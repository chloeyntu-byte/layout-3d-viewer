from __future__ import absolute_import


def _text(value):
    return str(value or '').strip()


def selected_pins(metadata, paths):
    selected = set(_text(path) for path in paths if _text(path))
    return [pin for pin in metadata.get('pins') or [] if _text(pin.get('hierPath')) in selected]


def scoped_net_key(path, net):
    net = _text(net)
    return '%s::%s' % (_text(path), net) if net else ''


def connected_net_keys(metadata, paths, pins=None):
    """Trace explicit occurrence mappings; never join nets by name or proximity.

    pins=None traces every terminal on selected modules. A pin list limits the
    starting terminals while retaining the selected hierarchy and its markers.
    """
    selected = set(_text(path) for path in paths if _text(path))
    result = []
    visited = set()
    graph = {}

    def add(path, net):
        key = scoped_net_key(path, net)
        if key and key not in visited:
            visited.add(key)
            result.append(key)

    starting_pins = selected_pins(metadata, selected) if pins is None else pins
    pin_terminals = set()
    for pin in starting_pins:
        add(pin.get('hierPath'), pin.get('net') or pin.get('terminal'))
        pin_terminals.add((_text(pin.get('hierPath')), _text(pin.get('terminal') or pin.get('name'))))
    for connection in metadata.get('connections') or []:
        occurrence = _text(connection.get('occurrencePath') or connection.get('hierPath'))
        parent = _text(connection.get('parentPath') or occurrence.rpartition('/')[0])
        parent_net = connection.get('parentNet') or connection.get('net')
        child_net = connection.get('childFormalNet') or connection.get('childNet') or connection.get('terminal')
        parent_key = scoped_net_key(parent, parent_net)
        child_key = scoped_net_key(occurrence, child_net)
        if 'geometric' in _text(connection.get('source')).lower():
            continue
        if occurrence and parent_key and child_key:
            graph.setdefault(parent_key, set()).add(child_key)
            graph.setdefault(child_key, set()).add(parent_key)
        terminal = _text(connection.get('terminal') or connection.get('pin') or connection.get('name'))
        if (pins is None and occurrence in selected) or (occurrence, terminal) in pin_terminals:
            add(parent, parent_net)
            add(occurrence, child_net)
    cursor = 0
    while cursor < len(result):
        key = result[cursor]
        cursor += 1
        for neighbor in sorted(graph.get(key, ())):
            if neighbor not in visited:
                visited.add(neighbor)
                result.append(neighbor)
    return result


def hierarchy_tree_rows(metadata, query='', maximum_depth=3, selected_paths=()):
    """Keep occurrence ancestry visible while filtering, including pin-only scopes."""
    root = _text(metadata.get('cell')) or 'layout'
    records = {}
    for instance in metadata.get('instances') or []:
        path = _text(instance.get('hierPath') or instance.get('path'))
        if path:
            records[path] = instance
    paths = set(records)
    # Exported instance records intentionally omit redundant via primitives.
    # Only reconstruct from shape scopes when no instance inventory is available.
    if not records:
        paths.update(_text(path) for path in metadata.get('hierarchyPaths') or [] if _text(path))
    paths.update(_text(pin.get('hierPath')) for pin in metadata.get('pins') or [] if _text(pin.get('hierPath')))
    query = _text(query).lower()
    included = set([root])
    for path in paths:
        instance = records.get(path, {})
        master = instance.get('master') or {}
        search_text = '%s %s %s' % (path, master.get('cell') or '', master.get('library') or '')
        depth = max(0, path.count('/') - root.count('/'))
        if (query and query in search_text.lower()) or (not query and depth <= maximum_depth):
            included.add(path)
    included.update(_text(path) for path in selected_paths if _text(path) in paths)
    for path in list(included):
        while '/' in path:
            path = path.rpartition('/')[0]
            included.add(path)
    return [(path, records.get(path, {})) for path in sorted(included, key=lambda item: (item.count('/'), item))]


def hierarchy_ids(metadata, paths):
    requested = sorted(set(_text(path) for path in paths if _text(path)), key=lambda path: (len(path), path))
    selected = []
    for path in requested:
        if any(path == root or path.startswith(root + '/') for root in selected):
            continue
        selected.append(path)
    exact = set(selected)
    prefixes = tuple(path + '/' for path in selected)
    return set(
        index for index, path in enumerate(metadata.get('hierarchyPaths') or [])
        if path in exact or path.startswith(prefixes)
    )


def net_ids(metadata, paths, pins=None):
    lookup = dict((key, index) for index, key in enumerate(metadata.get('netKeys') or []))
    return set(lookup[key] for key in connected_net_keys(metadata, paths, pins=pins) if key in lookup)


def outline_indices(arrays, selected_hierarchy, connected_nets, numpy_module=None):
    if numpy_module is None:
        import numpy as numpy_module
    hierarchy = arrays.get('outline_hierarchy')
    nets = arrays.get('outline_nets')
    if hierarchy is None:
        empty = numpy_module.empty((0,), dtype=numpy_module.int64)
        return empty, empty.copy()
    selected_values = numpy_module.asarray(sorted(selected_hierarchy), dtype=hierarchy.dtype)
    selected = numpy_module.flatnonzero(numpy_module.isin(hierarchy, selected_values)) \
        if len(selected_values) else numpy_module.empty((0,), dtype=numpy_module.int64)
    if nets is None:
        connected = numpy_module.empty((0,), dtype=numpy_module.int64)
    else:
        net_values = numpy_module.asarray(sorted(connected_nets), dtype=nets.dtype)
        connected = numpy_module.flatnonzero(numpy_module.isin(nets, net_values)) \
            if len(net_values) else numpy_module.empty((0,), dtype=numpy_module.int64)
    return selected, connected


def physical_shape_rows(arrays, shape_indices, numpy_module=None):
    """Map original JSON shape ordinals to every compiled geometry fragment."""
    if numpy_module is None:
        import numpy as numpy_module
    from .errors import Vl3dError
    indices = sorted(set(int(value) for value in shape_indices if int(value) >= 0))
    result = []
    for name in ('rect_shape_indices', 'outline_shape_indices'):
        values = arrays.get(name)
        if values is None:
            raise Vl3dError('E9003', 'Reload the layout to build geometry-trace shape mappings')
        result.append(numpy_module.flatnonzero(numpy_module.isin(values, indices))
                      if indices else numpy_module.empty((0,), dtype=numpy_module.int64))
    return tuple(result)
