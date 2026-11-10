#!/usr/bin/env python3
"""Conservative electrical rules for the geometry tracer (Python 3.6+).

Layer names identify declared endpoints; they never imply adjacency. In
particular, metal numbers, visual Z coordinates and capacitor plate indices
are not electrical equivalence classes. Device interiors can be opaque while
remaining visible in the 3D viewer.
"""
from __future__ import print_function

try:
    from .pdk_profile import is_non_conductive_layer_name, is_non_conductive_purpose
except ImportError:
    from pdk_profile import is_non_conductive_layer_name, is_non_conductive_purpose

RULES_VERSION = 1
CONDUCTOR_KINDS = frozenset(('metal', 'poly'))
CONNECTOR_KINDS = frozenset(('via', 'contact'))
OPAQUE_DEVICE_KINDS = frozenset(('resistor', 'inductor', 'capacitor', 'mos', 'bipolar', 'diode', 'unknown-device'))
KNOWN_DEVICE_KINDS = frozenset(('module', 'geometry', 'mos', 'bipolar', 'diode',
                               'capacitor', 'resistor', 'inductor', 'unknown-device'))


def _name(value):
    return str(value or '').strip()


def _kind(layer):
    return _name(layer.get('kind')).lower()


def _string_names(value):
    if isinstance(value, str):
        return [value] if value.strip() else []
    if isinstance(value, (tuple, list)):
        return [item.strip() for item in value if isinstance(item, str) and item.strip()]
    return []


def _warning(code, message, **details):
    result = {'code': code, 'severity': 'warning', 'message': message}
    result.update(details)
    return result


def connector_rules(metadata):
    """Return named lower/upper endpoints from a layer list or layout object.

    Call build_trace_rules for completeness diagnostics. Contacts terminate at
    active/well regions; only retained conductive endpoints participate.
    """
    return build_trace_rules(metadata if isinstance(metadata, dict) else {
        'layers': metadata, 'deviceScopes': {}, 'deviceMetadataComplete': True,
    })['connectors']


def build_trace_rules(metadata):
    metadata = metadata if isinstance(metadata, dict) else {}
    layers = metadata.get('layers', [])
    layers = layers if isinstance(layers, list) else []
    conductors = {}
    cuts = {}
    warnings = []
    complete = True
    by_name = {}
    folded = {}
    for layer in layers:
        if not isinstance(layer, dict):
            continue
        name = _name(layer.get('name'))
        if not name:
            continue
        kind = _kind(layer)
        explicit = kind in CONDUCTOR_KINDS | CONNECTOR_KINDS and layer.get('routing') is True
        if (not explicit or is_non_conductive_layer_name(name, explicit_conductor=explicit)
                or is_non_conductive_purpose(layer.get('purpose'))):
            continue
        if name.upper() in folded:
            complete = False
            warnings.append(_warning('trace-layer-ambiguous',
                                     'Duplicate layer identities cannot define an electrical connection', layer=name))
            continue
        folded[name.upper()] = name
        by_name[name] = layer
        if kind in CONDUCTOR_KINDS:
            conductors[name] = kind
        else:
            cuts[name] = kind

    def endpoints(layer, side):
        declared = _string_names(layer.get(side + 'Layer')) + _string_names(layer.get(side + 'Layers'))
        found = []
        blocked = []
        missing = []
        for name in sorted(set(declared)):
            actual = folded.get(name.upper())
            if actual in conductors:
                if actual not in found:
                    found.append(actual)
            elif is_non_conductive_layer_name(name):
                blocked.append(name)
            else:
                missing.append(name)
        return sorted(found), sorted(set(blocked)), sorted(set(missing)), bool(declared)

    connectors = {}
    for name in sorted(cuts):
        layer = by_name[name]
        lower, lower_blocked, lower_missing, has_lower = endpoints(layer, 'lower')
        upper, upper_blocked, upper_missing, has_upper = endpoints(layer, 'upper')
        source = _name(layer.get('connectivitySource')) or 'explicit-layer-endpoints'
        if source == 'name-inference':
            complete = False
            warnings.append(_warning('trace-connector-unconfirmed',
                                     'A connector inferred only from its name is not used; provide explicit endpoints', layer=name))
            continue
        if not has_lower or not has_upper or not upper or (not lower and not lower_blocked):
            complete = False
            warnings.append(_warning('trace-connector-endpoints-missing',
                                     'Connector endpoints are missing or unavailable; no Z-based connection was invented',
                                     layer=name, lowerLayers=lower, upperLayers=upper))
            continue
        if set(lower).intersection(upper):
            complete = False
            warnings.append(_warning('trace-connector-invalid',
                                     'A connector must have distinct lower and upper conductor layers', layer=name))
            continue
        if lower_missing or upper_missing:
            complete = False
            warnings.append(_warning('trace-connector-partial',
                                     'Some declared connector endpoints are absent from the imported layer set',
                                     layer=name, missingLayers=sorted(set(lower_missing + upper_missing))))
        connectors[name] = {
            'kind': cuts[name], 'lowerLayers': lower, 'upperLayers': upper,
            'source': source, 'deviceBoundaryLayers': sorted(set(lower_blocked + upper_blocked)),
        }

    raw_scopes = metadata.get('deviceScopes', {})
    if isinstance(raw_scopes, list):
        raw_scopes = dict((item.get('hierPath', ''), item) for item in raw_scopes if isinstance(item, dict))
    raw_scopes = raw_scopes if isinstance(raw_scopes, dict) else {}
    device_scopes = {}
    for path, info in raw_scopes.items():
        if not isinstance(info, dict) or not _name(path):
            continue
        kind = _name(info.get('kind')).lower()
        if kind not in KNOWN_DEVICE_KINDS:
            kind = 'unknown-device'
        record = dict(info)
        record['kind'] = kind
        record['opaque'] = kind in OPAQUE_DEVICE_KINDS
        device_scopes[path] = record
        if kind == 'unknown-device':
            complete = False
            warnings.append(_warning('trace-device-boundary-unconfirmed',
                                     'An unclassified device interior is excluded to avoid joining different terminals',
                                     hierPath=path))
    if metadata.get('deviceMetadataComplete') is not True:
        complete = False
        warnings.append(_warning('trace-device-metadata-missing',
                                 'Device-boundary metadata is incomplete; geometric connectivity is not a complete circuit extraction'))
    if metadata.get('deviceBoundaryComplete') is False:
        complete = False
        warnings.append(_warning('trace-stop-layer-semantics-unconfirmed',
                                 'Device categories are known, but PDK derived stop-layer semantics are not fully declared'))
    return {
        'schemaVersion': RULES_VERSION,
        'conductors': conductors, 'connectors': connectors,
        'deviceScopes': device_scopes, 'excludedShapeIndices': [],
        'complete': complete, 'warnings': warnings,
        'domain': 'declared-metal-poly-contact-via',
    }


def is_shape_allowed(shape, rules):
    """Respect purpose and declared opaque device scopes, including descendants."""
    if not isinstance(shape, dict):
        return False
    if shape.get('routing') is False or is_non_conductive_purpose(shape.get('purpose')):
        return False
    if shape.get('traceRole') in ('device-body', 'barrier', 'excluded'):
        return False
    path = _name(shape.get('hierPath'))
    scopes = rules.get('deviceScopes', {})
    # An opaque ancestor dominates a geometry-only child of that device.
    while path:
        if scopes.get(path, {}).get('opaque'):
            if not (shape.get('traceRole') == 'terminal' and path == _name(shape.get('hierPath'))
                    and scopes[path].get('kind') != 'unknown-device'):
                return False
        path = path.rsplit('/', 1)[0] if '/' in path else ''
    return True


def source_device_scopes(cell, instances, source_views):
    """Join evidence by exact OA identity, never by device/master name patterns."""
    def key(info):
        return tuple(info.get(field, '') for field in ('library', 'cell', 'view'))
    sources = dict((key(info), info) for info in source_views)
    occurrences = [(cell.get('cell', ''), cell)] + [(i.get('hierPath', ''), i.get('master', {})) for i in instances]
    scopes = {}
    complete = bool(sources)
    for path, identity in occurrences:
        info = sources.get(key(identity), {})
        kind = info.get('deviceKind', 'unknown-device')
        if kind not in KNOWN_DEVICE_KINDS:
            kind = 'unknown-device'
        complete = complete and kind != 'unknown-device' and bool(info.get('deviceSource'))
        scopes[path] = {'kind': kind, 'source': info.get('deviceSource', 'missing-source-metadata'),
                        'master': dict(identity), 'isPCell': info.get('isPCell'),
                        'terminalCount': info.get('terminalCount')}
    return scopes, bool(complete)


def apply_connectivity_metadata(layers, via_definitions, profile):
    """Apply actual OA endpoints; refuse ambiguous shared cut-layer topologies.

    Profile declarations are used only by exact layer name. Generic numeric or
    display-stack inferences remain marked unconfirmed.
    """
    declared_conductors = set(layer.get('name', '').upper() for layer in layers
                              if layer.get('kind') in CONDUCTOR_KINDS and layer.get('routing') is True)
    declarations = {}
    for info in profile.get('streamLayers', {}).values():
        if isinstance(info, dict) and info.get('name'):
            declarations.setdefault(info['name'].upper(), []).append(info)
    grouped = {}
    for info in via_definitions:
        grouped.setdefault(info['cutLayer'].upper(), []).append(info)
    for layer in layers:
        if layer.get('kind') not in CONNECTOR_KINDS:
            continue
        name = layer['name'].upper()
        layer.setdefault('connectivitySource', 'name-inference')
        records = grouped.get(name, [])
        if records:
            pairs = set((r['lowerLayer'], r['upperLayer']) for r in records)
            lower = sorted(set(p[0] for p in pairs))
            upper = sorted(set(p[1] for p in pairs))
            # A contact may touch poly OR active; active is a terminal boundary.
            retained_lower = [n for n in lower if n.upper() in declared_conductors or not is_non_conductive_layer_name(n)]
            valid = len(upper) == 1 and (len(retained_lower) <= 1 or len(pairs) == 1)
            for key in ('lowerLayer', 'upperLayer', 'lowerLayers', 'upperLayers'):
                layer.pop(key, None)
            layer['connectivitySource'] = 'oa-via-definition' if valid else 'ambiguous-via-definitions'
            layer['viaDefinitions'] = list(records)
            if valid:
                layer['lowerLayers'] = lower
                layer['upperLayers'] = upper
                layer['lowerLayer'] = lower[0] if len(lower) == 1 else None
                layer['upperLayer'] = upper[0] if len(upper) == 1 else None
            continue
        candidates = []
        for info in declarations.get(name, []):
            lower = _string_names(info.get('lowerLayer')) + _string_names(info.get('lowerLayers'))
            upper = _string_names(info.get('upperLayer')) + _string_names(info.get('upperLayers'))
            if lower and upper:
                candidates.append((tuple(sorted(set(lower))), tuple(sorted(set(upper)))))
        candidates = set(candidates)
        if len(candidates) == 1:
            lower, upper = next(iter(candidates))
            layer['lowerLayer'] = lower[0] if len(lower) == 1 else None
            layer['upperLayer'] = upper[0] if len(upper) == 1 else None
            layer['lowerLayers'] = list(lower)
            layer['upperLayers'] = list(upper)
            layer['connectivitySource'] = 'profile-declaration:' + str(profile.get('id', 'custom'))
        elif len(candidates) > 1:
            for key in ('lowerLayer', 'upperLayer', 'lowerLayers', 'upperLayers'):
                layer.pop(key, None)
            layer['connectivitySource'] = 'ambiguous-profile-declarations'
    return layers
