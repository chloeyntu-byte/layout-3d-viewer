// Unified search over pins, hierarchy modules and named nets.
// Pure functions: no DOM and no Three.js, so the ranking can be tested on its own.

const KIND_ORDER = { pin: 0, module: 1, net: 2 };

function lower(value) {
  return String(value ?? '').toLocaleLowerCase();
}

function leafName(path) {
  const text = String(path || '');
  const slash = text.lastIndexOf('/');
  return slash >= 0 ? text.slice(slash + 1) : text;
}

export function buildSearchIndex(index) {
  const entries = [];
  if (!index) return { entries };
  const rootPath = index.rootPath || '';
  const seenPins = new Set();
  for (const pin of index.pins || []) {
    const name = pin.terminal || pin.name || '';
    if (!name) continue;
    // One row per terminal and scope; extra figures of the same pin add nothing to the list.
    const pinKey = `${pin.hierPath || ''}|${name}`;
    if (seenPins.has(pinKey)) continue;
    seenPins.add(pinKey);
    entries.push({
      kind: 'pin', name, scope: pin.hierPath || '', detail: pin.layer || '',
      topLevel: (pin.hierPath || '') === rootPath, ref: pin,
      haystack: `${lower(name)} ${lower(pin.hierPath)}`,
    });
  }
  for (const [path, instance] of index.instancesByPath || []) {
    if (!path || path === rootPath) continue;
    const name = instance.name || leafName(path);
    const master = instance.master?.cell || '';
    entries.push({
      kind: 'module', name, scope: path, detail: master, topLevel: (instance.depth || 1) <= 1, ref: path,
      haystack: `${lower(name)} ${lower(path)} ${lower(master)}`,
    });
  }
  for (const row of index.netRows || []) {
    if (!row.net) continue;
    entries.push({
      kind: 'net', name: row.net, scope: row.path || '', detail: `${row.shapeCount || 0}`, topLevel: (row.path || '') === rootPath, ref: row.key,
      haystack: `${lower(row.net)} ${lower(row.path)}`,
    });
  }
  return { entries };
}

// Rank: exact name > name prefix > name substring > path/master substring; then top level, kind, name.
export function querySearchIndex(searchIndex, text, limitPerKind = 8) {
  const query = lower(text).trim();
  if (!query || !searchIndex?.entries?.length) return [];
  const scored = [];
  for (const entry of searchIndex.entries) {
    const name = lower(entry.name);
    let score;
    if (name === query) score = 0;
    else if (name.startsWith(query)) score = 1;
    else if (name.includes(query)) score = 2;
    else if (entry.haystack.includes(query)) score = 3;
    else continue;
    scored.push({ entry, score });
  }
  scored.sort((a, b) => a.score - b.score
    || Number(b.entry.topLevel) - Number(a.entry.topLevel)
    || KIND_ORDER[a.entry.kind] - KIND_ORDER[b.entry.kind]
    || a.entry.name.localeCompare(b.entry.name));
  const perKind = { pin: 0, module: 0, net: 0 };
  const results = [];
  for (const item of scored) {
    if (perKind[item.entry.kind] >= limitPerKind) continue;
    perKind[item.entry.kind] += 1;
    results.push(item.entry);
  }
  return results;
}
