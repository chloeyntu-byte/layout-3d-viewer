from __future__ import absolute_import

import gzip
import hashlib
import json
import math
import os
import shutil
import tempfile
import time

from .errors import Vl3dError
from tools.layout_units import validate_viewer_units
from tools.pdk_profile import (classify_layer, is_hard_non_conductive_layer_name,
                               is_non_conductive_layer_name,
                               is_non_conductive_purpose, load_registry)


COMPILER_VERSION = 'native-cache-v1.10'
TARGET_ARRAYS = ('layers', 'instances', 'pins', 'connections', 'sourceViews')
TARGET_OBJECTS = ('bbox', 'technology', 'exportStatus', 'deviceScopes', 'traceRules', 'units')
SCALAR_KEYS = (
    'schemaVersion', 'sourceSchemaVersion', 'library', 'cell', 'view', 'units',
    'dbuPerMicron', 'shapeCount', 'instanceCount', 'pinCount', 'connectionCount',
    'generatedAt', 'sourceShapeCount', 'maxInstanceDepth', 'maxShapeDepth',
    'deviceMetadataComplete', 'deviceBoundaryComplete', 'deviceBoundarySource',
)


def _secure_directory(path, create=False):
    if os.path.lexists(path):
        if os.path.islink(path) or not os.path.isdir(path):
            raise Vl3dError('E4005', 'Native compile path is not a safe directory: %s' % path)
    elif create:
        try:
            os.makedirs(path, 0o700)
        except OSError:
            if not os.path.isdir(path) or os.path.islink(path):
                raise
    else:
        raise Vl3dError('E4005', 'Native compile directory is missing: %s' % path)
    os.chmod(path, 0o700)


def _secure_publish_tree(path, array_names):
    _secure_directory(path)
    files = ['meta.json', '.complete'] + [name + '.npy' for name in array_names]
    for name in files:
        candidate = os.path.join(path, name)
        if os.path.islink(candidate) or not os.path.isfile(candidate):
            raise Vl3dError('E4005', 'Native cache file is unsafe or missing: %s' % candidate)
        os.chmod(candidate, 0o600)


def _require_dependencies():
    try:
        import ijson
        import numpy
    except ImportError as error:
        raise Vl3dError('E1013', 'Native compiler dependency is missing: %s' % error)
    return ijson, numpy


def _source_open(path):
    if str(path).lower().endswith('.gz'):
        return gzip.open(path, 'rb')
    return open(path, 'rb')


def _valid_bbox(value):
    if not isinstance(value, dict):
        return None
    minimum = value.get('min')
    maximum = value.get('max')
    if not isinstance(minimum, list) or not isinstance(maximum, list):
        return None
    try:
        min_x, min_y = float(minimum[0]), float(minimum[1])
        max_x, max_y = float(maximum[0]), float(maximum[1])
    except (IndexError, TypeError, ValueError):
        return None
    values = (min_x, min_y, max_x, max_y)
    if not all(math.isfinite(item) for item in values):
        return None
    return (min(min_x, max_x), min(min_y, max_y), max(min_x, max_x), max(min_y, max_y))


def _normalized_layer(value):
    return str(value or '').strip().upper()


def _normalized_text(value):
    return str(value or '').strip()


def _parse_metadata(path, ijson):
    from ijson.common import ObjectBuilder

    result = dict((key, []) for key in TARGET_ARRAYS)
    active = None
    active_name = ''
    active_kind = ''
    depth = 0
    with _source_open(path) as handle:
        for prefix, event, value in ijson.parse(handle, use_float=True):
            if active is not None:
                active.event(event, value)
                if event in ('start_map', 'start_array'):
                    depth += 1
                elif event in ('end_map', 'end_array'):
                    depth -= 1
                if depth == 0:
                    if active_kind == 'array':
                        result[active_name].append(active.value)
                    else:
                        result[active_name] = active.value
                    active = None
                    active_name = ''
                    active_kind = ''
                continue

            matched = False
            if event in ('start_map', 'start_array'):
                for name in TARGET_ARRAYS:
                    if prefix == name + '.item':
                        active = ObjectBuilder()
                        active_name = name
                        active_kind = 'array'
                        depth = 1
                        active.event(event, value)
                        matched = True
                        break
                if matched:
                    continue
                for name in TARGET_OBJECTS:
                    if prefix == name:
                        active = ObjectBuilder()
                        active_name = name
                        active_kind = 'object'
                        depth = 1
                        active.event(event, value)
                        matched = True
                        break
                if matched:
                    continue
            if prefix in SCALAR_KEYS and event in ('string', 'number', 'boolean', 'null'):
                result[prefix] = value
    return result


def _semantic(layer):
    kind = _normalized_text(layer.get('kind')).lower()
    semantic = _normalized_text(layer.get('semantic')).lower()
    name = _normalized_layer(layer.get('name'))
    combined = '%s %s' % (kind, semantic)
    if 'contact' in combined or name in ('CONT', 'CONTACT', 'CO', 'CT'):
        return 'contact'
    if 'via' in combined or name.startswith('VIA') or (name.startswith('V') and name[1:].isdigit()):
        return 'via'
    if 'metal' in combined or name.startswith('METAL') or (name.startswith('M') and name[1:].isdigit()):
        return 'metal'
    if 'poly' in combined or name.startswith('POLY'):
        return 'poly'
    if 'active' in combined or 'diff' in combined or name in ('OD', 'AA'):
        return 'active'
    return kind or 'auxiliary'


def _layer_stack(raw_layers):
    layers = []
    registry = load_registry()
    generic = registry['profiles']['generic']
    base = 0.0
    auxiliary_depth = 0.0
    for index, source in enumerate(raw_layers or []):
        layer = dict(source) if isinstance(source, dict) else {'name': str(source)}
        name = _normalized_layer(layer.get('name') or 'LAYER_%d' % index)
        explicit_conductor = (layer.get('routing') is True and
                              _normalized_text(layer.get('kind')).lower() in ('metal', 'poly', 'contact', 'via'))
        try:
            thickness = float(layer.get('thickness', 0.2))
            if not math.isfinite(thickness) or thickness <= 0:
                thickness = 0.2
        except (TypeError, ValueError):
            thickness = 0.2
        inferred = classify_layer(registry, generic, name)
        if inferred.get('routing') and layer.get('routing') is not False and layer.get('kind') in (None, '', 'other', 'unknown', 'auxiliary'):
            for key in ('kind', 'semantic', 'routing', 'defaultVisible', 'metal', 'lowerMetal', 'upperMetal'):
                if key in inferred:
                    layer[key] = inferred[key]
        routing = layer.get('routing') is True
        semantic = _semantic(layer)
        non_conductor = (is_hard_non_conductive_layer_name(name)
                         or (is_non_conductive_layer_name(name) and not explicit_conductor)
                         or semantic in ('active', 'substrate'))
        if non_conductor or (semantic not in ('poly', 'contact', 'metal', 'via') and not inferred.get('routing')):
            layer['routing'] = False
            layer['defaultVisible'] = False
            routing = False
        unresolved_stack = layer.get('stackSource') == 'unresolved'
        auxiliary = unresolved_stack or (not routing and semantic not in ('active', 'poly', 'contact', 'metal', 'via'))
        if unresolved_stack:
            layer['defaultVisible'] = False
        semantic_text = _normalized_text(layer.get('semantic')).lower().replace('_', '-').replace(' ', '-')
        parallel_special_metal = (
            layer.get('nativeParallelStack') is True
            or 'capacitor-top-metal' in semantic_text
        )
        if auxiliary:
            bottom = -(auxiliary_depth + thickness)
            auxiliary_depth += thickness * 0.14
        elif parallel_special_metal:
            bottom = max(0.0, base - thickness)
        else:
            bottom = base
            base += thickness
        explicit_bottom = layer.get('zBottomUm')
        explicit_top = layer.get('zTopUm')
        try:
            if explicit_bottom is not None and explicit_top is not None:
                calibrated_bottom = float(explicit_bottom)
                calibrated_top = float(explicit_top)
                if math.isfinite(calibrated_bottom) and math.isfinite(calibrated_top) and calibrated_top > calibrated_bottom:
                    bottom = calibrated_bottom
                    thickness = calibrated_top - calibrated_bottom
                    if not auxiliary and not parallel_special_metal:
                        base = max(base, calibrated_top)
        except (TypeError, ValueError):
            pass
        layer.update({
            'name': name,
            'index': index,
            'semantic': layer.get('semantic') or semantic,
            'nativeSemantic': semantic,
            'nativeBottomUm': bottom,
            'nativeTopUm': bottom + thickness,
            'thickness': thickness,
            'defaultVisible': bool(layer.get('defaultVisible', not auxiliary)),
            'nativeParallelStack': parallel_special_metal,
        })
        layers.append(layer)

    return layers


def _axis_rectangle(points):
    if not isinstance(points, list) or len(points) not in (4, 5):
        return False
    cleaned = points[:-1] if len(points) == 5 and points[0] == points[-1] else points
    try:
        xs = set(round(float(point[0]), 9) for point in cleaned)
        ys = set(round(float(point[1]), 9) for point in cleaned)
    except (IndexError, TypeError, ValueError):
        return False
    if len(cleaned) != 4 or len(xs) != 2 or len(ys) != 2:
        return False
    # A crossed set of bbox corners is not a rectangle boundary.
    return all((float(a[0]) == float(b[0])) != (float(a[1]) == float(b[1]))
               for a, b in zip(cleaned, cleaned[1:] + cleaned[:1]))


def _legacy_pathseg_bbox(shape):
    """Detect the old OA exporter fallback, whose centerline was lost.

    A pathSeg has two endpoints. Older exports instead put its four bbox
    corners in points. Those corners are a display approximation, never a
    centerline and never precise physical geometry (diagonal segments differ).
    """
    if str(shape.get('type') or shape.get('shapeType') or shape.get('figType') or '').lower() != 'pathseg':
        return False
    points = shape.get('worldPoints') or shape.get('points')
    bbox = _valid_bbox(shape.get('worldBBox') or shape.get('bbox'))
    if bbox is None or not _axis_rectangle(points):
        return False
    return (min(float(p[0]) for p in points), min(float(p[1]) for p in points),
            max(float(p[0]) for p in points), max(float(p[1]) for p in points)) == bbox


def _clean_points(points, closed=True):
    result = []
    for point in points or []:
        try:
            x_value, y_value = float(point[0]), float(point[1])
        except (IndexError, TypeError, ValueError):
            continue
        if math.isfinite(x_value) and math.isfinite(y_value):
            if not result or result[-1] != (x_value, y_value):
                result.append((x_value, y_value))
    if closed and len(result) > 1 and result[0] == result[-1]:
        result.pop()
    return result


def _polygon_area(points):
    # Translate first: large origins must not cancel small routing areas.
    if not points:
        return 0.0
    origin_x, origin_y = points[0]
    return sum(
        (points[index][0] - origin_x) * (points[(index + 1) % len(points)][1] - origin_y)
        - (points[(index + 1) % len(points)][0] - origin_x) * (points[index][1] - origin_y)
        for index in range(len(points))
    ) * 0.5


def _point_in_triangle(point, first, second, third):
    def sign(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
    first_sign = sign(point, first, second)
    second_sign = sign(point, second, third)
    third_sign = sign(point, third, first)
    negative = first_sign < 0 or second_sign < 0 or third_sign < 0
    positive = first_sign > 0 or second_sign > 0 or third_sign > 0
    return not (negative and positive)


def _triangulate(points):
    points = _clean_points(points)
    if len(points) < 3:
        return []
    vertices = list(range(len(points)))
    if _polygon_area(points) < 0:
        vertices.reverse()
    triangles = []
    span = max(max(p[axis] for p in points) - min(p[axis] for p in points) for axis in (0, 1))
    epsilon = max(span * span * 1e-14, 1e-28)
    guard = len(vertices) * len(vertices)
    while len(vertices) > 3 and guard > 0:
        guard -= 1
        clipped = False
        for offset in range(len(vertices)):
            previous = vertices[offset - 1]
            current = vertices[offset]
            following = vertices[(offset + 1) % len(vertices)]
            first, second, third = points[previous], points[current], points[following]
            cross = ((second[0] - first[0]) * (third[1] - second[1])
                     - (second[1] - first[1]) * (third[0] - second[0]))
            if abs(cross) <= epsilon:
                del vertices[offset]
                clipped = True
                break
            if cross < 0:
                continue
            if any(_point_in_triangle(points[item], first, second, third)
                   for item in vertices if item not in (previous, current, following)
                   and points[item] not in (first, second, third)):
                continue
            triangles.extend((first, second, third))
            del vertices[offset]
            clipped = True
            break
        if not clipped:
            break
    if len(vertices) == 3:
        triangles.extend((points[vertices[0]], points[vertices[1]], points[vertices[2]]))
    expected_area = abs(_polygon_area(points))
    actual_area = sum(abs(_polygon_area(triangles[i:i + 3])) for i in range(0, len(triangles), 3))
    if len(vertices) > 3 or expected_area <= epsilon or abs(actual_area - expected_area) > max(expected_area * 1e-8, epsilon):
        # A fan fallback fills concave notches and holes with invented metal.
        raise Vl3dError('E9003', 'Cannot triangulate layout polygon without changing its area')
    return triangles


def _path_footprints(points, width, shape=None):
    """Use the existing GDS geometry engine for continuous mitered routes."""
    try:
        width = float(width)
    except (TypeError, ValueError):
        raise Vl3dError('E9003', 'Layout path has no valid width')
    if not math.isfinite(width) or width <= 0:
        raise Vl3dError('E9003', 'Layout path width must be positive and finite')
    if len(points) < 2:
        return []
    try:
        import gdstk
    except ImportError:
        raise Vl3dError('E1013', 'Path geometry requires the bundled gdstk dependency')
    shape = shape or {}
    style = str(shape.get('pathStyle') or shape.get('endStyle') or 'flush').lower()
    ends = {'truncate': 'flush', 'extend': 'extended', 'variable': 'flush'}.get(style, style)
    if ends not in ('flush', 'extended', 'round'):
        ends = 'flush'
    if shape.get('beginExt') is not None or shape.get('endExt') is not None:
        ends = (float(shape.get('beginExt') or 0), float(shape.get('endExt') or 0))
    path = gdstk.FlexPath(points, width, joins='miter', ends=ends, tolerance=max(width * 0.001, 1e-9))
    # Offset paths can touch their own earlier segments. Normalize the physical
    # mask union first so roundoff at a closed corner cannot become a false gap.
    polygons = gdstk.boolean(path.to_polygons(), [], 'or', precision=max(width * 1e-9, 1e-12))
    return [_clean_points(polygon.points.tolist()) for polygon in polygons]


def _safe_id(table, lookup, value):
    normalized = _normalized_text(value)
    if normalized not in lookup:
        lookup[normalized] = len(table)
        table.append(normalized)
    return lookup[normalized]


def _compile_arrays(path, metadata, layers, ijson, numpy):
    layer_lookup = dict((item['name'], item['index']) for item in layers)
    hierarchy_paths = []
    hierarchy_lookup = {}
    net_keys = []
    net_lookup = {}
    rectangles = []
    rectangle_layers = []
    rectangle_hierarchy = []
    rectangle_nets = []
    rectangle_shape_indices = []
    triangle_vertices = []
    triangle_layers = []
    triangle_hierarchy = []
    outline_vertices = []
    outline_offsets = [0]
    outline_layers = []
    outline_hierarchy = []
    outline_nets = []
    outline_shape_indices = []

    def add_polygon(points, layer_id, hierarchy_id, net_id, bottom, top, shape_index):
        if _polygon_area(points) < 0:
            points = list(reversed(points))
        triangles = _triangulate(points)
        for index in range(0, len(triangles), 3):
            for point in reversed(triangles[index:index + 3]):
                triangle_vertices.append((point[0], point[1], bottom))
                triangle_layers.append(layer_id)
                triangle_hierarchy.append(hierarchy_id)
        for point in triangles:
            triangle_vertices.append((point[0], point[1], top))
            triangle_layers.append(layer_id)
            triangle_hierarchy.append(hierarchy_id)
        for index, first in enumerate(points):
            second = points[(index + 1) % len(points)]
            side = (
                (first[0], first[1], bottom),
                (second[0], second[1], bottom),
                (second[0], second[1], top),
                (first[0], first[1], bottom),
                (second[0], second[1], top),
                (first[0], first[1], top),
            )
            for point in side:
                triangle_vertices.append(point)
                triangle_layers.append(layer_id)
                triangle_hierarchy.append(hierarchy_id)
        for point in points:
            outline_vertices.append((point[0], point[1], top))
        outline_offsets.append(len(outline_vertices))
        outline_layers.append(layer_id)
        outline_hierarchy.append(hierarchy_id)
        outline_nets.append(net_id)
        outline_shape_indices.append(shape_index)

    with _source_open(path) as handle:
        for shape_index, shape in enumerate(ijson.items(handle, 'shapes.item', use_float=True)):
            if not isinstance(shape, dict):
                continue
            purpose = _normalized_text(shape.get('purpose')).lower()
            shape_type = _normalized_text(shape.get('type')).lower()
            if purpose == 'pin' or 'text' in shape_type or 'label' in shape_type or is_non_conductive_purpose(purpose):
                continue
            bbox = _valid_bbox(shape.get('bbox'))
            if not bbox:
                continue
            layer_name = _normalized_layer(shape.get('layer'))
            if layer_name not in layer_lookup:
                index = len(layers)
                bottom = max([item['nativeTopUm'] for item in layers] or [0.0])
                layer = {
                    'name': layer_name or 'UNKNOWN_%d' % index,
                    'index': index,
                    'semantic': 'unknown',
                    'nativeSemantic': 'unknown',
                    'nativeBottomUm': bottom,
                    'nativeTopUm': bottom + 0.2,
                    'thickness': 0.2,
                    'defaultVisible': False,
                    'routing': False,
                    'color': '#8ecae6',
                }
                layers.append(layer)
                layer_lookup[layer['name']] = index
                layer_name = layer['name']
            layer_id = layer_lookup[layer_name]
            layer = layers[layer_id]
            if shape.get('routing') is False and layer.get('nativeSemantic') in ('poly', 'contact', 'metal', 'via'):
                continue
            bottom = float(layer['nativeBottomUm'])
            top = float(layer['nativeTopUm'])
            hierarchy = _normalized_text(shape.get('hierPath'))
            hierarchy_id = _safe_id(hierarchy_paths, hierarchy_lookup, hierarchy)
            net = _normalized_text(shape.get('net'))
            net_id = _safe_id(net_keys, net_lookup, '%s::%s' % (hierarchy, net) if net else '')
            # Preserve old bbox-only previews without expanding the bbox a second time.
            is_path = shape_type in ('path', 'pathseg') and not _legacy_pathseg_bbox(shape)
            points = _clean_points(shape.get('points'), closed=not is_path)
            rectangle_shape = shape_type in ('rect', 'box', 'rectangle')
            if not shape.get('holes') and ((rectangle_shape and not points) or (not is_path and _axis_rectangle(shape.get('points')))):
                rectangles.append((bbox[0], bbox[1], bbox[2], bbox[3], bottom, top))
                rectangle_layers.append(layer_id)
                rectangle_hierarchy.append(hierarchy_id)
                rectangle_nets.append(net_id)
                rectangle_shape_indices.append(shape_index)
                continue
            if not points and not rectangle_shape:
                raise Vl3dError('E9003', 'Layout shape has no polygon boundary: %s' % shape_type)
            if shape.get('holes') and not points:
                points = [(bbox[0], bbox[1]), (bbox[2], bbox[1]), (bbox[2], bbox[3]), (bbox[0], bbox[3])]
            footprints = _path_footprints(points, shape.get('width'), shape) if is_path else [points]
            if not is_path and shape.get('holes'):
                try:
                    import gdstk
                except ImportError:
                    raise Vl3dError('E1013', 'Polygon holes require the bundled gdstk dependency')
                holes = [_clean_points(hole) for hole in shape['holes']]
                footprints = [_clean_points(p.points.tolist()) for p in gdstk.boolean(
                    [points], [hole for hole in holes if len(hole) >= 3], 'not',
                    precision=max(1e-9, 1.0 / max(float(metadata.get('dbuPerMicron') or 1000), 1.0)))]
            for footprint in footprints:
                add_polygon(footprint, layer_id, hierarchy_id, net_id, bottom, top, shape_index)

    order = numpy.argsort(numpy.asarray(rectangle_layers, dtype=numpy.uint16), kind='stable') if rectangles else []
    rects = numpy.asarray(rectangles, dtype=numpy.float32).reshape((-1, 6))
    rect_layers = numpy.asarray(rectangle_layers, dtype=numpy.uint16)
    rect_hierarchy = numpy.asarray(rectangle_hierarchy, dtype=numpy.uint32)
    rect_nets = numpy.asarray(rectangle_nets, dtype=numpy.uint32)
    rect_shape_indices = numpy.asarray(rectangle_shape_indices, dtype=numpy.uint32)
    if len(rectangles):
        rects = rects[order]
        rect_layers = rect_layers[order]
        rect_hierarchy = rect_hierarchy[order]
        rect_nets = rect_nets[order]
        rect_shape_indices = rect_shape_indices[order]

    connector_ids = set(
        int(layer['index']) for layer in layers
        if layer.get('nativeSemantic') in ('via', 'contact'))
    connector_count = int(numpy.count_nonzero(numpy.isin(
        rect_layers, numpy.asarray(sorted(connector_ids), dtype=numpy.uint16)))) if connector_ids else 0
    lod_rect_parts = []
    lod_layer_parts = []
    lod_grid = 4.0
    if connector_count >= 30000:
        for layer_id in sorted(connector_ids):
            layer_rects = rects[rect_layers == layer_id]
            if not len(layer_rects):
                continue
            centers = (layer_rects[:, :2] + layer_rects[:, 2:4]) * 0.5
            keys = numpy.floor(centers / lod_grid).astype(numpy.int64)
            unique_keys, inverse = numpy.unique(keys, axis=0, return_inverse=True)
            aggregate = numpy.empty((len(unique_keys), 6), dtype=numpy.float32)
            aggregate[:, 0:2] = numpy.inf
            aggregate[:, 2:4] = -numpy.inf
            aggregate[:, 4] = layer_rects[0, 4]
            aggregate[:, 5] = layer_rects[0, 5]
            numpy.minimum.at(aggregate[:, 0], inverse, layer_rects[:, 0])
            numpy.minimum.at(aggregate[:, 1], inverse, layer_rects[:, 1])
            numpy.maximum.at(aggregate[:, 2], inverse, layer_rects[:, 2])
            numpy.maximum.at(aggregate[:, 3], inverse, layer_rects[:, 3])
            lod_rect_parts.append(aggregate)
            lod_layer_parts.append(numpy.full(len(aggregate), layer_id, dtype=numpy.uint16))
    lod_rects = numpy.concatenate(lod_rect_parts) if lod_rect_parts else numpy.empty((0, 6), dtype=numpy.float32)
    lod_layers = numpy.concatenate(lod_layer_parts) if lod_layer_parts else numpy.empty((0,), dtype=numpy.uint16)

    instances = []
    instance_hierarchy = []
    for instance in metadata.get('instances') or []:
        bbox = _valid_bbox(instance.get('bbox'))
        if not bbox:
            continue
        hierarchy_id = _safe_id(
            hierarchy_paths, hierarchy_lookup,
            instance.get('hierPath') or instance.get('path'))
        instances.append(bbox)
        instance_hierarchy.append(hierarchy_id)

    triangle_vertices_array = numpy.asarray(triangle_vertices, dtype=numpy.float32).reshape((-1, 3))
    triangle_layers_array = numpy.asarray(triangle_layers, dtype=numpy.uint16)
    triangle_hierarchy_array = numpy.asarray(triangle_hierarchy, dtype=numpy.uint32)
    if len(triangle_vertices_array):
        triangle_order = numpy.argsort(triangle_layers_array[::3], kind='stable')
        vertex_order = (triangle_order[:, None] * 3 + numpy.arange(3)[None, :]).reshape(-1)
        triangle_vertices_array = triangle_vertices_array[vertex_order]
        triangle_layers_array = triangle_layers_array[vertex_order]
        triangle_hierarchy_array = triangle_hierarchy_array[vertex_order]

    arrays = {
        'rects': rects,
        'rect_layers': rect_layers,
        'rect_hierarchy': rect_hierarchy,
        'rect_nets': rect_nets,
        'rect_shape_indices': rect_shape_indices,
        'triangle_vertices': triangle_vertices_array,
        'triangle_layers': triangle_layers_array,
        'triangle_hierarchy': triangle_hierarchy_array,
        'outline_vertices': numpy.asarray(outline_vertices, dtype=numpy.float32).reshape((-1, 3)),
        'outline_offsets': numpy.asarray(outline_offsets, dtype=numpy.uint64),
        'outline_layers': numpy.asarray(outline_layers, dtype=numpy.uint16),
        'outline_hierarchy': numpy.asarray(outline_hierarchy, dtype=numpy.uint32),
        'outline_nets': numpy.asarray(outline_nets, dtype=numpy.uint32),
        'outline_shape_indices': numpy.asarray(outline_shape_indices, dtype=numpy.uint32),
        'instances': numpy.asarray(instances, dtype=numpy.float32).reshape((-1, 4)),
        'instance_hierarchy': numpy.asarray(instance_hierarchy, dtype=numpy.uint32),
        'lod_rects': lod_rects,
        'lod_layers': lod_layers,
    }
    lod_metadata = {
        'available': bool(len(lod_rects)),
        'gridUm': lod_grid if len(lod_rects) else 0.0,
        'sourceConnectorCount': connector_count,
        'aggregatedConnectorCount': len(lod_rects),
    }
    return arrays, hierarchy_paths, net_keys, lod_metadata


def compile_layout(source, target, fingerprint):
    ijson, numpy = _require_dependencies()
    source = os.path.realpath(source)
    if not os.path.isfile(source):
        raise Vl3dError('E6001', 'Layout JSON does not exist: %s' % source)
    before = os.stat(source)
    source_hasher = hashlib.sha256()
    with open(source, 'rb') as source_handle:
        for source_chunk in iter(lambda: source_handle.read(1024 * 1024), b''):
            source_hasher.update(source_chunk)
    source_digest = source_hasher.hexdigest()
    metadata = _parse_metadata(source, ijson)
    try:
        validate_viewer_units(metadata)
    except ValueError as error:
        raise Vl3dError('E4003', str(error))
    if not metadata.get('cell'):
        raise Vl3dError('E9003', 'Unsupported layout JSON: missing cell')
    if int(metadata.get('schemaVersion') or 0) < 1:
        raise Vl3dError('E9003', 'Unsupported layout JSON schema')
    layers = _layer_stack(metadata.get('layers') or [])
    arrays, hierarchy_paths, net_keys, lod_metadata = _compile_arrays(source, metadata, layers, ijson, numpy)
    after = os.stat(source)
    if before.st_size != after.st_size or before.st_mtime != after.st_mtime:
        raise Vl3dError('E6008', 'Layout source changed while it was being compiled')

    parent = os.path.dirname(target)
    _secure_directory(parent, create=True)
    if os.path.lexists(target) and (os.path.islink(target) or not os.path.isdir(target)):
        raise Vl3dError('E4005', 'Native cache target is unsafe: %s' % target)
    temporary = tempfile.mkdtemp(
        prefix='.compile-%s-%d-' % (fingerprint, os.getpid()), dir=parent)
    os.chmod(temporary, 0o700)
    try:
        for name, array in arrays.items():
            array_path = os.path.join(temporary, name + '.npy')
            numpy.save(array_path, array, allow_pickle=False)
            os.chmod(array_path, 0o600)
        public_metadata = dict(metadata)
        public_metadata.update({
            'cacheAbi': 1,
            'compilerVersion': COMPILER_VERSION,
            'fingerprint': fingerprint,
            'source': source,
            'sourceDigest': source_digest,
            'sourceBytes': before.st_size,
            'compiledAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'layers': layers,
            'hierarchyPaths': hierarchy_paths,
            'netKeys': net_keys,
            'viaLod': lod_metadata,
            'arrays': dict((name, list(array.shape)) for name, array in arrays.items()),
        })
        with open(os.path.join(temporary, 'meta.json'), 'w') as handle:
            json.dump(public_metadata, handle, separators=(',', ':'), sort_keys=True)
            handle.write('\n')
        os.chmod(os.path.join(temporary, 'meta.json'), 0o600)
        with open(os.path.join(temporary, '.complete'), 'w') as handle:
            handle.write(fingerprint + '\n')
        os.chmod(os.path.join(temporary, '.complete'), 0o600)
        _secure_publish_tree(temporary, arrays)
        if os.path.isdir(target):
            marker = os.path.join(target, '.complete')
            valid = False
            try:
                with open(marker, 'r') as handle:
                    valid = handle.readline().strip() == fingerprint
                valid = valid and os.path.isfile(os.path.join(target, 'meta.json'))
                valid = valid and all(os.path.isfile(os.path.join(target, name + '.npy')) for name in arrays)
            except IOError:
                valid = False
            if valid:
                _secure_publish_tree(target, arrays)
                shutil.rmtree(temporary)
                temporary = ''
                return target
            shutil.rmtree(target)
        try:
            os.rename(temporary, target)
        except OSError:
            _secure_directory(target)
            marker = os.path.join(target, '.complete')
            with open(marker, 'r') as handle:
                if handle.readline().strip() != fingerprint:
                    raise
            if not all(os.path.isfile(os.path.join(target, name + '.npy')) for name in arrays):
                raise
            _secure_publish_tree(target, arrays)
            shutil.rmtree(temporary)
        temporary = ''
        _secure_publish_tree(target, arrays)
        return target
    finally:
        if temporary and os.path.isdir(temporary):
            shutil.rmtree(temporary)
