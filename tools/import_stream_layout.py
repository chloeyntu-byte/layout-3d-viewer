#!/usr/bin/env python3
"""Import VL3D JSON, GDSII, or OASIS into compact schema v2 JSON.

gdstk is the primary stream parser.  A complete KLayout installation remains
an optional compatibility fallback.  Raw streams never invent pin or net
semantics: those are retained only when they already exist in schema-v2 JSON.
"""

from __future__ import print_function

import argparse
import datetime
import gzip
import hashlib
import json
import math
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile

# Support both direct CLI execution and importlib-based embedded callers.
_TOOLS_DIRECTORY = os.path.dirname(os.path.abspath(__file__))
if _TOOLS_DIRECTORY not in sys.path:
    sys.path.insert(0, _TOOLS_DIRECTORY)
from layout_units import validate_viewer_units
from pdk_profile import (classify_layer, load_registry, is_non_conductive_purpose,
                         is_non_conductive_layer_name)


PALETTE = (
    "#4dabf7", "#51cf66", "#ffd43b", "#f06595", "#b197fc", "#38d9a9",
    "#ff922b", "#66d9e8", "#e599f7", "#8ce99a", "#ffa8a8", "#74c0fc",
)
DEFAULT_MAX_INPUT_BYTES = 1024 * 1024 * 1024
DEFAULT_MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024
MAX_PROFILE_DIRECTORIES = 16
MAX_PROFILE_DIRECTORY_ENTRIES = 256
MAX_EXTERNAL_PROFILES = 64
MAX_EXTERNAL_PROFILE_BYTES = 1024 * 1024
MAX_EXTERNAL_PROFILE_TOTAL_BYTES = 8 * 1024 * 1024
RESOURCE_PRESETS = {
    "low": {"maxDepth": 6, "maxShapes": 100000},
    "balanced": {"maxDepth": 8, "maxShapes": 200000},
    "large": {"maxDepth": 16, "maxShapes": 1000000},
}


class StreamImportError(RuntimeError):
    def __init__(self, code, message, details=None):
        RuntimeError.__init__(self, message)
        self.code = code
        self.details = details or {}


def utc_now():
    return datetime.datetime.utcnow().isoformat(timespec="microseconds") + "Z"


def timestamp_stamp():
    return datetime.datetime.utcnow().strftime("%Y%m%d-%H%M%S")


def compact_number(value):
    rounded = round(float(value), 9)
    return 0.0 if rounded == 0 else rounded


def safe_segment(value):
    text = str(value or "").strip().replace("/", "_")
    return text or "unnamed"


def hierarchy_depth(path):
    return max(len(str(path or "").split("/")) - 1, 0)


def input_kind(path):
    normalized = path.lower()
    compressed = normalized.endswith(".gz")
    if compressed:
        normalized = normalized[:-3]
    if normalized.endswith(".json"):
        return "json", compressed
    if normalized.endswith((".gds", ".gdsii")):
        return "gds", compressed
    if normalized.endswith((".oas", ".oasis")):
        return "oas", compressed
    return None, compressed


def validate_stream_path(path):
    kind, _compressed = input_kind(path)
    if kind not in ("gds", "oas"):
        raise RuntimeError("Input must be GDSII or OASIS (.gds/.gdsii/.oas/.oasis, optionally .gz)")


def validate_input_path(path):
    kind, _compressed = input_kind(path)
    if kind is None:
        raise StreamImportError(
            "E6001",
            "Input must be VL3D JSON, GDSII, or OASIS (.json/.gds/.gdsii/.oas/.oasis, optionally .gz)",
        )
    return kind


def read_json_object(path, label, maximum_bytes=16 * 1024 * 1024):
    metadata = os.stat(path)
    if not os.path.isfile(path) or metadata.st_size <= 0 or metadata.st_size > maximum_bytes:
        raise StreamImportError("E6003", "%s has an invalid size" % label)
    with open(path, "rb") as handle:
        contents = handle.read(maximum_bytes + 1)
    if len(contents) > maximum_bytes:
        raise StreamImportError("E6003", "%s is too large" % label)
    try:
        payload = json.loads(contents.decode("utf-8"))
    except Exception as error:
        raise StreamImportError("E6003", "%s is not valid JSON: %s" % (label, error))
    if not isinstance(payload, dict):
        raise StreamImportError("E6003", "%s must contain a JSON object" % label)
    return payload, contents


def validate_layer_map_payload(payload):
    invalid = [
        key for key, value in payload.items()
        if value is not None and not isinstance(value, (dict, str))
    ]
    if invalid:
        raise RuntimeError("Layer map entry %s must be a string or JSON object" % sorted(invalid)[0])
    for key, value in payload.items():
        if not isinstance(value, dict):
            continue
        for field in ("name", "purpose", "color"):
            if field in value and (not isinstance(value[field], str) or not value[field].strip()):
                raise RuntimeError("Layer map %s.%s must be a non-empty string" % (key, field))
        for field in ("routing", "defaultVisible"):
            if field in value and not isinstance(value[field], bool):
                raise RuntimeError("Layer map %s.%s must be boolean" % (key, field))


def layer_map_descriptor(path):
    if not path:
        return {
            "provided": False,
            "sourceFile": "",
            "entryCount": 0,
            "sha256": "",
        }
    payload, contents = read_json_object(path, "Layer map")
    validate_layer_map_payload(payload)
    return {
        "provided": True,
        "sourceFile": os.path.basename(os.path.abspath(path)),
        "entryCount": len(payload),
        "sha256": hashlib.sha256(contents).hexdigest(),
    }


def validate_layer_map(path):
    return layer_map_descriptor(path)


def profile_payload(payload, contents, source_file, selection, source_kind):
    if payload.get("schemaVersion") != 1 or not isinstance(payload.get("id"), str) or not payload["id"].strip():
        raise StreamImportError("E5005", "PDK profile must use schemaVersion 1 and contain a non-empty id")
    candidate = payload.get("streamLayers", payload.get("streamLayerMap", {}))
    if candidate is None:
        candidate = {}
    if not isinstance(candidate, dict):
        raise StreamImportError("E5005", "PDK profile streamLayers must be a JSON object")
    if len(candidate) > 4096:
        raise StreamImportError("E5005", "PDK profile streamLayers exceeds 4096 entries")
    try:
        validate_layer_map_payload(candidate)
        mapping = calibrated_stream_mapping(normalized_stream_mapping(candidate))
    except (RuntimeError, TypeError, ValueError) as error:
        raise StreamImportError("E5005", "PDK profile streamLayers is invalid: %s" % error)
    aliases = [payload.get("id")]
    match = payload.get("match") if isinstance(payload.get("match"), dict) else {}
    for field in ("technologyLibraries", "aliases"):
        values = match.get(field, [])
        if values is None:
            values = []
        if not isinstance(values, list) or len(values) > 64 or any(not isinstance(value, str) for value in values):
            raise StreamImportError("E5005", "PDK profile match.%s must be a string array with at most 64 entries" % field)
        aliases.extend(values)
    descriptor = {
        "id": payload["id"].strip(),
        "sourceFile": source_file,
        "sha256": hashlib.sha256(contents).hexdigest(),
        "streamEntryCount": len(mapping),
        "selection": selection,
        "sourceKind": source_kind,
    }
    return {
        "id": descriptor["id"],
        "sourceFile": source_file,
        "sha256": descriptor["sha256"],
        "mapping": mapping,
        "aliases": aliases,
        "descriptor": descriptor,
    }


def load_mapping_sources(layer_map_path, pdk_profile_path):
    explicit = {}
    descriptor = layer_map_descriptor(layer_map_path)
    if layer_map_path:
        explicit, _contents = read_json_object(layer_map_path, "Layer map")
        validate_layer_map_payload(explicit)

    profile = None
    profile_mapping = {}
    profile_descriptor = None
    if pdk_profile_path:
        profile, contents = read_json_object(pdk_profile_path, "PDK profile")
        record = profile_payload(
            profile, contents, os.path.basename(os.path.abspath(pdk_profile_path)),
            "explicit", "explicit",
        )
        profile_mapping = record["mapping"]
        profile_descriptor = record["descriptor"]

    merged = dict(profile_mapping)
    merged.update(explicit)
    merged = normalized_stream_mapping(merged)
    return merged, descriptor, profile_descriptor


def stream_technology_metadata(descriptor, profile_descriptor=None):
    provided = bool(descriptor.get("provided"))
    profile_has_map = bool(profile_descriptor and profile_descriptor.get("streamEntryCount"))
    if profile_descriptor:
        profile_name = profile_descriptor["id"]
        source = "pdk-profile"
        semantics = "pdk-profile-layer-map" if profile_has_map else "geometry-only"
    else:
        profile_name = "stream-layer-map" if provided else "generic-stream"
        source = "layer-map" if provided else "stream-geometry"
        semantics = "layer-map" if provided else "geometry-only"
    result = {
        "library": "",
        "profile": profile_name,
        "source": source,
        "semantics": semantics,
        "layerMap": descriptor,
    }
    if profile_descriptor:
        result["pdkProfile"] = profile_descriptor
    return result


def source_snapshot(path):
    metadata = os.stat(path)
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(4 * 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return {
        "dev": metadata.st_dev,
        "ino": metadata.st_ino,
        "size": metadata.st_size,
        "mtimeNs": getattr(metadata, "st_mtime_ns", int(metadata.st_mtime * 1000000000)),
        "sha256": digest.hexdigest(),
    }


def assert_source_unchanged(path, expected):
    try:
        current = source_snapshot(path)
    except Exception as error:
        raise StreamImportError("E6008", "Source became unavailable during import: %s" % error)
    if current != expected:
        raise StreamImportError("E6008", "Source changed while it was being imported")


def atomic_write(path, contents):
    directory = os.path.dirname(path) or "."
    if not os.path.isdir(directory):
        os.makedirs(directory)
    temporary = "%s.tmp-%d-%s" % (path, os.getpid(), hashlib.sha256(os.urandom(16)).hexdigest()[:12])
    try:
        with open(temporary, "wb") as handle:
            handle.write(contents)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def gzip_bytes(contents):
    temporary = tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024)
    with gzip.GzipFile(fileobj=temporary, mode="wb", compresslevel=1, mtime=0) as compressed:
        compressed.write(contents)
    temporary.seek(0)
    result = temporary.read()
    temporary.close()
    return result


def backup_file(path, stamp):
    if not os.path.isfile(path):
        return None
    backup = "%s.bak-%s" % (path, stamp)
    shutil.copy2(path, backup)
    return backup


def write_layout_outputs(output_path, payload, force=False, backup=True):
    existing = [path for path in (output_path, output_path + ".gz") if os.path.exists(path)]
    if existing and not force:
        raise RuntimeError("Output already exists; pass --force to replace it: %s" % ", ".join(existing))
    stamp = timestamp_stamp()
    if backup:
        for path in existing:
            backup_file(path, stamp)
    contents = (json.dumps(payload, separators=(",", ":"), sort_keys=False) + "\n").encode("utf-8")
    atomic_write(output_path + ".gz", gzip_bytes(contents))
    atomic_write(output_path, contents)


def manifest_entry(payload, output_path, prefix):
    normalized_prefix = str(prefix or "").strip("/")
    relative_path = os.path.basename(output_path)
    if normalized_prefix:
        relative_path = "%s/%s" % (normalized_prefix, relative_path)
    return {
        "library": payload["library"],
        "cell": payload["cell"],
        "view": payload["view"],
        "path": relative_path,
        "sourceFormat": payload.get("sourceFormat", "VL3D-JSON"),
        "shapeCount": payload.get("shapeCount", len(payload.get("shapes", []))),
        "sourceShapeCount": payload.get("sourceShapeCount", len(payload.get("shapes", []))),
        "instanceCount": payload.get("instanceCount", len(payload.get("instances", []))),
        "pinCount": payload.get("pinCount", len(payload.get("pins", []))),
        "connectionCount": payload.get("connectionCount", len(payload.get("connections", []))),
        "layerCount": len(payload.get("layers", [])),
        "maxShapeDepth": payload.get("maxShapeDepth", 0),
        "maxInstanceDepth": payload.get("maxInstanceDepth", 0),
        "ownerCellCount": payload.get("ownerCellCount", 0),
        "bbox": payload.get("bbox", {"min": [0, 0], "max": [0, 0]}),
        "exportStatus": payload.get("exportStatus", {}),
        "technology": payload.get("technology", {}),
        "warnings": payload.get("warnings", []),
        "source": payload.get("source", {}),
    }


def update_manifest(path, payload, output_path, mode, prefix, backup=True):
    if mode == "merge" and os.path.isfile(path):
        with open(path, "r") as handle:
            manifest = json.load(handle)
        if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 2:
            raise RuntimeError("Existing manifest is not schema v2")
    else:
        manifest = {"schemaVersion": 2, "cells": []}
    entry = manifest_entry(payload, output_path, prefix)
    cells = manifest.get("cells", []) if isinstance(manifest.get("cells", []), list) else []
    identity = (entry["library"], entry["cell"], entry["view"])
    cells = [cell for cell in cells if (
        cell.get("library"), cell.get("cell"), cell.get("view")
    ) != identity]
    cells.append(entry)
    cells.sort(key=lambda cell: (
        str(cell.get("library", "")), str(cell.get("cell", "")), str(cell.get("view", ""))
    ))
    manifest.update({"schemaVersion": 2, "generatedAt": utc_now(), "cells": cells})
    stamp = timestamp_stamp()
    if backup:
        backup_file(path, stamp)
        backup_file(path + ".gz", stamp)
    contents = (json.dumps(manifest, separators=(",", ":")) + "\n").encode("utf-8")
    atomic_write(path + ".gz", gzip_bytes(contents))
    atomic_write(path, contents)


def resolve_klayout(requested):
    configured = os.environ.get("KLAYOUT_BIN")
    if requested:
        candidates = [requested]
        source = "--klayout"
    elif configured:
        candidates = [configured]
        source = "KLAYOUT_BIN"
    else:
        candidates = ["/usr/bin/klayout", "klayout"]
        source = "KLayout"
    for candidate in candidates:
        resolved = shutil.which(candidate) if not os.path.isabs(candidate) else candidate
        if resolved and os.path.isfile(resolved) and os.access(resolved, os.X_OK):
            return os.path.abspath(resolved)
    raise RuntimeError("%s executable not found: %s" % (source, candidates[0]))


def resolve_gdstk():
    try:
        import gdstk  # pylint: disable=import-outside-toplevel
        return gdstk
    except Exception as error:
        raise RuntimeError("gdstk is unavailable: %s" % error)


def rd(name, value):
    text = str(value)
    if "\n" in text or "\r" in text:
        raise RuntimeError("KLayout -rd values cannot contain newlines")
    return ["-rd", "%s=%s" % (name, text)]


def missing_plugin_hint(klayout):
    candidates = []
    if klayout == "/usr/bin/klayout":
        candidates.extend(("/usr/lib64/klayout/db_plugins", "/usr/lib/klayout/db_plugins"))
    if candidates and not any(os.path.isdir(path) for path in candidates):
        return (
            "KLayout database plugins are missing at %s. The executable alone cannot read "
            "GDSII/OASIS; verify the package or use gdstk/a complete portable KLayout installation."
        ) % " or ".join(candidates)
    return ""


def affine_identity():
    return (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def affine_compose(parent, local):
    pa, pb, pc, pd, ptx, pty = parent
    la, lb, lc, ld, ltx, lty = local
    return (
        pa * la + pc * lb,
        pb * la + pd * lb,
        pa * lc + pc * ld,
        pb * lc + pd * ld,
        pa * ltx + pc * lty + ptx,
        pb * ltx + pd * lty + pty,
    )


def affine_apply(transform, point):
    a, b, c, d, tx, ty = transform
    x, y = point
    return (a * x + c * y + tx, b * x + d * y + ty)


def reference_affine(reference, offset):
    angle = float(reference.rotation or 0.0)
    magnification = float(reference.magnification or 1.0)
    reflected_scale = -magnification if reference.x_reflection else magnification
    cosine = math.cos(angle)
    sine = math.sin(angle)
    origin = reference.origin
    return (
        cosine * magnification,
        sine * magnification,
        -sine * reflected_scale,
        cosine * reflected_scale,
        float(origin[0]) + float(offset[0]),
        float(origin[1]) + float(offset[1]),
    )


def transform_record(transform, unit_to_microns):
    a, b, c, d, tx, ty = transform
    magnification = math.sqrt(a * a + b * b)
    return {
        "angle": compact_number(math.degrees(math.atan2(b, a))),
        "magnification": compact_number(magnification),
        "mirror": (a * d - b * c) < 0,
        "translation": [compact_number(tx * unit_to_microns), compact_number(ty * unit_to_microns)],
    }


def bbox_from_points(points):
    if not points:
        return {"min": [0.0, 0.0], "max": [0.0, 0.0]}
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return {
        "min": [compact_number(min(xs)), compact_number(min(ys))],
        "max": [compact_number(max(xs)), compact_number(max(ys))],
    }


def transformed_bbox(bbox, transform, unit_to_microns):
    if bbox is None:
        return {"min": [0.0, 0.0], "max": [0.0, 0.0]}
    lower, upper = bbox
    points = [
        affine_apply(transform, (lower[0], lower[1])),
        affine_apply(transform, (upper[0], lower[1])),
        affine_apply(transform, (upper[0], upper[1])),
        affine_apply(transform, (lower[0], upper[1])),
    ]
    return bbox_from_points([
        (point[0] * unit_to_microns, point[1] * unit_to_microns) for point in points
    ])


def rectangle_points(points):
    if len(points) != 4:
        return False
    xs = sorted(set(round(point[0], 9) for point in points))
    ys = sorted(set(round(point[1], 9) for point in points))
    return len(xs) == 2 and len(ys) == 2 and set(
        (round(point[0], 9), round(point[1], 9)) for point in points
    ) == set((x, y) for x in xs for y in ys)


def mapping_for(mapping, layer_number, datatype):
    return mapping.get("%d/%d" % (layer_number, datatype),
                       mapping.get("%d:%d" % (layer_number, datatype),
                                   mapping.get(str(layer_number))))


def normalized_stream_mapping(mapping):
    """Infer from explicit names, never from layer numbers; honor custom metadata."""
    registry = load_registry()
    generic = registry["profiles"]["generic"]
    result = {}
    for key, entry in mapping.items():
        if entry is None:
            result[key] = {"kind": "auxiliary", "semantic": "excluded",
                           "routing": False, "defaultVisible": False}
            continue
        metadata = {"name": entry} if isinstance(entry, str) else dict(entry)
        name = metadata.get("name", "")
        info = classify_layer(registry, generic, name, metadata.get("purpose"))
        inferred_kind = info.get("kind")
        info.update(metadata)
        if info.get("kind") in ("contact", "via"):
            has_lower = bool(metadata.get("lowerLayer") or metadata.get("lowerLayers"))
            has_upper = bool(metadata.get("upperLayer") or metadata.get("upperLayers"))
            info["connectivitySource"] = (metadata.get("connectivitySource", "explicit-stream-map")
                                          if has_lower and has_upper else "name-inference")
        # An explicitly supplied custom conductor kind is meaningful even when
        # the name does not follow generic M/VIA conventions.
        if "kind" in metadata and "routing" not in metadata:
            info["routing"] = metadata["kind"] in ("metal", "via", "poly", "contact")
        if ("kind" in metadata and "semantic" not in metadata
                and (info.get("semantic") == "unknown" or metadata["kind"] != inferred_kind)):
            info["semantic"] = metadata["kind"]
        if "defaultVisible" not in metadata:
            info["defaultVisible"] = info.get("routing") is True
        explicit_conductor = (metadata.get("kind") in ("metal", "via", "poly", "contact")
                              and info.get("routing") is True)
        if (is_non_conductive_layer_name(name, explicit_conductor=explicit_conductor)
                or is_non_conductive_purpose(metadata.get("purpose"))
                or info.get("kind") in ("active", "substrate", "auxiliary")):
            info.update({"routing": False, "defaultVisible": False})
        result[key] = info
    metals = {}
    for entry in result.values():
        if entry.get("kind") == "metal" and entry.get("metal") is not None and entry.get("name"):
            metals.setdefault(entry["metal"], entry["name"])
    for entry in result.values():
        for side in ("lower", "upper"):
            number = entry.get(side + "Metal")
            if number in metals and not entry.get(side + "Layer"):
                entry[side + "Layer"] = metals[number]
    return result


def calibrated_stream_mapping(mapping):
    calibrated = dict(
        (key, dict(value) if isinstance(value, dict) else value)
        for key, value in mapping.items()
    )
    base = 0.0
    routing = [
        value for value in calibrated.values()
        if isinstance(value, dict) and (value.get("routing") is True or value.get("kind") == "active")
    ]
    for metadata in sorted(routing, key=lambda item: float(item.get("stackIndex", 0.0))):
        thickness = float(metadata.get("thickness", metadata.get("thicknessUm", 0.2)))
        explicit_bottom = metadata.get("zBottomUm")
        explicit_top = metadata.get("zTopUm")
        if explicit_bottom is not None and explicit_top is not None:
            bottom = float(explicit_bottom)
            top = float(explicit_top)
            if "capacitor-top-metal" not in str(metadata.get("semantic", "")).lower():
                base = max(base, top)
        elif "capacitor-top-metal" in str(metadata.get("semantic", "")).lower():
            bottom = max(0.0, base - thickness)
            top = bottom + thickness
        else:
            bottom = base
            top = bottom + thickness
            base = top
        metadata["zBottomUm"] = compact_number(bottom)
        metadata["zTopUm"] = compact_number(top)
    return calibrated


def stream_pairs(layout):
    pairs = set()
    for cell in layout.cells:
        for polygon in cell.polygons:
            pairs.add((int(polygon.layer), int(polygon.datatype)))
        for path in cell.paths:
            pairs.update(
                (int(layer), int(datatype))
                for layer, datatype in zip(list(path.layers), list(path.datatypes))
            )
    return pairs


def _normalized_hint(value):
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def _external_profile_object(path):
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise StreamImportError("E5008", "Cannot safely open PDK profile %s: %s" % (os.path.basename(path), error))
    try:
        metadata = os.fstat(descriptor)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1
                or metadata.st_size <= 0 or metadata.st_size > MAX_EXTERNAL_PROFILE_BYTES):
            raise StreamImportError("E5008", "PDK profile %s has an invalid size or file type" % os.path.basename(path))
        chunks = []
        remaining = MAX_EXTERNAL_PROFILE_BYTES + 1
        while remaining > 0:
            chunk = os.read(descriptor, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        contents = b"".join(chunks)
    finally:
        os.close(descriptor)
    if len(contents) > MAX_EXTERNAL_PROFILE_BYTES:
        raise StreamImportError("E5008", "PDK profile %s is too large" % os.path.basename(path))
    try:
        payload = json.loads(contents.decode("utf-8"))
    except Exception as error:
        raise StreamImportError("E5008", "PDK profile %s is not valid JSON: %s" % (os.path.basename(path), error))
    if not isinstance(payload, dict):
        raise StreamImportError("E5008", "PDK profile %s must contain a JSON object" % os.path.basename(path))
    return payload, contents


def _external_stream_profiles(directories):
    directories = list(directories or [])
    if len(directories) > MAX_PROFILE_DIRECTORIES:
        raise StreamImportError("E5008", "At most %d PDK profile directories are allowed" % MAX_PROFILE_DIRECTORIES)
    profiles = []
    total_bytes = 0
    seen_directories = set()
    for directory in directories:
        raw_directory = str(directory or "")
        if not os.path.isabs(raw_directory):
            raise StreamImportError("E5008", "PDK profile directory must be an absolute non-symlink path")
        requested = os.path.abspath(raw_directory)
        canonical = os.path.realpath(requested)
        if not directory or requested != canonical or canonical in seen_directories:
            if canonical in seen_directories:
                continue
            raise StreamImportError("E5008", "PDK profile directory must be an absolute non-symlink path")
        seen_directories.add(canonical)
        try:
            metadata = os.lstat(canonical)
            names = sorted(os.listdir(canonical))
        except OSError as error:
            raise StreamImportError("E5008", "PDK profile directory is unavailable: %s" % error)
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise StreamImportError("E5008", "PDK profile directory must not be a symlink and must be a directory")
        if len(names) > MAX_PROFILE_DIRECTORY_ENTRIES:
            raise StreamImportError(
                "E5008", "PDK profile directory exceeds %d entries" % MAX_PROFILE_DIRECTORY_ENTRIES,
            )
        for name in names:
            path = os.path.join(canonical, name)
            try:
                entry = os.lstat(path)
            except OSError as error:
                raise StreamImportError("E5008", "Cannot inspect PDK profile directory entry: %s" % error)
            if stat.S_ISLNK(entry.st_mode):
                raise StreamImportError("E5008", "PDK profile directories must not contain symlinks: %s" % name)
            if not name.lower().endswith(".json"):
                continue
            if not stat.S_ISREG(entry.st_mode):
                raise StreamImportError("E5008", "PDK profile JSON must be a regular file: %s" % name)
            if len(profiles) >= MAX_EXTERNAL_PROFILES:
                raise StreamImportError("E5008", "At most %d external PDK profiles are allowed" % MAX_EXTERNAL_PROFILES)
            payload, contents = _external_profile_object(path)
            total_bytes += len(contents)
            if total_bytes > MAX_EXTERNAL_PROFILE_TOTAL_BYTES:
                raise StreamImportError("E5008", "External PDK profiles exceed the total byte limit")
            try:
                profiles.append(profile_payload(
                    payload, contents, name, "stream-auto-external", "external",
                ))
            except StreamImportError as error:
                raise StreamImportError(
                    "E5008", "Invalid external PDK profile %s: %s" % (name, error),
                    {"profile": name, "cause": error.code},
                )
    return profiles


def _builtin_stream_profiles(include_unmapped=False):
    directory = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "profiles")
    profiles = []
    for name in sorted(os.listdir(directory)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(directory, name)
        profile, contents = read_json_object(path, "PDK profile")
        if profile.get("id") == "generic":
            continue  # A generic fallback is not a conflicting process identity.
        mapping = profile.get("streamLayers")
        if not mapping and not include_unmapped:
            continue
        profiles.append(profile_payload(profile, contents, name, "stream-auto-builtin", "builtin"))
    return profiles


def _infer_from_profiles(observed, input_path, profiles, source_kind, identity_profiles=None):
    path_hint = _normalized_hint(os.path.abspath(input_path))
    candidates = []
    numeric_candidates = []
    conflicting_identities = set()
    path_identities = []
    for identity in identity_profiles or profiles:
        matched_aliases = set(alias for alias in (_normalized_hint(item) for item in identity["aliases"])
                              if len(alias) >= 5 and alias in path_hint)
        if matched_aliases:
            path_identities.append((identity["id"], matched_aliases))
    for profile in profiles:
        matched = []
        metals = set()
        connectors = set()
        for layer_number, datatype in observed:
            metadata = mapping_for(profile["mapping"], layer_number, datatype)
            if not isinstance(metadata, dict) or metadata.get("routing") is not True:
                continue
            matched.append((layer_number, datatype))
            kind = str(metadata.get("kind") or "").lower()
            if kind == "metal":
                metals.add(metadata.get("metal", metadata.get("name")))
            elif kind in ("via", "contact"):
                connectors.add(metadata.get("name", (layer_number, datatype)))
        alias_match = any(
            len(alias) >= 5 and alias in path_hint
            for alias in (_normalized_hint(item) for item in profile["aliases"])
            if alias
        )
        strong_numeric = len(metals) >= 3 and len(connectors) >= 1 and len(matched) >= 4
        path_and_numeric = alias_match and len(metals) >= 1 and len(matched) >= 2
        if strong_numeric:
            numeric_candidates.append(profile["id"])
        # Numeric GDS layer IDs are process-local. A coincidental ID signature
        # is only a suggestion, never sufficient evidence to assign a PDK.
        if not path_and_numeric:
            continue
        aliases = set(_normalized_hint(item) for item in profile["aliases"])
        conflicts = set(identity for identity, matched_aliases in path_identities
                        if not matched_aliases.issubset(aliases))
        if conflicts:
            # A migration/comparison directory can name both old and new PDKs.
            # Include known processes without a numeric map in this guard too.
            conflicting_identities.update(conflicts | {profile["id"]})
            continue
        candidates.append({
            "profile": profile,
            "pathAlias": alias_match,
            "matchedRoutingPairs": len(matched),
            "matchedMetals": len(metals),
            "matchedConnectors": len(connectors),
        })
    if len(candidates) != 1:
        return None, {
            "status": "ambiguous" if candidates or conflicting_identities else ("unconfirmed" if numeric_candidates else "none"),
            "candidates": sorted(conflicting_identities) or sorted(item["profile"]["id"] for item in candidates) or sorted(numeric_candidates),
            "observedPairCount": len(observed),
            "source": source_kind,
        }
    candidate = candidates[0]
    profile = candidate["profile"]
    evidence = {
        "pathAlias": candidate["pathAlias"],
        "matchedRoutingPairs": candidate["matchedRoutingPairs"],
        "matchedMetals": candidate["matchedMetals"],
        "matchedConnectors": candidate["matchedConnectors"],
    }
    descriptor = dict(profile["descriptor"])
    descriptor.update({"confidence": "high", "evidence": evidence})
    return (profile["mapping"], descriptor), {
        "status": "matched", "profile": profile["id"], "confidence": "high",
        "source": source_kind, "evidence": evidence,
    }


def infer_stream_profile(layout, input_path, pdk_profile_dirs=None):
    return infer_stream_profile_pairs(stream_pairs(layout), input_path, pdk_profile_dirs)


def infer_stream_profile_pairs(observed, input_path, pdk_profile_dirs=None):
    observed = set((int(layer), int(datatype)) for layer, datatype in observed)
    external_profiles = _external_stream_profiles(pdk_profile_dirs)
    builtin_profiles = _builtin_stream_profiles(include_unmapped=True)
    identities = external_profiles + builtin_profiles
    if external_profiles:
        inferred, detection = _infer_from_profiles(observed, input_path, external_profiles, "external", identities)
        if inferred or detection.get("status") in ("ambiguous", "unconfirmed"):
            return inferred, detection
    inferred, detection = _infer_from_profiles(observed, input_path, builtin_profiles, "builtin", identities)
    if external_profiles and detection.get("status") == "none":
        detection["externalProfileCount"] = len(external_profiles)
    return inferred, detection


class GdstkImporter(object):
    def __init__(self, gdstk, library, input_path, logical_library, top_name, max_depth,
                 max_shapes, layer_map, technology, source):
        self.gdstk = gdstk
        self.layout = library
        self.input_path = input_path
        self.logical_library = logical_library
        self.top_name = top_name
        self.max_depth = max_depth
        self.max_shapes = max_shapes
        self.layer_map = layer_map
        self.technology = technology
        self.source = source
        self.unit_to_microns = float(library.unit) * 1000000.0
        self.source_dbu_microns = float(library.precision) * 1000000.0
        self.cells = {cell.name: cell for cell in library.cells}
        self.shapes = []
        self.instances = []
        self.layers = {}
        self.layer_shape_counts = {}
        self.source_shapes_seen = 0
        self.unsupported_shapes = 0
        self.cycles_skipped = 0
        self.depth_limited = False
        self.truncated = False
        self.max_depth_reached = 0
        self.instance_serials = {}
        self.used_instance_names = {}

    def select_top(self):
        top_cells = sorted(self.layout.top_level(), key=lambda cell: cell.name)
        candidates = [cell.name for cell in top_cells]
        if self.top_name:
            selected = self.cells.get(self.top_name)
            if selected is None:
                raise StreamImportError(
                    "E6002", "Top cell %r was not found" % self.top_name,
                    {"topCells": candidates, "requestedTop": self.top_name},
                )
            return selected, candidates
        if len(top_cells) == 1:
            return top_cells[0], candidates
        if not top_cells:
            raise StreamImportError("E6002", "No top cell was found", {"topCells": []})
        raise StreamImportError(
            "E6002", "Multiple top cells found; select one explicitly",
            {"topCells": candidates, "selectionRequired": True},
        )

    def collect_layer_metadata(self):
        pairs = stream_pairs(self.layout)
        requested_names = {}
        for approximate_index, (layer_number, datatype) in enumerate(sorted(pairs)):
            mapped = mapping_for(self.layer_map, layer_number, datatype)
            mapping_present = (isinstance(mapped, str) and bool(mapped.strip())) or (
                isinstance(mapped, dict) and bool(mapped)
            )
            metadata = mapped if isinstance(mapped, dict) else {}
            default_name = "L%d_D%d" % (layer_number, datatype)
            requested = mapped if isinstance(mapped, str) else metadata.get("name", default_name)
            requested = str(requested or default_name).strip() or default_name
            requested_names[requested] = requested_names.get(requested, 0) + 1
            unique_name = requested
            if requested_names[requested] > 1:
                unique_name = "%s__L%d_D%d" % (requested, layer_number, datatype)
            stack_index = metadata.get("stackIndex", approximate_index)
            thickness = metadata.get("thickness", metadata.get("thicknessUm", 0.2))
            approximate_bottom = compact_number(approximate_index * 0.25)
            approximate_top = compact_number(approximate_bottom + float(thickness))
            self.layers[(layer_number, datatype)] = {
                "name": unique_name,
                "layerNumber": layer_number,
                "datatype": datatype,
                "sourceName": "",
                "purpose": metadata.get("purpose", "drawing"),
                "color": metadata.get("color", PALETTE[(layer_number * 17 + datatype) % len(PALETTE)]),
                "kind": metadata.get("kind", "stream"),
                "semantic": metadata.get("semantic", metadata.get("kind", "unknown")),
                "routing": bool(metadata.get("routing", False)),
                "defaultVisible": bool(metadata.get("defaultVisible", False)),
                "stackIndex": float(stack_index),
                "stackIndexSource": "layer-map" if mapping_present else "stream-order",
                "thickness": float(thickness),
                "thicknessSource": metadata.get(
                    "thicknessSource", "layer-map" if (
                        "thickness" in metadata or "thicknessUm" in metadata
                    ) else "stream-default"
                ),
                "metadataSource": "layer-map" if mapping_present else "stream-default",
                "lowerLayer": metadata.get("lowerLayer"),
                "upperLayer": metadata.get("upperLayer"),
                "lowerLayers": metadata.get("lowerLayers", []),
                "upperLayers": metadata.get("upperLayers", []),
                "connectivitySource": metadata.get("connectivitySource", "name-inference"),
            }
            for field in ("metal", "lowerMetal", "upperMetal", "zBottomUm", "zTopUm", "approximate"):
                if field in metadata:
                    self.layers[(layer_number, datatype)][field] = metadata[field]
            if not mapping_present:
                self.layers[(layer_number, datatype)].update({
                    "approximate": True,
                    "zBottomUm": approximate_bottom,
                    "zTopUm": approximate_top,
                    "stackIndexSource": "stable-layer-datatype-order",
                    "thicknessSource": "visualization-approximation",
                })

    def unique_instance_name(self, parent, requested):
        name = safe_segment(requested)
        names = self.used_instance_names.setdefault(parent, {})
        names[name] = names.get(name, 0) + 1
        return name if names[name] == 1 else "%s#%d" % (name, names[name])

    def reference_offsets(self, reference):
        if reference.repetition is None:
            return [(0.0, 0.0)]
        offsets = [tuple(offset) for offset in reference.repetition.get_offsets()]
        return offsets or [(0.0, 0.0)]

    def master_for_reference(self, reference):
        master = reference.cell
        if isinstance(master, str):
            return self.cells.get(master)
        return master

    def emit_polygon(self, polygon, owner_cell, path, transform):
        self.source_shapes_seen += 1
        if self.max_shapes > 0 and len(self.shapes) >= self.max_shapes:
            self.truncated = True
            return
        key = (int(polygon.layer), int(polygon.datatype))
        layer = self.layers.get(key)
        if layer is None:
            self.unsupported_shapes += 1
            return
        points = []
        for point in polygon.points:
            world = affine_apply(transform, point)
            points.append([
                compact_number(world[0] * self.unit_to_microns),
                compact_number(world[1] * self.unit_to_microns),
            ])
        if len(points) < 3:
            self.unsupported_shapes += 1
            return
        record = {
            "id": len(self.shapes),
            "ownerCell": owner_cell,
            "hierPath": path,
            "layer": layer["name"],
            "layerNumber": key[0],
            "datatype": key[1],
            "purpose": layer.get("purpose", "drawing"),
            "net": "",
            "label": "",
            "type": "box" if rectangle_points(points) else "polygon",
            "width": 0.0,
            "bbox": bbox_from_points(points),
            "points": points,
        }
        self.shapes.append(record)
        self.layer_shape_counts[layer["name"]] = self.layer_shape_counts.get(layer["name"], 0) + 1

    def emit_cell_shapes(self, cell, path, transform):
        for polygon in cell.polygons:
            if self.truncated:
                return
            self.emit_polygon(polygon, cell.name, path, transform)
        for path_geometry in cell.paths:
            if self.truncated:
                return
            polygons = path_geometry.to_polygons()
            if not polygons:
                self.source_shapes_seen += 1
                self.unsupported_shapes += 1
            for polygon in polygons:
                if self.truncated:
                    return
                self.emit_polygon(polygon, cell.name, path, transform)

    def traverse(self, cell, path, transform, depth, ancestry):
        if self.truncated:
            return
        self.max_depth_reached = max(self.max_depth_reached, depth)
        self.emit_cell_shapes(cell, path, transform)
        if self.truncated:
            return
        if depth >= self.max_depth:
            if cell.references:
                self.depth_limited = True
            return
        for reference in cell.references:
            master = self.master_for_reference(reference)
            if master is None:
                self.unsupported_shapes += 1
                continue
            offsets = self.reference_offsets(reference)
            parent_serial = self.instance_serials.get(path, 0) + 1
            self.instance_serials[path] = parent_serial
            base_name = "I%d_%s" % (parent_serial, safe_segment(master.name))
            for element_index, offset in enumerate(offsets):
                if self.truncated:
                    return
                requested = "%s[%d]" % (base_name, element_index) if len(offsets) > 1 else base_name
                element_name = self.unique_instance_name(path, requested)
                child_path = "%s/%s" % (path, safe_segment(element_name))
                child_transform = affine_compose(transform, reference_affine(reference, offset))
                record = {
                    "id": len(self.instances),
                    "hierPath": child_path,
                    "parentPath": path,
                    "name": element_name,
                    "master": {"library": self.logical_library, "cell": master.name, "view": "layout"},
                    "bbox": transformed_bbox(master.bounding_box(), child_transform, self.unit_to_microns),
                    "transform": transform_record(child_transform, self.unit_to_microns),
                }
                if len(offsets) > 1:
                    record["arrayElementIndex"] = element_index
                self.instances.append(record)
                if master.name in ancestry or master.name == cell.name:
                    self.cycles_skipped += 1
                    continue
                self.traverse(master, child_path, child_transform, depth + 1, ancestry + [cell.name])

    def build_layers(self):
        used = [
            layer for layer in self.layers.values()
            if self.layer_shape_counts.get(layer["name"], 0) > 0
        ]
        used.sort(key=lambda layer: (layer["stackIndex"], layer["layerNumber"], layer["datatype"]))
        result = []
        for index, layer in enumerate(used):
            record = dict(layer)
            if record["stackIndexSource"] != "layer-map":
                record["stackIndex"] = index
            record.update({
                "index": index,
                "shapeCount": self.layer_shape_counts.get(record["name"], 0),
                "connectorCount": 0,
                "z": index,
                "height": 0.35,
            })
            result.append(record)
        return result

    def run(self, source_format):
        top_cell, candidates = self.select_top()
        self.collect_layer_metadata()
        root_path = safe_segment(top_cell.name)
        self.traverse(top_cell, root_path, affine_identity(), 0, [])
        layers = self.build_layers()
        unclassified = sorted(
            layer["name"] for layer in layers if layer["metadataSource"] == "stream-default"
        )
        technology = dict(self.technology)
        technology.update({
            "unclassifiedLayers": unclassified,
            "usedLayerCount": len(layers),
            "mappedLayerCount": len(layers) - len(unclassified),
            "stackAccuracy": "approximate" if unclassified else "profile-or-layer-map",
            "signoffSuitable": False if unclassified else technology.get("signoffSuitable", False),
        })
        descriptor = technology.get("layerMap", {})
        if not descriptor.get("provided") and not technology.get("pdkProfile", {}).get("streamEntryCount"):
            warnings = [{
                "code": "stream-generic-geometry",
                "severity": "warning",
                "message": "VL3D-E6006: no authoritative layer map was supplied or inferred; unmapped layer/datatype pairs are retained but hidden until classified. Approximate Z positions are non-signoff.",
            }]
        elif unclassified:
            warnings = [{
                "code": "stream-layer-map-partial",
                "severity": "warning",
                "message": "VL3D-E6006: the selected mapping leaves %d used layers visible with approximate, non-signoff Z positions: %s" % (
                    len(unclassified), ", ".join(unclassified[:12]) + (", ..." if len(unclassified) > 12 else "")
                ),
            }]
        else:
            warnings = []
        detection = technology.get("streamProfileDetection", {})
        if detection.get("status") == "matched":
            warnings.append({
                "code": "pdk-profile-inferred",
                "severity": "warning",
                "message": "VL3D-E5007: inferred %s from a matching process name and compatible %s layer map; use Advanced settings to override it"
                           % (detection.get("profile"), detection.get("source", "built-in")),
            })
        elif detection.get("status") == "ambiguous":
            warnings.append({
                "code": "stream-profile-ambiguous",
                "severity": "warning",
                "message": "VL3D-E5009: multiple %s PDK profiles matched; unmapped geometry is retained but hidden until an explicit profile is selected"
                           % detection.get("source", "candidate"),
            })
        shape_depths = [hierarchy_depth(shape["hierPath"]) for shape in self.shapes]
        instance_depths = [hierarchy_depth(instance["hierPath"]) for instance in self.instances]
        status = {
            "parser": "gdstk",
            "sourceFormat": source_format,
            "topCells": candidates,
            "shapesSeen": self.source_shapes_seen,
            "shapesEmitted": len(self.shapes),
            "truncated": self.truncated,
            "complete": not self.truncated and not self.depth_limited,
            "maxDepthReached": self.max_depth_reached,
            "maxDepthRequested": self.max_depth,
            "maxShapesRequested": self.max_shapes,
            "depthLimited": self.depth_limited,
            "pinsEmitted": 0,
            "connectionsEmitted": 0,
            "unsupportedShapesSkipped": self.unsupported_shapes,
            "cyclesSkipped": self.cycles_skipped,
            "unclassifiedLayerCount": len(unclassified),
            "warningCount": len(warnings),
        }
        return {
            "schemaVersion": 2,
            "sourceSchemaVersion": 2,
            "generatedAt": utc_now(),
            "sourceFormat": source_format,
            "sourceFile": os.path.basename(self.input_path),
            "source": self.source,
            "units": "um",
            "technology": technology,
            "warnings": warnings,
            "library": self.logical_library,
            "cell": top_cell.name,
            "view": "layout",
            "rootPath": root_path,
            "dbuPerMicron": compact_number(1.0 / self.source_dbu_microns) if self.source_dbu_microns > 0 else 0,
            "sourceDbuMicrons": compact_number(self.source_dbu_microns),
            "bbox": transformed_bbox(top_cell.bounding_box(), affine_identity(), self.unit_to_microns),
            "sourceShapeCount": self.source_shapes_seen,
            "shapeCount": len(self.shapes),
            "instanceCount": len(self.instances),
            "pinCount": 0,
            "connectionCount": 0,
            "maxShapeDepth": max(shape_depths) if shape_depths else 0,
            "maxInstanceDepth": max(instance_depths) if instance_depths else 0,
            "ownerCellCount": len(set(shape["ownerCell"] for shape in self.shapes)),
            "layers": layers,
            "shapes": self.shapes,
            "instances": self.instances,
            "pins": [],
            "connections": [],
            "netlistStatus": {
                "available": False,
                "reason": "GDSII/OASIS geometry streams do not contain authoritative OA net, terminal, or pin connectivity",
            },
            "exportStatus": status,
        }


def read_gdstk_layout(gdstk, path, kind):
    if kind == "gds":
        return gdstk.read_gds(path)
    return gdstk.read_oas(path)


def import_with_gdstk(path, original_path, kind, arguments, layer_map, technology, source):
    gdstk = resolve_gdstk()
    try:
        layout = read_gdstk_layout(gdstk, path, kind)
    except Exception as error:
        raise StreamImportError("E6004", "gdstk could not read the stream: %s" % error, {"parser": "gdstk"})
    if not layout.cells:
        raise StreamImportError("E6004", "gdstk read an empty stream database", {"parser": "gdstk"})
    effective_layer_map = layer_map
    effective_technology = technology
    if not arguments.layer_map and not arguments.pdk_profile:
        inferred, detection = infer_stream_profile(layout, original_path, arguments.pdk_profile_dir)
        effective_technology = dict(technology)
        effective_technology["streamProfileDetection"] = detection
        if inferred:
            effective_layer_map, profile_descriptor = inferred
            effective_technology = stream_technology_metadata(
                {"provided": False, "sourceFile": "", "entryCount": 0, "sha256": ""},
                profile_descriptor,
            )
            effective_technology["profileMatch"] = detection.get("source", "builtin") + "-stream-auto"
            effective_technology["streamProfileDetection"] = detection
    importer = GdstkImporter(
        gdstk, layout, original_path, arguments.library or "STREAM", arguments.top, arguments.max_depth,
        arguments.max_shapes, effective_layer_map, effective_technology, source,
    )
    return importer.run("GDSII" if kind == "gds" else "OASIS")


def finalize_stream_payload(payload, resource_mode, max_depth, max_shapes):
    layers = payload.get("layers") if isinstance(payload.get("layers"), list) else []
    unclassified = []
    for index, layer in enumerate(layers):
        if not isinstance(layer, dict):
            continue
        layer.setdefault("defaultVisible", layer.get("routing") is True)
        if layer.get("metadataSource") != "stream-default":
            if layer.get("semantic") == "unknown" and layer.get("routing") is not True:
                unclassified.append(layer.get("name", "LAYER_%d" % index))
            continue
        try:
            thickness = max(0.01, float(layer.get("thickness", 0.2)))
        except (TypeError, ValueError):
            thickness = 0.2
        bottom = compact_number(index * 0.25)
        layer.update({
            "defaultVisible": False,
            "routing": False,
            "approximate": True,
            "stackIndex": index,
            "stackIndexSource": "stable-layer-datatype-order",
            "thickness": compact_number(thickness),
            "thicknessSource": "visualization-approximation",
            "zBottomUm": bottom,
            "zTopUm": compact_number(bottom + thickness),
        })
        unclassified.append(layer.get("name", "LAYER_%d" % index))
    technology = payload.setdefault("technology", {})
    if isinstance(technology, dict):
        technology["resourceMode"] = resource_mode
        if unclassified:
            technology.update({
                "stackAccuracy": "approximate",
                "signoffSuitable": False,
                "unclassifiedLayers": sorted(unclassified),
            })
    warnings = payload.setdefault("warnings", [])
    if not isinstance(warnings, list):
        warnings = []
        payload["warnings"] = warnings
    if unclassified and not any(isinstance(item, dict) and item.get("code") in (
            "stream-generic-geometry", "stream-layer-map-partial") for item in warnings):
        warnings.append({"code": "stream-layer-map-partial", "severity": "warning"})
    for warning in warnings:
        if not isinstance(warning, dict):
            continue
        if warning.get("code") == "stream-generic-geometry":
            warning["message"] = (
                "VL3D-E6006: no unique authoritative numeric layer map was found; used "
                "layer/datatype pairs are retained but hidden until a layer map or PDK profile "
                "identifies them. Their approximate Z order is non-signoff."
            )
        elif warning.get("code") == "stream-layer-map-partial":
            warning["message"] = (
                "VL3D-E6006: unmapped layers are retained but hidden; select a layer map "
                "or PDK profile to classify them. Approximate Z positions are non-signoff."
            )
    detection = technology.get("streamProfileDetection", {}) if isinstance(technology, dict) else {}
    if detection.get("status") == "ambiguous" and not any(
            isinstance(item, dict) and item.get("code") == "stream-profile-ambiguous"
            for item in warnings):
        warnings.append({
            "code": "stream-profile-ambiguous",
            "severity": "warning",
            "message": "VL3D-E5009: multiple %s PDK profiles matched; unmapped geometry is retained but hidden until an explicit profile is selected"
                       % detection.get("source", "candidate"),
        })
    if detection.get("status") == "unconfirmed":
        warnings.append({
            "code": "stream-profile-unconfirmed", "severity": "warning",
            "message": "VL3D-E5007: numeric layer IDs resemble %s but do not identify a process; select the matching PDK profile or supply a layer map" % ", ".join(detection.get("candidates", [])),
        })
    status = payload.setdefault("exportStatus", {})
    if not isinstance(status, dict):
        status = {}
        payload["exportStatus"] = status
    status.update({
        "resourceMode": resource_mode,
        "maxDepthRequested": max_depth,
        "maxShapesRequested": max_shapes,
    })
    reasons = []
    if status.get("truncated"):
        reasons.append("shape-limit")
        if not any(isinstance(item, dict) and item.get("code") == "stream-shape-limit" for item in warnings):
            warnings.append({
                "code": "stream-shape-limit",
                "severity": "warning",
                "message": "VL3D-E4004: stream geometry was truncated at %d emitted shapes in %s resource mode; the displayed result is partial."
                           % (max_shapes, resource_mode),
            })
    if status.get("depthLimited"):
        reasons.append("hierarchy-depth-limit")
        if not any(isinstance(item, dict) and item.get("code") == "stream-depth-limit" for item in warnings):
            warnings.append({
                "code": "stream-depth-limit",
                "severity": "warning",
                "message": "VL3D-E4004: hierarchy expansion stopped at depth %d in %s resource mode; the displayed result is partial."
                           % (max_depth, resource_mode),
            })
    status["truncationReasons"] = reasons
    status["complete"] = not reasons
    status["warningCount"] = len(warnings)
    return payload


def apply_inferred_profile_to_payload(payload, mapping, descriptor, detection):
    layers = payload.get("layers") if isinstance(payload.get("layers"), list) else []
    requested_names = {}
    renamed = {}
    mapped_count = 0
    for layer in layers:
        if not isinstance(layer, dict):
            continue
        try:
            layer_number = int(layer.get("layerNumber"))
            datatype = int(layer.get("datatype", 0))
        except (TypeError, ValueError):
            continue
        mapped = mapping_for(mapping, layer_number, datatype)
        if not ((isinstance(mapped, str) and mapped.strip()) or isinstance(mapped, dict)):
            continue
        metadata = mapped if isinstance(mapped, dict) else {}
        old_name = str(layer.get("name") or "L%d_D%d" % (layer_number, datatype))
        requested = mapped if isinstance(mapped, str) else metadata.get("name", old_name)
        requested = str(requested or old_name).strip() or old_name
        requested_names[requested] = requested_names.get(requested, 0) + 1
        new_name = requested if requested_names[requested] == 1 else "%s__L%d_D%d" % (
            requested, layer_number, datatype,
        )
        renamed[old_name] = new_name
        layer.update({
            "name": new_name,
            "purpose": metadata.get("purpose", layer.get("purpose", "drawing")),
            "color": metadata.get("color", layer.get("color", PALETTE[(layer_number * 17 + datatype) % len(PALETTE)])),
            "kind": metadata.get("kind", layer.get("kind", "stream")),
            "semantic": metadata.get("semantic", metadata.get("kind", layer.get("semantic", "unknown"))),
            "routing": bool(metadata.get("routing", layer.get("routing", False))),
            "defaultVisible": bool(metadata.get("defaultVisible", False)),
            "stackIndex": float(metadata.get("stackIndex", layer.get("stackIndex", layer.get("index", 0)))),
            "stackIndexSource": "layer-map",
            "thickness": float(metadata.get("thickness", metadata.get("thicknessUm", layer.get("thickness", 0.2)))),
            "thicknessSource": metadata.get("thicknessSource", "layer-map"),
            "metadataSource": "layer-map",
        })
        for field in (
            "metal", "lowerMetal", "upperMetal", "lowerLayer", "upperLayer", "lowerLayers", "upperLayers", "connectivitySource",
            "zBottomUm", "zTopUm", "approximate",
        ):
            if field in metadata:
                layer[field] = metadata[field]
        mapped_count += 1
    by_name = dict((layer["name"], layer) for layer in layers if isinstance(layer, dict))
    for shape in payload.get("shapes", []):
        if isinstance(shape, dict) and shape.get("layer") in renamed:
            shape["layer"] = renamed[shape["layer"]]
            shape["purpose"] = by_name[shape["layer"]].get("purpose", "drawing")
    technology = stream_technology_metadata(
        {"provided": False, "sourceFile": "", "entryCount": 0, "sha256": ""}, descriptor,
    )
    technology.update({
        "profileMatch": detection.get("source", "builtin") + "-stream-auto",
        "streamProfileDetection": detection,
        "usedLayerCount": len(layers),
        "mappedLayerCount": mapped_count,
    })
    payload["technology"] = technology
    payload["warnings"] = [
        warning for warning in payload.get("warnings", [])
        if not isinstance(warning, dict) or warning.get("code") not in (
            "stream-generic-geometry", "stream-layer-map-partial",
        )
    ]
    payload["warnings"].append({
        "code": "pdk-profile-inferred",
        "severity": "warning",
        "message": "VL3D-E5007: inferred %s from a matching process name and compatible %s layer map; use Advanced settings to override it"
                   % (detection.get("profile"), detection.get("source", "built-in")),
    })
    return payload


def import_with_klayout(path, original_path, arguments, technology, layer_map, temporary_directory):
    try:
        klayout = resolve_klayout(arguments.klayout)
    except Exception as error:
        raise StreamImportError("E6007", str(error), {"parser": "klayout"})
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from klayout_macro import MACRO
    macro = os.path.join(temporary_directory, "stream_import_klayout.rb")
    with open(macro, "w") as handle:
        handle.write(MACRO)
    output_path = os.path.join(temporary_directory, "klayout-result.json")
    klayout_layer_map = ""
    if layer_map:
        klayout_layer_map = os.path.join(temporary_directory, "klayout-layer-map.json")
        with open(klayout_layer_map, "w") as handle:
            json.dump(layer_map, handle, separators=(",", ":"), sort_keys=True)
    command = [klayout, "-b", "-r", macro]
    command += rd("vl3d_input", path)
    command += rd("vl3d_output", output_path)
    command += rd("vl3d_library", arguments.library or "STREAM")
    command += rd("vl3d_top", arguments.top or "")
    command += rd("vl3d_layer_map", klayout_layer_map)
    command += rd("vl3d_technology", json.dumps(technology, separators=(",", ":"), sort_keys=True))
    command += rd("vl3d_max_depth", arguments.max_depth)
    command += rd("vl3d_max_shapes", arguments.max_shapes)
    command += rd("vl3d_manifest", "")
    command += rd("vl3d_manifest_mode", "replace")
    command += rd("vl3d_manifest_prefix", "data")
    command += rd("vl3d_force", "true")
    command += rd("vl3d_backup", "false")
    completed = subprocess.run(
        command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        universal_newlines=True, timeout=arguments.timeout,
    )
    succeeded = completed.returncode == 0 and "VL3D_IMPORT_OK" in completed.stdout and os.path.isfile(output_path)
    if not succeeded:
        combined = "%s\n%s" % (completed.stdout[-4000:], completed.stderr[-4000:])
        top_match = "Multiple top cells found; pass --top. Available:"
        if top_match in combined:
            candidates = combined.split(top_match, 1)[1].splitlines()[0].strip().split(", ")
            raise StreamImportError(
                "E6002", "Multiple top cells found; select one explicitly",
                {"topCells": candidates, "selectionRequired": True, "parser": "klayout"},
            )
        hint = missing_plugin_hint(klayout)
        message = "KLayout stream import failed (exit %d): %s" % (
            completed.returncode, combined.strip()[-3000:]
        )
        if hint:
            message = "%s %s" % (message, hint)
        raise StreamImportError("E6004", message, {"parser": "klayout"})
    with open(output_path, "r") as handle:
        payload = json.load(handle)
    if not arguments.layer_map and not arguments.pdk_profile:
        observed = [
            (layer.get("layerNumber"), layer.get("datatype", 0))
            for layer in payload.get("layers", []) if isinstance(layer, dict)
        ]
        inferred, detection = infer_stream_profile_pairs(
            observed, original_path, arguments.pdk_profile_dir,
        )
        if inferred:
            inferred_mapping, inferred_descriptor = inferred
            payload = apply_inferred_profile_to_payload(
                payload, inferred_mapping, inferred_descriptor, detection,
            )
        else:
            payload.setdefault("technology", {})["streamProfileDetection"] = detection
    payload["sourceFile"] = os.path.basename(original_path)
    payload.setdefault("exportStatus", {})["parser"] = "klayout"
    return payload


def validate_schema_v2(payload):
    if payload.get("schemaVersion") != 2:
        raise StreamImportError("E4001", "VL3D JSON must use schemaVersion 2")
    try:
        validate_viewer_units(payload)
    except ValueError as error:
        raise StreamImportError("E4003", str(error))
    for field in ("library", "cell", "view"):
        if not isinstance(payload.get(field), str) or not payload[field]:
            raise StreamImportError("E4002", "VL3D JSON is missing %s" % field)
    for field in ("layers", "shapes", "instances", "pins", "connections"):
        if not isinstance(payload.get(field), list):
            raise StreamImportError("E4002", "VL3D JSON %s must be an array" % field)


def read_json_input(path, compressed, maximum_bytes):
    opener = gzip.open if compressed else open
    with opener(path, "rb") as handle:
        contents = handle.read(maximum_bytes + 1)
    if len(contents) > maximum_bytes:
        raise StreamImportError("E4004", "Expanded VL3D JSON exceeds the configured limit")
    try:
        payload = json.loads(contents.decode("utf-8"))
    except Exception as error:
        raise StreamImportError("E4002", "VL3D JSON is malformed: %s" % error)
    if not isinstance(payload, dict):
        raise StreamImportError("E4002", "VL3D JSON root must be an object")
    validate_schema_v2(payload)
    return payload


def decompress_input(path, kind, maximum_bytes, temporary_directory):
    suffix = ".json" if kind == "json" else (".gds" if kind == "gds" else ".oas")
    destination = os.path.join(temporary_directory, "expanded" + suffix)
    total = 0
    with gzip.open(path, "rb") as source, open(destination, "wb") as output:
        while True:
            chunk = source.read(4 * 1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > maximum_bytes:
                raise StreamImportError("E4004", "Expanded input exceeds the configured limit")
            output.write(chunk)
    return destination


def parser():
    result = argparse.ArgumentParser(
        description="Convert VL3D JSON, GDSII, or OASIS to compact VL3D schema v2 JSON + gzip."
    )
    result.add_argument("input", help="Input .json/.gds/.gdsii/.oas/.oasis file (optionally .gz)")
    result.add_argument("--output", required=True, help="Destination .json file")
    result.add_argument("--library", help="Logical library override (streams default to STREAM)")
    result.add_argument("--top", help="Top cell; required when a stream has multiple top cells")
    result.add_argument("--layer-map", help="Explicit JSON mapping from layer/datatype to display metadata")
    result.add_argument("--pdk-profile", help="Explicit PDK profile; numeric streamLayers are used when present")
    result.add_argument(
        "--pdk-profile-dir", action="append", default=[],
        help="Bounded non-symlink directory of candidate PDK profiles; may be repeated",
    )
    result.add_argument("--resource-mode", choices=("low", "balanced", "large"), default="balanced")
    result.add_argument("--max-depth", type=int, help="Maximum expanded hierarchy depth (resource preset by default)")
    result.add_argument("--max-shapes", type=int, help="Positive shape cap (resource preset by default; unlimited is not allowed)")
    result.add_argument("--max-input-bytes", type=int, default=DEFAULT_MAX_INPUT_BYTES)
    result.add_argument("--max-expanded-bytes", type=int, default=DEFAULT_MAX_EXPANDED_BYTES)
    result.add_argument("--manifest", help="Optional VL3D manifest.json to create or update")
    result.add_argument("--manifest-mode", choices=("merge", "replace"), default="merge")
    result.add_argument("--manifest-prefix", default="data", help="Path prefix stored in manifest entry")
    result.add_argument("--parser", choices=("auto", "gdstk", "klayout"), default="auto")
    result.add_argument("--klayout", help="Explicit KLayout executable; also selects compatibility mode in auto")
    result.add_argument("--timeout", type=int, default=300, help="KLayout fallback timeout in seconds")
    result.add_argument("--force", action="store_true", help="Replace an existing output (with backup)")
    result.add_argument("--no-backup", action="store_true", help="Disable timestamped backups on replacement")
    return result


def main():
    arguments = parser().parse_args()
    preset = RESOURCE_PRESETS[arguments.resource_mode]
    if arguments.max_depth is None:
        arguments.max_depth = preset["maxDepth"]
    if arguments.max_shapes is None:
        arguments.max_shapes = preset["maxShapes"]
    input_path = os.path.abspath(arguments.input)
    output_path = os.path.abspath(arguments.output)
    if not os.path.isfile(input_path):
        raise StreamImportError("E6001", "Input does not exist: %s" % input_path)
    metadata = os.stat(input_path)
    if metadata.st_size <= 0 or metadata.st_size > arguments.max_input_bytes:
        raise StreamImportError("E6001", "Input size is outside the configured limit: %d" % metadata.st_size)
    kind = validate_input_path(input_path)
    _detected_kind, compressed = input_kind(input_path)
    if not output_path.lower().endswith(".json"):
        raise RuntimeError("--output must end in .json")
    if arguments.max_depth < 0 or arguments.max_shapes <= 0:
        raise StreamImportError(
            "E4004", "--max-depth must be zero or greater and --max-shapes must be positive",
        )
    if arguments.max_input_bytes <= 0 or arguments.max_expanded_bytes <= 0 or arguments.timeout <= 0:
        raise RuntimeError("Input limits and --timeout must be positive")
    manifest_path = os.path.abspath(arguments.manifest) if arguments.manifest else None
    output_paths = {os.path.realpath(output_path), os.path.realpath(output_path + ".gz")}
    source_path = os.path.realpath(input_path)
    if source_path in output_paths:
        raise RuntimeError("--output must not replace the selected source")
    if manifest_path:
        manifest_paths = {os.path.realpath(manifest_path), os.path.realpath(manifest_path + ".gz")}
        if output_paths.intersection(manifest_paths):
            raise RuntimeError("--manifest and --output must not refer to the same JSON/gzip files")
    existing_outputs = [path for path in (output_path, output_path + ".gz") if os.path.exists(path)]
    if existing_outputs and not arguments.force:
        raise RuntimeError("Output already exists; pass --force to replace it: %s" % ", ".join(existing_outputs))

    layer_map, layer_descriptor, profile_descriptor = load_mapping_sources(
        arguments.layer_map, arguments.pdk_profile,
    )
    technology = stream_technology_metadata(layer_descriptor, profile_descriptor)
    initial_source = source_snapshot(input_path)
    public_source = {
        "type": "vl3d-json" if kind == "json" else "stream",
        "file": os.path.basename(input_path),
        "sha256": initial_source["sha256"],
        "size": initial_source["size"],
    }

    temporary_directory = tempfile.mkdtemp(prefix="vl3d-stream-import-")
    try:
        parser_path = input_path
        if compressed and kind != "json":
            parser_path = decompress_input(
                input_path, kind, arguments.max_expanded_bytes, temporary_directory,
            )
        if kind == "json":
            payload = read_json_input(input_path, compressed, arguments.max_expanded_bytes)
            if arguments.top and arguments.top != payload["cell"]:
                raise StreamImportError(
                    "E6002", "Requested top cell does not match the VL3D JSON cell",
                    {"requestedTop": arguments.top, "topCells": [payload["cell"]]},
                )
            if arguments.library:
                payload["library"] = arguments.library
            payload["sourceFormat"] = payload.get("sourceFormat") or "VL3D-JSON"
            payload["sourceFile"] = os.path.basename(input_path)
            payload["source"] = public_source
            payload.setdefault("exportStatus", {})["parser"] = "vl3d-json"
        else:
            selected_parser = arguments.parser
            if selected_parser == "auto" and arguments.klayout:
                selected_parser = "klayout"
            failures = []
            if selected_parser in ("auto", "gdstk"):
                try:
                    payload = import_with_gdstk(
                        parser_path, input_path, kind, arguments, layer_map, technology, public_source,
                    )
                except StreamImportError as error:
                    if error.code == "E6002" or selected_parser == "gdstk":
                        raise
                    failures.append({"parser": "gdstk", "message": str(error)})
                    payload = None
                except Exception as error:
                    if selected_parser == "gdstk":
                        raise StreamImportError("E6007", str(error), {"parser": "gdstk"})
                    failures.append({"parser": "gdstk", "message": str(error)})
                    payload = None
            else:
                payload = None
            if payload is None and selected_parser in ("auto", "klayout"):
                try:
                    payload = import_with_klayout(
                        parser_path, input_path, arguments, technology, layer_map, temporary_directory,
                    )
                except StreamImportError as error:
                    if error.code == "E6002":
                        raise
                    failures.append({"parser": "klayout", "message": str(error)})
                    if all(failure["message"].lower().find("unavailable") >= 0 or
                           failure["message"].lower().find("not found") >= 0
                           for failure in failures):
                        raise StreamImportError("E6007", "No usable stream parser is available", {"parsers": failures})
                    raise StreamImportError("E6004", "All available stream parsers failed", {"parsers": failures})
            payload = finalize_stream_payload(
                payload, arguments.resource_mode, arguments.max_depth, arguments.max_shapes,
            )
            payload["source"] = public_source
            payload["sourceFile"] = os.path.basename(input_path)

        assert_source_unchanged(input_path, initial_source)
        write_layout_outputs(output_path, payload, arguments.force, not arguments.no_backup)
        if manifest_path:
            update_manifest(
                manifest_path, payload, output_path, arguments.manifest_mode,
                arguments.manifest_prefix, not arguments.no_backup,
            )
        result = {
            "output": output_path,
            "library": payload.get("library"),
            "cell": payload.get("cell"),
            "view": payload.get("view"),
            "shapeCount": payload.get("shapeCount", 0),
            "instanceCount": payload.get("instanceCount", 0),
            "parser": payload.get("exportStatus", {}).get("parser", "unknown"),
            "sourceSha256": initial_source["sha256"],
        }
        print("VL3D_IMPORT_OK %s" % json.dumps(result, separators=(",", ":"), sort_keys=True))
        print(
            "Imported %s/%s: %d shapes, %d instances, %d layers"
            % (payload.get("library"), payload.get("cell"), payload.get("shapeCount", 0),
               payload.get("instanceCount", 0), len(payload.get("layers", [])))
        )
    finally:
        shutil.rmtree(temporary_directory, ignore_errors=True)


if __name__ == "__main__":
    try:
        main()
    except StreamImportError as error:
        marker = {
            "code": "VL3D-%s" % error.code,
            "message": str(error),
            "details": error.details,
        }
        print("VL3D_IMPORT_ERROR %s" % json.dumps(marker, separators=(",", ":"), sort_keys=True), file=sys.stderr)
        print("ERROR: VL3D-%s %s" % (error.code, error), file=sys.stderr)
        sys.exit(2)
    except subprocess.TimeoutExpired as error:
        marker = {"code": "VL3D-E6005", "message": str(error), "details": {"timeout": error.timeout}}
        print("VL3D_IMPORT_ERROR %s" % json.dumps(marker, separators=(",", ":"), sort_keys=True), file=sys.stderr)
        print("ERROR: VL3D-E6005 %s" % error, file=sys.stderr)
        sys.exit(2)
    except Exception as error:
        marker = {"code": "VL3D-E6004", "message": str(error), "details": {}}
        print("VL3D_IMPORT_ERROR %s" % json.dumps(marker, separators=(",", ":"), sort_keys=True), file=sys.stderr)
        print("ERROR: VL3D-E6004 %s" % error, file=sys.stderr)
        sys.exit(1)
