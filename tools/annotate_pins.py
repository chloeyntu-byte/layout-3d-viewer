#!/usr/bin/env python3
"""Validate explicit world-coordinate pin figures and append them to layout JSON.

No geometry, net names or device extraction rules are inferred or modified.
Python 3.6+, standard library only. Output is always a new, exclusive file.
"""
from __future__ import print_function
import argparse
import gzip
import hashlib
import json
import math
import os
import re
import stat
import sys
import tempfile

try:
    from .layout_units import validate_viewer_units
except ImportError:
    from layout_units import validate_viewer_units

MAX_SOURCE_BYTES = 384 * 1024 * 1024
MAX_SIDECAR_BYTES = 4 * 1024 * 1024
MAX_PIN_FIGURES = 10000
MAX_PIN_VERTICES = 1024
IDENTITY_FIELDS = ('library', 'cell', 'view')
PIN_FIELDS = frozenset(('id', 'hierPath', 'terminal', 'name', 'net', 'direction',
                        'layer', 'purpose', 'points', 'worldBBox', 'ownerCell'))


class AnnotationError(ValueError):
    pass


def _fail(message):
    raise AnnotationError(message)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _fail('Duplicate JSON field: ' + key)
        result[key] = value
    return result


def _invalid_constant(value):
    _fail('Non-finite JSON number: ' + value)


def read_json(path, limit):
    canonical = os.path.realpath(path)
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
    descriptor = os.open(canonical, flags)
    with os.fdopen(descriptor, 'rb') as handle:
        before = os.fstat(handle.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
            _fail('Input must be a regular file within the size limit: ' + str(path))
        raw = handle.read(limit + 1)
        after = os.fstat(handle.fileno())
    if len(raw) > limit or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        _fail('Input changed during read or exceeds the size limit: ' + str(path))
    content = raw
    if canonical.lower().endswith('.gz'):
        import io
        with gzip.GzipFile(fileobj=io.BytesIO(raw)) as compressed:
            content = compressed.read(limit + 1)
        if len(content) > limit:
            _fail('Expanded JSON exceeds the size limit')
    try:
        data = json.loads(content.decode('utf-8'), object_pairs_hook=_unique_object,
                          parse_constant=_invalid_constant)
    except (ValueError, UnicodeError) as error:
        _fail('Invalid JSON: ' + str(error))
    return data, {'sha256': hashlib.sha256(raw).hexdigest(), 'mtimeNs': str(before.st_mtime_ns),
                  'sizeBytes': before.st_size}


def _text(value, field, allow_empty=False):
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        _fail(field + ' must be a non-empty string')
    if any(ord(char) < 32 for char in value) or len(value) > 4096:
        _fail(field + ' contains controls or exceeds 4096 characters')
    return value


def source_description(layout):
    if not isinstance(layout, dict) or layout.get('schemaVersion') != 2:
        _fail('Source must be a VL3D schemaVersion 2 layout JSON')
    identity = {field: _text(layout.get(field), 'source.' + field) for field in IDENTITY_FIELDS}
    for field in ('shapes', 'layers', 'instances', 'pins', 'connections'):
        if not isinstance(layout.get(field), list):
            _fail('Source ' + field + ' must be an array')
    units = _text(layout.get('units'), 'source.units')
    try:
        validate_viewer_units(layout)
    except ValueError as error:
        _fail(str(error))
    # Bind physical geometry and occurrence identities, not importer timestamps,
    # display palettes, diagnostics, IDs, names of nets or existing pin annotations.
    shape_fields = ('type','layer','hierPath','points','holes','bbox','worldBBox','width',
                    'transform','localToWorld','pathStyle','beginStyle','endStyle','beginExt','endExt')
    instance_fields = ('hierPath','parentPath','master','bbox','transform')
    def geometry_fields(item, fields):
        if not isinstance(item, dict):
            _fail('Source geometry records must be objects')
        return {key:item[key] for key in fields if key in item and item[key] not in (None, [], '')
                and not (key in ('width','beginExt','endExt') and item[key] == 0)}
    geometry = dict(identity, units=units, dbuPerMicron=layout.get('dbuPerMicron'),
                    shapes=[geometry_fields(item,shape_fields) for item in layout['shapes']],
                    instances=[geometry_fields(item,instance_fields) for item in layout['instances']],
                    layerNames=sorted(item.get('name','') for item in layout['layers'] if isinstance(item,dict)))
    encoded = json.dumps(geometry, sort_keys=True, separators=(',', ':'),
                         ensure_ascii=False, allow_nan=False).encode('utf-8')
    identity['geometryDigest'] = hashlib.sha256(encoded).hexdigest()
    paths = {identity['cell']}
    owners = {identity['cell']: identity['cell']}
    for item in layout['instances']:
        if isinstance(item, dict) and item.get('hierPath'):
            paths.add(item['hierPath'])
            owners[item['hierPath']] = (item.get('master') or {}).get('cell', '')
    for item in layout['shapes'] + layout['pins']:
        if isinstance(item, dict) and item.get('hierPath'):
            paths.add(item['hierPath'])
            owners.setdefault(item['hierPath'], item.get('ownerCell', ''))
    layers = {item.get('name') for item in layout['layers'] if isinstance(item, dict) and item.get('name')}
    return {'schemaVersion': 1, 'source': identity, 'units': units, 'pins': [],
            'availableHierarchyPaths': sorted(paths), 'availableLayers': sorted(layers),
            'existingPinFigures': len(layout['pins'])}, owners


def _number(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        _fail(label + ' must be a finite number')
    return value


def _point(value, label):
    if not isinstance(value, list) or len(value) != 2:
        _fail(label + ' must contain exactly [x, y]')
    return [_number(v, label) for v in value]


def _cross(a, b, c):
    return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])


def _segments_meet(a, b, c, d):
    def on(p, q, r):
        return _cross(p, q, r) == 0 and min(p[0],q[0]) <= r[0] <= max(p[0],q[0]) and min(p[1],q[1]) <= r[1] <= max(p[1],q[1])
    first, second, third, fourth = _cross(a,b,c), _cross(a,b,d), _cross(c,d,a), _cross(c,d,b)
    return (first*second < 0 and third*fourth < 0) or on(a,b,c) or on(a,b,d) or on(c,d,a) or on(c,d,b)


def validate_geometry(pin, label, budget=None):
    points = pin.get('points')
    bbox = pin.get('worldBBox')
    if points is not None:
        if not isinstance(points, list) or not 3 <= len(points) <= MAX_PIN_VERTICES:
            _fail(label + '.points must have 3-%d vertices' % MAX_PIN_VERTICES)
        for point in points:
            _point(point, label + '.points')
        ring = points[:-1] if points[0] == points[-1] else points
        if len(ring) < 3 or any(ring[i] == ring[(i+1) % len(ring)] for i in range(len(ring))):
            _fail(label + ' has duplicate adjacent polygon vertices')
        if sum(_cross([0, 0], ring[i], ring[(i+1) % len(ring)]) for i in range(len(ring))) == 0:
            _fail(label + ' polygon has zero area')
        for i in range(len(ring)):
            for j in range(i+1, len(ring)):
                if j == i+1 or (i == 0 and j == len(ring)-1):
                    continue
                if budget is not None:
                    budget[0] += 1
                    if budget[0] > 2000000:
                        _fail('Pin polygons exceed the bounded validation work limit; use simpler figures')
                if _segments_meet(ring[i], ring[(i+1)%len(ring)], ring[j], ring[(j+1)%len(ring)]):
                    _fail(label + ' polygon self-intersects; supply a simple world-coordinate polygon')
        expected = {'min': [min(p[0] for p in points), min(p[1] for p in points)],
                    'max': [max(p[0] for p in points), max(p[1] for p in points)]}
    else:
        expected = None
    if bbox is not None:
        if not isinstance(bbox, dict) or set(bbox) != {'min', 'max'}:
            _fail(label + '.worldBBox must contain min and max points')
        low, high = _point(bbox['min'], label+'.worldBBox.min'), _point(bbox['max'], label+'.worldBBox.max')
        if not all(low[i] < high[i] for i in (0, 1)):
            _fail(label + '.worldBBox must have positive width and height')
        if expected and bbox != expected:
            _fail(label + '.worldBBox differs from the polygon bounds; coordinates were not changed')
    elif expected:
        pin['worldBBox'] = expected
    else:
        _fail(label + ' needs explicit points or worldBBox; pin geometry is never guessed')
    if points is None:
        low, high = pin['worldBBox']['min'], pin['worldBBox']['max']
        pin['points'] = [list(low), [high[0],low[1]], list(high), [low[0],high[1]]]


def annotate(layout, sidecar, sidecar_info=None):
    description, owners = source_description(layout)
    if not isinstance(sidecar, dict) or sidecar.get('schemaVersion') != 1:
        _fail('Pin sidecar schemaVersion must be 1')
    allowed = {'schemaVersion','source','units','pins','availableHierarchyPaths','availableLayers','existingPinFigures'}
    unknown = set(sidecar)-allowed
    if unknown:
        _fail('Unsupported sidecar fields: ' + ', '.join(sorted(unknown)))
    if sidecar.get('source') != description['source']:
        _fail('Source identity/geometryDigest differs. Inspect this exact imported layout again; no pins were added')
    if sidecar.get('units') != description['units']:
        _fail('Pin units must exactly match source units; no coordinate conversion is performed')
    pins = sidecar.get('pins')
    if not isinstance(pins, list) or not 1 <= len(pins) <= MAX_PIN_FIGURES:
        _fail('pins must contain 1-%d explicit pin figures' % MAX_PIN_FIGURES)
    paths, layers = set(description['availableHierarchyPaths']), set(description['availableLayers'])
    existing_ids = {item.get('id') for item in layout['pins'] if isinstance(item,dict) and isinstance(item.get('id'),(int,str))}
    next_id = max([value for value in existing_ids if isinstance(value,int)] or [-1])+1
    additions, seen, budget = [], set(), [0]
    for existing in layout['pins']:
        if not isinstance(existing,dict):
            continue
        points=existing.get('points')
        bbox=existing.get('worldBBox')
        if not points and isinstance(bbox,dict) and set(bbox)=={'min','max'}:
            low,high=bbox['min'],bbox['max']
            points=[list(low),[high[0],low[1]],list(high),[low[0],high[1]]]
        if points:
            seen.add(json.dumps([existing.get('hierPath'),existing.get('terminal'),
                                 existing.get('name',existing.get('terminal')),existing.get('layer'),points],
                                separators=(',',':'),ensure_ascii=False))
    for index, raw in enumerate(pins):
        label = 'pins[%d]' % index
        if not isinstance(raw,dict) or set(raw)-PIN_FIELDS:
            _fail(label + ' contains unsupported fields')
        pin = dict(raw)
        for field in ('hierPath','terminal','layer'):
            _text(pin.get(field), label+'.'+field)
        if pin['hierPath'] not in paths:
            _fail(label + '.hierPath is absent from this layout: ' + pin['hierPath'])
        if pin['layer'] not in layers:
            _fail(label + '.layer is absent from this layout: ' + pin['layer'])
        for field in ('name','net','direction','purpose','ownerCell'):
            if field in pin:
                _text(pin[field],label+'.'+field,allow_empty=field=='net')
        pin.setdefault('name',pin['terminal'])
        pin.setdefault('net','')
        pin.setdefault('direction','inputOutput')
        pin.setdefault('purpose','pin')
        pin.setdefault('ownerCell',owners.get(pin['hierPath'],'') or pin['hierPath'].rsplit('/',1)[-1])
        validate_geometry(pin,label,budget)
        key=json.dumps([pin['hierPath'],pin['terminal'],pin['name'],pin['layer'],pin['points']],separators=(',',':'),ensure_ascii=False)
        if key in seen:
            _fail(label + ' repeats an existing or duplicate pin figure; it was not appended again')
        seen.add(key)
        if 'id' in pin:
            if isinstance(pin['id'],bool) or not isinstance(pin['id'],(int,str)) or pin['id'] in existing_ids:
                _fail(label + '.id must be unique across existing and new pin figures')
        else:
            while next_id in existing_ids:next_id+=1
            pin['id']=next_id;next_id+=1
        existing_ids.add(pin['id']);additions.append(pin)
    result=dict(layout)
    result['pins']=list(layout['pins'])+additions
    result['pinCount']=len(result['pins'])
    result['pinAnnotations']={'schemaVersion':1,'source':description['source'],
                              'units':description['units'],'addedPinFigures':len(additions)}
    if sidecar_info:result['pinAnnotations'].update(sidecar_info)
    return result


def write_new_json(path, data):
    target=os.path.abspath(path)
    if not target.lower().endswith('.json'):
        _fail('Output must be a new .json file')
    if os.path.lexists(target):
        _fail('Output already exists; choose a new filename. Source and existing outputs are never overwritten')
    descriptor,temporary=tempfile.mkstemp(prefix='.vl3d-pins-',dir=os.path.dirname(target))
    try:
        with os.fdopen(descriptor,'w',encoding='utf-8') as handle:
            json.dump(data,handle,ensure_ascii=False,allow_nan=False,separators=(',',':'))
            handle.write('\n');handle.flush();os.fsync(handle.fileno())
        os.link(temporary,target)  # Atomic no-clobber publication, including races/symlinks.
    finally:
        os.unlink(temporary)


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source',help='Imported VL3D JSON or JSON.gz (read-only)')
    parser.add_argument('--inspect',action='store_true',help='Print sidecar template plus exact source identity, paths and layers')
    parser.add_argument('--annotations',help='Explicit schema-1 pin sidecar JSON')
    parser.add_argument('--output',help='New annotated .json file; existing files are never overwritten')
    args=parser.parse_args(argv)
    try:
        layout,_=read_json(args.source,MAX_SOURCE_BYTES)
        if args.inspect:
            if args.annotations or args.output:_fail('--inspect cannot be combined with annotation/output options')
            print(json.dumps(source_description(layout)[0],ensure_ascii=False,indent=2));return 0
        if not args.annotations or not args.output:_fail('--annotations and --output are required unless using --inspect')
        sidecar,info=read_json(args.annotations,MAX_SIDECAR_BYTES)
        result=annotate(layout,sidecar,info)
        write_new_json(args.output,result)
        print(json.dumps({'output':os.path.abspath(args.output),'addedPinFigures':result['pinAnnotations']['addedPinFigures'],'pinCount':result['pinCount']}));return 0
    except (AnnotationError,ValueError,OSError,TypeError,RecursionError) as error:
        print('VL3D_PIN_ANNOTATION_ERROR '+json.dumps({'code':'E6009','message':str(error)}),file=sys.stderr);return 2


if __name__=='__main__':sys.exit(main())
