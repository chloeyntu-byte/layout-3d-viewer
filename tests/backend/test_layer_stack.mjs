import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import * as THREE from '../../public/vendor/three.module.min.js';
import { hardNonConductiveLayerName, nonConductiveLayerName } from '../../public/src/geometry.js';

// Execute the actual pure layer functions without creating a GUI or a WebGL context.
const source = readFileSync(new URL('../../public/src/viewer-next.js', import.meta.url), 'utf8');
const names = ['normalizedLayerName', 'explicitLayerSemantic', 'declaredLayerSemantic', 'layerSemantic',
  'metalNumber', 'viaPair', 'layerFromLookup', 'connectorPair', 'layerStackValue', 'isAuxiliaryLayer', 'defaultLayerVisibility',
  'syntheticLayer',
  'declaredLayerEndpoints', 'hasLayerStackEvidence', 'parallelStackLayer', 'normalizeLayerMetadata',
  'preferredMetalLayer', 'inferredConnectorName', 'unclassifiedLayerWarning', 'approximateStackWarning',
  'completeRoutingStack', 'layerThickness', 'rebuildLayerMeta', 'verticalUnit', 'layerBaseY',
  'layerVisualHeight', 'connectorSpan', 'firstExistingLayer', 'existingMetalLayer', 'beginFastMode', 'setAllLayersVisible'];
function actualFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `Missing viewer function ${name}`);
  const end = source.indexOf('\n}\n', start);
  assert(end > start, `Missing function boundary for ${name}`);
  return source.slice(start, end + 3);
}
const context = vm.createContext({ hardNonConductiveLayerName, nonConductiveLayerName,
  LAYER_COLORS: {}, THREE, layerMeta: new Map(), layerVisibility: new Map(),
  layerFillColors: new Map(), resolvedFillColor: () => '#8ecae6', zScale: { value: 0.1 },
  performance: { now: () => 1 }, window: { clearTimeout() {} }, fastMode: false,
  fastModeTimer: null, lastFastInteractionAt: 0, fastDraftLayerCount: 0,
  selectedRenderRecord: null, selectedNetKeys: new Set(), currentIndex: {},
  setRoutingSurfaceVisibility() {}, connectorRoot: {}, instanceRoot: {}, pinRoot: {},
  wireframeToggle: { checked: false }, updatePerformanceInfo() {}, requestRender() {}, syncRenderDPR() {}, setEdgeOpacity() {}, edgeObjects: [], routingToggle: { checked: true },
});
vm.runInContext(names.map(actualFunction).join('\n'), context);
const plain = (value) => JSON.parse(JSON.stringify(value));
let checks = 0;
function check(name, body) { body(); checks += 1; console.log(`PASS: ${name}`); }

check('Multi-digit VIA names match the authoritative Python name parser', () => {
  const inputs = ['VIA12', 'VIA9', 'VIA10', 'VIA910', 'VIA1011', 'VIA1_2', 'VIA_9_10',
    'VIA-10-11', 'V10', 'V_10', 'V9_10', 'VIA123', 'VIA_123', 'TV1', 'unknown'];
  const result = spawnSync(process.env.VL3D_PYTHON || 'python3', ['-c',
    'import json,sys; from tools.pdk_profile import via_pair_from_name; print(json.dumps([via_pair_from_name(x) for x in json.loads(sys.argv[1])]))',
    JSON.stringify(inputs)], { cwd: new URL('../../', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(inputs.map((name) => plain(context.viaPair(name))), JSON.parse(result.stdout));
  assert.deepEqual(plain(context.viaPair('VIA10')), [10, 11]);
  assert.deepEqual(plain(context.viaPair('VIA910')), [9, 10]);
  assert.equal(context.viaPair('VIA123'), null);
});
check('Null numeric hints do not override declared named endpoints', () => {
  assert.deepEqual(plain(context.viaPair({ name: 'VIA910', lowerMetal: null, upperMetal: null })), [9, 10]);
  assert.deepEqual(plain(context.viaPair({ name: 'VIA10', lowerMetal: 1, upperMetal: 2,
    lowerLayer: 'M9', upperLayer: 'M10' })), [9, 10]);
});
check('Technology identity never enables a name-based top-layer or capacitor-plate fallback', () => {
  for (const profile of ['', 'generic', 'my-process']) {
    const top = context.normalizeLayerMetadata({ name: 'TM1' }, { technology: { profile } });
    assert.equal(top.routing, false); assert.equal(top.defaultVisible, false);
  }
  const plate = context.normalizeLayerMetadata({ name: 'CTM5', kind: 'metal', routing: true, stackIndex: 11 });
  assert.notEqual(plate.parallelStack, true);
  assert.equal(context.parallelStackLayer({ name: 'X', parallelStack: true }), true);
  assert.equal(context.parallelStackLayer({ name: 'CTM5' }), false);
});
check('Explicit top-metal numbering, stack position and endpoints survive normalization', () => {
  const top = context.normalizeLayerMetadata({ name: 'TM1', kind: 'metal', routing: true, metal: 9,
    stackIndex: 19, thickness: 2.4 });
  assert.equal(top.metal, 9); assert.equal(top.stackIndex, 19); assert.equal(top.thickness, 2.4);
  const via = context.normalizeLayerMetadata({ name: 'TV1', kind: 'via', routing: true,
    lowerLayer: 'M8', upperLayer: 'TM1', stackIndex: 18 });
  assert.equal(via.lowerLayer, 'M8'); assert.equal(via.upperLayer, 'TM1'); assert.equal(via.stackIndex, 18);
  const unknown = context.normalizeLayerMetadata({ name: 'TM1' });
  assert.equal(unknown.routing, false); assert.equal(unknown.defaultVisible, false);
});
check('Known endpoint names and absent endpoints are never silently replaced by a similarly numbered layer', () => {
  const raw = { technology: { profile: 'generic' }, layers: [
    { name: 'M8', kind: 'metal', routing: true, metal: 8 },
    { name: 'TM1', kind: 'metal', routing: true, metal: 9 },
    { name: 'VIA89', kind: 'via', routing: true, lowerLayer: 'SPECIAL8', upperLayer: 'TM1',
      lowerLayers: ['SPECIAL8'], upperLayers: ['TM1'], connectivitySource: 'oa-via-definition' },
  ], pins: [{ terminal: ' A<3> ', bbox: { min: [1, 2], max: [3, 4] } }] };
  const before = JSON.stringify(raw);
  const result = context.completeRoutingStack(raw);
  const via = result.layers.find((layer) => layer.name === 'VIA89');
  assert.equal(via.lowerLayer, 'SPECIAL8'); assert.deepEqual(plain(via.lowerLayers), ['SPECIAL8']);
  assert.equal(via.connectivitySource, 'oa-via-definition');
  assert.equal(JSON.stringify(raw), before); assert.equal(result.pins[0], raw.pins[0]);
});
check('Display-only inferred connectors carry no authority for physical tracing', () => {
  const raw = { layers: [8, 9].map((metal) => ({ name: `M${metal}`, kind: 'metal', routing: true, metal })) };
  const result = context.completeRoutingStack(raw);
  const via = result.layers.find((layer) => layer.kind === 'via');
  assert(via.inferred); assert.equal(via.connectivitySource, 'name-inference');
  assert.equal(raw.layers.length, 2);
});
check('Ten-layer calibrated stacks preserve two distinct thick top levels', () => {
  const layers = Array.from({ length: 10 }, (_, index) => ({ name: index < 8 ? `M${index + 1}` : `TM${index - 7}`,
    kind: 'metal', routing: true, metal: index + 1, stackIndex: 2 * index + 3,
    thickness: index < 8 ? 0.2 : 2.4, zBottomUm: index < 8 ? index * 0.4 : 4 + (index - 8) * 3,
    zTopUm: index < 8 ? index * 0.4 + 0.2 : 6.4 + (index - 8) * 3 }));
  context.currentData = context.completeRoutingStack({ technology: { profile: 'synthetic-ten-metal' }, layers });
  context.rebuildLayerMeta();
  assert.equal(context.layerMeta.get('TM1').metal, 9);
  assert.equal(context.layerMeta.get('TM2').metal, 10);
  assert.equal(context.layerMeta.get('TM1').base, 4);
  assert.equal(context.layerMeta.get('TM2').base, 7);
  assert(Math.abs(context.layerVisualHeight('TM2') - 2.4) < 1e-12);
});
check('PDK-specific fallback thickness cannot suppress the approximate-stack warning', () => {
  const data = { technology: { profile: 'synthetic-known-pdk' } };
  assert.match(context.approximateStackWarning(data, [{ routing: true, approximate: true }]), /Approximate PDK stack/);
  assert.match(context.approximateStackWarning(data, [{ routing: true, thicknessSource: 'custom65-fallback' }]), /Approximate PDK stack/);
  assert.equal(context.approximateStackWarning(data, [{ routing: true, approximate: false, thicknessSource: 'verified-stack' }]), '');
  assert.match(context.approximateStackWarning(data, [{ routing: true, geometryApproximate: true }]), /XY dimensions match/);
  assert.match(context.approximateStackWarning({ technology: { profile: 'verified', approximateLayers: ['M9'] } }, []), /Z heights/);
  assert.match(context.approximateStackWarning({ technology: { profile: 'verified', unresolvedStackLayers: ['CTM', 'CBM'] } }, []), /position unconfirmed.*CTM, CBM/);
  assert.equal(context.approximateStackWarning(data, [{ routing: false, geometryApproximate: true }]), '');
});
check('Motion preview keeps the actual top metals even when names are TM1/TM2', () => {
  // Real runtime topology may know named top layers and stack order without assigning a metal number.
  for (const name of ['TM1', 'TM2']) context.layerMeta.get(name).metal = null;
  context.routingLayerGroups = new Map(['M6', 'M7', 'M8', 'TM1', 'TM2'].map((name) => [name, { visible: true }]));
  context.beginFastMode();
  assert.deepEqual([...context.routingLayerGroups].filter(([, group]) => group.visible).map(([name]) => name), ['M8', 'TM1', 'TM2']);
});
check('Unresolved conductor heights cannot shift known layers or be enabled by All', () => {
  const layers = [{ name: 'CTM', kind: 'metal', routing: true, stackIndex: -4, stackSource: 'unresolved', thickness: 4, defaultVisible: false },
    { name: 'CBM', kind: 'metal', routing: true, stackIndex: -4, stackSource: 'unresolved', thickness: 4, defaultVisible: false },
    { name: 'M1', kind: 'metal', routing: true, stackIndex: 3, thickness: 0.2 },
    { name: 'M2', kind: 'metal', routing: true, stackIndex: 5, thickness: 0.3 }];
  assert.equal(context.defaultLayerVisibility(layers[0]), false);
  assert.equal(context.defaultLayerVisibility({ name: 'M1', kind: 'metal', routing: true, defaultVisible: false }), false);
  assert.equal(context.defaultLayerVisibility(layers[2]), true);
  const before = JSON.stringify(layers);
  context.currentData = context.completeRoutingStack({ technology: { profile: 'synthetic' }, layers: layers.slice(2) });
  context.rebuildLayerMeta(); const knownM2Base = context.layerMeta.get('M2').base;
  context.currentData = context.completeRoutingStack({ technology: { profile: 'synthetic' }, layers });
  context.layerVisibility = new Map(); context.rebuildLayerMeta();
  assert.equal(context.layerMeta.get('M1').base, 0); assert.equal(context.layerMeta.get('M2').base, knownM2Base);
  assert.equal(context.layerMeta.get('CTM').routing, true); assert.equal(context.layerVisibility.get('CTM'), false);
  context.updateLayerVisibility = (name, visible) => context.layerVisibility.set(name, visible);
  context.updateLayerPanel = () => {};
  context.setAllLayersVisible(true);
  assert.equal(context.layerVisibility.get('CTM'), false); assert.equal(context.layerVisibility.get('M1'), true);
  assert.equal(JSON.stringify(layers), before);
});
console.log(`Layer-stack regressions passed (${checks} groups)`);
