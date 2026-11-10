function normalizedText(value) {
  return String(value ?? '').trim();
}

function normalizedLayer(value) {
  return normalizedText(value).toUpperCase();
}

function safeBBox(value) {
  if (!value?.min || !value?.max) return null;
  const minX = Number(value.min[0]);
  const minY = Number(value.min[1]);
  const maxX = Number(value.max[0]);
  const maxY = Number(value.max[1]);
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
  return {
    min: [Math.min(minX, maxX), Math.min(minY, maxY)],
    max: [Math.max(minX, maxX), Math.max(minY, maxY)],
  };
}

function bboxesTouch(first, second, tolerance = 0.002) {
  return first.min[0] <= second.max[0] + tolerance
    && first.max[0] >= second.min[0] - tolerance
    && first.min[1] <= second.max[1] + tolerance
    && first.max[1] >= second.min[1] - tolerance;
}

export function parentHierarchyPath(path) {
  const normalized = normalizedText(path);
  const slash = normalized.lastIndexOf('/');
  return slash < 0 ? '' : normalized.slice(0, slash);
}

export function hierarchyDepth(path) {
  const normalized = normalizedText(path);
  return normalized ? normalized.split('/').length - 1 : 0;
}

export function scopedNetKey(path, net) {
  const normalizedNet = normalizedText(net);
  if (!normalizedNet) return '';
  return `${normalizedText(path)}::${normalizedNet}`;
}

export function splitScopedNetKey(key) {
  const normalized = normalizedText(key);
  const separator = normalized.lastIndexOf('::');
  if (separator < 0) return { path: '', net: normalized };
  return {
    path: normalized.slice(0, separator),
    net: normalized.slice(separator + 2),
  };
}

function addMapList(map, key, value) {
  if (!key) return;
  let values = map.get(key);
  if (!values) {
    values = [];
    map.set(key, values);
  }
  values.push(value);
}

function addGraphEdge(graph, first, second) {
  if (!first || !second || first === second) return;
  if (!graph.has(first)) graph.set(first, new Set());
  if (!graph.has(second)) graph.set(second, new Set());
  graph.get(first).add(second);
  graph.get(second).add(first);
}

function pinShapeCandidate(shape) {
  const purpose = normalizedText(shape?.purpose).toLowerCase();
  const type = normalizedText(shape?.type).toLowerCase();
  return purpose.includes('pin') || type.includes('text') || type.includes('label');
}

function shapeLabel(shape) {
  return normalizedText(shape?.label || shape?.theLabel || shape?.text || shape?.net);
}

function normalizedPin(pin, id) {
  const bbox = safeBBox(pin?.worldBBox || pin?.bbox);
  if (!bbox) return null;
  const terminal = String(pin?.terminal || pin?.name || pin?.net || `PIN_${id}`);
  return {
    ...pin,
    id: Number.isFinite(Number(pin?.id)) ? Number(pin.id) : id,
    figureIndex: id,
    ownerCell: normalizedText(pin?.ownerCell),
    hierPath: normalizedText(pin?.hierPath || pin?.path),
    terminal,
    name: normalizedText(pin?.name || terminal),
    direction: normalizedText(pin?.direction || 'unknown'),
    net: normalizedText(pin?.net),
    layer: normalizedLayer(pin?.layer),
    purpose: normalizedText(pin?.purpose || 'pin'),
    bbox,
    points: Array.isArray(pin?.points) ? pin.points : [],
    holes: Array.isArray(pin?.holes) ? pin.holes : [],
    type: normalizedText(pin?.type || 'polygon'),
    width: pin?.width,
    source: normalizedText(pin?.source || 'oa'),
  };
}

function inferPins(data, routingShapesByScopeLayer) {
  const pins = [];
  for (const shape of data.shapes || []) {
    if (!pinShapeCandidate(shape)) continue;
    const bbox = safeBBox(shape.bbox);
    if (!bbox) continue;
    const scopeLayer = `${normalizedText(shape.hierPath)}|${normalizedLayer(shape.layer)}`;
    const candidates = routingShapesByScopeLayer.get(scopeLayer) || [];
    const matching = candidates.filter((candidate) => candidate.net
      && !pinShapeCandidate(candidate) && candidate.bbox
      && /^(rect|rectangle)$/i.test(candidate.type || '')
      && bboxesTouch(bbox, candidate.bbox, 0));
    const matchingNets = new Set(matching.map((candidate) => candidate.net));
    const best = matchingNets.size === 1 ? matching[0] : null;
    const isPinPurpose = normalizedText(shape.purpose).toLowerCase().includes('pin');
    if (!isPinPurpose && !best && !normalizedText(shape.net)) continue;
    const label = shapeLabel(shape) || normalizedText(best?.net) || `PIN_${pins.length}`;
    pins.push({
      id: pins.length,
      ownerCell: normalizedText(shape.ownerCell),
      hierPath: normalizedText(shape.hierPath),
      terminal: label,
      name: label,
      direction: 'unknown',
      net: normalizedText(shape.net || best?.net),
      layer: normalizedLayer(shape.layer),
      purpose: normalizedText(shape.purpose || 'pin'),
      bbox,
      points: Array.isArray(shape.points) ? shape.points : [],
      source: 'geometric-inference',
    });
  }
  return pins;
}

function normalizedConnection(connection, id) {
  const occurrencePath = normalizedText(connection?.occurrencePath || connection?.hierPath || connection?.path);
  const parentPath = normalizedText(connection?.parentPath || parentHierarchyPath(occurrencePath));
  const terminal = normalizedText(connection?.terminal || connection?.pin || connection?.name);
  const parentNet = normalizedText(connection?.parentNet || connection?.net);
  const childFormalNet = normalizedText(connection?.childFormalNet || connection?.childNet || terminal);
  if (!occurrencePath || (!parentNet && !childFormalNet)) return null;
  return {
    id: Number.isFinite(Number(connection?.id)) ? Number(connection.id) : id,
    occurrencePath,
    parentPath,
    parentNet,
    childFormalNet,
    terminal,
    source: normalizedText(connection?.source || 'oa'),
  };
}


function layoutDisplayName(data) {
  const library = normalizedText(data.library || 'local');
  const cell = normalizedText(data.cell || 'layout');
  const view = normalizedText(data.view || 'layout');
  return `${library}/${cell}/${view}`;
}

export function buildLayoutIndex(data) {
  const startedAt = performance.now();
  const instances = Array.isArray(data.instances) ? data.instances : [];
  const shapes = Array.isArray(data.shapes) ? data.shapes : [];
  const instancesByPath = new Map();
  const childrenByPath = new Map();
  const shapesByNet = new Map();
  const shapesByScopeLayer = new Map();
  const pinsByPath = new Map();
  const connectionsByOccurrence = new Map();
  const netGraph = new Map();
  const nets = new Map();

  for (const instance of instances) {
    instance.hierPath = normalizedText(instance.hierPath || instance.path);
    instance.parentPath = normalizedText(instance.parentPath || parentHierarchyPath(instance.hierPath));
    instance.depth = hierarchyDepth(instance.hierPath);
    instancesByPath.set(instance.hierPath, instance);
    addMapList(childrenByPath, instance.parentPath, instance);
  }

  for (const [shapeIndex, shape] of shapes.entries()) {
    shape.shapeIndex = shapeIndex;
    shape.hierPath = normalizedText(shape.hierPath);
    shape.layer = normalizedLayer(shape.layer);
    shape.net = normalizedText(shape.net);
    shape.bbox = safeBBox(shape.bbox);
    shape.netKey = scopedNetKey(shape.hierPath, shape.net);
    addMapList(shapesByScopeLayer, `${shape.hierPath}|${shape.layer}`, shape);
    if (!shape.netKey) continue;
    addMapList(shapesByNet, shape.netKey, shape);
    let netRecord = nets.get(shape.netKey);
    if (!netRecord) {
      netRecord = {
        key: shape.netKey,
        path: shape.hierPath,
        net: shape.net,
        shapeCount: 0,
        layers: new Set(),
        bbox: null,
      };
      nets.set(shape.netKey, netRecord);
    }
    netRecord.shapeCount += 1;
    netRecord.layers.add(shape.layer);
    if (shape.bbox) {
      if (!netRecord.bbox) {
        netRecord.bbox = {
          min: [...shape.bbox.min],
          max: [...shape.bbox.max],
        };
      } else {
        netRecord.bbox.min[0] = Math.min(netRecord.bbox.min[0], shape.bbox.min[0]);
        netRecord.bbox.min[1] = Math.min(netRecord.bbox.min[1], shape.bbox.min[1]);
        netRecord.bbox.max[0] = Math.max(netRecord.bbox.max[0], shape.bbox.max[0]);
        netRecord.bbox.max[1] = Math.max(netRecord.bbox.max[1], shape.bbox.max[1]);
      }
    }
  }

  const explicitPins = (Array.isArray(data.pins) ? data.pins : [])
    .map((pin, index) => normalizedPin(pin, index))
    .filter(Boolean);
  // An explicit empty array is authoritative, including terminal-free OA cells.
  const pins = Array.isArray(data.pins) ? explicitPins : inferPins(data, shapesByScopeLayer);
  for (const pin of pins) {
    const inferred = /geometric|stream/i.test(pin.source);
    pin.netKey = scopedNetKey(pin.hierPath, pin.net || (!inferred ? pin.terminal : ''));
    addMapList(pinsByPath, pin.hierPath, pin);
  }

  const explicitConnections = (Array.isArray(data.connections) ? data.connections : [])
    .map((connection, index) => normalizedConnection(connection, index))
    .filter(Boolean);
  // Bounding-box proximity cannot prove electrical contact (holes, bends and
  // overlapping layers are common). Only exported terminal mappings join scopes.
  const connections = explicitConnections;
  for (const connection of connections) {
    connection.parentNetKey = scopedNetKey(connection.parentPath, connection.parentNet);
    connection.childNetKey = scopedNetKey(connection.occurrencePath, connection.childFormalNet || connection.terminal);
    addMapList(connectionsByOccurrence, connection.occurrencePath, connection);
    if (!/geometric/i.test(connection.source)) {
      addGraphEdge(netGraph, connection.parentNetKey, connection.childNetKey);
    }
  }

  const netRows = [...nets.values()].map((record) => ({
    ...record,
    layers: [...record.layers].sort(),
    connectionCount: netGraph.get(record.key)?.size || 0,
  })).sort((first, second) => (
    second.shapeCount - first.shapeCount
    || first.net.localeCompare(second.net)
    || first.path.localeCompare(second.path)
  ));

  const maxDepth = instances.reduce((maximum, instance) => Math.max(maximum, instance.depth), 0);
  const explicitConnectivity = connections.some((connection) => !/geometric/i.test(connection.source));
  const explicitPinData = pins.some((pin) => !/geometric|stream/i.test(pin.source));
  return {
    displayName: layoutDisplayName(data),
    instancesByPath,
    childrenByPath,
    shapesByNet,
    shapesByScopeLayer,
    pins,
    pinsByPath,
    connections,
    connectionsByOccurrence,
    netGraph,
    netRows,
    maxDepth,
    rootPath: normalizedText(data.cell),
    connectivityMode: explicitConnectivity ? 'oa' : (connections.length ? 'estimated-untraced' : 'none'),
    pinMode: explicitPinData ? 'oa' : (pins.length ? 'geometric' : 'none'),
    buildMs: performance.now() - startedAt,
  };
}

export function traceScopedNets(index, startingKeys) {
  const queue = [...startingKeys].filter(Boolean);
  const visited = new Set(queue);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const key = queue[cursor];
    for (const neighbor of index.netGraph.get(key) || []) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      queue.push(neighbor);
    }
  }
  return visited;
}

export function pathUnderSelection(path, selectedPaths) {
  if (!selectedPaths?.size) return false;
  const normalized = normalizedText(path);
  if (selectedPaths.has(normalized)) return true;
  let slash = normalized.length;
  while ((slash = normalized.lastIndexOf('/', slash - 1)) >= 0) {
    if (selectedPaths.has(normalized.slice(0, slash))) return true;
  }
  return false;
}

export function hierarchyMatches(instance, search, maxDepth) {
  if (instance.depth > maxDepth) return false;
  const normalizedSearch = normalizedText(search).toLowerCase();
  if (!normalizedSearch) return true;
  const master = instance.master || {};
  return `${instance.hierPath} ${instance.name || ''} ${master.library || ''} ${master.cell || ''} ${master.view || ''}`
    .toLowerCase()
    .includes(normalizedSearch);
}

export function netMatches(record, search) {
  const normalizedSearch = normalizedText(search).toLowerCase();
  if (!normalizedSearch) return true;
  return `${record.net} ${record.path} ${record.layers.join(' ')}`.toLowerCase().includes(normalizedSearch);
}

export function mergeBBoxes(items, getter = (item) => item?.bbox) {
  let merged = null;
  for (const item of items) {
    const bbox = safeBBox(getter(item));
    if (!bbox) continue;
    if (!merged) {
      merged = { min: [...bbox.min], max: [...bbox.max] };
      continue;
    }
    merged.min[0] = Math.min(merged.min[0], bbox.min[0]);
    merged.min[1] = Math.min(merged.min[1], bbox.min[1]);
    merged.max[0] = Math.max(merged.max[0], bbox.max[0]);
    merged.max[1] = Math.max(merged.max[1], bbox.max[1]);
  }
  return merged;
}
