#!/usr/bin/env python3
"""Build a four-occurrence VL3D stress layout without touching the OA source."""

import argparse
import copy
import datetime
import fcntl
import gzip
import hashlib
import json
import math
import os
import re
import shutil
import sys
import tempfile


TARGET = {"library": "VL3D_STRESS", "cell": "DEMO_x4", "view": "layout"}
SAFE_IDENTITY = re.compile(r"^[A-Za-z0-9_.$:+-]+$")
INTERFACES = ("OUTP", "OUTN", "VDD", "VSS")
PLACEMENTS = (("U00", 0, 0), ("U01", 0, 1), ("U10", 1, 0), ("U11", 1, 1))


def utc_now():
    return datetime.datetime.utcnow().isoformat() + "Z"


def normalize_bbox(value):
    try:
        coords = [
            float(value["min"][0]), float(value["min"][1]),
            float(value["max"][0]), float(value["max"][1]),
        ]
    except (KeyError, TypeError, ValueError, IndexError):
        return None
    if not all(math.isfinite(coord) for coord in coords):
        return None
    return {
        "min": [min(coords[0], coords[2]), min(coords[1], coords[3])],
        "max": [max(coords[0], coords[2]), max(coords[1], coords[3])],
    }


def move_bbox(value, dx, dy):
    box = normalize_bbox(value)
    if box is None:
        return value
    return {
        "min": [box["min"][0] + dx, box["min"][1] + dy],
        "max": [box["max"][0] + dx, box["max"][1] + dy],
    }


def union_bbox(result, value):
    box = normalize_bbox(value)
    if box is None:
        return result
    if result is None:
        return copy.deepcopy(box)
    return {
        "min": [min(result["min"][0], box["min"][0]), min(result["min"][1], box["min"][1])],
        "max": [max(result["max"][0], box["max"][0]), max(result["max"][1], box["max"][1])],
    }


def remap_path(path, source_root, target_root):
    path = str(path or "")
    if path == source_root:
        return target_root
    if path.startswith(source_root + "/"):
        return target_root + path[len(source_root):]
    raise RuntimeError("Path %r is outside source root %r" % (path, source_root))


def translated(record, dx, dy, source_root, target_root, path_fields):
    result = copy.deepcopy(record)
    for field in path_fields:
        if result.get(field):
            result[field] = remap_path(result[field], source_root, target_root)
    for field in ("bbox", "worldBBox"):
        if field in result:
            result[field] = move_bbox(result[field], dx, dy)
    if "points" in result:
        result["points"] = [
            [float(point[0]) + dx, float(point[1]) + dy]
            for point in result["points"] if len(point) >= 2
        ]
    transform = result.get("transform")
    if isinstance(transform, dict) and len(transform.get("translation", [])) >= 2:
        old = transform["translation"]
        transform["translation"] = [float(old[0]) + dx, float(old[1]) + dy]
    return result


def metal_level(layer):
    name = str(layer or "").upper()
    for prefix in ("METAL", "M"):
        suffix = name[len(prefix):] if name.startswith(prefix) else ""
        if suffix.isdigit():
            return int(suffix)
    return -1


def route_width(layer):
    level = metal_level(layer)
    return 6.0 if level >= 6 else 4.0 if level >= 4 else 3.0


def make_pin(owner, path, name, layer, center, source):
    half = max(4.0, route_width(layer)) / 2.0
    box = {
        "min": [center[0] - half, center[1] - half],
        "max": [center[0] + half, center[1] + half],
    }
    return {
        "ownerCell": owner,
        "hierPath": path,
        "terminal": name,
        "name": name,
        "direction": "inputOutput",
        "net": name,
        "layer": layer,
        "purpose": "pin",
        "worldBBox": box,
        "points": [
            [box["min"][0], box["min"][1]], [box["max"][0], box["min"][1]],
            [box["max"][0], box["max"][1]], [box["min"][0], box["max"][1]],
        ],
        "source": source,
    }


def make_route(net, layer, start, end, label):
    width = route_width(layer)
    half = width / 2.0
    points = [[float(start[0]), float(start[1])], [float(end[0]), float(end[1])]]
    return {
        "ownerCell": TARGET["cell"],
        "hierPath": TARGET["cell"],
        "type": "path",
        "layer": layer,
        "purpose": "drawing",
        "width": width,
        "bbox": {
            "min": [min(start[0], end[0]) - half, min(start[1], end[1]) - half],
            "max": [max(start[0], end[0]) + half, max(start[1], end[1]) + half],
        },
        "points": points,
        "net": net,
        "label": label,
        "source": "synthetic-stress-manhattan",
    }


def find_anchor(source, interface):
    root = source["cell"]
    source_box = normalize_bbox(source["bbox"])
    side = "top" if interface == "VDD" else "bottom"
    candidates = []

    for shape in source["shapes"]:
        if shape.get("hierPath") == root and str(shape.get("net", "")).upper() == interface:
            box = normalize_bbox(shape.get("bbox"))
            if box:
                candidates.append((box, str(shape.get("layer") or "METAL1").upper(), True))

    pins_by_path = {}
    for pin in source["pins"]:
        pins_by_path.setdefault(pin.get("hierPath"), []).append(pin)
    for connection in source["connections"]:
        if connection.get("parentPath") != root or str(connection.get("parentNet", "")).upper() != interface:
            continue
        formal = {
            str(connection.get("terminal", "")).upper(),
            str(connection.get("childFormalNet", "")).upper(),
        }
        for pin in pins_by_path.get(connection.get("occurrencePath"), []):
            pin_names = {
                str(pin.get("terminal", "")).upper(), str(pin.get("name", "")).upper(),
                str(pin.get("net", "")).upper(),
            }
            box = normalize_bbox(pin.get("worldBBox") or pin.get("bbox"))
            if box and not formal.isdisjoint(pin_names):
                candidates.append((box, str(pin.get("layer") or "METAL1").upper(), False))

    boundary = source_box["max"][1] if side == "top" else source_box["min"][1]
    if not candidates:
        center_x = (source_box["min"][0] + source_box["max"][0]) / 2.0
        return {"center": [center_x, boundary], "layer": "METAL6", "side": side, "inferred": True}

    def score(candidate):
        box, layer, direct = candidate
        edge = box["max"][1] if side == "top" else box["min"][1]
        return (0 if direct else 100000) + abs(edge - boundary) - metal_level(layer) * 0.01

    box, layer, direct = min(candidates, key=score)
    center = [(box["min"][0] + box["max"][0]) / 2.0,
              box["max"][1] if side == "top" else box["min"][1]]
    return {"center": center, "layer": layer, "side": side, "inferred": not direct}


def make_placements(source_box, gap_x, gap_y):
    step_x = source_box["max"][0] - source_box["min"][0] + gap_x
    step_y = source_box["max"][1] - source_box["min"][1] + gap_y
    return [{
        "name": name,
        "row": row,
        "column": column,
        "path": TARGET["cell"] + "/" + name,
        "dx": column * step_x,
        "dy": row * step_y,
        "bbox": move_bbox(source_box, column * step_x, row * step_y),
    } for name, row, column in PLACEMENTS]


def clone_source(source, placements):
    result = {"shapes": [], "instances": [], "pins": [], "connections": []}
    root = source["cell"]
    for placement in placements:
        result["instances"].append({
            "hierPath": placement["path"],
            "parentPath": TARGET["cell"],
            "name": placement["name"],
            "master": {key: source[key] for key in ("library", "cell", "view")},
            "bbox": copy.deepcopy(placement["bbox"]),
            "transform": {
                "angle": 0.0, "magnification": 1.0, "mirror": False,
                "translation": [placement["dx"], placement["dy"]],
            },
            "source": "synthetic-stress-occurrence",
        })

    specs = (
        ("shapes", ("hierPath",)),
        ("instances", ("hierPath", "parentPath")),
        ("pins", ("hierPath",)),
        ("connections", ("occurrencePath", "parentPath")),
    )
    for placement in placements:
        for collection, path_fields in specs:
            result[collection].extend(
                translated(row, placement["dx"], placement["dy"], root,
                           placement["path"], path_fields)
                for row in source[collection]
            )
    return result


def add_interfaces(source, placements, records):
    min_x = min(item["bbox"]["min"][0] for item in placements)
    max_x = max(item["bbox"]["max"][0] for item in placements)
    min_y = min(item["bbox"]["min"][1] for item in placements)
    max_y = max(item["bbox"]["max"][1] for item in placements)
    anchors = {name: find_anchor(source, name) for name in INTERFACES}
    offsets = {"OUTN": 25.0, "OUTP": 45.0, "VSS": 65.0, "VDD": 35.0}
    occurrence_centers = {}
    existing_interfaces = {}
    for pin in records["pins"]:
        path = pin.get("hierPath")
        names = {
            str(pin.get(field, "")).upper()
            for field in ("terminal", "name", "net")
        }
        existing_interfaces.setdefault(path, set()).update(names.intersection(INTERFACES))
    synthetic_occurrence_pins = 0

    for placement in placements:
        occurrence_centers[placement["path"]] = {}
        for name, anchor in anchors.items():
            center = [anchor["center"][0] + placement["dx"], anchor["center"][1] + placement["dy"]]
            occurrence_centers[placement["path"]][name] = center
            if name not in existing_interfaces.get(placement["path"], set()):
                records["pins"].append(make_pin(
                    source["cell"], placement["path"], name, anchor["layer"], center,
                    "synthetic-stress-occurrence-pin",
                ))
                synthetic_occurrence_pins += 1
            records["connections"].append({
                "occurrencePath": placement["path"],
                "parentPath": TARGET["cell"],
                "parentNet": name,
                "childFormalNet": name,
                "terminal": name,
                "source": "synthetic-stress-parent-connection",
            })

    routes = []
    for name, anchor in anchors.items():
        top = anchor["side"] == "top"
        offset = offsets[name]
        backbone_x = max_x + offset if top else min_x - offset
        trunk_ys = []
        for row in range(2):
            row_items = [item for item in placements if item["row"] == row]
            edge = (max(item["bbox"]["max"][1] for item in row_items) if top
                    else min(item["bbox"]["min"][1] for item in row_items))
            trunk_y = edge + (offset if top else -offset)
            trunk_ys.append(trunk_y)
            routes.append(make_route(
                name, anchor["layer"], [min(min_x - 10.0, backbone_x), trunk_y],
                [max(max_x + 10.0, backbone_x), trunk_y], "%s_ROW%d_TRUNK" % (name, row),
            ))
            for placement in row_items:
                center = occurrence_centers[placement["path"]][name]
                routes.append(make_route(
                    name, anchor["layer"], center, [center[0], trunk_y],
                    "%s_%s_BRANCH" % (name, placement["name"]),
                ))
        routes.append(make_route(
            name, anchor["layer"], [backbone_x, min(trunk_ys)], [backbone_x, max(trunk_ys)],
            "%s_BACKBONE" % name,
        ))
        root_center = [backbone_x, max(trunk_ys) if top else min(trunk_ys)]
        records["pins"].append(make_pin(
            TARGET["cell"], TARGET["cell"], name, anchor["layer"], root_center,
            "synthetic-stress-top-pin",
        ))

    records["shapes"].extend(routes)
    return {
        "anchors": anchors,
        "routeShapeCount": len(routes),
        "occurrencePinCount": synthetic_occurrence_pins,
        "occurrenceInterfaceCount": len(placements) * len(INTERFACES),
        "topPinCount": len(INTERFACES),
        "parentConnectionCount": len(placements) * len(INTERFACES),
        "cloneBounds": {"min": [min_x, min_y], "max": [max_x, max_y]},
    }


def update_layers(source_layers, shapes):
    layers = copy.deepcopy(source_layers)
    counts = {}
    for shape in shapes:
        name = str(shape.get("layer") or "UNKNOWN").upper()
        shape["layer"] = name
        counts[name] = counts.get(name, 0) + 1
    known = {str(layer.get("name") or "").upper() for layer in layers}
    for name in sorted(set(counts) - known):
        index = len(layers)
        layers.append({
            "name": name, "index": index, "color": "#8ecae6", "kind": "other",
            "routing": True, "stackIndex": index, "thickness": 0.2, "height": 0.35,
            "lowerLayer": None, "upperLayer": None, "lowerLayers": [], "z": index,
        })
    source_connectors = {
        str(layer.get("name") or "").upper(): int(layer.get("connectorCount") or 0)
        for layer in source_layers
    }
    for index, layer in enumerate(layers):
        name = str(layer.get("name") or "").upper()
        layer.update({
            "name": name, "index": index, "z": index,
            "shapeCount": counts.get(name, 0),
            "connectorCount": source_connectors.get(name, 0) * len(PLACEMENTS),
        })
    return layers


def total_bbox(records):
    result = None
    for row in records["shapes"] + records["instances"]:
        result = union_bbox(result, row.get("bbox"))
    for pin in records["pins"]:
        result = union_bbox(result, pin.get("worldBBox") or pin.get("bbox"))
    return result or {"min": [0.0, 0.0], "max": [1.0, 1.0]}


def unique_source_views(source):
    rows = [copy.deepcopy(TARGET)] + copy.deepcopy(source.get("sourceViews") or [])
    rows.append({key: source[key] for key in ("library", "cell", "view")})
    seen = set()
    return [row for row in rows
            if not ((row["library"], row["cell"], row["view"]) in seen
                    or seen.add((row["library"], row["cell"], row["view"])))]


def build_layout(source, source_path, source_hash, gap_x=None, gap_y=None):
    required = ("library", "cell", "view", "bbox", "shapes", "instances",
                "pins", "connections", "layers")
    if source.get("schemaVersion") != 2 or any(key not in source for key in required):
        raise RuntimeError("Source must be a complete VL3D schemaVersion 2 layout")
    source_box = normalize_bbox(source["bbox"])
    if source_box is None:
        raise RuntimeError("Source bbox is invalid")
    width = source_box["max"][0] - source_box["min"][0]
    height = source_box["max"][1] - source_box["min"][1]
    gap_x = float(gap_x if gap_x is not None else max(120.0, width * 0.28))
    gap_y = float(gap_y if gap_y is not None else max(170.0, height * 0.36))
    if gap_x <= 80.0 or gap_y <= 120.0:
        raise RuntimeError("Gaps are too small for clear external routing")

    placements = make_placements(source_box, gap_x, gap_y)
    records = clone_source(source, placements)
    interface_stats = add_interfaces(source, placements, records)
    for collection in records.values():
        for row_id, row in enumerate(collection):
            row["id"] = row_id
    layers = update_layers(source["layers"], records["shapes"])
    shape_depth = max((str(row.get("hierPath") or "").count("/") for row in records["shapes"]), default=0)
    instance_depth = max((str(row.get("hierPath") or "").count("/") for row in records["instances"]), default=0)
    non_routing = sum(layer["shapeCount"] for layer in layers if not layer.get("routing", False))

    layout = {
        "schemaVersion": 2,
        "sourceSchemaVersion": source.get(
            "sourceSchemaVersion", source.get("schemaVersion", 2)
        ),
        "generatedAt": utc_now(),
        "sourceFormat": "VL3D synthetic stress layout",
        "sourceJson": os.path.basename(source_path),
        **TARGET,
        "rootPath": TARGET["cell"],
        "dbuPerMicron": source.get("dbuPerMicron", 1000.0),
        "units": source.get("units", "um"),
        "technology": copy.deepcopy(source.get("technology") or {}),
        "bbox": total_bbox(records),
        "sourceShapeCount": len(records["shapes"]),
        "shapeCount": len(records["shapes"]),
        "instanceCount": len(records["instances"]),
        "pinCount": len(records["pins"]),
        "connectionCount": len(records["connections"]),
        "maxShapeDepth": shape_depth,
        "maxInstanceDepth": instance_depth,
        "ownerCellCount": len({row.get("ownerCell") for row in records["shapes"] if row.get("ownerCell")}),
        "layers": layers,
        **records,
        "sourceViews": unique_source_views(source),
        "stressSource": {
            "kind": "translated-2x2-clone",
            "input": {
                "library": source["library"], "cell": source["cell"], "view": source["view"],
                "file": os.path.basename(source_path), "sha256": source_hash,
                "generatedAt": source.get("generatedAt"), "shapeCount": len(source["shapes"]),
                "instanceCount": len(source["instances"]), "pinCount": len(source["pins"]),
                "connectionCount": len(source["connections"]),
            },
            "grid": {
                "rows": 2, "columns": 2, "gapX": gap_x, "gapY": gap_y,
                "placements": copy.deepcopy(placements),
            },
            "interfaces": interface_stats,
        },
        "exportStatus": {
            "synthetic": True, "truncated": False, "depthLimited": False,
            "maxDepthReached": max(shape_depth, instance_depth),
            "maxDepthRequested": source.get("exportStatus", {}).get("maxDepthRequested"),
            "clones": len(placements), "sourceShapesPerClone": len(source["shapes"]),
            "clonedShapes": len(source["shapes"]) * len(placements),
            "syntheticRouteShapes": interface_stats["routeShapeCount"],
            "shapesSeen": len(records["shapes"]), "shapesEmitted": len(records["shapes"]),
            "viewableShapesRetained": len(records["shapes"]),
            "routingShapesRetained": len(records["shapes"]) - non_routing,
            "nonRoutingShapesRetained": non_routing,
            "pinsEmitted": len(records["pins"]),
            "connectionsEmitted": len(records["connections"]),
            "sourceExportStatus": copy.deepcopy(source.get("exportStatus") or {}),
        },
    }
    validate(layout)
    return layout


def validate(layout):
    count_fields = {
        "shapes": "shapeCount", "instances": "instanceCount",
        "pins": "pinCount", "connections": "connectionCount",
    }
    for collection, count_field in count_fields.items():
        rows = layout[collection]
        if len(rows) != layout[count_field] or [row["id"] for row in rows] != list(range(len(rows))):
            raise RuntimeError("Invalid %s count or IDs" % collection)

    root = layout["cell"]
    instance_paths = [row["hierPath"] for row in layout["instances"]]
    path_set = set(instance_paths)
    if len(path_set) != len(instance_paths):
        raise RuntimeError("Instance hierarchy paths are not unique")
    expected = {root + "/" + name for name, unused_row, unused_column in PLACEMENTS}
    actual = {row["hierPath"] for row in layout["instances"] if row.get("parentPath") == root}
    if actual != expected:
        raise RuntimeError("Top-level occurrence paths are incomplete")

    valid_paths = path_set | {root}

    def covered(path):
        while path:
            if path in valid_paths:
                return True
            path, separator, unused = path.rpartition("/")
            if not separator:
                break
        return False

    for collection in ("shapes", "pins"):
        for row in layout[collection]:
            if not covered(row.get("hierPath")):
                raise RuntimeError("%s references unknown hierarchy path" % collection)
    for connection in layout["connections"]:
        if connection.get("occurrencePath") not in path_set or connection.get("parentPath") not in valid_paths:
            raise RuntimeError("Connection references an unknown hierarchy path")

    interface_set = set(INTERFACES)
    for occurrence in expected:
        pins = [row for row in layout["pins"]
                if row.get("hierPath") == occurrence]
        connections = [row for row in layout["connections"]
                       if row.get("occurrencePath") == occurrence
                       and row.get("source") == "synthetic-stress-parent-connection"]
        pin_names = {
            str(row.get(field, "")).upper()
            for row in pins for field in ("terminal", "name", "net")
        }
        if not interface_set.issubset(pin_names):
            raise RuntimeError("Occurrence pins are incomplete for %s" % occurrence)
        if len(connections) != 4 or {row.get("parentNet") for row in connections} != interface_set:
            raise RuntimeError("Parent connections are incomplete for %s" % occurrence)

    routes = [row for row in layout["shapes"] if row.get("source") == "synthetic-stress-manhattan"]
    if len(routes) != 28 or any(
            len(row.get("points", [])) != 2
            or not (row["points"][0][0] == row["points"][1][0]
                    or row["points"][0][1] == row["points"][1][1])
            for row in routes):
        raise RuntimeError("External routes are not complete Manhattan paths")

    shape_counts = {}
    for shape in layout["shapes"]:
        shape_counts[shape["layer"]] = shape_counts.get(shape["layer"], 0) + 1
    layer_counts = {layer["name"]: layer["shapeCount"] for layer in layout["layers"] if layer["shapeCount"]}
    if shape_counts != layer_counts:
        raise RuntimeError("Layer shape counts are inconsistent")


def read_source(path):
    with open(path, "rb") as handle:
        contents = handle.read()
    try:
        return json.loads(contents.decode("utf-8")), hashlib.sha256(contents).hexdigest()
    except (UnicodeDecodeError, ValueError) as error:
        raise RuntimeError("Could not parse source JSON: %s" % error)


def hash_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def stage_json(path, payload):
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=os.path.basename(path) + ".tmp-", dir=directory)
    try:
        with os.fdopen(descriptor, "w") as handle:
            json.dump(payload, handle, separators=(",", ":"), sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        return temporary
    except Exception:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def stage_gzip(source_path, destination_path):
    directory = os.path.dirname(destination_path) or "."
    descriptor, temporary = tempfile.mkstemp(prefix=os.path.basename(destination_path) + ".tmp-", dir=directory)
    os.close(descriptor)
    try:
        with open(source_path, "rb") as source, open(temporary, "wb") as raw_output:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw_output,
                               compresslevel=6, mtime=0) as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)
            raw_output.flush()
            os.fsync(raw_output.fileno())
        return temporary
    except Exception:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def backup_file(path, stamp, enabled, backup_root):
    if enabled and os.path.isfile(path):
        destination = os.path.join(os.path.abspath(backup_root), stamp)
        os.makedirs(destination, exist_ok=True)
        backup = os.path.join(destination, os.path.basename(path))
        if not os.path.exists(backup):
            shutil.copy2(path, backup)


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def publish_pair(path, payload, stamp, backup, backup_root):
    path = os.path.abspath(path)
    gzip_path = path + ".gz"
    temporary_json = stage_json(path, payload)
    temporary_gzip = stage_gzip(temporary_json, gzip_path)
    try:
        backup_file(path, stamp, backup, backup_root)
        backup_file(gzip_path, stamp, backup, backup_root)
        os.chmod(temporary_json, 0o600)
        os.chmod(temporary_gzip, 0o600)
        os.replace(temporary_json, path)
        temporary_json = None
        os.replace(temporary_gzip, gzip_path)
        temporary_gzip = None
        fsync_directory(os.path.dirname(path) or ".")
    finally:
        for temporary in (temporary_json, temporary_gzip):
            if temporary:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass


def manifest_entry(layout, output_path, data_root):
    relative = os.path.relpath(os.path.realpath(output_path), os.path.realpath(data_root))
    if relative == ".." or relative.startswith(".." + os.sep):
        raise RuntimeError("Output must be inside %s" % data_root)
    keys = ("library", "cell", "view", "sourceFormat", "shapeCount", "sourceShapeCount",
            "instanceCount", "pinCount", "connectionCount", "maxShapeDepth",
            "maxInstanceDepth", "ownerCellCount", "bbox", "exportStatus", "technology")
    entry = {key: layout[key] for key in keys}
    entry.update({
        "path": "data/" + relative.replace(os.sep, "/"),
        "layerCount": len(layout["layers"]),
        "stressSource": layout["stressSource"]["input"],
    })
    return entry


def merge_manifest(path, entry, stamp, backup, backup_root):
    path = os.path.abspath(path)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    lock_path = path + ".lock"
    with open(lock_path, "a+") as lock:
        os.chmod(lock_path, 0o600)
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        with open(path) as handle:
            manifest = json.load(handle)
        identity = tuple(entry[key] for key in ("library", "cell", "view"))
        cells = [cell for cell in manifest.get("cells", [])
                 if tuple(cell.get(key) for key in ("library", "cell", "view")) != identity]
        cells.append(entry)
        manifest.update({
            "schemaVersion": 2,
            "generatedAt": utc_now(),
            "cells": sorted(cells, key=lambda cell: tuple(str(cell.get(key) or "")
                                                           for key in ("library", "cell", "view"))),
        })
        publish_pair(path, manifest, stamp, backup, backup_root)


def stats(layout, output_path, dry_run):
    return {
        "dryRun": dry_run,
        "output": os.path.abspath(output_path),
        "identity": "%s/%s/%s" % (layout["library"], layout["cell"], layout["view"]),
        "bbox": layout["bbox"],
        "shapes": layout["shapeCount"],
        "instances": layout["instanceCount"],
        "topInstances": len(PLACEMENTS),
        "pins": layout["pinCount"],
        "connections": layout["connectionCount"],
        "layers": len(layout["layers"]),
        "maxShapeDepth": layout["maxShapeDepth"],
        "maxInstanceDepth": layout["maxInstanceDepth"],
        "externalRoutes": layout["stressSource"]["interfaces"]["routeShapeCount"],
        "occurrencePins": layout["stressSource"]["interfaces"]["occurrencePinCount"],
        "parentConnections": layout["stressSource"]["interfaces"]["parentConnectionCount"],
    }


def parse_args():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    cache_root = os.environ.get("XDG_CACHE_HOME") or os.path.join(
        os.path.expanduser("~"), ".cache")
    data = os.environ.get("VL3D_DATA_DIR") or os.path.join(cache_root, "vl3d", "data")
    state_root = os.environ.get("XDG_STATE_HOME") or os.path.join(
        os.path.expanduser("~"), ".local", "state")
    backup_root = os.environ.get("VL3D_BACKUP_DIR") or os.path.join(
        state_root, "vl3d", "generated-stress")
    public_input = os.path.join(root, "examples", "hierarchy-demo.json")
    parser = argparse.ArgumentParser(description="Build a synthetic VL3D 2x2 stress layout")
    parser.add_argument("--input", default=public_input)
    parser.add_argument("--output", default=os.path.join(data, "VL3D_STRESS@DEMO_x4@layout.json"))
    parser.add_argument("--manifest", default=os.path.join(data, "manifest.json"))
    parser.add_argument("--target-library", default=TARGET["library"])
    parser.add_argument("--target-cell", default=TARGET["cell"])
    parser.add_argument("--gap-x", type=float)
    parser.add_argument("--gap-y", type=float)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--backup", dest="backup", action="store_true",
                        help="Back up replaced synthetic outputs under --backup-dir")
    parser.add_argument("--no-backup", dest="backup", action="store_false",
                        help=argparse.SUPPRESS)
    parser.set_defaults(backup=False)
    parser.add_argument("--backup-dir", default=backup_root)
    return parser.parse_args(), root, data


def main():
    global TARGET
    os.umask(0o077)
    args, root, data_root = parse_args()
    if not SAFE_IDENTITY.match(args.target_library) or not SAFE_IDENTITY.match(args.target_cell):
        raise RuntimeError("Target library and cell must be safe OA-style names")
    TARGET = {"library": args.target_library, "cell": args.target_cell, "view": "layout"}
    input_path = os.path.abspath(args.input)
    output_path = os.path.abspath(args.output)
    manifest_path = os.path.abspath(args.manifest)
    if not os.path.isfile(input_path):
        raise RuntimeError("Source JSON does not exist: %s" % input_path)
    if not output_path.lower().endswith(".json"):
        raise RuntimeError("--output must end in .json")
    real_paths = [os.path.realpath(path) for path in (input_path, output_path, manifest_path)]
    if len(set(real_paths)) != len(real_paths):
        raise RuntimeError("Input, output, and manifest paths must differ")

    source, source_hash = read_source(input_path)
    source_identity = tuple(source.get(key) for key in ("library", "cell", "view"))
    target_identity = tuple(TARGET[key] for key in ("library", "cell", "view"))
    if source_identity == target_identity:
        raise RuntimeError("Synthetic target identity must differ from the source identity")
    expected_name = "%s@%s@layout.json" % (TARGET["library"], TARGET["cell"])
    if os.path.basename(output_path) != expected_name:
        raise RuntimeError("Output basename must match target identity: %s" % expected_name)
    layout = build_layout(source, input_path, source_hash, args.gap_x, args.gap_y)
    result = stats(layout, output_path, args.dry_run)
    if not args.dry_run:
        if hash_file(input_path) != source_hash:
            raise RuntimeError("Source JSON changed while building")
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = args.backup
        if backup:
            os.makedirs(os.path.join(os.path.abspath(args.backup_dir), stamp), exist_ok=True)
        publish_pair(output_path, layout, stamp, backup, args.backup_dir)
        entry = manifest_entry(layout, output_path, data_root)
        merge_manifest(manifest_path, entry, stamp, backup, args.backup_dir)
        result.update({
            "jsonBytes": os.path.getsize(output_path),
            "gzipBytes": os.path.getsize(output_path + ".gz"),
        })
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("ERROR: %s" % error, file=sys.stderr)
        sys.exit(1)
