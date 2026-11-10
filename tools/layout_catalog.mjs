import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { gzipSync } from 'node:zlib';
import { resolveRuntimePaths } from './runtime_paths.mjs';

const SAFE_OA_NAME = /^[A-Za-z0-9_.$:+-]+$/;
const SAFE_OA_DATA_FILE = /^[A-Za-z0-9_.$:+-]+\.oa$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const OA_MASTER_TAG_MAX_BYTES = 64 * 1024;
export const DEFAULT_OA_LAYOUT_VIEWS = Object.freeze([
  'layout',
  'maskLayout',
  'chip',
  'cLayout',
  'dLayout',
  'ivpcell',
]);
const DEFAULT_CDS_PARSE_LIMITS = Object.freeze({
  maxDepth: 16,
  maxFiles: 128,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxLibraries: 4096,
});

export const OA_EXPORT_POLICY = Object.freeze({
  maxDepth: 8,
  shapeLimit: 200000,
  instanceLimit: 200000,
  pinLimit: 200000,
  connectionLimit: 400000,
  recordLimit: 1000000,
});

const OA_POLICY_LIMITS = Object.freeze({
  maxDepth: [1, 64],
  shapeLimit: [1000, 2000000],
  instanceLimit: [1000, 2000000],
  pinLimit: [1000, 2000000],
  connectionLimit: [1000, 4000000],
  recordLimit: [10000, 8000000],
});

const OA_POLICY_ENV = Object.freeze({
  maxDepth: 'VL3D_MAX_DEPTH',
  shapeLimit: 'VL3D_SHAPE_LIMIT',
  instanceLimit: 'VL3D_INSTANCE_LIMIT',
  pinLimit: 'VL3D_PIN_LIMIT',
  connectionLimit: 'VL3D_CONNECTION_LIMIT',
  recordLimit: 'VL3D_RECORD_LIMIT',
});

export const OA_RESOURCE_PRESETS = Object.freeze({
  low: Object.freeze({
    maxDepth: 6,
    shapeLimit: 100000,
    instanceLimit: 100000,
    pinLimit: 100000,
    connectionLimit: 200000,
    recordLimit: 500000,
  }),
  balanced: OA_EXPORT_POLICY,
  large: Object.freeze({
    maxDepth: 16,
    shapeLimit: 1000000,
    instanceLimit: 1000000,
    pinLimit: 1000000,
    connectionLimit: 2000000,
    recordLimit: 4000000,
  }),
});

export function resolveOaExportPolicy(config = {}, environment = process.env, overrides = {}) {
  const resourceMode = String(
    overrides.resourceMode || environment.VL3D_RESOURCE_MODE || config.resourceMode || 'balanced',
  ).toLowerCase();
  if (!Object.hasOwn(OA_RESOURCE_PRESETS, resourceMode)) {
    throw new Error('resourceMode must be low, balanced, or large');
  }
  const preset = OA_RESOURCE_PRESETS[resourceMode];
  const configured = config.oaExportPolicy && typeof config.oaExportPolicy === 'object'
    ? config.oaExportPolicy
    : {};
  const policy = {};
  for (const [name, [minimum, maximum]] of Object.entries(OA_POLICY_LIMITS)) {
    const raw = overrides[name] ?? environment[OA_POLICY_ENV[name]] ?? configured[name]
      ?? preset[name];
    const value = Number(raw);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
    }
    policy[name] = value;
  }
  Object.defineProperty(policy, 'resourceMode', { value: resourceMode, enumerable: true });
  return Object.freeze(policy);
}

export function expandPath(value, baseDirectory, environment = process.env) {
  let expanded = String(value || '').trim().replace(/^(["'])(.*)\1$/, '$2');
  expanded = expanded.replace(/^~(?=\/|$)/, environment.HOME || process.env.HOME || '');
  expanded = expanded.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced, plain) => (
    environment[braced || plain] || ''
  ));
  return resolve(isAbsolute(expanded) ? expanded : join(baseDirectory, expanded));
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export function layoutKey(library, cell, view = 'layout') {
  return `${library}/${cell}/${view}`;
}

export function validOaName(value) {
  return SAFE_OA_NAME.test(String(value || ''));
}

function pathIsWithin(base, candidate) {
  const rel = relative(base, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`));
}

function realEntry(path, type, boundary, requireRealEntries) {
  try {
    const entryMetadata = lstatSync(path);
    if (requireRealEntries && entryMetadata.isSymbolicLink()) return null;
    const canonical = realpathSync(path);
    if (!pathIsWithin(boundary, canonical)) return null;
    const metadata = statSync(canonical);
    if (type === 'file' ? !metadata.isFile() : !metadata.isDirectory()) return null;
    return { path: canonical, metadata };
  } catch {
    return null;
  }
}

function masterTagTarget(masterTagPath) {
  let contents;
  try {
    const metadata = statSync(masterTagPath);
    if (!metadata.isFile() || metadata.size > OA_MASTER_TAG_MAX_BYTES) {
      return { invalid: true, name: null };
    }
    contents = readFileSync(masterTagPath, 'utf8');
  } catch {
    return { invalid: true, name: null };
  }
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('--')) continue;
    return { invalid: !SAFE_OA_DATA_FILE.test(line), name: line };
  }
  return { invalid: false, name: null };
}

export function resolveOaViewSource(libraryPath, cell, view, options = {}) {
  if (![cell, view].every(validOaName)) return null;
  const requireRealEntries = options.requireRealEntries === true;
  let canonicalLibrary;
  try {
    canonicalLibrary = realpathSync(libraryPath);
    if (!statSync(canonicalLibrary).isDirectory()) return null;
  } catch {
    return null;
  }
  const cellEntry = realEntry(join(canonicalLibrary, cell), 'directory', canonicalLibrary, requireRealEntries);
  if (!cellEntry) return null;
  const viewEntry = realEntry(
    join(cellEntry.path, view), 'directory', canonicalLibrary, requireRealEntries,
  );
  if (!viewEntry) return null;

  const masterTagCandidate = join(viewEntry.path, 'master.tag');
  let masterTagExists = false;
  try {
    lstatSync(masterTagCandidate);
    masterTagExists = true;
  } catch {
  }
  const masterTagEntry = masterTagExists
    ? realEntry(masterTagCandidate, 'file', canonicalLibrary, requireRealEntries)
    : null;
  if (masterTagExists && !masterTagEntry) return null;
  const tagTarget = masterTagEntry ? masterTagTarget(masterTagEntry.path) : null;
  if (tagTarget?.invalid) return null;
  const taggedName = tagTarget?.name || null;
  const candidateNames = taggedName
    ? [taggedName]
    : [...new Set(['layout.oa', `${view}.oa`])];
  for (const name of candidateNames) {
    const sourceEntry = realEntry(
      join(viewEntry.path, name), 'file', canonicalLibrary, requireRealEntries,
    );
    if (!sourceEntry) continue;
    return {
      libraryPath: canonicalLibrary,
      cellPath: cellEntry.path,
      viewPath: viewEntry.path,
      oaPath: sourceEntry.path,
      oaMetadata: sourceEntry.metadata,
      masterTagPath: taggedName ? masterTagEntry.path : null,
      masterTagMetadata: taggedName ? masterTagEntry.metadata : null,
    };
  }
  return null;
}

export function loadProjectConfig(root, environment = process.env) {
  const runtime = resolveRuntimePaths(root, environment);
  const candidates = [runtime.projectConfigFile, runtime.configFile]
    .filter((path, index, paths) => path && paths.indexOf(path) === index);
  let config = {};
  const loadedPaths = [];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const metadata = statSync(path);
    if (!metadata.isFile() || metadata.size > 1024 * 1024) {
      throw new Error(`VL3D configuration must be a regular JSON file below 1 MiB: ${path}`);
    }
    let loaded;
    try {
      loaded = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new Error(`Cannot parse VL3D configuration ${path}: ${error.message}`);
    }
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
      throw new Error(`VL3D configuration must contain a JSON object: ${path}`);
    }
    config = { ...config, ...loaded };
    loadedPaths.push(path);
  }
  return {
    path: loadedPaths.at(-1) || runtime.configFile,
    paths: loadedPaths,
    config,
  };
}

export function resolveCdsLib(root, config = {}, override = null, environment = process.env) {
  const candidate = override || environment.VL3D_CDS_LIB || config.cdsLib || join(root, 'cds.lib');
  const path = expandPath(candidate, root, environment);
  return existsSync(path) ? realpathSync(path) : path;
}

export function parseCdsLibraryDetails(entryPath, options = {}) {
  const environment = options.environment || process.env;
  const limits = { ...DEFAULT_CDS_PARSE_LIMITS, ...(options.limits || {}) };
  const libraries = new Map();
  const directLibraries = new Map();
  const visited = new Set();
  const warnings = [];
  let totalBytes = 0;

  function visit(path, depth) {
    if (depth > limits.maxDepth) {
      warnings.push({ code: 'VL3D-E4004', message: `Skipped cds.lib include beyond depth ${limits.maxDepth}` });
      return;
    }
    if (!existsSync(path)) return;
    let canonical;
    try {
      canonical = realpathSync(path);
    } catch {
      return;
    }
    if (visited.has(canonical)) return;
    if (visited.size >= limits.maxFiles) throw new Error(`cds.lib include count exceeds ${limits.maxFiles}`);
    const metadata = statSync(canonical);
    if (!metadata.isFile()) throw new Error(`cds.lib include is not a regular file: ${canonical}`);
    if (metadata.size > limits.maxFileBytes) throw new Error(`cds.lib file exceeds ${limits.maxFileBytes} bytes: ${canonical}`);
    totalBytes += metadata.size;
    if (totalBytes > limits.maxTotalBytes) throw new Error(`cds.lib total input exceeds ${limits.maxTotalBytes} bytes`);
    visited.add(canonical);
    const baseDirectory = dirname(canonical);
    const lines = readFileSync(canonical, 'utf8').split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.replace(/\s*[#;].*$/, '').trim();
      if (!line) continue;
      const include = line.match(/^(?:SOFT)?INCLUDE\s+(.+)$/i);
      if (include) {
        visit(expandPath(include[1], baseDirectory, environment), depth + 1);
        continue;
      }
      const define = line.match(/^DEFINE\s+(\S+)\s+(.+)$/i);
      if (!define) continue;
      const library = define[1];
      const libraryPath = expandPath(define[2], baseDirectory, environment);
      if (!validOaName(library) || !existsSync(libraryPath)) continue;
      let canonicalLibraryPath;
      try {
        canonicalLibraryPath = realpathSync(libraryPath);
        if (!statSync(canonicalLibraryPath).isDirectory()) continue;
      } catch {
        continue;
      }
      libraries.set(library, canonicalLibraryPath);
      if (depth === 0) directLibraries.set(library, canonicalLibraryPath);
      if (libraries.size > limits.maxLibraries) {
        throw new Error(`cds.lib library count exceeds ${limits.maxLibraries}`);
      }
    }
  }

  visit(entryPath, 0);
  return { libraries, directLibraries, files: [...visited], warnings };
}

export function parseCdsLibraries(entryPath, options = {}) {
  return parseCdsLibraryDetails(entryPath, options).libraries;
}

export function configuredViews(config) {
  const views = Array.isArray(config.views) ? config.views : DEFAULT_OA_LAYOUT_VIEWS;
  return new Set(views.filter(validOaName));
}

function configuredPathList(value) {
  if (Array.isArray(value)) return value;
  return String(value || '').split(delimiter).filter(Boolean);
}

export function configuredPdkProfiles(
  root, config = {}, environment = process.env, overrides = {},
) {
  const profileValue = overrides.pdkProfile ?? environment.VL3D_PDK_PROFILE
    ?? config.pdkProfile ?? null;
  const directoryValues = overrides.pdkProfileDirs ?? [
    ...configuredPathList(environment.VL3D_PDK_PROFILE_DIRS),
    ...configuredPathList(environment.VL3D_PDK_PROFILE_DIR),
    ...configuredPathList(config.pdkProfileDirs),
    ...configuredPathList(config.pdkProfileDir),
  ];
  if (!Array.isArray(directoryValues) || directoryValues.length > 32) {
    throw new Error('pdkProfileDirs must contain at most 32 paths');
  }
  return {
    profile: profileValue ? expandPath(profileValue, root, environment) : null,
    directories: [...new Set(directoryValues.filter(Boolean).map((value) => (
      expandPath(value, root, environment)
    )))],
  };
}

function isTimestampBackupCell(cell) {
  return /^.+\.bak-\d{8}(?:-\d{6})?$/.test(cell);
}

function compareLayoutChoices(first, second) {
  return Number(Boolean(first.isBackup)) - Number(Boolean(second.isBackup))
    || first.key.localeCompare(second.key);
}

export function discoverOaLayouts(libraries, config = {}) {
  const allowedViews = configuredViews(config);
  const layouts = [];
  for (const [library, libraryPath] of libraries) {
    let cellEntries = [];
    try {
      cellEntries = readdirSync(libraryPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const cellEntry of cellEntries) {
      if ((!cellEntry.isDirectory() && !cellEntry.isSymbolicLink())
          || !validOaName(cellEntry.name)) continue;
      for (const view of allowedViews) {
        if (!resolveOaViewSource(libraryPath, cellEntry.name, view)) continue;
        layouts.push({
          key: layoutKey(library, cellEntry.name, view),
          library,
          cell: cellEntry.name,
          view,
          isBackup: isTimestampBackupCell(cellEntry.name),
        });
      }
    }
  }
  return layouts.sort(compareLayoutChoices);
}

export function discoverOaLayoutsForLibrary(library, libraryPath, config = {}, options = {}) {
  const layouts = discoverOaLayouts(new Map([[library, libraryPath]]), config);
  if (options.requireRealEntries !== true) return layouts;
  return layouts.filter((layout) => resolveOaViewSource(
    libraryPath, layout.cell, layout.view, { requireRealEntries: true },
  ));
}

function manifestPath(root, dataRoot = null) {
  return dataRoot ? join(dataRoot, 'manifest.json') : join(root, 'public', 'data', 'manifest.json');
}

function cachedFilePath(root, entryPath, dataRoot = null) {
  if (!dataRoot) return join(root, 'public', entryPath);
  const relativePath = String(entryPath || '').replace(/^data\//, '');
  if (!relativePath || relativePath.startsWith('/') || relativePath.split('/').includes('..')) return null;
  return join(dataRoot, relativePath);
}

export function readManifest(root, dataRoot = null) {
  return readJson(manifestPath(root, dataRoot), {
    schemaVersion: 2,
    generatedAt: new Date(0).toISOString(),
    cells: [],
  });
}

export function sourceFingerprint(sourceViews, libraries) {
  if (!Array.isArray(sourceViews) || !sourceViews.length) return null;
  if (libraries.size > DEFAULT_CDS_PARSE_LIMITS.maxLibraries) return null;
  const records = [];
  const seen = new Set();
  const sourceLibraries = new Set();
  for (const source of sourceViews) {
    if (!source || ![source.library, source.cell, source.view].every(validOaName)) return null;
    const key = layoutKey(source.library, source.cell, source.view);
    if (seen.has(key)) continue;
    seen.add(key);
    const libraryPath = libraries.get(source.library);
    if (!libraryPath) return null;
    sourceLibraries.add(libraryPath);
    const resolvedSource = resolveOaViewSource(libraryPath, source.cell, source.view);
    if (!resolvedSource) return null;
    const sourceRecord = [
      key,
      relative(resolvedSource.libraryPath, resolvedSource.oaPath),
      resolvedSource.oaMetadata.size,
      Math.trunc(resolvedSource.oaMetadata.mtimeMs),
    ];
    if (resolvedSource.masterTagPath) {
      sourceRecord.push(
        relative(resolvedSource.libraryPath, resolvedSource.masterTagPath),
        resolvedSource.masterTagMetadata.size,
        Math.trunc(resolvedSource.masterTagMetadata.mtimeMs),
      );
    }
    records.push(sourceRecord.join(':'));
  }
  if (!records.length) return null;
  // OA attachment is stored in data.dm. Technology definitions live in tech.db,
  // but data.dm is binary: use the bounded cds.lib definitions as candidates
  // instead of guessing the attachment from stale printable strings. Inspect
  // only these exact files, never recursively traverse a PDK installation.
  const metadataPaths = new Set([...sourceLibraries].map((path) => join(path, 'data.dm')));
  for (const path of libraries.values()) metadataPaths.add(join(path, 'tech.db'));
  let metadataBytes = 0;
  for (const path of [...metadataPaths].sort()) {
    try {
      const metadata = statSync(path);
      metadataBytes += metadata.size;
      if (!metadata.isFile() || metadata.size > 16 * 1024 * 1024
          || metadataBytes > 64 * 1024 * 1024) return null;
      records.push(['oa-metadata', realpathSync(path), metadata.size,
        createHash('sha256').update(readFileSync(path)).digest('hex')].join(':'));
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return null;
      records.push(`oa-metadata-missing:${path}`);
    }
  }
  return createHash('sha256').update(records.sort().join('\n')).digest('hex');
}

function profileFingerprintPaths(root) {
  const paths = [];
  const pending = ['profiles'];
  while (pending.length) {
    const relativeDirectory = pending.pop();
    let entries = [];
    try {
      entries = readdirSync(join(root, relativeDirectory), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relativePath = join(relativeDirectory, entry.name);
      if (entry.isDirectory()) pending.push(relativePath);
      else if (entry.isFile() && entry.name.endsWith('.json')) paths.push(relativePath);
    }
  }
  return paths.sort();
}

function digestExternalProfiles(digest, pdkProfiles) {
  const candidates = [];
  if (pdkProfiles?.profile) candidates.push(pdkProfiles.profile);
  for (const directory of pdkProfiles?.directories || []) {
    let entries = [];
    try {
      entries = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => join(directory, entry.name))
        .sort();
    } catch {
      digest.update(`missing-profile-directory:${directory}\0`);
      continue;
    }
    if (entries.length > 256) return false;
    let canonicalDirectory;
    try {
      canonicalDirectory = realpathSync(directory);
    } catch {
      digest.update(`missing-profile-directory:${directory}\0`);
      continue;
    }
    digest.update(`profile-directory:${canonicalDirectory}:${entries.length}\0`);
    candidates.push(...entries);
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      const canonical = realpathSync(candidate);
      const metadata = statSync(canonical);
      if (!metadata.isFile() || metadata.size > 1024 * 1024) return false;
      digest.update('external-profile\0').update(canonical).update('\0')
        .update(readFileSync(canonical)).update('\0');
    } catch {
      digest.update(`missing-profile:${candidate}\0`);
    }
  }
  return true;
}

export function pipelineFingerprint(root, policy = OA_EXPORT_POLICY, pdkProfiles = null) {
  const digest = createHash('sha256');
  digest.update(`oa-export-policy:${JSON.stringify(policy)}\0`);
  const pipelinePaths = [
    'tools/oa_dump.il',
    'tools/export_layouts.sh',
    'tools/convert_layout_tsv.py',
    'tools/pdk_profile.py',
    'tools/trace_rules.py',
    'tools/technology_layers.py',
    ...profileFingerprintPaths(root),
  ];
  for (const relativePath of pipelinePaths) {
    const path = join(root, relativePath);
    try {
      digest.update(relativePath).update('\0').update(readFileSync(path)).update('\0');
    } catch {
      if (relativePath === 'tools/pdk_profile.py') continue;
      return null;
    }
  }
  if (!digestExternalProfiles(digest, pdkProfiles)) return null;
  return digest.digest('hex');
}

export function cacheFingerprint(
  root, sourceViews, libraries, policy = OA_EXPORT_POLICY, pdkProfiles = null,
) {
  const oaFingerprint = sourceFingerprint(sourceViews, libraries);
  const exporterFingerprint = pipelineFingerprint(root, policy, pdkProfiles);
  if (!oaFingerprint || !exporterFingerprint) return null;
  return createHash('sha256').update(`${oaFingerprint}:${exporterFingerprint}`).digest('hex');
}

export function cacheState(
  root, entry, libraries, requireOaFingerprint = false, dataRoot = null,
  policy = OA_EXPORT_POLICY, pdkProfiles = null,
) {
  const filePath = entry?.path ? cachedFilePath(root, entry.path, dataRoot) : null;
  if (!filePath || !existsSync(filePath)) return 'missing';
  if (requireOaFingerprint && (
    entry.source?.type !== 'oa'
    || !SHA256_HEX.test(String(entry.source?.fingerprint || ''))
    || !Array.isArray(entry.sourceViews)
    || !entry.sourceViews.length
  )) return 'stale';
  if (entry.source?.type !== 'oa') return 'ready';
  if (!SHA256_HEX.test(String(entry.source?.fingerprint || ''))) return 'stale';
  const current = cacheFingerprint(root, entry.sourceViews, libraries, policy, pdkProfiles);
  if (!current) return 'stale';
  return current === entry.source.fingerprint ? 'ready' : 'stale';
}

function writeExclusive(path, data) {
  let fileDescriptor;
  try {
    fileDescriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    let offset = 0;
    while (offset < data.length) offset += writeSync(fileDescriptor, data, offset, data.length - offset);
    fsyncSync(fileDescriptor);
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
  }
}

export function writeManifest(root, manifest, dataRoot = null) {
  const path = manifestPath(root, dataRoot);
  const encoded = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const token = randomBytes(12).toString('hex');
  const temporary = `${path}.tmp-${token}`;
  const temporaryGzip = `${path}.gz.tmp-${token}`;
  try {
    writeExclusive(temporary, encoded);
    writeExclusive(temporaryGzip, gzipSync(encoded, { level: 6 }));
    renameSync(temporaryGzip, `${path}.gz`);
    renameSync(temporary, path);
    const directory = openSync(dirname(path), constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    for (const candidate of [temporary, temporaryGzip]) {
      try {
        unlinkSync(candidate);
      } catch {
        // A successful rename removes the temporary name.
      }
    }
  }
}

export function decorateOaCacheEntry(
  root, libraries, inputEntry, library, cell, view, policy = OA_EXPORT_POLICY,
  pdkProfiles = null,
) {
  const key = layoutKey(library, cell, view);
  if (!inputEntry || layoutKey(inputEntry.library, inputEntry.cell, inputEntry.view) !== key) {
    throw new Error(`Exporter did not produce ${key}`);
  }
  const entry = JSON.parse(JSON.stringify(inputEntry));
  const sourceViews = Array.isArray(entry.sourceViews) && entry.sourceViews.length
    ? entry.sourceViews
    : [{ library, cell, view }];
  const oaFingerprint = sourceFingerprint(sourceViews, libraries);
  const exporterFingerprint = pipelineFingerprint(root, policy, pdkProfiles);
  const fingerprint = cacheFingerprint(root, sourceViews, libraries, policy, pdkProfiles);
  if (!fingerprint) throw new Error(`Cannot fingerprint OA sources for ${key}`);
  entry.sourceViews = sourceViews;
  entry.source = {
    type: 'oa',
    fingerprint,
    oaFingerprint,
    exporterFingerprint,
    generatedAt: new Date().toISOString(),
  };
  return entry;
}

export function resolveCadenceEnvironment(
  root, config = {}, override = null, environment = process.env,
) {
  const candidates = [
    override,
    environment.VL3D_CADENCE_ENV,
    config.cadenceEnv,
    ...(Array.isArray(config.cadenceEnvCandidates) ? config.cadenceEnvCandidates : []),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const path = expandPath(candidate, root, environment);
    try {
      if (statSync(path).isFile()) return path;
    } catch {
      // Continue to the next portable/local candidate.
    }
  }
  return null;
}

export function buildCatalog(root, overrides = {}, options = {}) {
  const environment = overrides.environment || process.env;
  const { config } = loadProjectConfig(root, environment);
  const effectiveConfig = {
    ...config,
    ...(Array.isArray(overrides.views) ? { views: overrides.views } : {}),
  };
  const exportPolicy = options.exportPolicy || resolveOaExportPolicy(
    effectiveConfig, environment, overrides.oaExportPolicy,
  );
  const pdkProfiles = configuredPdkProfiles(root, effectiveConfig, environment, overrides);
  const cdsLib = resolveCdsLib(root, effectiveConfig, overrides.cdsLib, environment);
  const libraries = parseCdsLibraries(cdsLib, { environment });
  const discovered = discoverOaLayouts(libraries, effectiveConfig);
  const manifest = readManifest(root, options.dataRoot);
  const cachedByKey = new Map((manifest.cells || []).map((entry) => [
    layoutKey(entry.library, entry.cell, entry.view),
    entry,
  ]));
  const catalogByKey = new Map();
  for (const layout of discovered) {
    const cached = cachedByKey.get(layout.key) || null;
    catalogByKey.set(layout.key, {
      ...layout,
      cacheState: cached
        ? cacheState(
          root, cached, libraries, true, options.dataRoot, exportPolicy, pdkProfiles,
        )
        : 'missing',
      entry: cached,
      sourceType: 'oa',
    });
  }
  for (const [key, entry] of cachedByKey) {
    if (catalogByKey.has(key)) continue;
    catalogByKey.set(key, {
      key,
      library: entry.library,
      cell: entry.cell,
      view: entry.view,
      isBackup: isTimestampBackupCell(entry.cell),
      cacheState: cacheState(
        root, entry, libraries, false, options.dataRoot, exportPolicy, pdkProfiles,
      ),
      entry,
      sourceType: entry.source?.type || 'cache',
    });
  }
  return {
    config: effectiveConfig,
    cdsLib,
    libraries,
    manifest,
    exportPolicy,
    pdkProfiles,
    cadenceEnv: resolveCadenceEnvironment(
      root, effectiveConfig, overrides.cadenceEnv, environment,
    ),
    layouts: [...catalogByKey.values()].sort(compareLayoutChoices),
  };
}
