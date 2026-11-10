#!/usr/bin/env python3
"""Convert Virtuoso TSV layout dumps into viewer JSON.

The TSV is intentionally simple so the SKILL side does not need to implement a
full JSON encoder. This script is Python 3.6 compatible for CentOS 7.
"""

from __future__ import print_function

import argparse
import contextlib
import datetime
import fcntl
import gzip
import json
import math
import os
import re
import shutil
import stat
import tempfile
import time

from trace_rules import source_device_scopes, apply_connectivity_metadata
from technology_layers import technology_layer_context, scoped_via_definitions

from pdk_profile import (
    classify_layer as classify_profile_layer,
    load_registry as load_profile_registry,
    metal_number_from_name,
    profile_preferences,
    select_profile,
    via_pair_from_name,
)


SAFE_OA_NAME = re.compile(r"^[A-Za-z0-9_.$:+-]+$")
DEFAULT_MAX_INPUT_BYTES = 256 * 1024 * 1024
DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024
DEFAULT_MAX_INPUT_FILES = 64
DEFAULT_MAX_RECORDS = 1000000
DEFAULT_MAX_SHAPES = 200000
DEFAULT_MAX_INSTANCES = 200000
DEFAULT_MAX_PINS = 200000
DEFAULT_MAX_CONNECTIONS = 400000
DEFAULT_LOCK_TIMEOUT = 60.0
SUPPORTED_SOURCE_SCHEMA_VERSIONS = (2, 3, 4)
DEFAULT_PROFILE_REGISTRY = None


PALETTE = [
    "#e56b6f",
    "#2a9d8f",
    "#f4a261",
    "#457b9d",
    "#f6c85f",
    "#7b2cbf",
    "#43aa8b",
    "#f94144",
    "#90be6d",
    "#577590",
    "#ff9f1c",
    "#4cc9f0",
]

LAYER_COLORS = {
    "DIFF": "#4cc9a7",
    "OD": "#4cc9a7",
    "ACTIVE": "#4cc9a7",
    "POLY1": "#f97316",
    "POLY": "#f97316",
    "CONT": "#e8e0c4",
    "CO": "#e8e0c4",
    "METAL1": "#4dabf7",
    "METAL2": "#51cf66",
    "METAL3": "#ffd43b",
    "METAL4": "#f06595",
    "METAL5": "#b197fc",
    "METAL6": "#38d9a9",
}

VIA_COLORS = {
    "CONT": "#f8f0d8",
    "CO": "#f8f0d8",
    "VIA12": "#ffd166",
    "VIA23": "#80ed99",
    "VIA34": "#56cfe1",
    "VIA45": "#c77dff",
    "VIA56": "#ff8fab",
}


def parse_number(value):
    if value in ("", None):
        return 0.0
    value = str(value).strip()
    try:
        number = float(value)
        return number if math.isfinite(number) else 0.0
    except ValueError:
        # SKILL can print nil or compact object text if something unexpected
        # leaks through. Keep the conversion resilient.
        return 0.0


def parse_integer(value, fallback=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def parse_bool(value):
    return str(value or "").strip().lower() in ("1", "t", "true", "yes")


def parse_bbox(text, dbu):
    if not text:
        return None
    parts = text.split(",")
    if len(parts) != 4:
        return None
    # Virtuoso SKILL reports these OA bBox/point coordinates in user units for
    # this flow. Keep DBU metadata, but do not scale coordinates again.
    vals = [parse_number(part) for part in parts]
    x1, y1, x2, y2 = vals
    return {
        "min": [min(x1, x2), min(y1, y2)],
        "max": [max(x1, x2), max(y1, y2)],
    }


def parse_points(text, dbu):
    points = []
    if not text:
        return points
    for item in text.split(";"):
        if not item:
            continue
        xy = item.split(",")
        if len(xy) != 2:
            continue
        points.append([parse_number(xy[0]), parse_number(xy[1])])
    return points


def bbox_from_points(points):
    if not points:
        return None
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return {"min": [min(xs), min(ys)], "max": [max(xs), max(ys)]}


def merge_bbox(a, b):
    if b is None:
        return a
    if a is None:
        return b
    return {
        "min": [min(a["min"][0], b["min"][0]), min(a["min"][1], b["min"][1])],
        "max": [max(a["max"][0], b["max"][0]), max(a["max"][1], b["max"][1])],
    }


def normalize_layer(layer):
    return (layer or "unknown").strip().upper()


def default_profile_registry():
    global DEFAULT_PROFILE_REGISTRY
    if DEFAULT_PROFILE_REGISTRY is None:
        DEFAULT_PROFILE_REGISTRY = load_profile_registry()
    return DEFAULT_PROFILE_REGISTRY


def raw_layer_info(layer, context, purpose=None):
    return classify_profile_layer(
        context["profileRegistry"], context["selectedProfile"], layer, purpose,
        technology_layer=context.get("technologyLayers", {}).get(normalize_layer(layer))
    )


def metal_number(layer, context=None):
    if context:
        info = raw_layer_info(layer, context)
        if info.get("kind") == "metal" and info.get("metal") is not None:
            return int(info["metal"])
    return metal_number_from_name(layer)


def via_pair_from_layer(layer, context=None):
    if context:
        info = raw_layer_info(layer, context)
        if info.get("kind") in ("contact", "via"):
            if info.get("lowerMetal") is not None and info.get("upperMetal") is not None:
                return (int(info["lowerMetal"]), int(info["upperMetal"]))
            if info.get("kind") == "contact":
                return (0, 1)
    return via_pair_from_name(layer)


def detect_technology_profile(technology_library, library, layer_names,
                              profile_registry=None):
    registry = profile_registry or default_profile_registry()
    profile, _, _ = select_profile(registry, technology_library, library, layer_names)
    return profile["id"]


def preferred_numbered_layer(names, number, context):
    candidates = [name for name in names if metal_number(name, context) == number]
    if not candidates:
        return None
    prefixes = context.get("preferences", {}).get("metalPrefixes", ["METAL", "M", "MET"])
    for prefix in prefixes:
        exact = "%s%d" % (prefix, number)
        if exact in candidates:
            return exact
    return sorted(candidates)[0]


def build_layer_context(layer_names, technology_library="", library="",
                        profile_registry=None, technology_layers=None, via_definitions=None):
    names = set(normalize_layer(name) for name in layer_names if str(name or "").strip())
    registry = profile_registry or default_profile_registry()
    selected_profile, profile_match, diagnostics = select_profile(
        registry, technology_library, library, names
    )
    runtime_layers, runtime_diagnostics = technology_layer_context(
        technology_layers or [], via_definitions or [], registry, selected_profile,
        technology_library)
    diagnostics = list(diagnostics) + runtime_diagnostics
    context = {
        "technologyLayers": runtime_layers,
        "profile": selected_profile["id"],
        "profileVersion": selected_profile["version"],
        "profileHash": selected_profile["_profileHash"],
        "profileSource": selected_profile["_profileSource"],
        "profileMatch": profile_match,
        "profileDiagnostics": diagnostics,
        "technologyLibrary": str(technology_library or "").strip(),
        "profileRegistry": registry,
        "selectedProfile": selected_profile,
        "preferences": profile_preferences(registry, selected_profile),
        "classificationCache": {},
    }
    metal_layers = {}
    for name in names:
        number = metal_number(name, context)
        if number is not None:
            metal_layers[number] = preferred_numbered_layer(names, number, context)
    context["metalLayers"] = metal_layers
    via_layers = {}
    for name in names:
        pair = via_pair_from_layer(name, context)
        if pair and pair != (0, 1):
            preferred = via_layers.get(pair)
            if preferred is None:
                via_layers[pair] = name
            else:
                prefixes = context["preferences"].get("viaPrefixes", ["VIA", "V"])
                ranks = dict((prefix, index) for index, prefix in enumerate(prefixes))
                current_prefix = "VIA" if preferred.startswith("VIA") else "V"
                candidate_prefix = "VIA" if name.startswith("VIA") else "V"
                if ranks.get(candidate_prefix, 999) < ranks.get(current_prefix, 999):
                    via_layers[pair] = name
    # Actual cut names win over numeric naming conventions (VIA1 vs VIA12).
    declared_pairs = {}
    for record in scoped_via_definitions(via_definitions or [], technology_library):
        lower = raw_layer_info(normalize_layer(record["lowerLayer"]), context)
        upper = raw_layer_info(normalize_layer(record["upperLayer"]), context)
        cut = normalize_layer(record["cutLayer"])
        if all(info.get("kind") == "metal" and info.get("routing") and
               info.get("metal") is not None for info in (lower, upper)):
            pair = (int(lower["metal"]), int(upper["metal"]))
            if pair[1] > pair[0]:
                declared_pairs.setdefault(pair, set()).add(cut)
    for pair, candidates in declared_pairs.items():
        if len(candidates) == 1:
            via_layers[pair] = next(iter(candidates))
    context["viaLayers"] = via_layers
    contacts = [name for name in names if raw_layer_info(name, context).get("kind") == "contact"]
    contact_priority = context["preferences"].get(
        "contactLayers", ["CONT", "CO", "CONTACT", "CT", "CA"]
    )
    contact_layer = None
    for candidate in contact_priority:
        if candidate in contacts:
            contact_layer = candidate
            break
    if contact_layer is None and contacts:
        contact_layer = sorted(contacts)[0]
    context["contactLayer"] = contact_layer
    return context


def actual_metal_layer(number, context):
    if context:
        actual = context.get("metalLayers", {}).get(number)
        if actual:
            return actual
        prefixes = context.get("preferences", {}).get("metalPrefixes", ["METAL"])
        if prefixes:
            return "%s%d" % (prefixes[0], number)
    return "METAL%d" % number


def actual_via_layer(lower, upper, context):
    pair = (lower, upper)
    if context:
        actual = context.get("viaLayers", {}).get(pair)
        if actual:
            return actual
        prefixes = context.get("preferences", {}).get("viaPrefixes", ["VIA"])
        if prefixes:
            if prefixes[0] == "V" and upper == lower + 1:
                return "V%d" % lower
            if lower < 10 and upper < 10:
                return "%s%d%d" % (prefixes[0], lower, upper)
            return "%s%d_%d" % (prefixes[0], lower, upper)
    return "VIA%d%d" % (lower, upper) if upper < 10 else "VIA%d_%d" % (lower, upper)


def layer_class(layer, context=None, purpose=None):
    name = normalize_layer(layer)
    active_context = context or build_layer_context([name])
    key = (name, str(purpose or "drawing").strip().lower())
    cached = active_context.get("classificationCache", {}).get(key)
    if cached is not None:
        return cached
    info = dict(raw_layer_info(name, active_context, purpose))
    if info.get("kind") in ("via", "contact"):
        has_lower = bool(info.get("lowerLayer") or info.get("lowerLayers"))
        has_upper = bool(info.get("upperLayer") or info.get("upperLayers"))
        info["connectivitySource"] = ("profile-explicit-endpoints" if has_lower and has_upper
                                      and active_context.get("profile") != "generic" else "name-inference")
    if info.get("upperLayer") is None and info.get("upperMetal") is not None:
        info["upperLayer"] = actual_metal_layer(int(info["upperMetal"]), active_context)
    if info.get("lowerLayer") is None and info.get("lowerMetal") is not None:
        info["lowerLayer"] = actual_metal_layer(int(info["lowerMetal"]), active_context)
    if info.get("kind") == "contact" and info.get("upperLayer") is None:
        info["upperLayer"] = actual_metal_layer(1, active_context)
    if (info.get("routing") is True and float(info.get("stackIndex", -4)) < 0
            and info.get("zBottomUm") is None and info.get("zTopUm") is None):
        info["defaultVisible"] = False
        info["stackSource"] = "unresolved"
    active_context.setdefault("classificationCache", {})[key] = info
    return info


def is_routing_layer(layer, context=None, purpose=None):
    return layer_class(layer, context, purpose).get("routing") is True


def is_viewable_shape(shape):
    obj_type = str(shape.get("type") or "").strip().lower()
    purpose = str(shape.get("purpose") or "").strip().lower()
    layer = normalize_layer(shape.get("layer"))
    if obj_type in ("label", "text", "textdisplay"):
        return False
    if purpose in ("label", "annotation", "annotate"):
        return False
    if layer in ("", "UNKNOWN", "TEXT", "ANNOTATE"):
        return False
    return True


def layer_key(layer, context=None):
    info = layer_class(layer, context)
    return (info.get("stackIndex", 10000.0), normalize_layer(layer))


def layer_color(name, index, context=None):
    normalized = normalize_layer(name)
    if normalized in LAYER_COLORS:
        return LAYER_COLORS[normalized]
    if normalized in VIA_COLORS:
        return VIA_COLORS[normalized]
    info = layer_class(normalized, context)
    if info.get("kind") == "active":
        return LAYER_COLORS["ACTIVE"]
    if info.get("kind") == "poly":
        return LAYER_COLORS["POLY"]
    if info.get("kind") == "contact":
        return VIA_COLORS["CONT"]
    if info.get("kind") == "metal" and info.get("metal") is not None:
        canonical = "METAL%d" % info["metal"]
        if canonical in LAYER_COLORS:
            return LAYER_COLORS[canonical]
    via_pair = via_pair_from_layer(normalized, context)
    if via_pair is not None:
        lower, upper = via_pair
        canonical = "VIA%d%d" % (lower, upper)
        if canonical in VIA_COLORS:
            return VIA_COLORS[canonical]
        return PALETTE[(lower + upper + index) % len(PALETTE)]
    return PALETTE[index % len(PALETTE)]


def layer_thickness(name, context=None, purpose=None):
    return float(layer_class(name, context, purpose).get("thicknessUm", 0.2))


def layer_z_geometry(name, context=None, purpose=None):
    info = layer_class(name, context, purpose)
    thickness = layer_thickness(name, context, purpose)
    bottom = info.get("zBottomUm")
    top = info.get("zTopUm")
    if bottom is not None and top is None:
        top = float(bottom) + thickness
    elif top is not None and bottom is None:
        bottom = float(top) - thickness
    return bottom, top


def complete_routing_layer_names(layer_names, context=None):
    names = set([normalize_layer(name) for name in layer_names])
    metals = sorted(set([metal_number_from_name(name) for name in names
                         if metal_number_from_name(name) is not None]))
    if metals:
        for metal in range(metals[0], metals[-1]):
            lower = actual_metal_layer(metal, context)
            upper = actual_metal_layer(metal + 1, context)
            if lower in names and upper in names:
                candidate = actual_via_layer(metal, metal + 1, context)
                # New OA exports retain only observed cuts. A reserved technology
                # layer name does not prove that a via exists in this cell.
                if not (context or {}).get("technologyLayers"):
                    names.add(candidate)
    return sorted(names, key=lambda item: layer_key(item, context))


def inferred_connector_layer(master_cell, context=None):
    name = (master_cell or "").lower()
    if re.search(r"(^|[_-])(cont|contact)($|[_-])", name) or re.match(r"^co($|[_-])", name):
        priorities = (context or {}).get("preferences", {}).get("contactLayers", ["CONT"])
        return (context or {}).get("contactLayer") or priorities[0]
    match = re.search(r"(?:^|[_-])m([0-9]+)[_-]m([0-9]+)(?:$|[_-])", name)
    if match:
        first = int(match.group(1))
        second = int(match.group(2))
        lower, upper = min(first, second), max(first, second)
        if upper == lower + 1:
            return actual_via_layer(lower, upper, context)
    match = re.search(r"via([0-9])([0-9])", name)
    if match:
        return actual_via_layer(int(match.group(1)), int(match.group(2)), context)
    match = re.search(r"via([0-9]+)", name)
    if match:
        lower = int(match.group(1))
        return actual_via_layer(lower, lower + 1, context)
    return None


def hierarchy_depth(path_name):
    return (path_name or "").count("/")


def parent_path(path_name):
    path_name = path_name or ""
    if "/" not in path_name:
        return ""
    return path_name.rsplit("/", 1)[0]


def valid_oa_name(value):
    return bool(SAFE_OA_NAME.match(str(value or "")))


def validate_identity(library, cell, view, label):
    if not all(valid_oa_name(value) for value in (library, cell, view)):
        raise RuntimeError("Unsafe OA identity in %s: %r/%r/%r" %
                           (label, library, cell, view))


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def exclusive_temporary(directory, prefix):
    descriptor, path = tempfile.mkstemp(prefix=prefix + ".tmp-", dir=directory)
    os.fchmod(descriptor, 0o600)
    return descriptor, path


def write_json_and_gzip(path, payload):
    directory = os.path.dirname(os.path.abspath(path)) or "."
    basename = os.path.basename(path)
    temporary = None
    temporary_gzip = None
    descriptor = None
    gzip_descriptor = None
    try:
        descriptor, temporary = exclusive_temporary(directory, basename)
        with os.fdopen(descriptor, "w") as handle:
            descriptor = None
            json.dump(payload, handle, separators=(",", ":"), sort_keys=True,
                      allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        gzip_descriptor, temporary_gzip = exclusive_temporary(directory, basename + ".gz")
        with os.fdopen(gzip_descriptor, "wb") as gzip_handle:
            gzip_descriptor = None
            with open(temporary, "rb") as source:
                with gzip.GzipFile(fileobj=gzip_handle, mode="wb", compresslevel=6) as compressed:
                    shutil.copyfileobj(source, compressed)
            gzip_handle.flush()
            os.fsync(gzip_handle.fileno())
        os.rename(temporary_gzip, path + ".gz")
        temporary_gzip = None
        os.rename(temporary, path)
        temporary = None
        fsync_directory(directory)
    finally:
        for open_descriptor in (descriptor, gzip_descriptor):
            if open_descriptor is not None:
                os.close(open_descriptor)
        for candidate in (temporary, temporary_gzip):
            if candidate:
                try:
                    os.unlink(candidate)
                except OSError:
                    pass


def checked_input(path, maximum_bytes, maximum_line_bytes):
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise RuntimeError("Cannot safely open input %s: %s" % (path, error))
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise RuntimeError("Input is not a regular file: %s" % path)
        if metadata.st_size > maximum_bytes:
            raise RuntimeError("Input exceeds %d bytes: %s" % (maximum_bytes, path))
        with os.fdopen(descriptor, "rb") as handle:
            descriptor = None
            line_number = 0
            while True:
                raw_line = handle.readline(maximum_line_bytes + 1)
                if not raw_line:
                    break
                line_number += 1
                if len(raw_line) > maximum_line_bytes:
                    raise RuntimeError("Input line %d exceeds %d bytes in %s" %
                                       (line_number, maximum_line_bytes, path))
                if b"\0" in raw_line:
                    raise RuntimeError("Input contains NUL at line %d in %s" %
                                       (line_number, path))
                if not raw_line.endswith(b"\n") and handle.peek(1):
                    raise RuntimeError("Input line %d exceeds %d bytes in %s" %
                                       (line_number, maximum_line_bytes, path))
                try:
                    yield line_number, raw_line.rstrip(b"\r\n").decode("utf-8")
                except UnicodeDecodeError:
                    raise RuntimeError("Input is not valid UTF-8 at line %d in %s" %
                                       (line_number, path))
    finally:
        if descriptor is not None:
            os.close(descriptor)


def require_fields(fields, minimum, kind, line_number, path, maximum=None):
    if len(fields) < minimum or (maximum is not None and len(fields) > maximum):
        raise RuntimeError("%s record has %d fields at line %d in %s" %
                           (kind, len(fields), line_number, path))


def convert_tsv(path, output_dir, limits, expected_identity=None, profile_registry=None):
    cell = None
    cell_records = 0
    schema_records = 0
    technology_records = 0
    technology_library = ""
    dbu = 1000.0
    shapes = []
    instances = []
    pins = []
    connections = []
    source_bbox = None
    source_schema_version = 1
    export_status = None
    status_records = 0
    endcell_records = 0
    source_views = []
    via_definitions = []
    technology_layers = []
    source_view_keys = set()
    record_count = 0
    category_counts = {
        "SHAPE": 0,
        "INSTANCE": 0,
        "PIN": 0,
        "CONNECTION": 0,
    }
    category_limits = {
        "SHAPE": limits["shapes"],
        "INSTANCE": limits["instances"],
        "PIN": limits["pins"],
        "CONNECTION": limits["connections"],
    }

    for line_number, line in checked_input(
            path, limits["input_bytes"], limits["line_bytes"]):
        if not line or line.startswith("#"):
            continue
        if endcell_records:
            raise RuntimeError("Record found after ENDCELL at line %d in %s" %
                               (line_number, path))
        record_count += 1
        if record_count > limits["records"]:
            raise RuntimeError("Input exceeds %d records: %s" %
                               (limits["records"], path))
        fields = line.split("\t")
        kind = fields[0]
        if kind in category_counts:
            category_counts[kind] += 1
            if category_counts[kind] > category_limits[kind]:
                raise RuntimeError("Input exceeds %d %s records: %s" %
                                   (category_limits[kind], kind, path))
        if kind == "SCHEMA":
            require_fields(fields, 2, kind, line_number, path, 2)
            schema_records += 1
            if schema_records != 1 or cell is not None:
                raise RuntimeError("SCHEMA must appear once before CELL in %s" % path)
            source_schema_version = parse_integer(fields[1], -1)
            if source_schema_version not in SUPPORTED_SOURCE_SCHEMA_VERSIONS:
                raise RuntimeError(
                    "Unsupported source schema version %s in %s; expected 2, 3 or 4" %
                    (fields[1], path)
                )
        elif kind == "SOURCE":
            field_count = 8 if source_schema_version >= 4 else 4
            require_fields(fields, field_count, kind, line_number, path, field_count)
            if cell is None or status_records:
                raise RuntimeError("Out-of-order SOURCE record at line %d in %s" %
                                   (line_number, path))
            if len(source_views) >= limits["sources"]:
                raise RuntimeError("Input exceeds %d unique SOURCE records: %s" %
                                   (limits["sources"], path))
            values = (fields + [""] * 4)[:4]
            source_view = {
                "library": values[1],
                "cell": values[2],
                "view": values[3],
            }
            if source_schema_version >= 4:
                if fields[6] not in ("t", "nil") or not fields[7].isdigit():
                    raise RuntimeError("Invalid SOURCE device evidence at line %d" % line_number)
                source_view.update({"deviceKind": fields[4], "deviceSource": fields[5],
                                    "isPCell": fields[6] == "t", "terminalCount": int(fields[7])})
            validate_identity(source_view["library"], source_view["cell"],
                              source_view["view"], "SOURCE line %d" % line_number)
            source_key = "%s/%s/%s" % (
                source_view["library"], source_view["cell"], source_view["view"]
            )
            if source_key not in source_view_keys:
                source_view_keys.add(source_key)
                source_views.append(source_view)
        elif kind == "TECHLAYER":
            require_fields(fields, 4, kind, line_number, path, 4)
            if source_schema_version < 4 or cell is None or status_records:
                raise RuntimeError("TECHLAYER requires schema 4 before STATUS at line %d" % line_number)
            if not all(fields[1:]):
                raise RuntimeError("Empty TECHLAYER field at line %d" % line_number)
            technology_layers.append(dict(zip(
                ("name", "material", "technologyLibrary"), fields[1:])))
        elif kind == "VIADEF":
            require_fields(fields, 6, kind, line_number, path, 6)
            if source_schema_version < 4 or cell is None or status_records:
                raise RuntimeError("VIADEF requires schema 4 before STATUS at line %d" % line_number)
            if not all(fields[1:4]):
                raise RuntimeError("Empty VIADEF endpoint at line %d" % line_number)
            via_definitions.append(dict(zip(
                ("cutLayer", "lowerLayer", "upperLayer", "technologyLibrary", "name"), fields[1:])))
        elif kind == "CELL":
            require_fields(fields, 6, kind, line_number, path, 6)
            cell_records += 1
            if cell_records != 1:
                raise RuntimeError("Expected exactly one CELL record in %s" % path)
            lib_name, cell_name, view_name = fields[1], fields[2], fields[3]
            validate_identity(lib_name, cell_name, view_name, "CELL line %d" % line_number)
            identity = (lib_name, cell_name, view_name)
            if expected_identity is not None and identity != expected_identity:
                raise RuntimeError("CELL identity %s/%s/%s does not match expected %s/%s/%s" %
                                   (identity + expected_identity))
            dbu = parse_number(fields[4]) or 1000.0
            source_bbox = parse_bbox(fields[5] if len(fields) > 5 else "", dbu)
            cell = {
                "library": lib_name,
                "cell": cell_name,
                "view": view_name,
                "dbuPerMicron": dbu,
            }
        elif kind == "TECH" and cell is not None:
            require_fields(fields, 2, kind, line_number, path, 2)
            if source_schema_version < 3:
                raise RuntimeError(
                    "TECH requires source schema version 3 at line %d in %s" %
                    (line_number, path)
                )
            if status_records:
                raise RuntimeError("TECH record follows STATUS at line %d in %s" %
                                   (line_number, path))
            technology_records += 1
            if technology_records != 1:
                raise RuntimeError("Expected at most one TECH record in %s" % path)
            technology_library = fields[1].strip()
            if technology_library and not valid_oa_name(technology_library):
                raise RuntimeError("Unsafe OA technology library at line %d in %s" %
                                   (line_number, path))
        elif kind == "SHAPE" and cell is not None:
            if status_records:
                raise RuntimeError("SHAPE record follows STATUS at line %d in %s" %
                                   (line_number, path))
            require_fields(fields, 11, kind, line_number, path, 18 if source_schema_version >= 4 else 11)
            _, owner, path_name, obj_type, layer, purpose, width, bbox_text, points_text, net, label = (fields + [""] * 11)[:11]
            points = parse_points(points_text, dbu)
            bbox = parse_bbox(bbox_text, dbu) or bbox_from_points(points)
            if bbox is None:
                continue
            raw_layer = layer or "unknown"
            shape = {
                "id": len(shapes),
                "ownerCell": owner,
                "hierPath": path_name,
                "type": obj_type or "shape",
                "layer": normalize_layer(raw_layer),
                "purpose": purpose or "drawing",
                "width": parse_number(width),
                "bbox": bbox,
                "points": points,
                "net": net,
                "label": label,
            }
            if len(fields) > 11:
                if len(fields) != 18:
                    raise RuntimeError("Partial SHAPE geometry metadata at line %d" % line_number)
                shape.update({"sourceType": fields[11], "sourceWidth": parse_number(fields[12]),
                              "pathStyle": fields[13], "beginStyle": fields[14], "endStyle": fields[15],
                              "beginExt": parse_number(fields[16]), "endExt": parse_number(fields[17])})
                if shape['type'].lower() == 'path' and shape['pathStyle'].lower() == 'round':
                    # Numeric extension endpoints select square caps in path engines.
                    # Keep OA audit values without overriding the round cap style.
                    shape['sourceBeginExt'] = shape.pop('beginExt')
                    shape['sourceEndExt'] = shape.pop('endExt')
            if raw_layer != shape["layer"]:
                shape["rawLayer"] = raw_layer
            shapes.append(shape)
        elif kind == "INSTANCE" and cell is not None:
            if status_records:
                raise RuntimeError("INSTANCE record follows STATUS at line %d in %s" %
                                   (line_number, path))
            require_fields(fields, 7, kind, line_number, path, 7)
            _, path_name, name, master_lib, master_cell, master_view, bbox_text = (fields + [""] * 7)[:7]
            validate_identity(master_lib, master_cell, master_view,
                              "INSTANCE master line %d" % line_number)
            bbox = parse_bbox(bbox_text, dbu)
            if bbox is None:
                continue
            instances.append({
                "id": len(instances),
                "hierPath": path_name,
                "parentPath": parent_path(path_name),
                "name": name,
                "master": {
                    "library": master_lib,
                    "cell": master_cell,
                    "view": master_view,
                },
                "bbox": bbox,
            })
        elif kind == "PIN" and cell is not None:
            if status_records:
                raise RuntimeError("PIN record follows STATUS at line %d in %s" %
                                   (line_number, path))
            require_fields(fields, 11, kind, line_number, path, 11)
            _, owner, path_name, terminal, pin_name, direction, net, layer, purpose, bbox_text, points_text = (fields + [""] * 11)[:11]
            points = parse_points(points_text, dbu)
            bbox = parse_bbox(bbox_text, dbu) or bbox_from_points(points)
            raw_layer = layer or "unknown"
            pin = {
                "id": len(pins),
                "ownerCell": owner,
                "hierPath": path_name,
                "terminal": terminal,
                "name": pin_name or terminal,
                "direction": direction or "unknown",
                "net": net,
                "layer": normalize_layer(raw_layer),
                "purpose": purpose or "pin",
                "worldBBox": bbox,
                "points": points,
            }
            if raw_layer != pin["layer"]:
                pin["rawLayer"] = raw_layer
            pins.append(pin)
        elif kind == "CONNECTION" and cell is not None:
            if status_records:
                raise RuntimeError("CONNECTION record follows STATUS at line %d in %s" %
                                   (line_number, path))
            require_fields(fields, 6, kind, line_number, path, 6)
            _, occurrence_path, parent_path_name, parent_net, child_formal_net, terminal = (fields + [""] * 6)[:6]
            connections.append({
                "id": len(connections),
                "occurrencePath": occurrence_path,
                "parentPath": parent_path_name,
                "parentNet": parent_net,
                "childFormalNet": child_formal_net,
                "terminal": terminal,
            })
        elif kind == "STATUS" and cell is not None:
            require_fields(fields, 9, kind, line_number, path, 12)
            status_records += 1
            if status_records != 1:
                raise RuntimeError("Expected at most one STATUS record in %s" % path)
            values = (fields + [""] * 9)[:9]
            export_status = {
                "shapesSeen": parse_integer(values[1]),
                "shapesEmitted": parse_integer(values[2]),
                "truncated": parse_bool(values[3]),
                "maxDepthReached": parse_integer(values[4]),
                "maxDepthRequested": parse_integer(values[5]),
                "depthLimited": parse_bool(values[6]),
                "pinsEmitted": parse_integer(values[7]),
                "connectionsEmitted": parse_integer(values[8]),
            }
        elif kind == "ENDCELL" and cell is not None:
            require_fields(fields, 5, kind, line_number, path, 5)
            endcell_records += 1
            if endcell_records != 1:
                raise RuntimeError("Expected exactly one ENDCELL record in %s" % path)
            end_identity = (fields[1], fields[2], fields[3])
            validate_identity(end_identity[0], end_identity[1], end_identity[2],
                              "ENDCELL line %d" % line_number)
            if end_identity != (cell["library"], cell["cell"], cell["view"]):
                raise RuntimeError("ENDCELL identity does not match CELL in %s" % path)
        else:
            raise RuntimeError("Unexpected or out-of-order %s record at line %d in %s" %
                               (kind or "empty", line_number, path))

    if cell is None or cell_records != 1:
        raise RuntimeError("Expected exactly one CELL record in %s" % path)
    if schema_records != 1:
        raise RuntimeError("Expected exactly one SCHEMA record in %s" % path)
    if endcell_records != 1:
        raise RuntimeError("Expected exactly one ENDCELL record in %s" % path)

    observed_lpp_counts = {}
    for shape in shapes:
        key = (shape["layer"], str(shape.get("purpose") or "drawing").strip().lower())
        counts = observed_lpp_counts.setdefault(key, {"shapeCount": 0, "pinCount": 0})
        counts["shapeCount"] += 1
    for pin in pins:
        key = (pin["layer"], str(pin.get("purpose") or "pin").strip().lower())
        counts = observed_lpp_counts.setdefault(key, {"shapeCount": 0, "pinCount": 0})
        counts["pinCount"] += 1
    observed_layer_names = set([shape["layer"] for shape in shapes]) | set(
        [pin["layer"] for pin in pins]
    )
    layer_context = build_layer_context(
        observed_layer_names, technology_library, cell["library"], profile_registry,
        technology_layers, via_definitions
    )
    source_shape_count = len(shapes)
    if export_status is None:
        observed_depth = max(
            [hierarchy_depth(shape.get("hierPath")) for shape in shapes]
            + [hierarchy_depth(inst.get("hierPath")) for inst in instances]
            + [0]
        )
        export_status = {
            "shapesSeen": source_shape_count,
            "shapesEmitted": source_shape_count,
            "truncated": False,
            "maxDepthReached": observed_depth,
            "maxDepthRequested": None,
            "depthLimited": None,
            "pinsEmitted": len(pins),
            "connectionsEmitted": len(connections),
        }
    export_status["truncated"] = bool(
        export_status.get("truncated")
        or export_status.get("shapesSeen", 0) > export_status.get("shapesEmitted", 0)
    )
    export_status["pinsEmitted"] = len(pins)
    export_status["connectionsEmitted"] = len(connections)
    shapes = [shape for shape in shapes if is_viewable_shape(shape)]
    # Carry LPP semantics on each shape so a dummy purpose cannot inherit the
    # visibility of real routing shapes sharing the same layer name.
    for shape in shapes:
        info = layer_class(shape["layer"], layer_context, shape.get("purpose"))
        for field in ("kind", "semantic", "routing", "defaultVisible"):
            shape[field] = info.get(field)
    export_status["routingShapesRetained"] = sum(
        1 for shape in shapes
        if is_routing_layer(shape["layer"], layer_context, shape.get("purpose"))
    )
    export_status["viewableShapesRetained"] = len(shapes)
    export_status["nonRoutingShapesFiltered"] = source_shape_count - len(shapes)

    total_bbox = source_bbox
    for shape in shapes:
        total_bbox = merge_bbox(total_bbox, shape["bbox"])
    for inst in instances:
        total_bbox = merge_bbox(total_bbox, inst["bbox"])
    if total_bbox is None:
        total_bbox = {"min": [0.0, 0.0], "max": [1.0, 1.0]}

    # Only an exact exported dbPin figure is admitted at an opaque device boundary.
    # A shared net name or an overlapping bbox is insufficient evidence.
    terminal_geometry = set((pin.get("hierPath"), pin.get("layer"),
                             tuple(tuple(pt) for pt in pin.get("points", []))) for pin in pins)
    for shape in shapes:
        if shape.get("points") and (shape.get("hierPath"), shape.get("layer"),
                                    tuple(tuple(pt) for pt in shape["points"])) in terminal_geometry:
            shape["traceRole"] = "terminal"
    device_scopes, device_metadata_complete = source_device_scopes(cell, instances, source_views)
    device_metadata_complete = bool(source_schema_version >= 4 and device_metadata_complete
                                    and not export_status.get("truncated") and not export_status.get("depthLimited"))
    shape_paths = set([shape["hierPath"] for shape in shapes])
    retained_instances = []
    redundant_connector_instances = 0
    for inst in instances:
        connector_layer = inferred_connector_layer(inst["master"]["cell"], layer_context)
        if connector_layer and inst["hierPath"] in shape_paths:
            redundant_connector_instances += 1
            continue
        retained_instances.append(inst)
    instances = retained_instances
    export_status["redundantConnectorInstancesFiltered"] = redundant_connector_instances
    connector_counts = {}
    for inst in instances:
        if inst["hierPath"] in shape_paths:
            continue
        layer = inferred_connector_layer(inst["master"]["cell"], layer_context)
        if layer:
            connector_counts[layer] = connector_counts.get(layer, 0) + 1

    pin_layer_names = set([
        pin["layer"] for pin in pins
        if is_routing_layer(pin["layer"], layer_context, pin.get("purpose"))
    ])
    layer_names = complete_routing_layer_names(
        set([shape["layer"] for shape in shapes]) | set(connector_counts.keys()) | pin_layer_names,
        layer_context,
    )
    layer_shape_counts = {}
    for shape in shapes:
        layer_shape_counts[shape["layer"]] = layer_shape_counts.get(shape["layer"], 0) + 1
    layers = []
    for index, name in enumerate(layer_names):
        observed_purposes = sorted(
            purpose for layer, purpose in observed_lpp_counts.keys() if layer == name
        )
        conductive_purposes = [purpose for purpose in observed_purposes
                               if is_routing_layer(name, layer_context, purpose)]
        primary_candidates = conductive_purposes or observed_purposes
        primary_purpose = "drawing" if "drawing" in primary_candidates else (
            primary_candidates[0] if primary_candidates else "drawing"
        )
        info = layer_class(name, layer_context, primary_purpose)
        z_bottom, z_top = layer_z_geometry(name, layer_context, primary_purpose)
        approximate = bool(info.get("approximate", False) or z_bottom is None or z_top is None)
        purpose_classes = []
        for purpose in observed_purposes:
            purpose_info = layer_class(name, layer_context, purpose)
            counts = observed_lpp_counts[(name, purpose)]
            purpose_classes.append({
                "purpose": purpose,
                "shapeCount": counts["shapeCount"],
                "pinCount": counts["pinCount"],
                "semantic": purpose_info.get("semantic", "unknown"),
                "routing": purpose_info.get("routing", False),
                "defaultVisible": purpose_info.get("defaultVisible", True),
            })
        layers.append({
            "name": name,
            "index": index,
            "color": layer_color(name, index, layer_context),
            "shapeCount": layer_shape_counts.get(name, 0),
            "connectorCount": connector_counts.get(name, 0),
            "classificationSource": info.get("classificationSource", "profile-name"),
            "technologyMaterial": info.get("technologyMaterial"),
            "stackSource": info.get("stackSource", "profile-approximate"),
            "kind": info.get("kind", "other"),
            "routing": info.get("routing", False),
            "defaultVisible": info.get("defaultVisible", True),
            "stackIndex": info.get("stackIndex", index),
            "semantic": info.get("semantic", "unknown"),
            "metal": info.get("metal"),
            "thickness": layer_thickness(name, layer_context, primary_purpose),
            "thicknessSource": info.get("thicknessSource", "%s-fallback" % layer_context["profile"]),
            "zBottomUm": z_bottom,
            "zTopUm": z_top,
            "geometryApproximate": approximate,
            "lowerLayer": info.get("lowerLayer"),
            "upperLayer": info.get("upperLayer"),
            "lowerLayers": info.get("lowerLayers", []),
            "upperLayers": info.get("upperLayers", []),
            "connectivitySource": info.get("connectivitySource", "name-inference"),
            "z": index,
            "height": 0.35,
            "purposes": purpose_classes,
        })

    apply_connectivity_metadata(layers, scoped_via_definitions(via_definitions, technology_library),
                                layer_context["selectedProfile"])

    unclassified_layers = sorted([
        layer["name"] for layer in layers if layer.get("semantic") == "unknown"
    ])
    export_status["unclassifiedLayerCount"] = len(unclassified_layers)

    observed_lpps = []
    unclassified_lpps = []
    for key in sorted(observed_lpp_counts.keys()):
        name, purpose = key
        counts = observed_lpp_counts[key]
        info = layer_class(name, layer_context, purpose)
        entry = {
            "layer": name,
            "purpose": purpose,
            "shapeCount": counts["shapeCount"],
            "pinCount": counts["pinCount"],
            "semantic": info.get("semantic", "unknown"),
            "routing": info.get("routing", False),
            "defaultVisible": info.get("defaultVisible", True),
        }
        observed_lpps.append(entry)
        if entry["semantic"] == "unknown":
            unclassified_lpps.append({"layer": name, "purpose": purpose})
    approximate_layers = sorted([
        layer["name"] for layer in layers
        if layer.get("routing") is True and layer.get("geometryApproximate") is True
    ])
    unresolved_stack_layers = sorted(layer["name"] for layer in layers
                                     if layer.get("routing") and layer.get("stackSource") == "unresolved")
    profile_diagnostics = list(layer_context.get("profileDiagnostics", []))
    if unresolved_stack_layers:
        profile_diagnostics.append({
            "code": "E5003", "severity": "warning",
            "message": "Recognized conductors have unconfirmed layer positions and are hidden by default",
            "layers": unresolved_stack_layers,
        })
    if unclassified_layers:
        profile_diagnostics.append({
            "code": "E5002", "severity": "warning",
            "message": "%d observed layer(s) remain unclassified and hidden" %
                       len(unclassified_layers),
            "layers": unclassified_layers,
        })
    if approximate_layers:
        profile_diagnostics.append({
            "code": "E5003", "severity": "warning",
            "message": "%d routing layer(s) use approximate stack geometry" %
                       len(approximate_layers),
            "layers": approximate_layers,
        })

    cell.update({
        "schemaVersion": 2,
        "sourceSchemaVersion": source_schema_version,
        "deviceScopes": device_scopes,
        "deviceMetadataComplete": device_metadata_complete,
        "deviceBoundaryComplete": False,
        "deviceBoundarySource": "oa-category-cdf-conservative" if source_schema_version >= 4 else "missing",
        "generatedAt": datetime.datetime.utcnow().isoformat() + "Z",
        "sourceTsv": os.path.basename(path),
        "units": "um",
        "technology": {
            "library": technology_library,
            "profile": layer_context["profile"],
            "profileVersion": layer_context["profileVersion"],
            "profileHash": layer_context["profileHash"],
            "profileSource": layer_context["profileSource"],
            "profileMatch": layer_context["profileMatch"],
            "source": "oa" if technology_library else "inferred",
            "unclassifiedLayers": unclassified_layers,
            "unclassifiedLpps": unclassified_lpps,
            "approximateLayers": approximate_layers,
            "unresolvedStackLayers": unresolved_stack_layers,
            "observedLpps": observed_lpps,
            "viaDefinitions": via_definitions,
            "layerDefinitions": technology_layers,
            "diagnostics": profile_diagnostics,
        },
        "bbox": total_bbox,
        "sourceShapeCount": source_shape_count,
        "shapeCount": len(shapes),
        "instanceCount": len(instances),
        "pinCount": len(pins),
        "connectionCount": len(connections),
        "maxShapeDepth": max([hierarchy_depth(shape.get("hierPath")) for shape in shapes] or [0]),
        "maxInstanceDepth": max([hierarchy_depth(inst.get("hierPath")) for inst in instances] or [0]),
        "ownerCellCount": len(set([shape.get("ownerCell") for shape in shapes])),
        "layers": layers,
        "shapes": shapes,
        "instances": instances,
        "pins": pins,
        "connections": connections,
        "sourceViews": sorted(
            source_views or [{
                "library": cell["library"],
                "cell": cell["cell"],
                "view": cell["view"],
            }],
            key=lambda item: (item["library"], item["cell"], item["view"]),
        ),
        "exportStatus": export_status,
    })

    safe_name = "%s@%s@%s.json" % (cell["library"], cell["cell"], cell["view"])
    output_path = os.path.join(output_dir, safe_name)
    write_json_and_gzip(output_path, cell)
    return cell, safe_name


@contextlib.contextmanager
def manifest_lock(path, timeout_seconds):
    lock_path = path + ".lock"
    flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(lock_path, flags, 0o600)
    metadata = os.fstat(descriptor)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        os.close(descriptor)
        raise RuntimeError("Unsafe manifest lock file %s" % lock_path)
    lock = os.fdopen(descriptor, "a+")
    try:
        deadline = time.time() + timeout_seconds
        while True:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except (IOError, OSError) as error:
                if time.time() >= deadline:
                    raise RuntimeError("Timed out waiting for manifest lock %s" % lock_path)
                time.sleep(0.1)
        yield
    finally:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
        finally:
            lock.close()


@contextlib.contextmanager
def optional_manifest_lock(path, timeout_seconds, enabled):
    if enabled:
        with manifest_lock(path, timeout_seconds):
            yield
    else:
        yield


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--manifest-mode", choices=("replace", "merge"), default="replace")
    parser.add_argument("--expect-library")
    parser.add_argument("--expect-cell")
    parser.add_argument("--expect-view")
    parser.add_argument("--max-input-bytes", type=int, default=DEFAULT_MAX_INPUT_BYTES)
    parser.add_argument("--max-line-bytes", type=int, default=DEFAULT_MAX_LINE_BYTES)
    parser.add_argument("--max-input-files", type=int, default=DEFAULT_MAX_INPUT_FILES)
    parser.add_argument("--max-records", type=int, default=DEFAULT_MAX_RECORDS)
    parser.add_argument("--max-shapes", type=int, default=DEFAULT_MAX_SHAPES)
    parser.add_argument("--max-instances", type=int, default=DEFAULT_MAX_INSTANCES)
    parser.add_argument("--max-pins", type=int, default=DEFAULT_MAX_PINS)
    parser.add_argument("--max-connections", type=int, default=DEFAULT_MAX_CONNECTIONS)
    parser.add_argument("--manifest-lock-timeout", type=float, default=DEFAULT_LOCK_TIMEOUT)
    parser.add_argument("--no-manifest-lock", action="store_true")
    parser.add_argument("--pdk-profile")
    parser.add_argument("--pdk-profile-dir", action="append", default=[])
    args = parser.parse_args()

    profile_directories = []
    environment_directories = os.environ.get("VL3D_PDK_PROFILE_DIRS", "")
    if environment_directories:
        profile_directories.extend(
            value for value in environment_directories.split(os.pathsep) if value
        )
    environment_directory = os.environ.get("VL3D_PDK_PROFILE_DIR", "")
    if environment_directory:
        profile_directories.append(environment_directory)
    profile_directories.extend(args.pdk_profile_dir)
    explicit_profile = args.pdk_profile or os.environ.get("VL3D_PDK_PROFILE")
    profile_registry = load_profile_registry(
        profile_dirs=profile_directories, explicit_profile=explicit_profile
    )

    expected_values = (args.expect_library, args.expect_cell, args.expect_view)
    if any(expected_values) and not all(expected_values):
        raise RuntimeError("All three --expect-library/--expect-cell/--expect-view values are required")
    expected_identity = tuple(expected_values) if all(expected_values) else None
    if expected_identity:
        validate_identity(expected_identity[0], expected_identity[1], expected_identity[2],
                          "expected identity")

    numeric_limits = (
        args.max_input_bytes, args.max_line_bytes, args.max_input_files,
        args.max_records, args.max_shapes, args.max_instances,
        args.max_pins, args.max_connections,
    )
    if any(value <= 0 for value in numeric_limits):
        raise RuntimeError("All resource limits must be positive")
    limits = {
        "input_bytes": args.max_input_bytes,
        "line_bytes": args.max_line_bytes,
        "records": args.max_records,
        "sources": min(args.max_records, 200000),
        "shapes": args.max_shapes,
        "instances": args.max_instances,
        "pins": args.max_pins,
        "connections": args.max_connections,
    }

    if not os.path.isdir(args.output_dir):
        os.makedirs(args.output_dir)

    input_names = []
    input_directory = os.path.abspath(args.input_dir)
    input_metadata = os.lstat(input_directory)
    if stat.S_ISLNK(input_metadata.st_mode) or not stat.S_ISDIR(input_metadata.st_mode):
        raise RuntimeError("Input directory must be a real directory: %s" % args.input_dir)
    for name in sorted(os.listdir(input_directory)):
        if name.endswith(".tsv"):
            input_names.append(name)
    if not input_names:
        raise RuntimeError("No TSV files found in %s" % args.input_dir)
    if len(input_names) > args.max_input_files:
        raise RuntimeError("Input contains more than %d TSV files" % args.max_input_files)
    if expected_identity and len(input_names) != 1:
        raise RuntimeError("Expected identity conversion requires exactly one TSV file")

    cells = []
    for name in input_names:
        input_path = os.path.join(input_directory, name)
        cell, rel_name = convert_tsv(
            input_path, args.output_dir, limits, expected_identity, profile_registry
        )
        cells.append({
            "library": cell["library"],
            "cell": cell["cell"],
            "view": cell["view"],
            "path": "data/%s" % rel_name,
            "sourceSchemaVersion": cell["sourceSchemaVersion"],
            "units": cell["units"],
            "technology": cell["technology"],
            "shapeCount": cell["shapeCount"],
            "sourceShapeCount": cell["sourceShapeCount"],
            "instanceCount": cell["instanceCount"],
            "pinCount": cell["pinCount"],
            "connectionCount": cell["connectionCount"],
            "layerCount": len(cell["layers"]),
            "maxShapeDepth": cell["maxShapeDepth"],
            "maxInstanceDepth": cell["maxInstanceDepth"],
            "ownerCellCount": cell["ownerCellCount"],
            "bbox": cell["bbox"],
            "sourceViews": cell["sourceViews"],
            "exportStatus": cell["exportStatus"],
        })

    with optional_manifest_lock(
            args.manifest, args.manifest_lock_timeout, not args.no_manifest_lock):
        if args.manifest_mode == "merge" and os.path.isfile(args.manifest):
            try:
                with open(args.manifest, "r") as handle:
                    previous = json.load(handle)
                merged = {}
                for entry in previous.get("cells", []):
                    key = (entry.get("library"), entry.get("cell"), entry.get("view"))
                    merged[key] = entry
                for entry in cells:
                    key = (entry.get("library"), entry.get("cell"), entry.get("view"))
                    merged[key] = entry
                cells = list(merged.values())
            except (IOError, OSError, ValueError, TypeError):
                raise RuntimeError("Cannot merge invalid manifest %s" % args.manifest)

        manifest = {
            "schemaVersion": 2,
            "generatedAt": datetime.datetime.utcnow().isoformat() + "Z",
            "cells": sorted(cells, key=lambda item: (item["library"], item["cell"], item["view"])),
        }
        write_json_and_gzip(args.manifest, manifest)
    print("Converted %d layout JSON file(s)" % len(cells))


if __name__ == "__main__":
    main()
