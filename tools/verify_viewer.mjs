#!/usr/bin/env node
import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { chromium } from 'playwright-core';

const MIB = 1024 * 1024;
const DEFAULT_URL = 'http://127.0.0.1:5177/';
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_PROFILE = { id: 'synthetic-demo', synthetic: true };
const VIEWPORT = { width: 1440, height: 980 };
const VERBOSE = process.env.VL3D_VERIFY_PROGRESS === '1';
const OA_INTEGRATION_PATHS = {
  primaryLibrary: process.env.VL3D_VERIFY_PRIMARY_LIBRARY || '',
  cdsLib: process.env.VL3D_VERIFY_CDS_LIB || '',
  cadenceEnv: process.env.VL3D_VERIFY_CADENCE_ENV || '',
  secondaryLibrary: process.env.VL3D_VERIFY_SECONDARY_LIBRARY || '',
};
const MOCK_OA_PATHS = {
  primaryLibrary: '/vl3d-self-test/LIB_A',
  cdsLib: '/vl3d-self-test/cds.lib',
  cadenceEnv: '/vl3d-self-test/cadence.env',
  secondaryLibrary: '/vl3d-self-test/LIB_B',
};

function progress(profile, stage) {
  if (VERBOSE) process.stderr.write(`[verify ${profile.id}] ${stage}\n`);
}

const PROFILES = [];
const ALL_PROFILES = PROFILES;

const PROFILE_ALIASES = new Map();
for (const profile of ALL_PROFILES) {
  for (const alias of [profile.key, profile.id, profile.cell, `${profile.library}/${profile.cell}`]) {
    const normalized = alias.toLowerCase();
    if (!PROFILE_ALIASES.has(normalized)) PROFILE_ALIASES.set(normalized, profile);
  }
}

function usage() {
  return `Usage: node tools/verify_viewer.mjs [options]

Options:
  --profile <demo>      Default demo uses only public synthetic examples
  --with-oa-integration Exercise real OA library discovery (requires VL3D_VERIFY_* paths)
  --url <viewer-url>    Viewer base URL (default ${DEFAULT_URL})
  --cell <cell>         Legacy profile selection by cell
  --library <library>   Expected library when using --cell
  --no-screenshot       Skip screenshot creation
  --help                Show this help`;
}

function parseArgs(argv) {
  const options = {
    url: DEFAULT_URL,
    profile: '',
    cell: '',
    library: '',
    withOaIntegration: false,
    screenshot: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--url') options.url = argv[++index];
    else if (argument === '--profile') options.profile = argv[++index];
    else if (argument === '--cell') options.cell = argv[++index];
    else if (argument === '--library') options.library = argv[++index];
    else if (argument === '--with-oa-integration') options.withOaIntegration = true;
    else if (argument === '--no-screenshot') options.screenshot = false;
    else if (argument === '--help' || argument === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}\n${usage()}`);
    }
  }
  return options;
}

function oaPaths(options) {
  if (!options.withOaIntegration) return MOCK_OA_PATHS;
  const missing = ['primaryLibrary', 'secondaryLibrary'].filter((key) => !OA_INTEGRATION_PATHS[key]);
  if (missing.length) {
    throw new Error(`--with-oa-integration requires ${missing.map((key) => (
      key === 'primaryLibrary' ? 'VL3D_VERIFY_PRIMARY_LIBRARY' : 'VL3D_VERIFY_SECONDARY_LIBRARY'
    )).join(' and ')}`);
  }
  return OA_INTEGRATION_PATHS;
}

function resolveProfile(value, library = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (library) {
    const exact = PROFILE_ALIASES.get(`${library}/${value}`.toLowerCase());
    if (exact) return exact;
  }
  return PROFILE_ALIASES.get(normalized) || null;
}

function selectedProfiles(options) {
  const urlCell = new URL(options.url).searchParams.get('cell') || '';
  const requested = options.profile || options.cell || urlCell || 'demo';
  if (['demo', 'synthetic', 'synthetic-demo'].includes(String(requested).toLowerCase())) return [PUBLIC_PROFILE];
  const profile = resolveProfile(requested, options.library);
  if (!profile) throw new Error(`Unknown verification profile: ${requested}`);
  if (options.library && profile.library !== options.library) {
    throw new Error(`Profile ${profile.id} does not match --library ${options.library}`);
  }
  if (options.cell && profile.cell.toLowerCase() !== options.cell.toLowerCase()) {
    throw new Error(`Profile ${profile.id} does not match --cell ${options.cell}`);
  }
  return [profile];
}

function profileUrl(baseUrl, profile) {
  const url = new URL(baseUrl);
  url.searchParams.set('library', profile.library);
  url.searchParams.set('cell', profile.cell);
  url.searchParams.set('view', 'layout');
  return url.toString();
}

function chromiumExecutable() {
  const candidates = [
    process.env.CHROMIUM_BIN,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/opt/google/chrome/chrome',
    '/snap/bin/chromium',
    '/usr/local/bin/chromium',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through common local Chromium locations.
    }
  }
  throw new Error(`No executable Chromium found. Checked: ${candidates.join(', ')}`);
}

function assert(condition, message, context = undefined) {
  if (condition) return;
  const suffix = context === undefined ? '' : `: ${JSON.stringify(context)}`;
  throw new Error(`${message}${suffix}`);
}

function assertAtMost(value, maximum, label, context = undefined) {
  assert(Number.isFinite(value), `${label} is unavailable`, context);
  assert(value <= maximum, `${label} exceeded ${maximum}`, { value, maximum, ...context });
}

function stateSnapshot(state) {
  return {
    library: state.library,
    cell: state.cell,
    shapes: state.totalShapes,
    sourceShapes: state.sourceShapeCount,
    instances: state.instanceOverlays,
    pins: state.pins,
    connections: state.connections,
    connectivityMode: state.connectivityMode,
    visibleRecords: state.visibleRecords,
    drawCalls: state.drawCalls,
    triangles: state.triangles,
    renderMs: state.renderMs,
    renderSerial: state.renderSerial,
    loadMs: state.loadMs,
    buildMs: state.buildMs,
    fastMode: state.fastMode,
    fastDraftLayers: state.fastDraftLayers,
    viaMerge: state.viaMerge,
    visiblePinMarkers: state.visiblePinMarkers,
    globalPinMarkers: state.globalPinMarkers,
    pinsVisible: state.pinsVisible,
    layerAdjusting: state.layerAdjusting,
    preparePending: state.preparePending,
    pendingLayoutKey: state.pendingLayoutKey,
    selectedLayoutKey: state.selectedLayoutKey,
    highlightedMasterKey: state.highlightedMasterKey,
    highlightedMasterInstances: state.highlightedMasterInstances,
    idleRender: state.idleRender,
  };
}

async function readState(page) {
  return page.evaluate(() => window.__VL3D_STATE);
}

async function waitForNextRender(page, previousSerial, timeout) {
  await page.waitForFunction((serial) => (
    window.__VL3D_STATE?.renderSerial > serial
    && window.__VL3D_STATE?.idleRender === true
  ), previousSerial, { timeout });
  return readState(page);
}

async function renderedAction(page, label, action, timeout) {
  const before = await readState(page);
  assert(Number.isFinite(before?.renderSerial), `${label}: renderSerial unavailable`, before);
  const startedAt = Date.now();
  const actionResult = await action();
  const state = await waitForNextRender(page, before.renderSerial, timeout);
  return {
    label,
    wallMs: Date.now() - startedAt,
    actionResult,
    state,
  };
}

async function withTimeout(promise, timeout, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout} ms`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function setCheckbox(page, selector, checked, timeout) {
  const current = await page.$eval(selector, (input) => input.checked);
  if (current === checked) return { state: await readState(page), wallMs: 0 };
  return renderedAction(page, `${selector}=${checked}`, () => page.$eval(selector, (input) => input.click()), timeout);
}

function layoutIdentity(key) {
  const [library, cell, view] = String(key || '').split('/');
  return { library, cell, view };
}

function geometrySnapshot(state) {
  return {
    totalShapes: state.totalShapes,
    sourceShapeCount: state.sourceShapeCount,
    shapeMeshes: state.shapeMeshes,
    connectorMeshes: state.connectorMeshes,
  };
}

function selectionSnapshot(state) {
  return {
    selectedInstances: state.selectedInstances,
    selectedNets: state.selectedNets,
  };
}

function coreStateSnapshot(state) {
  return {
    library: state.library,
    cell: state.cell,
    selectedLayoutKey: state.selectedLayoutKey,
    ...geometrySnapshot(state),
    instanceOverlays: state.instanceOverlays,
    pins: state.pins,
    connections: state.connections,
    connectivityMode: state.connectivityMode,
    visibleRecords: state.visibleRecords,
    triangles: state.triangles,
    ...selectionSnapshot(state),
    visiblePinMarkers: state.visiblePinMarkers,
    globalPinMarkers: state.globalPinMarkers,
    pinsVisible: state.pinsVisible,
    highlightedMasterKey: state.highlightedMasterKey,
    highlightedMasterInstances: state.highlightedMasterInstances,
    viaMerge: state.viaMerge,
  };
}

function assertSameGeometry(actualState, expectedGeometry, label) {
  const actualGeometry = geometrySnapshot(actualState);
  assert(
    Object.keys(expectedGeometry).every((key) => actualGeometry[key] === expectedGeometry[key]),
    `${label}: geometry totals changed`,
    { expectedGeometry, actualGeometry },
  );
}

function assertSameSelection(actualState, expectedSelection, label) {
  const actualSelection = selectionSnapshot(actualState);
  assert(
    Object.keys(expectedSelection).every((key) => actualSelection[key] === expectedSelection[key]),
    `${label}: selection changed`,
    { expectedSelection, actualSelection },
  );
}

function assertSameCoreState(actualState, expectedCoreState, label) {
  const actualCoreState = coreStateSnapshot(actualState);
  assert(
    Object.keys(expectedCoreState).every((key) => actualCoreState[key] === expectedCoreState[key]),
    `${label}: core state changed`,
    { expectedCoreState, actualCoreState },
  );
}

async function waitForFullIdle(page, timeout, minimumSerial = -1) {
  await page.waitForFunction((serial) => {
    const state = window.__VL3D_STATE;
    return state?.fastMode === false
      && state?.layerAdjusting === false
      && state?.idleRender === true
      && state.renderSerial >= serial;
  }, minimumSerial, { timeout });
  return readState(page);
}

async function canvasGesturePoint(page) {
  const bounds = await page.locator('#scene').boundingBox();
  assert(bounds, 'scene canvas has no bounding box');
  const point = await page.evaluate(({ box, candidates }) => {
    const canvas = document.querySelector('#scene');
    for (const [xRatio, yRatio] of candidates) {
      const x = box.x + box.width * xRatio;
      const y = box.y + box.height * yRatio;
      if (document.elementFromPoint(x, y) === canvas) return { x, y };
    }
    return null;
  }, {
    box: bounds,
    candidates: [[0.5, 0.5], [0.65, 0.15], [0.7, 0.85], [0.4, 0.1]],
  });
  assert(point, 'no unobstructed canvas gesture point is available', bounds);
  return point;
}

async function probeCanvasGesture(page, jitterPixels, timeout) {
  const before = await waitForFullIdle(page, timeout);
  const expectedSelection = selectionSnapshot(before);
  const point = await canvasGesturePoint(page);
  const monitorMs = 500;
  const startedAt = Date.now();
  await page.evaluate((duration) => {
    const probe = {
      done: false,
      sawFast: false,
      maxDraftLayers: 0,
    };
    window.__VL3D_GESTURE_PROBE = probe;
    const deadline = performance.now() + duration;
    const sample = () => {
      const state = window.__VL3D_STATE;
      probe.sawFast ||= state?.fastMode === true;
      probe.maxDraftLayers = Math.max(probe.maxDraftLayers, Number(state?.fastDraftLayers || 0));
      if (performance.now() < deadline) requestAnimationFrame(sample);
      else probe.done = true;
    };
    requestAnimationFrame(sample);
  }, monitorMs);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  if (jitterPixels > 0) {
    await page.mouse.move(point.x + jitterPixels, point.y, { steps: 2 });
  }
  await page.waitForTimeout(50);
  await page.mouse.up();
  await page.waitForFunction(() => window.__VL3D_GESTURE_PROBE?.done === true, undefined, { timeout });
  const probe = await page.evaluate(() => window.__VL3D_GESTURE_PROBE);
  const after = await waitForFullIdle(page, timeout, before.renderSerial);
  assert(!probe.sawFast && probe.maxDraftLayers === 0, `${jitterPixels}px canvas gesture entered fast mode`, probe);
  assertSameSelection(after, expectedSelection, `${jitterPixels}px canvas gesture`);
  return {
    jitterPixels,
    wallMs: Date.now() - startedAt,
    sawFast: probe.sawFast,
    maxDraftLayers: probe.maxDraftLayers,
    renderDelta: after.renderSerial - before.renderSerial,
    ...selectionSnapshot(after),
  };
}

function vectorDelta(value, baseline) {
  return value.map((entry, index) => entry - baseline[index]);
}

function vectorNorm(value) {
  return Math.sqrt(value.reduce((sum, entry) => sum + entry * entry, 0));
}

function vectorCosine(first, second) {
  const denominator = vectorNorm(first) * vectorNorm(second);
  return denominator > 0
    ? first.reduce((sum, entry, index) => sum + entry * second[index], 0) / denominator
    : Number.NaN;
}

function assertOppositeCameraEffects(normal, reversed, label) {
  assert(normal.uniform === reversed.uniform, `${label}: camera probe uniform changed`, { normal, reversed });
  assert(normal.baseline.length === reversed.baseline.length, `${label}: camera probe size changed`, { normal, reversed });
  const baselineDrift = vectorNorm(vectorDelta(normal.baseline, reversed.baseline));
  const normalDelta = vectorDelta(normal.camera, normal.baseline);
  const reversedDelta = vectorDelta(reversed.camera, reversed.baseline);
  const normalNorm = vectorNorm(normalDelta);
  const reversedNorm = vectorNorm(reversedDelta);
  const cosine = vectorCosine(normalDelta, reversedDelta);
  assert(baselineDrift <= 0.002, `${label}: reset camera baseline drifted`, { baselineDrift, normal, reversed });
  assert(normalNorm > 0.0001 && reversedNorm > 0.0001, `${label}: camera did not move`, {
    normalNorm,
    reversedNorm,
    normal,
    reversed,
  });
  assert(cosine <= -0.7, `${label}: reverse control did not reverse camera motion`, {
    cosine,
    normalNorm,
    reversedNorm,
    normal,
    reversed,
  });
  return {
    cosine: Number(cosine.toFixed(4)),
    normalMagnitude: Number(normalNorm.toFixed(6)),
    reversedMagnitude: Number(reversedNorm.toFixed(6)),
  };
}

async function readCameraProbe(page) {
  const probe = await page.evaluate(() => {
    const canvas = document.querySelector('#scene');
    const gl = canvas?.getContext('webgl2') || canvas?.getContext('webgl');
    const program = gl?.getParameter(gl.CURRENT_PROGRAM);
    if (!gl || !program) return null;
    const uniforms = new Map();
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let index = 0; index < count; index += 1) {
      const info = gl.getActiveUniform(program, index);
      const name = info?.name?.replace(/\[0\]$/, '');
      if (!name || !['cameraPosition', 'viewMatrix', 'modelViewMatrix'].includes(name)) continue;
      const value = gl.getUniform(program, gl.getUniformLocation(program, name));
      const entries = ArrayBuffer.isView(value) ? [...value] : [value];
      if (entries.every(Number.isFinite)) uniforms.set(name, entries);
    }
    for (const name of ['cameraPosition', 'viewMatrix', 'modelViewMatrix']) {
      if (uniforms.has(name)) return { uniform: name, values: uniforms.get(name) };
    }
    return null;
  });
  assert(probe?.values?.length, 'camera WebGL uniform is unavailable', probe);
  return probe;
}

async function setNavigationPreset(page, mode) {
  await page.$eval('#navigationModeSelect', (select, nextMode) => {
    select.value = nextMode;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, mode);
  const expected = mode === 'cad'
    ? { mode: 'cad', invertOrbitX: false, invertOrbitY: false, invertPan: false, invertWheel: false }
    : { mode: 'natural', invertOrbitX: true, invertOrbitY: true, invertPan: false, invertWheel: false };
  await page.waitForFunction((settings) => (
    Object.entries(settings).every(([key, value]) => window.__VL3D_STATE?.navigation?.[key] === value)
  ), expected, { timeout: 1000 });
  const observed = await page.evaluate(() => ({
    state: window.__VL3D_STATE.navigation,
    stored: JSON.parse(localStorage.getItem('vl3d.navigation.v2') || 'null'),
    summary: document.querySelector('#navigationSummary')?.textContent,
    controls: {
      mode: document.querySelector('#navigationModeSelect')?.value,
      invertOrbitX: document.querySelector('#invertOrbitXToggle')?.checked,
      invertOrbitY: document.querySelector('#invertOrbitYToggle')?.checked,
      invertPan: document.querySelector('#invertPanToggle')?.checked,
      invertWheel: document.querySelector('#invertWheelToggle')?.checked,
    },
  }));
  assert(Object.entries(expected).every(([key, value]) => observed.state?.[key] === value),
    `${mode} preset state is incorrect`, observed);
  assert(Object.entries(expected).every(([key, value]) => observed.stored?.[key] === value),
    `${mode} preset was not persisted`, observed);
  assert(Object.entries(expected).every(([key, value]) => observed.controls?.[key] === value),
    `${mode} preset controls are out of sync`, observed);
  assert(observed.summary === (mode === 'cad' ? 'CAD' : 'Natural'), `${mode} preset summary is incorrect`, observed);
  return observed;
}

async function setNavigationOverride(page, selector, stateKey, checked) {
  await page.$eval(selector, (input, nextChecked) => {
    input.checked = nextChecked;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, checked);
  await page.waitForFunction(({ key, value }) => (
    window.__VL3D_STATE?.navigation?.[key] === value
  ), { key: stateKey, value: checked }, { timeout: 1000 });
  const observed = await page.evaluate(({ key, controlSelector }) => ({
    state: window.__VL3D_STATE.navigation?.[key],
    stored: JSON.parse(localStorage.getItem('vl3d.navigation.v2') || 'null')?.[key],
    control: document.querySelector(controlSelector)?.checked,
  }), { key: stateKey, controlSelector: selector });
  assert(observed.state === checked && observed.stored === checked && observed.control === checked,
    `${stateKey} override is out of sync`, observed);
}

async function resetCameraProbe(page, timeout) {
  const reset = await renderedAction(
    page,
    'reset-camera-probe',
    () => page.$eval('#resetBtn', (button) => button.click()),
    timeout,
  );
  const camera = await readCameraProbe(page);
  return { state: reset.state, uniform: camera.uniform, values: camera.values };
}

async function performNavigationProbe(page, options, timeout) {
  const baseline = await resetCameraProbe(page, timeout);
  const expectedSelection = selectionSnapshot(baseline.state);
  const point = await canvasGesturePoint(page);
  const startedAt = Date.now();
  if (options.kind === 'wheel') {
    await page.$eval('#scene', (canvas, input) => {
      for (let index = 0; index < input.events; index += 1) {
        canvas.dispatchEvent(new WheelEvent('wheel', {
          deltaY: input.deltaY,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          bubbles: true,
          cancelable: true,
        }));
      }
    }, options);
  } else {
    if (options.pan) await page.keyboard.down('Shift');
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + (options.deltaX || 0), point.y + (options.deltaY || 0), { steps: 1 });
  }
  await page.waitForFunction((serial) => (
    window.__VL3D_STATE?.renderSerial > serial
    && window.__VL3D_STATE?.fastMode === true
    && window.__VL3D_STATE?.idleRender === true
  ), baseline.state.renderSerial, { timeout });
  const fastState = await readState(page);
  const camera = await readCameraProbe(page);
  assert(camera.uniform === baseline.uniform, `${options.label}: camera probe uniform changed during input`, {
    baseline: baseline.uniform,
    camera: camera.uniform,
  });
  const firstFrameMs = Date.now() - startedAt;
  if (options.kind !== 'wheel') {
    await page.mouse.up();
    if (options.pan) await page.keyboard.up('Shift');
  }
  const restored = await waitForFullIdle(page, timeout, fastState.renderSerial + 1);
  assertSameSelection(restored, expectedSelection, `${options.label} navigation`);
  return {
    label: options.label,
    uniform: baseline.uniform,
    baseline: baseline.values,
    camera: camera.values,
    firstFrameMs,
    fastRenderMs: fastState.renderMs,
    fastRenderDelta: fastState.renderSerial - baseline.state.renderSerial,
    fastDraftLayers: fastState.fastDraftLayers,
    restoreRenderDelta: restored.renderSerial - fastState.renderSerial,
  };
}

async function exerciseNavigationControls(page, profile, timeout) {
  const natural = await setNavigationPreset(page, 'natural');
  const naturalOrbitX = await performNavigationProbe(page, {
    label: 'natural-orbit-x',
    kind: 'drag',
    deltaX: 20,
    deltaY: 0,
  }, timeout);
  const cad = await setNavigationPreset(page, 'cad');
  const cadOrbitX = await performNavigationProbe(page, {
    label: 'cad-orbit-x',
    kind: 'drag',
    deltaX: 20,
    deltaY: 0,
  }, timeout);
  const presetOrbitXDirection = assertOppositeCameraEffects(cadOrbitX, naturalOrbitX, 'Natural/CAD horizontal orbit');
  await setNavigationOverride(page, '#invertOrbitXToggle', 'invertOrbitX', true);
  const orbitXReversed = await performNavigationProbe(page, {
    label: 'reverse-orbit-x',
    kind: 'drag',
    deltaX: 20,
    deltaY: 0,
  }, timeout);
  const orbitXDirection = assertOppositeCameraEffects(cadOrbitX, orbitXReversed, 'horizontal orbit');
  await setNavigationOverride(page, '#invertOrbitXToggle', 'invertOrbitX', false);

  const orbitYNormal = await performNavigationProbe(page, {
    label: 'orbit-y',
    kind: 'drag',
    deltaX: 0,
    deltaY: 20,
  }, timeout);
  await setNavigationOverride(page, '#invertOrbitYToggle', 'invertOrbitY', true);
  const orbitYReversed = await performNavigationProbe(page, {
    label: 'reverse-orbit-y',
    kind: 'drag',
    deltaX: 0,
    deltaY: 20,
  }, timeout);
  const orbitYDirection = assertOppositeCameraEffects(orbitYNormal, orbitYReversed, 'vertical orbit');
  await setNavigationOverride(page, '#invertOrbitYToggle', 'invertOrbitY', false);

  const panNormal = await performNavigationProbe(page, {
    label: 'pan',
    kind: 'drag',
    pan: true,
    deltaX: 20,
    deltaY: 12,
  }, timeout);
  await setNavigationOverride(page, '#invertPanToggle', 'invertPan', true);
  const panReversed = await performNavigationProbe(page, {
    label: 'reverse-pan',
    kind: 'drag',
    pan: true,
    deltaX: 20,
    deltaY: 12,
  }, timeout);
  const panDirection = assertOppositeCameraEffects(panNormal, panReversed, 'pan');
  await setNavigationOverride(page, '#invertPanToggle', 'invertPan', false);

  const wheelNormal = await performNavigationProbe(page, {
    label: 'wheel-burst',
    kind: 'wheel',
    events: 12,
    deltaY: 15,
  }, timeout);
  assertAtMost(wheelNormal.firstFrameMs, Math.max(350, profile.limits.fastEnterMs),
    'wheel burst first-frame wallMs', wheelNormal);
  assert(wheelNormal.fastRenderDelta <= 2, 'wheel burst was not coalesced into one render frame', wheelNormal);
  await setNavigationOverride(page, '#invertWheelToggle', 'invertWheel', true);
  const wheelReversed = await performNavigationProbe(page, {
    label: 'reverse-wheel-burst',
    kind: 'wheel',
    events: 12,
    deltaY: 15,
  }, timeout);
  const wheelDirection = assertOppositeCameraEffects(wheelNormal, wheelReversed, 'wheel zoom');
  await setNavigationOverride(page, '#invertWheelToggle', 'invertWheel', false);

  const restored = await setNavigationPreset(page, 'natural');
  await resetCameraProbe(page, timeout);
  return {
    presets: {
      natural: natural.state,
      cad: cad.state,
      restored: restored.state,
    },
    orbitX: {
      ...orbitXDirection,
      presetCosine: presetOrbitXDirection.cosine,
    },
    orbitY: orbitYDirection,
    pan: panDirection,
    wheel: {
      ...wheelDirection,
      events: 12,
      firstFrameMs: wheelNormal.firstFrameMs,
      fastRenderMs: wheelNormal.fastRenderMs,
      fastRenderDelta: wheelNormal.fastRenderDelta,
      draftLayers: wheelNormal.fastDraftLayers,
    },
  };
}

async function captureSceneContrast(page) {
  const display = await page.evaluate(() => {
    const swatches = [...document.querySelectorAll('.layer-row')].map((row) => (
      `${row.dataset.layer || ''}:${getComputedStyle(row.querySelector('.swatch')).backgroundColor}`
    ));
    return {
      theme: document.querySelector('#themeSelect')?.value || '',
      palette: document.querySelector('#paletteSelect')?.value || '',
      layerColors: new Set(swatches.map((entry) => entry.split(':').slice(1).join(':'))).size,
      swatchSignature: swatches.join('|'),
    };
  });
  const probeStyleId = '__vl3d_visual_probe';
  await page.evaluate((styleId) => {
    document.getElementById(styleId)?.remove();
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = '#app > :not(#scene) { visibility: hidden !important; }';
    document.head.append(style);
  }, probeStyleId);
  let screenshot;
  try {
    await page.waitForTimeout(32);
    screenshot = await page.locator('#scene').screenshot({ type: 'png' });
  } finally {
    await page.evaluate((styleId) => document.getElementById(styleId)?.remove(), probeStyleId);
  }
  const pixels = await page.evaluate(async (dataUrl) => {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = image.naturalWidth;
    sampleCanvas.height = image.naturalHeight;
    const context = sampleCanvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height).data;
    const toHsv = (red, green, blue) => {
      const channels = [red / 255, green / 255, blue / 255];
      const maximum = Math.max(...channels);
      const minimum = Math.min(...channels);
      const delta = maximum - minimum;
      let hue = 0;
      if (delta > 0) {
        if (maximum === channels[0]) hue = 60 * (((channels[1] - channels[2]) / delta) % 6);
        else if (maximum === channels[1]) hue = 60 * (((channels[2] - channels[0]) / delta) + 2);
        else hue = 60 * (((channels[0] - channels[1]) / delta) + 4);
        if (hue < 0) hue += 360;
      }
      return { hue, saturation: maximum ? delta / maximum : 0, value: maximum };
    };
    const hueCounts = new Array(12).fill(0);
    const occupied = new Set();
    let chromaticPixels = 0;
    let darkPixels = 0;
    let brightPixels = 0;
    let brightEdgePixels = 0;
    for (let yPosition = 2; yPosition < sampleCanvas.height - 2; yPosition += 2) {
      for (let xPosition = 2; xPosition < sampleCanvas.width - 2; xPosition += 2) {
        const offset = (yPosition * sampleCanvas.width + xPosition) * 4;
        const color = toHsv(data[offset], data[offset + 1], data[offset + 2]);
        if (color.saturation < 0.2 || color.value < 0.06) continue;
        chromaticPixels += 1;
        hueCounts[Math.floor(color.hue / 30) % hueCounts.length] += 1;
        occupied.add(`${Math.floor(xPosition / sampleCanvas.width * 24)}:${Math.floor(yPosition / sampleCanvas.height * 16)}`);
        if (color.value <= 0.62) darkPixels += 1;
        if (color.value >= 0.72) brightPixels += 1;
        if (color.value < 0.62) continue;
        for (const [xOffset, yOffset] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
          const neighborOffset = ((yPosition + yOffset) * sampleCanvas.width + xPosition + xOffset) * 4;
          const neighbor = toHsv(data[neighborOffset], data[neighborOffset + 1], data[neighborOffset + 2]);
          const hueDistance = Math.min(Math.abs(color.hue - neighbor.hue), 360 - Math.abs(color.hue - neighbor.hue));
          if (neighbor.saturation >= 0.15 && hueDistance <= 18 && color.value - neighbor.value >= 0.16) {
            brightEdgePixels += 1;
            break;
          }
        }
      }
    }
    return {
      chromaticPixels,
      darkPixels,
      brightPixels,
      brightEdgePixels,
      hueBuckets: hueCounts.filter((count) => count >= 20).length,
      hueHistogram: hueCounts,
      occupiedCells: occupied.size,
    };
  }, `data:image/png;base64,${screenshot.toString('base64')}`);
  return {
    ...display,
    ...pixels,
    imageHash: createHash('sha256').update(screenshot).digest('hex'),
  };
}

const DEFAULT_PALETTE = 'classic';
const PALETTE_VALUES = [DEFAULT_PALETTE, 'cyberpunk', 'aurora', 'plasma', 'titanium'];

function histogramDistance(first, second) {
  const delta = first.reduce((total, value, index) => total + Math.abs(value - second[index]), 0);
  const scale = Math.max(
    first.reduce((total, value) => total + value, 0),
    second.reduce((total, value) => total + value, 0),
    1,
  );
  return delta / scale;
}

async function setSelectValue(page, selector, value, timeout) {
  const current = await page.$eval(selector, (select) => select.value);
  if (current === value) return { label: `${selector}=${value}`, wallMs: 0, state: await readState(page) };
  return renderedAction(
    page,
    `${selector}=${value}`,
    () => page.$eval(selector, (select, nextValue) => {
      select.value = nextValue;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }, value),
    timeout,
  );
}

async function exercisePaletteMatrix(page, profile, timeout, initialVisual) {
  const options = await page.$$eval('#paletteSelect option', (entries) => entries.map((entry) => ({
    value: entry.value,
    label: entry.textContent.trim(),
  })));
  assert(options.length === PALETTE_VALUES.length, 'palette dropdown does not expose all five styles', options);
  assert(new Set(options.map((entry) => entry.value)).size === PALETTE_VALUES.length,
    'palette dropdown contains duplicate values', options);
  assert(new Set(options.map((entry) => entry.label)).size === PALETTE_VALUES.length,
    'palette dropdown contains duplicate labels', options);
  assert(PALETTE_VALUES.every((value) => options.some((entry) => entry.value === value)),
    'palette dropdown is missing a required style', options);

  const baseline = await readState(page);
  const expectedCoreState = coreStateSnapshot(baseline);
  const expectedBuildMs = baseline.buildMs;
  const matrix = [];
  const swatchesByTheme = new Map();
  const colorLimitMs = Math.max(250, profile.limits.renderMs);

  for (const theme of ['dark', 'light']) {
    const paletteBeforeTheme = await page.$eval('#paletteSelect', (select) => select.value);
    const themeAction = await setSelectValue(page, '#themeSelect', theme, timeout);
    assert(themeAction.state.theme === theme, 'theme selection did not reach public state', themeAction.state);
    assert(themeAction.state.palette === paletteBeforeTheme, 'theme selection changed the active palette', themeAction.state);
    for (const palette of PALETTE_VALUES) {
      const paletteAction = await setSelectValue(page, '#paletteSelect', palette, timeout);
      assert(paletteAction.state.palette === palette, 'palette selection did not reach public state', paletteAction.state);
      assert(paletteAction.state.theme === theme, 'palette selection changed the active theme', paletteAction.state);
      assert(paletteAction.state.fastMode === false, 'palette selection entered fast mode', paletteAction.state);
      assert(paletteAction.state.buildMs === expectedBuildMs, 'palette selection rebuilt geometry', {
        expectedBuildMs,
        actualBuildMs: paletteAction.state.buildMs,
      });
      assertSameCoreState(paletteAction.state, expectedCoreState, `${theme}/${palette} palette switch`);
      assertAtMost(paletteAction.state.colorMs, colorLimitMs, `${theme}/${palette} colorMs`, paletteAction.state);
      const visual = theme === 'dark' && palette === DEFAULT_PALETTE && initialVisual
        ? initialVisual
        : await captureSceneContrast(page);
      assert(visual.theme === theme && visual.palette === palette, 'visual probe has stale theme or palette', visual);
      assert(visual.layerColors >= 3 && visual.hueBuckets >= 3,
        `${theme}/${palette} lost layer color distinction`, visual);
      assert(visual.chromaticPixels >= 1000 && visual.occupiedCells >= 20,
        `${theme}/${palette} lost recognizable layout coverage`, visual);
      matrix.push({
        theme,
        palette,
        wallMs: paletteAction.wallMs,
        colorMs: paletteAction.state.colorMs,
        imageHash: visual.imageHash,
        swatchSignature: visual.swatchSignature,
        hueHistogram: visual.hueHistogram,
        hueBuckets: visual.hueBuckets,
      });
      if (!swatchesByTheme.has(theme)) swatchesByTheme.set(theme, new Map());
      swatchesByTheme.get(theme).set(palette, visual.swatchSignature);
    }
  }

  for (const theme of ['dark', 'light']) {
    const entries = matrix.filter((entry) => entry.theme === theme);
    assert(new Set(entries.map((entry) => entry.imageHash)).size === PALETTE_VALUES.length,
      `${theme} palette canvases are not distinct`, entries);
    assert(new Set(entries.map((entry) => entry.swatchSignature)).size === PALETTE_VALUES.length,
      `${theme} palette swatches are not distinct`, entries);
    for (let firstIndex = 0; firstIndex < entries.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < entries.length; secondIndex += 1) {
        const distance = histogramDistance(entries[firstIndex].hueHistogram, entries[secondIndex].hueHistogram);
        assert(distance >= 0.06, `${theme} palette hue distributions are too similar`, {
          first: entries[firstIndex].palette,
          second: entries[secondIndex].palette,
          distance,
        });
      }
    }
  }
  for (const palette of PALETTE_VALUES) {
    assert(swatchesByTheme.get('dark').get(palette) === swatchesByTheme.get('light').get(palette),
      `${palette} swatches changed with the UI theme`);
  }

  await setSelectValue(page, '#paletteSelect', DEFAULT_PALETTE, timeout);
  await setSelectValue(page, '#themeSelect', 'dark', timeout);
  const restored = await readState(page);
  assertSameCoreState(restored, expectedCoreState, 'palette matrix restore');
  return {
    options,
    combinations: matrix.map((entry) => ({
      theme: entry.theme,
      palette: entry.palette,
      wallMs: entry.wallMs,
      colorMs: entry.colorMs,
      hueBuckets: entry.hueBuckets,
      imageHash: entry.imageHash.slice(0, 16),
    })),
  };
}

async function dragIntoFastMode(page, previousSerial, timeout) {
  const canvasBounds = await page.locator('#scene').boundingBox();
  assert(canvasBounds, 'scene canvas has no bounding box');
  await page.mouse.move(
    canvasBounds.x + canvasBounds.width * 0.52,
    canvasBounds.y + canvasBounds.height * 0.48,
  );
  await page.mouse.down();
  const startedAt = Date.now();
  await page.mouse.move(
    canvasBounds.x + canvasBounds.width * 0.61,
    canvasBounds.y + canvasBounds.height * 0.56,
    { steps: 1 },
  );
  await page.waitForFunction((serial) => (
    window.__VL3D_STATE?.renderSerial > serial
    && window.__VL3D_STATE?.fastMode === true
    && window.__VL3D_STATE?.idleRender === true
  ), previousSerial, { timeout });
  return {
    ...await readState(page),
    firstFrameMs: Date.now() - startedAt,
  };
}

async function releaseFastMode(page, fastSerial, timeout) {
  const startedAt = Date.now();
  await page.mouse.up();
  await page.waitForFunction((serial) => (
    window.__VL3D_STATE?.renderSerial > serial
    && window.__VL3D_STATE?.fastMode === false
    && window.__VL3D_STATE?.idleRender === true
  ), fastSerial, { timeout });
  return {
    wallMs: Date.now() - startedAt,
    state: await readState(page),
  };
}

async function exerciseScaleControl(page, selector, profile, timeout) {
  const before = await waitForFullIdle(page, timeout);
  const expectedGeometry = geometrySnapshot(before);
  const control = await page.$eval(selector, (input) => {
    const oldValue = Number(input.value);
    const step = Number(input.step || 0.1);
    const minimum = Number(input.min);
    const maximum = Number(input.max);
    const nextValue = oldValue + step <= maximum ? oldValue + step : Math.max(minimum, oldValue - step);
    return { oldValue, nextValue };
  });
  const previewStartedAt = Date.now();
  await page.$eval(selector, (input, value) => {
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, control.nextValue);
  await page.waitForFunction((serial) => (
    window.__VL3D_STATE?.renderSerial > serial
    && window.__VL3D_STATE?.layerAdjusting === true
    && window.__VL3D_STATE?.idleRender === true
  ), before.renderSerial, { timeout });
  const previewMs = Date.now() - previewStartedAt;
  const preview = await readState(page);
  assertAtMost(previewMs, profile.limits.scalePreviewMs, `${selector} preview wallMs`, {
    profile: profile.id,
    preview: stateSnapshot(preview),
  });
  assertSameGeometry(preview, expectedGeometry, `${selector} preview`);

  const commitStartedAt = Date.now();
  await page.$eval(selector, (input) => input.dispatchEvent(new Event('change', { bubbles: true })));
  await page.waitForFunction((serial) => (
    window.__VL3D_STATE?.renderSerial > serial
    && window.__VL3D_STATE?.layerAdjusting === false
    && window.__VL3D_STATE?.fastMode === false
    && window.__VL3D_STATE?.idleRender === true
  ), preview.renderSerial, { timeout });
  const committed = await readState(page);
  const commitMs = Date.now() - commitStartedAt;
  assertAtMost(commitMs, profile.limits.scaleCommitMs, `${selector} commit wallMs`, {
    profile: profile.id,
    committed: stateSnapshot(committed),
  });
  assertSameGeometry(committed, expectedGeometry, `${selector} commit`);
  assert(committed.triangles === before.triangles, `${selector}: full triangle count changed`, {
    before: before.triangles,
    committed: committed.triangles,
  });
  return {
    from: control.oldValue,
    to: control.nextValue,
    previewMs,
    previewRenderMs: preview.renderMs,
    commitMs,
    triangles: committed.triangles,
  };
}

async function exerciseMasterQuickSelect(page, timeout) {
  const master = await page.$eval('#highlightSelect', (select) => (
    [...select.options].find((option) => option.value)?.value || ''
  ));
  assert(master, 'master quick select has no selectable master');
  const selected = await renderedAction(
    page,
    'master-quick-select',
    () => page.$eval('#highlightSelect', (select, value) => {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }, master),
    timeout,
  );
  assert(selected.state.highlightedMasterKey === master, 'master quick select did not highlight its master', {
    master,
    state: selected.state,
  });
  assert(selected.state.highlightedMasterInstances > 0, 'master quick select matched no visible instances', {
    master,
    state: selected.state,
  });
  assert(selected.state.fastMode === false, 'master quick select unexpectedly entered fast mode', selected.state);
  const cleared = await renderedAction(
    page,
    'master-quick-clear',
    () => page.$eval('#highlightSelect', (select) => {
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }),
    timeout,
  );
  assert(cleared.state.highlightedMasterKey === '', 'master quick select did not clear', cleared.state);
  assert(cleared.state.highlightedMasterInstances === 0, 'master quick select left highlighted instances after clear', cleared.state);
  assert(cleared.state.fastMode === false, 'master quick clear unexpectedly entered fast mode', cleared.state);
  await waitForFullIdle(page, timeout);
  return {
    master,
    highlightedInstances: selected.state.highlightedMasterInstances,
    selectMs: selected.wallMs,
    clearMs: cleared.wallMs,
  };
}

async function chooseHierarchyCandidate(page, search, preferredPath = '') {
  return page.evaluate(({ query, exactPath }) => {
    const input = document.querySelector('#hierarchySearch');
    input.value = query;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    let rows = [...document.querySelectorAll('.hierarchy-row')];
    if (!rows.length) {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      rows = [...document.querySelectorAll('.hierarchy-row')];
    }
    const exact = rows.find((row) => row.dataset.path === exactPath);
    const preferred = rows.find((row) => /rf[ np]?mos|mos2v/i.test(row.querySelector('.hierarchy-master')?.textContent || ''));
    const row = exact || preferred || rows[0];
    return row ? {
      path: row.dataset.path,
      master: row.querySelector('.hierarchy-master')?.textContent || '',
    } : null;
  }, { query: search, exactPath: preferredPath });
}

async function clickHierarchyCandidate(page, candidate) {
  return page.evaluate((path) => {
    const row = [...document.querySelectorAll('.hierarchy-row')].find((entry) => entry.dataset.path === path);
    const button = row?.querySelector('.hierarchy-item');
    if (!button) throw new Error(`Hierarchy row disappeared: ${path}`);
    button.click();
    return path;
  }, candidate.path);
}

async function waitForLayoutIdentity(page, key, timeout) {
  const identity = layoutIdentity(key);
  await page.waitForFunction(({ expectedKey, expectedIdentity }) => {
    const state = window.__VL3D_STATE;
    const select = document.querySelector('#cellSelect');
    return state?.library === expectedIdentity.library
      && state?.cell === expectedIdentity.cell
      && state?.view === expectedIdentity.view
      && state?.selectedLayoutKey === expectedKey
      && select?.value === expectedKey
      && state.shapeMeshes > 0
      && state.idleRender === true
      && state.preparePending === false;
  }, { expectedKey: key, expectedIdentity: identity }, { timeout });
  return readState(page);
}

async function switchToReadyCellAndBack(page, profile, timeout) {
  const originalKey = `${profile.library}/${profile.cell}/layout`;
  const original = await readState(page);
  assert(original.selectedLayoutKey === originalKey, 'initial selected layout identity is incomplete', {
    originalKey,
    state: original,
  });
  const alternative = await page.$eval('#cellSelect', (select, currentKey) => {
    const candidates = [...select.options]
      .filter((option) => option.value !== currentKey && / · ready(?: ·|$)/.test(option.textContent || ''))
      .map((option) => {
        const count = Number((option.textContent || '').match(/ · ([0-9]+)$/)?.[1] || Number.MAX_SAFE_INTEGER);
        return { key: option.value, count };
      })
      .filter((option) => option.key.split('/').length === 3 && option.count > 0)
      .sort((first, second) => first.count - second.count || first.key.localeCompare(second.key));
    return candidates[0] || null;
  }, originalKey);
  assert(alternative, 'no second ready layout is available for same-page switching', { originalKey });

  const switchAwayStartedAt = Date.now();
  await page.$eval('#cellSelect', (select, key) => {
    select.value = key;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, alternative.key);
  await page.click('#openCellBtn');
  const away = await waitForLayoutIdentity(page, alternative.key, timeout);
  const switchAwayMs = Date.now() - switchAwayStartedAt;

  const switchBackStartedAt = Date.now();
  await page.$eval('#cellSelect', (select, key) => {
    select.value = key;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, originalKey);
  await page.click('#openCellBtn');
  const returned = await waitForLayoutIdentity(page, originalKey, timeout);
  const switchBackMs = Date.now() - switchBackStartedAt;
  assertSameGeometry(returned, geometrySnapshot(original), 'same-page switch return');
  assert(returned.library === profile.library && returned.cell === profile.cell && returned.view === 'layout',
    'same-page switch did not restore the complete identity', returned);
  return {
    originalKey,
    alternativeKey: alternative.key,
    switchAwayMs,
    switchBackMs,
    awayIdentity: `${away.library}/${away.cell}/${away.view}`,
    returnedIdentity: `${returned.library}/${returned.cell}/${returned.view}`,
  };
}

async function installMockLibraryApi(page, options) {
  const manifestUrl = new URL('/public/data/manifest.json', options.url).href;
  const response = await page.request.get(manifestUrl);
  assert(response.ok(), 'self-contained library mock could not read the layout manifest', {
    url: manifestUrl,
    status: response.status(),
  });
  const manifest = await response.json();
  const entries = Array.isArray(manifest?.cells) ? manifest.cells : [];
  let sessionSerial = 0;
  let currentSession = null;
  let forbiddenPrepareRequests = 0;

  function recordsFor(library) {
    const records = entries
      .filter((entry) => entry.library === library)
      .map((entry) => ({
        key: `${entry.library}/${entry.cell}/${entry.view || 'layout'}`,
        library: entry.library,
        cell: entry.cell,
        view: entry.view || 'layout',
        sourceType: 'oa',
        cacheState: 'ready',
        entry,
      }));
    if (library === 'LIB_B' && !records.some((record) => record.cell === 'cell_b')) {
      records.push({
        key: 'LIB_B/diodep/layout',
        library: 'LIB_B',
        cell: 'cell_b',
        view: 'layout',
        sourceType: 'oa',
        cacheState: 'missing',
      });
    }
    return records;
  }

  await page.route('**/api/libraries/state', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ apiVersion: 2, oaEnabled: true, current: currentSession }),
  }));
  await page.route('**/api/library-sessions', async (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ status: 405, body: '{}' });
    const request = route.request().postDataJSON();
    const library = request?.overrides?.libraryName || '';
    sessionSerial += 1;
    currentSession = {
      sessionId: sessionSerial.toString(16).padStart(48, '0'),
      library: { name: library, path: request?.path || '' },
      layouts: recordsFor(library),
      resolved: {
        cdsLib: request?.overrides?.cdsLib || '',
        cadenceEnv: request?.overrides?.cadenceEnv || '',
      },
      warnings: [],
    };
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ session: currentSession }),
    });
  });
  await page.route('**/api/library-sessions/*', (route) => {
    const sessionId = new URL(route.request().url()).pathname.split('/').pop();
    if (currentSession?.sessionId !== sessionId) {
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'VL3D-E2023', message: 'Mock session not found' } }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ session: currentSession }),
    });
  });
  await page.route('**/api/layouts/prepare', (route) => {
    forbiddenPrepareRequests += 1;
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'VL3D-E9001', message: 'OA prepare is forbidden in mock verification' } }),
    });
  });
  return {
    get forbiddenPrepareRequests() { return forbiddenPrepareRequests; },
  };
}

async function loadPrimaryLibraryOptions(page, timeout, paths) {
  await page.click('#advancedSettingsBtn');
  await page.$eval('#advancedSettings', (details) => { details.open = true; });
  await page.fill('#libraryPathInput', paths.primaryLibrary);
  await page.fill('#libraryNameInput', 'LIB_A');
  await page.fill('#cdsLibInput', paths.cdsLib);
  await page.fill('#cadenceEnvInput', paths.cadenceEnv);
  await page.fill('#viewsInput', 'layout');
  await page.click('#applyLibraryBtn');
  await page.waitForFunction(() => (
    !document.querySelector('#libraryDialog')?.open
    && [...document.querySelectorAll('#cellSelect option')].some((option) => option.value === 'LIB_A/inv/layout')
    && [...document.querySelectorAll('#cellSelect option')].some((option) => option.value === 'LIB_A/CELL_B/layout')
  ), undefined, { timeout });
}

async function runLibraryWorkflowCheck(browser, options) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const url = new URL('/', options.url).href;
  const paths = oaPaths(options);
  const mockApi = options.withOaIntegration ? null : await installMockLibraryApi(page, options);
  const dataRequests = [];
  const prepareRequests = [];
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/public/data/') && pathname !== '/public/data/manifest.json') dataRequests.push(pathname);
    if (pathname === '/api/layouts/prepare') prepareRequests.push(request.postDataJSON());
  });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(() => window.__VL3D_APP_BOOTING === false, undefined, { timeout: 15_000 });
    const blank = await page.evaluate(() => ({
      options: [...document.querySelectorAll('#cellSelect option')].map((option) => option.value),
      library: document.querySelector('#libraryLabel')?.textContent,
      stats: document.querySelector('#cellStats')?.textContent,
    }));
    assert(blank.options.length === 1 && blank.options[0] === '', 'blank startup exposed a global catalog', blank);
    assert(dataRequests.length === 0, 'blank startup loaded layout data', dataRequests);

    await loadPrimaryLibraryOptions(page, 15_000, paths);
    const primaryOptions = await page.$$eval('#cellSelect option', (options) => options.map((option) => option.value).filter(Boolean));
    assert(primaryOptions.length >= 4 && primaryOptions.every((key) => key.startsWith('LIB_A/')), 'LIB_A session leaked another library', primaryOptions);
    const beforeSelection = dataRequests.length;
    await page.selectOption('#cellSelect', 'LIB_A/CELL_B/layout');
    const selectedCacheState = await page.$eval('#cellSelect', (select) => {
      const label = select.selectedOptions[0]?.textContent || '';
      if (/ · ready(?: ·|$)/.test(label)) return 'ready';
      if (/ · refresh(?: ·|$)/.test(label)) return 'stale';
      if (/ · load(?: ·|$)/.test(label)) return 'missing';
      return 'unknown';
    });
    assert(selectedCacheState !== 'unknown', 'selected LIB_A/CELL_B option has no cache-state label');
    await page.waitForTimeout(250);
    assert(dataRequests.length === beforeSelection, 'selecting a cell loaded data before Open', { beforeSelection, dataRequests });
    const prepareBeforeOpen = prepareRequests.length;
    await page.click('#openCellBtn');
    await waitForLayoutIdentity(page, 'LIB_A/CELL_B/layout', 20_000);
    const prepareDelta = prepareRequests.length - prepareBeforeOpen;
    const finalCacheState = await page.$eval('#cellSelect', (select) => (
      / · ready(?: ·|$)/.test(select.selectedOptions[0]?.textContent || '') ? 'ready' : 'not-ready'
    ));
    if (selectedCacheState === 'ready') {
      assert(prepareDelta === 0, 'ready cache unexpectedly invoked OA prepare', prepareRequests);
    } else {
      assert(prepareDelta === 1, `${selectedCacheState} cache did not invoke exactly one OA prepare`, prepareRequests);
      assert(finalCacheState === 'ready', `${selectedCacheState} cache did not become ready after prepare`, {
        finalCacheState,
        prepareRequests,
      });
    }

    await page.fill('#cellSearch', 'inv');
    await page.press('#cellSearch', 'Enter');
    await waitForLayoutIdentity(page, 'LIB_A/inv/layout', 15_000);
    const beforeUnknown = dataRequests.length;
    await page.fill('#cellSearch', 'definitely_missing_cell');
    await page.press('#cellSearch', 'Enter');
    await page.waitForTimeout(100);
    const unknownMessage = await page.textContent('#pickInfo');
    assert(dataRequests.length === beforeUnknown && unknownMessage.includes('No exact cell match'), 'unknown manual cell changed the view', {
      beforeUnknown,
      dataRequests,
      unknownMessage,
    });

    await page.click('#advancedSettingsBtn');
    await page.$eval('#advancedSettings', (details) => { details.open = true; });
    await page.fill('#libraryPathInput', paths.secondaryLibrary);
    await page.fill('#libraryNameInput', 'LIB_B');
    await page.check('#rememberLibrarySettings');
    await page.click('#applyLibraryBtn');
    await page.waitForFunction(() => (
      !document.querySelector('#libraryDialog')?.open
      && [...document.querySelectorAll('#cellSelect option')].some((option) => option.value === 'LIB_B/diodep/layout')
    ), undefined, { timeout: 15_000 });
    const switched = await page.evaluate(() => ({
      state: window.__VL3D_STATE,
      options: [...document.querySelectorAll('#cellSelect option')].map((option) => option.value).filter(Boolean),
      label: document.querySelector('#libraryLabel')?.textContent,
    }));
    assert(switched.options.every((key) => key.startsWith('LIB_B/')), 'Second-library session leaked another library', switched);
    assert(switched.state?.library === 'LIB_A' && switched.state?.cell === 'inv', 'switching libraries discarded the current 3D view', switched);

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__VL3D_APP_BOOTING === false, undefined, { timeout: 15_000 });
    const remembered = await page.evaluate(() => ({
      path: document.querySelector('#libraryPathInput')?.value,
      libraryName: document.querySelector('#libraryNameInput')?.value,
      options: [...document.querySelectorAll('#cellSelect option')].map((option) => option.value).filter(Boolean),
    }));
    assert(remembered.path === paths.secondaryLibrary && remembered.libraryName === 'LIB_B', 'advanced settings were not remembered', remembered);
    assert(remembered.options.length > 0 && remembered.options.every((key) => key.startsWith('LIB_B/')),
      'reload did not recover the selected library session', remembered);

    await page.route('**/api/libraries/state', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ apiVersion: 2, oaEnabled: true }),
    }));
    await page.route('**/api/library-sessions/*', (route) => route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'VL3D-E2023', message: 'Library session expired or was not found' },
      }),
    }));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__VL3D_APP_BOOTING === false, undefined, { timeout: 15_000 });
    const expired = await page.evaluate(() => ({
      stats: document.querySelector('#cellStats')?.textContent || '',
      help: document.querySelector('#pickInfo')?.textContent || '',
      loadLibraryVisible: document.querySelector('#loadLibraryBtn')?.getClientRects().length > 0,
      advancedVisible: document.querySelector('#advancedSettingsBtn')?.getClientRects().length > 0,
      options: [...document.querySelectorAll('#cellSelect option')].map((option) => option.value),
    }));
    assert(expired.stats.includes('expired') && expired.help.includes('VL3D-E2023'),
      'expired library session did not expose a recovery prompt', expired);
    assert(expired.loadLibraryVisible && expired.advancedVisible,
      'expired library session hid manual recovery controls', expired);
    assert(expired.options.length === 1 && expired.options[0] === '',
      'expired library session retained stale cell choices', expired);
    await page.unroute('**/api/library-sessions/*');
    await page.unroute('**/api/libraries/state');
    assert(options.withOaIntegration || mockApi.forbiddenPrepareRequests === 0,
      'default verification invoked OA prepare', { requests: mockApi?.forbiddenPrepareRequests });
    return {
      ok: true,
      mode: options.withOaIntegration ? 'oa-integration' : 'self-contained-mock',
      blankStartup: blank,
      primaryCells: primaryOptions.length,
      selectedCacheState,
      prepareRequestsForOpen: prepareDelta,
      pdkCells: switched.options.length,
      selectChangedWithoutRequest: true,
      totalLayoutRequests: dataRequests.length,
      currentViewAfterLibrarySwitch: `${switched.state.library}/${switched.state.cell}/${switched.state.view}`,
      rememberedPath: remembered.path,
      recoveredSessionCells: remembered.options.length,
      expiredSessionRecovery: expired,
    };
  } finally {
    await page.close();
  }
}

async function exerciseStalePrepareGuard(page, profile, timeout) {
  const originalKey = `${profile.library}/${profile.cell}/layout`;
  await page.$eval('#cellSearch', (input) => {
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const missingKey = await page.$eval('#cellSelect', (select, currentKey) => (
    [...select.options].find((option) => option.value !== currentKey && / · load(?: ·|$)/.test(option.textContent || ''))?.value || ''
  ), originalKey);
  assert(missingKey, 'no missing OA layout is available for the slow-prepare race test');

  const staleEntry = await page.evaluate(async (currentKey) => {
    const response = await fetch(new URL('/api/layouts/catalog', window.location.origin));
    if (!response.ok) throw new Error(`catalog ${response.status}`);
    const payload = await response.json();
    const record = payload.layouts?.find((candidate) => (
      candidate.cacheState === 'ready'
      && candidate.key !== currentKey
      && candidate.entry
    ));
    return record ? { key: record.key, entry: record.entry } : null;
  }, originalKey);
  assert(staleEntry, 'no alternate ready entry is available for the slow-prepare response');

  let observedPayload = null;
  let responseAborted = false;
  let markRequestSeen;
  let markResponseDone;
  let releaseResponse;
  const requestSeen = new Promise((resolvePromise) => { markRequestSeen = resolvePromise; });
  const responseDone = new Promise((resolvePromise) => { markResponseDone = resolvePromise; });
  const responseGate = new Promise((resolvePromise) => { releaseResponse = resolvePromise; });
  const routePattern = '**/api/layouts/prepare';
  await page.route(routePattern, async (route) => {
    observedPayload = route.request().postDataJSON();
    markRequestSeen();
    await responseGate;
    try {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ entry: staleEntry.entry, cached: true }),
      });
    } catch {
      responseAborted = true;
    } finally {
      markResponseDone();
    }
  });

  try {
    await page.$eval('#cellSelect', (select, key) => {
      select.value = key;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }, missingKey);
    await withTimeout(requestSeen, timeout, 'slow prepare request');
    await page.waitForFunction((key) => (
      window.__VL3D_STATE?.preparePending === true
      && window.__VL3D_STATE?.pendingLayoutKey === key
      && document.querySelector('#cellSelect')?.disabled === true
    ), missingKey, { timeout });

    await page.$eval('#cellSearch', (input, query) => {
      input.value = query;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, originalKey);
    const duringSearch = await page.evaluate(() => ({
      disabled: document.querySelector('#cellSelect')?.disabled,
      selectedKey: document.querySelector('#cellSelect')?.value,
      state: window.__VL3D_STATE,
    }));
    assert(duringSearch.disabled === true, 'search repaint re-enabled the cell selector during prepare', duringSearch);
    assert(duringSearch.selectedKey === originalKey, 'search repaint did not preserve the current ready choice', duringSearch);

    await page.click('#cancelLoadBtn');
    releaseResponse();
    await withTimeout(responseDone, timeout, 'slow prepare intercepted response');
    await page.waitForFunction((key) => {
      const state = window.__VL3D_STATE;
      return `${state?.library}/${state?.cell}/${state?.view}` === key
        && state?.preparePending === false
        && state?.pendingLayoutKey === ''
        && document.querySelector('#cellSelect')?.disabled === false;
    }, originalKey, { timeout });
    const final = await page.evaluate(() => ({
      state: window.__VL3D_STATE,
      selectValue: document.querySelector('#cellSelect')?.value,
      disabled: document.querySelector('#cellSelect')?.disabled,
      cancelMessage: document.querySelector('#pickInfo')?.textContent || '',
    }));
    assert(final.state.preparePending === false && final.state.pendingLayoutKey === '',
      'slow prepare did not settle cleanly', final);
    assert(final.selectValue === originalKey && final.state.selectedLayoutKey === originalKey,
      'stale prepare response overwrote the current selected layout', final);
    assert(`${final.state.library}/${final.state.cell}/${final.state.view}` === originalKey,
      'stale prepare response overwrote the active layout identity', final);
    assert(`${final.state.library}/${final.state.cell}/${final.state.view}` !== staleEntry.key,
      'stale response entry became active', { staleEntry, final });
    assert(final.cancelMessage.includes('Load canceled'), 'Cancel did not preserve its completion message', final);

    await page.$eval('#cellSearch', (input) => {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return {
      missingKey,
      staleEntryKey: staleEntry.key,
      responseHeldUntilCancel: true,
      disabledDuringSearch: duringSearch.disabled,
      responseAborted,
      interceptedPayload: observedPayload,
      finalSelectedKey: final.state.selectedLayoutKey,
      cancelMessage: final.cancelMessage,
    };
  } finally {
    releaseResponse();
    await page.unroute(routePattern);
  }
}

async function runDirectPublicCheck(browser, options) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const url = new URL('/public/index.html', options.url);
  url.searchParams.set('library', 'LIB_A');
  url.searchParams.set('cell', 'inv');
  url.searchParams.set('view', 'layout');
  const httpErrors = [];
  const consoleErrors = [];
  const pageErrors = [];
  const moduleResponses = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    const responseUrl = new URL(response.url());
    const optionalCatalogFallback = response.status() === 404 && responseUrl.pathname === '/api/layouts/catalog';
    if (response.status() >= 400 && responseUrl.pathname !== '/favicon.ico' && !optionalCatalogFallback) {
      httpErrors.push({ url: response.url(), status: response.status() });
    }
    if (responseUrl.pathname.startsWith('/public/src/') && responseUrl.pathname.endsWith('.js')) {
      moduleResponses.push({ url: response.url(), status: response.status() });
    }
  });
  try {
    const startedAt = Date.now();
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(() => (
      window.__VL3D_STATE?.library === 'LIB_A'
      && window.__VL3D_STATE?.cell === 'inv'
      && window.__VL3D_STATE?.view === 'layout'
      && window.__VL3D_STATE?.idleRender === true
    ), undefined, { timeout: 20_000 });
    const readyMs = Date.now() - startedAt;
    assert(moduleResponses.some((response) => response.url.endsWith('/public/src/viewer-next.js') && response.status === 200),
      '/public/index.html did not load its viewer module', moduleResponses);
    assert(moduleResponses.length >= 2 && moduleResponses.every((response) => response.status === 200),
      '/public/index.html module graph did not load cleanly', moduleResponses);
    assert(!httpErrors.length, '/public/index.html produced HTTP errors', httpErrors);
    assert(!consoleErrors.length && !pageErrors.length, '/public/index.html produced browser errors', {
      consoleErrors,
      pageErrors,
    });
    return {
      ok: true,
      url: url.toString(),
      readyMs,
      moduleResponses,
      consoleErrors,
      pageErrors,
    };
  } finally {
    await page.close();
  }
}

async function runFallbackPaletteCheck(browser, options) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const url = new URL('/public/index.html', options.url);
  url.searchParams.set('library', 'LIB_A');
  url.searchParams.set('cell', 'inv');
  url.searchParams.set('view', 'layout');
  await page.addInitScript(() => {
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function getContext(type, ...args) {
      if (type === 'webgl2') return null;
      return originalGetContext.call(this, type, ...args);
    };
  });
  try {
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(() => (
      window.__VL3D_STATE?.mode === 'unsupported-browser'
      && window.__VL3D_STATE?.errorCode === 'VL3D-E8001'
      && window.__VL3D_STATE?.fullApp === false
    ), undefined, { timeout: 20_000 });
    const optionsState = await page.$$eval('#paletteSelect option', (entries) => entries.map((entry) => entry.value));
    assert(PALETTE_VALUES.every((palette) => optionsState.includes(palette)),
      'fallback palette dropdown is incomplete', optionsState);
    const contract = await page.evaluate(() => {
      const visible = (selector) => document.querySelector(selector)?.getClientRects().length > 0;
      return {
        state: window.__VL3D_STATE,
        noticeVisible: visible('#browserCompatibilityNotice'),
        noticeText: document.querySelector('#browserCompatibilityNotice')?.textContent || '',
        loadLibraryVisible: visible('#loadLibraryBtn'),
        advancedVisible: visible('#advancedSettingsBtn'),
        openCellVisible: visible('#openCellBtn'),
        hierarchyVisible: visible('#hierarchyList'),
        netsVisible: visible('#netList'),
        inspectorVisible: visible('#inspectorPanel'),
        inspectorOpen: document.querySelector('.inspector-drawer')?.open === true,
        attitudeVisible: visible('#attitudeCanvas'),
        disabledSourceControls: ['loadLibraryBtn', 'advancedSettingsBtn', 'openCellBtn', 'openFileBtn']
          .every((id) => document.getElementById(id)?.disabled === true),
        statusText: document.querySelector('#cellStats')?.textContent || '',
        helpText: document.querySelector('#pickInfo')?.textContent || '',
      };
    });
    assert(contract.noticeVisible && contract.noticeText.includes('VL3D-E8001') && contract.noticeText.includes('vl3d'),
      'WebGL 2 failure did not show the explicit native-client recommendation', contract);
    assert(contract.loadLibraryVisible && contract.advancedVisible && contract.openCellVisible,
      'browser compatibility mode hid source controls', contract);
    assert(contract.hierarchyVisible && contract.netsVisible && contract.inspectorVisible
      && contract.inspectorOpen && contract.attitudeVisible,
    'browser compatibility mode hid exploration or inspector panels', contract);
    assert(contract.disabledSourceControls, 'unsupported browser left dead source controls interactive', contract);
    assert(contract.statusText.includes('E8001') && contract.helpText.includes('E8001'),
      'browser compatibility mode did not expose the error sequence', contract);
    return {
      ok: true,
      palettes: optionsState,
      mode: contract.state.mode,
      errorCode: contract.state.errorCode,
      fullInterfaceVisible: true,
      nativeRecommendation: true,
    };
  } finally {
    await page.close();
  }
}

async function runStartupFailureChecks(browser, options) {
  const scenarios = [
    {
      id: 'model-import',
      route: '**/public/src/model.js',
      status: 503,
      body: 'model module unavailable',
      expectedCode: 'VL3D-E8006',
    },
    {
      id: 'unexpected-startup',
      route: '**/public/src/viewer-next.js',
      status: 200,
      body: "throw new Error('Synthetic unexpected startup failure');\n",
      expectedCode: 'VL3D-E9001',
    },
  ];
  const results = [];
  for (const scenario of scenarios) {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await page.route(scenario.route, (route) => route.fulfill({
      status: scenario.status,
      contentType: 'text/javascript',
      body: scenario.body,
    }));
    try {
      const url = new URL('/public/index.html', options.url);
      await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForFunction((expectedCode) => (
        window.__VL3D_STATE?.mode === 'browser-startup-error'
        && window.__VL3D_STATE?.errorCode === expectedCode
      ), scenario.expectedCode, { timeout: 20_000 });
      const contract = await page.evaluate(() => ({
        state: window.__VL3D_STATE,
        code: document.querySelector('#browserCompatibilityCode')?.textContent || '',
        title: document.querySelector('#browserCompatibilityTitle')?.textContent || '',
        detail: document.querySelector('#browserCompatibilityDetail')?.textContent || '',
        notice: document.querySelector('#browserCompatibilityNotice')?.textContent || '',
        help: document.querySelector('#browserCompatibilityHelp')?.getAttribute('href') || '',
      }));
      assert(contract.code === scenario.expectedCode && contract.state.errorCode === scenario.expectedCode,
        `${scenario.id} exposed the wrong startup error`, contract);
      assert(!/WebGL 2 renderer unavailable|WebGL 2 is unavailable/i.test(`${contract.title} ${contract.detail}`),
        `${scenario.id} was misreported as WebGL incompatibility`, contract);
      assert(contract.title.includes('startup failed') && contract.help.includes(scenario.expectedCode),
        `${scenario.id} did not expose generic startup recovery`, contract);
      results.push({ id: scenario.id, errorCode: contract.state.errorCode, mode: contract.state.mode });
    } finally {
      await page.close();
    }
  }
  return { ok: true, scenarios: results };
}

async function runProfile(browser, profile, options) {
  progress(profile, 'open');
  const url = profileUrl(options.url, profile);
  const page = await browser.newPage({ viewport: VIEWPORT });
  const consoleErrors = [];
  const pageErrors = [];
  const httpErrors = [];
  const responseTasks = [];
  const forbiddenPrepareRequests = [];
  if (!options.withOaIntegration) {
    await page.route('**/api/layouts/prepare', (route) => {
      forbiddenPrepareRequests.push(route.request().postDataJSON());
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'VL3D-E9001', message: 'OA prepare is disabled in default verification' } }),
      });
    });
  }
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (message.text().startsWith('Failed to load resource:')) return;
    consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    const responseUrl = new URL(response.url());
    const optionalCatalogFallback = response.status() === 404 && responseUrl.pathname === '/api/layouts/catalog';
    if (response.status() >= 400 && responseUrl.pathname !== '/favicon.ico' && !optionalCatalogFallback) {
      httpErrors.push({ url: response.url(), status: response.status() });
    }
    if (!response.url().includes('/public/data/')) return;
    responseTasks.push((async () => {
      const headers = await response.allHeaders();
      return {
        file: decodeURIComponent(new URL(response.url()).pathname.split('/').pop()),
        status: response.status(),
        encoding: headers['content-encoding'] || '',
        bytes: Number(headers['content-length'] || 0),
      };
    })());
  });

  try {
    const navigationStartedAt = Date.now();
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: Math.max(30_000, profile.limits.readyMs + 10_000),
    });
    await page.waitForFunction(() => (
      window.__VL3D_APP_BOOTING === false
      || window.__VL3D_MODULE_FAILED === true
    ), undefined, { timeout: 10_000 });
    const available = await page.evaluate(({ library, cell }) => (
      [...document.querySelectorAll('#cellSelect option')].some((option) => (
        option.dataset.cell === cell && option.value.startsWith(`${library}/`)
      ))
    ), profile);
    assert(available, `${profile.id} is absent from the manifest`);

    await page.waitForFunction(({ library, cell }) => {
      const state = window.__VL3D_STATE;
      return state?.library === library
        && state?.cell === cell
        && state.shapeMeshes > 0
        && state.renderSerial > 0
        && state.idleRender === true;
    }, profile, { timeout: Math.max(30_000, profile.limits.readyMs + 10_000) });
    const readyMs = Date.now() - navigationStartedAt;
    const profileDataResponseCount = responseTasks.length;
    progress(profile, `ready ${readyMs}ms`);

    const initial = await page.evaluate(() => ({
      state: window.__VL3D_STATE,
      heapBytes: Number(performance.memory?.usedJSHeapSize || 0),
      title: document.title,
      bodyTextLength: document.body.innerText.trim().length,
      cells: document.querySelectorAll('#cellSelect option').length,
      layers: document.querySelectorAll('.layer-row').length,
      hierarchyRows: document.querySelectorAll('.hierarchy-row').length,
      netRows: document.querySelectorAll('.net-row').length,
      inspectorOpen: document.querySelector('.inspector-drawer')?.open === true,
      attitudeVisible: document.querySelector('#attitudeCanvas')?.getClientRects().length > 0,
      layerStack: Object.fromEntries([...document.querySelectorAll('.layer-row')].map((row) => [
        row.dataset.layer,
        {
          bottom: Number(row.dataset.bottom),
          thickness: Number(row.dataset.thickness),
          top: Number(row.dataset.top),
        },
      ])),
      fallback: Boolean(window.__VL3D_FALLBACK_STARTED),
      webgl: Boolean(document.querySelector('#scene').getContext('webgl2') || document.querySelector('#scene').getContext('webgl')),
    }));
    const initialHeapMiB = initial.heapBytes / MIB;
    const context = { profile: profile.id, state: stateSnapshot(initial.state) };
    assert(initial.webgl, 'WebGL context unavailable', context);
    assert(!initial.fallback, 'fallback renderer unexpectedly started', context);
    assert(initial.bodyTextLength > 80, 'viewer UI is unexpectedly empty', context);
    assert(initial.cells >= 1 && initial.layers >= 1, 'manifest or layers did not render', context);
    assert(initial.hierarchyRows > 0, 'hierarchy panel is empty', context);
    assert(initial.netRows > 0, 'net panel is empty', context);
    assert(initial.inspectorOpen && initial.attitudeVisible,
      'right inspector or orientation indicator is not visible by default', context);
    assert(initial.state.pins > 0 && initial.state.connections > 0, 'OA pin/connectivity data is missing', context);
    assert(initial.state.visiblePinMarkers === 0 && initial.state.pinsVisible === false,
      'pins should stay hidden until an occurrence is selected', initial.state);
    assert(initial.state.drawCalls > 0 && initial.state.triangles > 0, 'GPU scene did not render', context);
    assert(initial.state.idleRender, 'initial render is not idle', context);
    assert(initial.state.selectedLayoutKey === `${profile.library}/${profile.cell}/layout`,
      'selected layout key does not contain the complete identity', context);
    if (profile.requireViaLod) {
      assert(initial.state.viaMerge > 0, 'stress layout did not enable automatic via LOD', context);
    }
    assertAtMost(readyMs, profile.limits.readyMs, 'readyMs', context);
    assertAtMost(initial.state.loadMs, profile.limits.loadMs, 'loadMs', context);
    assertAtMost(initial.state.buildMs, profile.limits.buildMs, 'buildMs', context);
    assertAtMost(initialHeapMiB, profile.limits.heapMiB, 'heapMiB', context);
    assertAtMost(initial.state.drawCalls, profile.limits.drawCalls, 'drawCalls', context);
    assertAtMost(initial.state.renderMs, profile.limits.renderMs, 'renderMs', context);

    const actionTimeout = profile.limits.interactionMs + 5000;
    const instancesOn = await setCheckbox(page, '#instancesToggle', true, actionTimeout);
    assert(await page.$eval('#instancesToggle', (input) => input.checked), 'instance all-on toggle failed');
    if (initial.state.instanceOverlays > 0) {
      assert(instancesOn.state.visibleRecords > initial.state.visibleRecords, 'instance all-on did not expose records', instancesOn.state);
    }
    await setCheckbox(page, '#instancesToggle', false, actionTimeout);

    const wiresOff = await setCheckbox(page, '#wireToggle', false, actionTimeout);
    assert(wiresOff.state.visibleRecords === 0, 'wire all-off toggle failed', wiresOff.state);
    const canvasGestures = profile.key === 'inv'
      ? {
        staticClick: await probeCanvasGesture(page, 0, actionTimeout),
        jitter2px: await probeCanvasGesture(page, 2, actionTimeout),
      }
      : null;
    await setCheckbox(page, '#wireToggle', true, actionTimeout);

    const layersOff = await renderedAction(
      page,
      'layers-none',
      () => page.$eval('#legendNoneBtn', (button) => button.click()),
      actionTimeout,
    );
    const checkedLayers = await page.$$eval('.layer-row input', (inputs) => inputs.filter((input) => input.checked).length);
    assert(checkedLayers === 0 && layersOff.state.visibleRecords === 0, 'layer all-off failed', {
      checkedLayers,
      state: layersOff.state,
    });
    await renderedAction(
      page,
      'layers-all',
      () => page.$eval('#legendAllBtn', (button) => button.click()),
      actionTimeout,
    );
    const navigationControls = profile.key === 'inv'
      ? await exerciseNavigationControls(page, profile, actionTimeout)
      : null;
    if (navigationControls) progress(profile, `wheel-first-frame ${navigationControls.wheel.firstFrameMs}ms`);
    const normalVisual = await captureSceneContrast(page);
    assert(normalVisual.theme === 'dark', 'normal view did not start in the dark theme', normalVisual);
    assert(normalVisual.palette === DEFAULT_PALETTE, 'normal view did not start with the default palette', normalVisual);
    assert(normalVisual.layerColors >= 3 && normalVisual.hueBuckets >= 3,
      'normal view did not preserve distinct layer colors', normalVisual);
    assert(normalVisual.darkPixels >= 200 && normalVisual.brightPixels >= 100 && normalVisual.brightEdgePixels >= 50,
      'normal view lacks dark surfaces with bright edge contrast', normalVisual);
    const paletteMatrix = profile.cell === 'VCO_class_B'
      ? await exercisePaletteMatrix(page, profile, actionTimeout, normalVisual)
      : null;
    if (paletteMatrix) progress(profile, 'palette-matrix');
    const masterQuickSelect = await exerciseMasterQuickSelect(page, actionTimeout);
    assertAtMost(masterQuickSelect.selectMs, profile.limits.interactionMs, 'master quick select wallMs', context);
    progress(profile, 'toggles');

    const candidate = await chooseHierarchyCandidate(page, profile.hierarchySearch, profile.preferredPath);
    assert(candidate, 'no hierarchy occurrence is available for selection', context);
    const hierarchy = await renderedAction(
      page,
      'hierarchy-select',
      () => clickHierarchyCandidate(page, candidate),
      actionTimeout,
    );
    const hierarchyState = await page.evaluate(() => ({
      state: window.__VL3D_STATE,
      inspectorOpen: document.querySelector('.inspector-drawer').open,
      title: document.querySelector('#selectionTitle').textContent,
      pins: document.querySelectorAll('#pinList button').length,
      connections: document.querySelectorAll('#connectionList button').length,
      externalAction: Boolean(document.querySelector('[data-action="trace-external"]')),
    }));
    assert(hierarchyState.state.selectedInstances === 1, 'hierarchy occurrence selection failed', hierarchyState);
    assert(hierarchyState.inspectorOpen && hierarchyState.title, 'selection inspector did not open', hierarchyState);
    assert(hierarchyState.pins > 0, 'selected occurrence exposes no pins', { candidate, hierarchyState });
    assert(hierarchyState.connections > 0 && hierarchyState.externalAction, 'selected occurrence exposes no external connections', {
      candidate,
      hierarchyState,
    });
    if (profile.expectedPins != null) {
      assert(hierarchyState.pins === profile.expectedPins, 'selected occurrence pin count differs from the stress contract', hierarchyState);
    }
    if (profile.expectedConnections != null) {
      assert(hierarchyState.connections === profile.expectedConnections, 'selected occurrence connection count differs from the stress contract', hierarchyState);
    }
    const visiblePinMarkers = hierarchyState.state.visiblePinMarkers;
    const globalPinMarkers = hierarchyState.state.globalPinMarkers;
    assert(hierarchyState.state.pinsVisible === true && visiblePinMarkers === hierarchyState.pins,
      'selected occurrence did not reveal exactly its visible pins', hierarchyState);
    assert(globalPinMarkers === initial.state.pins, 'pin metadata population changed after selection', hierarchyState);
    const pinsOff = await setCheckbox(page, '#pinToggle', false, actionTimeout);
    assertAtMost(pinsOff.wallMs, profile.limits.interactionMs, 'Pins all-off wallMs', context);
    assert(pinsOff.state.pinsVisible === false && pinsOff.state.visiblePinMarkers === 0,
      'Pins all-off left visible 3D markers', pinsOff.state);
    assert(pinsOff.state.globalPinMarkers === globalPinMarkers,
      'Pins all-off changed pin marker metadata instead of visibility', pinsOff.state);
    const pinsOn = await setCheckbox(page, '#pinToggle', true, actionTimeout);
    assertAtMost(pinsOn.wallMs, profile.limits.interactionMs, 'Pins all-on wallMs', context);
    assert(pinsOn.state.pinsVisible === true && pinsOn.state.visiblePinMarkers === visiblePinMarkers,
      'Pins all-on did not restore all 3D markers', { before: hierarchyState.state, after: pinsOn.state });
    assert(pinsOn.state.globalPinMarkers === globalPinMarkers,
      'Pins all-on changed the global marker population', pinsOn.state);
    progress(profile, `hierarchy ${candidate.path}`);

    const external = await renderedAction(
      page,
      'trace-external',
      () => page.$eval('[data-action="trace-external"]', (button) => button.click()),
      actionTimeout,
    );
    assert(external.state.selectedNets > 0, 'external connection trace selected no nets', external.state);
    progress(profile, 'external-net');

    const pin = await renderedAction(
      page,
      'pin-select',
      () => page.$eval('#pinList button', (button) => button.click()),
      actionTimeout,
    );
    const pinState = await page.evaluate(() => ({
      state: window.__VL3D_STATE,
      title: document.querySelector('#selectionTitle').textContent,
      fitAction: Boolean(document.querySelector('[data-action="fit-record"]')),
    }));
    assert(pinState.title && pinState.fitAction, 'pin selection did not open the pin inspector', pinState);
    assert(pinState.state.selectedNets > 0, 'pin selection did not trace its scoped net', pinState);
    progress(profile, 'pin');

    await renderedAction(
      page,
      'clear-pin-selection',
      () => page.$eval('[data-action="clear-selection"]', (button) => button.click()),
      actionTimeout,
    );
    const net = await renderedAction(
      page,
      'net-trace',
      () => page.$eval('.net-row', (button) => button.click()),
      actionTimeout,
    );
    assert(net.state.selectedNets > 0, 'scoped net trace failed', net.state);
    await waitForFullIdle(page, actionTimeout);
    const hiddenLayers = await renderedAction(
      page,
      'selected-net-layers-none',
      () => page.$eval('#legendNoneBtn', (button) => button.click()),
      actionTimeout,
    );
    assert(hiddenLayers.state.selectedNets > 0 && hiddenLayers.state.visibleRecords === 0,
      'Layers None did not hide every record while a net was selected', hiddenLayers.state);
    const hiddenFastState = await dragIntoFastMode(page, hiddenLayers.state.renderSerial, actionTimeout);
    const hiddenCheckedLayers = await page.$$eval('.layer-row input', (inputs) => inputs.filter((input) => input.checked).length);
    assert(hiddenCheckedLayers === 0, 'fast mode changed hidden layer checkboxes', { hiddenCheckedLayers, hiddenFastState });
    assert(hiddenFastState.visibleRecords === 0 && hiddenFastState.triangles === 0 && hiddenFastState.fastDraftLayers === 0,
      'fast mode re-exposed hidden selected-net geometry', hiddenFastState);
    const hiddenFastRestore = await releaseFastMode(
      page,
      hiddenFastState.renderSerial,
      profile.limits.fastRestoreMs + 5000,
    );
    assert(hiddenFastRestore.state.visibleRecords === 0,
      'hidden layers reappeared after fast-mode restore', hiddenFastRestore.state);
    const hiddenLayersRestored = await renderedAction(
      page,
      'selected-net-layers-all',
      () => page.$eval('#legendAllBtn', (button) => button.click()),
      actionTimeout,
    );
    assert(hiddenLayersRestored.state.visibleRecords > 0 && hiddenLayersRestored.state.triangles > 0,
      'Layers All did not restore selected-net geometry', hiddenLayersRestored.state);
    await renderedAction(
      page,
      'clear-net-selection',
      () => page.$eval('[data-action="clear-selection"]', (button) => button.click()),
      actionTimeout,
    );
    progress(profile, 'net');

    await page.waitForFunction(() => window.__VL3D_STATE?.fastMode === false, undefined, {
      timeout: profile.limits.fastRestoreMs + 5000,
    });

    for (const interaction of [hierarchy, external, pin, net]) {
      assertAtMost(interaction.wallMs, profile.limits.interactionMs, `${interaction.label} wallMs`, context);
      assert(interaction.state.fastMode === false, `${interaction.label} unexpectedly entered fast mode`, interaction.state);
    }

    const fullBeforeFast = await readState(page);
    const expectedCoreState = coreStateSnapshot(fullBeforeFast);
    const fastState = await dragIntoFastMode(page, fullBeforeFast.renderSerial, actionTimeout);
    const fastRatio = fastState.triangles / fullBeforeFast.triangles;
    assert(fastState.fastMode === true, 'real canvas drag did not enter fast mode', fastState);
    assert(fastState.fastDraftLayers > 0, 'fast mode selected no draft layers', fastState);
    assert(fastState.triangles === 0 && fastState.drawCalls >= fastState.fastDraftLayers,
      'fast mode did not switch to the expected line-only structure', fastState);
    assert(fastState.drawCalls < fullBeforeFast.drawCalls, 'fast mode did not reduce draw calls', {
      fastState,
      fullBeforeFast,
    });
    assertAtMost(
      fastState.drawCalls / fullBeforeFast.drawCalls,
      profile.limits.fastDrawCallRatio,
      'fast draw-call ratio',
      context,
    );
    assertAtMost(fastState.renderMs, profile.limits.fastRenderMs, 'fast renderMs', context);
    assertAtMost(fastState.firstFrameMs, profile.limits.fastEnterMs, 'fast first-frame wallMs', context);
    assertAtMost(fastRatio, profile.limits.fastTriangleRatio, 'fast triangle ratio', {
      profile: profile.id,
      fastTriangles: fastState.triangles,
      fullTriangles: fullBeforeFast.triangles,
    });
    const fastVisual = await captureSceneContrast(page);
    const fastVisualState = await readState(page);
    assert(fastVisualState.fastMode === true, 'visual probe unexpectedly left fast mode', fastVisualState);
    assert(fastVisual.hueBuckets >= 2 && fastVisual.brightEdgePixels >= 20,
      'fast mode lost layer distinction or bright structural edges', fastVisual);
    assert(fastVisual.chromaticPixels >= normalVisual.chromaticPixels * 0.2
      && fastVisual.occupiedCells >= normalVisual.occupiedCells * 0.35,
      'fast mode retained too little recognizable layout coverage', { normalVisual, fastVisual });
    let fastPaletteCompatibility = null;
    if (profile.cell === 'VCO_class_B') {
      const alternateFastPalette = await setSelectValue(page, '#paletteSelect', 'plasma', actionTimeout);
      assert(alternateFastPalette.state.fastMode === true, 'palette switch left fast mode during outline check', alternateFastPalette.state);
      const alternateFastVisual = await captureSceneContrast(page);
      assert(alternateFastVisual.imageHash === fastVisual.imageHash,
        'fill palette changed fast-mode outlines', { fastVisual, alternateFastVisual });
      await setSelectValue(page, '#paletteSelect', DEFAULT_PALETTE, actionTimeout);
      fastPaletteCompatibility = {
        stable: true,
        imageHash: fastVisual.imageHash.slice(0, 16),
      };
    }

    const restored = await releaseFastMode(page, fastState.renderSerial, profile.limits.fastRestoreMs + 5000);
    const fastRestoreMs = restored.wallMs;
    const restoredState = restored.state;
    const drawCallDelta = Math.abs(restoredState.drawCalls - fullBeforeFast.drawCalls);
    const triangleDelta = Math.abs(restoredState.triangles - fullBeforeFast.triangles);
    const drawCallTolerance = Math.max(4, Math.ceil(fullBeforeFast.drawCalls * 0.03));
    const triangleTolerance = Math.max(128, Math.ceil(fullBeforeFast.triangles * 0.002));
    assertAtMost(fastRestoreMs, profile.limits.fastRestoreMs, 'fast restoreMs', context);
    assert(restoredState.fastMode === false, 'full mode did not restore after interaction', restoredState);
    assert(drawCallDelta <= drawCallTolerance, 'full draw calls exceeded the frustum-culling tolerance after restore', {
      drawCallDelta,
      drawCallTolerance,
      restoredState,
      fullBeforeFast,
    });
    assert(triangleDelta <= triangleTolerance, 'full triangles exceeded the frustum-culling tolerance after restore', {
      triangleDelta,
      triangleTolerance,
      restoredState,
      fullBeforeFast,
    });
    const expectedStableCoreState = { ...expectedCoreState };
    delete expectedStableCoreState.triangles;
    const restoredStableCoreState = coreStateSnapshot(restoredState);
    delete restoredStableCoreState.triangles;
    assert(
      Object.keys(expectedStableCoreState).every((key) => restoredStableCoreState[key] === expectedStableCoreState[key]),
      'fast/full restore: model or selection state changed',
      { expectedStableCoreState, restoredStableCoreState },
    );
    progress(profile, `fast-restored ${fastRestoreMs}ms`);

    const scaleControls = {
      zScale: await exerciseScaleControl(page, '#zScale', profile, actionTimeout),
    };
    progress(profile, `scale-preview ${scaleControls.zScale.previewMs}ms`);

    if (options.withOaIntegration && profile.key === 'inv') {
      await loadPrimaryLibraryOptions(page, actionTimeout, oaPaths(options));
    }
    const cellSwitchTimeout = Math.max(
      actionTimeout,
      profile.limits.readyMs + profile.limits.loadMs + profile.limits.buildMs + 6000,
    );
    const cellSwitch = options.withOaIntegration && profile.key === 'inv'
      ? await switchToReadyCellAndBack(page, profile, cellSwitchTimeout)
      : null;
    if (cellSwitch) progress(profile, `cell-switch ${cellSwitch.alternativeKey}`);
    const stalePrepare = null;
    if (stalePrepare) progress(profile, `stale-prepare ${stalePrepare.missingKey}`);

    const settledState = await waitForFullIdle(page, actionTimeout);
    const idleBefore = settledState.renderSerial;
    await page.waitForTimeout(500);
    const idleAfter = await readState(page);
    assert(idleAfter.idleRender && idleAfter.renderSerial === idleBefore, 'idle renderer produced extra frames', {
      idleBefore,
      idleAfter: idleAfter.renderSerial,
    });
    progress(profile, 'idle-stable');

    const finalHeapBytes = await page.evaluate(() => Number(performance.memory?.usedJSHeapSize || 0));
    const finalHeapMiB = finalHeapBytes / MIB;
    assertAtMost(finalHeapMiB, profile.limits.heapMiB, 'final heapMiB', context);

    const dataResponses = await Promise.all(responseTasks);
    const layoutResponses = dataResponses.filter((response) => response.file !== 'manifest.json');
    const profileLayoutResponses = dataResponses
      .slice(0, profileDataResponseCount)
      .filter((response) => response.file !== 'manifest.json');
    assert(layoutResponses.length > 0, 'layout data response was not observed', dataResponses);
    assert(profileLayoutResponses.length > 0, 'profile layout data response was not observed', dataResponses);
    for (const response of layoutResponses) {
      assert(response.status === 200, 'layout data response failed', response);
      assert(response.encoding.toLowerCase().includes('gzip'), 'layout data was not served with gzip', response);
    }
    for (const response of profileLayoutResponses) {
      if (response.bytes > 0) assertAtMost(response.bytes, profile.limits.gzipBytes, 'gzip bytes', response);
    }

    let screenshotPath = '';
    let screenshotBytes = 0;
    if (options.screenshot) {
      const screenshotDir = resolve('screenshots');
      mkdirSync(screenshotDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
      const safeProfile = profile.id.replace(/[^a-z0-9_-]+/gi, '__');
      screenshotPath = resolve(screenshotDir, `verify-${safeProfile}-${stamp}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      screenshotBytes = statSync(screenshotPath).size;
      assert(screenshotBytes > 20_000, 'screenshot is unexpectedly small', { screenshotBytes });
    }

    assert(!consoleErrors.length && !pageErrors.length && !httpErrors.length, 'browser errors detected', {
      consoleErrors,
      pageErrors,
      httpErrors,
    });
    assert(options.withOaIntegration || forbiddenPrepareRequests.length === 0,
      'default profile verification invoked OA prepare', forbiddenPrepareRequests);
    progress(profile, 'complete');

    return {
      ok: true,
      profile: profile.id,
      url,
      readyMs,
      limits: profile.limits,
      initial: {
        ...stateSnapshot(initial.state),
        heapMiB: Number(initialHeapMiB.toFixed(2)),
        title: initial.title,
        cells: initial.cells,
        hierarchyRows: initial.hierarchyRows,
        netRows: initial.netRows,
      },
      interactions: {
        canvasGestures,
        navigationControls,
        masterQuickSelect,
        hierarchy: {
          path: candidate.path,
          master: candidate.master,
          wallMs: hierarchy.wallMs,
          pins: hierarchyState.pins,
          connections: hierarchyState.connections,
        },
        pinsToggle: {
          defaultVisible: initial.state.visiblePinMarkers,
          globalMarkers: globalPinMarkers,
          visibleBefore: visiblePinMarkers,
          offMs: pinsOff.wallMs,
          onMs: pinsOn.wallMs,
          visibleAfter: pinsOn.state.visiblePinMarkers,
        },
        externalTraceMs: external.wallMs,
        pinSelectMs: pin.wallMs,
        netTraceMs: net.wallMs,
        hiddenLayersFastMode: {
          visibleRecords: hiddenFastState.visibleRecords,
          triangles: hiddenFastState.triangles,
          draftLayers: hiddenFastState.fastDraftLayers,
          firstFrameMs: hiddenFastState.firstFrameMs,
          restoreMs: hiddenFastRestore.wallMs,
        },
        scaleControls,
        cellSwitch,
        stalePrepare,
      },
      fastMode: {
        drawCalls: fastState.drawCalls,
        triangles: fastState.triangles,
        renderMs: fastState.renderMs,
        firstFrameMs: fastState.firstFrameMs,
        draftLayers: fastState.fastDraftLayers,
        triangleRatio: Number(fastRatio.toFixed(4)),
        restoreMs: fastRestoreMs,
        drawCallDelta,
        drawCallTolerance,
        triangleDelta,
        triangleTolerance,
        restoredDrawCalls: restoredState.drawCalls,
        restoredTriangles: restoredState.triangles,
        paletteCompatibility: fastPaletteCompatibility,
      },
      visual: {
        normal: normalVisual,
        fast: fastVisual,
        paletteMatrix,
        chromaticCoverageRatio: Number((fastVisual.chromaticPixels / normalVisual.chromaticPixels).toFixed(4)),
        occupiedCoverageRatio: Number((fastVisual.occupiedCells / normalVisual.occupiedCells).toFixed(4)),
      },
      idle: {
        windowMs: 500,
        renderSerial: idleAfter.renderSerial,
        stable: true,
      },
      finalHeapMiB: Number(finalHeapMiB.toFixed(2)),
      screenshot: screenshotPath,
      screenshotBytes,
      dataResponses,
    };
  } finally {
    await page.close();
  }
}


async function runPublicDemoCheck(browser, profile, options) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errors = [];
  const oaRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.url().includes('/api/layouts/prepare')) oaRequests.push(request.url());
  });
  try {
    await page.goto(new URL('/', options.url).toString());
    await page.waitForFunction(() => window.__VL3D_BOOT_STATE?.phase !== 'loading');
    const loaded = [];
    for (const name of ['hierarchy-demo.json', 'physical-trace-demo.json']) {
      const input = resolve(PROJECT_ROOT, 'examples', name);
      const source = JSON.parse(readFileSync(input));
      await page.locator('#fileInput').setInputFiles(input);
      await page.waitForFunction((expected) => window.__VL3D_STATE?.source === expected
        && window.__VL3D_STATE?.shapeMeshes > 0, name, { timeout: 30000 });
      const state = await page.evaluate(() => window.__VL3D_STATE);
      assert(state.cell === source.cell && state.library === source.library, 'Public source identity mismatch', state);
      assert(state.totalShapes === source.shapes.length, 'Public geometry count mismatch', state);
      assert(state.pins === source.pins.length, 'Public pin count mismatch', state);
      loaded.push({ file: name, library: state.library, cell: state.cell, shapes: state.totalShapes, pins: state.pins });
      if (name === 'hierarchy-demo.json') {
        await page.locator('.hierarchy-row[data-path="DEMO/U1"] .hierarchy-item').click();
        assert(await page.locator('#pinList button').count() === 2, 'Selected module must list its own two pin figures');
      }
    }
    await page.locator('.hierarchy-row[data-path="TRACE/ROUTE"] .hierarchy-item').click();
    await page.locator('#traceMode').selectOption('physical');
    await page.locator('#pinList button').filter({ has: page.locator('strong').filter({ hasText: /^IN$/ }) }).click();
    await page.waitForFunction(() => window.__VL3D_STATE?.physicalTraceStatus === 'complete'
      && window.__VL3D_STATE?.physicalTraceShapes === 8, null, { timeout: 30000 });
    const final = await page.evaluate(() => window.__VL3D_STATE);
    assert(JSON.stringify(final.physicalTraceShapeIndices) === '[0,1,2,3,4,5,6,7]',
      'Physical example must follow confirmed VIA connections, excluding crossings, gaps and holes', final);
    assert(final.viewport.width > 100 && final.viewport.height > 100, 'Viewer viewport is unavailable', final.viewport);
    assert(!errors.length && !oaRequests.length, 'Public verification must work without OA preparation or page errors', { errors, oaRequests });
    let screenshot = '';
    if (options.screenshot) {
      const directory = resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), '.cache'), 'vl3d', 'verification');
      mkdirSync(directory, { recursive: true });
      screenshot = resolve(directory, `public-demo-${Date.now()}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
    }
    return { profile: profile.id, loaded, physicalTrace: { status: final.physicalTraceStatus,
      shapeIndices: final.physicalTraceShapeIndices }, screenshot, oaRequests: 0 };
  } finally { await page.close(); }
}

const options = parseArgs(process.argv.slice(2));
const profiles = selectedProfiles(options);
const executablePath = chromiumExecutable();
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-precise-memory-info',
  ],
});
const results = [];
const failures = [];
let directPublic = null;
let libraryWorkflow = null;
let fallbackPalette = null;
let startupFailures = null;
try {
  if (!profiles.every((profile) => profile.synthetic)) {
  try {
    libraryWorkflow = await runLibraryWorkflowCheck(browser, options);
  } catch (error) {
    failures.push({
      profile: 'library-workflow',
      message: error?.message || String(error),
      stack: error?.stack || '',
    });
  }
  try {
    directPublic = await runDirectPublicCheck(browser, options);
  } catch (error) {
    failures.push({
      profile: 'direct-public-index',
      message: error?.message || String(error),
      stack: error?.stack || '',
    });
  }
  try {
    fallbackPalette = await runFallbackPaletteCheck(browser, options);
  } catch (error) {
    failures.push({
      profile: 'fallback-palette',
      message: error?.message || String(error),
      stack: error?.stack || '',
    });
  }
  try {
    startupFailures = await runStartupFailureChecks(browser, options);
  } catch (error) {
    failures.push({
      profile: 'startup-failures',
      message: error?.message || String(error),
      stack: error?.stack || '',
    });
  }
  }
  for (const profile of profiles) {
    try {
      results.push(await (profile.synthetic ? runPublicDemoCheck(browser, profile, options) : runProfile(browser, profile, options)));
    } catch (error) {
      failures.push({
        profile: profile.id,
        message: error?.message || String(error),
        stack: error?.stack || '',
      });
      if (profiles.length === 1) break;
    }
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify({
  ok: failures.length === 0,
  chromium: executablePath,
  profiles: profiles.map((profile) => profile.id),
  libraryWorkflow,
  directPublic,
  fallbackPalette,
  startupFailures,
  results,
  failures,
}, null, 2));
if (failures.length) process.exitCode = 1;
