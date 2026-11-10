"""Bounded physical conductor tracing on flattened layout geometry.

This is geometric connectivity, not device extraction or a substitute for LVS.
Source array ordinals are retained; display meshes and net names are never used
as evidence of a physical connection. No source or cache files are modified.
"""
from __future__ import absolute_import

import collections
import hashlib
import json
import math
import os
import time

from .compiler import (_clean_points, _legacy_pathseg_bbox, _parse_metadata,
                       _path_footprints, _source_open)
from .errors import Vl3dError
from tools.pdk_profile import is_non_conductive_purpose


ENGINE_VERSION = 'physical-trace-v1'
DEFAULT_LIMITS = {
    'maxShapes': 200000, 'maxVertices': 4000000, 'maxCandidates': 2000000,
    'maxResults': 100000, 'maxSeconds': 60.0, 'maxMemoryMiB': 256,
    'maxIndexCells': 2000000, 'maxGeometryChecks': 10000000,
}
# Sub-DBU integer arithmetic prevents float32 display precision from joining gaps.
COORDINATE_SCALE = 1000000000


class _Stop(Exception):
    def __init__(self, status, reason):
        self.status, self.reason = status, reason


def _limits(values=None):
    result = dict(DEFAULT_LIMITS)
    aliases = dict((''.join('_' + c.lower() if c.isupper() else c for c in key), key)
                   for key in DEFAULT_LIMITS)
    for key, value in (values or {}).items():
        key = aliases.get(key, key)
        if key in result:
            try:
                value = float(value) if key == 'maxSeconds' else int(value)
            except (TypeError, ValueError, OverflowError):
                raise Vl3dError('E9003', 'Invalid physical trace limit: %s' % key)
            if value <= 0 or not math.isfinite(value):
                raise Vl3dError('E9003', 'Physical trace limits must be positive: %s' % key)
            result[key] = value
    return result


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                    ensure_ascii=True).encode('utf-8')).hexdigest()


def _text(value):
    return str(value or '').strip()


def _layer(value):
    return _text(value).upper()


def _under(path, roots):
    return not roots or any(path == root or path.startswith(root + '/') for root in roots)


def _cross(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _on_segment(point, a, b):
    return (_cross(a, b, point) == 0 and min(a[0], b[0]) <= point[0] <= max(a[0], b[0])
            and min(a[1], b[1]) <= point[1] <= max(a[1], b[1]))


def _ring_location(point, ring):
    """-1 outside, 0 boundary, 1 inside; exact integer even-odd predicate."""
    inside = False
    x, y = point
    for index, a in enumerate(ring):
        b = ring[(index + 1) % len(ring)]
        cross = _cross(a, b, point)
        if cross == 0 and _on_segment(point, a, b):
            return 0
        if (a[1] > y) != (b[1] > y):
            if (cross > 0) == (b[1] > a[1]):
                inside = not inside
    return 1 if inside else -1


def _location(point, polygons):
    boundary = False
    for rings in polygons:
        outer = _ring_location(point, rings[0])
        if outer < 0:
            continue
        if outer == 0:
            boundary = True
            continue
        in_hole = False
        for hole in rings[1:]:
            value = _ring_location(point, hole)
            if value == 0:
                boundary = True
                in_hole = True
                break
            if value > 0:
                in_hole = True
                break
        if not in_hole:
            return 1
    return 0 if boundary else -1


def _bbox_overlap(a, b, area=False):
    dx = min(a[2], b[2]) - max(a[0], b[0])
    dy = min(a[3], b[3]) - max(a[1], b[1])
    return dx > 0 and dy > 0 if area else dx >= 0 and dy >= 0


def _segment_contact(a, b, c, d):
    first, second, third, fourth = _cross(a, b, c), _cross(a, b, d), _cross(c, d, a), _cross(c, d, b)
    if ((first > 0 and second < 0) or (first < 0 and second > 0)) and \
            ((third > 0 and fourth < 0) or (third < 0 and fourth > 0)):
        return 3  # Proper crossing: area overlap for valid polygons.
    if first == second == third == fourth == 0:
        axis = 0 if a[0] != b[0] else 1
        overlap = min(max(a[axis], b[axis]), max(c[axis], d[axis])) - max(min(a[axis], b[axis]), min(c[axis], d[axis]))
        return 2 if overlap > 0 else (1 if overlap == 0 else 0)
    if ((first == 0 and _on_segment(c, a, b)) or (second == 0 and _on_segment(d, a, b))
            or (third == 0 and _on_segment(a, c, d)) or (fourth == 0 and _on_segment(b, c, d))):
        return 1
    return 0


class _Shape(object):
    __slots__ = ('index', 'layer', 'path', 'polygons', 'bbox', 'edges', 'rectangle', 'vertices')

    def __init__(self, index, layer, path, polygons):
        self.index, self.layer, self.path, self.polygons = index, layer, path, polygons
        points = [point for rings in polygons for ring in rings for point in ring]
        self.vertices = len(points)
        self.bbox = (min(p[0] for p in points), min(p[1] for p in points),
                     max(p[0] for p in points), max(p[1] for p in points))
        self.edges = [(ring[i], ring[(i + 1) % len(ring)]) for rings in polygons
                      for ring in rings for i in range(len(ring))]
        ring = polygons[0][0]
        self.rectangle = (len(polygons) == 1 and len(polygons[0]) == 1 and len(ring) == 4
                          and all((a[0] == b[0]) != (a[1] == b[1]) for a, b in self.edges))


def _record_geometry(record, index, unit_scale=1.0, seed=False, check=None):
    """Input is world-space by default; explicit local affine data is supported."""
    shape_type = _text(record.get('type') or record.get('shapeType') or record.get('figType')).lower()
    shape_type = {'box': 'rect', 'rectangle': 'rect'}.get(shape_type, shape_type)
    if _legacy_pathseg_bbox(record):
        raise ValueError('legacy_pathseg_bbox: refresh or re-export the layout for exact path geometry')
    points = record.get('worldPoints') or record.get('points')
    bbox = record.get('worldBBox') or record.get('bbox')
    holes = record.get('worldHoles') or record.get('holes') or []
    using_world_bbox = not points and bool(record.get('worldBBox'))
    if not shape_type and seed:
        shape_type = 'polygon' if points else 'rect'
    if shape_type not in ('rect', 'polygon', 'path', 'pathseg'):
        raise ValueError('unsupported_shape_type:%s' % (shape_type or 'unknown'))
    if not points and shape_type == 'rect' and bbox:
        lo, hi = bbox.get('min'), bbox.get('max')
        if not lo or not hi or len(lo) < 2 or len(hi) < 2:
            raise ValueError('invalid_bbox')
        points = [(lo[0], lo[1]), (hi[0], lo[1]), (hi[0], hi[1]), (lo[0], hi[1])]
    if not isinstance(points, (list, tuple)) or not points:
        raise ValueError('missing_geometry')

    local = (_text(record.get('coordinateSpace')).lower() == 'local'
             and not record.get('worldPoints') and not using_world_bbox)
    transform = record.get('transform') if local else None
    if local and (not isinstance(transform, (list, tuple)) or len(transform) != 6):
        raise ValueError('local_geometry_requires_affine_transform')

    def convert(ring):
        result = []
        for point in ring:
            if not isinstance(point, (list, tuple)) or len(point) < 2:
                raise ValueError('invalid_point')
            x, y = float(point[0]), float(point[1])
            if transform is not None:
                a, b, c, d, tx, ty = [float(v) for v in transform]
                x, y = a * x + c * y + tx, b * x + d * y + ty
            x, y = x * unit_scale, y * unit_scale
            if not math.isfinite(x) or not math.isfinite(y) or abs(x) > 1e9 or abs(y) > 1e9:
                raise ValueError('invalid_coordinate')
            if not result or result[-1] != (x, y):
                result.append((x, y))
        return result

    converted = convert(points)
    converted_holes = [convert(hole) for hole in holes]
    if shape_type in ('path', 'pathseg'):
        path_scale = unit_scale
        width = float(record.get('width') or 0) * path_scale
        if transform is not None:
            a, b, c, d = [float(v) for v in transform[:4]]
            first_scale, second_scale = math.hypot(a, b), math.hypot(c, d)
            if abs(first_scale - second_scale) > 1e-10 or abs(a * c + b * d) > 1e-10:
                raise ValueError('nonuniform_path_transform')
            width *= first_scale
            path_scale *= first_scale
        path_options = dict(record)
        for key in ('beginExt', 'endExt'):
            if record.get(key) is not None:
                extension = float(record[key]) * path_scale
                if not math.isfinite(extension):
                    raise ValueError('invalid_path_extension')
                path_options[key] = extension
        converted_shapes = [[footprint] for footprint in _path_footprints(converted, width, path_options)]
    else:
        converted_shapes = [[converted] + converted_holes]
    polygons = []
    for rings in converted_shapes:
        integer_rings = []
        for ring in rings:
            cleaned = []
            for x, y in ring:
                point = (int(round(x * COORDINATE_SCALE)), int(round(y * COORDINATE_SCALE)))
                if not cleaned or cleaned[-1] != point:
                    cleaned.append(point)
            if len(cleaned) > 1 and cleaned[0] == cleaned[-1]:
                cleaned.pop()
            if len(cleaned) < 3:
                raise ValueError('degenerate_polygon')
            area = sum(_cross(cleaned[0], cleaned[i], cleaned[i + 1]) for i in range(1, len(cleaned) - 1))
            if area == 0:
                raise ValueError('zero_area_polygon')
            # A nonzero signed area does not prove a polygon is simple.
            # GDS bridge edges may repeat, but proper self-crossings are invalid.
            for first in range(len(cleaned)):
                for second in range(first + 2, len(cleaned)):
                    if first == 0 and second == len(cleaned) - 1:
                        continue
                    if check:
                        check()
                    if _segment_contact(cleaned[first], cleaned[(first + 1) % len(cleaned)],
                                        cleaned[second], cleaned[(second + 1) % len(cleaned)]) == 3:
                        raise ValueError('self_intersecting_polygon')
            integer_rings.append(cleaned)
        for hole in integer_rings[1:]:
            if any(_ring_location(point, integer_rings[0]) < 0 for point in hole):
                raise ValueError('hole_outside_polygon')
            for a, b in zip(hole, hole[1:] + hole[:1]):
                outer = integer_rings[0]
                for c, d in zip(outer, outer[1:] + outer[:1]):
                    if check:
                        check()
                    if _segment_contact(a, b, c, d) == 3:
                        raise ValueError('hole_crosses_polygon_boundary')
        if len(integer_rings) > 1:
            # Normalize hole unions/notches. A hole touching the outer edge
            # must not leave an artificial conductive boundary along that edge.
            import gdstk
            ox, oy = integer_rings[0][0]
            translated = [[(x - ox, y - oy) for x, y in ring] for ring in integer_rings]
            fragments = gdstk.boolean([translated[0]], translated[1:], 'not', precision=1)
            for fragment in fragments:
                ring = [(int(round(point[0])) + ox, int(round(point[1])) + oy) for point in fragment.points]
                if len(ring) >= 3:
                    polygons.append([ring])
        else:
            polygons.append(integer_rings)
    if not polygons:
        raise ValueError('empty_geometry')
    return _Shape(index, _layer(record.get('layer')), _text(record.get('hierPath')), polygons)


class PhysicalTraceIndex(object):
    def __init__(self):
        self.metadata = {}
        self.rules = {}
        self.source_digest = ''
        self.rules_digest = ''
        self.shapes = {}
        self.layer_shapes = collections.defaultdict(list)
        self.grids = {}
        self.adjacent_layers = collections.defaultdict(set)
        self.warnings = []
        self.build_status = 'complete'
        self.build_reason = ''
        self.limits = _limits()
        self.started = time.monotonic()
        self.stats = {'sourceShapes': 0, 'indexedShapes': 0, 'vertices': 0,
                      'excludedShapes': 0, 'unsupportedShapes': 0, 'indexCells': 0,
                      'estimatedIndexBytes': 0, 'candidateChecks': 0,
                      'geometryChecks': 0, 'pointContactsExcluded': 0,
                      'scopeBoundaryContacts': 0, 'validationChecks': 0}
        self.unit_scale = 1.0
        self.progress = None
        self._traced = False

    def _checkpoint(self, cancelled=None):
        if cancelled is not None:
            value = cancelled() if callable(cancelled) else cancelled.is_set()
            if value:
                raise _Stop('cancelled', 'cancelled_by_user')
        if time.monotonic() - self.started >= self.limits['maxSeconds']:
            raise _Stop('limited', 'maxSeconds')
        if self.stats['estimatedIndexBytes'] > self.limits['maxMemoryMiB'] * 1024 * 1024:
            raise _Stop('limited', 'maxMemoryMiB')

    def _validation_check(self, cancelled=None):
        self.stats['validationChecks'] += 1
        if self.stats['validationChecks'] > self.limits['maxGeometryChecks']:
            raise _Stop('limited', 'maxGeometryChecks')
        if self.stats['validationChecks'] % 512 == 0:
            self._checkpoint(cancelled)

    def _warn(self, code, **fields):
        if not any(item.get('code') == code for item in self.warnings):
            self.warnings.append(dict({'code': code}, **fields))

    @classmethod
    def from_layout(cls, source, rules=None, limits=None, cancelled=None, progress=None):
        self = cls()
        self.limits = _limits(limits)
        self.progress = progress
        iterator = None
        handle = None
        before = None
        try:
            self._checkpoint(cancelled)
            if isinstance(source, dict):
                self.metadata = dict((k, v) for k, v in source.items() if k != 'shapes')
                self.source_digest = _digest(source)
                iterator = iter(source.get('shapes') or [])
            else:
                path = os.path.realpath(str(source))
                before = os.stat(path)
                digest = hashlib.sha256()
                with open(path, 'rb') as raw:
                    for block in iter(lambda: raw.read(1024 * 1024), b''):
                        digest.update(block)
                        self._checkpoint(cancelled)
                self.source_digest = digest.hexdigest()
                try:
                    import ijson
                except ImportError:
                    raise Vl3dError('E1013', 'Physical tracing requires ijson')
                self.metadata = _parse_metadata(path, ijson)
                handle = _source_open(path)
                iterator = ijson.items(handle, 'shapes.item', use_float=True)
            if not self.metadata.get('cell'):
                raise Vl3dError('E9003', 'Physical trace source has no cell identity')
            units = _text(self.metadata.get('units') or 'um').lower()
            if units in ('um', '\u00b5m', '\u03bcm', 'micron', 'microns', 'micrometer', 'micrometers'):
                pass
            elif units == 'nm':
                self.unit_scale = 0.001
            elif units == 'dbu':
                dbu = float(self.metadata.get('dbuPerMicron') or 0)
                if dbu <= 0:
                    raise Vl3dError('E9003', 'DBU source requires dbuPerMicron')
                self.unit_scale = 1.0 / dbu
            else:
                raise Vl3dError('E9003', 'Unsupported physical trace units: %s' % units)
            if rules is None:
                from tools.trace_rules import build_trace_rules
                rules = build_trace_rules(self.metadata)
            self.rules = rules
            self.rules_digest = _digest(rules)
            self.warnings.extend(rules.get('warnings') or [])
            conductors = set(_layer(name) for name in rules.get('conductors') or {})
            connectors = dict((_layer(name), value) for name, value in (rules.get('connectors') or {}).items())
            accepted = conductors | set(connectors)
            for name in conductors:
                self.adjacent_layers[name].add(name)
            for name, value in connectors.items():
                for endpoint in value.get('lowerLayers', []) + value.get('upperLayers', []):
                    endpoint = _layer(endpoint)
                    if endpoint in conductors:
                        self.adjacent_layers[name].add(endpoint)
                        self.adjacent_layers[endpoint].add(name)
            excluded = set(rules.get('excludedShapeIndices') or [])
            device_scopes = rules.get('deviceScopes') or {}
            from tools.trace_rules import is_shape_allowed
            for index, raw_shape in enumerate(iterator):
                self.stats['sourceShapes'] = index + 1
                if index >= self.limits['maxShapes']:
                    raise _Stop('limited', 'maxShapes')
                if index % 128 == 0:
                    self._checkpoint(cancelled)
                    if progress:
                        progress({'phase': 'index', 'done': index,
                                  'total': int(self.metadata.get('shapeCount') or 0)})
                if not isinstance(raw_shape, dict):
                    self.stats['unsupportedShapes'] += 1
                    continue
                layer = _layer(raw_shape.get('layer'))
                purpose = _text(raw_shape.get('purpose')).lower()
                role = _text(raw_shape.get('traceRole')).lower()
                scope = _text(raw_shape.get('hierPath'))
                device_barrier = not is_shape_allowed(raw_shape, rules)
                ancestor = scope
                while ancestor and not device_barrier:
                    device = device_scopes.get(ancestor, {})
                    device_barrier = device.get('traceRole') == 'barrier' or device.get('blocked') is True
                    ancestor = ancestor.rpartition('/')[0]
                if (layer not in accepted or index in excluded or raw_shape.get('routing') is False
                        or is_non_conductive_purpose(purpose) or purpose == 'pin'
                        or role in ('barrier', 'device', 'excluded') or device_barrier):
                    self.stats['excludedShapes'] += 1
                    continue
                try:
                    shape = _record_geometry(raw_shape, index, self.unit_scale, check=lambda: self._validation_check(cancelled))
                except (ValueError, TypeError, IndexError, OverflowError, Vl3dError) as error:
                    self.stats['unsupportedShapes'] += 1
                    code = 'legacy_pathseg_bbox' if str(error).startswith('legacy_pathseg_bbox:') else 'unsupported_geometry'
                    self._warn(code, message=str(error))
                    continue
                self.stats['vertices'] += shape.vertices
                if self.stats['vertices'] > self.limits['maxVertices']:
                    raise _Stop('limited', 'maxVertices')
                self.stats['estimatedIndexBytes'] += 768 + shape.vertices * 192
                self._checkpoint(cancelled)
                self.shapes[index] = shape
                self.layer_shapes[layer].append(index)
                self.stats['indexedShapes'] += 1
            self._build_grid(cancelled)
            if before is not None:
                after = os.stat(path)
                if before.st_size != after.st_size or before.st_mtime != after.st_mtime:
                    raise Vl3dError('E6008', 'Layout changed while physical trace index was built')
            if rules.get('complete') is False or self.stats['unsupportedShapes']:
                self.build_status = 'limited'
                self.build_reason = ('legacy_pathseg_bbox' if any(w.get('code') == 'legacy_pathseg_bbox' for w in self.warnings)
                                     else 'incomplete_rules' if rules.get('complete') is False else 'unsupported_geometry')
            export = self.metadata.get('exportStatus') or {}
            if export.get('complete') is False or export.get('truncated') is True:
                self.build_status, self.build_reason = 'limited', 'incomplete_export'
                self._warn('incomplete_export')
        except _Stop as stop:
            self.build_status, self.build_reason = stop.status, stop.reason
        finally:
            if handle is not None:
                handle.close()
        self._build_warnings = list(self.warnings)
        return self

    def _build_grid(self, cancelled):
        for layer, indices in self.layer_shapes.items():
            values = [self.shapes[i] for i in indices]
            min_x, min_y = min(s.bbox[0] for s in values), min(s.bbox[1] for s in values)
            max_x, max_y = max(s.bbox[2] for s in values), max(s.bbox[3] for s in values)
            cell = max(1, int(max(max_x - min_x, max_y - min_y) / max(1, math.sqrt(len(values)))))
            grid, overflow = {}, []
            self.grids[layer] = (cell, grid, overflow)
            for offset, shape in enumerate(values):
                if offset % 128 == 0:
                    self._checkpoint(cancelled)
                x0, y0, x1, y1 = [value // cell for value in shape.bbox]
                count = (x1 - x0 + 1) * (y1 - y0 + 1)
                if count > 64:
                    overflow.append(shape.index)
                    self.stats['estimatedIndexBytes'] += 16
                    continue
                for x in range(x0, x1 + 1):
                    for y in range(y0, y1 + 1):
                        if (x, y) not in grid:
                            grid[(x, y)] = []
                            self.stats['indexCells'] += 1
                            self.stats['estimatedIndexBytes'] += 160
                        grid[(x, y)].append(shape.index)
                        self.stats['estimatedIndexBytes'] += 16
                if self.stats['indexCells'] > self.limits['maxIndexCells']:
                    raise _Stop('limited', 'maxIndexCells')
        self._checkpoint(cancelled)

    def _query(self, layer, bbox):
        if layer not in self.grids:
            # A resource-limited index can still expose an honest partial result.
            return iter(self.layer_shapes.get(layer, ()))
        cell, grid, overflow = self.grids[layer]
        x0, y0, x1, y1 = [value // cell for value in bbox]
        if (x1 - x0 + 1) * (y1 - y0 + 1) > max(64, len(grid)):
            return iter(self.layer_shapes.get(layer, ()))
        found = set(overflow)
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                found.update(grid.get((x, y), ()))
        return iter(sorted(found))

    def _intersection(self, first, second, area_only, cancelled):
        self.stats['candidateChecks'] += 1
        if self.stats['candidateChecks'] > self.limits['maxCandidates']:
            raise _Stop('limited', 'maxCandidates')
        if self.stats['candidateChecks'] % 64 == 0:
            self._checkpoint(cancelled)
        if not _bbox_overlap(first.bbox, second.bbox, area=area_only):
            return False
        if first.rectangle and second.rectangle:
            dx = min(first.bbox[2], second.bbox[2]) - max(first.bbox[0], second.bbox[0])
            dy = min(first.bbox[3], second.bbox[3]) - max(first.bbox[1], second.bbox[1])
            if dx == dy == 0:
                self.stats['pointContactsExcluded'] += 1
                return False
            return True
        boundary = 0
        for a, b in first.edges:
            edge_box = (min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1]))
            for c, d in second.edges:
                self.stats['geometryChecks'] += 1
                if self.stats['geometryChecks'] > self.limits['maxGeometryChecks']:
                    raise _Stop('limited', 'maxGeometryChecks')
                if self.stats['geometryChecks'] % 512 == 0:
                    self._checkpoint(cancelled)
                if not _bbox_overlap(edge_box, (min(c[0], d[0]), min(c[1], d[1]), max(c[0], d[0]), max(c[1], d[1]))):
                    continue
                contact = _segment_contact(a, b, c, d)
                if contact == 3:
                    return True
                boundary = max(boundary, contact)
        for shape, other in ((first, second), (second, first)):
            for rings in shape.polygons:
                if any(_location(point, other.polygons) > 0 for point in rings[0]):
                    return True
        if not area_only and boundary >= 2:
            return True
        if boundary:
            # Identical or boundary-aligned polygons need a positive-area test.
            # Translate before clipping to avoid loss with a large layout origin.
            import gdstk
            ox, oy = max(first.bbox[0], second.bbox[0]), max(first.bbox[1], second.bbox[1])
            def polygons(shape):
                result = []
                for rings in shape.polygons:
                    points = [[(x - ox, y - oy) for x, y in ring] for ring in rings]
                    if len(points) == 1:
                        result.append(gdstk.Polygon(points[0]))
                    else:
                        result.extend(gdstk.boolean([points[0]], points[1:], 'not', precision=1))
                return result
            overlap = gdstk.boolean(polygons(first), polygons(second), 'and', precision=1)
            if any(p.area() > 0 for p in overlap):
                return True
            if boundary == 1:
                self.stats['pointContactsExcluded'] += 1
        return False

    def trace(self, pins, scope_paths=None, cancelled=None, limits=None):
        # Index reuse must not carry a previous pin's cancellation/scope warning.
        self.warnings = list(self._build_warnings)
        if self._traced:
            self.started = time.monotonic()
        self._traced = True
        if limits:
            self.limits.update(_limits(dict(self.limits, **limits)))
        pins = [pins] if isinstance(pins, dict) else list(pins or [])
        roots = [_text(path) for path in scope_paths or [] if _text(path)]
        status, reason = self.build_status, self.build_reason
        components, visited, seeds, missing_seeds = [], {}, [], []
        self.stats['candidateChecks'] = self.stats['geometryChecks'] = 0
        self.stats['scopeBoundaryContacts'] = self.stats['pointContactsExcluded'] = 0
        try:
            self._checkpoint(cancelled)
            if not pins:
                raise _Stop('no_seed', 'no_pin_selected')
            for pin_index, pin in enumerate(pins):
                self._checkpoint(cancelled)
                if not isinstance(pin, dict):
                    missing_seeds.append(pin_index)
                    continue
                try:
                    seed = _record_geometry(pin, -1, self.unit_scale, seed=True, check=lambda: self._validation_check(cancelled))
                except (ValueError, TypeError, IndexError, OverflowError, Vl3dError) as error:
                    self._warn('invalid_pin_geometry', message=str(error))
                    missing_seeds.append(pin_index)
                    continue
                matches = []
                for index in self._query(seed.layer, seed.bbox):
                    shape = self.shapes[index]
                    if _under(shape.path, roots) and self._intersection(seed, shape, False, cancelled):
                        matches.append(index)
                if not matches:
                    missing_seeds.append(pin_index)
                seeds.extend((index, pin_index) for index in matches)
            for seed_index, pin_index in seeds:
                if seed_index in visited:
                    component = components[visited[seed_index]]
                    if pin_index not in component['seedIndices']:
                        component['seedIndices'].append(pin_index)
                    continue
                if len(visited) >= self.limits['maxResults']:
                    raise _Stop('limited', 'maxResults')
                component = {'seedIndices': [pin_index], 'shapeIndices': []}
                component_index = len(components)
                components.append(component)
                queue = collections.deque([seed_index])
                visited[seed_index] = component_index
                while queue:
                    self._checkpoint(cancelled)
                    index = queue.popleft()
                    shape = self.shapes[index]
                    component['shapeIndices'].append(index)
                    if self.progress and len(component['shapeIndices']) % 256 == 0:
                        self.progress({'phase': 'trace', 'done': len(visited),
                                       'total': self.stats['indexedShapes']})
                    if len(visited) > self.limits['maxResults']:
                        raise _Stop('limited', 'maxResults')
                    for layer in sorted(self.adjacent_layers.get(shape.layer, ())):
                        for neighbor in self._query(layer, shape.bbox):
                            if neighbor in visited:
                                continue
                            other = self.shapes[neighbor]
                            if not self._intersection(shape, other, layer != shape.layer, cancelled):
                                continue
                            if not _under(other.path, roots):
                                self.stats['scopeBoundaryContacts'] += 1
                                continue
                            if len(visited) >= self.limits['maxResults']:
                                raise _Stop('limited', 'maxResults')
                            visited[neighbor] = component_index
                            queue.append(neighbor)
            if not seeds:
                status, reason = 'no_seed', 'pin_does_not_touch_indexed_conductor'
            elif missing_seeds:
                status, reason = 'limited', 'unmatched_pin_figures'
            elif len(components) > 1:
                status, reason = 'ambiguous_seed', 'disconnected_pin_components'
            elif self.stats['scopeBoundaryContacts']:
                status, reason = 'limited', 'scope_boundary'
            elif self.stats['pointContactsExcluded']:
                status, reason = 'limited', 'point_only_contacts'
        except _Stop as stop:
            status, reason = stop.status, stop.reason
        if status != 'complete':
            self._warn(reason or status)
        # Include queued, already-confirmed nodes if cancellation interrupted BFS.
        for component in components:
            component['shapeIndices'] = []
        for index, component_index in visited.items():
            components[component_index]['shapeIndices'].append(index)
        for component in components:
            component['shapeIndices'].sort()
            component['seedIndices'].sort()
        stats = dict(self.stats)
        stats.update({'resultShapes': len(visited), 'elapsedSeconds': time.monotonic() - self.started,
                      'missingSeedFigures': len(missing_seeds)})
        return {'engineVersion': ENGINE_VERSION, 'sourceDigest': self.source_digest,
                'rulesDigest': self.rules_digest, 'status': status, 'reason': reason,
                'complete': status == 'complete', 'shapeIndices': sorted(visited),
                'components': components, 'seedComponentCount': len(components),
                'missingSeedIndices': missing_seeds, 'scopePaths': roots,
                'coordinatePrecisionUm': 1.0 / COORDINATE_SCALE,
                'contactPolicy': 'same-layer-edge-or-area; connector-positive-area',
                'stats': stats, 'warnings': list(self.warnings)}
