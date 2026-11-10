import assert from 'node:assert/strict';
import { cleanedPoints, createPrismGeometry, isAxisAlignedRectangle, excludedShape, nonConductiveLayerName, hardNonConductiveLayerName,
  pathFootprints, polygonArea, shapeFootprints, footprintBBox, legacyPathSegFootprint } from '../../public/src/geometry.js';

const bend = pathFootprints([[0, 0], [4, 0], [4, 4]], 2);
assert.equal(bend.length, 1);
assert.equal(Math.abs(polygonArea(bend[0])), 16);
assert(bend[0].some(([x, y]) => x === 5 && y === -1));
assert.equal(shapeFootprints({ type: 'pathseg', points: [[0, 0], [4, 0]], width: 2 }).length, 1);
assert.equal(Math.abs(polygonArea(shapeFootprints({ type: 'pathseg', points: [[0, 0], [4, 0]], width: 2 })[0])), 8);
assert.deepEqual(cleanedPoints([[0, 0], [0, 0], [0.0001, 0], [0, 0.0001]]), [[0, 0], [0.0001, 0], [0, 0.0001]]);
assert.equal(isAxisAlignedRectangle([[0, 0], [2, 2], [0, 2], [2, 0]]), false);
assert.throws(() => createPrismGeometry([[0, 0], [2, 2], [0, 2], [2, 0]]), /triangulate/);
assert.throws(() => pathFootprints([[0, 0], [1, 1]], 0), /width/);

function capArea(geometry, height) {
  const positions = geometry.getAttribute('position');
  let area = 0;
  for (let index = 0; index < positions.count; index += 3) {
    const triangle = [0, 1, 2].map((i) => [positions.getX(index + i), -positions.getZ(index + i)]);
    if ([0, 1, 2].every((i) => positions.getY(index + i) === height)) {
      area += Math.abs(polygonArea(triangle));
      const center = [0, 1].map((axis) => triangle.reduce((sum, point) => sum + point[axis], 0) / 3);
      assert(!(center[0] > 1 && center[0] < 4 && center[1] > 1 && center[1] < 4), 'hole was filled');
    }
  }
  return area;
}
const outer = [[0, 0], [5, 0], [5, 5], [0, 5]];
const hole = [[1, 1], [4, 1], [4, 4], [1, 4]];
for (const ring of [outer, [...outer].reverse()]) {
  const geometry = createPrismGeometry(ring, [hole]);
  assert.equal(capArea(geometry, 0), 16);
  assert.equal(capArea(geometry, 1), 16);
  const normals = geometry.getAttribute('normal');
  for (let index = 0; index < normals.count; index += 3) {
    assert.deepEqual([normals.getX(index), normals.getY(index), normals.getZ(index)],
      [normals.getX(index + 1), normals.getY(index + 1), normals.getZ(index + 1)], 'flat face normals differ');
  }
  geometry.dispose();
}
const concave = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]];
assert.equal(polygonArea(concave.map(([x, y]) => [x + 1e8, y + 1e8])), 7);
const miterSolid = createPrismGeometry(bend[0]);
assert(miterSolid.getAttribute('position').count > 0);
miterSolid.dispose();
const closed = pathFootprints([[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]], 0.5);
assert.equal(Math.abs(polygonArea(closed[0])), 8);
const closedSolid = createPrismGeometry(closed[0]);
closedSolid.dispose();
console.log('Browser geometry regression tests passed');

assert.equal(excludedShape({ type: 'rect', purpose: 'drawing' }, { kind: 'metal' }), false);
for (const purpose of ['dummy', 'fill', 'slot', 'text', 'drawing_text']) {
  assert.equal(excludedShape({ type: 'rect', purpose }, { kind: 'metal' }), true);
}
assert.equal(excludedShape({ type: 'rect', purpose: 'custom', routing: false }, { kind: 'via' }), true);
assert.equal(nonConductiveLayerName('NW'), true);
assert.equal(nonConductiveLayerName('OD'), true);
assert.equal(nonConductiveLayerName('POLY1'), false);
assert.equal(nonConductiveLayerName('CONT'), false);

const [x, y, length, rise, width] = [100.1, 20.3, 6.7, 2.9, 0.3];
const selfTouch = pathFootprints([[x, y], [x + length, y], [x + length, y + rise], [x + width / 2, y + rise], [x + width / 2, y + width / 2]], width)[0];
assert(Math.abs(Math.abs(polygonArea(selfTouch)) - width * (2 * length + 2 * rise - width)) < 1e-9);
createPrismGeometry(selfTouch).dispose();

assert.equal(nonConductiveLayerName('MIM'), true);
assert.equal(hardNonConductiveLayerName('MIM'), false);
for (const layer of ['NW', 'AA', 'NIMP', 'SUBSTRATE', 'M1_DUMMY']) {
  assert.equal(hardNonConductiveLayerName(layer), true);
}
assert.equal(excludedShape({ type: 'rect', layer: 'MIM', purpose: 'dummy' }, { kind: 'metal', routing: true }), true);

// Legacy OA pathSeg points are already the bbox footprint, not a centerline.
const oldPathSeg = { type: 'pathSeg', width: 4, bbox: { min: [0, -2], max: [10, 2] },
  points: [[0, -2], [10, -2], [10, 2], [0, 2]] };
assert.equal(legacyPathSegFootprint(oldPathSeg), true);
assert.deepEqual(footprintBBox(shapeFootprints(oldPathSeg)[0]), oldPathSeg.bbox);
const realFourPointPath = { ...oldPathSeg, type: 'path' };
assert.equal(legacyPathSegFootprint(realFourPointPath), false);
assert.notDeepEqual(footprintBBox(shapeFootprints(realFourPointPath)[0]), oldPathSeg.bbox);
const extendedPathSeg = { type: 'pathSeg', points: [[0, 0], [10, 0]], width: 4, beginExt: 1, endExt: 3 };
assert.deepEqual(footprintBBox(shapeFootprints(extendedPathSeg)[0]), { min: [-1, -2], max: [13, 2] });

// PDK-exported drawing variants still carry nonconductive dummy purposes.
for (const purpose of ['odummy', 'odummy1', 'o_dummy', 'o-dummy2']) {
  assert.equal(excludedShape({ type: 'rect', purpose }, { kind: 'metal' }), true);
}
assert.equal(hardNonConductiveLayerName('TM1DUM'), true);
assert.equal(hardNonConductiveLayerName('TM1'), false);
