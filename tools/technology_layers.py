"""Local OA material evidence and approximate display ordering (Python 3.6).

VIA endpoints remain the sole input to electrical connector declarations. The
ordering here is a visualization aid, never a measured thickness or a net rule.
"""
from pdk_profile import classify_layer, metal_number_from_name


def scoped_via_definitions(records, technology):
    identities = set(r.get('technologyLibrary') for r in records if r.get('technologyLibrary'))
    if not technology:
        return list(records) if len(identities) <= 1 else []
    return [r for r in records if r.get('technologyLibrary') == technology or
            (not r.get('technologyLibrary') and not (identities - {technology}))]


def technology_layer_context(records, via_definitions, registry, profile, technology):
    layers, diagnostics = {}, []
    technologies = set(r.get('technologyLibrary') for r in records if r.get('technologyLibrary'))
    foreign = technologies - {technology} if technology else (technologies if len(technologies) > 1 else set())
    foreign_names = set(str(r.get('name') or '').strip().upper() for r in records
                        if r.get('technologyLibrary') in foreign)
    if foreign:
        diagnostics.append({'code': 'E5010', 'severity': 'warning',
                            'message': 'Multiple source technologies: conflicting layer identities stay hidden'})
    materials = {}
    for record in records:
        name = str(record.get('name') or '').strip().upper()
        material = str(record.get('material') or 'unknown').strip().lower()
        if name:
            materials.setdefault(name, set()).add(material)
    for name, values in materials.items():
        known = values - {'unknown', ''}
        if len(known) > 1 or name in foreign_names:
            layers[name] = {'material': 'conflict', 'source': 'oa-tech-conflict'}
            diagnostics.append({'code': 'E5010', 'severity': 'warning', 'layers': [name],
                                'message': 'Conflicting OA materials; layer is hidden'})
        else:
            layers[name] = {'material': next(iter(known)) if known else 'unknown',
                            'source': 'oa-tech-layer'}

    via_definitions = scoped_via_definitions(via_definitions, technology)
    names = set(layers)
    for record in via_definitions:
        names.update(str(record.get(key) or '').upper()
                     for key in ('cutLayer', 'lowerLayer', 'upperLayer'))
    classes = dict((name, classify_layer(registry, profile, name,
                       technology_layer=layers.get(name))) for name in names if name)
    positions = {}
    for name, info in classes.items():
        if info.get('routing') is not True:
            continue
        if info.get('kind') == 'poly':
            positions[name] = float(info.get('stackIndex', 1))
        elif info.get('kind') == 'metal':
            number = metal_number_from_name(name)
            if info.get('stackIndex') is not None and 0 <= float(info['stackIndex']) < 1000:
                # Preserve explicit profile spacing, including capacitor plates.
                positions[name] = float(info['stackIndex'])
            elif number is not None:
                positions[name] = 2.0 * number + 1.0

    pairs, predecessors = {}, {}
    for record in via_definitions:
        cut, lower, upper = [str(record.get(key) or '').upper()
                             for key in ('cutLayer', 'lowerLayer', 'upperLayer')]
        if not all((cut, lower, upper)):
            continue
        pairs.setdefault(cut, set()).add((lower, upper))
        if (classes.get(lower, {}).get('kind') == 'metal' and
                classes.get(upper, {}).get('kind') == 'metal' and
                classes[lower].get('routing') and classes[upper].get('routing')):
            predecessors.setdefault(upper, set()).add(lower)
    # Topological order excludes cycles and their unresolved descendants.
    successors = {}
    incoming = dict((upper, len(lower_names)) for upper, lower_names in predecessors.items())
    for upper, lower_names in predecessors.items():
        for lower in lower_names:
            successors.setdefault(lower, set()).add(upper)
            incoming.setdefault(lower, 0)
    ready = [name for name, count in incoming.items() if count == 0]
    ordered = []
    while ready:
        lower = ready.pop()
        ordered.append(lower)
        for upper in successors.get(lower, ()):
            incoming[upper] -= 1
            if incoming[upper] == 0:
                ready.append(upper)
    for upper in ordered:
        lower_names = predecessors.get(upper, set())
        if upper in positions or len(lower_names) != 1:
            continue
        lower = next(iter(lower_names))
        if lower in positions:
            positions[upper] = positions[lower] + 2.0
            layers.setdefault(upper, {'material': 'unknown', 'source': 'oa-via-definition'})
            layers[upper].update(stackIndex=positions[upper], stackSource='oa-via-order-approximate')
    for cut, cut_pairs in pairs.items():
        positioned = set((positions[lower], positions[upper]) for lower, upper in cut_pairs
                         if lower in positions and upper in positions)
        if len(positioned) != 1:
            continue
        lower, upper = next(iter(positioned))
        if upper <= lower:
            continue
        info = classes.get(cut, {})
        if info.get('routing') and info.get('kind') in ('via', 'contact'):
            layers.setdefault(cut, {'material': 'unknown', 'source': 'oa-via-definition'})
            layers[cut].update(stackIndex=(lower + upper) / 2.0,
                               stackSource='oa-via-order-approximate')
    return layers, diagnostics
