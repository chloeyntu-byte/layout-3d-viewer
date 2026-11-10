#!/usr/bin/env python3
"""Generate the synthetic octagonal-inductor demo layout (pure Python, no EDA needed).

    python3 tools/make_example_inductor.py [output.json]

All geometry and layer data are fictional (see profiles/example-process.json).
The output is a schema-v2 layout JSON that `vl3d gui` / `vl3d web` can open.
"""
from __future__ import print_function

import json
import math
import os
import sys

LIB, TOP = "EXAMPLE_LIB", "OCT_IND"
WIDTH = 6.0          # spiral trace width (um)
PITCH = 4.0          # radial shrink per octagon side (um)
R_OUT = 52.0         # outer circumradius of the first vertex (um)
SIDES = 20           # 2.5 turns
LAYERS = [  # name, kind, semantic, z bottom, z top, colour
    ("M1", "metal", "metal", 0.4, 0.7, "#cc9b66"),
    ("M5", "metal", "metal", 4.0, 4.6, "#c2c46b"),
    ("V5", "via", "via", 4.6, 5.0, "#8ea5c8"),
    ("M6", "metal", "metal", 5.0, 6.2, "#ec5aa5"),
]


def r6(v):
    return round(v, 4)


def box_points(x0, y0, x1, y1):
    return [[r6(x0), r6(y0)], [r6(x1), r6(y0)], [r6(x1), r6(y1)], [r6(x0), r6(y1)]]


def bbox_of(points):
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return {"min": [min(xs), min(ys)], "max": [max(xs), max(ys)]}


def offset_polyline(points, half):
    """Closed outline (mitre joins) of an open polyline with the given half width."""
    def normal(a, b):
        dx, dy = b[0] - a[0], b[1] - a[1]
        n = math.hypot(dx, dy)
        return (-dy / n, dx / n)

    left, right = [], []
    for i, p in enumerate(points):
        if i == 0:
            nx, ny = normal(points[0], points[1])
            k = 1.0
        elif i == len(points) - 1:
            nx, ny = normal(points[-2], points[-1])
            k = 1.0
        else:
            n1, n2 = normal(points[i - 1], p), normal(p, points[i + 1])
            mx, my = n1[0] + n2[0], n1[1] + n2[1]
            m = math.hypot(mx, my)
            nx, ny = mx / m, my / m
            k = 1.0 / max(nx * n1[0] + ny * n1[1], 1e-6)
        left.append([p[0] + nx * half * k, p[1] + ny * half * k])
        right.append([p[0] - nx * half * k, p[1] - ny * half * k])
    return [[r6(x), r6(y)] for x, y in left + right[::-1]]


def spiral_centerline():
    pts = []
    for k in range(SIDES + 1):
        ang = math.radians(22.5 + 45.0 * k)
        r = R_OUT - PITCH * k / 1.0 * 0.5
        pts.append([r * math.cos(ang), r * math.sin(ang)])
    return pts


def build():
    shapes, pins, instances = [], [], []
    next_id = [100]

    def add_shape(layer, points, path, owner, net=""):
        shapes.append({"id": next_id[0], "layer": layer, "purpose": "drawing", "type": "polygon",
                       "ownerCell": owner, "hierPath": path, "net": net,
                       "bbox": bbox_of(points), "points": points})
        next_id[0] += 1

    center = spiral_centerline()
    add_shape("M6", offset_polyline(center, WIDTH / 2.0), TOP + "/SPIRAL", "SPIRAL", "")

    # Underpass on M5: from the inner end, straight out along +x beyond the outer turn.
    inner = center[-1]
    x_end = R_OUT + 14.0
    add_shape("M5", box_points(inner[0] - 4, inner[1] - 3, x_end, inner[1] + 3), TOP + "/UNDERPASS", "UNDERPASS")
    # 2x2 via array at the inner end and a landing at the outer end of the underpass.
    for dx in (-2.0, 1.0):
        for dy in (-2.0, 1.0):
            add_shape("V5", box_points(inner[0] + dx - 0.0, inner[1] + dy, inner[0] + dx + 1.0, inner[1] + dy + 1.0),
                      TOP + "/UNDERPASS", "UNDERPASS")

    # Octagonal guard ring on M1 (eight trapezoids).
    ro, ri = R_OUT + 24.0, R_OUT + 18.0
    for k in range(8):
        a0, a1 = math.radians(22.5 + 45 * k), math.radians(22.5 + 45 * (k + 1))
        quad = [[r6(ro * math.cos(a0)), r6(ro * math.sin(a0))], [r6(ro * math.cos(a1)), r6(ro * math.sin(a1))],
                [r6(ri * math.cos(a1)), r6(ri * math.sin(a1))], [r6(ri * math.cos(a0)), r6(ri * math.sin(a0))]]
        add_shape("M1", quad, TOP + "/GUARD", "GUARD", "GND")

    # Pins.
    p1 = center[0]
    pins.append({"id": 0, "terminal": "P1", "name": "P1", "net": "P1", "layer": "M6", "purpose": "pin",
                 "ownerCell": "SPIRAL", "hierPath": TOP + "/SPIRAL",
                 "worldBBox": bbox_of(box_points(p1[0] - 3, p1[1] - 3, p1[0] + 3, p1[1] + 3)),
                 "points": box_points(p1[0] - 3, p1[1] - 3, p1[0] + 3, p1[1] + 3), "source": "synthetic"})
    pins.append({"id": 1, "terminal": "P2", "name": "P2", "net": "P2", "layer": "M5", "purpose": "pin",
                 "ownerCell": "UNDERPASS", "hierPath": TOP + "/UNDERPASS",
                 "worldBBox": bbox_of(box_points(x_end - 6, inner[1] - 3, x_end, inner[1] + 3)),
                 "points": box_points(x_end - 6, inner[1] - 3, x_end, inner[1] + 3), "source": "synthetic"})
    g = ro - 3.0
    pins.append({"id": 2, "terminal": "GND", "name": "GND", "net": "GND", "layer": "M1", "purpose": "pin",
                 "ownerCell": "GUARD", "hierPath": TOP + "/GUARD",
                 "worldBBox": bbox_of(box_points(g - 2, -2, g + 2, 2)),
                 "points": box_points(g - 2, -2, g + 2, 2), "source": "synthetic"})

    xs = [p[0] for s in shapes for p in s["points"]]
    ys = [p[1] for s in shapes for p in s["points"]]
    bbox = {"min": [min(xs), min(ys)], "max": [max(xs), max(ys)]}
    for index, name in enumerate(("SPIRAL", "UNDERPASS", "GUARD")):
        owned = [s for s in shapes if s["ownerCell"] == name]
        pts = [p for s in owned for p in s["points"]]
        box = bbox_of(pts)
        instances.append({"id": index, "hierPath": TOP + "/" + name, "parentPath": TOP, "name": name,
                          "master": {"library": LIB, "cell": name, "view": "layout"},
                          "worldBBox": box, "bbox": box, "depth": 1})
    layers = []
    for index, (name, kind, semantic, z0, z1, color) in enumerate(LAYERS):
        endpoints = {"lowerLayer": "M5", "upperLayer": "M6", "connectivitySource": "explicit"} if name == "V5" else {}
        layers.append({"index": index, "name": name, "kind": kind, "semantic": semantic, "routing": True,
                       "defaultVisible": True, "color": color, "z": z0, "height": r6(z1 - z0),
                       "zBottomUm": z0, "zTopUm": z1, "thickness": r6(z1 - z0), "approximate": True,
                       "shapeCount": len([s for s in shapes if s["layer"] == name]), **endpoints})
    return {
        "schemaVersion": 2, "sourceSchemaVersion": 2, "units": "um", "dbuPerMicron": 1000,
        "library": LIB, "cell": TOP, "view": "layout", "generatedAt": "2026-01-01T00:00:00Z",
        "bbox": bbox, "layers": layers, "shapes": shapes, "instances": instances, "pins": pins,
        "connections": [], "shapeCount": len(shapes), "instanceCount": len(instances),
        "pinCount": len(pins), "connectionCount": 0,
        "technology": {"profile": "example-process", "source": "synthetic", "approximate": True,
                       "geometryApproximate": True},
        "deviceScopes": {}, "deviceMetadataComplete": True,
        "exportStatus": {"complete": True, "truncated": False},
        "description": "Entirely synthetic octagonal inductor: M6 spiral, M5 underpass joined by a V5 via "
                       "array at the centre, M1 guard ring. P1 and P2 are the two inductor terminals.",
    }


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "examples", "octagon-inductor.json")
    with open(out, "w") as handle:
        json.dump(build(), handle, indent=1)
        handle.write("\n")
    print("wrote", out)


if __name__ == "__main__":
    main()
