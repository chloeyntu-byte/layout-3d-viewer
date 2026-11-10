import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildLayoutIndex, traceScopedNets } from '../../public/src/model.js';

const bbox = { min: [0, 0], max: [1, 1] };
const demo = JSON.parse(readFileSync(new URL('../../examples/hierarchy-demo.json', import.meta.url)));
const index = buildLayoutIndex(demo);
const input = traceScopedNets(index, ['DEMO/U1::A']);
assert(input.has('DEMO::IN'));
assert(input.has('DEMO/U1/M0::G'));
assert(!input.has('DEMO/U2::A'), 'Repeated masters must retain occurrence-local nets');
assert(!input.has('DEMO::OUT'));
assert.deepEqual(index.pinsByPath.get('DEMO').map((pin) => pin.terminal), ['IN', 'OUT']);

const empty = buildLayoutIndex({ cell: 'TOP', pins: [], connections: [], shapes: [
  { type: 'label', purpose: 'pin', label: 'FAKE', layer: 'M1', hierPath: 'TOP', bbox },
] });
assert.equal(empty.pins.length, 0, 'Explicit empty pin data is authoritative');

const approximate = buildLayoutIndex({ cell: 'TOP', pins: [
  { terminal: 'A', net: 'A', hierPath: 'TOP/U1', layer: 'M1', bbox },
], shapes: [
  { type: 'rect', net: 'CLK', hierPath: 'TOP', layer: 'M1', bbox },
] });
assert.equal(approximate.connections.length, 0, 'Overlapping bounding boxes cannot prove electrical contact');
assert.deepEqual([...traceScopedNets(approximate, ['TOP/U1::A'])], ['TOP/U1::A']);

const legacy = buildLayoutIndex({ cell: 'TOP', connections: [
  { occurrencePath: 'TOP/U1', parentPath: 'TOP', parentNet: 'CLK', childFormalNet: 'A', source: 'geometric-inference' },
] });
assert.deepEqual([...traceScopedNets(legacy, ['TOP/U1::A'])], ['TOP/U1::A']);
assert.equal(legacy.connectivityMode, 'estimated-untraced');
const annotations = buildLayoutIndex({ cell: 'TOP', shapes: [
  { type: 'label', purpose: 'drawing', label: 'FLOORPLAN_NOTE', layer: 'NW', hierPath: 'TOP', bbox },
] });
assert.equal(annotations.pins.length, 0, 'Arbitrary layout annotations are not electrical pins');

console.log('Model hierarchy, per-level pins and explicit scoped trace tests passed');
