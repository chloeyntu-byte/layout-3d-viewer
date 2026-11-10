import * as THREE from '../vendor/three.module.min.js';

const NON_CONDUCTIVE_PURPOSES = new Set([
  'label', 'text', 'textdisplay', 'annotation', 'annotate', 'drawingtext',
  'dummy', 'odummy', 'dmy', 'fill', 'fillblock', 'fillblockage', 'slot', 'slotting',
  'marker', 'mark', 'boundary', 'border', 'netboundary', 'blockage',
  'keepout', 'exclude', 'exclusion', 'density', 'error', 'warning', 'flight',
]);

const SOFT_AUXILIARY_LAYER_NAMES = new Set(['HRP', 'MIM', 'SAB', 'HRI', 'RPO', 'NTN']);
const HARD_NON_CONDUCTIVE_LAYER_NAMES = new Set([
  'DIFF', 'DIFFUSION', 'OD', 'ACTIVE', 'ACT', 'AA', 'RX', 'COMP',
  'SUBSTRATE', 'SUB', 'PW', 'NW', 'PWELL', 'NWELL', 'DNW', 'DNWELL', 'NWEL', 'PWEL',
  'NPLUS', 'PPLUS', 'NIMP', 'PIMP', 'NSD', 'PSD', 'SN', 'SP',
  'RFDEV', 'RFMOSD', 'INSTANCE', 'PRBOUNDARY', 'TEXT', 'ANNOTATE',
]);

export function hardNonConductiveLayerName(value) {
  const name = String(value || '').trim().toUpperCase();
  return HARD_NON_CONDUCTIVE_LAYER_NAMES.has(name)
    || /(?:WELL|TXT|TEXT|DUMMY|DUM|DMY|SLOT|FILL|MARK|BOUND|BOUNDARY|BORDER|_PIN|_LABEL)$/.test(name);
}

export function nonConductiveLayerName(value) {
  const name = String(value || '').trim().toUpperCase();
  return hardNonConductiveLayerName(name) || SOFT_AUXILIARY_LAYER_NAMES.has(name);
}

export function excludedShape(shape, layer = {}) {
  const type = String(shape?.type || '').toLowerCase();
  const purpose = String(shape?.purpose || '').toLowerCase().replace(/[\s_-]+/g, '');
  return type.includes('text') || type.includes('label') || purpose === 'pin'
    || NON_CONDUCTIVE_PURPOSES.has(purpose) || /^(?:dummy|odummy|dmy|fill|slot|marker|label|text)[0-9]+$/.test(purpose)
    || (shape?.routing === false && ['metal', 'via', 'contact', 'poly'].includes(layer.kind));
}

export function cleanedPoints(points, closed = true) {
  const result = [];
  for (const point of Array.isArray(points) ? points : []) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const x = Number(point[0]);
    const y = Number(point[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (!result.length || result.at(-1)[0] !== x || result.at(-1)[1] !== y) result.push([x, y]);
  }
  if (closed && result.length > 1 && result[0][0] === result.at(-1)[0] && result[0][1] === result.at(-1)[1]) result.pop();
  return result;
}

export function polygonArea(points) {
  if (!points.length) return 0;
  const [ox, oy] = points[0];
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    area += (a[0] - ox) * (b[1] - oy) - (b[0] - ox) * (a[1] - oy);
  }
  return area / 2;
}

export function bboxFootprint(bbox) {
  return [[bbox.min[0], bbox.min[1]], [bbox.max[0], bbox.min[1]],
    [bbox.max[0], bbox.max[1]], [bbox.min[0], bbox.max[1]]];
}

export function pathFootprints(points, width, shape = {}) {
  const cleaned = cleanedPoints(points, false);
  const half = Number(width) / 2;
  if (!Number.isFinite(half) || half <= 0) throw new Error('Layout path width must be positive and finite');
  if (cleaned.length < 2) return [];
  const closed = cleaned.length > 2 && cleaned[0][0] === cleaned.at(-1)[0] && cleaned[0][1] === cleaned.at(-1)[1];
  if (closed) cleaned.pop();
  const count = cleaned.length;
  const directions = [];
  for (let i = 0; i < (closed ? count : count - 1); i += 1) {
    const a = cleaned[i]; const b = cleaned[(i + 1) % count];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    directions.push([(b[0] - a[0]) / length, (b[1] - a[1]) / length]);
  }
  const style = String(shape.pathStyle || shape.endStyle || 'flush').toLowerCase();
  const extension = ['extend', 'extended'].includes(style) ? half : 0;
  const firstExtension = Number(shape.beginExt ?? extension);
  const lastExtension = Number(shape.endExt ?? extension);
  const left = []; const right = [];
  for (let i = 0; i < count; i += 1) {
    const previous = directions[(i - 1 + directions.length) % directions.length];
    const next = directions[i % directions.length];
    let x = cleaned[i][0]; let y = cleaned[i][1];
    let offset;
    if (!closed && (i === 0 || i === count - 1)) {
      const direction = i === 0 ? next : previous;
      const endExtension = i === 0 ? -firstExtension : lastExtension;
      x += direction[0] * endExtension; y += direction[1] * endExtension;
      offset = [-direction[1] * half, direction[0] * half];
    } else {
      const divisor = 1 + previous[0] * next[0] + previous[1] * next[1];
      if (divisor < 1e-12) throw new Error('A reversing layout path needs an explicit polygon boundary');
      offset = [-(previous[1] + next[1]) * half / divisor, (previous[0] + next[0]) * half / divisor];
    }
    left.push([x + offset[0], y + offset[1]]);
    right.push([x - offset[0], y - offset[1]]);
  }
  if (closed) { left.push(left[0]); right.push(right[0]); }
  if (!closed && style === 'round') {
    const arc = (center, direction, startAngle) => Array.from({ length: 15 }, (_, index) => {
      const angle = startAngle - (index + 1) * Math.PI / 16;
      return [center[0] + Math.cos(angle) * half, center[1] + Math.sin(angle) * half];
    });
    const endAngle = Math.atan2(directions.at(-1)[1], directions.at(-1)[0]) + Math.PI / 2;
    const startAngle = Math.atan2(directions[0][1], directions[0][0]) - Math.PI / 2;
    return [[...left, ...arc(cleaned.at(-1), directions.at(-1), endAngle),
      ...right.reverse(), ...arc(cleaned[0], directions[0], startAngle)]];
  }
  return [[...left, ...right.reverse()]];
}

// Older OA exporters wrote a pathSeg bounding rectangle as its points.
// It is a display fallback, never a centerline to extrude a second time. The
// physical engine rejects this legacy geometry and asks for a fresh export.
export function legacyPathSegFootprint(shape) {
  if (String(shape?.type || '').toLowerCase() !== 'pathseg' || !shape.bbox) return false;
  const points = cleanedPoints(shape.points);
  if (!isAxisAlignedRectangle(points)) return false;
  const bounds = footprintBBox(points);
  return [0, 1].every((axis) => bounds.min[axis] === Number(shape.bbox.min?.[axis])
    && bounds.max[axis] === Number(shape.bbox.max?.[axis]));
}

export function shapeFootprints(shape) {
  const type = String(shape?.type || '').toLowerCase();
  if (excludedShape(shape)) return [];
  const isPath = type === 'path' || type === 'pathseg';
  const points = cleanedPoints(shape.points, !isPath);
  if (legacyPathSegFootprint(shape)) return [cleanedPoints(shape.points)];
  if (isPath && points.length >= 2) return pathFootprints(points, shape.width, shape);
  if (points.length >= 3) return [points];
  return shape.bbox ? [bboxFootprint(shape.bbox)] : [];
}

export function footprintBBox(footprint) {
  const bbox = { min: [Infinity, Infinity], max: [-Infinity, -Infinity] };
  for (const point of footprint) for (let axis = 0; axis < 2; axis += 1) {
    bbox.min[axis] = Math.min(bbox.min[axis], point[axis]);
    bbox.max[axis] = Math.max(bbox.max[axis], point[axis]);
  }
  return bbox;
}

export function isAxisAlignedRectangle(footprint) {
  const points = cleanedPoints(footprint);
  return points.length === 4 && Math.abs(polygonArea(points)) > 0 && points.every((a, index) => {
    const b = points[(index + 1) % 4];
    return (a[0] === b[0]) !== (a[1] === b[1]);
  });
}

export function createPrismGeometry(footprint, holes = [], worldX = (x) => x, worldZ = (y) => -y) {
  const rings = [cleanedPoints(footprint), ...holes.map((hole) => cleanedPoints(hole))].filter((ring) => ring.length >= 3);
  if (!rings.length) return null;
  rings.forEach((ring, i) => { if ((polygonArea(ring) < 0) !== (i > 0)) ring.reverse(); });
  const points = rings.flat();
  const pointCount = points.length;
  const vectors = rings.map((ring) => ring.map((point) => new THREE.Vector2(...point)));
  const triangles = THREE.ShapeUtils.triangulateShape(vectors[0], vectors.slice(1));
  const expected = Math.abs(polygonArea(rings[0])) - rings.slice(1).reduce((sum, ring) => sum + Math.abs(polygonArea(ring)), 0);
  const actual = triangles.reduce((sum, triangle) => sum + Math.abs(polygonArea(triangle.map((i) => points[i]))), 0);
  if (expected <= 0 || Math.abs(actual - expected) > Math.max(expected * 1e-8, 1e-24)) throw new Error('Cannot triangulate layout polygon without changing its area');
  const vertices = [];
  for (const point of points) vertices.push(worldX(point[0]), 0, worldZ(point[1]));
  for (const point of points) vertices.push(worldX(point[0]), 1, worldZ(point[1]));
  const indices = [];
  for (const triangle of triangles) {
    indices.push(triangle[2], triangle[1], triangle[0]);
    indices.push(triangle[0] + pointCount, triangle[1] + pointCount, triangle[2] + pointCount);
  }
  let offset = 0;
  for (const ring of rings) {
    for (let index = 0; index < ring.length; index += 1) {
      const a = offset + index; const b = offset + (index + 1) % ring.length;
      indices.push(a, b, b + pointCount, a, b + pointCount, a + pointCount);
    }
    offset += ring.length;
  }
  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  indexed.setIndex(indices);
  const geometry = indexed.toNonIndexed();
  indexed.dispose();
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}
