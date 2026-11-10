import { requestPhysicalTrace, traceResultSummary, traceDiagnostics } from './trace-client.js';
import * as THREE from '../vendor/three.module.min.js';
import { excludedShape, nonConductiveLayerName, hardNonConductiveLayerName, shapeFootprints, footprintBBox, isAxisAlignedRectangle,
  createPrismGeometry as buildPrismGeometry } from './geometry.js';
import {
  buildLayoutIndex,
  hierarchyMatches,
  mergeBBoxes,
  netMatches,
  parentHierarchyPath,
  pathUnderSelection,
  splitScopedNetKey,
  traceScopedNets,
} from './model.js';

window.__VL3D_MODULE_STARTED = true;
window.__VL3D_APP_BOOTING = true;
function recordBootFailure(reason) {
  if (!window.__VL3D_APP_BOOTING) return;
  const message = String(reason?.message || reason || 'The 3D renderer failed during startup');
  const embeddedCode = message.match(/\b(?:VL3D-)?E[0-9]{3,5}\b/i)?.[0] || '';
  const rawCode = String(reason?.code || embeddedCode).toUpperCase();
  window.__VL3D_MODULE_FAILED = true;
  window.__VL3D_FAILURE_MESSAGE = message;
  window.__VL3D_FAILURE_CODE = /^E[0-9]{3,5}$/.test(rawCode) ? `VL3D-${rawCode}` : rawCode;
  window.dispatchEvent(new CustomEvent('vl3d-module-failed', {
    detail: {
      message: window.__VL3D_FAILURE_MESSAGE,
      code: window.__VL3D_FAILURE_CODE,
    },
  }));
}
window.addEventListener('error', (event) => {
  recordBootFailure(event.error || event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  recordBootFailure(event.reason);
});

const byId = (id) => document.getElementById(id);
const canvas = byId('scene');
const axisOverlay = byId('axisOverlay');
const viewport = byId('viewport');
const appElement = byId('app');
const pinAnnotation = byId('pinAnnotation');
const viewHistory = [];
let hierarchyRowLimit = 260;
let loadCandidateKind = '';
let pendingImportOperation = '';
let temporaryLibraryName = '';
const loadSourceKind = byId('loadSourceKind');
const attitudeCanvas = byId('attitudeCanvas');
const cellSelect = byId('cellSelect');
const cellSearch = byId('cellSearch');
const loadLibraryBtn = byId('loadLibraryBtn');
const libraryLabel = byId('libraryLabel');
const openCellBtn = byId('openCellBtn');
const refreshCellBtn = byId('refreshCellBtn');
const advancedSettingsBtn = byId('advancedSettingsBtn');
const libraryDialog = byId('libraryDialog');
const libraryForm = byId('libraryForm');
const closeLibraryDialogBtn = byId('closeLibraryDialogBtn');
const cancelLibraryBtn = byId('cancelLibraryBtn');
const libraryDialogMessage = byId('libraryDialogMessage');
const libraryPathInput = byId('libraryPathInput');
const libraryNameInput = byId('libraryNameInput');
const cdsLibInput = byId('cdsLibInput');
const cadenceEnvInput = byId('cadenceEnvInput');
const viewsInput = byId('viewsInput');
const rememberLibrarySettings = byId('rememberLibrarySettings');
const resolvedSettings = byId('resolvedSettings');
const highlightSelect = byId('highlightSelect');
const layerList = byId('layerList');
const legendAllBtn = byId('legendAllBtn');
const legendNoneBtn = byId('legendNoneBtn');
const fitBtn = byId('fitBtn');
const resetBtn = byId('resetBtn');
const instancesToggle = byId('instancesToggle');
const routingToggle = byId('wireToggle');
const pinsToggle = byId('pinToggle');
const wireframeToggle = byId('wireframeToggle');
const xrayToggle = byId('xrayToggle');
const paletteSelect = byId('paletteSelect');
const themeSelect = byId('themeSelect');
const zScale = byId('zScale');
const zScaleValue = byId('zScaleValue');
const alphaScale = byId('alphaScale');
const viaMerge = byId('viaMerge');
const viaMergeValue = byId('viaMergeValue');
const fovScale = byId('fovScale');
const fovValue = byId('fovValue');
const qualitySelect = byId('qualitySelect');
const technologyNotice = byId('technologyNotice');
const stackPositionNotice = byId('stackPositionNotice');
const navigationModeSelect = byId('navigationModeSelect');
const navigationSummary = byId('navigationSummary');
const invertOrbitXToggle = byId('invertOrbitXToggle');
const invertOrbitYToggle = byId('invertOrbitYToggle');
const invertPanToggle = byId('invertPanToggle');
const invertWheelToggle = byId('invertWheelToggle');
const cellStats = byId('cellStats');
const rulerInfo = byId('rulerInfo');
const pickInfo = byId('pickInfo');
const performanceInfo = byId('performanceInfo');
const hierarchySearch = byId('hierarchySearch');
const hierarchyDepthInput = byId('hierarchyDepth');
const hierarchyDepthValue = byId('hierarchyDepthValue');
const hierarchyList = byId('hierarchyList');
const hierarchyAllBtn = byId('hierarchyAllBtn');
const hierarchyNoneBtn = byId('hierarchyNoneBtn');
const clearHierarchyBtn = byId('clearHierarchyBtn');
const netSearch = byId('netSearch');
const netList = byId('netList');
const clearNetBtn = byId('clearNetBtn');
const selectionTitle = byId('selectionTitle');
const selectionDetails = byId('selectionDetails');
const selectionActions = byId('selectionActions');
const pinList = byId('pinList');
const connectionList = byId('connectionList');
const loadingOverlay = byId('loadingOverlay');
const loadingText = byId('loadingText');
const cancelLoadBtn = byId('cancelLoadBtn');
const dropOverlay = byId('dropOverlay');
const openFileBtn = byId('openFileBtn');
const fileInput = byId('fileInput');
const viewIsoBtn = byId('viewIsoBtn');
const viewTopBtn = byId('viewTopBtn');
const viewSideBtn = byId('viewSideBtn');
const workspaceDrawer = document.querySelector('.workspace-drawer');
const inspectorDrawer = document.querySelector('.inspector-drawer');

const params = new URLSearchParams(window.location.search);
const demoMode = params.get('demo') === '1';
if (demoMode) document.body.classList.add('demo-mode');

const LAYER_COLORS = {
  DIFF: '#4cc9a7',
  OD: '#4cc9a7',
  ACTIVE: '#4cc9a7',
  POLY1: '#f97316',
  POLY: '#f97316',
  CONT: '#f8f0d8',
  CO: '#f8f0d8',
  METAL1: '#4dabf7',
  METAL2: '#51cf66',
  METAL3: '#ffd43b',
  METAL4: '#f06595',
  METAL5: '#b197fc',
  METAL6: '#38d9a9',
  VIA12: '#ffd166',
  VIA23: '#80ed99',
  VIA34: '#56cfe1',
  VIA45: '#c77dff',
  VIA56: '#ff8fab',
};

const DEFAULT_PALETTE = 'classic';
const PALETTE_SETTINGS_KEY = 'vl3d.palette.v2';
const LAYER_PALETTES = {
  classic: {
    DIFF: '#4cc9a7', ACTIVE: '#4cc9a7', OD: '#4cc9a7',
    POLY: '#f97316', POLY1: '#f97316', CONT: '#f8f0d8', CO: '#f8f0d8',
    METAL1: '#4dabf7', METAL2: '#51cf66', METAL3: '#ffd43b',
    METAL4: '#f06595', METAL5: '#b197fc', METAL6: '#38d9a9',
    VIA12: '#ffd166', VIA23: '#80ed99', VIA34: '#56cfe1',
    VIA45: '#c77dff', VIA56: '#ff8fab',
  },
  cyberpunk: {
    DIFF: '#00b8d9', ACTIVE: '#00b8d9', OD: '#00b8d9',
    POLY: '#ff3d81', POLY1: '#ff3d81', CONT: '#f5e6b8', CO: '#f5e6b8',
    METAL1: '#247bff', METAL2: '#00f5d4', METAL3: '#ffe66d',
    METAL4: '#ff3cac', METAL5: '#9d4edd', METAL6: '#00e5ff',
    VIA12: '#59d8ff', VIA23: '#4dffd2', VIA34: '#fff19a',
    VIA45: '#e879f9', VIA56: '#7df9ff',
  },
  aurora: {
    DIFF: '#2dd4bf', ACTIVE: '#2dd4bf', OD: '#2dd4bf',
    POLY: '#fb7185', POLY1: '#fb7185', CONT: '#ecfccb', CO: '#ecfccb',
    METAL1: '#22c55e', METAL2: '#84cc16', METAL3: '#facc15',
    METAL4: '#fb923c', METAL5: '#f472b6', METAL6: '#b8ff3d',
    VIA12: '#5eead4', VIA23: '#bef264', VIA34: '#fde047',
    VIA45: '#fdba74', VIA56: '#f9a8d4',
  },
  plasma: {
    DIFF: '#7c3aed', ACTIVE: '#7c3aed', OD: '#7c3aed',
    POLY: '#ff006e', POLY1: '#ff006e', CONT: '#ffe4f3', CO: '#ffe4f3',
    METAL1: '#5b21b6', METAL2: '#7c3aed', METAL3: '#a855f7',
    METAL4: '#e11d48', METAL5: '#ff2f92', METAL6: '#ff4fd8',
    VIA12: '#8b5cf6', VIA23: '#c084fc', VIA34: '#f0abfc',
    VIA45: '#fb7185', VIA56: '#ff8ad8',
  },
  titanium: {
    DIFF: '#38bdf8', ACTIVE: '#38bdf8', OD: '#38bdf8',
    POLY: '#f97316', POLY1: '#f97316', CONT: '#e2e8f0', CO: '#e2e8f0',
    METAL1: '#64748b', METAL2: '#0ea5e9', METAL3: '#94a3b8',
    METAL4: '#f97316', METAL5: '#cbd5e1', METAL6: '#ffb020',
    VIA12: '#7dd3fc', VIA23: '#bae6fd', VIA34: '#cbd5e1',
    VIA45: '#fdba74', VIA56: '#fde68a',
  },
};

const THEMES = {
  dark: {
    background: 0x0C0F0D,
    gridMajor: 0x5F6963,
    gridMinor: 0x26302B,
    frame: 0xEC5AA5,
    text: '#D8E0DA',
    muted: '#8C978F',
    edgeMultiplier: 1.44,
    axisX: '#b77d76',
    axisY: '#748fa6',
    axisZ: '#77a08c',
  },
  light: {
    background: 0xf6f4ee,
    gridMajor: 0x8f897d,
    gridMinor: 0xd6d0c5,
    frame: 0xC23A83,
    text: '#20221e',
    muted: '#5f655b',
    edgeMultiplier: 0.62,
    axisX: '#8d5752',
    axisY: '#55738c',
    axisZ: '#567b69',
  },
};

let webgl2Context = null;
try {
  webgl2Context = canvas?.getContext('webgl2', {
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
  }) || null;
} catch (cause) {
  const error = new Error(`WebGL 2 context creation failed: ${cause.message}`);
  error.code = 'VL3D-E8001';
  throw error;
}
if (!webgl2Context) {
  const error = new Error('WebGL 2 is unavailable; use the native VL3D client');
  error.code = 'VL3D-E8001';
  throw error;
}

const renderer = new THREE.WebGLRenderer({
  canvas,
  context: webgl2Context,
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
  preserveDrawingBuffer: false,
});
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.04;
renderer.sortObjects = true;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 10000);
const layoutRoot = new THREE.Group();
const routingRoot = new THREE.Group();
const connectorRoot = new THREE.Group();
const instanceRoot = new THREE.Group();
const pinRoot = new THREE.Group();
const gridRoot = new THREE.Group();
const axisRoot = new THREE.Group();
layoutRoot.add(routingRoot, connectorRoot, instanceRoot, pinRoot);
scene.add(layoutRoot, gridRoot, axisRoot);

camera.add(new THREE.DirectionalLight(0xffffff, 0.66));
scene.add(camera);
scene.add(new THREE.HemisphereLight(0xf8f4e8, 0x303640, 1.4));
scene.add(new THREE.AmbientLight(0xffffff, 0.14));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.0);
keyLight.position.set(30, 60, 26);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0xf2a65a, 0.7);
rimLight.position.set(-45, 28, -36);
scene.add(rimLight);

const axisContext = axisOverlay.getContext('2d');
const attitudeContext = attitudeCanvas?.getContext('2d');
const temporaryMatrix = new THREE.Matrix4();
const temporaryColor = new THREE.Color();
const surfaceTintColor = new THREE.Color(0x474d4b);
const selectionNetColor = new THREE.Color(0xffd166);
const selectionPathColor = new THREE.Color(0x5eead4);
const exactSelectionColor = new THREE.Color(0xffffff);

let manifest = null;
let layoutCatalog = new Map();
let oaApiAvailable = false;
let librarySession = null;
let libraryRequestPending = false;
let libraryRecoveryError = null;
let currentData = null;
let currentElectricalData = null;
let currentIndex = null;
let currentBounds = null;
let currentSourceName = '';
let layerMeta = new Map();
let layerFillColors = new Map();
let layerVisibility = new Map();
let routingLayerGroups = new Map();
let connectorLayerGroups = new Map();
let surfaceBatches = [];
let connectorBatches = [];
let polygonRecords = [];
let instanceBatch = null;
let edgeObjects = [];
let surfaceMaterials = new Set();
let colorTargetByRecord = new WeakMap();
let styledColorRecords = new Set();
let forceFullColorRefresh = true;
let lastXrayColorMode = false;
let selectedHierarchyPaths = new Set();
let selectedNetKeys = new Set();
let selectedPhysicalShapeIndices = new Set();
let physicalTraceResult = null;
let physicalTraceController = null;
let physicalTraceGeneration = 0;
const traceMode = document.querySelector('#traceMode');
const traceScope = document.querySelector('#traceScope');
const tracePhysicalBtn = document.querySelector('#tracePhysicalBtn');
const cancelPhysicalTraceBtn = document.querySelector('#cancelPhysicalTraceBtn');
const physicalTraceStatus = document.querySelector('#physicalTraceStatus');
const physicalTraceDiagnosticBox = document.querySelector('#physicalTraceDiagnostics');
const physicalTraceDiagnosticText = document.querySelector('#physicalTraceDiagnosticText');
let selectedInstancePath = '';
let selectedRenderRecord = null;
let highlightedMasterKey = '';
let highlightedMasterPaths = new Set();
let baseCamera = null;
let renderPending = false;
let fastMode = false;
let fastModeTimer = null;
let lastFastInteractionAt = 0;
let resizePending = false;
let loadController = null;
let prepareController = null;
let loadGeneration = 0;
let pendingLoadKey = '';
let lastLoadMs = 0;
let lastGeometryBuildMs = 0;
let lastPickMs = 0;
let lastRenderCalls = 0;
let lastRenderTriangles = 0;
let lastRenderMs = 0;
let lastColorUpdateMs = 0;
let lastPerformanceUiAt = 0;
let renderSerial = 0;
let fastDraftLayerCount = 0;
let lastHierarchyRows = [];
let layerTransformFrame = null;
let layerTransformTimer = null;
let layerAdjusting = false;
let renderedPinMarkerCount = 0;
const viaMergeOverrides = new Map();
const LIBRARY_SETTINGS_KEY = 'vl3d.librarySettings.v1';
const LIBRARY_SESSION_KEY = 'vl3d.librarySession.v1';
const NAVIGATION_SETTINGS_KEY = 'vl3d.navigation.v2';
const NAVIGATION_PRESETS = {
  natural: {
    mode: 'natural',
    invertOrbitX: true,
    invertOrbitY: true,
    invertPan: false,
    invertWheel: false,
  },
  cad: {
    mode: 'cad',
    invertOrbitX: false,
    invertOrbitY: false,
    invertPan: false,
    invertWheel: false,
  },
};
let navigationSettings = readNavigationSettings();
let initialViaMergeOverride = params.has('viaMerge')
  ? clamp(Number(params.get('viaMerge')), 0, 5)
  : null;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function readNavigationSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(NAVIGATION_SETTINGS_KEY) || 'null');
    const mode = saved?.mode === 'cad' ? 'cad' : 'natural';
    const preset = NAVIGATION_PRESETS[mode];
    return {
      mode,
      invertOrbitX: typeof saved?.invertOrbitX === 'boolean' ? saved.invertOrbitX : preset.invertOrbitX,
      invertOrbitY: typeof saved?.invertOrbitY === 'boolean' ? saved.invertOrbitY : preset.invertOrbitY,
      invertPan: typeof saved?.invertPan === 'boolean' ? saved.invertPan : preset.invertPan,
      invertWheel: typeof saved?.invertWheel === 'boolean' ? saved.invertWheel : preset.invertWheel,
    };
  } catch {
    return { ...NAVIGATION_PRESETS.natural };
  }
}

function persistNavigationSettings() {
  try {
    localStorage.setItem(NAVIGATION_SETTINGS_KEY, JSON.stringify(navigationSettings));
  } catch {}
}

function syncNavigationControls() {
  if (navigationModeSelect) navigationModeSelect.value = navigationSettings.mode;
  if (invertOrbitXToggle) invertOrbitXToggle.checked = navigationSettings.invertOrbitX;
  if (invertOrbitYToggle) invertOrbitYToggle.checked = navigationSettings.invertOrbitY;
  if (invertPanToggle) invertPanToggle.checked = navigationSettings.invertPan;
  if (invertWheelToggle) invertWheelToggle.checked = navigationSettings.invertWheel;
  if (navigationSummary) navigationSummary.textContent = navigationSettings.mode === 'cad' ? 'CAD' : 'Natural';
}

function applyNavigationPreset(mode) {
  navigationSettings = { ...(NAVIGATION_PRESETS[mode] || NAVIGATION_PRESETS.natural) };
  syncNavigationControls();
  persistNavigationSettings();
  updatePublicState();
}

function applyNavigationOverrides() {
  navigationSettings = {
    mode: navigationModeSelect?.value === 'cad' ? 'cad' : 'natural',
    invertOrbitX: invertOrbitXToggle?.checked === true,
    invertOrbitY: invertOrbitYToggle?.checked === true,
    invertPan: invertPanToggle?.checked === true,
    invertWheel: invertWheelToggle?.checked === true,
  };
  syncNavigationControls();
  persistNavigationSettings();
  updatePublicState();
}

function errorDetails(value, fallback = 'Operation failed') {
  const nested = value?.error && typeof value.error === 'object' ? value.error : null;
  const message = String(
    nested?.message
      || (typeof value?.error === 'string' ? value.error : '')
      || value?.message
      || (typeof value === 'string' ? value : '')
      || fallback,
  );
  const explicitCode = nested?.code || value?.code || value?.errorCode || value?.error_code || '';
  const embeddedCode = message.match(/\b(?:VL3D-)?E[0-9]{3,5}\b/i)?.[0] || '';
  const rawCode = String(explicitCode || embeddedCode).trim().toUpperCase();
  const code = /^E[0-9]{3,5}$/.test(rawCode) ? `VL3D-${rawCode}` : rawCode;
  return { message, code: /^VL3D-E[0-9]{3,5}$/.test(code) ? code : '' };
}

function responseError(payload, fallback) {
  const details = errorDetails(payload, fallback);
  const error = new Error(details.message);
  error.code = details.code || 'VL3D-E9003';
  error.details = payload?.error?.details || payload?.details || {};
  return error;
}

function codedError(code, message, cause = null) {
  const error = new Error(message);
  error.code = /^VL3D-E/.test(code) ? code : `VL3D-${code}`;
  if (cause) error.cause = cause;
  return error;
}

function renderErrorMessage(element, value, suffix = '') {
  if (!element) return;
  const details = errorDetails(value);
  element.replaceChildren(document.createTextNode(`${details.message}${suffix}`));
  if (!details.code) return;
  const link = document.createElement('a');
  link.className = 'error-help-link';
  link.href = `/public/errors.html#${encodeURIComponent(details.code)}`;
  link.textContent = `${details.code} help`;
  link.target = '_blank';
  link.rel = 'noopener';
  element.append(document.createTextNode(' '), link);
}

function layerThickness(layer, fallback = 0.2) {
  const raw = layer?.thickness;
  const thickness = raw === null || raw === '' || raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(thickness) && thickness >= 0 ? thickness : fallback;
}

function fmt(value) {
  if (!Number.isFinite(Number(value))) return '0';
  const number = Number(value);
  if (Math.abs(number) >= 100) return number.toFixed(1);
  if (Math.abs(number) >= 10) return number.toFixed(2);
  return number.toFixed(3);
}

function niceStep(target) {
  const safe = Math.max(0.001, Math.abs(target));
  const base = 10 ** Math.floor(Math.log10(safe));
  const normalized = safe / base;
  const multiple = normalized < 1.5 ? 1 : (normalized < 3 ? 2 : (normalized < 7 ? 5 : 10));
  return base * multiple;
}

function normalizedLayerName(value) {
  return String(value ?? '').trim().toUpperCase();
}

function explicitLayerSemantic(layer) {
  if (!layer || typeof layer !== 'object') return '';
  for (const candidate of [layer.semantic, layer.kind]) {
    const value = String(candidate || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
    if (['active', 'diff', 'diffusion'].includes(value)) return 'active';
    if (['poly', 'polysilicon', 'gate'].includes(value)) return 'poly';
    if (['contact', 'cut'].includes(value)) return 'contact';
    if (['metal', 'routingmetal', 'interconnect'].includes(value)
      || /^(?:metal|topmetal|capacitortopmetal)[0-9]+$/.test(value)) return 'metal';
    if (['via', 'routingvia'].includes(value) || /^(?:via|topvia)[0-9]+$/.test(value)) return 'via';
  }
  return '';
}

function declaredLayerSemantic(layer) {
  const semantic = String(layer?.semantic || '').trim();
  const normalized = semantic.toLowerCase().replace(/[\s_-]+/g, '');
  return semantic && !['unknown', 'other', 'substrate', 'auxiliary'].includes(normalized) ? semantic : '';
}

function layerSemantic(layer) {
  const explicit = explicitLayerSemantic(layer);
  if (explicit) return explicit;
  const name = normalizedLayerName(typeof layer === 'object' ? layer?.name : layer);
  if (['DIFF', 'OD', 'ACTIVE', 'AA'].includes(name)) return 'active';
  if (name.startsWith('POLY') || ['PO', 'PO1', 'PO2', 'GT', 'GATE', 'PC'].includes(name)) return 'poly';
  if (['CONT', 'CONTACT', 'CO', 'CT', 'CA'].includes(name)) return 'contact';
  if (/^(?:METAL|MET|M)[_-]?[0-9]+$/.test(name)) return 'metal';
  if (viaPair(name)) return 'via';
  return '';
}

function masterIdentity(master) {
  if (!master?.cell) return '';
  return `${master.library || ''}/${master.cell}/${master.view || 'layout'}`;
}

function metalNumber(layer) {
  if (layer && typeof layer === 'object') {
    const explicit = Number(layer.metal);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
  }
  const normalized = normalizedLayerName(typeof layer === 'object' ? layer?.name : layer);
  const match = normalized.match(/^(?:METAL|MET|M)[_-]?([0-9]+)$/);
  return match ? Number(match[1]) : null;
}

function viaPair(layer) {
  if (layer && typeof layer === 'object') {
    const lower = metalNumber(layer.lowerLayer);
    const upper = metalNumber(layer.upperLayer);
    if (lower != null && upper != null) return [lower, upper];
    if (explicitLayerSemantic(layer) === 'contact' && upper != null) return [0, upper];
    const numeric = (value) => value != null && value !== '' && Number.isFinite(Number(value));
    if (numeric(layer.lowerMetal) && numeric(layer.upperMetal)) {
      return [Number(layer.lowerMetal), Number(layer.upperMetal)];
    }
  }
  const normalized = normalizedLayerName(typeof layer === 'object' ? layer?.name : layer);
  if (['CONT', 'CONTACT', 'CO', 'CT', 'CA'].includes(normalized)) return [0, 1];
  // Match tools.pdk_profile.via_pair_from_name. These are display hints only;
  // physical tracing still requires endpoint evidence from the original input.
  const separated = normalized.match(/^(?:VIA|V)[_-]?([0-9]+)[_-]([0-9]+)$/);
  if (separated) return [Number(separated[1]), Number(separated[2])];
  const via = normalized.match(/^VIA[_-]?([0-9]+)$/);
  if (via) {
    const digits = via[1];
    const adjacent = [];
    for (let index = 1; index < digits.length; index += 1) {
      const lower = Number(digits.slice(0, index));
      const upper = Number(digits.slice(index));
      if (upper === lower + 1) adjacent.push([lower, upper]);
    }
    if (adjacent.length === 1) return adjacent[0];
    return digits.length <= 2 ? [Number(digits), Number(digits) + 1] : null;
  }
  const single = normalized.match(/^V[_-]?([0-9]+)$/);
  return single ? [Number(single[1]), Number(single[1]) + 1] : null;
}

function layerFromLookup(lookup, name) {
  const normalized = normalizedLayerName(name);
  if (!normalized || !lookup) return null;
  return lookup instanceof Map ? lookup.get(normalized) : lookup[normalized];
}

function connectorPair(layer, lookup = null) {
  if (layer && typeof layer === 'object' && layer.lowerLayer && layer.upperLayer) {
    const lower = metalNumber(layerFromLookup(lookup, layer.lowerLayer)) ?? metalNumber(layer.lowerLayer);
    const upper = metalNumber(layerFromLookup(lookup, layer.upperLayer)) ?? metalNumber(layer.upperLayer);
    if (lower != null && upper != null) return [lower, upper];
  }
  return viaPair(layer);
}

function layerStackValue(layer) {
  const semantic = layerSemantic(layer);
  const explicit = Number(layer?.stackIndex);
  if (semantic && Number.isFinite(explicit) && explicit >= 0) return explicit;
  const metal = metalNumber(layer);
  const pair = viaPair(layer);
  if (metal != null) return metal * 2 + 1;
  if (pair) return pair[0] * 2 + 2;
  if (semantic === 'poly') return 1;
  if (semantic === 'active') return 0;
  if (Number.isFinite(explicit)) return explicit;
  return -1000;
}

function isAuxiliaryLayer(layer) {
  if (!layer) return false;
  if (layer.routing === true) return false;
  if (layer.routing === false || layer.defaultVisible === false) return true;
  return ['other', 'substrate', 'auxiliary'].includes(String(layer.kind || '').toLowerCase());
}

function defaultLayerVisibility(layer) {
  return layer?.stackSource !== 'unresolved' && layer?.defaultVisible !== false && !isAuxiliaryLayer(layer);
}

function layerIsConnector(name) {
  const normalized = normalizedLayerName(name);
  const meta = layerMeta.get(normalized);
  const semantic = layerSemantic(meta || { name: normalized });
  return semantic === 'via' || semantic === 'contact';
}

function inferConnectorLayerFromInstance(instance) {
  const cell = String(instance?.master?.cell ?? '').toLowerCase();
  if (/(^|[_-])(cont|contact|ct)($|[_-])/.test(cell) || /^co($|[_-])/.test(cell)) {
    return firstExistingLayer(['CONT', 'CONTACT', 'CO', 'CT']);
  }
  const metalPair = cell.match(/m([0-9]+)[_-]m([0-9]+)/);
  if (metalPair) {
    const first = Number(metalPair[1]);
    const second = Number(metalPair[2]);
    return existingConnectorLayer(Math.min(first, second), Math.max(first, second));
  }
  const topVia = cell.match(/(?:^|[_-])tv([0-9]+)(?:$|[_-])/);
  if (topVia) {
    const name = `TV${topVia[1]}`;
    return layerIsConnector(name) && layerMeta.has(name) ? name : '';
  }
  const via = cell.match(/(?:^|[_-])((?:via|v)[_-]?[0-9]+(?:[_-][0-9]+)?)(?:$|[_-])/);
  const pair = via ? viaPair(via[1]) : null;
  return pair ? existingConnectorLayer(pair[0], pair[1]) : '';
}

function syntheticLayer(name, index, relationships = {}) {
  const normalized = normalizedLayerName(name);
  const pair = Array.isArray(relationships.pair) ? relationships.pair : viaPair({ name: normalized, ...relationships });
  const metal = metalNumber(normalized);
  const layer = {
    name: normalized,
    index,
    color: LAYER_COLORS[normalized] || '#8ecae6',
    shapeCount: 0,
    connectorCount: 0,
    kind: 'other',
    routing: true,
    stackIndex: layerStackValue({ name: normalized }),
    thickness: 0.2,
    inferred: true,
    connectivitySource: 'name-inference',
  };
  if (pair?.[0] === 0) {
    layer.kind = 'contact';
    layer.semantic = 'contact';
    layer.thickness = 0.1;
    layer.lowerLayers = ['DIFF', 'OD', 'ACTIVE', 'AA', 'POLY1', 'POLY', 'PO', 'GT'];
    layer.upperLayer = normalizedLayerName(relationships.upperLayer);
  } else if (pair) {
    layer.kind = 'via';
    layer.semantic = /^TV[12]$/.test(normalized) ? `top-via-${normalized.at(-1)}` : 'via';
    layer.stackIndex = pair[0] * 2 + 2;
    layer.thickness = 0.1;
    layer.lowerLayer = normalizedLayerName(relationships.lowerLayer);
    layer.upperLayer = normalizedLayerName(relationships.upperLayer);
    layer.lowerMetal = pair[0];
    layer.upperMetal = pair[1];
  } else if (metal != null) {
    layer.kind = 'metal';
    layer.semantic = 'metal';
    layer.metal = metal;
  } else if (layerSemantic({ name: normalized }) === 'poly') {
    layer.kind = 'poly';
    layer.semantic = 'poly';
  } else if (layerSemantic({ name: normalized }) === 'active') {
    layer.kind = 'active';
    layer.semantic = 'active';
  }
  return layer;
}

function declaredLayerEndpoints(layer) {
  return ['lowerLayer', 'upperLayer', 'lowerLayers', 'upperLayers'].some((key) => (
    Array.isArray(layer?.[key]) ? layer[key].length > 0 : String(layer?.[key] || '').trim().length > 0
  ));
}

function hasLayerStackEvidence(layer) {
  return !!explicitLayerSemantic(layer) || declaredLayerEndpoints(layer)
    || ['metal', 'stackIndex', 'zBottomUm', 'zTopUm'].some((key) => (
      layer?.[key] != null && layer[key] !== '' && Number.isFinite(Number(layer[key])) && Number(layer[key]) >= 0
    ));
}

// A layer may opt in to a parallel (non-stacking) position with an explicit `parallelStack: true`.
function parallelStackLayer(layer) {
  return layer?.parallelStack === true;
}

function normalizeLayerMetadata(layer) {
  const copy = { ...layer, name: normalizedLayerName(layer?.name) };
  const explicitlyDisabled = copy.routing === false;
  const explicitConductor = copy.routing === true
    && ['metal', 'poly', 'contact', 'via'].includes(String(copy.kind || '').toLowerCase());
  const specialMetal = parallelStackLayer(copy);
  const knownAuxiliary = ['HRI', 'RPO', 'NTN'].includes(copy.name);
  const semantic = layerSemantic(copy);
  if (specialMetal) {
    copy.parallelStack = true;
    if (!declaredLayerSemantic(copy)) copy.semantic = 'metal';
    copy.kind = 'metal';
    copy.routing = true;
    copy.defaultVisible = true;
    if (!Number.isFinite(Number(copy.stackIndex)) || Number(copy.stackIndex) < 0) copy.stackIndex = 11.5;
  } else if (semantic) {
    if (!declaredLayerSemantic(copy)) copy.semantic = semantic;
    copy.kind = semantic;
    copy.routing = true;
    if (!Number.isFinite(Number(copy.stackIndex)) || Number(copy.stackIndex) < 0) {
      copy.stackIndex = layerStackValue({ ...copy, stackIndex: undefined });
    }
  }
  if (knownAuxiliary && copy.routing !== true) {
    copy.kind = 'auxiliary';
    copy.routing = false;
    copy.defaultVisible = false;
  }
  if (explicitlyDisabled || hardNonConductiveLayerName(copy.name)
    || (nonConductiveLayerName(copy.name) && !explicitConductor)
    || (!semantic && !specialMetal)) {
    copy.routing = false;
    copy.defaultVisible = false;
  }
  const metal = metalNumber(copy);
  if (metal != null) copy.metal = metal;
  if (copy.lowerLayer) copy.lowerLayer = normalizedLayerName(copy.lowerLayer);
  if (copy.upperLayer) copy.upperLayer = normalizedLayerName(copy.upperLayer);
  if (Array.isArray(copy.lowerLayers)) copy.lowerLayers = copy.lowerLayers.map(normalizedLayerName);
  if (Array.isArray(copy.upperLayers)) copy.upperLayers = copy.upperLayers.map(normalizedLayerName);
  return copy;
}

function preferredMetalLayer(metalsByNumber, number) {
  return metalsByNumber.get(number)?.[0] || '';
}

function inferredConnectorName(lowerLayer, upperLayer, lowerMetal, upperMetal) {
  if (/^M[0-9]+$/.test(lowerLayer) && /^M[0-9]+$/.test(upperLayer)) return `V${lowerMetal}`;
  return `VIA${lowerMetal}${upperMetal}`;
}

function unclassifiedLayerWarning(data, layers) {
  const declared = Array.isArray(data?.technology?.unclassifiedLayers)
    ? data.technology.unclassifiedLayers
    : null;
  const requestedNames = declared
    ? declared.map((entry) => normalizedLayerName(typeof entry === 'object' ? entry?.name : entry))
    : layers
      .filter((layer) => {
        const semantic = String(layer?.semantic || '').trim().toLowerCase();
        return semantic === 'unknown' || (!declaredLayerSemantic(layer) && !layerSemantic(layer) && isAuxiliaryLayer(layer));
      })
      .map((layer) => layer.name);
  const byName = new Map(layers.map((layer) => [normalizedLayerName(layer.name), layer]));
  const names = [...new Set(requestedNames.filter(Boolean))]
    .filter((name) => isAuxiliaryLayer(byName.get(name)));
  if (!names.length) return '';
  const shapeCounts = Array.isArray(data?.shapes) ? new Map(names.map((name) => [name, 0])) : null;
  if (shapeCounts) {
    for (const shape of data.shapes) {
      const layerName = normalizedLayerName(shape?.layer);
      if (shapeCounts.has(layerName)) shapeCounts.set(layerName, shapeCounts.get(layerName) + 1);
    }
  }
  const countFor = (name) => {
    if (shapeCounts) return shapeCounts.get(name) || 0;
    const count = Number(byName.get(name)?.shapeCount);
    return Number.isFinite(count) && count >= 0 ? count : 0;
  };
  return `Unclassified layers hidden: ${names.map((name) => `${name} (${countFor(name)})`).join(', ')}`;
}

function approximateStackWarning(data, layers) {
  const technology = data?.technology;
  const profile = String(
    (typeof technology === 'object' ? technology?.profile : technology)
      || data?.technologyProfile
      || '',
  ).trim();
  const normalizedProfile = profile.toLowerCase();
  const genericProfile = !normalizedProfile
    || ['generic', 'unknown', 'geometry-only'].includes(normalizedProfile)
    || normalizedProfile.includes('generic-stream');
  const genericThickness = (layers || []).some((layer) => (
    layer?.routing !== false
    && (layer?.approximate === true || layer?.geometryApproximate === true || /fallback/i.test(String(layer?.thicknessSource || '')))
  )) || Boolean(technology?.approximateLayers?.length);
  const notes = [];
  const label = profile || String(technology?.library || data?.techLibrary || 'unidentified PDK');
  if (genericProfile || genericThickness) notes.push(`Approximate PDK stack (${label}): Z heights/thicknesses are approximate; XY dimensions match the original layout.`);
  if (technology?.unresolvedStackLayers?.length) notes.push(`Layer position unconfirmed (hidden by default): ${technology.unresolvedStackLayers.join(', ')}.`);
  return notes.join(' ');
}

function payloadWarningText(data) {
  if (!Array.isArray(data?.warnings)) return '';
  return data.warnings
    .map((warning) => typeof warning === 'string' ? warning : warning?.message || warning?.code || '')
    .map((warning) => String(warning).trim())
    .filter(Boolean)
    .join('; ');
}

function completeRoutingStack(data) {
  const byName = new Map();
  for (const layer of data.layers || []) {
    const copy = normalizeLayerMetadata(layer);
    byName.set(copy.name, copy);
  }
  const metalsByNumber = new Map();
  for (const layer of byName.values()) {
    const metal = metalNumber(layer);
    if (metal == null) continue;
    if (!metalsByNumber.has(metal)) metalsByNumber.set(metal, []);
    metalsByNumber.get(metal).push(layer.name);
  }
  for (const layer of byName.values()) {
    const semantic = layerSemantic(layer);
    const pair = connectorPair(layer, byName);
    if (declaredLayerEndpoints(layer)) continue;
    if (semantic === 'contact') {
      const upperMetal = pair?.[1] || 1;
      if (!byName.has(layer.upperLayer)) layer.upperLayer = preferredMetalLayer(metalsByNumber, upperMetal);
      if (!layer.lowerLayers?.length) layer.lowerLayers = ['DIFF', 'OD', 'ACTIVE', 'AA', 'POLY1', 'POLY', 'PO', 'GT'];
      layer.connectivitySource = 'name-inference';
    } else if (semantic === 'via' && pair) {
      if (!byName.has(layer.lowerLayer)) layer.lowerLayer = preferredMetalLayer(metalsByNumber, pair[0]);
      if (!byName.has(layer.upperLayer)) layer.upperLayer = preferredMetalLayer(metalsByNumber, pair[1]);
      layer.lowerMetal = pair[0];
      layer.upperMetal = pair[1];
      layer.connectivitySource = 'name-inference';
      if (!Number.isFinite(Number(layer.stackIndex)) || Number(layer.stackIndex) < 0) layer.stackIndex = pair[0] * 2 + 2;
    }
  }
  const metalNumbers = [...metalsByNumber.keys()].sort((first, second) => first - second);
  if (metalNumbers.length) {
    for (let metal = metalNumbers[0]; metal < metalNumbers[metalNumbers.length - 1]; metal += 1) {
      const lowerLayer = preferredMetalLayer(metalsByNumber, metal);
      const upperLayer = preferredMetalLayer(metalsByNumber, metal + 1);
      if (!lowerLayer || !upperLayer) continue;
      const alreadyPresent = [...byName.values()].some((layer) => {
        const pair = connectorPair(layer, byName);
        return layerSemantic(layer) === 'via' && pair?.[0] === metal && pair?.[1] === metal + 1;
      });
      if (alreadyPresent) continue;
      const viaName = inferredConnectorName(lowerLayer, upperLayer, metal, metal + 1);
      if (!byName.has(viaName)) {
        byName.set(viaName, syntheticLayer(viaName, byName.size, {
          lowerLayer,
          upperLayer,
          pair: [metal, metal + 1],
        }));
      }
    }
  }
  const layers = [...byName.values()]
    .sort((first, second) => layerStackValue(first) - layerStackValue(second) || first.name.localeCompare(second.name))
    .map((layer, index) => ({ ...layer, index }));
  return {
    ...data,
    layers,
    unclassifiedLayerWarning: unclassifiedLayerWarning(data, layers),
    approximateStackWarning: approximateStackWarning(data, layers),
  };
}

function paletteLayerKey(layerName, layer = null) {
  const normalized = normalizedLayerName(layerName);
  const descriptor = layer || { name: normalized };
  const semantic = layerSemantic(descriptor);
  const metal = metalNumber(descriptor);
  if (metal != null) return `METAL${metal}`;
  const pair = viaPair(descriptor);
  if (pair?.[0] === 0) return 'CONT';
  if (pair) return `VIA${pair[0]}${pair[1]}`;
  if (semantic === 'poly') return 'POLY';
  if (semantic === 'active') return 'ACTIVE';
  return normalized;
}

function selectedPaletteName() {
  const requested = paletteSelect?.value || DEFAULT_PALETTE;
  return Object.hasOwn(LAYER_PALETTES, requested) ? requested : DEFAULT_PALETTE;
}

function currentPalette() {
  return LAYER_PALETTES[selectedPaletteName()];
}

function resolvedFillColor(layerName, sourceColor = '', layer = null) {
  const normalized = normalizedLayerName(layerName);
  const key = paletteLayerKey(normalized, layer);
  const palette = currentPalette();
  const metal = metalNumber(key);
  if (metal != null) {
    const cycleKey = `METAL${((metal - 1) % 6) + 1}`;
    return palette[key] || palette[cycleKey] || sourceColor || LAYER_COLORS[key] || '#8ecae6';
  }
  const pair = viaPair(key);
  if (pair?.[0] > 0) {
    const lower = ((pair[0] - 1) % 5) + 1;
    return palette[key] || palette[`VIA${lower}${lower + 1}`] || sourceColor || LAYER_COLORS[key] || '#8ecae6';
  }
  return palette[key] || palette[normalized] || sourceColor || LAYER_COLORS[key] || '#8ecae6';
}

function currentTheme() {
  return THEMES[themeSelect?.value === 'light' ? 'light' : 'dark'];
}

function boxSize(bbox) {
  return {
    x: Math.max(0.001, bbox.max[0] - bbox.min[0]),
    y: Math.max(0.001, bbox.max[1] - bbox.min[1]),
  };
}

function boxCenter(bbox) {
  return {
    x: (bbox.min[0] + bbox.max[0]) / 2,
    y: (bbox.min[1] + bbox.max[1]) / 2,
  };
}

function computeBounds(data) {
  const bbox = data.bbox || { min: [0, 0], max: [1, 1] };
  const sizeX = Math.max(1, bbox.max[0] - bbox.min[0]);
  const sizeY = Math.max(1, bbox.max[1] - bbox.min[1]);
  return {
    minX: bbox.min[0],
    minY: bbox.min[1],
    maxX: bbox.max[0],
    maxY: bbox.max[1],
    sizeX,
    sizeY,
    centerX: (bbox.min[0] + bbox.max[0]) / 2,
    centerY: (bbox.min[1] + bbox.max[1]) / 2,
    radius: Math.max(sizeX, sizeY, 2),
  };
}

function worldX(value) {
  return value - currentBounds.centerX;
}

function worldZ(value) {
  return -(value - currentBounds.centerY);
}

function verticalUnit() {
  return 10;
}

function layerBaseY(layerName) {
  const meta = layerMeta.get(normalizedLayerName(layerName));
  return Number(meta?.base || 0) * Number(zScale?.value || 1) * verticalUnit();
}

function layerVisualHeight(layerName) {
  const meta = layerMeta.get(normalizedLayerName(layerName));
  return Math.max(1e-9, layerThickness(meta) * Number(zScale?.value || 1) * verticalUnit());
}

function updateZScaleLabel() {
  if (zScaleValue) zScaleValue.textContent = `${(Number(zScale?.value || 1) * verticalUnit()).toFixed(1).replace(/\.0$/, '')}×`;
}

function stackHeight() {
  if (!currentData?.layers?.length) return 1;
  return Math.max(...currentData.layers.map((layer) => layerBaseY(layer.name) + layerVisualHeight(layer.name)), 1);
}

function rebuildLayerMeta() {
  layerMeta = new Map();
  layerFillColors = new Map();
  let base = 0;
  let auxiliaryDepth = 0;
  for (const layer of currentData.layers || []) {
    const name = normalizedLayerName(layer.name);
    let thickness = layerThickness(layer);
    const unresolvedStack = layer.stackSource === 'unresolved';
    const auxiliary = unresolvedStack || (isAuxiliaryLayer(layer) && layerSemantic(layer) !== 'active');
    const explicitBottom = layer.zBottomUm == null ? NaN : Number(layer.zBottomUm);
    const explicitTop = layer.zTopUm == null ? NaN : Number(layer.zTopUm);
    const calibrated = Number.isFinite(explicitBottom) && Number.isFinite(explicitTop) && explicitTop > explicitBottom;
    if (calibrated) thickness = explicitTop - explicitBottom;
    const parallelSpecialMetal = parallelStackLayer(layer);
    const sourceColor = layer.color || LAYER_COLORS[name] || '#8ecae6';
    const copy = {
      ...layer,
      name,
      base: calibrated ? explicitBottom : auxiliary
        ? -(auxiliaryDepth + thickness)
        : parallelSpecialMetal
          ? Math.max(0, base - thickness)
          : base,
      thickness,
      color: sourceColor,
      fillColor: resolvedFillColor(name, sourceColor, layer),
    };
    layerMeta.set(name, copy);
    layerFillColors.set(name, new THREE.Color(copy.fillColor));
    if (auxiliary) auxiliaryDepth += thickness * 0.14;
    else if (!parallelSpecialMetal) base = Math.max(base, copy.base + thickness);
    if (!layerVisibility.has(name)) layerVisibility.set(name, defaultLayerVisibility(layer));
  }
}

function firstExistingLayer(names) {
  return (names || []).map(normalizedLayerName).find((name) => layerMeta.has(name)) || '';
}

function existingMetalLayer(number) {
  for (const [name, meta] of layerMeta) {
    if (layerSemantic(meta) === 'metal' && metalNumber(meta) === number) return name;
  }
  return '';
}

function existingConnectorLayer(lower, upper) {
  for (const [name, meta] of layerMeta) {
    const pair = connectorPair(meta, layerMeta);
    if (layerSemantic(meta) === 'via' && pair?.[0] === lower && pair?.[1] === upper) return name;
  }
  const lowerLayer = existingMetalLayer(lower);
  const upperLayer = existingMetalLayer(upper);
  if (!lowerLayer || !upperLayer) return '';
  const inferred = inferredConnectorName(lowerLayer, upperLayer, lower, upper);
  return layerMeta.has(inferred) ? inferred : '';
}

function connectorSpan(layerName) {
  const normalized = normalizedLayerName(layerName);
  const meta = layerMeta.get(normalized) || {};
  const ownHeight = layerVisualHeight(normalized);
  if (meta.zBottomUm != null && meta.zTopUm != null && Number(meta.zTopUm) > Number(meta.zBottomUm)) {
    return { bottom: layerBaseY(normalized), top: layerBaseY(normalized) + ownHeight };
  }
  let bottom = layerBaseY(normalized);
  let top = bottom + ownHeight;
  if (meta.kind === 'contact') {
    const lower = firstExistingLayer(meta.lowerLayers || ['DIFF', 'OD', 'ACTIVE', 'AA', 'POLY1', 'POLY', 'PO', 'GT']);
    const upper = meta.upperLayer && layerMeta.has(normalizedLayerName(meta.upperLayer))
      ? normalizedLayerName(meta.upperLayer)
      : existingMetalLayer(1);
    if (lower) bottom = layerBaseY(lower) + layerVisualHeight(lower) * 0.96;
    if (upper) top = layerBaseY(upper) + layerVisualHeight(upper) * 0.04;
  } else if (meta.kind === 'via') {
    if (meta.lowerLayer && layerMeta.has(meta.lowerLayer)) {
      bottom = layerBaseY(meta.lowerLayer) + layerVisualHeight(meta.lowerLayer) * 0.96;
    }
    if (meta.upperLayer && layerMeta.has(meta.upperLayer)) {
      top = layerBaseY(meta.upperLayer) + layerVisualHeight(meta.upperLayer) * 0.04;
    }
  }
  const minimum = Math.min(bottom, top);
  return { bottom: minimum, top: Math.max(minimum + ownHeight * 0.7, Math.max(bottom, top)) };
}

function isTextShape(shape) {
  return excludedShape(shape, layerMeta.get(normalizedLayerName(shape.layer)) || {});
}

function createPrismGeometry(footprint, holes = []) {
  return buildPrismGeometry(footprint, holes, worldX, worldZ);
}

class SimpleOrbitControls {
  constructor(object, domElement) {
    this.object = object;
    this.domElement = domElement;
    this.target = new THREE.Vector3();
    this.distance = 80;
    this.theta = Math.PI / 4;
    this.phi = Math.PI / 3;
    this.drag = null;
    this.inputFrame = null;
    this.pendingOrbitX = 0;
    this.pendingOrbitY = 0;
    this.pendingPanX = 0;
    this.pendingPanY = 0;
    this.pendingZoomLog = 0;
    this.restoreAfterFrame = false;
    this.autoRotate = demoMode;
    this.autoRotateSpeed = 0.65;
    domElement.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    domElement.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
    domElement.addEventListener('contextmenu', (event) => event.preventDefault());
    window.addEventListener('pointermove', (event) => this.onPointerMove(event));
    window.addEventListener('pointerup', (event) => this.onPointerUp(event));
    window.addEventListener('pointercancel', (event) => this.onPointerCancel(event));
  }

  syncFromCamera() {
    const offset = this.object.position.clone().sub(this.target);
    this.distance = Math.max(0.001, offset.length());
    const spherical = new THREE.Spherical().setFromVector3(offset);
    this.theta = spherical.theta;
    this.phi = spherical.phi;
  }

  onPointerDown(event) {
    if (event.button !== 0 && event.button !== 2) return;
    if (this.drag) return;
    event.preventDefault();
    this.autoRotate = false;
    this.drag = {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      pan: event.button === 2 || event.shiftKey,
      pointerId: event.pointerId,
    };
    this.domElement.setPointerCapture?.(event.pointerId);
  }

  onPointerMove(event) {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    let deltaX = event.clientX - this.drag.x;
    let deltaY = event.clientY - this.drag.y;
    const dragThreshold = event.pointerType === 'touch' ? 6 : 2;
    if (!this.drag.moved && Math.hypot(
      event.clientX - this.drag.startX,
      event.clientY - this.drag.startY,
    ) > dragThreshold) {
      this.drag.moved = true;
      deltaX = event.clientX - this.drag.startX;
      deltaY = event.clientY - this.drag.startY;
    }
    if (!this.drag.moved) return;
    this.drag.x = event.clientX;
    this.drag.y = event.clientY;
    if (this.drag.pan) {
      this.pendingPanX += deltaX;
      this.pendingPanY += deltaY;
    } else {
      this.pendingOrbitX += deltaX;
      this.pendingOrbitY += deltaY;
    }
    this.scheduleInputFrame();
  }

  onPointerUp(event) {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    this.domElement.releasePointerCapture?.(this.drag.pointerId);
    const moved = this.drag.moved;
    const pickPin = !moved && !this.drag.pan;
    this.drag = null;
    if (moved) this.finishInteraction();
    else if (pickPin) { const pin = hitTestPin(event.clientX, event.clientY); if (pin) selectPin(pin); }
  }

  onPointerCancel(event) {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    const moved = this.drag.moved;
    this.domElement.releasePointerCapture?.(this.drag.pointerId);
    this.drag = null;
    if (moved) this.finishInteraction();
  }

  onWheel(event) {
    event.preventDefault();
    this.autoRotate = false;
    const unit = event.deltaMode === 1 ? 16 : (event.deltaMode === 2 ? window.innerHeight : 1);
    const direction = navigationSettings.invertWheel ? -1 : 1;
    this.pendingZoomLog += clamp(event.deltaY * unit, -240, 240) * 0.001 * direction;
    this.restoreAfterFrame = true;
    this.scheduleInputFrame();
  }

  scheduleInputFrame() {
    if (this.inputFrame != null) return;
    this.inputFrame = requestAnimationFrame(() => this.flushInputFrame());
  }

  flushInputFrame() {
    this.inputFrame = null;
    const orbitX = this.pendingOrbitX;
    const orbitY = this.pendingOrbitY;
    const panX = this.pendingPanX;
    const panY = this.pendingPanY;
    const zoomLog = this.pendingZoomLog;
    const restore = this.restoreAfterFrame;
    this.pendingOrbitX = 0;
    this.pendingOrbitY = 0;
    this.pendingPanX = 0;
    this.pendingPanY = 0;
    this.pendingZoomLog = 0;
    this.restoreAfterFrame = false;
    if (!orbitX && !orbitY && !panX && !panY && !zoomLog) return;
    const orbitXDirection = navigationSettings.invertOrbitX ? -1 : 1;
    const orbitYDirection = navigationSettings.invertOrbitY ? 1 : -1;
    this.theta += orbitX * 0.006 * orbitXDirection;
    this.phi = clamp(this.phi + orbitY * 0.006 * orbitYDirection, 0.002, Math.PI - 0.002);
    if (panX || panY) {
      const scale = this.distance * 0.0018;
      const panDirection = navigationSettings.invertPan ? -1 : 1;
      const right = new THREE.Vector3().setFromMatrixColumn(this.object.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(this.object.matrix, 1);
      this.target.addScaledVector(right, -panX * scale * panDirection);
      this.target.addScaledVector(up, panY * scale * panDirection);
    }
    if (zoomLog) this.distance = clamp(this.distance * Math.exp(zoomLog), 0.01, 100000);
    this.update();
    beginFastMode();
    requestRender();
    if (restore && !this.drag) endFastModeSoon(180);
  }

  finishInteraction() {
    if (this.inputFrame != null) {
      this.restoreAfterFrame = true;
      return;
    }
    endFastModeSoon(180);
  }

  isInteracting() {
    return Boolean(this.drag || this.inputFrame != null);
  }

  update() {
    const spherical = new THREE.Spherical(this.distance, this.phi, this.theta);
    this.object.position.copy(new THREE.Vector3().setFromSpherical(spherical).add(this.target));
    this.object.lookAt(this.target);
    updateCameraClipping();
  }
}

const controls = new SimpleOrbitControls(camera, renderer.domElement);

function qualityPixelRatio(isFast = fastMode) {
  const deviceRatio = window.devicePixelRatio || 1;
  if (isFast) return Math.min(deviceRatio, 0.85);
  const quality = qualitySelect?.value || 'auto';
  if (quality === 'performance' || quality === 'fast') return Math.min(deviceRatio, 1);
  if (quality === 'balanced') return Math.min(deviceRatio, 1.25);
  if (quality === 'high' || quality === 'quality') return Math.min(deviceRatio, 2);
  return Math.min(deviceRatio, deviceRatio > 1.5 ? 1.5 : deviceRatio);
}

function setRoutingSurfaceVisibility(visible) {
  for (const batch of surfaceBatches) batch.mesh.visible = visible;
  for (const entry of polygonRecords) entry.mesh.visible = visible;
}

function beginFastMode() {
  window.clearTimeout(fastModeTimer);
  fastModeTimer = null;
  lastFastInteractionAt = performance.now();
  if (fastMode) return;
  fastMode = true;
  const visibleMetals = [...routingLayerGroups.keys()]
    .filter((layer) => layerSemantic(layerMeta.get(layer) || { name: layer }) === 'metal' && layerVisibility.get(layer) !== false)
    .sort((first, second) => layerStackValue(layerMeta.get(second) || { name: second }) - layerStackValue(layerMeta.get(first) || { name: first }));
  const draftLayers = new Set(visibleMetals.slice(0, 3));
  const addVisibleDraftLayer = (layerName) => {
    const layer = normalizedLayerName(layerName);
    if (routingLayerGroups.has(layer) && layerVisibility.get(layer) !== false) draftLayers.add(layer);
  };
  if (selectedRenderRecord?.layer) addVisibleDraftLayer(selectedRenderRecord.layer);
  for (const netKey of selectedNetKeys) {
    let inspected = 0;
    for (const shape of currentIndex?.shapesByNet.get(netKey) || []) {
      addVisibleDraftLayer(shape.layer);
      inspected += 1;
      if (inspected >= 512 || draftLayers.size >= 6) break;
    }
  }
  if (!draftLayers.size) {
    const visibleLayers = [...routingLayerGroups.keys()]
      .filter((layer) => layerVisibility.get(layer) !== false)
      .sort((first, second) => layerStackValue(layerMeta.get(second)) - layerStackValue(layerMeta.get(first)));
    for (const layer of visibleLayers.slice(0, 3)) draftLayers.add(layer);
  }
  for (const [layer, group] of routingLayerGroups) group.visible = draftLayers.has(layer);
  setRoutingSurfaceVisibility(false);
  connectorRoot.visible = false;
  instanceRoot.visible = false;
  pinRoot.visible = false;
  fastDraftLayerCount = draftLayers.size;
  if (wireframeToggle?.checked) {
    for (const edgeObject of edgeObjects) edgeObject.visible = routingToggle?.checked !== false;
  }
  updatePerformanceInfo(true);
  requestRender();
}

function endFastModeSoon(delayMs = 180) {
  window.clearTimeout(fastModeTimer);
  const restoreFullMode = () => {
    const remaining = delayMs - (performance.now() - lastFastInteractionAt);
    if (remaining > 0 || controls.isInteracting()) {
      fastModeTimer = window.setTimeout(restoreFullMode, Math.max(32, remaining));
      return;
    }
    fastMode = false;
    fastDraftLayerCount = 0;
    routingRoot.visible = routingToggle?.checked !== false;
    setRoutingSurfaceVisibility(true);
    connectorRoot.visible = routingToggle?.checked !== false;
    instanceRoot.visible = instancesToggle?.checked === true;
    pinRoot.visible = pinsToggle?.checked !== false;
    for (const [layer, group] of routingLayerGroups) group.visible = layerVisibility.get(layer) !== false;
    for (const [layer, group] of connectorLayerGroups) group.visible = layerVisibility.get(layer) !== false;
    updateWireframeVisibility();
    pinRoot.traverse((object) => {
      if (object.userData.pinLabel) object.visible = pinsToggle?.checked !== false;
    });
    updatePerformanceInfo(true);
    requestRender();
  };
  fastModeTimer = window.setTimeout(restoreFullMode, delayMs);
}

function updateCameraClipping() {
  if (!currentBounds) return;
  const sceneRadius = Math.max(currentBounds.radius, stackHeight(), 1);
  const near = Math.max(sceneRadius / 8000, controls.distance / 2500, 0.005);
  const far = Math.max(controls.distance + sceneRadius * 12, sceneRadius * 20);
  if (Math.abs(camera.near - near) > near * 0.08 || Math.abs(camera.far - far) > far * 0.08) {
    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
  }
}

function requestRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(renderFrame);
}

function renderFrame() {
  const startedAt = performance.now();
  renderPending = false;
  if (controls.autoRotate) {
    controls.theta -= controls.autoRotateSpeed * 0.0025;
    controls.update();
  }
  renderer.render(scene, camera);
  lastRenderCalls = renderer.info.render.calls;
  lastRenderTriangles = renderer.info.render.triangles;
  drawScaleOverlay();
  drawSelectedPinAnnotation();
  drawAttitudeOverlay();
  lastRenderMs = performance.now() - startedAt;
  renderSerial += 1;
  updatePerformanceInfo();
  updatePublicState();
  if (controls.autoRotate) requestRender();
}

function resizeRenderer() {
  const width = Math.max(1, viewport?.clientWidth || window.innerWidth);
  const height = Math.max(1, viewport?.clientHeight || window.innerHeight);
  renderer.setPixelRatio(qualityPixelRatio());
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  resizeOverlayCanvases();
  requestRender();
}

function resizeOverlayCanvases() {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = viewport?.clientWidth || window.innerWidth;
  const height = viewport?.clientHeight || window.innerHeight;
  axisOverlay.width = Math.floor(width * ratio);
  axisOverlay.height = Math.floor(height * ratio);
  axisOverlay.style.width = `${width}px`;
  axisOverlay.style.height = `${height}px`;
  axisContext.setTransform(ratio, 0, 0, ratio, 0, 0);
  if (!attitudeCanvas || !attitudeContext) return;
  const size = Math.round(attitudeCanvas.getBoundingClientRect().width || 146);
  attitudeCanvas.width = Math.floor(size * ratio);
  attitudeCanvas.height = Math.floor(size * ratio);
  attitudeContext.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function disposeMaterial(material) {
  if (!material) return;
  if (Array.isArray(material)) {
    for (const entry of material) disposeMaterial(entry);
    return;
  }
  material.map?.dispose?.();
  material.dispose?.();
}

function disposeObject(object) {
  object.traverse((child) => {
    child.geometry?.dispose?.();
    disposeMaterial(child.material);
  });
}

function clearGroup(group) {
  for (const child of [...group.children]) disposeObject(child);
  group.clear();
}

function clearLayoutScene() {
  clearGroup(routingRoot);
  clearGroup(connectorRoot);
  clearGroup(instanceRoot);
  clearGroup(pinRoot);
  clearGroup(gridRoot);
  clearGroup(axisRoot);
  routingLayerGroups = new Map();
  connectorLayerGroups = new Map();
  surfaceBatches = [];
  connectorBatches = [];
  polygonRecords = [];
  instanceBatch = null;
  edgeObjects = [];
  surfaceMaterials = new Set();
  colorTargetByRecord = new WeakMap();
  styledColorRecords = new Set();
  forceFullColorRefresh = true;
  lastXrayColorMode = false;
  lastColorUpdateMs = 0;
  renderedPinMarkerCount = 0;
  selectedRenderRecord = null;
}

function baseLayerColor(layerName, seed = '', partIndex = 0) {
  const meta = layerMeta.get(normalizedLayerName(layerName));
  return new THREE.Color(meta?.color || LAYER_COLORS[normalizedLayerName(layerName)] || '#8ecae6');
}

function createSurfaceMaterial(layerName) {
  const meta = layerMeta.get(normalizedLayerName(layerName)) || {};
  const material = new THREE.MeshStandardMaterial({
    color: surfaceTintColor,
    vertexColors: false,
    roughness: meta.kind === 'metal' ? 0.46 : 0.66,
    metalness: meta.kind === 'metal' ? 0.2 : 0.03,
    flatShading: true,
    side: THREE.FrontSide,
    transparent: false,
    opacity: 1,
    depthWrite: true,
    polygonOffset: true,
    polygonOffsetFactor: 0.45,
    polygonOffsetUnits: 0.45,
  });
  surfaceMaterials.add(material);
  return material;
}

function createEdgeMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    toneMapped: false,
    depthWrite: false,
    depthTest: true,
    uniforms: {
      opacity: { value: 0.72 },
      multiplier: { value: currentTheme().edgeMultiplier },
    },
    vertexShader: `
      attribute vec3 instanceOffset;
      attribute vec3 instanceScale;
      attribute vec3 instanceColor;
      varying vec3 edgeColor;
      void main() {
        edgeColor = instanceColor;
        vec3 transformed = position * instanceScale + instanceOffset;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
      }
    `,
    fragmentShader: `
      uniform float opacity;
      uniform float multiplier;
      varying vec3 edgeColor;
      void main() {
        gl_FragColor = vec4(clamp(edgeColor * multiplier, 0.0, 1.0), opacity);
        #include <colorspace_fragment>
      }
    `,
  });
}

function styledRecordColor(record, baseColor) {
  const members = record.records?.length ? record.records : [record];
  const activeFilter = selectedHierarchyPaths.size > 0 || selectedNetKeys.size > 0 || selectedPhysicalShapeIndices.size > 0 || highlightedMasterKey;
  const pathMatch = selectedHierarchyPaths.size > 0
    && members.some((member) => pathUnderSelection(member.hierPath, selectedHierarchyPaths));
  const netMatch = members.some((member) => (member.netKey && selectedNetKeys.has(member.netKey)) || physicalRecordMatch(member));
  const masterMatch = Boolean(highlightedMasterKey && members.some((member) => (
    member.masterKey === highlightedMasterKey
    || pathUnderSelection(member.hierPath, highlightedMasterPaths)
  )));
  temporaryColor.copy(baseColor || record.baseColor || new THREE.Color(0x8ecae6));
  if (xrayToggle?.checked && activeFilter && !pathMatch && !netMatch && !masterMatch) {
    temporaryColor.multiplyScalar(0.2);
  }
  if (masterMatch) temporaryColor.lerp(selectionPathColor, 0.46);
  if (pathMatch) temporaryColor.lerp(selectionPathColor, 0.72);
  if (netMatch) temporaryColor.lerp(selectionNetColor, 0.82);
  if (selectedRenderRecord === record) temporaryColor.lerp(exactSelectionColor, 0.86);
  return temporaryColor;
}

function recordStyleColor(record) {
  return styledRecordColor(record, record.baseColor);
}

function recordFillStyleColor(record) {
  const fillColor = record.layer
    ? layerFillColors.get(normalizedLayerName(record.layer))
    : record.baseColor;
  return styledRecordColor(record, fillColor);
}

function createInstancedEdges(records, matrixForRecord) {
  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  const baseEdges = new THREE.EdgesGeometry(boxGeometry);
  boxGeometry.dispose();
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', baseEdges.getAttribute('position').clone());
  const offsets = new Float32Array(records.length * 3);
  const scales = new Float32Array(records.length * 3);
  const colors = new Float32Array(records.length * 3);
  geometry.setAttribute('instanceOffset', new THREE.InstancedBufferAttribute(offsets, 3));
  geometry.setAttribute('instanceScale', new THREE.InstancedBufferAttribute(scales, 3));
  geometry.setAttribute('instanceColor', new THREE.InstancedBufferAttribute(colors, 3));
  geometry.instanceCount = records.length;
  baseEdges.dispose();
  const edgeObject = new THREE.LineSegments(geometry, createEdgeMaterial());
  edgeObject.frustumCulled = false;
  edgeObject.userData.records = records;
  edgeObject.userData.matrixForRecord = matrixForRecord;
  edgeObject.userData.edgeObject = true;
  edgeObjects.push(edgeObject);
  updateInstancedEdgeMatrices(edgeObject);
  return edgeObject;
}

function decomposeMatrix(matrix, offset, scale) {
  const elements = matrix.elements;
  offset.set(elements[12], elements[13], elements[14]);
  scale.set(
    Math.hypot(elements[0], elements[1], elements[2]),
    Math.hypot(elements[4], elements[5], elements[6]),
    Math.hypot(elements[8], elements[9], elements[10]),
  );
}

function updateInstancedEdgeMatrices(edgeObject) {
  const records = edgeObject.userData.records || [];
  const matrixForRecord = edgeObject.userData.matrixForRecord;
  const offsetAttribute = edgeObject.geometry.getAttribute('instanceOffset');
  const scaleAttribute = edgeObject.geometry.getAttribute('instanceScale');
  const offset = new THREE.Vector3();
  const scale = new THREE.Vector3();
  records.forEach((record, index) => {
    const matrix = matrixForRecord(record, temporaryMatrix);
    decomposeMatrix(matrix, offset, scale);
    offsetAttribute.setXYZ(index, offset.x, offset.y, offset.z);
    scaleAttribute.setXYZ(index, scale.x, scale.y, scale.z);
  });
  offsetAttribute.needsUpdate = true;
  scaleAttribute.needsUpdate = true;
}

function updateBatchColors(batch) {
  const meshColors = batch.mesh?.instanceColor;
  const edgeColors = batch.edgeObject?.geometry.getAttribute('instanceColor');
  const meshArray = meshColors?.array;
  const edgeArray = edgeColors?.array;
  batch.records.forEach((record, index) => {
    const offset = index * 3;
    if (meshArray) {
      const fillColor = recordFillStyleColor(record);
      meshArray[offset] = fillColor.r;
      meshArray[offset + 1] = fillColor.g;
      meshArray[offset + 2] = fillColor.b;
    }
    if (edgeArray) {
      const edgeColor = recordStyleColor(record);
      edgeArray[offset] = edgeColor.r;
      edgeArray[offset + 1] = edgeColor.g;
      edgeArray[offset + 2] = edgeColor.b;
    }
  });
  if (meshColors) meshColors.needsUpdate = true;
  if (edgeColors) edgeColors.needsUpdate = true;
}

function registerBatchColorTargets(batch) {
  batch.records.forEach((record, index) => colorTargetByRecord.set(record, { batch, index }));
  if (batch.mesh?.instanceColor) batch.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  const edgeColors = batch.edgeObject?.geometry.getAttribute('instanceColor');
  if (edgeColors) edgeColors.setUsage(THREE.DynamicDrawUsage);
}

function recordHasEmphasis(record) {
  if (selectedRenderRecord === record) return true;
  const members = record.records?.length ? record.records : [record];
  if (selectedHierarchyPaths.size > 0 && members.some((member) => pathUnderSelection(member.hierPath, selectedHierarchyPaths))) return true;
  if (members.some((member) => (member.netKey && selectedNetKeys.has(member.netKey)) || physicalRecordMatch(member))) return true;
  return Boolean(highlightedMasterKey && members.some((member) => (
    member.masterKey === highlightedMasterKey
    || pathUnderSelection(member.hierPath, highlightedMasterPaths)
  )));
}

function visitColorRecords(visitor) {
  for (const batch of surfaceBatches) for (const record of batch.records) visitor(record);
  for (const batch of connectorBatches) for (const record of batch.records) visitor(record);
  for (const record of instanceBatch?.records || []) visitor(record);
  for (const entry of polygonRecords) visitor(entry.record);
}

function writeRecordColor(record, dirtyBatches) {
  const target = colorTargetByRecord.get(record);
  if (!target) return;
  if (target.polygon) {
    target.polygon.mesh.material.color.copy(recordFillStyleColor(record)).multiply(surfaceTintColor);
    target.polygon.edge.material.color.copy(recordStyleColor(record)).multiplyScalar(currentTheme().edgeMultiplier);
    return;
  }
  const meshColors = target.batch.mesh?.instanceColor;
  const edgeColors = target.batch.edgeObject?.geometry.getAttribute('instanceColor');
  const offset = target.index * 3;
  if (meshColors) {
    const fillColor = recordFillStyleColor(record);
    meshColors.array[offset] = fillColor.r;
    meshColors.array[offset + 1] = fillColor.g;
    meshColors.array[offset + 2] = fillColor.b;
  }
  if (edgeColors) {
    const edgeColor = recordStyleColor(record);
    edgeColors.array[offset] = edgeColor.r;
    edgeColors.array[offset + 1] = edgeColor.g;
    edgeColors.array[offset + 2] = edgeColor.b;
  }
  dirtyBatches.add(target.batch);
}

function flushBatchColors(batches) {
  for (const batch of batches) {
    if (batch.mesh?.instanceColor) batch.mesh.instanceColor.needsUpdate = true;
    const edgeColors = batch.edgeObject?.geometry.getAttribute('instanceColor');
    if (edgeColors) edgeColors.needsUpdate = true;
  }
}

function shapeMatrix(record, target = new THREE.Matrix4()) {
  const size = boxSize(record.bbox);
  const center = boxCenter(record.bbox);
  target.makeScale(size.x, 1, size.y);
  target.setPosition(worldX(center.x), 0.5, worldZ(center.y));
  return target;
}

function connectorMatrix(record, target = new THREE.Matrix4()) {
  const size = boxSize(record.bbox);
  const center = boxCenter(record.bbox);
  const span = connectorSpan(record.layer);
  const height = Math.max(0.01, span.top - span.bottom);
  target.makeScale(size.x, height, size.y);
  target.setPosition(worldX(center.x), span.bottom + height / 2, worldZ(center.y));
  return target;
}

function instanceMatrix(record, target = new THREE.Matrix4()) {
  const size = boxSize(record.bbox);
  const center = boxCenter(record.bbox);
  const height = stackHeight();
  target.makeScale(size.x, height, size.y);
  target.setPosition(worldX(center.x), height / 2, worldZ(center.y));
  return target;
}

function createInstancedBatch(records, layerName, matrixForRecord, kind) {
  if (!records.length) return null;
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = createSurfaceMaterial(layerName);
  const mesh = new THREE.InstancedMesh(geometry, material, records.length);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  records.forEach((record, index) => {
    mesh.setMatrixAt(index, matrixForRecord(record, temporaryMatrix));
    mesh.setColorAt(index, record.baseColor);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.userData = { kind, records };
  const edgeObject = createInstancedEdges(records, matrixForRecord);
  const batch = { mesh, edgeObject, records, layer: layerName, matrixForRecord, kind };
  registerBatchColorTargets(batch);
  updateBatchColors(batch);
  return batch;
}

function ensureLayerGroup(root, groups, layerName) {
  const normalized = normalizedLayerName(layerName);
  if (groups.has(normalized)) return groups.get(normalized);
  const group = new THREE.Group();
  group.name = normalized;
  group.userData.layer = normalized;
  group.visible = layerVisibility.get(normalized) !== false;
  root.add(group);
  groups.set(normalized, group);
  return group;
}

function buildRoutingGeometry() {
  const buckets = new Map();
  for (const shape of currentData.shapes || []) {
    const layer = normalizedLayerName(shape.layer);
    if (!layerMeta.has(layer) || layerIsConnector(layer) || isTextShape(shape)) continue;
    const footprints = shapeFootprints(shape);
    footprints.forEach((footprint, partIndex) => {
      const bbox = footprintBBox(footprint);
      const record = {
        kind: 'shape',
        shape,
        partIndex,
        bbox,
        footprint,
        layer,
        hierPath: shape.hierPath || '',
        ownerCell: shape.ownerCell || '',
        masterCell: '',
        masterKey: '',
        netKey: shape.netKey || '',
        baseColor: baseLayerColor(layer, `${shape.hierPath}|${shape.net}|${shape.type}`, partIndex),
      };
      if (!shape.holes?.length && isAxisAlignedRectangle(footprint)) {
        if (!buckets.has(layer)) buckets.set(layer, []);
        buckets.get(layer).push(record);
      } else {
        const geometry = createPrismGeometry(footprint, shape.holes || []);
        if (!geometry) return;
        const material = createSurfaceMaterial(layer);
        material.vertexColors = false;
        material.color.copy(recordFillStyleColor(record)).multiply(surfaceTintColor);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData = { kind: 'polygon', record };
        const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 26), new THREE.LineBasicMaterial({
          color: record.baseColor.clone().multiplyScalar(currentTheme().edgeMultiplier),
          transparent: true,
          opacity: 0.72,
          depthWrite: false,
          toneMapped: false,
        }));
        edge.userData.edgeObject = true;
        edgeObjects.push(edge);
        const group = ensureLayerGroup(routingRoot, routingLayerGroups, layer);
        group.add(mesh, edge);
        const polygon = { mesh, edge, record };
        polygonRecords.push(polygon);
        colorTargetByRecord.set(record, { polygon });
      }
    });
  }
  for (const [layer, records] of buckets) {
    const batch = createInstancedBatch(records, layer, shapeMatrix, 'shape-batch');
    if (!batch) continue;
    const group = ensureLayerGroup(routingRoot, routingLayerGroups, layer);
    group.add(batch.mesh, batch.edgeObject);
    surfaceBatches.push(batch);
  }
  updateRoutingLayerTransforms();
}

function connectorRecordFromShape(shape) {
  return {
    kind: 'connector',
    source: shape,
    bbox: shape.bbox,
    layer: normalizedLayerName(shape.layer),
    hierPath: shape.hierPath || '',
    ownerCell: shape.ownerCell || '',
    masterCell: '',
    masterKey: '',
    netKey: shape.netKey || '',
  };
}

function connectorRecordFromInstance(instance) {
  const layer = inferConnectorLayerFromInstance(instance);
  if (!layer || !instance.bbox) return null;
  return {
    kind: 'connector',
    source: instance,
    bbox: instance.bbox,
    layer,
    hierPath: instance.hierPath || '',
    ownerCell: '',
    masterCell: instance.master?.cell || '',
    masterKey: masterIdentity(instance.master),
    netKey: '',
  };
}

function collectConnectorRecords() {
  const records = [];
  for (const shape of currentData.shapes || []) {
    if (!layerIsConnector(shape.layer) || !shape.bbox || isTextShape(shape)) continue;
    records.push(connectorRecordFromShape(shape));
  }
  return records;
}

function viaMergeSize() {
  return clamp(Number(viaMerge?.value || 0), 0, 5);
}

function currentLayoutKey() {
  if (!currentData) return '';
  return `${currentData.library || ''}/${currentData.cell || ''}/${currentData.view || 'layout'}`;
}

function applyAutomaticViaLod() {
  if (!viaMerge || !currentData) return;
  const key = currentLayoutKey();
  if (viaMergeOverrides.has(key)) {
    viaMerge.value = String(viaMergeOverrides.get(key));
    return;
  }
  if (initialViaMergeOverride != null) {
    viaMergeOverrides.set(key, initialViaMergeOverride);
    viaMerge.value = String(initialViaMergeOverride);
    initialViaMergeOverride = null;
    return;
  }
  const connectorCount = currentData.layers.reduce((total, layer) => (
    total + (layerIsConnector(layer.name)
      ? Number(layer.shapeCount || 0) + Number(layer.connectorCount || 0)
      : 0)
  ), 0);
  viaMerge.value = connectorCount >= 300000 ? '5' : connectorCount >= 100000 ? '4' : '0';
}

function aggregateConnectorRecords(records) {
  if (physicalMode()) return records;
  const grid = viaMergeSize();
  if (grid <= 0) return records;
  const groups = new Map();
  for (const record of records) {
    const center = boxCenter(record.bbox);
    const gridX = Math.floor(center.x / grid);
    const gridY = Math.floor(center.y / grid);
    const semanticKey = record.netKey || record.masterCell || record.ownerCell || 'connector';
    const key = `${record.layer}|${semanticKey}|${gridX}|${gridY}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        ...record,
        bbox: {
          min: [...record.bbox.min],
          max: [...record.bbox.max],
        },
        mergedCount: 0,
        records: [],
      };
      groups.set(key, group);
    }
    group.bbox.min[0] = Math.min(group.bbox.min[0], record.bbox.min[0]);
    group.bbox.min[1] = Math.min(group.bbox.min[1], record.bbox.min[1]);
    group.bbox.max[0] = Math.max(group.bbox.max[0], record.bbox.max[0]);
    group.bbox.max[1] = Math.max(group.bbox.max[1], record.bbox.max[1]);
    group.mergedCount += 1;
    group.records.push(record);
  }
  return [...groups.values()];
}

function clearConnectorGeometry() {
  const connectorEdges = new Set(connectorBatches.map((batch) => batch.edgeObject).filter(Boolean));
  for (const batch of connectorBatches) surfaceMaterials.delete(batch.mesh?.material);
  clearGroup(connectorRoot);
  edgeObjects = edgeObjects.filter((object) => !connectorEdges.has(object));
  connectorLayerGroups = new Map();
  connectorBatches = [];
  styledColorRecords.clear();
  forceFullColorRefresh = true;
}

function buildConnectorGeometry() {
  clearConnectorGeometry();
  const sourceRecords = collectConnectorRecords();
  const displayRecords = aggregateConnectorRecords(sourceRecords);
  const buckets = new Map();
  for (const record of displayRecords) {
    record.baseColor = baseLayerColor(record.layer, `${record.hierPath}|${record.netKey}|connector`, record.mergedCount || 0);
    if (!buckets.has(record.layer)) buckets.set(record.layer, []);
    buckets.get(record.layer).push(record);
  }
  for (const [layer, records] of buckets) {
    const batch = createInstancedBatch(records, layer, connectorMatrix, 'connector-batch');
    if (!batch) continue;
    const group = ensureLayerGroup(connectorRoot, connectorLayerGroups, layer);
    group.userData.baseSpan = connectorSpan(layer);
    group.add(batch.mesh, batch.edgeObject);
    connectorBatches.push(batch);
  }
  updateViaMergeLabel(displayRecords.length, sourceRecords.length);
}

function buildInstanceGeometry() {
  clearGroup(instanceRoot);
  instanceRoot.scale.set(1, 1, 1);
  const records = [];
  for (const instance of currentData.instances || []) {
    if (!instance.bbox || inferConnectorLayerFromInstance(instance)) continue;
    records.push({
      kind: 'instance',
      instance,
      bbox: instance.bbox,
      hierPath: instance.hierPath || '',
      ownerCell: '',
      masterCell: instance.master?.cell || '',
      masterKey: masterIdentity(instance.master),
      netKey: '',
      baseColor: new THREE.Color(0xb9c2bd),
    });
  }
  if (!records.length) return;
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    wireframe: true,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, records.length);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  records.forEach((record, index) => {
    mesh.setMatrixAt(index, instanceMatrix(record, temporaryMatrix));
    mesh.setColorAt(index, record.baseColor);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.userData = { kind: 'instance-batch', records };
  instanceRoot.add(mesh);
  instanceRoot.visible = instancesToggle?.checked === true;
  instanceBatch = {
    mesh,
    records,
    matrixForRecord: instanceMatrix,
    kind: 'instance-batch',
    baseHeight: stackHeight(),
  };
  registerBatchColorTargets(instanceBatch);
  updateBatchColors(instanceBatch);
}

function updateRoutingLayerTransforms() {
  for (const [layer, group] of routingLayerGroups) {
    group.position.y = layerBaseY(layer);
    group.scale.y = layerVisualHeight(layer);
    if (!fastMode) group.visible = layerVisibility.get(layer) !== false;
  }
}

function commitLayerTransforms() {
  if (layerTransformFrame != null) cancelAnimationFrame(layerTransformFrame);
  if (layerTransformTimer != null) window.clearTimeout(layerTransformTimer);
  layerTransformFrame = null;
  layerTransformTimer = null;
  updateRoutingLayerTransforms();
  for (const [layer, group] of connectorLayerGroups) {
    if (!fastMode) group.visible = layerVisibility.get(layer) !== false;
    const baseSpan = group.userData.baseSpan;
    const span = connectorSpan(layer);
    if (baseSpan) {
      const baseHeight = Math.max(0.01, baseSpan.top - baseSpan.bottom);
      const height = Math.max(0.01, span.top - span.bottom);
      const scaleY = height / baseHeight;
      group.scale.y = scaleY;
      group.position.y = (span.bottom + height / 2)
        - (baseSpan.bottom + baseHeight / 2) * scaleY;
    }
  }
  if (instanceBatch) {
    instanceRoot.scale.y = stackHeight() / Math.max(0.01, instanceBatch.baseHeight || stackHeight());
  }
  rebuildPinMarkers();
  rebuildGridAndAxes();
  updateCameraClipping();
  layerAdjusting = false;
  if (fastMode) endFastModeSoon(50);
  requestRender();
}

function scheduleLayerTransformPreview() {
  layerAdjusting = true;
  beginFastMode();
  if (layerTransformFrame == null) {
    layerTransformFrame = requestAnimationFrame(() => {
      layerTransformFrame = null;
      updateRoutingLayerTransforms();
      updateCameraClipping();
      requestRender();
    });
  }
  if (layerTransformTimer != null) window.clearTimeout(layerTransformTimer);
  layerTransformTimer = window.setTimeout(commitLayerTransforms, 240);
}

function updateAllColors() {
  const startedAt = performance.now();
  const activeFilter = selectedHierarchyPaths.size > 0 || selectedNetKeys.size > 0 || selectedPhysicalShapeIndices.size > 0 || highlightedMasterKey;
  const xrayColorMode = Boolean(xrayToggle?.checked && activeFilter);
  if (forceFullColorRefresh || xrayColorMode || lastXrayColorMode) {
    for (const batch of [...surfaceBatches, ...connectorBatches]) updateBatchColors(batch);
    if (instanceBatch) updateBatchColors(instanceBatch);
    for (const entry of polygonRecords) {
      entry.mesh.material.color.copy(recordFillStyleColor(entry.record)).multiply(surfaceTintColor);
      entry.edge.material.color.copy(recordStyleColor(entry.record)).multiplyScalar(currentTheme().edgeMultiplier);
    }
    styledColorRecords = new Set();
    if (!xrayColorMode) visitColorRecords((record) => {
      if (recordHasEmphasis(record)) styledColorRecords.add(record);
    });
    forceFullColorRefresh = false;
  } else {
    const nextStyledRecords = new Set();
    visitColorRecords((record) => {
      if (recordHasEmphasis(record)) nextStyledRecords.add(record);
    });
    const dirtyRecords = new Set([...styledColorRecords, ...nextStyledRecords]);
    const dirtyBatches = new Set();
    for (const record of dirtyRecords) writeRecordColor(record, dirtyBatches);
    flushBatchColors(dirtyBatches);
    styledColorRecords = nextStyledRecords;
  }
  lastXrayColorMode = xrayColorMode;
  refreshSelectionPanelState();
  updateInspector();
  lastColorUpdateMs = performance.now() - startedAt;
  requestRender();
}

function updateMaterialState() {
  const requestedAlpha = clamp(Number(alphaScale?.value || 1), 0.15, 1);
  const xrayFactor = xrayToggle?.checked ? 0.46 : 1;
  const opacity = requestedAlpha * xrayFactor;
  for (const material of surfaceMaterials) {
    material.opacity = opacity;
    material.transparent = opacity < 0.995;
    material.depthWrite = opacity >= 0.72;
    material.side = opacity < 0.85 ? THREE.DoubleSide : THREE.FrontSide;
    material.needsUpdate = true;
  }
  updateWireframeVisibility();
  requestRender();
}

function updateWireframeVisibility() {
  const wireframe = wireframeToggle?.checked === true;
  for (const material of surfaceMaterials) {
    if (material.wireframe === wireframe) continue;
    material.wireframe = wireframe;
    material.needsUpdate = true;
  }
  for (const edgeObject of edgeObjects) {
    edgeObject.visible = (fastMode || !wireframe) && routingToggle?.checked !== false;
    if (edgeObject.material?.uniforms?.multiplier) {
      edgeObject.material.uniforms.multiplier.value = currentTheme().edgeMultiplier;
    }
  }
  requestRender();
}

function rebuildGridAndAxes() {
  if (!currentBounds) return;
  clearGroup(gridRoot);
  clearGroup(axisRoot);
  const theme = currentTheme();
  const size = Math.max(currentBounds.sizeX, currentBounds.sizeY, 1);
  const divisions = clamp(Math.round(size / niceStep(size / 24)), 8, 100);
  const grid = new THREE.GridHelper(size * 1.35, divisions, theme.gridMajor, theme.gridMinor);
  grid.position.y = -0.025;
  gridRoot.add(grid);
  const framePoints = [
    new THREE.Vector3(worldX(currentBounds.minX), 0, worldZ(currentBounds.minY)),
    new THREE.Vector3(worldX(currentBounds.maxX), 0, worldZ(currentBounds.minY)),
    new THREE.Vector3(worldX(currentBounds.maxX), 0, worldZ(currentBounds.maxY)),
    new THREE.Vector3(worldX(currentBounds.minX), 0, worldZ(currentBounds.maxY)),
    new THREE.Vector3(worldX(currentBounds.minX), 0, worldZ(currentBounds.minY)),
  ];
  const frame = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(framePoints),
    new THREE.LineBasicMaterial({ color: theme.frame, transparent: true, opacity: 0.65 }),
  );
  gridRoot.add(frame);
  const axes = new THREE.AxesHelper(Math.max(size * 0.08, stackHeight() * 0.15, 1));
  axes.setColors(theme.axisX, theme.axisZ, theme.axisY);
  axes.position.set(worldX(currentBounds.minX), 0.02, worldZ(currentBounds.minY));
  axisRoot.add(axes);
}

function updateLayerVisibility(layerName, visible) {
  const normalized = normalizedLayerName(layerName);
  layerVisibility.set(normalized, visible);
  if (routingLayerGroups.has(normalized)) routingLayerGroups.get(normalized).visible = visible;
  if (connectorLayerGroups.has(normalized)) connectorLayerGroups.get(normalized).visible = visible;
  updateStats();
  updateSelectionLegend();
  if (byId('layerFilter')?.value === 'shown') updateLayerPanel();
  requestRender();
}

function setAllLayersVisible(visible) {
  if (!currentData) return;
  for (const layer of currentData.layers) updateLayerVisibility(layer.name, visible && layer.stackSource !== 'unresolved' && !isAuxiliaryLayer(layer));
  updateLayerPanel();
}

function displayLayerName(layer) {
  const name = normalizedLayerName(layer?.name);
  const metal = name.match(/^METAL([0-9]+)$/);
  if (metal) return `M${metal[1]}`;
  return /^VIA/.test(name) ? name.toLowerCase() : name;
}

function layerCountText(layer) {
  const shapes = Number(layer.shapeCount || 0);
  const connectors = Number(layer.connectorCount || 0);
  const count = connectors ? `${shapes}+${connectors}` : String(shapes);
  return `${layer.kind === 'contact' ? 'via' : (layer.kind || 'layer')} ${count}${layer.inferred ? ' inferred' : ''}`;
}

function updateLayerPanel() {
  if (!layerList || !currentData) return;
  layerList.textContent = '';
  const filter = byId('layerFilter')?.value || 'conductive';
  const layers = [...currentData.layers].filter((layer) => filter !== 'shown' || (layerVisibility.get(layer.name) !== false && routingToggle?.checked !== false))
    .sort((first, second) => (filter === 'conductive' ? Number(isAuxiliaryLayer(first)) - Number(isAuxiliaryLayer(second)) : 0)
      || layerStackValue(second) - layerStackValue(first));
  for (const layer of layers) {
    const row = document.createElement('label');
    row.className = 'layer-row';
    row.dataset.layer = layer.name;
    const layerStack = layerMeta.get(normalizedLayerName(layer.name));
    if (layerStack) {
      row.dataset.bottom = String(layerStack.base);
      row.dataset.thickness = String(layerStack.thickness);
      row.dataset.top = String(layerStack.base + layerStack.thickness);
      row.title = `${layer.name} · z ${fmt(layerStack.base)}–${fmt(layerStack.base + layerStack.thickness)} um`;
    }
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = layerVisibility.get(layer.name) !== false;
    input.addEventListener('change', () => updateLayerVisibility(layer.name, input.checked));
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = layerStack?.fillColor || layer.color;
    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = displayLayerName(layer);
    name.title = layer.name;
    const count = document.createElement('span');
    count.className = 'layer-count';
    count.textContent = layerCountText(layer);
    row.append(input, swatch, name, count);
    layerList.append(row);
  }
}

function updateHighlightOptions() {
  if (!highlightSelect || !currentData) return;
  const counts = new Map();
  for (const instance of currentData.instances || []) {
    const key = masterIdentity(instance.master);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  highlightSelect.textContent = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'All master cells';
  highlightSelect.append(all);
  for (const [key, count] of [...counts].sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = `${key} (${count})`;
    highlightSelect.append(option);
  }
  highlightedMasterKey = '';
  highlightedMasterPaths = new Set();
  highlightSelect.value = '';
}

function refreshHighlightedMasterPaths() {
  highlightedMasterPaths = new Set();
  if (!highlightedMasterKey || !currentData) return;
  for (const instance of currentData.instances || []) {
    if (masterIdentity(instance.master) === highlightedMasterKey) highlightedMasterPaths.add(instance.hierPath);
  }
}

function updateHierarchyPanel() {
  if (!hierarchyList || !currentIndex || !currentData) return;
  const search = hierarchySearch?.value || '';
  const maxDepth = Number(hierarchyDepthInput?.value || currentIndex.maxDepth);
  if (hierarchyDepthValue) hierarchyDepthValue.textContent = `0-${maxDepth}`;
  const matching = (currentData.instances || []).filter((instance) => hierarchyMatches(instance, search, maxDepth));
  const rows = matching.slice(0, hierarchyRowLimit);
  lastHierarchyRows = rows;
  hierarchyList.textContent = '';
  const rootPath = currentIndex.rootPath;
  const rootMatches = !search || `${currentData.library || ''}/${currentData.cell}/${currentData.view || 'layout'}`
    .toLocaleLowerCase().includes(search.toLocaleLowerCase());
  if (rootMatches) {
    const rootRow = document.createElement('div');
    rootRow.className = `hierarchy-row root-row${selectedHierarchyPaths.has(rootPath) ? ' selected' : ''}`;
    rootRow.dataset.path = rootPath;
    const rootInput = document.createElement('input');
    rootInput.type = 'checkbox';
    rootInput.checked = selectedHierarchyPaths.has(rootPath);
    rootInput.title = 'Highlight the complete top-level layout';
    rootInput.addEventListener('change', () => toggleHierarchySelection(rootPath, rootInput.checked, true));
    const rootButton = document.createElement('button');
    rootButton.type = 'button';
    rootButton.className = 'hierarchy-item';
    rootButton.style.setProperty('--depth', '0');
    rootButton.innerHTML = `<span class="hierarchy-path">${escapeHtml(currentData.cell)}</span><span class="hierarchy-master">top scope</span>`;
    rootButton.title = `${currentIndex.displayName}\nTop-level pins and nets`;
    rootButton.addEventListener('click', () => selectInstance(rootPath, true));
    rootRow.append(rootInput, rootButton);
    hierarchyList.append(rootRow);
  }
  for (const instance of rows) {
    const row = document.createElement('div');
    row.className = `hierarchy-row${selectedHierarchyPaths.has(instance.hierPath) ? ' selected' : ''}`;
    row.dataset.path = instance.hierPath;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = selectedHierarchyPaths.has(instance.hierPath);
    input.title = 'Highlight this exact occurrence and its subtree';
    input.addEventListener('change', () => toggleHierarchySelection(instance.hierPath, input.checked, true));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hierarchy-item';
    button.style.setProperty('--depth', String(Math.min(instance.depth, 8)));
    const leaf = instance.hierPath.split('/').pop();
    button.innerHTML = `<span class="hierarchy-path">${escapeHtml(leaf)}</span><span class="hierarchy-master">${escapeHtml(instance.master?.cell || 'unknown')}</span><span class="hierarchy-full-path">${escapeHtml(instance.hierPath)}</span>`;
    button.title = `${instance.hierPath}\n${instance.master?.library || ''}/${instance.master?.cell || ''}/${instance.master?.view || ''}`;
    button.addEventListener('click', () => selectInstance(instance.hierPath, true));
    row.append(input, button);
    hierarchyList.append(row);
  }
  if (matching.length > rows.length) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'list-note';
    more.textContent = `Show more instances (${rows.length}/${matching.length})`;
    more.addEventListener('click', () => { hierarchyRowLimit += 260; updateHierarchyPanel(); });
    hierarchyList.append(more);
  }
}

function refreshSelectionPanelState() {
  for (const row of hierarchyList?.querySelectorAll('.hierarchy-row') || []) {
    const selected = selectedHierarchyPaths.has(row.dataset.path || '');
    row.classList.toggle('selected', selected);
    const input = row.querySelector('input[type="checkbox"]');
    if (input) input.checked = selected;
  }
  for (const button of netList?.querySelectorAll('.net-row') || []) {
    button.classList.toggle('selected', selectedNetKeys.has(button.dataset.netKey || ''));
  }
}

function updateNetPanel() {
  if (!netList || !currentIndex) return;
  const search = netSearch?.value || '';
  const matching = search
    ? currentIndex.netRows.filter((record) => netMatches(record, search))
    : currentIndex.netRows;
  const rows = matching.slice(0, 180);
  netList.textContent = '';
  for (const record of rows) {
    const traced = selectedNetKeys.has(record.key);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `net-row${traced ? ' selected' : ''}`;
    button.dataset.netKey = record.key;
    button.title = `${record.path}::${record.net}\n${record.layers.join(', ')}`;
    button.innerHTML = `<span class="net-name">${escapeHtml(record.net)}</span><span class="net-scope">${escapeHtml(record.path)}</span><span class="net-count">${record.shapeCount}</span>`;
    button.addEventListener('click', (event) => traceNet(record.key, event.ctrlKey || event.metaKey));
    netList.append(button);
  }
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'list-note';
    empty.textContent = currentIndex.netRows.length ? 'No matching scoped nets' : 'No electrical net data in this export';
    netList.append(empty);
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function toggleHierarchySelection(path, selected, showPins = false) {
  cancelPhysicalTrace(true);
  if (selected) selectedHierarchyPaths.add(path);
  else selectedHierarchyPaths.delete(path);
  selectedInstancePath = selected ? (showPins || !selectedInstancePath ? path : selectedInstancePath)
    : selectedInstancePath === path ? [...selectedHierarchyPaths].at(-1) || '' : selectedInstancePath;
  selectedRenderRecord = null;
  rebuildPinMarkers();
  updateAllColors();
}

function physicalRecordMatch(record) {
  const shape = record.shape || record.source;
  return Number.isInteger(shape?.shapeIndex) && selectedPhysicalShapeIndices.has(shape.shapeIndex);
}

function physicalMode() { return traceMode?.value === 'physical'; }

function setPhysicalTraceStatus(message, running = false) {
  if (physicalTraceStatus) physicalTraceStatus.textContent = message;
  if (cancelPhysicalTraceBtn) cancelPhysicalTraceBtn.disabled = !running;
  if (tracePhysicalBtn) tracePhysicalBtn.disabled = !physicalMode() || !currentData || running;
}

function cancelPhysicalTrace(quiet = false) {
  physicalTraceGeneration += 1;
  physicalTraceController?.abort();
  physicalTraceController = null;
  selectedPhysicalShapeIndices.clear();
  physicalTraceResult = null;
  if (physicalTraceDiagnosticBox) physicalTraceDiagnosticBox.hidden = true;
  setPhysicalTraceStatus(quiet ? (physicalMode() ? 'Select a pin, then trace its connected geometry.'
    : 'Named nets follow exported electrical metadata.') : 'Trace canceled. Select a pin to start again.');
}

function physicalSeedPins() {
  const pins = selectedRenderRecord?.kind === 'pin'
    ? currentIndex.pins.filter((candidate) => candidate.hierPath === selectedRenderRecord.pin.hierPath && candidate.terminal === selectedRenderRecord.pin.terminal)
    : selectedPinRecords();
  // Figure indices address the original pin array, preserving path extensions,
  // holes and all source geometry as well as the original terminal spelling.
  return pins.map((pin) => currentElectricalData?.pins?.[pin.figureIndex] || pin);
}

async function startPhysicalTrace() {
  if (!currentData || !currentElectricalData || !currentIndex) return;
  const pins = physicalSeedPins();
  cancelPhysicalTrace(true);
  if (!pins.length) { setPhysicalTraceStatus('This module has no pin figures. Select a module with pins; an unannotated GDS file needs pin annotations.'); return; }
  if (pins.length > 256) { setPhysicalTraceStatus('More than 256 pin figures are selected. Choose one pin or a smaller module for geometry tracing.'); return; }
  const scopePaths = traceScope?.value === 'module' ? [...selectedHierarchyPaths] : null;
  if (scopePaths && !scopePaths.length) { setPhysicalTraceStatus('Select a module for the requested trace scope.'); return; }
  selectedNetKeys.clear();
  const generation = physicalTraceGeneration;
  const data = currentData;
  const electricalData = currentElectricalData;
  const controller = new AbortController();
  physicalTraceController = controller;
  setPhysicalTraceStatus('Building conductor index and tracing geometry...', true);
  updateAllColors();
  try {
    // Send the actual in-memory layout, including local drag/drop files. A local
    // filename is never interpreted as a server filesystem path.
    const result = await requestPhysicalTrace({ layout: electricalData, pins, scopePaths }, {
      signal: controller.signal,
      onProgress: (progress) => {
        if (generation === physicalTraceGeneration) {
          const message = progress.message || progress.phase || progress.stage || 'Tracing geometry...';
          setPhysicalTraceStatus(progress.total ? `${message} (${progress.done || 0}/${progress.total})` : message, true);
        }
      },
    });
    if (generation !== physicalTraceGeneration || data !== currentData
      || electricalData !== currentElectricalData || controller.signal.aborted) return;
    if (!result || !Array.isArray(result.shapeIndices) || result.shapeIndices.some((index) => !Number.isInteger(index) || index < 0 || index >= data.shapes.length)) {
      throw codedError('E9003', 'Physical trace returned invalid shape indices');
    }
    physicalTraceResult = result;
    selectedPhysicalShapeIndices = new Set(result.shapeIndices);
    setPhysicalTraceStatus(traceResultSummary(result));
    const diagnostics = traceDiagnostics(result);
    if (physicalTraceDiagnosticBox) { physicalTraceDiagnosticBox.hidden = !diagnostics; physicalTraceDiagnosticBox.open = result.complete !== true; }
    if (physicalTraceDiagnosticText) physicalTraceDiagnosticText.textContent = diagnostics;
    updateAllColors();
  } catch (error) {
    if (generation !== physicalTraceGeneration || controller.signal.aborted) return;
    setPhysicalTraceStatus(`Physical trace failed: ${error.message}`);
  } finally {
    if (physicalTraceController === controller) physicalTraceController = null;
    requestRender();
  }
}

function selectInstance(path, replaceSelection = true) {
  cancelPhysicalTrace(true);
  if (!currentIndex || (path !== currentIndex.rootPath && !currentIndex.instancesByPath.has(path))) return;
  if (replaceSelection) selectedHierarchyPaths = new Set([path]);
  else selectedHierarchyPaths.add(path);
  selectedInstancePath = path;
  selectedRenderRecord = null;
  revealInspector();
  rebuildPinMarkers();
  updateAllColors();
}

function clearHierarchySelection() {
  cancelPhysicalTrace(true);
  selectedHierarchyPaths.clear();
  selectedInstancePath = '';
  selectedRenderRecord = null;
  rebuildPinMarkers();
  updateAllColors();
}

function traceNet(key, additive = false, renderRecord = null) {
  cancelPhysicalTrace(true);
  if (traceMode) traceMode.value = 'named';
  if (traceScope) traceScope.disabled = true;
  setPhysicalTraceStatus('Named nets follow exported electrical metadata.');
  const starting = additive ? new Set([...selectedNetKeys, key]) : new Set([key]);
  selectedNetKeys = traceScopedNets(currentIndex, starting);
  selectedInstancePath = '';
  selectedRenderRecord = renderRecord;
  rebuildPinMarkers();
  revealInspector();
  updateAllColors();
}

function syncDrawerState(drawer) {
  drawer?.closest('.workspace-panel')?.classList.toggle('is-collapsed', !drawer.open);
  if (window.innerWidth > 900) {
    appElement?.style.setProperty('--explorer-width', workspaceDrawer?.open ? (window.innerWidth <= 1150 ? '220px' : '270px') : '42px');
    appElement?.style.setProperty('--inspector-width', inspectorDrawer?.open ? (window.innerWidth <= 1150 ? '286px' : '324px') : '42px');
  }
  requestAnimationFrame(resizeRenderer);
}

function toggleWorkspacePanel(panel) {
  if (window.innerWidth <= 900 && appElement.dataset.panel === panel && !appElement.classList.contains('dock-collapsed')) {
    appElement.classList.add('dock-collapsed');
    byId('explorerTab').setAttribute('aria-pressed', 'false'); byId('pinsTab').setAttribute('aria-pressed', 'false');
    requestAnimationFrame(resizeRenderer); return;
  }
  showWorkspacePanel(panel);
}

function showWorkspacePanel(panel) {
  const drawer = panel === 'inspector' ? inspectorDrawer : workspaceDrawer;
  if (drawer) drawer.open = true;
  if (appElement) appElement.dataset.panel = panel;
  appElement?.classList.remove('dock-collapsed');
  byId('explorerTab')?.setAttribute('aria-pressed', String(panel === 'explorer'));
  byId('pinsTab')?.setAttribute('aria-pressed', String(panel === 'inspector'));
  syncDrawerState(drawer);
}

function revealInspector() {
  if (!inspectorDrawer) return;
  showWorkspacePanel('inspector');
}

function clearNetSelection() {
  cancelPhysicalTrace(true);
  selectedNetKeys.clear();
  updateAllColors();
}

function traceExternalConnections() {
  if (physicalMode()) { startPhysicalTrace(); return; }
  cancelPhysicalTrace(true);
  if (!selectedInstancePath || !currentIndex) return;
  const connections = currentIndex.connectionsByOccurrence.get(selectedInstancePath) || [];
  const parentKeys = connections.map((connection) => connection.parentNetKey).filter(Boolean);
  selectedNetKeys = traceScopedNets(currentIndex, parentKeys);
  updateAllColors();
}

function selectedPinRecords() {
  if (!currentIndex) return [];
  const paths = selectedHierarchyPaths.size ? [...selectedHierarchyPaths] : selectedInstancePath ? [selectedInstancePath] : [];
  return paths.flatMap((path) => currentIndex.pinsByPath.get(path) || []);
}

function visiblePinRecords() {
  return selectedPinRecords();
}

function pinPosition(pin) {
  const center = boxCenter(pin.bbox);
  const layer = layerMeta.has(pin.layer) ? pin.layer : currentData.layers.at(-1)?.name;
  return new THREE.Vector3(
    worldX(center.x),
    layerBaseY(layer) + layerVisualHeight(layer) + Math.max(verticalUnit() * 0.06, 0.03),
    worldZ(center.y),
  );
}

function pinRenderRecord(pin) {
  return {
    kind: 'pin',
    pin,
    source: pin,
    hierPath: pin.hierPath,
    layer: pin.layer,
    netKey: pin.netKey,
    bbox: pin.bbox,
    terminal: pin.terminal,
  };
}

function selectPin(pin, additive = false) {
  if (!pin) return;
  cancelPhysicalTrace(true);
  selectedInstancePath = pin.hierPath;
  selectedRenderRecord = pinRenderRecord(pin);
  if (pin.netKey && !physicalMode()) {
    const starting = additive ? new Set([...selectedNetKeys, pin.netKey]) : new Set([pin.netKey]);
    selectedNetKeys = traceScopedNets(currentIndex, starting);
  } else if (!additive) {
    selectedNetKeys.clear();
  }
  revealInspector();
  rebuildPinMarkers();
  updateAllColors();
  if (physicalMode()) startPhysicalTrace();
}

function rebuildPinMarkers() {
  clearGroup(pinRoot);
  const pins = visiblePinRecords();
  renderedPinMarkerCount = pins.length;
  pinRoot.visible = pinsToggle?.checked !== false;
  if (pins.length && currentBounds) {
    const outlines = [];
    const activeOutlines = [];
    const centers = [];
    for (const pin of pins) {
      const active = selectedRenderRecord?.kind === 'pin' && selectedRenderRecord.pin === pin;
      const y = pinPosition(pin).y;
      const footprints = shapeFootprints({ ...pin, purpose: 'drawing' });
      for (const footprint of footprints) {
        for (const ring of [footprint, ...(pin.holes || [])]) {
          if (!Array.isArray(ring) || ring.length < 2) continue;
          for (let i = 0; i < ring.length; i += 1) {
            const first = ring[i], second = ring[(i + 1) % ring.length];
            (active ? activeOutlines : outlines).push(worldX(first[0]), y, worldZ(first[1]), worldX(second[0]), y, worldZ(second[1]));
          }
        }
      }
      const center = pinPosition(pin);
      centers.push(center.x, center.y, center.z);
    }
    for (const [vertices, color] of [[outlines, 0x5eead4], [activeOutlines, 0xffffff]]) {
      if (!vertices.length) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color, depthTest: false, depthWrite: false }));
      lines.renderOrder = 1000;
      pinRoot.add(lines);
    }
    // These constant-screen-size dots locate pin figures; the lines above retain
    // their exact XY footprints. Neither changes the electrical pin geometry.
    const points = new THREE.BufferGeometry();
    points.setAttribute('position', new THREE.Float32BufferAttribute(centers, 3));
    const markers = new THREE.Points(points, new THREE.PointsMaterial({ color: 0xffd166, size: 5, sizeAttenuation: false, depthTest: false, depthWrite: false }));
    markers.renderOrder = 1001;
    pinRoot.add(markers);
  }
  updatePinAndConnectionLists();
  drawSelectedPinAnnotation();
  requestRender();
}

function pinScreenPoint(pin) {
  const projected = pinPosition(pin).project(camera);
  if (Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1 || projected.z < -1 || projected.z > 1) return null;
  const rect = canvas.getBoundingClientRect();
  return { x: rect.left + (projected.x + 1) * rect.width / 2, y: rect.top + (1 - projected.y) * rect.height / 2 };
}

function hitTestPin(clientX, clientY) {
  if (!currentData || pinsToggle?.checked === false) return null;
  let nearest = null, distance = 7;
  for (const pin of visiblePinRecords()) {
    const point = pinScreenPoint(pin);
    if (!point) continue;
    const delta = Math.hypot(point.x - clientX, point.y - clientY);
    if (delta <= distance) { nearest = pin; distance = delta; }
  }
  return nearest;
}

// Inspection hook returns screen coordinates only; tracing still uses raw figures.
window.__VL3D_PIN_SCREEN_POINTS = () => visiblePinRecords().map((pin) => ({ figureIndex: pin.figureIndex, terminal: pin.terminal, hierPath: pin.hierPath, ...pinScreenPoint(pin) }));

function drawSelectedPinAnnotation() {
  if (!pinAnnotation) return;
  const pin = selectedRenderRecord?.kind === 'pin' ? selectedRenderRecord.pin : null;
  pinAnnotation.hidden = !pin || pinsToggle?.checked === false;
  if (pinAnnotation.hidden) return;
  const projected = pinPosition(pin).project(camera);
  const width = viewport.clientWidth, height = viewport.clientHeight;
  const offscreen = Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1 || projected.z < -1 || projected.z > 1;
  const layerHidden = layerVisibility.get(pin.layer) === false || routingToggle?.checked === false;
  pinAnnotation.title = `${pin.terminal}\n${pin.hierPath} · ${pin.layer}`;
  pinAnnotation.innerHTML = `<strong>Selected pin · ${escapeHtml(pin.terminal)}</strong><span>${escapeHtml(pin.hierPath)} · ${escapeHtml(pin.layer)}${layerHidden ? ' · layer hidden' : ''}${offscreen ? ' · outside view; use Locate pin' : ''}</span>${pin.terminal.length > 70 ? '<small>Long name shortened here · full name in Pins</small>' : ''}`;
  pinAnnotation.style.left = `${clamp((projected.x + 1) * width / 2 + 10, 8, Math.max(8, width - Math.min(340, width - 18) - 8))}px`;
  pinAnnotation.style.top = `${clamp((1 - projected.y) * height / 2 - 35, 8, Math.max(8, height - 154))}px`;
}

function appendPagedRows(container, records, makeRow, emptyMessage, initialCount = 120) {
  container.textContent = '';
  if (!records.length) { container.textContent = emptyMessage; return; }
  let rendered = 0;
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'inspector-row';
  const appendPage = () => {
    more.remove();
    const end = Math.min(rendered ? rendered + 120 : initialCount, records.length);
    while (rendered < end) container.append(makeRow(records[rendered++]));
    if (rendered < records.length) {
      more.textContent = `Show more (${rendered}/${records.length})`;
      container.append(more);
    }
  };
  more.addEventListener('click', appendPage);
  appendPage();
}

function updatePinAndConnectionLists() {
  const pins = selectedPinRecords();
  const layerFilter = byId('pinLayerFilter');
  const selectedLayer = layerFilter?.value || '';
  const layers = [...new Set(pins.map((pin) => pin.layer))].sort();
  if (layerFilter) {
    layerFilter.innerHTML = '<option value="">All pin layers</option>' + layers.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
    layerFilter.value = layers.includes(selectedLayer) ? selectedLayer : '';
  }
  const query = (byId('pinSearch')?.value || '').trim().toLocaleLowerCase();
  const filtered = pins.filter((pin) => (!layerFilter?.value || pin.layer === layerFilter.value)
    && (!query || `${pin.terminal} ${pin.hierPath} ${pin.net} ${pin.layer}`.toLocaleLowerCase().includes(query)));
  const groups = new Map();
  for (const pin of pins) {
    const key = `${pin.hierPath}::${pin.terminal}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(pin);
  }
  if (byId('pinCountNote')) byId('pinCountNote').textContent = `${filtered.length}/${pins.length} figures · ${groups.size} ports`;
  if (pinList) {
    appendPagedRows(pinList, filtered, (pin) => {
      const button = document.createElement('button');
      button.type = 'button';
      const active = selectedRenderRecord?.kind === 'pin' && selectedRenderRecord.pin === pin;
      const figures = groups.get(`${pin.hierPath}::${pin.terminal}`) || [pin];
      const figure = figures.indexOf(pin) + 1;
      button.className = 'inspector-row pin-row';
      button.dataset.figureIndex = String(pin.figureIndex);
      button.setAttribute('aria-pressed', String(active));
      button.innerHTML = `${active ? '<span class="pin-selected-badge">◎ Selected</span>' : ''}<strong>${escapeHtml(pin.terminal)}</strong><span>${escapeHtml(pin.hierPath)}</span><span class="pin-figure">${escapeHtml(pin.layer)} · ${escapeHtml(pin.net || 'No net name')} · Figure ${figure}/${figures.length}</span>`;
      button.title = `${pin.hierPath}::${pin.terminal} · Figure ${figure}/${figures.length} · ${pin.layer}`;
      button.addEventListener('click', () => selectPin(pin, false));
      return button;
    }, pins.length ? 'No pins match these filters. Clear the search or choose All pin layers.' : selectedHierarchyPaths.size
      ? 'This module has no pin annotations. Select a child module with pins, or add pin annotations in Load.' : 'Select a module to inspect its own pins.',
    Math.max(120, Math.ceil((filtered.indexOf(selectedRenderRecord?.pin) + 1) / 120) * 120));
  }
  if (connectionList) {
    const connections = selectedInstancePath ? (currentIndex?.connectionsByOccurrence.get(selectedInstancePath) || []) : [];
    appendPagedRows(connectionList, connections, (connection) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'inspector-row';
      button.innerHTML = `<strong>${escapeHtml(connection.terminal || connection.childFormalNet)}</strong><span>${escapeHtml(connection.parentNet || 'unmapped')} · ${escapeHtml(connection.source)}</span>`;
      button.addEventListener('click', () => connection.parentNetKey && traceNet(connection.parentNetKey, false));
      return button;
    }, selectedInstancePath ? 'No external connection mapping' : 'Select an instance');
  }
}

function updateInspector() {
  if (!selectionTitle || !selectionDetails || !selectionActions) return;
  if (stackPositionNotice) {
    const unresolved = currentData?.technology?.unresolvedStackLayers || [];
    stackPositionNotice.hidden = !unresolved.length;
    stackPositionNotice.textContent = unresolved.length ? `Layer position unconfirmed (hidden by default): ${unresolved.join(', ')}. Manual layer display uses a placeholder height.` : '';
  }
  updateSelectionLegend();
  if (tracePhysicalBtn) tracePhysicalBtn.textContent = selectedRenderRecord?.kind === 'pin' ? 'Trace selected pin' : 'Trace all module pins';
  if (selectedRenderRecord?.kind === 'pin') {
    const record = selectedRenderRecord;
    const pin = record.pin || record.source;
    selectionTitle.textContent = `Pin · ${pin.terminal || pin.net || 'unnamed'}`;
    selectionTitle.title = pin.terminal || pin.net || '';
    selectionDetails.innerHTML = `
      <dl>
        <dt>Original pin name</dt><dd>${escapeHtml(pin.terminal)}</dd><dt>Path</dt><dd>${escapeHtml(pin.hierPath || 'top')}</dd>
        <dt>Layer</dt><dd>${escapeHtml(pin.layer || '')}</dd>
        <dt>Net</dt><dd>${escapeHtml(pin.net || 'No net name')}</dd>
        <dt>Source</dt><dd>${escapeHtml(pin.source || currentIndex.pinMode)}</dd>
        <dt>Trace scope</dt><dd>${physicalMode() ? escapeHtml(physicalTraceResult ? traceResultSummary(physicalTraceResult) : 'Physical geometry trace uses actual conductor contact.') : 'Named nets follow exported electrical metadata. Unnamed shapes are excluded.'}</dd>
        <dt>Physical XY size</dt><dd>${pin.bbox?.max?.[0] - pin.bbox?.min?.[0]} × ${pin.bbox?.max?.[1] - pin.bbox?.min?.[1]} ${escapeHtml(currentData.units || 'um')}</dd><dt>Coordinates</dt><dd>${escapeHtml(JSON.stringify(pin.bbox))}</dd><dt>Figure</dt><dd>${pin.figureIndex + 1} in source pin list</dd>
      </dl>`;
    selectionActions.innerHTML = `
      <button type="button" data-action="fit-record">Locate pin</button>
      <button type="button" data-action="fit-nets" ${selectedNetShapes().length ? '' : 'disabled'}>Fit routes</button>
      <button type="button" data-action="fit-instance">Fit module</button>
      <button type="button" data-action="clear-trace">Clear trace</button>
      <button type="button" data-action="clear-selection">Clear all</button>`;
    updatePinAndConnectionLists();
    pickInfo.textContent = `${pin.terminal || 'pin'} · ${pin.layer || ''} · ${pin.net || 'No net name'}`;
    return;
  }
  const instance = selectedInstancePath ? currentIndex?.instancesByPath.get(selectedInstancePath) : null;
  if (selectedInstancePath && selectedInstancePath === currentIndex?.rootPath) {
    const pins = currentIndex.pinsByPath.get(selectedInstancePath) || [];
    const connections = currentIndex.connectionsByOccurrence.get(selectedInstancePath) || [];
    selectionTitle.textContent = `${currentData.cell} · top scope`;
    selectionDetails.innerHTML = `
      <dl>
        <dt>Path</dt><dd>${escapeHtml(selectedInstancePath)}</dd>
        <dt>Layout</dt><dd>${escapeHtml(currentIndex.displayName)}</dd>
        <dt>Pins</dt><dd>${pins.length} (${escapeHtml(currentIndex.pinMode)})</dd>
        <dt>External</dt><dd>${connections.length} (${escapeHtml(currentIndex.connectivityMode)})</dd>
      </dl>`;
    selectionActions.innerHTML = `
      ${connections.length ? `<button type="button" data-action="trace-external">${physicalMode() ? 'Trace module pins' : 'Trace external'}</button>` : ''}
      <button type="button" data-action="fit-instance">Fit layout</button>
      <button type="button" data-action="clear-selection">Clear</button>`;
    updatePinAndConnectionLists();
    pickInfo.textContent = `${currentIndex.displayName} · ${pins.length} top-level pins`;
    return;
  }
  if (instance) {
    const pins = currentIndex.pinsByPath.get(selectedInstancePath) || [];
    const connections = currentIndex.connectionsByOccurrence.get(selectedInstancePath) || [];
    selectionTitle.textContent = instance.hierPath.split('/').pop() || instance.name || 'Instance';
    selectionDetails.innerHTML = `
      <dl>
        <dt>Path</dt><dd>${escapeHtml(instance.hierPath)}</dd>
        <dt>Master</dt><dd>${escapeHtml(`${instance.master?.library || ''}/${instance.master?.cell || ''}/${instance.master?.view || ''}`)}</dd>
        <dt>Depth</dt><dd>${instance.depth}</dd>
        <dt>Pins</dt><dd>${pins.length} (${escapeHtml(currentIndex.pinMode)})</dd>
        <dt>External</dt><dd>${connections.length} (${escapeHtml(currentIndex.connectivityMode)})</dd>
      </dl>`;
    selectionActions.innerHTML = `
      <button type="button" data-action="trace-external">${physicalMode() ? 'Trace module pins' : 'Trace external'}</button>
      <button type="button" data-action="fit-instance">Fit module</button>
      <button type="button" data-action="clear-selection">Clear</button>`;
    updatePinAndConnectionLists();
    pickInfo.textContent = `${instance.hierPath} · ${instance.master?.cell || 'unknown'} · ${pins.length} pins`;
    return;
  }
  if (selectedRenderRecord) {
    const record = selectedRenderRecord;
    const shape = record.shape || record.source;
    const memberCount = record.records?.length || 1;
    selectionTitle.textContent = record.kind === 'connector'
      ? `${memberCount > 1 ? 'Connector cluster' : 'Connector'} · ${record.layer}`
      : `${record.layer || 'Shape'} route`;
    selectionDetails.innerHTML = `
      <dl>
        <dt>Path</dt><dd>${memberCount > 1 ? `${memberCount} merged occurrences` : escapeHtml(record.hierPath || 'top')}</dd>
        <dt>Layer</dt><dd>${escapeHtml(record.layer || '')}</dd>
        <dt>Net</dt><dd>${escapeHtml(shape?.net || splitScopedNetKey(record.netKey).net || 'unmapped')}</dd>
        <dt>Type</dt><dd>${escapeHtml(shape?.type || record.kind)}</dd>
        <dt>BBox</dt><dd>${fmt(record.bbox?.max?.[0] - record.bbox?.min?.[0])} × ${fmt(record.bbox?.max?.[1] - record.bbox?.min?.[1])} um</dd>
      </dl>`;
    selectionActions.innerHTML = `
      <button type="button" data-action="fit-record">Fit</button>
      ${record.netKey ? '<button type="button" data-action="trace-record">Trace net</button>' : ''}
      <button type="button" data-action="clear-selection">Clear</button>`;
    pinList.textContent = 'Select an instance to inspect pins';
    connectionList.textContent = 'Select an instance to inspect external routes';
    pickInfo.textContent = memberCount > 1
      ? `${record.layer || ''} · ${memberCount} merged connectors`
      : `${record.layer || ''} ${shape?.net || 'unmapped'} @ ${record.hierPath || 'top'}`;
    return;
  }
  const traced = [...selectedNetKeys];
  if (traced.length) {
    selectionTitle.textContent = `${traced.length} scoped net${traced.length === 1 ? '' : 's'}`;
    selectionDetails.textContent = traced.slice(0, 8).map((key) => {
      const parts = splitScopedNetKey(key);
      return `${parts.path}::${parts.net}`;
    }).join('\n');
    selectionActions.innerHTML = '<button type="button" data-action="fit-nets">Fit routes</button><button type="button" data-action="clear-selection">Clear</button>';
    return;
  }
  selectionTitle.textContent = currentData ? 'Ready · select a module' : 'Open a layout to begin';
  selectionDetails.textContent = currentData ? 'Select a hierarchy instance, then choose one of its own pins. Child modules have their own pins.' : 'Use Load to open a JSON layout, local GDS/OAS file or OA library.';
  selectionActions.textContent = '';
  pinList.textContent = 'Select an instance';
  connectionList.textContent = 'Select an instance';
  pickInfo.textContent = 'No selection';
}

function updateSelectionLegend() {
  const note = byId('selectionScopeNote');
  const selected = [...selectedHierarchyPaths];
  if (note) note.textContent = selected.length
    ? `${selected.length} selected module${selected.length === 1 ? '' : 's'}; each module's own pins are listed. Search filters the list, not the selection or trace scope.`
    : 'Select an instance to inspect its own pins. Checkboxes add modules; Clear all removes selection and traces.';
  const routes = selectedNetShapes();
  const hidden = routes.filter((shape) => routingToggle?.checked === false || layerVisibility.get(shape.layer) === false).length;
  const legend = byId('selectionLegend');
  if (legend) legend.hidden = !currentData;
  if (byId('hiddenRoutesNote')) byId('hiddenRoutesNote').textContent = routes.length
    ? `${routes.length} route figures${hidden ? ` · ${hidden} hidden by layer/display controls` : ''}` : 'Dots are screen markers; pin outlines retain physical XY size';
}

function clearAllSelection() {
  cancelPhysicalTrace(true);
  selectedHierarchyPaths.clear(); selectedNetKeys.clear();
  selectedInstancePath = ''; selectedRenderRecord = null;
  highlightedMasterKey = ''; highlightedMasterPaths.clear();
  if (highlightSelect) highlightSelect.value = '';
  rebuildPinMarkers(); updateAllColors();
}

function selectedNetShapes() {
  const shapes = (currentData?.shapes || []).filter((shape) => selectedPhysicalShapeIndices.has(shape.shapeIndex));
  for (const key of selectedNetKeys) shapes.push(...(currentIndex?.shapesByNet.get(key) || []));
  return shapes;
}

function rememberView() {
  if (!currentBounds) return;
  viewHistory.push({ position: camera.position.clone(), target: controls.target.clone() });
  if (viewHistory.length > 20) viewHistory.shift();
  if (byId('backViewBtn')) byId('backViewBtn').disabled = false;
}

function restorePreviousView() {
  const previous = viewHistory.pop();
  if (!previous) return;
  camera.position.copy(previous.position);
  controls.target.copy(previous.target);
  controls.syncFromCamera();
  controls.update();
  if (byId('backViewBtn')) byId('backViewBtn').disabled = !viewHistory.length;
  requestRender();
}

function focusLayoutBBox(bbox, options = {}) {
  if (!bbox || !currentBounds) return;
  if (options.remember !== false) rememberView();
  const center = boxCenter(bbox), size = boxSize(bbox);
  const localHeight = options.pinLayer ? layerVisualHeight(options.pinLayer) : stackHeight();
  const radius = Math.max(Math.hypot(size.x, size.y, localHeight) / 2, currentBounds.radius * (options.pinLayer ? 0.018 : 0.001), 0.001);
  const targetY = options.pinLayer ? layerBaseY(options.pinLayer) + localHeight * 0.5 : stackHeight() * 0.5;
  const target = new THREE.Vector3(worldX(center.x), targetY, worldZ(center.y));
  const halfVertical = THREE.MathUtils.degToRad(camera.fov / 2);
  const halfHorizontal = Math.atan(Math.tan(halfVertical) * Math.max(camera.aspect, 0.01));
  const distance = radius / Math.sin(Math.min(halfVertical, halfHorizontal)) * 1.08;
  const direction = camera.position.clone().sub(controls.target);
  if (direction.lengthSq() < 0.000001) direction.set(1, 0.72, 1);
  direction.normalize();
  controls.target.copy(target);
  controls.distance = Math.max(distance, radius * 1.2);
  camera.position.copy(direction.multiplyScalar(controls.distance).add(target));
  controls.syncFromCamera(); controls.update(); requestRender();
}

function fitCamera(remember = false) {
  if (!currentBounds) return;
  if (remember) rememberView();
  focusLayoutBBox({ min: [currentBounds.minX, currentBounds.minY], max: [currentBounds.maxX, currentBounds.maxY] }, { remember: false });
  const distance = controls.distance * (demoMode ? 0.88 : 1.08);
  controls.distance = distance;
  controls.theta = Math.PI / 4.2;
  controls.phi = Math.PI / 3.25;
  controls.target.y = stackHeight() * 0.34;
  controls.update();
  baseCamera = { position: camera.position.clone(), target: controls.target.clone() };
  requestRender();
}

function resetCamera() {
  rememberView();
  if (!baseCamera) return fitCamera();
  camera.position.copy(baseCamera.position);
  controls.target.copy(baseCamera.target);
  controls.syncFromCamera();
  controls.update();
  requestRender();
}

function setViewPreset(preset) {
  if (!currentBounds) return;
  rememberView();
  const target = controls.target.clone();
  const distance = Math.max(controls.distance, currentBounds.radius * 0.8);
  if (preset === 'top') {
    camera.position.set(target.x, target.y + distance, target.z + 0.001);
  } else if (preset === 'side') {
    camera.position.set(target.x + distance, target.y + stackHeight() * 0.08, target.z);
  } else {
    camera.position.set(target.x + distance * 0.72, target.y + distance * 0.54, target.z + distance * 0.72);
  }
  camera.lookAt(target);
  controls.syncFromCamera();
  controls.update();
  requestRender();
}

function panAlongAxis(axis, sign, fast) {
  if (!currentBounds) return;
  const step = niceStep(currentBounds.radius / 24) * (fast ? 4 : 1);
  const delta = new THREE.Vector3(
    axis === 'x' ? sign * step : 0,
    axis === 'y' ? sign * Math.max(verticalUnit(), stackHeight() / 20) : 0,
    axis === 'z' ? sign * step : 0,
  );
  camera.position.add(delta);
  controls.target.add(delta);
  controls.update();
  requestRender();
}

function updateViaMergeLabel(rendered = null, source = null) {
  if (!viaMergeValue) return;
  const size = viaMergeSize();
  const mode = size <= 0 ? 'Exact vias' : `${fmt(size)} um LOD grid`;
  viaMergeValue.textContent = rendered != null && source != null && rendered !== source
    ? `${mode} · ${rendered}/${source}`
    : mode;
}

function updateStats() {
  if (!currentData || !currentIndex) return;
  const exportStatus = currentData.exportStatus || {};
  const incomplete = exportStatus.truncated || exportStatus.depthLimited ? ' · incomplete export' : '';
  const warnings = [
    currentData.approximateStackWarning,
    currentData.unclassifiedLayerWarning,
    payloadWarningText(currentData),
  ].filter(Boolean);
  const warningText = warnings.length ? ` · ⚠ ${warnings.join(' · ')}` : '';
  const visibleLayers = currentData.layers.filter((layer) => layerVisibility.get(layer.name) !== false).length;
  cellStats.textContent = `${currentIndex.displayName} · ${currentData.shapeCount ?? currentData.shapes.length} routes · ${currentData.instanceCount ?? currentData.instances.length} instances · ${currentIndex.pins.length} pins · ${visibleLayers}/${currentData.layers.length} layers${incomplete}${warningText}`;
  cellStats.title = warnings.join('\n');
  rulerInfo.textContent = `${fmt(currentBounds.sizeX)} × ${fmt(currentBounds.sizeY)} um · FOV ${fmt(camera.fov)}° · ${currentIndex.connectivityMode} connectivity`;
  if (technologyNotice) {
    technologyNotice.hidden = !currentData.approximateStackWarning;
    technologyNotice.textContent = currentData.approximateStackWarning || '';
  }
}

function updatePerformanceInfo(force = false) {
  if (!performanceInfo) return;
  const now = performance.now();
  if (!force && fastMode && now - lastPerformanceUiAt < 120) return;
  lastPerformanceUiAt = now;
  const mode = fastMode ? 'FAST' : 'FULL';
  performanceInfo.textContent = `${mode} · load ${Math.round(lastLoadMs)} ms · build ${Math.round(lastGeometryBuildMs)} ms · render ${fmt(lastRenderMs)} ms · ${lastRenderCalls} calls · ${lastRenderTriangles.toLocaleString()} tris${lastColorUpdateMs ? ` · color ${fmt(lastColorUpdateMs)} ms` : ''}${lastPickMs ? ` · pick ${fmt(lastPickMs)} ms` : ''}`;
}

function visibleRecordCount() {
  let total = 0;
  if (routingToggle?.checked !== false) {
    for (const batch of surfaceBatches) {
      if (layerVisibility.get(batch.layer) !== false) total += batch.records.length;
    }
    for (const batch of connectorBatches) {
      if (layerVisibility.get(batch.layer) !== false) total += batch.records.length;
    }
    for (const entry of polygonRecords) {
      if (layerVisibility.get(entry.record.layer) !== false) total += 1;
    }
  }
  if (instancesToggle?.checked === true) total += instanceBatch?.records.length || 0;
  return total;
}

function updatePublicState() {
  if (!currentData || !currentIndex) return;
  window.__VL3D_STATE = {
    library: currentData.library,
    cell: currentData.cell,
    view: currentData.view,
    source: currentSourceName,
    shapeMeshes: surfaceBatches.reduce((total, batch) => total + batch.records.length, 0) + polygonRecords.length,
    connectorMeshes: connectorBatches.reduce((total, batch) => total + batch.records.length, 0),
    totalShapes: currentData.shapeCount ?? currentData.shapes.length,
    sourceShapeCount: currentData.sourceShapeCount ?? currentData.shapeCount ?? currentData.shapes.length,
    layers: currentData.layers.length,
    pins: currentIndex.pins.length,
    globalPinMarkers: currentIndex.pins.length,
    visiblePinMarkers: pinsToggle?.checked !== false && pinRoot.visible ? renderedPinMarkerCount : 0,
    pinsVisible: pinsToggle?.checked !== false && pinRoot.visible && renderedPinMarkerCount > 0,
    connections: currentIndex.connections.length,
    connectivityMode: currentIndex.connectivityMode,
    selectedInstances: selectedHierarchyPaths.size,
    selectedNets: selectedNetKeys.size,
    physicalTraceMode: physicalMode(),
    physicalTracePending: Boolean(physicalTraceController),
    physicalTraceStatus: physicalTraceResult?.status || '',
    physicalTraceShapes: selectedPhysicalShapeIndices.size,
    physicalTraceShapeIndices: [...selectedPhysicalShapeIndices].slice(0, 500),
    camera: { position: camera.position.toArray(), target: controls.target.toArray() },
    viewport: { width: viewport?.clientWidth || 0, height: viewport?.clientHeight || 0 },
    selectedPin: selectedRenderRecord?.kind === 'pin' ? { terminal: selectedRenderRecord.pin.terminal, hierPath: selectedRenderRecord.pin.hierPath, figureIndex: selectedRenderRecord.pin.figureIndex, bbox: selectedRenderRecord.pin.bbox } : null,
    instanceOverlays: instanceBatch?.records.length || 0,
    drawCalls: lastRenderCalls,
    triangles: lastRenderTriangles,
    renderMs: lastRenderMs,
    colorMs: lastColorUpdateMs,
    palette: selectedPaletteName(),
    theme: themeSelect?.value === 'light' ? 'light' : 'dark',
    navigation: { ...navigationSettings },
    renderSerial,
    fastMode,
    fastDraftLayers: fastDraftLayerCount,
    viaMerge: viaMergeSize(),
    layerAdjusting,
    preparePending: Boolean(prepareController),
    pendingLayoutKey: pendingLoadKey,
    selectedLayoutKey: currentLayoutKey(),
    highlightedMasterKey,
    highlightedMasterInstances: highlightedMasterPaths.size,
    loadMs: lastLoadMs,
    buildMs: lastGeometryBuildMs,
    idleRender: !renderPending && !controls.autoRotate,
    visibleRecords: visibleRecordCount(),
  };
}

function drawScaleOverlay() {
  const width = viewport?.clientWidth || window.innerWidth, height = viewport?.clientHeight || window.innerHeight;
  axisContext.clearRect(0, 0, width, height);
  if (!currentBounds) return;
  const theme = currentTheme();
  const step = niceStep(Math.max(0.001, controls.distance / 7));
  const origin = controls.target.clone().project(camera);
  const end = controls.target.clone().add(new THREE.Vector3(step, 0, 0)).project(camera);
  const pixelLength = Math.abs(end.x - origin.x) * width * 0.5;
  if (!Number.isFinite(pixelLength) || pixelLength < 12 || pixelLength > width * 0.45) return;
  const startX = Math.max(12, width - pixelLength - 18);
  const endX = startX + pixelLength;
  const y = height - 60;
  axisContext.save();
  axisContext.strokeStyle = theme.text;
  axisContext.fillStyle = theme.text;
  axisContext.globalAlpha = 0.82;
  axisContext.lineWidth = 2;
  axisContext.beginPath();
  axisContext.moveTo(startX, y);
  axisContext.lineTo(endX, y);
  axisContext.moveTo(startX, y - 5);
  axisContext.lineTo(startX, y + 5);
  axisContext.moveTo(endX, y - 5);
  axisContext.lineTo(endX, y + 5);
  axisContext.stroke();
  axisContext.font = '600 11px system-ui, sans-serif';
  axisContext.textAlign = 'center';
  axisContext.fillText(`${fmt(step)} um`, (startX + endX) / 2, y - 9);
  axisContext.restore();
}

function attitudePoint(direction, radius, center) {
  const local = direction.clone().normalize().applyQuaternion(camera.quaternion.clone().invert());
  return {
    x: center.x + local.x * radius,
    y: center.y - local.y * radius,
    z: local.z,
  };
}

function drawAttitudeOverlay() {
  if (!attitudeCanvas || !attitudeContext) return;
  const rect = attitudeCanvas.getBoundingClientRect();
  const width = rect.width || 146;
  const height = rect.height || 146;
  const center = { x: width / 2, y: height / 2 };
  const radius = Math.min(width, height) * 0.35;
  const context = attitudeContext;
  context.clearRect(0, 0, width, height);
  context.save();
  context.strokeStyle = currentTheme().muted;
  context.globalAlpha = 0.45;
  context.beginPath();
  context.arc(center.x, center.y, radius, 0, Math.PI * 2);
  context.stroke();
  context.restore();
  const axes = [
    { label: 'X', color: currentTheme().axisX, point: attitudePoint(new THREE.Vector3(1, 0, 0), radius, center) },
    { label: 'Y', color: currentTheme().axisY, point: attitudePoint(new THREE.Vector3(0, 0, -1), radius, center) },
    { label: 'Z', color: currentTheme().axisZ, point: attitudePoint(new THREE.Vector3(0, 1, 0), radius, center) },
  ].sort((first, second) => second.point.z - first.point.z);
  for (const axis of axes) {
    context.save();
    context.strokeStyle = axis.color;
    context.fillStyle = axis.color;
    context.globalAlpha = axis.point.z > 0 ? 0.48 : 0.98;
    context.lineWidth = axis.point.z > 0 ? 1.4 : 2.2;
    context.beginPath();
    context.moveTo(center.x, center.y);
    context.lineTo(axis.point.x, axis.point.y);
    context.stroke();
    context.beginPath();
    context.arc(axis.point.x, axis.point.y, 3.5, 0, Math.PI * 2);
    context.fill();
    context.font = '700 12px system-ui, sans-serif';
    context.fillText(axis.label, axis.point.x + 6, axis.point.y - 5);
    context.restore();
  }
}

function showLoading(message) {
  if (loadingText) loadingText.textContent = message;
  if (cancelLoadBtn) cancelLoadBtn.hidden = !pendingLoadKey;
  if (loadingOverlay) loadingOverlay.hidden = false;
}

function hideLoading() {
  if (loadingOverlay) loadingOverlay.hidden = true;
  if (cancelLoadBtn) cancelLoadBtn.hidden = true;
}

function showError(error) {
  if (!errorDetails(error).code) error = codedError('E9001', errorDetails(error).message, error);
  console.error(error);
  hideLoading();
  cellStats.textContent = 'Load failed';
  renderErrorMessage(pickInfo, error);
  if (window.__VL3D_APP_BOOTING) recordBootFailure(error);
  window.__VL3D_APP_BOOTING = false;
}

function handleLoadError(error) {
  if (error?.name === 'AbortError') return;
  showError(error);
  if (librarySession && /E2003|E2008|E2009|E2023|E3009/.test(errorDetails(error).code)) {
    loadSourceKind.value = 'oa'; syncLoadSourceFields(); showLoadIssue(error);
  }
}

function syncLoadControls() {
  const pending = Boolean(pendingLoadKey);
  if (byId('applyLibraryBtn')) byId('applyLibraryBtn').disabled = pending || libraryRequestPending;
  if (cellSearch) cellSearch.disabled = pending || libraryRequestPending || !layoutCatalog.size;
  if (cellSelect) {
    const hasOptions = [...cellSelect.options].some((option) => Boolean(option.value));
    cellSelect.disabled = pending || libraryRequestPending || !hasOptions;
  }
  updateCellControlState();
}

function beginLayoutLoad(key = '') {
  cancelImportOperation();
  cancelPhysicalTrace(true);
  loadGeneration += 1;
  if (layerTransformFrame != null) cancelAnimationFrame(layerTransformFrame);
  if (layerTransformTimer != null) window.clearTimeout(layerTransformTimer);
  layerTransformFrame = null;
  layerTransformTimer = null;
  layerAdjusting = false;
  prepareController?.abort();
  loadController?.abort();
  prepareController = null;
  loadController = null;
  pendingLoadKey = key;
  syncLoadControls();
  requestRender();
  return loadGeneration;
}

function finishLayoutLoad(generation, key) {
  if (generation !== loadGeneration || pendingLoadKey !== key) return;
  prepareController = null;
  loadController = null;
  pendingLoadKey = '';
  syncLoadControls();
  requestRender();
}

function cancelCurrentLoad() {
  cancelImportOperation();
  if (!pendingLoadKey) return;
  loadGeneration += 1;
  prepareController?.abort();
  loadController?.abort();
  prepareController = null;
  loadController = null;
  pendingLoadKey = '';
  hideLoading();
  if (layoutCatalog.size) renderCatalogOptions(cellSearch?.value || '', cellSelect?.value);
  syncLoadControls();
  if (currentData) {
    updateStats();
    pickInfo.textContent = 'Load canceled · current layout kept';
  } else {
    cellStats.textContent = 'Load canceled';
    pickInfo.textContent = 'Select a layout cell to continue';
  }
  requestRender();
}

async function loadManifest() {
  let response;
  try {
    response = await fetch(new URL('../data/manifest.json', import.meta.url), { cache: 'no-store' });
  } catch (error) {
    throw codedError('E8006', `Layout manifest fetch failed: ${error.message}`, error);
  }
  if (!response.ok) throw codedError('E8006', `Layout manifest fetch failed (${response.status})`);
  try {
    manifest = await response.json();
  } catch (error) {
    throw codedError('E7002', `Layout manifest is not valid JSON: ${error.message}`, error);
  }
  if (!manifest || manifest.schemaVersion !== 2 || !Array.isArray(manifest.cells)) {
    throw codedError('E7002', 'Layout manifest must be a schema-v2 object with a cells array');
  }
}

function entryKey(entry) {
  return `${entry?.library || ''}/${entry?.cell || ''}/${entry?.view || 'layout'}`;
}

function mergeManifestEntry(entry) {
  if (!entry) return;
  const cells = Array.isArray(manifest?.cells) ? manifest.cells : [];
  const key = entryKey(entry);
  const index = cells.findIndex((candidate) => entryKey(candidate) === key);
  if (index >= 0) cells[index] = entry;
  else cells.push(entry);
  manifest = { ...(manifest || {}), cells };
}

function cachedCatalog() {
  return (manifest?.cells || []).map((entry) => ({
    key: entryKey(entry),
    library: entry.library,
    cell: entry.cell,
    view: entry.view || 'layout',
    cacheState: 'ready',
    sourceType: entry.source?.type || 'cache',
    entry,
  }));
}

function sessionPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidate = payload.session || payload.current || payload;
  return candidate?.sessionId && candidate?.library ? candidate : null;
}

function rememberedLibrarySessionId() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(LIBRARY_SESSION_KEY) || 'null');
    return /^[a-f0-9]{48}$/.test(String(saved?.sessionId || '')) ? saved.sessionId : '';
  } catch {
    sessionStorage.removeItem(LIBRARY_SESSION_KEY);
    return '';
  }
}

function rememberLibrarySession(session) {
  if (!session?.sessionId) return;
  try {
    sessionStorage.setItem(LIBRARY_SESSION_KEY, JSON.stringify({
      sessionId: session.sessionId,
      library: session.library?.name || '',
      path: session.library?.path || '',
    }));
  } catch {}
}

function forgetLibrarySession() {
  try {
    sessionStorage.removeItem(LIBRARY_SESSION_KEY);
  } catch {}
}

function reportLibraryRecoveryError(error) {
  libraryRecoveryError = error;
  librarySession = null;
  oaApiAvailable = false;
  layoutCatalog = new Map();
  if (libraryLabel) {
    libraryLabel.textContent = 'Reload library';
    libraryLabel.title = errorDetails(error).message;
    libraryLabel.classList.remove('is-loaded');
  }
  renderErrorMessage(pickInfo, error, ' Use Change source / Load to restore the cell list.');
}

function requestedLayoutKey() {
  const library = params.get('library') || params.get('lib') || '';
  const cell = params.get('cell') || '';
  const view = params.get('view') || 'layout';
  return library && cell ? `${library}/${cell}/${view}` : '';
}

function exactCachedRecord(key) {
  return cachedCatalog().find((record) => record.key === key) || null;
}

function restoreRememberedSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(LIBRARY_SETTINGS_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return;
    if (libraryPathInput) libraryPathInput.value = saved.path || '';
    if (libraryNameInput) libraryNameInput.value = saved.libraryName || '';
    if (cdsLibInput) cdsLibInput.value = saved.cdsLib || '';
    if (cadenceEnvInput) cadenceEnvInput.value = saved.cadenceEnv || '';
    if (viewsInput) viewsInput.value = Array.isArray(saved.views) ? saved.views.join(', ') : '';
    if (byId('pdkProfileInput')) byId('pdkProfileInput').value = saved.pdkProfile || '';
    if (byId('pdkSearchDirsInput')) byId('pdkSearchDirsInput').value = (saved.pdkProfileDirs || []).join('; ');
    if (byId('loadResourceMode')) byId('loadResourceMode').value = saved.resourceMode || '';
    if (byId('loadStrictChecks')) byId('loadStrictChecks').value = typeof saved.strictSymlinks === 'boolean' ? String(saved.strictSymlinks) : '';
    if (rememberLibrarySettings) rememberLibrarySettings.checked = true;
  } catch {
    localStorage.removeItem(LIBRARY_SETTINGS_KEY);
  }
}

function currentLibraryOverrides() {
  const overrides = {};
  const cdsLib = cdsLibInput?.value.trim() || '';
  const cadenceEnv = cadenceEnvInput?.value.trim() || '';
  const libraryName = libraryNameInput?.value.trim() || '';
  const views = (viewsInput?.value || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (cdsLib) overrides.cdsLib = cdsLib;
  if (cadenceEnv) overrides.cadenceEnv = cadenceEnv;
  if (libraryName) overrides.libraryName = libraryName;
  if (views.length) overrides.views = views;
  if (temporaryLibraryName && loadSourceKind?.value === 'oa') overrides.libraryName = temporaryLibraryName;
  const profile = byId('pdkProfileInput')?.value.trim();
  const directories = (byId('pdkSearchDirsInput')?.value || '').split(';').map((value) => value.trim()).filter(Boolean);
  if (profile) overrides.pdkProfile = profile;
  if (directories.length) overrides.pdkProfileDirs = directories;
  if (byId('loadResourceMode')?.value) overrides.resourceMode = byId('loadResourceMode').value;
  if (byId('loadStrictChecks')?.value) overrides.strictSymlinks = byId('loadStrictChecks').value === 'true';
  return overrides;
}

function rememberCurrentSettings(path, overrides) {
  try {
    if (!rememberLibrarySettings?.checked) {
      localStorage.removeItem(LIBRARY_SETTINGS_KEY);
      return;
    }
    const saved = { path, ...overrides };
    if (temporaryLibraryName) { delete saved.libraryName; if (libraryNameInput.value.trim()) saved.libraryName = libraryNameInput.value.trim(); }
    localStorage.setItem(LIBRARY_SETTINGS_KEY, JSON.stringify(saved));
  } catch {}
}

function setLibraryDialogMessage(message, isError = false, suffix = '') {
  if (!libraryDialogMessage) return;
  if (isError) renderErrorMessage(libraryDialogMessage, message, suffix);
  else libraryDialogMessage.textContent = `${message}${suffix}`;
  libraryDialogMessage.classList.toggle('is-error', isError);
}

function openLibraryDialog(message = '', isError = false, suffix = '') {
  syncLoadSourceFields();
  setLibraryDialogMessage(message || 'Choose a source. Required inputs appear here; Advanced contains optional overrides.', isError, suffix);
  if (libraryDialog && !libraryDialog.open) libraryDialog.showModal();
  window.setTimeout(() => (loadSourceKind.value === 'oa' ? libraryPathInput : loadSourceKind.value === 'stream' ? byId('streamPathInput') : byId('chooseBrowserFileBtn'))?.focus(), 0);
}

function closeLibraryDialog() {
  if (libraryDialog?.open) libraryDialog.close();
}

function describeResolvedSession(session) {
  const lines = [];
  if (session?.resolved?.cdsLib) lines.push(`cds.lib: ${session.resolved.cdsLib}`);
  if (session?.resolved?.cadenceEnv) lines.push(`Cadence environment script: ${session.resolved.cadenceEnv}`);
  if (session?.resolved?.pdkProfile) lines.push(`PDK profile (${session.resolved.pdkProfileSource || 'selected'}): ${session.resolved.pdkProfile}`);
  lines.push('Mapping completeness is checked in Layers and trace diagnostics after opening a cell.');
  updateLoadInputStatus(session);
  for (const warning of session?.warnings || []) {
    const message = typeof warning === 'string' ? warning : (warning?.message || warning?.code || JSON.stringify(warning));
    lines.push(`Warning: ${message}`);
  }
  if (resolvedSettings) {
    resolvedSettings.hidden = !lines.length;
    resolvedSettings.textContent = lines.join('\n');
  }
}

function applyLibrarySession(session) {
  libraryRecoveryError = null;
  librarySession = session;
  oaApiAvailable = Boolean(session?.sessionId);
  rememberLibrarySession(session);
  const libraryName = String(session?.library?.name || '');
  const records = (Array.isArray(session?.layouts) ? session.layouts : [])
    .filter((record) => !libraryName || record.library === libraryName)
    .map((record) => ({ ...record, key: record.key || entryKey(record) }));
  for (const record of records) mergeManifestEntry(record.entry);
  layoutCatalog = new Map(records.map((record) => [record.key, record]));
  if (libraryLabel) {
    libraryLabel.textContent = libraryName || 'No library';
    libraryLabel.title = session?.library?.path || libraryName || 'No library loaded';
    libraryLabel.classList.toggle('is-loaded', Boolean(libraryName));
  }
  if (libraryPathInput && session?.library?.path) libraryPathInput.value = session.library.path;
  // Resolved automatic values are status, not persistent manual overrides.
  describeResolvedSession(session);
  if (cellSearch) {
    cellSearch.value = '';
    cellSearch.disabled = !records.length;
  }
  renderCatalogOptions('', requestedLayoutKey());
  syncDialogCells();
  pickInfo.textContent = records.length
    ? `${records.length} layout cell${records.length === 1 ? '' : 's'} in ${libraryName}`
    : `No layout cells found in ${libraryName}`;
}

async function restoreLibrarySession() {
  let stateError = null;
  try {
    const response = await fetch(new URL('../../api/libraries/state', import.meta.url), { cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) stateError = responseError(payload, `Library service state failed (${response.status})`);
    else {
      const session = sessionPayload(payload);
      if (session) {
        applyLibrarySession(session);
        return session;
      }
    }
  } catch (error) {
    stateError = codedError('E8006', `Library service is unavailable: ${error.message}`, error);
  }

  const sessionId = rememberedLibrarySessionId();
  if (!sessionId) {
    if (stateError) reportLibraryRecoveryError(stateError);
    return null;
  }
  try {
    const response = await fetch(new URL(`../../api/library-sessions/${sessionId}`, import.meta.url), { cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const failure = responseError(payload, `Library session recovery failed (${response.status})`);
      if (!errorDetails(failure).code) failure.code = 'VL3D-E2023';
      forgetLibrarySession();
      reportLibraryRecoveryError(failure);
      return null;
    }
    const session = sessionPayload(payload);
    if (!session) throw codedError('E2023', 'Library session recovery returned invalid data');
    applyLibrarySession(session);
    return session;
  } catch (error) {
    const failure = errorDetails(error).code
      ? error
      : codedError('E8006', `Library session recovery failed: ${error.message}`, error);
    if (errorDetails(failure).code === 'VL3D-E2023') forgetLibrarySession();
    reportLibraryRecoveryError(failure);
    return null;
  }
}

async function createLibrarySession(path) {
  const selectedPath = String(path || '').trim();
  if (!selectedPath) {
    openLibraryDialog(codedError('E2015', 'Enter an absolute library path.'), true);
    return null;
  }
  const overrides = currentLibraryOverrides();
  libraryRequestPending = true;
  syncLoadControls();
  setLibraryDialogMessage(`Loading ${selectedPath}…`);
  try {
    const response = await fetch(new URL('../../api/library-sessions', import.meta.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: selectedPath, overrides }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw responseError(payload, `Library load failed (${response.status})`);
    const session = sessionPayload(payload);
    if (!session) throw codedError('E9003', 'Library service returned an invalid session');
    rememberCurrentSettings(selectedPath, overrides);
    applyLibrarySession(session);
    const needsInput = (session.warnings || []).filter((warning) => /E2003|E2009/.test(errorDetails(warning).code));
    if (needsInput.length) {
      for (const warning of needsInput) showLoadIssue(warning);
      byId('continueLoadedLibraryBtn').hidden = false;
      setLibraryDialogMessage('Cell list is ready. Complete the highlighted input for a fresh OA export, or continue to cached cells.');
    } else {
      setLibraryDialogMessage('Library ready. Choose a cell below, then Open cell.');
      byId('loadCellSelect')?.focus();
    }
    return session;
  } catch (error) {
    const reported = errorDetails(error).code
      ? error
      : codedError('E8006', `Library service request failed: ${error.message}`, error);
    showLoadIssue(reported);
    return null;
  } finally {
    libraryRequestPending = false;
    syncLoadControls();
  }
}

async function pickLibrary() {
  loadSourceKind.value = 'oa'; syncLoadSourceFields();
  setLibraryDialogMessage('Opening the Linux file chooser…');
  if (libraryDialog && !libraryDialog.open) libraryDialog.showModal();
  libraryRequestPending = true;
  syncLoadControls();
  try {
    const response = await fetch(new URL('../../api/libraries/pick', import.meta.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw responseError(payload, `Native picker unavailable (${response.status})`);
    if (payload.canceled || !payload.path) {
      openLibraryDialog('No directory selected. Enter a library path manually.');
      return;
    }
    if (libraryPathInput) libraryPathInput.value = payload.path;
  } catch (error) {
    const reported = errorDetails(error).code
      ? error
      : codedError('E2019', `Native picker request failed: ${error.message}`, error);
    openLibraryDialog(reported, true, '. Enter a library path manually.');
    return;
  } finally {
    libraryRequestPending = false;
    syncLoadControls();
  }
  await createLibrarySession(libraryPathInput?.value || '');
}

function localSourceIsJson() {
  return /\.json(?:\.gz)?$/i.test(byId('streamPathInput')?.value.trim() || '');
}

function syncStreamMappingFields() {
  const json = loadSourceKind?.value === 'stream' && localSourceIsJson();
  byId('layerMapRequirement').hidden = json;
  byId('pdkRequirement').hidden = loadSourceKind?.value === 'browser' || json;
  byId('jsonRulesNote').hidden = !json;
}

function syncLoadSourceFields() {
  const mode = loadSourceKind?.value || 'browser';
  byId('browserLoadFields').hidden = mode !== 'browser';
  byId('oaLoadFields').hidden = mode !== 'oa';
  byId('streamLoadFields').hidden = mode !== 'stream';
  byId('pdkRequirement').hidden = mode === 'browser';
  byId('advancedSettings').hidden = mode === 'browser';
  byId('applyLibraryBtn').textContent = mode === 'browser' ? 'Choose JSON file' : mode === 'oa' ? 'Load library' : 'Import and open';
  byId('continueLoadedLibraryBtn').hidden = true;
  byId('loadCandidates').hidden = true;
  resolvedSettings.hidden = mode !== 'oa' || !librarySession;
  updateLoadInputStatus(mode === 'oa' ? librarySession : null);
  syncDialogCells();
  syncStreamMappingFields();
}

function syncDialogCells() {
  const available = loadSourceKind.value === 'oa' && Boolean(librarySession?.sessionId);
  byId('loadCellFields').hidden = !available;
  if (!available) return;
  const select = byId('loadCellSelect');
  select.replaceChildren(...[...cellSelect.options].map((option) => option.cloneNode(true)));
  select.value = cellSelect.value;
  byId('loadChosenCellBtn').disabled = !select.value;
}

function updateLoadInputStatus(session = null) {
  const status = (id, input, resolved, fallback = 'Automatic') => {
    const value = byId(input)?.value.trim();
    const element = byId(id);
    if (element) { element.textContent = value ? 'Selected' : resolved ? 'Automatic · found' : fallback; element.title = value || resolved || ''; }
  };
  status('cdsInputStatus', 'cdsLibInput', session?.resolved?.cdsLib);
  status('cadenceInputStatus', 'cadenceEnvInput', session?.resolved?.cadenceEnv);
  status('pdkInputStatus', 'pdkProfileInput', session?.resolved?.pdkProfile, 'From layout / automatic mapping; inspect Layers');
  status('layerMapInputStatus', 'streamLayerMapInput', '', 'Automatic mapping; inspect Layers');
}

function showLoadIssue(error) {
  openLibraryDialog(error, true);
  const code = errorDetails(error).code;
  const fields = /E2003/.test(code) ? ['cdsRequirement', 'cdsLibInput', 'cdsInputStatus']
    : /E2009/.test(code) ? ['cadenceRequirement', 'cadenceEnvInput', 'cadenceInputStatus']
      : /E6006/.test(code) ? ['layerMapRequirement', 'streamLayerMapInput', 'layerMapInputStatus']
        : /E6009/.test(code) ? ['pinAnnotationsSettings', 'pinAnnotationsInput'] : null;
  if (/E6006/.test(code) && loadSourceKind.value === 'stream' && localSourceIsJson()) {
    byId('jsonRulesNote').hidden = false;
    setLibraryDialogMessage(error, true, ' JSON keeps its embedded layer rules. Re-import the original GDS/OAS with verified mapping, or correct and refresh the OA export.');
  } else if (fields) {
    byId(fields[0]).open = true;
    if (fields[2]) byId(fields[2]).textContent = 'Needs input';
    window.setTimeout(() => byId(fields[1])?.focus(), 0);
  }
  const candidates = error.details?.candidates || error.details?.topCells || error.details?.tops || [];
  if (Array.isArray(candidates) && candidates.length && /E2008|E6002/.test(code)) {
    loadCandidateKind = /E6002/.test(code) ? 'top' : typeof candidates[0] === 'string' ? 'cadence' : 'library';
    byId('loadCandidates').hidden = false;
    byId('loadCandidateLabel').textContent = loadCandidateKind === 'library' ? 'Choose the OA library' : loadCandidateKind === 'cadence' ? 'Choose the Cadence environment script' : 'Choose the top cell';
    byId('loadCandidateSelect').replaceChildren(...candidates.map((item) => {
      const option = document.createElement('option');
      option.value = typeof item === 'string' ? item : item.name || item.cell;
      option.textContent = typeof item === 'string' ? item : `${item.name || item.cell} · ${item.path || ''}`;
      return option;
    }));
    byId('loadCandidates').scrollIntoView({ block: 'nearest' });
  }
}

function cancelImportOperation() {
  if (!pendingImportOperation) return;
  const id = pendingImportOperation;
  pendingImportOperation = '';
  fetch(new URL(`../../api/operations/${encodeURIComponent(id)}`, import.meta.url), { method: 'DELETE' }).catch(() => {});
}

async function loadServerFile() {
  const path = byId('streamPathInput').value.trim();
  if (!path.startsWith('/')) { showLoadIssue(codedError('E6001', 'Enter an absolute file path on the machine running VL3D.')); return false; }
  const overrides = currentLibraryOverrides();
  const payload = { path };
  for (const [field, input] of [['top', 'streamTopInput'], ['layerMapPath', 'streamLayerMapInput'], ['pinAnnotationsPath', 'pinAnnotationsInput']]) {
    const value = byId(input).value.trim(); if (value && !(field === 'layerMapPath' && localSourceIsJson())) payload[field] = value;
  }
  if (overrides.pdkProfile && !localSourceIsJson()) payload.pdkProfilePath = overrides.pdkProfile;
  if (overrides.pdkProfileDirs && !localSourceIsJson()) payload.pdkProfileDirs = overrides.pdkProfileDirs;
  if (overrides.resourceMode) payload.resourceMode = overrides.resourceMode;
  if (overrides.libraryName) payload.library = overrides.libraryName;
  const key = `stream/${path}`;
  const generation = beginLayoutLoad(key);
  const startedAt = performance.now();
  closeLibraryDialog();
  showLoading('Importing local layout file…');
  try {
    // Retain the POST until its operation ID arrives so Cancel can stop the child.
    const response = await fetch(new URL('../../api/streams/import', import.meta.url), {
      method: 'POST', headers: { 'content-type': 'application/json', prefer: 'respond-async' }, body: JSON.stringify(payload),
    });
    let state = await response.json().catch(() => ({}));
    if (!response.ok) throw responseError(state, `Layout import failed (${response.status})`);
    const operationId = state.operationId || '';
    if (generation !== loadGeneration) {
      if (operationId) fetch(new URL(`../../api/operations/${encodeURIComponent(operationId)}`, import.meta.url), { method: 'DELETE' }).catch(() => {});
      return false;
    }
    pendingImportOperation = operationId;
    const deadline = Date.now() + 600000;
    while (operationId && !['succeeded', 'failed', 'cancelled'].includes(state.state)) {
      if (generation !== loadGeneration) return false;
      if (Date.now() > deadline) { cancelImportOperation(); throw codedError('E6005', 'Layout import timed out and was canceled. Check the source or choose a smaller top cell.'); }
      const poll = await fetch(new URL(`../../api/operations/${encodeURIComponent(operationId)}`, import.meta.url), { cache: 'no-store' });
      state = await poll.json().catch(() => ({}));
      if (generation !== loadGeneration) return false;
      if (!poll.ok) throw responseError(state, 'Layout import status is unavailable');
      if (state.progress) showLoading(state.progress.message || state.progress.phase || 'Importing layout…');
      if (!['succeeded', 'failed', 'cancelled'].includes(state.state)) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (pendingImportOperation === operationId) pendingImportOperation = '';
    if (state.state === 'failed') throw responseError(state, 'Layout import failed');
    if (state.state === 'cancelled') return false;
    const result = state.result || state;
    if (!result.entry?.path) throw codedError('E9003', 'Layout importer returned no layout entry');
    const controller = new AbortController(); loadController = controller;
    const data = await fetchLayout(result.entry, controller.signal);
    if (generation !== loadGeneration) return false;
    mergeManifestEntry(result.entry);
    return await activateLayout(data, path, generation, startedAt);
  } catch (error) {
    if (generation !== loadGeneration || error?.name === 'AbortError') return false;
    cancelImportOperation(); showLoadIssue(errorDetails(error).code ? error : codedError('E8006', `Layout service request failed: ${error.message}`, error)); return false;
  } finally { if (generation === loadGeneration) hideLoading(); finishLayoutLoad(generation, key); }
}

async function loadPublicExample() {
  closeLibraryDialog();
  const key = 'example/physical-trace';
  const generation = beginLayoutLoad(key);
  const startedAt = performance.now();
  const controller = new AbortController(); loadController = controller;
  showLoading('Opening public example…');
  try {
    const response = await fetch(new URL('../../api/examples/physical-trace', import.meta.url), { signal: controller.signal });
    if (!response.ok) throw responseError(await response.json().catch(() => ({})), 'The public example is unavailable');
    const raw = await response.json();
    if (generation !== loadGeneration || controller.signal.aborted) return false;
    return await activateLayout(raw, 'physical-trace-demo.json', generation, startedAt);
  } catch (error) {
    if (generation !== loadGeneration || error?.name === 'AbortError') return false;
    showLoadIssue(errorDetails(error).code ? error : codedError('E8006', `Example request failed: ${error.message}`, error)); return false;
  } finally { if (generation === loadGeneration) hideLoading(); finishLayoutLoad(generation, key); }
}

async function submitLoadSource() {
  if (loadSourceKind.value === 'browser') { fileInput?.click(); return; }
  if (loadSourceKind.value === 'stream') return loadServerFile();
  return createLibrarySession(libraryPathInput?.value || '');
}

function renderCatalogOptions(filter = '', preferredKey = cellSelect?.value) {
  if (!cellSelect) return;
  const query = filter.trim().toLocaleLowerCase();
  const records = [...layoutCatalog.values()]
    .filter((record) => !query || `${record.key} ${record.library} ${record.cell} ${record.view}`.toLocaleLowerCase().includes(query))
    .sort((first, second) => {
      const firstReady = first.cacheState === 'ready' ? 0 : 1;
      const secondReady = second.cacheState === 'ready' ? 0 : 1;
      return Number(Boolean(first.isBackup)) - Number(Boolean(second.isBackup))
        || firstReady - secondReady || first.key.localeCompare(second.key, undefined, { numeric: true });
    });
  cellSelect.textContent = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = records.length
    ? 'Select a cell'
    : (layoutCatalog.size ? 'No matching cell' : 'Load a library first');
  cellSelect.append(placeholder);
  for (const record of records) {
    const option = document.createElement('option');
    const count = record.entry?.shapeCount;
    const state = record.cacheState === 'ready' ? 'ready' : (record.cacheState === 'stale' ? 'refresh' : 'load');
    option.value = record.key;
    option.textContent = `${record.cell}${record.view && record.view !== 'layout' ? `/${record.view}` : ''}${record.isBackup ? ' · Backup' : ''} · ${state}${Number.isFinite(count) ? ` · ${count}` : ''}`;
    option.dataset.cell = record.cell;
    cellSelect.append(option);
  }
  cellSelect.disabled = Boolean(pendingLoadKey || prepareController || libraryRequestPending || !records.length);
  if (preferredKey && records.some((record) => record.key === preferredKey)) cellSelect.value = preferredKey;
  else cellSelect.value = '';
  updateCellControlState();
}

function exactTypedRecord() {
  const query = cellSearch?.value.trim().toLocaleLowerCase() || '';
  if (!query) return layoutCatalog.get(cellSelect?.value) || null;
  const libraryName = String(librarySession?.library?.name || '').toLocaleLowerCase();
  return [...layoutCatalog.values()].find((record) => {
    const candidates = [record.cell, `${record.cell}/${record.view}`, record.key];
    if (libraryName) candidates.push(`${libraryName}/${record.cell}`);
    return candidates.some((candidate) => String(candidate || '').toLocaleLowerCase() === query);
  }) || null;
}

function selectTypedRecord() {
  const record = exactTypedRecord();
  if (record && cellSelect) cellSelect.value = record.key;
  updateCellControlState();
  return record;
}

function updateCellControlState() {
  const record = exactTypedRecord();
  const busy = Boolean(pendingLoadKey || libraryRequestPending);
  if (openCellBtn) openCellBtn.disabled = busy || !record;
  for (const element of [cellSearch, cellSelect?.closest('.source-control'), openCellBtn, refreshCellBtn]) {
    if (element) element.hidden = !layoutCatalog.size;
  }
  if (loadLibraryBtn) loadLibraryBtn.disabled = busy;
  if (advancedSettingsBtn) advancedSettingsBtn.disabled = busy;
  if (!refreshCellBtn) return;
  refreshCellBtn.disabled = busy || !record || record.sourceType !== 'oa' || !oaApiAvailable;
  const needsLoad = record?.cacheState === 'missing';
  refreshCellBtn.textContent = needsLoad ? 'Load' : 'Refresh';
  refreshCellBtn.title = !oaApiAvailable
    ? 'OA loading is unavailable; cached layouts remain usable'
    : needsLoad
      ? 'Export and open this OA layout'
      : 'Regenerate the selected OA layout cache';
}

function selectedManifestEntry() {
  const value = cellSelect.value;
  return manifest?.cells?.find((entry) => entryKey(entry) === value) || null;
}

async function fetchLayout(entry, signal) {
  let response;
  try {
    response = await fetch(new URL(`../${entry.path}`, import.meta.url), { cache: 'default', signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw codedError('E8006', `Layout fetch failed for ${entry.path}: ${error.message}`, error);
  }
  if (!response.ok) throw codedError('E8006', `Layout fetch failed for ${entry.path} (${response.status})`);
  try {
    return await response.json();
  } catch (error) {
    throw codedError('E8006', `Layout JSON decode failed for ${entry.path}: ${error.message}`, error);
  }
}

async function prepareSelectedLayout(record, refresh, generation, signal) {
  if (!record) throw codedError('E2015', 'Select a layout cell');
  if (record.entry && record.cacheState === 'ready' && !refresh) return record.entry;
  if (record.sourceType !== 'oa') {
    if (record.entry) return record.entry;
    throw codedError('E7002', `${record.key} has no usable cache`);
  }
  if (!oaApiAvailable) throw codedError('E3001', 'OA one-click loading is unavailable in this server mode');
  showLoading(`${refresh ? 'Refreshing' : 'Exporting'} ${record.key}`);
  let response;
  try {
    response = await fetch(new URL('../../api/layouts/prepare', import.meta.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: librarySession?.sessionId || '',
        library: record.library,
        cell: record.cell,
        view: record.view,
        refresh,
      }),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw codedError('E8006', `OA preparation request failed: ${error.message}`, error);
  }
  const payload = await response.json().catch(() => ({}));
  if (generation !== loadGeneration || pendingLoadKey !== record.key || signal.aborted) return null;
  if (!response.ok) throw responseError(payload, `OA preparation failed (${response.status})`);
  if (entryKey(payload.entry) !== record.key) throw codedError('E9003', 'OA preparation returned a different layout identity');
  record.entry = payload.entry;
  record.cacheState = 'ready';
  mergeManifestEntry(payload.entry);
  renderCatalogOptions(cellSearch?.value || '', record.key);
  return payload.entry;
}

async function loadSelectedCell(refresh = false) {
  selectTypedRecord();
  const key = cellSelect?.value || '';
  const record = layoutCatalog.get(key);
  if (!record) throw codedError('E2015', 'Select a layout cell');
  const generation = beginLayoutLoad(key);
  const startedAt = performance.now();
  try {
    const prepareRequest = new AbortController();
    prepareController = prepareRequest;
    const entry = await prepareSelectedLayout(record, refresh, generation, prepareRequest.signal);
    if (prepareController === prepareRequest) prepareController = null;
    if (generation !== loadGeneration || pendingLoadKey !== key || !entry) return false;
    const controller = new AbortController();
    loadController = controller;
    showLoading(`Loading ${entry.library || ''}/${entry.cell}/${entry.view || ''}`);
    const data = await fetchLayout(entry, controller.signal);
    if (loadController === controller) loadController = null;
    if (generation !== loadGeneration || pendingLoadKey !== key) return false;
    const activated = await activateLayout(data, entry.path, generation, startedAt);
    if (!activated || generation !== loadGeneration || pendingLoadKey !== key) return false;
    const url = new URL(window.location.href);
    url.searchParams.set('library', data.library || entry.library || '');
    url.searchParams.set('cell', data.cell);
    url.searchParams.set('view', data.view || entry.view || 'layout');
    window.history.replaceState(null, '', url);
    return true;
  } catch (error) {
    if (generation !== loadGeneration || pendingLoadKey !== key || error?.name === 'AbortError') return false;
    if (errorDetails(error).code) throw error;
    throw codedError('E9001', `Layout activation failed: ${error.message}`, error);
  } finally {
    finishLayoutLoad(generation, key);
  }
}

async function decodeLocalFile(file) {
  const buffer = await file.arrayBuffer();
  let bytes = new Uint8Array(buffer);
  if (/\.gz$/i.test(file.name)) {
    if (typeof DecompressionStream !== 'function') throw codedError('E8006', 'This browser cannot open gzip files directly');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const text = new TextDecoder().decode(bytes);
  if (!/^\s*[\[{]/.test(text)) throw codedError('E8006', 'Expected VL3D JSON or JSON.GZ');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw codedError('E8006', `Selected file is not valid JSON: ${error.message}`, error);
  }
}

async function loadLocalFile(file) {
  if (!file) return false;
  const key = `local/${file.name}`;
  const generation = beginLayoutLoad(key);
  const startedAt = performance.now();
  showLoading(`Opening ${file.name}`);
  try {
    let data;
    try {
      data = await decodeLocalFile(file);
    } catch (error) {
      if (errorDetails(error).code) throw error;
      throw codedError('E8006', `Selected file could not be decoded: ${error.message}`, error);
    }
    if (generation !== loadGeneration || pendingLoadKey !== key) return false;
    return await activateLayout(data, file.name, generation, startedAt);
  } catch (error) {
    if (generation !== loadGeneration || pendingLoadKey !== key || error?.name === 'AbortError') return false;
    throw error;
  } finally {
    finishLayoutLoad(generation, key);
  }
}

async function activateLayout(rawData, sourceName, generation, startedAt) {
  if (Object.hasOwn(rawData || {}, 'units') && (typeof rawData.units !== 'string' || !['um', 'µm', 'μm'].includes(rawData.units.trim().toLowerCase()))) {
    throw codedError('E4003', "Viewer geometry requires micrometre units (um, µm or μm). Convert all XY coordinates, widths, extensions, bounding boxes and pin/instance geometry consistently; changing only the units label is insufficient. The current layout is kept.");
  }
  cancelPhysicalTrace(true);
  if (generation !== loadGeneration) return false;
  // The display index decorates shape/instance records in place. Keep the input
  // records and electrical layer evidence intact; polygon coordinates stay read-only.
  const normalized = completeRoutingStack({
    ...rawData,
    shapes: Array.isArray(rawData.shapes) ? rawData.shapes.map((shape) => ({ ...shape })) : rawData.shapes,
    instances: Array.isArray(rawData.instances) ? rawData.instances.map((instance) => ({ ...instance })) : rawData.instances,
  });
  if (!normalized.cell || !Array.isArray(normalized.shapes) || !Array.isArray(normalized.instances)) {
    throw codedError('E9003', 'Unsupported layout JSON: expected cell, shapes, and instances');
  }
  const bounds = computeBounds(normalized);
  const index = buildLayoutIndex(normalized);
  showLoading(`Building GPU batches for ${normalized.cell}`);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  if (generation !== loadGeneration) return false;
  currentData = normalized;
  currentElectricalData = rawData;
  viewHistory.length = 0;
  if (byId('backViewBtn')) byId('backViewBtn').disabled = true;
  if (byId('sceneGuide')) byId('sceneGuide').hidden = true;
  if (byId('pinSearch')) byId('pinSearch').value = '';
  currentSourceName = sourceName;
  libraryLabel.textContent = `${rawData.cell} · ${rawData.library || 'layout file'}`;
  libraryLabel.title = sourceName;
  libraryLabel.classList.add('is-loaded');
  loadLibraryBtn.textContent = 'Change source';
  currentBounds = bounds;
  layerVisibility = new Map(currentData.layers.map((layer) => [
    normalizedLayerName(layer.name),
    defaultLayerVisibility(layer),
  ]));
  rebuildLayerMeta();
  currentIndex = index;
  selectedHierarchyPaths = new Set();
  selectedNetKeys = new Set();
  selectedInstancePath = '';
  selectedRenderRecord = null;
  highlightedMasterKey = '';
  highlightedMasterPaths = new Set();
  if (hierarchyDepthInput) {
    hierarchyDepthInput.max = String(currentIndex.maxDepth);
    hierarchyDepthInput.value = String(Math.min(currentIndex.maxDepth, 3));
  }
  const buildStartedAt = performance.now();
  clearLayoutScene();
  buildRoutingGeometry();
  applyAutomaticViaLod();
  buildConnectorGeometry();
  buildInstanceGeometry();
  rebuildPinMarkers();
  forceFullColorRefresh = false;
  lastXrayColorMode = false;
  styledColorRecords.clear();
  rebuildGridAndAxes();
  lastGeometryBuildMs = performance.now() - buildStartedAt;
  lastLoadMs = performance.now() - startedAt;
  updateLayerPanel();
  updateHighlightOptions();
  updateHierarchyPanel();
  updateNetPanel();
  updateMaterialState();
  updateStats();
  updateInspector();
  fitCamera();
  hideLoading();
  window.__VL3D_APP_BOOTING = false;
  setPhysicalTraceStatus(physicalMode() ? 'Select a pin to trace connected geometry.' : 'Named nets follow exported electrical metadata.');
  requestRender();
  return true;
}

function bindEvents() {
  let hoverFrame = null;
  let hoverPoint = null;
  canvas.addEventListener('pointermove', (event) => {
    hoverPoint = [event.clientX, event.clientY];
    if (hoverFrame !== null) return;
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = null;
      const pin = !controls.isInteracting() && hitTestPin(...hoverPoint);
      canvas.title = pin ? `${pin.terminal}\n${pin.hierPath} · ${pin.layer} · source figure ${pin.figureIndex + 1}\nClick to select this pin; drag to orbit.` : '';
      canvas.style.cursor = pin ? 'pointer' : '';
    });
  });
  canvas.addEventListener('pointerleave', () => { canvas.title = ''; canvas.style.cursor = ''; });
  traceMode?.addEventListener('change', () => {
    cancelPhysicalTrace(true);
    if (traceScope) traceScope.disabled = !physicalMode();
    if (currentData) buildConnectorGeometry();
    selectedNetKeys.clear();
    if (selectedRenderRecord?.kind === 'pin') selectPin(selectedRenderRecord.pin, false);
    else updateAllColors();
  });
  traceScope?.addEventListener('change', () => { cancelPhysicalTrace(true); if (physicalMode()) startPhysicalTrace(); });
  tracePhysicalBtn?.addEventListener('click', startPhysicalTrace);
  cancelPhysicalTraceBtn?.addEventListener('click', () => { cancelPhysicalTrace(false); updateAllColors(); });
  window.addEventListener('beforeunload', () => cancelPhysicalTrace(true));

  for (const drawer of [workspaceDrawer, inspectorDrawer]) {
    if (!drawer) continue;
    syncDrawerState(drawer);
    drawer.addEventListener('toggle', () => syncDrawerState(drawer));
  }
  window.addEventListener('resize', () => {
    if (resizePending) return;
    resizePending = true;
    requestAnimationFrame(() => {
      resizePending = false;
      syncDrawerState(workspaceDrawer);
      syncDrawerState(inspectorDrawer);
      resizeRenderer();
    });
  });
  cellSelect?.addEventListener('change', () => {
    if (cellSearch) cellSearch.value = '';
    renderCatalogOptions('', cellSelect.value);
    updateCellControlState();
  });
  cellSearch?.addEventListener('input', () => {
    renderCatalogOptions(cellSearch.value, pendingLoadKey ? currentLayoutKey() : cellSelect?.value);
    selectTypedRecord();
  });
  cellSearch?.addEventListener('keydown', (event) => {
    if (pendingLoadKey) {
      if (event.key === 'Enter' || event.key === 'Escape') event.preventDefault();
      return;
    }
    if (event.key === 'Escape' && cellSearch.value) {
      cellSearch.value = '';
      renderCatalogOptions('', cellSelect?.value);
      event.preventDefault();
    } else if (event.key === 'Enter') {
      if (selectTypedRecord()) loadSelectedCell(false).catch(handleLoadError);
      else pickInfo.textContent = 'No exact cell match in the loaded library';
      event.preventDefault();
    }
  });
  loadLibraryBtn?.addEventListener('click', () => openLibraryDialog());
  byId('browseLibraryBtn')?.addEventListener('click', () => pickLibrary().catch(handleLoadError));
  advancedSettingsBtn?.addEventListener('click', () => { if (loadSourceKind.value === 'browser') loadSourceKind.value = librarySession ? 'oa' : 'stream'; openLibraryDialog(); byId('advancedSettings').open = true; });
  openCellBtn?.addEventListener('click', () => {
    if (selectTypedRecord()) loadSelectedCell(false).catch(handleLoadError);
  });
  libraryForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    submitLoadSource().catch(handleLoadError);
  });
  loadSourceKind?.addEventListener('change', syncLoadSourceFields);
  byId('chooseBrowserFileBtn')?.addEventListener('click', () => fileInput?.click());
  byId('openExampleBtn')?.addEventListener('click', loadPublicExample);
  byId('loadExampleBtn')?.addEventListener('click', loadPublicExample);
  byId('continueLoadedLibraryBtn')?.addEventListener('click', () => { syncDialogCells(); byId('loadCellFields').scrollIntoView({ block: 'nearest' }); byId('loadCellSelect').focus(); });
  byId('loadCellSelect')?.addEventListener('change', () => { cellSelect.value = byId('loadCellSelect').value; byId('loadChosenCellBtn').disabled = !cellSelect.value; updateCellControlState(); });
  byId('loadChosenCellBtn')?.addEventListener('click', () => { cellSelect.value = byId('loadCellSelect').value; if (cellSearch) cellSearch.value = ''; closeLibraryDialog(); loadSelectedCell(false).catch(handleLoadError); });
  byId('applyLoadCandidateBtn')?.addEventListener('click', () => {
    const selected = byId('loadCandidateSelect').value;
    if (loadCandidateKind === 'library') temporaryLibraryName = selected;
    else if (loadCandidateKind === 'cadence') cadenceEnvInput.value = selected;
    else byId('streamTopInput').value = selected;
    submitLoadSource().catch(handleLoadError);
  });
  libraryPathInput?.addEventListener('input', () => { temporaryLibraryName = ''; updateLoadInputStatus(); resolvedSettings.hidden = true; byId('loadCellFields').hidden = true; });
  byId('streamPathInput')?.addEventListener('input', syncStreamMappingFields);
  for (const id of ['cdsLibInput', 'cadenceEnvInput', 'pdkProfileInput', 'streamLayerMapInput']) byId(id)?.addEventListener('input', () => updateLoadInputStatus());
  closeLibraryDialogBtn?.addEventListener('click', closeLibraryDialog);
  cancelLibraryBtn?.addEventListener('click', closeLibraryDialog);
  libraryDialog?.addEventListener('click', (event) => {
    if (event.target === libraryDialog) closeLibraryDialog();
  });
  refreshCellBtn?.addEventListener('click', () => loadSelectedCell(true).catch(handleLoadError));
  cancelLoadBtn?.addEventListener('click', cancelCurrentLoad);
  highlightSelect?.addEventListener('change', () => {
    highlightedMasterKey = highlightSelect.value;
    refreshHighlightedMasterPaths();
    updateAllColors();
  });
  fitBtn?.addEventListener('click', () => fitCamera(true));
  byId('backViewBtn')?.addEventListener('click', restorePreviousView);
  byId('pinSearch')?.addEventListener('input', updatePinAndConnectionLists);
  byId('pinLayerFilter')?.addEventListener('change', updatePinAndConnectionLists);
  byId('layerFilter')?.addEventListener('change', updateLayerPanel);
  byId('explorerTab')?.addEventListener('click', () => toggleWorkspacePanel('explorer'));
  byId('pinsTab')?.addEventListener('click', () => toggleWorkspacePanel('inspector'));
  byId('physicalZBtn')?.addEventListener('click', () => { if (zScale) { zScale.value = '0.1'; zScale.dispatchEvent(new Event('input')); zScale.dispatchEvent(new Event('change')); } });
  resetBtn?.addEventListener('click', resetCamera);
  viewIsoBtn?.addEventListener('click', () => setViewPreset('iso'));
  viewTopBtn?.addEventListener('click', () => setViewPreset('top'));
  viewSideBtn?.addEventListener('click', () => setViewPreset('side'));
  legendAllBtn?.addEventListener('click', () => setAllLayersVisible(true));
  legendNoneBtn?.addEventListener('click', () => setAllLayersVisible(false));
  instancesToggle?.addEventListener('change', () => {
    instanceRoot.visible = instancesToggle.checked;
    requestRender();
  });
  routingToggle?.addEventListener('change', () => {
    routingRoot.visible = routingToggle.checked;
    connectorRoot.visible = routingToggle.checked;
    updateWireframeVisibility();
    updateSelectionLegend();
    if (byId('layerFilter')?.value === 'shown') updateLayerPanel();
    requestRender();
  });
  pinsToggle?.addEventListener('change', () => {
    pinRoot.visible = pinsToggle.checked;
    requestRender();
  });
  wireframeToggle?.addEventListener('change', updateWireframeVisibility);
  xrayToggle?.addEventListener('change', () => {
    updateMaterialState();
    updateAllColors();
  });
  themeSelect?.addEventListener('change', () => {
    forceFullColorRefresh = true;
    applyTheme();
    rebuildGridAndAxes();
    updateAllColors();
  });
  paletteSelect?.addEventListener('change', applyPaletteSelection);
  zScale?.addEventListener('input', () => {
    updateZScaleLabel();
    scheduleLayerTransformPreview();
  });
  zScale?.addEventListener('change', commitLayerTransforms);
  alphaScale?.addEventListener('input', updateMaterialState);
  viaMerge?.addEventListener('input', () => {
    if (currentData) viaMergeOverrides.set(currentLayoutKey(), viaMergeSize());
    updateViaMergeLabel();
  });
  viaMerge?.addEventListener('change', () => {
    buildConnectorGeometry();
    updateWireframeVisibility();
    updateAllColors();
    requestRender();
  });
  fovScale?.addEventListener('input', () => {
    camera.fov = Number(fovScale.value || 50);
    camera.updateProjectionMatrix();
    if (fovValue) fovValue.textContent = `${camera.fov}°`;
    updateStats();
    requestRender();
  });
  qualitySelect?.addEventListener('change', resizeRenderer);
  navigationModeSelect?.addEventListener('change', () => applyNavigationPreset(navigationModeSelect.value));
  for (const toggle of [invertOrbitXToggle, invertOrbitYToggle, invertPanToggle, invertWheelToggle]) {
    toggle?.addEventListener('change', applyNavigationOverrides);
  }
  hierarchySearch?.addEventListener('input', () => { hierarchyRowLimit = 260; updateHierarchyPanel(); });
  hierarchyDepthInput?.addEventListener('input', () => { hierarchyRowLimit = 260; updateHierarchyPanel(); });
  hierarchyAllBtn?.addEventListener('click', () => {
    cancelPhysicalTrace(true);
    for (const instance of lastHierarchyRows) selectedHierarchyPaths.add(instance.hierPath);
    if (!selectedHierarchyPaths.has(selectedInstancePath)) selectedInstancePath = lastHierarchyRows[0]?.hierPath || '';
    selectedRenderRecord = null;
    rebuildPinMarkers();
    updateAllColors();
  });
  hierarchyNoneBtn?.addEventListener('click', clearHierarchySelection);
  clearHierarchyBtn?.addEventListener('click', clearAllSelection);
  netSearch?.addEventListener('input', updateNetPanel);
  clearNetBtn?.addEventListener('click', clearNetSelection);
  selectionActions?.addEventListener('click', (event) => {
    const action = event.target.closest('button')?.dataset.action;
    if (action === 'trace-external') traceExternalConnections();
    else if (action === 'clear-trace') clearNetSelection();
    else if (action === 'fit-instance') {
      const bbox = currentIndex.instancesByPath.get(selectedInstancePath)?.bbox
        || (selectedInstancePath === currentIndex.rootPath ? currentData.bbox : null);
      focusLayoutBBox(bbox);
    }
    else if (action === 'fit-record') focusLayoutBBox(selectedRenderRecord?.bbox, { pinLayer: selectedRenderRecord?.kind === 'pin' ? selectedRenderRecord.layer : null });
    else if (action === 'trace-record' && physicalMode()) startPhysicalTrace();
    else if (action === 'trace-record' && selectedRenderRecord?.netKey) {
      traceNet(selectedRenderRecord.netKey, false, selectedRenderRecord);
    }
    else if (action === 'fit-nets') focusLayoutBBox(mergeBBoxes(selectedNetShapes()));
    else if (action === 'clear-selection') clearAllSelection();
  });
  openFileBtn?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', () => { closeLibraryDialog(); loadLocalFile(fileInput.files?.[0]).catch(handleLoadError); });
  window.addEventListener('dragenter', (event) => {
    event.preventDefault();
    if (dropOverlay) dropOverlay.hidden = false;
  });
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('dragleave', (event) => {
    if (event.relatedTarget === null && dropOverlay) dropOverlay.hidden = true;
  });
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    if (dropOverlay) dropOverlay.hidden = true;
    loadLocalFile(event.dataTransfer?.files?.[0]).catch(handleLoadError);
  });
  window.addEventListener('keydown', (event) => {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '')) return;
    if (event.code === 'Escape') { clearAllSelection(); return; }
    if (event.code === 'Digit1') setViewPreset('iso');
    else if (event.code === 'Digit2') setViewPreset('top');
    else if (event.code === 'Digit3') setViewPreset('side');
    else if (event.code === 'KeyF') fitCamera(true);
    else if (event.code === 'KeyX') panAlongAxis('x', event.shiftKey ? -1 : 1, event.altKey);
    else if (event.code === 'KeyY') panAlongAxis('y', event.shiftKey ? -1 : 1, event.altKey);
    else if (event.code === 'KeyZ') panAlongAxis('z', event.shiftKey ? -1 : 1, event.altKey);
    else if (event.code === 'ArrowLeft') panAlongAxis('x', -1, event.shiftKey);
    else if (event.code === 'ArrowRight') panAlongAxis('x', 1, event.shiftKey);
    else if (event.code === 'ArrowUp') panAlongAxis('z', 1, event.shiftKey);
    else if (event.code === 'ArrowDown') panAlongAxis('z', -1, event.shiftKey);
    else if (event.code === 'PageUp') panAlongAxis('y', 1, event.shiftKey);
    else if (event.code === 'PageDown') panAlongAxis('y', -1, event.shiftKey);
    else return;
    event.preventDefault();
  });
}

function applyTheme() {
  const light = themeSelect?.value === 'light';
  document.body.classList.toggle('light-theme', light);
  renderer.setClearColor(currentTheme().background, 1);
}

function rememberedPaletteName() {
  try {
    const saved = localStorage.getItem(PALETTE_SETTINGS_KEY) || '';
    return Object.hasOwn(LAYER_PALETTES, saved) ? saved : '';
  } catch {
    return '';
  }
}

function initialPaletteName() {
  const requested = params.get('palette') || rememberedPaletteName() || DEFAULT_PALETTE;
  return Object.hasOwn(LAYER_PALETTES, requested) ? requested : DEFAULT_PALETTE;
}

function persistPaletteName(name) {
  try {
    localStorage.setItem(PALETTE_SETTINGS_KEY, name);
  } catch {}
  const url = new URL(window.location.href);
  url.searchParams.set('palette', name);
  window.history.replaceState(null, '', url);
}

function applyPaletteSelection() {
  const name = selectedPaletteName();
  if (paletteSelect) paletteSelect.value = name;
  persistPaletteName(name);
  if (!currentData) return;
  rebuildLayerMeta();
  updateLayerPanel();
  forceFullColorRefresh = true;
  updateAllColors();
}

async function main() {
  if (!canvas) throw codedError('E9001', 'Missing #scene canvas');
  if (themeSelect) themeSelect.value = params.get('theme') === 'light' ? 'light' : 'dark';
  if (paletteSelect) paletteSelect.value = initialPaletteName();
  if (routingToggle) routingToggle.checked = true;
  if (instancesToggle) instancesToggle.checked = false;
  if (pinsToggle) pinsToggle.checked = true;
  if (viaMerge) viaMerge.value = params.get('viaMerge') || '0';
  if (fovScale) {
    fovScale.value = params.get('fov') || '50';
    camera.fov = Number(fovScale.value);
    camera.updateProjectionMatrix();
    if (fovValue) fovValue.textContent = `${camera.fov}°`;
  }
  applyTheme();
  syncNavigationControls();
  restoreRememberedSettings();
  bindEvents();
  new ResizeObserver(resizeRenderer).observe(viewport);
  showWorkspacePanel('explorer');
  syncLoadSourceFields();
  resizeRenderer();
  showLoading('Loading layout manifest');
  await loadManifest();
  const session = await restoreLibrarySession();
  const requestedKey = requestedLayoutKey();
  if (requestedKey && layoutCatalog.has(requestedKey)) {
    renderCatalogOptions('', requestedKey);
    await loadSelectedCell(false);
    return;
  }
  if (!session && requestedKey) {
    const cached = exactCachedRecord(requestedKey);
    if (cached) {
      layoutCatalog = new Map([[cached.key, cached]]);
      if (libraryLabel) {
        libraryLabel.textContent = `${cached.library} · cached`;
        libraryLabel.title = 'Cached layout selected from the URL';
        libraryLabel.classList.add('is-loaded');
      }
      if (cellSearch) cellSearch.disabled = false;
      renderCatalogOptions('', requestedKey);
      await loadSelectedCell(false);
      return;
    }
  }
  if (!session) renderCatalogOptions('', '');
  hideLoading();
  window.__VL3D_APP_BOOTING = false;
  if (libraryRecoveryError) {
    cellStats.textContent = errorDetails(libraryRecoveryError).code === 'VL3D-E2023'
      ? 'Library session expired · reload the library'
      : 'Library service unavailable · manual paths remain available';
    renderErrorMessage(pickInfo, libraryRecoveryError, ' Use Load to retry.');
  } else {
    cellStats.textContent = session ? 'Select a cell and press Open' : 'Open a layout or try the public example';
    pickInfo.textContent = session ? pickInfo.textContent : 'Next: choose a layout source, then select a module to inspect its pins.';
  }
  requestRender();
}

main().catch(showError);
