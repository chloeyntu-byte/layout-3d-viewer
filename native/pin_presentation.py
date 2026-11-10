"""Read-only pin presentation. Screen annotations never replace source geometry."""
from __future__ import absolute_import

import math

from .compiler import _legacy_pathseg_bbox, _path_footprints
from .errors import Vl3dError


def pin_name(pin):
    # Preserve the exact original spelling, including bus syntax and Unicode.
    value = pin.get('terminal')
    if value is None or value == '':
        value = pin.get('name')
    return str(value) if value is not None else ''


def pin_rings(pin):
    shape_type = str(pin.get('type') or pin.get('shapeType') or pin.get('figType') or '').lower()
    is_path = shape_type in ('path', 'pathseg') and not _legacy_pathseg_bbox(pin)
    points = pin.get('worldPoints') or pin.get('points')
    if not points and is_path:
        return []
    if not points:
        bbox = pin.get('worldBBox') or pin.get('bbox') or {}
        lo, hi = bbox.get('min'), bbox.get('max')
        if not lo or not hi:
            return []
        points = [(lo[0], lo[1]), (hi[0], lo[1]), (hi[0], hi[1]), (lo[0], hi[1])]
    rings = []
    for ring in [points] + list(pin.get('worldHoles') or pin.get('holes') or []):
        converted = []
        for point in ring:
            try:
                x, y = float(point[0]), float(point[1])
            except (IndexError, TypeError, ValueError):
                return []
            if not math.isfinite(x) or not math.isfinite(y):
                return []
            converted.append((x, y))
        if is_path:
            # points are the original centerline; derive its real boundary with
            # the same width/caps/extensions as meshes and physical seeds.
            # Fresh OA pathSeg exports are already polygons and bypass this.
            try:
                return _path_footprints(converted, pin.get('width'), pin)
            except (Vl3dError, TypeError, ValueError, OverflowError):
                return []
        if len(converted) > 1 and converted[0] == converted[-1]:
            converted.pop()
        if len(converted) >= 3:
            rings.append(converted)
    return rings


def pin_bounds(pin):
    rings = pin_rings(pin)
    if not rings:
        return None
    points = [point for ring in rings for point in ring]
    return (min(p[0] for p in points), min(p[1] for p in points),
            max(p[0] for p in points), max(p[1] for p in points))


def selected_pin_index(pins, selected):
    for index, pin in enumerate(pins):
        if pin is selected:
            return index
    for index, pin in enumerate(pins):
        if pin == selected:
            return index
    return None


def pin_annotations(pins, selected=None):
    """One annotation per source figure; repeated terminal names stay repeated."""
    active = selected_pin_index(pins, selected)
    totals = {}
    for pin in pins:
        key = (pin.get('hierPath'), pin_name(pin))
        totals[key] = totals.get(key, 0) + 1
    seen, result = {}, []
    for index, pin in enumerate(pins):
        key = (pin.get('hierPath'), pin_name(pin))
        seen[key] = seen.get(key, 0) + 1
        result.append({'source': pin, 'sourceIndex': index, 'name': pin_name(pin),
                       'path': pin.get('hierPath') or '', 'layer': pin.get('layer') or '',
                       'figureNumber': seen[key], 'figureCount': totals[key],
                       'active': index == active, 'bounds': pin_bounds(pin),
                       'rings': pin_rings(pin)})
    return result


def place_labels(candidates, width, height, limit=48, margin=8):
    """Place readable labels in viewport pixels, prioritizing the current pin.

    Input carries a source reference and a measured label size. It is never
    mutated. Leaders point to the actual projected figure center; an offscreen
    active figure gets an edge indicator rather than an invented world point.
    """
    width, height = max(1, int(width)), max(1, int(height))
    boxes, placed = [], []
    ordered = sorted(candidates, key=lambda item: (not item.get('active'), item['sourceIndex']))
    for candidate in ordered:
        if len(placed) >= limit and not candidate.get('active'):
            break
        anchor = candidate.get('anchor')
        if anchor is None:
            continue
        x, y = anchor[:2]
        offscreen = x < margin or x > width - margin or y < margin or y > height - margin
        if offscreen and not candidate.get('active'):
            continue
        x = min(max(float(x), margin), max(margin, width - margin))
        y = min(max(float(y), margin), max(margin, height - margin))
        label_width, label_height = candidate['size']
        label_width = min(max(1, label_width), max(1, width - margin * 2))
        label_height = min(max(1, label_height), max(1, height - margin * 2))
        best, best_score = None, None
        for distance in (18, 36, 60, 90, 132, 180):
            for dx, dy in ((distance, -label_height - 8), (distance, 8),
                           (-distance - label_width, -label_height - 8),
                           (-distance - label_width, 8),
                           (-label_width / 2, -distance - label_height),
                           (-label_width / 2, distance)):
                left = min(max(x + dx, margin), max(margin, width - margin - label_width))
                top = min(max(y + dy, margin), max(margin, height - margin - label_height))
                box = (left, top, left + label_width, top + label_height)
                overlap = sum(max(0, min(box[2] + 3, old[2]) - max(box[0] - 3, old[0]))
                              * max(0, min(box[3] + 3, old[3]) - max(box[1] - 3, old[1]))
                              for old in boxes)
                score = overlap * 10000 + (left + label_width / 2 - x) ** 2 + (top + label_height / 2 - y) ** 2
                if best_score is None or score < best_score:
                    best, best_score = box, score
        # Non-current labels can wait for a closer view when there is no room.
        if not candidate.get('active') and any(
                best[0] < b[2] + 3 and best[2] + 3 > b[0]
                and best[1] < b[3] + 3 and best[3] + 3 > b[1] for b in boxes):
            continue
        entry = dict(candidate)
        entry.update({'box': best, 'screenAnchor': (x, y), 'offscreen': offscreen})
        placed.append(entry)
        boxes.append(best)
    return placed
