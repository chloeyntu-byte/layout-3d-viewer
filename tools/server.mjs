#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { createServer } from 'node:http';
import {
  accessSync,
  chmodSync,
  chownSync,
  closeSync,
  constants,
  createReadStream,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  buildCatalog,
  configuredPdkProfiles,
  configuredViews,
  decorateOaCacheEntry,
  expandPath,
  layoutKey,
  loadProjectConfig,
  parseCdsLibraries,
  resolveCadenceEnvironment,
  resolveOaExportPolicy,
  resolveOaViewSource,
  validOaName,
  writeManifest,
} from './layout_catalog.mjs';
import {
  LibrarySessionStore,
  resolveSessionCadenceEnvironment,
} from './library_sessions.mjs';
import {
  ensurePrivateDirectory,
  findExecutable,
  resolveRuntimePaths,
} from './runtime_paths.mjs';
import { errorPayload, getErrorDefinition } from './error_catalog.mjs';
import { TraceService, TRACE_REQUEST_MAX_BYTES } from './trace_service.mjs';

const RAW_MAX_BYTES = 256 * 1024 * 1024;
const JSON_MAX_BYTES = 384 * 1024 * 1024;
const GZIP_MAX_BYTES = 128 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
const STREAM_INPUT_MAX_BYTES = 1024 * 1024 * 1024;
const STREAM_REQUEST_MAX_BYTES = 128 * 1024;
const LOCK_TIMEOUT_SECONDS = 60;
const EXPORT_TIMEOUT_MS = 15 * 60 * 1000;
const CONVERTER_TIMEOUT_MS = 5 * 60 * 1000;
const PICKER_TIMEOUT_MS = 30 * 60 * 1000;
const STREAM_TIMEOUT_MS = 15 * 60 * 1000;
const CONTROL_LINE_MAX_BYTES = 1024;
const OPERATION_TTL_MS = 30 * 60 * 1000;
const MAX_OPERATIONS = 32;
const STREAM_PROFILE_MAX_DIRECTORIES = 16;
const STREAM_PROFILE_MAX_DIRECTORY_ENTRIES = 256;
const STREAM_PROFILE_MAX_FILES = 64;
const STREAM_PROFILE_MAX_FILE_BYTES = 1024 * 1024;
const STREAM_PROFILE_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const STREAM_RESOURCE_PRESETS = Object.freeze({
  low: Object.freeze({ maxDepth: 6, maxShapes: 100000 }),
  balanced: Object.freeze({ maxDepth: 8, maxShapes: 200000 }),
  large: Object.freeze({ maxDepth: 16, maxShapes: 1000000 }),
});
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

function optionValue(args, index, option) {
  if (index + 1 >= args.length) throw new Error(`Missing value for ${option}`);
  return args[index + 1];
}

const args = process.argv.slice(2);
const opts = {
  root: '.',
  host: '127.0.0.1',
  port: 5177,
  enableOa: false,
  dataDir: null,
  stateDir: null,
  strictSymlinks: null,
  resourceMode: null,
  nativePrivate: false,
  authFd: null,
  parentFd: null,
};
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--root') opts.root = optionValue(args, index++, arg);
  else if (arg === '--host') opts.host = optionValue(args, index++, arg);
  else if (arg === '--port') opts.port = Number(optionValue(args, index++, arg));
  else if (arg === '--enable-oa') opts.enableOa = true;
  else if (arg === '--data-dir') opts.dataDir = optionValue(args, index++, arg);
  else if (arg === '--state-dir') opts.stateDir = optionValue(args, index++, arg);
  else if (arg === '--strict-symlinks') opts.strictSymlinks = true;
  else if (arg === '--allow-safe-symlinks') opts.strictSymlinks = false;
  else if (arg === '--resource-mode') opts.resourceMode = optionValue(args, index++, arg);
  else if (arg === '--native-private') opts.nativePrivate = true;
  else if (arg === '--auth-fd') opts.authFd = Number(optionValue(args, index++, arg));
  else if (arg === '--parent-fd') opts.parentFd = Number(optionValue(args, index++, arg));
  else throw new Error(`Unknown option: ${arg}`);
}
if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
  throw new Error('--port must be an integer from 0 through 65535');
}

function isLoopbackBind(host) {
  return ['127.0.0.1', '::1', 'localhost'].includes(String(host).toLowerCase());
}

if (opts.enableOa && !isLoopbackBind(opts.host)) {
  throw new Error('Refusing to enable OA loading on a non-loopback bind address');
}
if (opts.nativePrivate && !isLoopbackBind(opts.host)) {
  throw new Error('Refusing native private mode on a non-loopback bind address');
}
if (opts.nativePrivate && (
  !Number.isInteger(opts.authFd) || opts.authFd < 3
  || !Number.isInteger(opts.parentFd) || opts.parentFd < 3
)) {
  throw new Error('--native-private requires --auth-fd and --parent-fd values of 3 or greater');
}
if (!opts.nativePrivate && (opts.authFd != null || opts.parentFd != null)) {
  throw new Error('--auth-fd and --parent-fd require --native-private');
}
if (opts.enableOa && typeof process.getuid === 'function' && process.getuid() === 0) {
  throw new Error('Refusing to enable OA loading as root; run the server as the layout owner');
}

const root = realpathSync(resolve(opts.root));
const publicRoot = realpathSync(resolve(root, 'public'));
const { config: startupConfig } = loadProjectConfig(root);
const startupCadenceEnv = resolveCadenceEnvironment(root, startupConfig);
const runtimePaths = resolveRuntimePaths(root, process.env, {
  dataRoot: opts.dataDir || process.env.VL3D_DATA_DIR || startupConfig.dataDir,
  stateDirectory: opts.stateDir || process.env.VL3D_STATE_DIR || startupConfig.stateDir,
});
const dataRoot = ensurePrivateDirectory(runtimePaths.dataRoot);
const stateRoot = ensurePrivateDirectory(runtimePaths.stateDirectory);
const exportPolicy = resolveOaExportPolicy(
  startupConfig, process.env, opts.resourceMode ? { resourceMode: opts.resourceMode } : {},
);
const startupPdkProfiles = configuredPdkProfiles(root, startupConfig, process.env);
const startupStreamLayerMapValue = process.env.VL3D_STREAM_LAYER_MAP || startupConfig.streamLayerMap;
const startupStreamLayerMap = startupStreamLayerMapValue
  ? expandPath(startupStreamLayerMapValue, root, process.env) : null;
const pythonExecutable = findExecutable(process.env.VL3D_PYTHON || 'python3');
if (opts.enableOa && !pythonExecutable) {
  throw new Error('Python 3 is required for OA loading; set VL3D_PYTHON to an executable path');
}
const manifestPath = join(dataRoot, 'manifest.json');
const manifestLockPath = `${manifestPath}.lock`;
const strictSymlinks = opts.strictSymlinks ?? startupConfig.strictSymlinks === true;
const startupAdvancedSettings = Object.freeze({
  libraryName: startupConfig.libraryName || '',
  cdsLib: process.env.VL3D_CDS_LIB || startupConfig.cdsLib || '',
  cadenceEnv: startupCadenceEnv || '',
  views: [...configuredViews(startupConfig)],
  pdkProfile: startupPdkProfiles.profile || '',
  pdkProfileDirs: startupPdkProfiles.directories,
  streamLayerMap: startupStreamLayerMap || '',
  strictSymlinks,
  resourceMode: exportPolicy.resourceMode,
});
const librarySessions = new LibrarySessionStore(root, {
  dataRoot,
  exportPolicy,
  pdkProfiles: startupPdkProfiles,
  strictSymlinks,
});
const acceptedHosts = new Set();
const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.wasm', 'application/wasm'],
]);
const compressible = new Set(['.html', '.js', '.mjs', '.css', '.json', '.map', '.svg']);
let activeExportKey = '';
let activeStreamImport = '';
const activeProcessGroups = new Set();
const cadenceEnvironmentCache = new Map();
const operations = new Map();
let shutdownState = null;
let server;
let serverListening = false;
let listeningPort = null;
let privateBearerToken = null;
let parentPipeEnded = false;
const controlStreams = [];
const traceService = new TraceService({
  root, stateRoot, pythonExecutable, runBuffered, sourceRecord: streamSourceRecord,
  assertSnapshot: assertStreamSourceSnapshot, readRegular: regularFileBuffer, codedError,
  environment: () => cleanEnvironment(accountForUid(typeof process.getuid === 'function' ? process.getuid() : 0), false),
});

function acceptedHostValues(port) {
  return [
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ];
}

function updateAcceptedHosts(port) {
  acceptedHosts.clear();
  for (const host of acceptedHostValues(port)) acceptedHosts.add(host);
}

function controlStream(fd) {
  const stream = createReadStream(null, { fd, autoClose: false });
  controlStreams.push(stream);
  return stream;
}

function readControlToken(stream) {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffered = Buffer.alloc(0);
    let settled = false;
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('error', onError);
      stream.off('end', onEnd);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    };
    const onError = (error) => fail(new Error(`Cannot read native control pipe: ${error.message}`));
    const onEnd = () => fail(new Error('Native control pipe ended before the bearer token was received'));
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > CONTROL_LINE_MAX_BYTES) {
        fail(new Error('Native control token exceeds the protocol limit'));
        return;
      }
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      const remainder = buffered.subarray(newline + 1);
      if (remainder.toString('utf8').trim()) {
        fail(new Error('Native control pipe contains unexpected startup data'));
        return;
      }
      const token = buffered.subarray(0, newline).toString('utf8').replace(/\r$/, '');
      if (token.length < 32 || token.length > 512 || /[\s\0]/.test(token)) {
        fail(new Error('Native control token is invalid'));
        return;
      }
      settled = true;
      cleanup();
      stream.pause();
      resolvePromise(token);
    };
    stream.on('data', onData);
    stream.once('error', onError);
    stream.once('end', onEnd);
  });
}

function parentControlEnded() {
  if (parentPipeEnded) return;
  parentPipeEnded = true;
  if (serverListening && !shutdownState) beginShutdown('PARENT_EOF');
}

function watchParentControl(stream) {
  stream.once('end', parentControlEnded);
  stream.once('close', parentControlEnded);
  stream.once('error', parentControlEnded);
  stream.resume();
}

async function initializeNativeControl() {
  if (!opts.nativePrivate) return;
  const authStream = controlStream(opts.authFd);
  privateBearerToken = await readControlToken(authStream);
  if (opts.parentFd === opts.authFd) {
    watchParentControl(authStream);
  } else {
    watchParentControl(controlStream(opts.parentFd));
  }
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* The child already exited. */ }
  }
}

function finishShutdownIfReady() {
  if (!shutdownState || !shutdownState.serverClosed || activeProcessGroups.size) return;
  clearTimeout(shutdownState.timer);
  process.exit(shutdownState.code);
}

function securityHeaders(extraHeaders = {}) {
  return {
    'content-security-policy': CSP,
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    ...extraHeaders,
  };
}

function send(res, code, text, extraHeaders = {}) {
  res.writeHead(code, securityHeaders({
    'content-type': 'text/plain; charset=utf-8',
    ...extraHeaders,
  }));
  res.end(text);
}

function sendJson(res, code, payload, extraHeaders = {}) {
  const encoded = JSON.stringify(payload);
  res.writeHead(code, securityHeaders({
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(encoded),
    'cache-control': 'no-store',
    ...extraHeaders,
  }));
  res.end(encoded);
}

function sendEmpty(res, code, extraHeaders = {}) {
  res.writeHead(code, securityHeaders({
    'cache-control': 'no-store',
    'content-length': 0,
    ...extraHeaders,
  }));
  res.end();
}

function codedError(status, code, message, details = null) {
  const error = new Error(message);
  error.status = status;
  error.code = getErrorDefinition(code).code;
  if (details) error.details = details;
  return error;
}

function sendApiError(res, status, error, fallbackCode = 'E9001') {
  sendJson(res, status, errorPayload(error, fallbackCode));
}

function redirect(res, location) {
  res.writeHead(302, securityHeaders({
    location,
    'cache-control': 'no-store',
    'content-length': 0,
  }));
  res.end();
}

function isWithin(base, filePath) {
  const rel = relative(base, filePath);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isWithinRoot(filePath) {
  return isWithin(root, filePath);
}

function isAllowedPublicFile(filePath) {
  return isWithin(publicRoot, filePath)
    || isWithin(dataRoot, filePath);
}

function acceptsGzip(headerValue) {
  let wildcardQuality = null;
  let gzipQuality = null;
  String(headerValue || '').split(',').forEach((entry) => {
    const parts = entry.trim().split(';');
    const encoding = parts.shift().trim().toLowerCase();
    let quality = 1;
    parts.forEach((parameter) => {
      const match = parameter.trim().match(/^q=([0-9.]+)$/i);
      if (match) quality = Number(match[1]);
    });
    if (encoding === 'gzip') gzipQuality = quality;
    else if (encoding === '*') wildcardQuality = quality;
  });
  if (gzipQuality != null) return gzipQuality > 0;
  return wildcardQuality != null && wildcardQuality > 0;
}

function cacheControl(pathname) {
  if (pathname.endsWith('/public/data/manifest.json')) return 'no-store';
  if (pathname.includes('/public/vendor/')) return 'public, max-age=86400, immutable';
  if (pathname.includes('/public/data/')) return 'public, max-age=0, must-revalidate';
  return 'public, max-age=0, must-revalidate';
}

function weakEtag(metadata) {
  return `W/"${metadata.size.toString(16)}-${Math.trunc(metadata.mtimeMs).toString(16)}"`;
}

function isLoopback(address) {
  const normalized = String(address || '').replace(/^::ffff:/, '');
  return normalized === '127.0.0.1' || normalized === '::1';
}

function validHostRequest(req) {
  return acceptedHosts.has(String(req.headers.host || '').toLowerCase());
}

function validFetchSite(req) {
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  return !site || ['none', 'same-origin', 'same-site'].includes(site);
}

function sameOriginRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:'
      && parsed.host.toLowerCase() === String(req.headers.host || '').toLowerCase()
      && acceptedHosts.has(parsed.host.toLowerCase());
  } catch {
    return false;
  }
}

function privateRoute(pathname) {
  return pathname.startsWith('/api/')
    || pathname === '/public/data'
    || pathname.startsWith('/public/data/');
}

function validBearerRequest(req) {
  if (!opts.nativePrivate || !privateBearerToken) return true;
  const match = String(req.headers.authorization || '').match(/^Bearer ([^\s]+)$/i);
  if (!match) return false;
  const supplied = Buffer.from(match[1], 'utf8');
  const expected = Buffer.from(privateBearerToken, 'utf8');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readJsonBody(req, maximumBytes = 4096) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim();
  if (contentType !== 'application/json') {
    throw codedError(415, 'E9003', 'Expected application/json');
  }
  const declaredLength = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw codedError(413, 'E4004', 'Request body is too large');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximumBytes) {
      throw codedError(413, 'E4004', 'Request body is too large');
    }
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw codedError(400, 'E9003', 'Invalid JSON request');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw codedError(400, 'E9003', 'JSON request must be an object');
  }
  return body;
}

function publicCatalog(catalog) {
  return {
    apiVersion: 1,
    oaEnabled: opts.enableOa,
    oaAvailable: Boolean(opts.enableOa && catalog.cadenceEnv && catalog.libraries.size),
    activeExportKey,
    exportPolicy: catalog.exportPolicy || exportPolicy,
    layouts: catalog.layouts.map((layout) => ({
      key: layout.key,
      library: layout.library,
      cell: layout.cell,
      view: layout.view,
      cacheState: layout.cacheState,
      sourceType: layout.sourceType,
      entry: layout.entry,
    })),
  };
}

async function currentCatalog(overrides = {}) {
  const cadenceEnv = overrides.cadenceEnv || startupCadenceEnv;
  const environment = overrides.environment || await captureCadenceEnvironment(cadenceEnv);
  return buildCatalog(root, { ...overrides, cadenceEnv, environment }, { dataRoot, exportPolicy });
}

function accountForUid(uid) {
  try {
    for (const line of readFileSync('/etc/passwd', 'utf8').split(/\r?\n/)) {
      const fields = line.split(':');
      if (Number(fields[2]) === uid) return { name: fields[0], home: fields[5] || tmpdir() };
    }
  } catch {
    // Minimal containers may not expose a conventional passwd file.
  }
  return { name: String(uid), home: tmpdir() };
}

function cleanEnvironment(account, includeLicense = false) {
  const environment = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: account.home,
    USER: account.name,
    LOGNAME: account.name,
    LANG: process.env.LANG || 'C',
    LC_ALL: process.env.LC_ALL || process.env.LANG || 'C',
  };
  if (process.env.LC_CTYPE) environment.LC_CTYPE = process.env.LC_CTYPE;
  if (includeLicense) {
    for (const name of ['CDS_LIC_FILE', 'LM_LICENSE_FILE']) {
      if (process.env[name]) environment[name] = process.env[name];
    }
  }
  for (const [name, value] of Object.entries(environment)) {
    if (String(value).includes('\0') || /[\r\n]/.test(String(value))) {
      throw new Error(`Unsafe child environment value: ${name}`);
    }
  }
  return environment;
}

function localDisplaySocket(display) {
  const match = String(display || '').match(/^:(\d+)(?:\.\d+)?$/);
  if (!match) return null;
  const path = `/tmp/.X11-unix/X${match[1]}`;
  try {
    return lstatSync(path).isSocket() ? path : null;
  } catch {
    return null;
  }
}

function readableXauthority(candidate, uid) {
  if (!candidate || !isAbsolute(candidate)) return null;
  try {
    const canonical = realpathSync(candidate);
    const metadata = statSync(canonical);
    if (!metadata.isFile() || metadata.uid !== uid || metadata.size > 1024 * 1024) return null;
    accessSync(canonical, constants.R_OK);
    return canonical;
  } catch {
    return null;
  }
}

function procGuiCandidates(uid) {
  const candidates = [];
  let processIds = [];
  try {
    processIds = readdirSync('/proc').filter((name) => /^\d+$/.test(name)).slice(0, 4096);
  } catch {
    return candidates;
  }
  for (const processId of processIds) {
    const environmentPath = `/proc/${processId}/environ`;
    try {
      const processMetadata = statSync(`/proc/${processId}`);
      const environmentMetadata = statSync(environmentPath);
      if (processMetadata.uid !== uid || environmentMetadata.size > 256 * 1024) continue;
      const environment = Object.fromEntries(readFileSync(environmentPath)
        .toString('utf8')
        .split('\0')
        .filter(Boolean)
        .map((entry) => {
          const separator = entry.indexOf('=');
          return separator > 0 ? [entry.slice(0, separator), entry.slice(separator + 1)] : ['', ''];
        })
        .filter(([name]) => name));
      if (!localDisplaySocket(environment.DISPLAY)) continue;
      candidates.push(environment);
      if (candidates.length >= 16) break;
    } catch {
      // Processes may exit or hide their environment while being inspected.
    }
  }
  return candidates;
}

function discoverPickerExecutable() {
  const configured = process.env.VL3D_PICKER || process.env.VL3D_FILE_PICKER;
  const candidates = configured ? [configured] : ['zenity', 'yad', 'kdialog'];
  for (const candidate of candidates) {
    const executable = findExecutable(candidate);
    if (!executable) continue;
    const provider = executable.includes('kdialog')
      ? 'kdialog'
      : executable.includes('yad') ? 'yad' : 'zenity';
    return { executable, provider };
  }
  return null;
}

function discoverPickerEnvironment() {
  if (typeof process.getuid !== 'function' || process.getuid() === 0) {
    return { available: false, reason: 'The native picker requires a non-root server process' };
  }
  const pickerCommand = discoverPickerExecutable();
  if (!pickerCommand) return {
    available: false,
    reason: 'No supported graphical picker was found (zenity, yad, or kdialog)',
  };
  const uid = process.getuid();
  const account = accountForUid(uid);
  const candidates = [process.env, ...procGuiCandidates(uid)];
  try {
    for (const name of readdirSync('/tmp/.X11-unix').filter((entry) => /^X\d+$/.test(entry)).sort()) {
      candidates.push({ DISPLAY: `:${name.slice(1)}` });
    }
  } catch {
    // A headless host has no X11 socket directory.
  }
  for (const candidate of candidates) {
    if (!localDisplaySocket(candidate.DISPLAY)) continue;
    const xauthority = readableXauthority(candidate.XAUTHORITY, uid)
      || readableXauthority(join(account.home, '.Xauthority'), uid);
    const environment = cleanEnvironment(account, false);
    environment.DISPLAY = candidate.DISPLAY;
    if (xauthority) environment.XAUTHORITY = xauthority;
    const expectedBus = `/run/user/${uid}/bus`;
    if (candidate.DBUS_SESSION_BUS_ADDRESS === `unix:path=${expectedBus}`) {
      try {
        if (lstatSync(expectedBus).isSocket()) {
          environment.DBUS_SESSION_BUS_ADDRESS = candidate.DBUS_SESSION_BUS_ADDRESS;
        }
      } catch {
        // Zenity can operate without the session bus.
      }
    }
    return {
      available: true,
      provider: pickerCommand.provider,
      executable: pickerCommand.executable,
      display: candidate.DISPLAY,
      environment,
    };
  }
  return { available: false, reason: 'No usable same-user X11 graphical session was found' };
}

function runNativePicker(mode) {
  const picker = discoverPickerEnvironment();
  if (!picker.available) throw codedError(409, 'E2019', picker.reason);
  picker.environment.LANG = 'C';
  picker.environment.LC_ALL = 'C';
  let activeWindow = '';
  const xpropExecutable = findExecutable(process.env.VL3D_XPROP || 'xprop', picker.environment);
  try {
    const result = spawnSync(xpropExecutable, ['-root', '_NET_ACTIVE_WINDOW'], {
      encoding: 'utf8',
      env: picker.environment,
      timeout: 1000,
    });
    const windowHex = result.stdout.match(/window id # (0x[0-9a-f]+)/i)?.[1] || '';
    activeWindow = windowHex && windowHex !== '0x0' ? BigInt(windowHex).toString(10) : '';
  } catch {
    activeWindow = '';
  }
  const parentArgs = activeWindow ? [`--attach=${activeWindow}`, '--modal'] : [];
  const pickerArgs = picker.provider === 'kdialog'
    ? mode === 'cdsLib'
      ? ['--getopenfilename', picker.environment.HOME, 'cds.lib lib.defs', 'Select cds.lib or lib.defs']
      : ['--getexistingdirectory', picker.environment.HOME, 'Select OA library or project directory']
    : mode === 'cdsLib'
      ? ['--file-selection', ...parentArgs, '--title=Select cds.lib or lib.defs', '--file-filter=Cadence library files | cds.lib lib.defs']
      : ['--file-selection', '--directory', ...parentArgs, '--title=Select OA library or project directory'];
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(picker.executable, pickerArgs, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: picker.environment,
    });
    activeProcessGroups.add(child.pid);
    let stdout = '';
    let stderr = '';
    let oversized = false;
    const append = (current, chunk) => `${current}${chunk}`.slice(-8192);
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
      if (Buffer.byteLength(stdout) >= 8192) oversized = true;
    });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => signalProcessGroup(child.pid, 'SIGTERM'), PICKER_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      activeProcessGroups.delete(child.pid);
      rejectPromise(codedError(502, 'E2019', `Native picker could not start: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      activeProcessGroups.delete(child.pid);
      finishShutdownIfReady();
      if (code === 1) {
        resolvePromise({ canceled: true, path: null });
        return;
      }
      if (code !== 0 || oversized) {
        rejectPromise(codedError(502, 'E2019', `Native picker failed: ${stderr.trim() || `exit ${code}`}`));
        return;
      }
      const selected = stdout.trim();
      if (!isAbsolute(selected) || /[\0\r\n]/.test(selected)) {
        rejectPromise(codedError(502, 'E2019', 'Native picker returned an invalid path'));
        return;
      }
      resolvePromise({ canceled: false, path: selected });
    });
  });
}

function childIdentity(owner) {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return { uid: owner.uid, gid: owner.gid };
  }
  return {};
}

function runBuffered(command, commandArgs, options = {}, timeoutMs = EXPORT_TIMEOUT_MS, operation = null) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (operation?.cancelRequested) {
      const cancelled = new Error('Operation was cancelled before its child process started');
      cancelled.cancelled = true;
      rejectPromise(cancelled);
      return;
    }
    const child = spawn(command, commandArgs, {
      ...options,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeProcessGroups.add(child.pid);
    if (operation) operation.childPids.add(child.pid);
    let output = '';
    let timedOut = false;
    let killTimer = null;
    let settled = false;
    let progressBuffer = '';
    const append = (chunk) => {
      output = `${output}${chunk}`.slice(-1024 * 1024);
      if (operation?.type === 'physical-trace') {
        progressBuffer = `${progressBuffer}${chunk}`.slice(-8192);
        const lines = progressBuffer.split(/\r?\n/);
        progressBuffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('VL3D_TRACE_PROGRESS ')) continue;
          try { operation.progress = JSON.parse(line.slice('VL3D_TRACE_PROGRESS '.length)); }
          catch { /* Partial diagnostic output does not affect the result file. */ }
        }
      }
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      signalProcessGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => {
        signalProcessGroup(child.pid, 'SIGKILL');
      }, 3000);
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      activeProcessGroups.delete(child.pid);
      if (operation) operation.childPids.delete(child.pid);
      finishShutdownIfReady();
      if (!settled) {
        settled = true;
        rejectPromise(error);
      }
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      activeProcessGroups.delete(child.pid);
      if (operation) operation.childPids.delete(child.pid);
      finishShutdownIfReady();
      if (settled) return;
      settled = true;
      if (operation?.cancelRequested) {
        const cancelled = new Error('Operation was cancelled');
        cancelled.cancelled = true;
        rejectPromise(cancelled);
      } else if (timedOut) {
        rejectPromise(new Error(`Child process timed out after ${Math.round(timeoutMs / 60000)} minutes`));
      } else if (code !== 0) {
        rejectPromise(new Error(`Child process failed (${code ?? signal}): ${output.trim().slice(-4000)}`));
      } else {
        resolvePromise(output);
      }
    });
  });
}

function embeddedErrorCode(error) {
  const match = String(error?.message || error || '').match(/\b(?:VL3D-)?E[1-9][0-9]{3}\b/i);
  if (!match) return null;
  const definition = getErrorDefinition(match[0]);
  return definition.code === 'VL3D-E9001' && !/E9001$/i.test(match[0]) ? null : definition.code;
}

function classifyExporterError(error) {
  if (/^VL3D-E[1-9][0-9]{3}$/.test(String(error?.code || ''))) return error;
  const message = error?.message || String(error);
  const code = /timed out/i.test(message) ? 'E3007'
    : /(license|checkout|flexlm|lmgrd)/i.test(message) ? 'E3008'
      : /(pcell|supermaster|callback)/i.test(message) ? 'E3005'
        : /(openaccess|dbopencellview|cannot open|failed to open)/i.test(message) ? 'E3004'
          : 'E3003';
  return codedError(code === 'E3007' ? 504 : 500, code, message, { phase: 'oa-export' });
}

function classifyConverterError(error) {
  if (/^VL3D-E[1-9][0-9]{3}$/.test(String(error?.code || ''))) return error;
  const message = error?.message || String(error);
  const embedded = embeddedErrorCode(error);
  const code = embedded || (/timed out|resource limit|too (?:large|many)/i.test(message) ? 'VL3D-E4004' : 'VL3D-E4002');
  return codedError(/E4004$/.test(code) ? 413 : 500, code, message, { phase: 'conversion' });
}

const LOCK_HELPER = String.raw`
import fcntl, os, stat, sys, time
path = sys.argv[1]
timeout = float(sys.argv[2])
flags = os.O_RDWR | os.O_CREAT
if hasattr(os, "O_NOFOLLOW"):
    flags |= os.O_NOFOLLOW
fd = os.open(path, flags, 0o600)
metadata = os.fstat(fd)
if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
    sys.stderr.write("unsafe lock file\n")
    sys.exit(74)
deadline = time.time() + timeout
while True:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except OSError:
        if time.time() >= deadline:
            sys.stderr.write("lock timeout\n")
            sys.exit(75)
        time.sleep(0.1)
os.write(1, b"READY\n")
while os.read(0, 4096):
    pass
`;

async function withManifestLock(operation) {
  const child = spawn(pythonExecutable, [
    '-c', LOCK_HELPER, manifestLockPath, String(LOCK_TIMEOUT_SECONDS),
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
  await new Promise((resolvePromise, rejectPromise) => {
    let output = '';
    let ready = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(codedError(409, 'E7004', `Timed out waiting for ${manifestLockPath}`));
    }, (LOCK_TIMEOUT_SECONDS + 5) * 1000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
      if (!ready && output.includes('READY\n')) {
        ready = true;
        clearTimeout(timer);
        resolvePromise();
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      if (!ready) rejectPromise(codedError(500, 'E7004', `Cannot start cache lock helper: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!ready) rejectPromise(codedError(409, 'E7004', `Cannot acquire manifest lock (${code}): ${stderr.trim()}`));
    });
  });
  try {
    return await operation();
  } finally {
    child.stdin.end();
    await new Promise((resolvePromise) => {
      if (child.exitCode != null) resolvePromise();
      else child.once('close', resolvePromise);
    });
  }
}

function regularFileBuffer(path, maximumBytes, label) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    throw new Error(`${label} must be one regular, non-linked file`);
  }
  if (metadata.size <= 0 || metadata.size > maximumBytes) {
    throw new Error(`${label} has an invalid size: ${metadata.size}`);
  }
  const buffer = readFileSync(path);
  if (buffer.length !== metadata.size) throw new Error(`${label} changed while being read`);
  return buffer;
}

function validateRawDirectory(rawDirectory, expectedName) {
  const metadata = lstatSync(rawDirectory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('Raw export path is not a real directory');
  }
  const names = readdirSync(rawDirectory).sort();
  if (names.length !== 1 || names[0] !== expectedName) {
    throw new Error(`OA exporter must produce exactly ${expectedName}`);
  }
  regularFileBuffer(join(rawDirectory, expectedName), RAW_MAX_BYTES, 'OA TSV');
}

function parseJsonBuffer(buffer, label) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function exactIdentity(value, expected) {
  return value?.library === expected.library
    && value?.cell === expected.cell
    && value?.view === expected.view;
}

function layoutFileName(identity, extension = '.json') {
  return `${identity.library}@${identity.cell}@${identity.view}${extension}`;
}

function validateStage(stageDirectory, expected) {
  const stageMetadata = lstatSync(stageDirectory);
  if (stageMetadata.isSymbolicLink() || !stageMetadata.isDirectory()) {
    throw new Error('Converter staging is not a real directory');
  }
  const safeName = layoutFileName(expected);
  const expectedNames = [safeName, `${safeName}.gz`, 'manifest.json', 'manifest.json.gz'].sort();
  const actualNames = readdirSync(stageDirectory).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`Converter staging contains unexpected files: ${actualNames.join(', ')}`);
  }
  const jsonBuffer = regularFileBuffer(join(stageDirectory, safeName), JSON_MAX_BYTES, 'layout JSON');
  const gzipBuffer = regularFileBuffer(join(stageDirectory, `${safeName}.gz`), GZIP_MAX_BYTES, 'layout gzip');
  const manifestBuffer = regularFileBuffer(join(stageDirectory, 'manifest.json'), MANIFEST_MAX_BYTES, 'staged manifest');
  const manifestGzipBuffer = regularFileBuffer(
    join(stageDirectory, 'manifest.json.gz'), MANIFEST_MAX_BYTES, 'staged manifest gzip',
  );
  const expandedJson = gunzipSync(gzipBuffer, { maxOutputLength: JSON_MAX_BYTES });
  const expandedManifest = gunzipSync(manifestGzipBuffer, { maxOutputLength: MANIFEST_MAX_BYTES });
  if (!expandedJson.equals(jsonBuffer) || !expandedManifest.equals(manifestBuffer)) {
    throw new Error('Staged gzip sidecar does not match its JSON file');
  }
  const layout = parseJsonBuffer(jsonBuffer, 'layout JSON');
  const manifest = parseJsonBuffer(manifestBuffer, 'staged manifest');
  if (!exactIdentity(layout, expected)) throw new Error('Layout JSON identity mismatch');
  if (layout.sourceTsv !== layoutFileName(expected, '.tsv')) {
    throw new Error('Layout JSON source TSV mismatch');
  }
  for (const field of ['shapes', 'instances', 'pins', 'connections', 'sourceViews', 'layers']) {
    if (!Array.isArray(layout[field])) throw new Error(`Layout JSON ${field} must be an array`);
  }
  const countChecks = [
    ['shapeCount', 'shapes', exportPolicy.shapeLimit],
    ['instanceCount', 'instances', exportPolicy.instanceLimit],
    ['pinCount', 'pins', exportPolicy.pinLimit],
    ['connectionCount', 'connections', exportPolicy.connectionLimit],
  ];
  for (const [countName, arrayName, limit] of countChecks) {
    if (layout[countName] !== layout[arrayName].length || layout[countName] > limit) {
      throw new Error(`Layout JSON ${countName} is invalid`);
    }
  }
  if (!layout.sourceViews.length || !layout.sourceViews.every((source) => (
    source && [source.library, source.cell, source.view].every(validOaName)
  ))) throw new Error('Layout JSON has unsafe source views');
  if (!layout.sourceViews.some((source) => exactIdentity(source, expected))) {
    throw new Error('Layout JSON omits the requested OA source');
  }
  if (!manifest || manifest.schemaVersion !== 2 || !Array.isArray(manifest.cells)
      || manifest.cells.length !== 1) {
    throw new Error('Staged manifest must contain exactly one schema-v2 cell');
  }
  const entry = manifest.cells[0];
  if (!exactIdentity(entry, expected) || entry.path !== `data/${safeName}`) {
    throw new Error('Staged manifest identity or path mismatch');
  }
  for (const [countName] of countChecks) {
    if (entry[countName] !== layout[countName]) throw new Error(`Manifest ${countName} mismatch`);
  }
  return { entry, safeName, jsonBuffer, gzipBuffer };
}

function createExclusiveTemporary(destination, buffer) {
  const temporary = `${destination}.tmp-${randomBytes(12).toString('hex')}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    let offset = 0;
    while (offset < buffer.length) {
      offset += writeSync(descriptor, buffer, offset, buffer.length - offset);
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    return temporary;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch { /* Nothing to clean. */ }
    throw error;
  }
}

function publishLayoutPair(safeName, jsonBuffer, gzipBuffer) {
  const destination = join(dataRoot, safeName);
  const gzipDestination = `${destination}.gz`;
  const temporary = createExclusiveTemporary(destination, jsonBuffer);
  const temporaryGzip = createExclusiveTemporary(gzipDestination, gzipBuffer);
  try {
    renameSync(temporaryGzip, gzipDestination);
    renameSync(temporary, destination);
    const directory = openSync(dataRoot, constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    for (const candidate of [temporary, temporaryGzip]) {
      try { unlinkSync(candidate); } catch { /* A rename removes the temporary name. */ }
    }
  }
}

function strictPublicManifest() {
  const buffer = regularFileBuffer(manifestPath, MANIFEST_MAX_BYTES, 'public manifest');
  const manifest = parseJsonBuffer(buffer, 'public manifest');
  if (!manifest || manifest.schemaVersion !== 2 || !Array.isArray(manifest.cells)) {
    throw new Error('Public manifest is not valid schema v2');
  }
  return manifest;
}

function ensureInitialManifest() {
  try {
    strictPublicManifest();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    writeManifest(root, {
      schemaVersion: 2,
      generatedAt: new Date(0).toISOString(),
      cells: [],
    }, dataRoot);
    strictPublicManifest();
  }
}

function mergeAndPublish(catalog, expected, stage) {
  const entry = decorateOaCacheEntry(
    root, catalog.libraries, stage.entry, expected.library, expected.cell, expected.view,
    catalog.exportPolicy || exportPolicy,
    catalog.pdkProfiles,
  );
  const manifest = strictPublicManifest();
  const key = layoutKey(expected.library, expected.cell, expected.view);
  manifest.cells = manifest.cells.filter((candidate) => (
    layoutKey(candidate.library, candidate.cell, candidate.view) !== key
  ));
  manifest.cells.push(entry);
  manifest.cells.sort((first, second) => (
    layoutKey(first.library, first.cell, first.view)
      .localeCompare(layoutKey(second.library, second.cell, second.view))
  ));
  manifest.generatedAt = new Date().toISOString();
  publishLayoutPair(stage.safeName, stage.jsonBuffer, stage.gzipBuffer);
  writeManifest(root, manifest, dataRoot);
  return entry;
}

function streamInputKind(path) {
  const normalized = String(path || '').toLowerCase().replace(/\.gz$/, '');
  if (normalized.endsWith('.json')) return 'json';
  if (normalized.endsWith('.gds') || normalized.endsWith('.gdsii')) return 'gds';
  if (normalized.endsWith('.oas') || normalized.endsWith('.oasis')) return 'oas';
  return null;
}

function streamSourceRecord(requestedPath) {
  if (!isAbsolute(String(requestedPath || '')) || /\0|[\r\n]/.test(String(requestedPath || ''))) {
    throw codedError(400, 'E6001', 'Stream input path must be an absolute local path');
  }
  let canonical;
  let metadata;
  try {
    canonical = realpathSync(requestedPath);
    metadata = statSync(canonical);
    accessSync(canonical, constants.R_OK);
  } catch {
    throw codedError(404, 'E6001', 'Selected stream input is missing or unreadable');
  }
  const kind = streamInputKind(requestedPath) || streamInputKind(canonical);
  if (!kind || !metadata.isFile() || metadata.size <= 0 || metadata.size > STREAM_INPUT_MAX_BYTES) {
    throw codedError(
      400, 'E6001',
      'Input must be a readable JSON/GDSII/OASIS file within the configured size limit',
    );
  }
  return {
    path: canonical,
    kind,
    metadata,
    snapshot: {
      dev: metadata.dev,
      ino: metadata.ino,
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
    },
  };
}

function assertStreamSourceSnapshot(source) {
  let canonical;
  let metadata;
  try {
    canonical = realpathSync(source.path);
    metadata = statSync(canonical);
  } catch {
    throw codedError(409, 'E6008', 'Stream source became unavailable during import');
  }
  const expected = source.snapshot;
  if (canonical !== source.path || !metadata.isFile()
      || metadata.dev !== expected.dev || metadata.ino !== expected.ino
      || metadata.size !== expected.size || metadata.mtimeMs !== expected.mtimeMs) {
    throw codedError(409, 'E6008', 'Stream source changed during import');
  }
}

function genericIdentity(value, label, fallback = null) {
  const text = value == null || value === '' ? fallback : String(value);
  if (!text || text.length > 255 || /[\/\0\r\n]/.test(text)) {
    throw codedError(400, 'E3010', `${label} must be 1-255 characters without slashes or controls`);
  }
  return text;
}

function optionalInteger(value, label, fallback, minimum, maximum) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw codedError(400, 'E4004', `${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

function normalizeStreamImportBody(body) {
  const normalized = { ...body };
  const overrides = body.overrides;
  if (overrides != null) {
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
      throw codedError(400, 'E9003', 'stream import overrides must be a JSON object');
    }
    const supported = new Set([
      'layerMapPath', 'pdkProfilePath', 'pdkProfileDirs', 'resourceMode', 'pinAnnotationsPath',
    ]);
    for (const [key, value] of Object.entries(overrides)) {
      if (!supported.has(key)) {
        throw codedError(400, 'E9003', `Unsupported stream import override: ${key}`);
      }
      if (normalized[key] != null && normalized[key] !== value) {
        throw codedError(400, 'E9003', `Conflicting stream import value: ${key}`);
      }
      normalized[key] = value;
    }
    delete normalized.overrides;
  }
  if (normalized.topCell != null) {
    if (normalized.top != null && normalized.top !== normalized.topCell) {
      throw codedError(400, 'E9003', 'Conflicting stream import value: top/topCell');
    }
    normalized.top = normalized.topCell;
    delete normalized.topCell;
  }
  return normalized;
}

function copyJsonInputToStage(value, pathValue, label, stageDirectory, owner, filename) {
  if (value != null && pathValue) {
    throw codedError(400, 'E6003', `${label} and ${label}Path are mutually exclusive`);
  }
  let buffer = null;
  if (value != null) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw codedError(400, 'E6003', `${label} must be a JSON object`);
    }
    buffer = Buffer.from(`${JSON.stringify(value)}\n`);
  } else if (pathValue) {
    if (!isAbsolute(String(pathValue)) || /\0|[\r\n]/.test(String(pathValue))) {
      throw codedError(400, 'E6003', `${label}Path must be an absolute local path`);
    }
    try {
      const canonical = realpathSync(pathValue);
      buffer = regularFileBuffer(canonical, 4 * 1024 * 1024, label);
      JSON.parse(buffer.toString('utf8'));
    } catch (error) {
      throw codedError(400, 'E6003', `${label}Path is not a readable JSON object: ${error.message}`);
    }
  }
  if (!buffer) return null;
  const destination = join(stageDirectory, filename);
  const descriptor = openSync(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(descriptor, buffer, offset, buffer.length - offset);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (typeof process.getuid === 'function' && process.getuid() === 0 && owner.uid > 0) {
    chownSync(destination, owner.uid, owner.gid);
  }
  return destination;
}

function copyPdkProfileDirectoriesToStage(values, stageDirectory, owner) {
  if (values == null || values === '') return [];
  if (!Array.isArray(values) || values.length > STREAM_PROFILE_MAX_DIRECTORIES) {
    throw codedError(400, 'E5008', `pdkProfileDirs must contain at most ${STREAM_PROFILE_MAX_DIRECTORIES} paths`);
  }
  const staged = [];
  const seen = new Set();
  let fileCount = 0;
  let totalBytes = 0;
  for (const [directoryIndex, value] of values.entries()) {
    if (typeof value !== 'string' || !isAbsolute(value) || /\0|[\r\n]/.test(value)) {
      throw codedError(400, 'E5008', 'Each pdkProfileDirs entry must be an absolute local path');
    }
    let canonical;
    let metadata;
    let entries;
    try {
      metadata = lstatSync(value);
      canonical = realpathSync(value);
      if (metadata.isSymbolicLink() || !metadata.isDirectory() || canonical !== resolve(value)) {
        throw new Error('directory must be real, not a symlink');
      }
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      entries = readdirSync(canonical, { withFileTypes: true });
    } catch (error) {
      throw codedError(400, 'E5008', `PDK profile directory is unavailable or unsafe: ${error.message}`);
    }
    if (entries.length > STREAM_PROFILE_MAX_DIRECTORY_ENTRIES) {
      throw codedError(400, 'E5008', `PDK profile directory exceeds ${STREAM_PROFILE_MAX_DIRECTORY_ENTRIES} entries`);
    }
    const destinationDirectory = join(stageDirectory, `pdk-profiles-${directoryIndex}`);
    mkdirSync(destinationDirectory, { mode: 0o700 });
    if (typeof process.getuid === 'function' && process.getuid() === 0 && owner.uid > 0) {
      chownSync(destinationDirectory, owner.uid, owner.gid);
    }
    for (const entry of entries.sort((first, second) => first.name.localeCompare(second.name))) {
      if (entry.isSymbolicLink()) {
        throw codedError(400, 'E5008', `PDK profile directories must not contain symlinks: ${entry.name}`);
      }
      if (!entry.name.toLowerCase().endsWith('.json')) continue;
      if (!entry.isFile()) {
        throw codedError(400, 'E5008', `PDK profile JSON must be a regular file: ${entry.name}`);
      }
      fileCount += 1;
      if (fileCount > STREAM_PROFILE_MAX_FILES) {
        throw codedError(400, 'E5008', `At most ${STREAM_PROFILE_MAX_FILES} external PDK profiles are allowed`);
      }
      let buffer;
      try {
        buffer = regularFileBuffer(
          join(canonical, entry.name), STREAM_PROFILE_MAX_FILE_BYTES, `PDK profile ${entry.name}`,
        );
        const parsed = JSON.parse(buffer.toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('profile root must be a JSON object');
        }
      } catch (error) {
        throw codedError(400, 'E5008', `PDK profile ${entry.name} is invalid: ${error.message}`);
      }
      totalBytes += buffer.length;
      if (totalBytes > STREAM_PROFILE_MAX_TOTAL_BYTES) {
        throw codedError(400, 'E5008', 'External PDK profiles exceed the total byte limit');
      }
      const destination = join(destinationDirectory, entry.name);
      const descriptor = openSync(
        destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600,
      );
      try {
        let offset = 0;
        while (offset < buffer.length) {
          offset += writeSync(descriptor, buffer, offset, buffer.length - offset);
        }
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      if (typeof process.getuid === 'function' && process.getuid() === 0 && owner.uid > 0) {
        chownSync(destination, owner.uid, owner.gid);
      }
    }
    staged.push(destinationDirectory);
  }
  return staged;
}

function streamImportMarker(error) {
  const lines = String(error?.message || error || '').split(/\r?\n/).reverse();
  const line = lines.find((candidate) => candidate.includes('VL3D_IMPORT_ERROR '));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(line.indexOf('VL3D_IMPORT_ERROR ') + 'VL3D_IMPORT_ERROR '.length));
  } catch {
    return null;
  }
}

function classifyStreamImporterError(error) {
  if (error?.cancelled) return error;
  const marker = streamImportMarker(error);
  const message = marker?.message || error?.message || String(error);
  const embedded = marker?.code || embeddedErrorCode(error);
  const code = embedded || (/timed out/i.test(message) ? 'E6005' : 'E6004');
  const status = /E6002$|E6008$/.test(code) ? 409
    : /E6001$|E6003$/.test(code) ? 400
      : /E6005$/.test(code) ? 504
        : /E6007$/.test(code) ? 503
          : /E4004$/.test(code) ? 413 : 422;
  return codedError(status, code, message, marker?.details || { phase: 'stream-import' });
}

function safeStreamFileName(identity) {
  const safe = (value) => String(value).replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 72) || 'unnamed';
  const digest = createHash('sha256')
    .update(`${identity.library}\0${identity.cell}\0${identity.view}`)
    .digest('hex').slice(0, 12);
  return `${safe(identity.library)}@${safe(identity.cell)}@${safe(identity.view)}-${digest}.json`;
}

function validateStreamStage(stageDirectory) {
  const jsonPath = join(stageDirectory, 'layout.json');
  const gzipPath = `${jsonPath}.gz`;
  const jsonBuffer = regularFileBuffer(jsonPath, JSON_MAX_BYTES, 'stream layout JSON');
  const gzipBuffer = regularFileBuffer(gzipPath, GZIP_MAX_BYTES, 'stream layout gzip');
  const expanded = gunzipSync(gzipBuffer, { maxOutputLength: JSON_MAX_BYTES });
  if (!expanded.equals(jsonBuffer)) throw new Error('Stream JSON and gzip outputs differ');
  const payload = parseJsonBuffer(jsonBuffer, 'stream layout JSON');
  if (!payload || payload.schemaVersion !== 2) throw new Error('Stream output is not schema v2');
  for (const name of ['layers', 'shapes', 'instances', 'pins', 'connections']) {
    if (!Array.isArray(payload[name])) throw new Error(`Stream output ${name} must be an array`);
  }
  const identity = {
    library: genericIdentity(payload.library, 'library'),
    cell: genericIdentity(payload.cell, 'cell'),
    view: genericIdentity(payload.view, 'view', 'layout'),
  };
  const countChecks = [
    ['shapeCount', payload.shapes.length],
    ['instanceCount', payload.instances.length],
    ['pinCount', payload.pins.length],
    ['connectionCount', payload.connections.length],
  ];
  for (const [name, expected] of countChecks) {
    if (payload[name] !== expected) throw new Error(`Stream output ${name} does not match its array`);
  }
  if (!/^[a-f0-9]{64}$/.test(String(payload.source?.sha256 || ''))) {
    throw new Error('Stream output source fingerprint is missing');
  }
  return {
    payload,
    identity,
    safeName: safeStreamFileName(identity),
    jsonBuffer,
    gzipBuffer,
  };
}

function streamManifestEntry(stage) {
  const payload = stage.payload;
  return {
    library: stage.identity.library,
    cell: stage.identity.cell,
    view: stage.identity.view,
    path: `data/${stage.safeName}`,
    sourceFormat: payload.sourceFormat || 'STREAM',
    shapeCount: payload.shapeCount,
    sourceShapeCount: payload.sourceShapeCount ?? payload.shapeCount,
    instanceCount: payload.instanceCount,
    pinCount: payload.pinCount,
    connectionCount: payload.connectionCount,
    layerCount: payload.layers.length,
    maxShapeDepth: payload.maxShapeDepth || 0,
    maxInstanceDepth: payload.maxInstanceDepth || 0,
    ownerCellCount: payload.ownerCellCount || 0,
    bbox: payload.bbox,
    exportStatus: payload.exportStatus || {},
    technology: payload.technology || {},
    warnings: payload.warnings || [],
    source: payload.source,
    ...(payload.pinAnnotations ? { pinAnnotations: payload.pinAnnotations } : {}),
  };
}

function publishStreamStage(stage) {
  const entry = streamManifestEntry(stage);
  const manifest = strictPublicManifest();
  const identity = stage.identity;
  manifest.cells = manifest.cells.filter((candidate) => !(
    candidate.library === identity.library
    && candidate.cell === identity.cell
    && candidate.view === identity.view
  ));
  manifest.cells.push(entry);
  manifest.cells.sort((first, second) => (
    layoutKey(first.library, first.cell, first.view)
      .localeCompare(layoutKey(second.library, second.cell, second.view))
  ));
  manifest.generatedAt = new Date().toISOString();
  publishLayoutPair(stage.safeName, stage.jsonBuffer, stage.gzipBuffer);
  writeManifest(root, manifest, dataRoot);
  return entry;
}

function streamChildOwner(source) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0 || source.metadata.uid <= 0) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : source.metadata.uid;
    const gid = typeof process.getgid === 'function' ? process.getgid() : source.metadata.gid;
    return { uid, gid, ...accountForUid(uid) };
  }
  return { uid: source.metadata.uid, gid: source.metadata.gid, ...accountForUid(source.metadata.uid) };
}

function annotationSourceRecord(path) {
  try {
    const record = streamSourceRecord(path);
    if (record.kind !== 'json' || !String(path).toLowerCase().endsWith('.json')) {
      throw new Error('Pin annotations must be a readable .json sidecar');
    }
    const bytes = regularFileBuffer(record.path, 4 * 1024 * 1024, 'pin annotations');
    record.sha256 = createHash('sha256').update(bytes).digest('hex');
    return record;
  } catch (error) {
    throw codedError(400, 'E6009', error.message, { phase: 'pin-annotations' });
  }
}

function assertAnnotationSource(record) {
  if (!record) return;
  const current = annotationSourceRecord(record.path);
  if (current.sha256 !== record.sha256 || current.metadata.mtimeMs !== record.metadata.mtimeMs
      || current.metadata.ino !== record.metadata.ino || current.metadata.dev !== record.metadata.dev) {
    throw codedError(409, 'E6009', 'Pin sidecar changed during import; retry the stable file. No result was published');
  }
}

function writeAnnotationStage(path, bytes) {
  const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
}

async function applyPinAnnotations(source, stagedSidecar, outputPath, temporaryRoot, owner, operation) {
  const annotatedPath = join(temporaryRoot, 'pin-annotated.json');
  try {
    await runBuffered(pythonExecutable, [join(root, 'tools/annotate_pins.py'), outputPath,
      '--annotations', stagedSidecar, '--output', annotatedPath], {
      cwd: root, ...childIdentity(owner), env: cleanEnvironment(owner, false),
    }, STREAM_TIMEOUT_MS, operation);
  } catch (error) {
    if (error?.cancelled) throw error;
    const line = String(error?.message || error).split(/\r?\n/).find((item) => item.includes('VL3D_PIN_ANNOTATION_ERROR '));
    let message = 'Pin annotation validation failed';
    if (line) {
      try { message = JSON.parse(line.slice(line.indexOf('VL3D_PIN_ANNOTATION_ERROR ') + 'VL3D_PIN_ANNOTATION_ERROR '.length)).message || message; } catch {}
    }
    throw codedError(422, 'E6009', message, { phase: 'pin-annotations' });
  }
  if (operation?.cancelRequested) {
    const cancelled = new Error('Operation was cancelled before pin publication'); cancelled.cancelled = true; throw cancelled;
  }
  assertAnnotationSource(source);
  if (typeof process.getuid === 'function' && process.getuid() === 0) sealTemporaryRoot(temporaryRoot);
  const payload = parseJsonBuffer(regularFileBuffer(annotatedPath, JSON_MAX_BYTES, 'annotated layout JSON'), 'annotated layout JSON');
  payload.pinAnnotations = { ...payload.pinAnnotations, sha256: source.sha256,
    mtimeMs: source.metadata.mtimeMs, sizeBytes: source.metadata.size };
  delete payload.pinAnnotations.mtimeNs; // Staging file time is not the user's sidecar time.
  const bytes = Buffer.from(`${JSON.stringify(payload)}\n`);
  const publishJson = join(temporaryRoot, 'pin-publish.json');
  const publishGzip = join(temporaryRoot, 'pin-publish.json.gz');
  writeAnnotationStage(publishJson, bytes);
  writeAnnotationStage(publishGzip, gzipSync(bytes));
  renameSync(publishJson, outputPath);
  renameSync(publishGzip, `${outputPath}.gz`);
}

async function importStreamLayout(body, operation = null) {
  if (!pythonExecutable) throw codedError(503, 'E6007', 'Python 3 is required for stream import');
  if (activeStreamImport) {
    throw codedError(409, 'E7004', `Another stream import is active: ${activeStreamImport}`);
  }
  const source = streamSourceRecord(body.path);
  const annotationSource = body.pinAnnotationsPath ? annotationSourceRecord(body.pinAnnotationsPath) : null;
  const library = body.library == null || body.library === ''
    ? null : genericIdentity(body.library, 'library');
  const top = body.top == null || body.top === '' ? null : genericIdentity(body.top, 'top cell');
  const parserName = String(body.parser || 'auto');
  if (!['auto', 'gdstk', 'klayout'].includes(parserName)) {
    throw codedError(400, 'E6007', 'parser must be auto, gdstk, or klayout');
  }
  const resourceMode = String(body.resourceMode || exportPolicy.resourceMode || 'balanced').toLowerCase();
  const resourcePreset = STREAM_RESOURCE_PRESETS[resourceMode];
  if (!resourcePreset) {
    throw codedError(400, 'E4004', 'resourceMode must be low, balanced, or large');
  }
  const maxDepth = optionalInteger(body.maxDepth, 'maxDepth', resourcePreset.maxDepth, 0, 256);
  const maxShapes = optionalInteger(
    body.maxShapes, 'maxShapes', resourcePreset.maxShapes, 1, 20_000_000,
  );
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'vl3d-stream-import-'));
  const owner = streamChildOwner(source);
  if (typeof process.getuid === 'function' && process.getuid() === 0 && owner.uid > 0) {
    chownSync(temporaryRoot, owner.uid, owner.gid);
    chmodSync(temporaryRoot, 0o700);
  }
  activeStreamImport = `${source.kind}:${source.metadata.size}`;
  const startedAt = Date.now();
  try {
    let stagedAnnotations = null;
    if (annotationSource) {
      try { stagedAnnotations = copyJsonInputToStage(null, annotationSource.path, 'pinAnnotations', temporaryRoot, owner, 'pin-annotations.json'); }
      catch (error) { throw codedError(400, 'E6009', error.message); }
      const copied = regularFileBuffer(stagedAnnotations, 4 * 1024 * 1024, 'pin annotations');
      if (createHash('sha256').update(copied).digest('hex') !== annotationSource.sha256) {
        throw codedError(409, 'E6009', 'Pin sidecar changed while being copied; retry the stable file');
      }
    }
    const hasRequestLayerMap = Object.hasOwn(body, 'layerMap') || Object.hasOwn(body, 'layerMapPath');
    const effectiveLayerMapValue = hasRequestLayerMap
      ? (body.layerMap || body.layerMapPath) : startupStreamLayerMap;
    const hasRequestPdkProfile = Object.hasOwn(body, 'pdkProfilePath');
    const hasRequestPdkProfileDirs = Object.hasOwn(body, 'pdkProfileDirs');
    const effectivePdkProfilePath = hasRequestPdkProfile
      ? body.pdkProfilePath
      : (hasRequestPdkProfileDirs || effectiveLayerMapValue ? null : startupPdkProfiles.profile);
    const effectivePdkProfileDirs = hasRequestPdkProfileDirs
      ? body.pdkProfileDirs
      : (hasRequestPdkProfile || effectiveLayerMapValue || startupPdkProfiles.profile
        ? [] : startupPdkProfiles.directories);
    const layerMapPath = copyJsonInputToStage(
      hasRequestLayerMap ? body.layerMap : null,
      hasRequestLayerMap ? body.layerMapPath : startupStreamLayerMap,
      'layerMap', temporaryRoot, owner, 'layer-map.json',
    );
    const pdkProfilePath = copyJsonInputToStage(
      null, effectivePdkProfilePath, 'pdkProfile', temporaryRoot, owner, 'pdk-profile.json',
    );
    const pdkProfileDirectories = (pdkProfilePath || layerMapPath) ? []
      : copyPdkProfileDirectoriesToStage(effectivePdkProfileDirs, temporaryRoot, owner);
    const outputPath = join(temporaryRoot, 'layout.json');
    const importerArgs = [
      join(root, 'tools', 'import_stream_layout.py'),
      source.path,
      '--output', outputPath,
      '--parser', parserName,
      '--resource-mode', resourceMode,
      '--max-depth', String(maxDepth),
      '--max-shapes', String(maxShapes),
      '--no-backup',
    ];
    if (library) importerArgs.push('--library', library);
    if (top) importerArgs.push('--top', top);
    if (layerMapPath) importerArgs.push('--layer-map', layerMapPath);
    if (pdkProfilePath) importerArgs.push('--pdk-profile', pdkProfilePath);
    for (const directory of pdkProfileDirectories) {
      importerArgs.push('--pdk-profile-dir', directory);
    }
    if (body.klayoutPath) {
      if (!isAbsolute(String(body.klayoutPath)) || /\0|[\r\n]/.test(String(body.klayoutPath))) {
        throw codedError(400, 'E6007', 'klayoutPath must be an absolute executable path');
      }
      importerArgs.push('--klayout', String(body.klayoutPath));
    }
    try {
      await runBuffered(pythonExecutable, importerArgs, {
        cwd: root,
        ...childIdentity(owner),
        env: cleanEnvironment(owner, false),
      }, STREAM_TIMEOUT_MS, operation);
    } catch (error) {
      throw classifyStreamImporterError(error);
    }
    if (operation?.cancelRequested) {
      const cancelled = new Error('Operation was cancelled before publish');
      cancelled.cancelled = true;
      throw cancelled;
    }
    assertStreamSourceSnapshot(source);
    if (annotationSource) await applyPinAnnotations(annotationSource, stagedAnnotations, outputPath, temporaryRoot, owner, operation);
    let stage;
    try {
      if (typeof process.getuid === 'function' && process.getuid() === 0) {
        sealTemporaryRoot(temporaryRoot);
      }
      stage = validateStreamStage(temporaryRoot);
    } catch (error) {
      throw codedError(500, 'E4002', error.message, { phase: 'stream-validation' });
    }
    if (operation?.cancelRequested) {
      const cancelled = new Error('Operation was cancelled before publish');
      cancelled.cancelled = true;
      throw cancelled;
    }
    const entry = await withManifestLock(async () => {
      assertStreamSourceSnapshot(source);
      assertAnnotationSource(annotationSource);
      return publishStreamStage(stage);
    });
    return {
      cached: false,
      entry,
      elapsedMs: Date.now() - startedAt,
      parser: stage.payload.exportStatus?.parser || 'unknown',
    };
  } finally {
    activeStreamImport = '';
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function pruneOperations(now = Date.now()) {
  for (const [id, operation] of operations) {
    if (operation.finishedAt && now - operation.finishedAt > OPERATION_TTL_MS) operations.delete(id);
  }
  while (operations.size >= MAX_OPERATIONS) {
    const oldestFinished = [...operations.values()]
      .filter((operation) => operation.finishedAt)
      .sort((first, second) => first.finishedAt - second.finishedAt)[0];
    if (!oldestFinished) break;
    operations.delete(oldestFinished.id);
  }
}

function publicOperation(operation) {
  return {
    operationId: operation.id,
    type: operation.type,
    state: operation.state,
    createdAt: new Date(operation.createdAt).toISOString(),
    updatedAt: new Date(operation.updatedAt).toISOString(),
    ...(operation.result ? { result: operation.result } : {}),
    ...(operation.progress ? { progress: operation.progress } : {}),
    ...(operation.error ? { error: operation.error } : {}),
  };
}

function createOperation(type, task) {
  pruneOperations();
  if (operations.size >= MAX_OPERATIONS) {
    throw codedError(429, 'E4004', 'Too many retained operations; clear completed operations first');
  }
  const now = Date.now();
  const operation = {
    id: randomBytes(20).toString('hex'),
    type,
    state: 'running',
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    result: null,
    error: null,
    cancelRequested: false,
    childPids: new Set(),
  };
  operations.set(operation.id, operation);
  Promise.resolve().then(() => task(operation)).then((result) => {
    if (operation.cancelRequested) {
      operation.state = 'cancelled';
    } else {
      operation.state = 'succeeded';
      operation.result = result;
    }
    operation.updatedAt = Date.now();
    operation.finishedAt = operation.updatedAt;
  }, (error) => {
    operation.state = operation.cancelRequested || error?.cancelled ? 'cancelled' : 'failed';
    if (operation.state === 'failed') operation.error = errorPayload(error, type === 'physical-trace' ? 'E4004' : 'E6004').error;
    operation.updatedAt = Date.now();
    operation.finishedAt = operation.updatedAt;
  });
  return operation;
}

function cancelOperation(operation) {
  if (!['running', 'cancelling'].includes(operation.state)) return false;
  operation.cancelRequested = true;
  operation.state = 'cancelling';
  operation.updatedAt = Date.now();
  for (const pid of operation.childPids) signalProcessGroup(pid, 'SIGTERM');
  const timer = setTimeout(() => {
    if (!operation.cancelRequested || operation.finishedAt) return;
    for (const pid of operation.childPids) signalProcessGroup(pid, 'SIGKILL');
  }, 3000);
  timer.unref?.();
  return true;
}

function selectExportOwner(catalog, layout) {
  const libraryPath = catalog.libraries.get(layout.library);
  const libraryOwner = statSync(libraryPath);
  const effectiveOwner = typeof process.getuid === 'function' && process.getuid() > 0
    ? { uid: process.getuid(), gid: process.getgid() }
    : null;
  const fallbackOwners = [catalog.cadenceEnv, catalog.cdsLib, ...catalog.libraries.values(), root]
    .filter(Boolean)
    .flatMap((candidate) => {
      try { return [statSync(candidate)]; } catch { return []; }
    });
  const owner = [effectiveOwner, libraryOwner, ...fallbackOwners]
    .find((candidate) => candidate?.uid > 0);
  if (!owner) throw codedError(500, 'E3003', 'Refusing to run the OA exporter as root; no non-root owner was found');
  return { uid: owner.uid, gid: owner.gid };
}

function sealTemporaryRoot(temporaryRoot) {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    chownSync(temporaryRoot, 0, 0);
    chmodSync(temporaryRoot, 0o700);
  } else {
    chmodSync(temporaryRoot, 0o700);
  }
}

function sealRootStage(stageDirectory) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  function seal(path) {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) throw new Error('Converter staging contains a symbolic link');
    if (metadata.isDirectory()) {
      for (const name of readdirSync(path)) seal(join(path, name));
      chownSync(path, 0, 0);
      chmodSync(path, 0o500);
      return;
    }
    if (!metadata.isFile()) throw new Error('Converter staging contains a non-regular file');
    chownSync(path, 0, 0);
    chmodSync(path, 0o400);
  }
  seal(stageDirectory);
}

function createSessionCdsLib(temporaryRoot, catalog, owner) {
  if (!catalog.sessionScoped || (!catalog.needsOverlay && catalog.cdsLib)) return catalog.cdsLib;
  const selected = catalog.selectedLibrary;
  if (!selected || !validOaName(selected.name)) throw codedError(400, 'E3010', 'Session library identity is invalid');
  for (const [label, value] of [['cds.lib', catalog.cdsLib], ['library path', selected.path]]) {
    if (value && /[\0\r\n#;]/.test(value)) throw codedError(400, 'E2010', `${label} contains unsupported cds.lib characters`);
  }
  const path = join(temporaryRoot, 'session-cds.lib');
  const lines = [];
  if (catalog.cdsLib) lines.push(`INCLUDE ${catalog.cdsLib}`);
  lines.push(`DEFINE ${selected.name} ${selected.path}`);
  const buffer = Buffer.from(`${lines.join('\n')}\n`);
  const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeSync(descriptor, buffer);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (typeof process.getuid === 'function' && process.getuid() === 0) chownSync(path, owner.uid, owner.gid);
  return path;
}

function createEnvironmentDump(temporaryRoot, owner) {
  const path = join(temporaryRoot, 'cadence-environment.bin');
  const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  closeSync(descriptor);
  if (typeof process.getuid === 'function' && process.getuid() === 0) chownSync(path, owner.uid, owner.gid);
  return path;
}

function parseEnvironmentBuffer(buffer) {
  const environment = {};
  for (const record of buffer.toString('utf8').split('\0')) {
    if (!record) continue;
    const separator = record.indexOf('=');
    if (separator <= 0) continue;
    const name = record.slice(0, separator);
    const value = record.slice(separator + 1);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !/[\0\r\n]/.test(value)) environment[name] = value;
  }
  return environment;
}

function parseEnvironmentDump(path) {
  return parseEnvironmentBuffer(regularFileBuffer(
    path, 1024 * 1024, 'Cadence environment dump',
  ));
}

async function captureCadenceEnvironment(cadenceEnv) {
  if (!cadenceEnv) return process.env;
  const metadata = statSync(cadenceEnv);
  const cacheKey = `${cadenceEnv}:${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`;
  if (cadenceEnvironmentCache.has(cacheKey)) return cadenceEnvironmentCache.get(cacheKey);
  const uid = typeof process.getuid === 'function' ? process.getuid() : metadata.uid;
  const account = accountForUid(uid);
  const output = await runBuffered('/bin/bash', [
    '--noprofile', '--norc', '-c',
    'set -e; source "$1" >/dev/null 2>&1; /usr/bin/env -0',
    'vl3d-load-environment', cadenceEnv,
  ], {
    cwd: root,
    env: cleanEnvironment(account, true),
  }, 30 * 1000);
  const environment = parseEnvironmentBuffer(Buffer.from(output, 'utf8'));
  if (!environment.PATH) environment.PATH = '/usr/local/bin:/usr/bin:/bin';
  cadenceEnvironmentCache.clear();
  cadenceEnvironmentCache.set(cacheKey, environment);
  return environment;
}

function validateSessionLayoutSource(catalog, layout) {
  if (!catalog.sessionScoped) return;
  const snapshot = layout.sourceSnapshot;
  if (!snapshot) throw new Error('Session layout source snapshot is missing');
  const libraryPath = catalog.selectedLibrary.path;
  try {
    const source = resolveOaViewSource(
      libraryPath, layout.cell, layout.view,
      { requireRealEntries: catalog.strictSymlinks === true },
    );
    if (!source) throw new Error('source not found');
    const metadata = source.oaMetadata;
    if (!isWithin(libraryPath, source.oaPath) || source.oaPath !== snapshot.path
        || metadata.dev !== snapshot.dev || metadata.ino !== snapshot.ino
        || metadata.size !== snapshot.size || metadata.mtimeMs !== snapshot.mtimeMs) {
      throw new Error('source identity mismatch');
    }
    const tag = snapshot.masterTag;
    if (Boolean(tag) !== Boolean(source.masterTagPath)) throw new Error('master.tag identity mismatch');
    if (tag && (source.masterTagPath !== tag.path
        || source.masterTagMetadata.dev !== tag.dev || source.masterTagMetadata.ino !== tag.ino
        || source.masterTagMetadata.size !== tag.size
        || source.masterTagMetadata.mtimeMs !== tag.mtimeMs)) {
      throw new Error('master.tag identity mismatch');
    }
  } catch {
    throw codedError(409, 'E3009', 'OA layout changed after selection; reload the library and try again');
  }
}

async function exportOaLayout(catalog, layout) {
  validateSessionLayoutSource(catalog, layout);
  const owner = selectExportOwner(catalog, layout);
  const account = accountForUid(owner.uid);
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'vl3d-oa-'));
  const rawDirectory = join(temporaryRoot, 'raw');
  const stageDirectory = join(temporaryRoot, 'stage');
  const runtimeDirectory = join(temporaryRoot, 'runtime');
  const logPath = join(temporaryRoot, 'virtuoso.log');
  for (const directory of [rawDirectory, stageDirectory, runtimeDirectory]) {
    mkdirSync(directory, { mode: 0o700 });
  }
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    for (const path of [temporaryRoot, rawDirectory, stageDirectory, runtimeDirectory]) {
      chownSync(path, owner.uid, owner.gid);
    }
  }
  const identity = { library: layout.library, cell: layout.cell, view: layout.view };
  const tsvName = layoutFileName(layout, '.tsv');
  const identityOptions = childIdentity(owner);
  try {
    const effectiveCdsLib = createSessionCdsLib(temporaryRoot, catalog, owner);
    const environmentDump = catalog.sessionScoped ? createEnvironmentDump(temporaryRoot, owner) : null;
    const exporterArgs = [
      join(root, 'tools', 'export_layouts.sh'),
      '--lib', layout.library,
      '--cells', layout.cell,
      '--view', layout.view,
      '--max-depth', String(catalog.exportPolicy.maxDepth),
      '--shape-limit', String(catalog.exportPolicy.shapeLimit),
      '--instance-limit', String(catalog.exportPolicy.instanceLimit),
      '--pin-limit', String(catalog.exportPolicy.pinLimit),
      '--connection-limit', String(catalog.exportPolicy.connectionLimit),
      '--record-limit', String(catalog.exportPolicy.recordLimit),
      '--cadence-env', catalog.sessionScoped ? '/dev/null' : catalog.cadenceEnv,
      '--cds-lib', effectiveCdsLib,
      '--raw-dir', rawDirectory,
      '--runtime-dir', runtimeDirectory,
      '--log', logPath,
      '--raw-only',
    ];
    const commandArgs = catalog.sessionScoped
      ? [
        '--noprofile', '--norc', '-c',
        'set -e; source "$1" >/dev/null; /usr/bin/env -0 > "$2"; shift 2; source "$@"',
        'vl3d-cadence-env', catalog.cadenceEnv, environmentDump, ...exporterArgs,
      ]
      : exporterArgs;
    try {
      await runBuffered('/bin/bash', commandArgs, {
        cwd: root,
        ...identityOptions,
        env: cleanEnvironment(account, true),
      }, EXPORT_TIMEOUT_MS);
    } catch (error) {
      throw classifyExporterError(error);
    }
    if (catalog.sessionScoped) {
      const cadenceEnvironment = parseEnvironmentDump(environmentDump);
      const dependencyLibraries = catalog.cdsLib
        ? parseCdsLibraries(catalog.cdsLib, { environment: cadenceEnvironment })
        : new Map();
      dependencyLibraries.set(catalog.selectedLibrary.name, catalog.selectedLibrary.path);
      catalog.libraries = dependencyLibraries;
    }
    try {
      validateRawDirectory(rawDirectory, tsvName);
    } catch (error) {
      throw codedError(500, 'E4002', error.message, { phase: 'oa-export-validation' });
    }
    const converterArgs = [
      join(root, 'tools', 'convert_layout_tsv.py'),
      '--input-dir', rawDirectory,
      '--output-dir', stageDirectory,
      '--manifest', join(stageDirectory, 'manifest.json'),
      '--manifest-mode', 'replace',
      '--no-manifest-lock',
      '--expect-library', layout.library,
      '--expect-cell', layout.cell,
      '--expect-view', layout.view,
      '--max-input-files', '1',
      '--max-input-bytes', String(RAW_MAX_BYTES),
      '--max-records', String(catalog.exportPolicy.recordLimit + 16),
      '--max-shapes', String(catalog.exportPolicy.shapeLimit),
      '--max-instances', String(catalog.exportPolicy.instanceLimit),
      '--max-pins', String(catalog.exportPolicy.pinLimit),
      '--max-connections', String(catalog.exportPolicy.connectionLimit),
    ];
    if (catalog.pdkProfiles?.profile) {
      converterArgs.push('--pdk-profile', catalog.pdkProfiles.profile);
    }
    for (const directory of catalog.pdkProfiles?.directories || []) {
      converterArgs.push('--pdk-profile-dir', directory);
    }
    try {
      await runBuffered(pythonExecutable, converterArgs, {
        cwd: root,
        ...identityOptions,
        env: cleanEnvironment(account, false),
      }, CONVERTER_TIMEOUT_MS);
    } catch (error) {
      throw classifyConverterError(error);
    }
    let stage;
    try {
      sealTemporaryRoot(temporaryRoot);
      sealRootStage(stageDirectory);
      stage = validateStage(stageDirectory, identity);
    } catch (error) {
      throw codedError(500, 'E4002', error.message, { phase: 'conversion-validation' });
    }
    try {
      return mergeAndPublish(catalog, identity, stage);
    } catch (error) {
      const code = error?.code === 'ENOSPC' ? 'E7005' : 'E4005';
      throw codedError(500, code, error.message, { phase: 'cache-publish' });
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function handleApi(req, res, pathname) {
  if (!pathname.startsWith('/api/')) return false;
  if (!isLoopback(req.socket.remoteAddress)) {
    sendApiError(res, 403, new Error('The OA loader is available only from the local machine'), 'E2022');
    return true;
  }
  if (!sameOriginRequest(req)) {
    sendApiError(res, 403, new Error('Cross-origin OA requests are not allowed'), 'E2022');
    return true;
  }
  if (pathname === '/api/guides/pin-annotation' && req.method === 'GET') {
    try {
      const bytes = regularFileBuffer(join(root, 'docs/PIN_ANNOTATION.md'), 1024 * 1024, 'public pin annotation guide');
      send(res, 200, bytes, { 'cache-control': 'no-cache' });
    } catch (error) { sendApiError(res, 500, error, 'E4002'); }
    return true;
  }
  if (pathname === '/api/examples/physical-trace' && req.method === 'GET') {
    try {
      const bytes = regularFileBuffer(join(root, 'examples/physical-trace-demo.json'), JSON_MAX_BYTES, 'public physical trace example');
      sendJson(res, 200, parseJsonBuffer(bytes, 'public physical trace example'));
    } catch (error) { sendApiError(res, 500, error, 'E4002'); }
    return true;
  }
  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, {
      apiVersion: 3,
      status: shutdownState ? 'stopping' : 'ok',
      mode: opts.nativePrivate ? 'native-private' : 'web',
      host: opts.host,
      port: listeningPort,
      oaEnabled: opts.enableOa,
      streamImportAvailable: Boolean(pythonExecutable),
      physicalTraceAvailable: Boolean(pythonExecutable),
      active: {
        oaExport: activeExportKey || null,
        streamImport: activeStreamImport || null,
        operations: [...operations.values()].filter((operation) => (
          operation.state === 'running' || operation.state === 'cancelling'
        )).length,
      },
    });
    return true;
  }
  const operationMatch = pathname.match(/^\/api\/operations\/([a-f0-9]{40})$/);
  if (operationMatch && req.method === 'GET') {
    pruneOperations();
    const operation = operations.get(operationMatch[1]);
    if (!operation) {
      sendApiError(res, 404, new Error('Operation was not found or has expired'), 'E9003');
      return true;
    }
    sendJson(res, 200, publicOperation(operation));
    return true;
  }
  if (operationMatch && req.method === 'DELETE') {
    pruneOperations();
    const operation = operations.get(operationMatch[1]);
    if (!operation) {
      sendApiError(res, 404, new Error('Operation was not found or has expired'), 'E9003');
      return true;
    }
    if (cancelOperation(operation)) {
      sendJson(res, 202, publicOperation(operation));
    } else {
      operations.delete(operation.id);
      sendEmpty(res, 204);
    }
    return true;
  }
  if (pathname === '/api/traces' && req.method === 'POST') {
    try {
      const body = traceService.normalize(await readJsonBody(req, TRACE_REQUEST_MAX_BYTES));
      const operation = createOperation('physical-trace', (record) => traceService.run(body, record));
      sendJson(res, 202, publicOperation(operation), { location: `/api/operations/${operation.id}` });
    } catch (error) {
      sendApiError(res, error.status || 500, error, 'E4004');
    }
    return true;
  }
  if (pathname === '/api/streams/import' && req.method === 'POST') {
    try {
      const body = normalizeStreamImportBody(await readJsonBody(req, STREAM_REQUEST_MAX_BYTES));
      const asynchronous = String(req.headers.prefer || '')
        .split(',').some((preference) => (
          preference.trim().toLowerCase().split(';')[0] === 'respond-async'
        ));
      if (asynchronous) {
        const operation = createOperation('stream-import', (record) => importStreamLayout(body, record));
        sendJson(res, 202, publicOperation(operation), {
          location: `/api/operations/${operation.id}`,
          'preference-applied': 'respond-async',
        });
      } else {
        sendJson(res, 201, await importStreamLayout(body));
      }
    } catch (error) {
      sendApiError(res, error.status || 500, error, 'E6004');
    }
    return true;
  }
  if (pathname === '/api/libraries/state' && req.method === 'GET') {
    const picker = discoverPickerEnvironment();
    sendJson(res, 200, {
      apiVersion: 2,
      oaEnabled: opts.enableOa,
      activeExportKey,
      runtime: {
        dataRoot,
        stateRoot,
        strictSymlinks,
        exportPolicy,
      },
      picker: picker.available
        ? { available: true, provider: picker.provider, display: picker.display }
        : { available: false, reason: picker.reason },
    });
    return true;
  }
  if (pathname === '/api/libraries/pick' && req.method === 'POST') {
    if (!opts.enableOa) {
      sendApiError(res, 503, new Error('OA loading is disabled; start the server with --enable-oa'), 'E3001');
      return true;
    }
    try {
      const body = await readJsonBody(req, 1024);
      const mode = String(body.mode || 'directory');
      if (!['directory', 'cdsLib'].includes(mode)) {
        throw codedError(400, 'E9003', 'mode must be directory or cdsLib');
      }
      sendJson(res, 200, await runNativePicker(mode));
    } catch (error) {
      sendApiError(res, error.status || 500, error, 'E2019');
    }
    return true;
  }
  if (pathname === '/api/library-sessions' && req.method === 'POST') {
    if (!opts.enableOa) {
      sendApiError(res, 503, new Error('OA loading is disabled; start the server with --enable-oa'), 'E3001');
      return true;
    }
    try {
      const body = await readJsonBody(req, 16 * 1024);
      const cadenceEnv = resolveSessionCadenceEnvironment(root, body);
      const environment = await captureCadenceEnvironment(cadenceEnv);
      const pdkProfiles = configuredPdkProfiles(root, startupConfig, environment, body.overrides);
      let sessionExportPolicy;
      try {
        sessionExportPolicy = resolveOaExportPolicy(startupConfig, environment, body.overrides);
      } catch (error) {
        throw codedError(400, 'E2015', error.message);
      }
      sendJson(res, 201, librarySessions.create(body, {
        cadenceEnv,
        environment,
        pdkProfiles,
        exportPolicy: sessionExportPolicy,
      }));
    } catch (error) {
      sendApiError(res, error.status || 500, error, 'E3002');
    }
    return true;
  }
  const librarySessionMatch = pathname.match(/^\/api\/library-sessions\/([a-f0-9]{48})$/);
  if (librarySessionMatch && req.method === 'GET') {
    try {
      sendJson(res, 200, librarySessions.describe(librarySessionMatch[1]));
    } catch (error) {
      sendApiError(res, error.status || 500, error, 'E2023');
    }
    return true;
  }
  if (librarySessionMatch && req.method === 'DELETE') {
    librarySessions.prune();
    if (!librarySessions.sessions.delete(librarySessionMatch[1])) {
      sendApiError(res, 404, new Error('Library session expired or was not found'), 'E2023');
      return true;
    }
    sendEmpty(res, 204);
    return true;
  }
  if (pathname === '/api/layouts/catalog' && req.method === 'GET') {
    sendJson(res, 200, publicCatalog(await currentCatalog()));
    return true;
  }
  if (pathname === '/api/layouts/prepare' && req.method === 'POST') {
    if (!opts.enableOa) {
      sendApiError(res, 503, new Error('OA loading is disabled; start the server with --enable-oa'), 'E3001');
      return true;
    }
    try {
      const body = await readJsonBody(req);
      const library = String(body.library || '');
      const cell = String(body.cell || '');
      const view = String(body.view || 'layout');
      const sessionId = String(body.sessionId || '');
      if (![library, cell, view].every(validOaName)) {
        throw codedError(400, 'E3010', 'Invalid OA identity');
      }
      const key = layoutKey(library, cell, view);
      let librarySession = sessionId ? librarySessions.get(sessionId) : null;
      let catalog = librarySession ? librarySessions.catalog(librarySession) : await currentCatalog();
      let layout = catalog.layouts.find((candidate) => (
        candidate.key === key && candidate.sourceType === 'oa'
      ));
      if (!layout) {
        throw codedError(404, 'E2017', `OA layout is not registered in cds.lib: ${key}`);
      }
      validateSessionLayoutSource(catalog, layout);
      if (layout.cacheState === 'ready' && body.refresh !== true) {
        sendJson(res, 200, { cached: true, entry: layout.entry });
        return true;
      }
      if (!catalog.cadenceEnv) {
        throw codedError(503, 'E3002', 'No readable Cadence environment is configured');
      }
      if (activeExportKey) {
        throw codedError(409, 'E7004', `Another layout is being prepared: ${activeExportKey}`);
      }
      activeExportKey = key;
      const startedAt = Date.now();
      try {
        const result = await withManifestLock(async () => {
          librarySession = sessionId ? librarySessions.get(sessionId) : null;
          catalog = librarySession ? librarySessions.catalog(librarySession) : await currentCatalog();
          layout = catalog.layouts.find((candidate) => (
            candidate.key === key && candidate.sourceType === 'oa'
          ));
          if (!layout) throw codedError(404, 'E3009', `OA layout disappeared: ${key}`);
          validateSessionLayoutSource(catalog, layout);
          if (layout.cacheState === 'ready' && body.refresh !== true) {
            return { cached: true, entry: layout.entry };
          }
          return { cached: false, entry: await exportOaLayout(catalog, layout) };
        });
        sendJson(res, 200, { ...result, elapsedMs: Date.now() - startedAt });
      } finally {
        activeExportKey = '';
      }
    } catch (error) {
      sendApiError(res, error.status || 500, error, 'E9001');
    }
    return true;
  }
  sendApiError(res, 404, new Error('Unknown API endpoint'), 'E9003');
  return true;
}

async function handleStatic(req, res, pathname, search) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method not allowed', { allow: 'GET, HEAD' });
    return;
  }
  if (pathname.includes('\0')) {
    send(res, 400, 'Bad request');
    return;
  }
  if (pathname === '/') {
    redirect(res, `/public/${search}`);
    return;
  }
  if (pathname === '/public') {
    redirect(res, `/public/${search}`);
    return;
  }
  const dataRoute = pathname === '/public/data' || pathname.startsWith('/public/data/');
  const boundary = dataRoute ? dataRoot : root;
  const relativePath = dataRoute
    ? pathname.replace(/^\/public\/data\/?/, '')
    : pathname.replace(/^\/+/, '');
  let filePath = resolve(boundary, relativePath);
  if (!isWithin(boundary, filePath)) {
    send(res, 403, 'Forbidden');
    return;
  }
  try {
    let metadata = statSync(filePath);
    if (metadata.isDirectory()) {
      filePath = join(filePath, 'index.html');
      metadata = statSync(filePath);
    }
    filePath = realpathSync(filePath);
    if (!isWithin(boundary, filePath) || !isAllowedPublicFile(filePath)) {
      send(res, 403, 'Forbidden');
      return;
    }
    metadata = statSync(filePath);
    if (!metadata.isFile()) {
      send(res, 404, 'Not found');
      return;
    }
    const extension = extname(filePath).toLowerCase();
    const canUseGzip = compressible.has(extension) && acceptsGzip(req.headers['accept-encoding']);
    let servedPath = filePath;
    let servedMetadata = metadata;
    let contentEncoding = null;
    if (canUseGzip) {
      try {
        const gzipPath = `${filePath}.gz`;
        const gzipMetadata = statSync(gzipPath);
        const realGzipPath = realpathSync(gzipPath);
        if (gzipMetadata.isFile() && gzipMetadata.mtimeMs >= metadata.mtimeMs
            && isAllowedPublicFile(realGzipPath)) {
          servedPath = realGzipPath;
          servedMetadata = gzipMetadata;
          contentEncoding = 'gzip';
        }
      } catch {
        // Precompressed sidecars are optional.
      }
    }
    const etag = weakEtag(servedMetadata);
    const headers = securityHeaders({
      'content-type': types.get(extension) || 'application/octet-stream',
      'content-length': servedMetadata.size,
      'cache-control': cacheControl(pathname),
      etag,
      'last-modified': servedMetadata.mtime.toUTCString(),
      vary: 'Accept-Encoding',
    });
    if (contentEncoding) headers['content-encoding'] = contentEncoding;
    if (!pathname.endsWith('/public/data/manifest.json') && req.headers['if-none-match'] === etag) {
      delete headers['content-length'];
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(servedPath);
    stream.on('error', (error) => res.destroy(error));
    stream.pipe(res);
  } catch {
    send(res, 404, 'Not found');
  }
}

try {
  await initializeNativeControl();
} catch (error) {
  process.stderr.write(`${JSON.stringify(errorPayload(error, 'E8009'))}\n`);
  process.exit(1);
}

if (parentPipeEnded) process.exit(0);

ensureInitialManifest();

server = createServer(async (req, res) => {
  if (!validHostRequest(req)) {
    send(res, 421, 'Invalid Host header');
    return;
  }
  if (!validFetchSite(req)) {
    send(res, 403, 'Cross-site requests are not allowed');
    return;
  }
  let url;
  let pathname;
  try {
    url = new URL(req.url || '/', `http://127.0.0.1:${listeningPort || opts.port || 80}`);
    pathname = decodeURIComponent(url.pathname);
  } catch {
    send(res, 400, 'Bad request');
    return;
  }
  if (privateRoute(pathname) && !validBearerRequest(req)) {
    sendJson(res, 401, errorPayload(new Error('Native backend bearer authentication failed'), 'E8009'), {
      'www-authenticate': 'Bearer realm="VL3D native backend"',
    });
    return;
  }
  try {
    if (await handleApi(req, res, pathname)) return;
    await handleStatic(req, res, pathname, url.search);
  } catch (error) {
    sendApiError(res, error.status || 500, error, 'E9001');
  }
});

function beginShutdown(signal) {
  const code = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 0;
  if (shutdownState) {
    for (const pid of activeProcessGroups) signalProcessGroup(pid, 'SIGKILL');
    process.exit(code);
  }
  shutdownState = { code, serverClosed: false, timer: null };
  if (serverListening) {
    server.close(() => {
      serverListening = false;
      shutdownState.serverClosed = true;
      finishShutdownIfReady();
    });
    server.closeIdleConnections?.();
  } else {
    shutdownState.serverClosed = true;
  }
  for (const pid of activeProcessGroups) signalProcessGroup(pid, 'SIGTERM');
  shutdownState.timer = setTimeout(() => {
    for (const pid of activeProcessGroups) signalProcessGroup(pid, 'SIGKILL');
    process.exit(code);
  }, 3000);
  finishShutdownIfReady();
}

process.on('SIGINT', () => beginShutdown('SIGINT'));
process.on('SIGTERM', () => beginShutdown('SIGTERM'));

server.listen(opts.port, opts.host, () => {
  const address = server.address();
  listeningPort = typeof address === 'object' && address ? address.port : opts.port;
  updateAcceptedHosts(listeningPort);
  serverListening = true;
  const displayHost = opts.host.includes(':') ? `[${opts.host}]` : opts.host;
  console.log(`VL3D_READY ${JSON.stringify({
    host: opts.host,
    port: listeningPort,
    ...(opts.nativePrivate ? { advancedSettings: startupAdvancedSettings } : {}),
  })}`);
  console.log(`Serving ${root} at http://${displayHost}:${listeningPort} (OA ${opts.enableOa ? 'enabled' : 'disabled'})`);
  if (parentPipeEnded) beginShutdown('PARENT_EOF');
});
