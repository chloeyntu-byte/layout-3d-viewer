import { randomBytes } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  DEFAULT_OA_LAYOUT_VIEWS,
  OA_EXPORT_POLICY,
  cacheState,
  discoverOaLayoutsForLibrary,
  layoutKey,
  loadProjectConfig,
  parseCdsLibraryDetails,
  readManifest,
  resolveOaViewSource,
  resolveCadenceEnvironment,
  validOaName,
} from './layout_catalog.mjs';

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 16;
const MAX_DIRECTORY_ENTRIES = 100000;
const MAX_CONFIGURED_VIEWS = 32;

function httpError(status, message, details = null, code = 'E9001') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (details) error.details = details;
  return error;
}

function isWithin(base, candidate) {
  const rel = relative(base, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`));
}

function safeConfiguredPath(value, label) {
  const path = String(value || '');
  if (!path || !path.startsWith('/')) throw httpError(400, `${label} must be an absolute path`, null, 'E2007');
  if (/\0|[\r\n#;]/.test(path)) throw httpError(400, `${label} contains unsupported characters`, null, 'E2007');
  return path;
}

function canonicalPath(value, label, expectedType) {
  const configured = safeConfiguredPath(value, label);
  let canonical;
  try {
    canonical = realpathSync(configured);
  } catch {
    throw httpError(404, `${label} does not exist or is not readable`, null, 'E2007');
  }
  const metadata = statSync(canonical);
  if (expectedType === 'file' && !metadata.isFile()) throw httpError(400, `${label} must be a regular file`, null, 'E2007');
  if (expectedType === 'directory' && !metadata.isDirectory()) throw httpError(400, `${label} must be a directory`, null, 'E2007');
  if (metadata.isFile() && metadata.size > 4 * 1024 * 1024) throw httpError(413, `${label} exceeds 4 MiB`, null, 'E4004');
  return canonical;
}

function snapshot(path, type) {
  const metadata = statSync(path);
  return {
    path,
    type,
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
  };
}

function assertSnapshot(record, label) {
  let canonical;
  let metadata;
  try {
    canonical = realpathSync(record.path);
    metadata = statSync(canonical);
  } catch {
    throw httpError(409, `${label} is no longer available; load the library again`, null, 'E3009');
  }
  const expectedType = record.type === 'directory' ? metadata.isDirectory() : metadata.isFile();
  const fileChanged = record.type === 'file'
    && (metadata.size !== record.size || metadata.mtimeMs !== record.mtimeMs);
  if (canonical !== record.path || !expectedType || metadata.dev !== record.dev
      || metadata.ino !== record.ino || fileChanged) {
    throw httpError(409, `${label} changed after it was loaded; load the library again`, null, 'E3009');
  }
}

function normalizeOverrides(rawOverrides) {
  if (rawOverrides == null) return {};
  if (typeof rawOverrides !== 'object' || Array.isArray(rawOverrides)) {
    throw httpError(400, 'overrides must be an object', null, 'E2015');
  }
  const overrides = {};
  for (const name of ['cdsLib', 'cadenceEnv', 'libraryName']) {
    if (rawOverrides[name] == null || rawOverrides[name] === '') continue;
    if (typeof rawOverrides[name] !== 'string') throw httpError(400, `${name} must be a string`, null, 'E2015');
    overrides[name] = rawOverrides[name];
  }
  if (rawOverrides.views != null) {
    if (!Array.isArray(rawOverrides.views) || !rawOverrides.views.length
        || rawOverrides.views.length > MAX_CONFIGURED_VIEWS
        || !rawOverrides.views.every((view) => typeof view === 'string' && validOaName(view))) {
      throw httpError(400, `views must contain 1-${MAX_CONFIGURED_VIEWS} valid OA view names`, null, 'E2015');
    }
    overrides.views = [...new Set(rawOverrides.views)];
  }
  if (rawOverrides.strictSymlinks != null) {
    if (typeof rawOverrides.strictSymlinks !== 'boolean') {
      throw httpError(400, 'strictSymlinks must be a boolean', null, 'E2015');
    }
    overrides.strictSymlinks = rawOverrides.strictSymlinks;
  }
  if (rawOverrides.resourceMode != null && rawOverrides.resourceMode !== '') {
    if (typeof rawOverrides.resourceMode !== 'string'
        || !['low', 'balanced', 'large'].includes(rawOverrides.resourceMode.toLowerCase())) {
      throw httpError(400, 'resourceMode must be low, balanced, or large', null, 'E2015');
    }
    overrides.resourceMode = rawOverrides.resourceMode.toLowerCase();
  }
  if (overrides.libraryName && !validOaName(overrides.libraryName)) {
    throw httpError(400, 'libraryName is not a valid OA library name', null, 'E3010');
  }
  return overrides;
}

function findNearestCdsLib(startDirectory, maximumLevels = 16) {
  let current = startDirectory;
  for (let level = 0; level <= maximumLevels; level += 1) {
    for (const name of ['cds.lib', 'lib.defs']) {
      const candidate = join(current, name);
      try {
        const canonical = realpathSync(candidate);
        const metadata = statSync(canonical);
        if (metadata.isFile() && metadata.size <= 4 * 1024 * 1024) return canonical;
      } catch {
        // Continue toward the filesystem root.
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function looksLikeOaLibrary(directory, views, strictSymlinks) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return false;
  }
  if (entries.length > MAX_DIRECTORY_ENTRIES) throw httpError(413, 'Library contains too many entries', null, 'E4004');
  for (const cell of entries) {
    if (!cell.isDirectory() || !validOaName(cell.name)) continue;
    for (const view of views) {
      if (resolveOaViewSource(
        directory, cell.name, view, { requireRealEntries: strictSymlinks },
      )) return true;
    }
  }
  return false;
}

function selectDefinedLibrary(details, sourceDirectory, requestedName, sourceWasCdsFile) {
  if (requestedName) {
    const selectedPath = details.libraries.get(requestedName);
    if (!selectedPath) throw httpError(404, `Library is not defined in cds.lib: ${requestedName}`, null, 'E2017');
    return { name: requestedName, path: selectedPath };
  }
  let candidates = [...details.directLibraries.entries()];
  if (!sourceWasCdsFile) {
    const localCandidates = candidates.filter(([, path]) => isWithin(sourceDirectory, path));
    if (localCandidates.length) candidates = localCandidates;
  }
  const sourceName = basename(sourceDirectory);
  const basenameMatch = candidates.find(([name]) => name === sourceName);
  if (basenameMatch) return { name: basenameMatch[0], path: basenameMatch[1] };
  if (candidates.length === 1) return { name: candidates[0][0], path: candidates[0][1] };
  if (!candidates.length) throw httpError(404, 'No OA library DEFINE was found in the selected cds.lib', null, 'E2005');
  throw httpError(409, 'The selected project defines multiple libraries; set Advanced libraryName', {
    candidates: candidates.map(([name, path]) => ({ name, path })),
  }, 'E2008');
}

function selectedDirectoryLibrary(directory, details, requestedName, warnings) {
  if (requestedName) return { name: requestedName, path: directory };
  const aliases = [...details.libraries.entries()]
    .filter(([, path]) => path === directory)
    .map(([name]) => name)
    .sort();
  if (aliases.includes(basename(directory))) return { name: basename(directory), path: directory };
  if (aliases.length) {
    if (aliases.length > 1) warnings.push({
      code: 'VL3D-E2008',
      message: `Multiple cds.lib names point to this directory; using ${aliases[0]}`,
    });
    return { name: aliases[0], path: directory };
  }
  const fallback = basename(directory);
  if (!validOaName(fallback)) {
    throw httpError(400, 'Cannot infer a valid OA library name; set Advanced libraryName', null, 'E3010');
  }
  warnings.push({
    code: 'VL3D-E2017',
    message: 'The selected OA directory is not defined in cds.lib; a temporary export overlay will be used',
  });
  return { name: fallback, path: directory };
}

function resolveCadencePath(root, override, environment = process.env) {
  if (override) return canonicalPath(override, 'cadenceEnv', 'file');
  const { config } = loadProjectConfig(root, environment);
  const resolved = resolveCadenceEnvironment(root, config, null, environment);
  if (!resolved) return null;
  try {
    return canonicalPath(resolve(resolved), 'cadenceEnv', 'file');
  } catch {
    return null;
  }
}

function cadenceEnvironmentCandidates(directories) {
  const paths = [];
  for (const directory of [...new Set(directories.filter(Boolean))]) {
    for (const name of ['cadence_env.sh', 'cadence_environment.sh', 'cadence_bridge_env.sh']) {
      try {
        const candidate = realpathSync(join(directory, name));
        if (statSync(candidate).isFile()) paths.push(candidate);
      } catch {
        // Continue through the bounded candidate list.
      }
    }
    try {
      const hidden = realpathSync(join(directory, '.vl3d', 'cadence_env.sh'));
      if (statSync(hidden).isFile()) paths.push(hidden);
    } catch {
      // The optional per-user adapter is absent.
    }
  }
  return [...new Set(paths)];
}

function pathAncestors(path, maximumLevels = 6) {
  const directories = [];
  let current = path;
  for (let level = 0; level <= maximumLevels; level += 1) {
    directories.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directories;
}

function inferredCadenceEnvironment(root, selectedPath, environment = process.env) {
  let selectedDirectory = null;
  try {
    const canonical = realpathSync(String(selectedPath || ''));
    selectedDirectory = statSync(canonical).isDirectory() ? canonical : dirname(canonical);
  } catch {
    // The normal library validation reports an invalid selection later.
  }
  const tiers = [
    selectedDirectory ? pathAncestors(selectedDirectory) : [],
    [root, environment.HOME, ...(environment.HOME ? pathAncestors(environment.HOME, 2) : [])],
  ];
  for (const directories of tiers) {
    const candidates = cadenceEnvironmentCandidates(directories);
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      throw httpError(409, 'Multiple Cadence environment adapters were found', {
        candidates,
      }, 'E2008');
    }
  }
  return null;
}

export class LibrarySessionStore {
  constructor(root, options = {}) {
    this.root = root;
    this.ttlMs = options.ttlMs || DEFAULT_TTL_MS;
    this.maxSessions = options.maxSessions || DEFAULT_MAX_SESSIONS;
    this.dataRoot = options.dataRoot || null;
    this.exportPolicy = options.exportPolicy || OA_EXPORT_POLICY;
    this.pdkProfiles = options.pdkProfiles || { profile: null, directories: [] };
    this.strictSymlinks = options.strictSymlinks === true;
    this.sessions = new Map();
  }

  prune(now = Date.now()) {
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
    while (this.sessions.size > this.maxSessions) {
      const oldest = [...this.sessions.values()].sort((first, second) => first.lastAccess - second.lastAccess)[0];
      if (!oldest) break;
      this.sessions.delete(oldest.id);
    }
  }

  create(input, options = {}) {
    this.prune();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError(400, 'Request must be an object', null, 'E9003');
    const overrides = normalizeOverrides(input.overrides);
    const environment = options.environment || process.env;
    const selected = canonicalPath(input.path, 'path');
    const selectedMetadata = statSync(selected);
    if (!selectedMetadata.isFile() && !selectedMetadata.isDirectory()) {
      throw httpError(400, 'path must select an OA directory, project directory, cds.lib, or lib.defs', null, 'E2007');
    }
    const views = overrides.views || DEFAULT_OA_LAYOUT_VIEWS;
    const strictSymlinks = overrides.strictSymlinks ?? this.strictSymlinks;
    const sourceWasCdsFile = selectedMetadata.isFile();
    if (sourceWasCdsFile && !['cds.lib', 'lib.defs'].includes(basename(selected))) {
      throw httpError(400, 'A selected file must be named cds.lib or lib.defs', null, 'E2007');
    }
    const sourceDirectory = sourceWasCdsFile ? dirname(selected) : selected;
    const localCdsLib = sourceWasCdsFile
      ? selected
      : findNearestCdsLib(sourceDirectory);
    const cdsLib = overrides.cdsLib
      ? canonicalPath(overrides.cdsLib, 'cdsLib', 'file')
      : localCdsLib;
    const details = cdsLib
      ? parseCdsLibraryDetails(cdsLib, { environment })
      : { libraries: new Map(), directLibraries: new Map(), warnings: [] };
    const warnings = [...details.warnings];
    let library;
    const selectedIsOaLibrary = !sourceWasCdsFile
      && looksLikeOaLibrary(selected, views, strictSymlinks);
    if (selectedIsOaLibrary) {
      library = selectedDirectoryLibrary(selected, details, overrides.libraryName, warnings);
    } else {
      let projectCdsLib = cdsLib;
      if (!sourceWasCdsFile) {
        for (const name of ['cds.lib', 'lib.defs']) {
          const candidate = join(selected, name);
          if (existsSync(candidate)) {
            projectCdsLib = canonicalPath(candidate, name, 'file');
            break;
          }
        }
      }
      if (!projectCdsLib) throw httpError(404, 'No OA library or cds.lib was found at the selected path', null, 'E2007');
      const projectDetails = projectCdsLib === cdsLib
        ? details
        : parseCdsLibraryDetails(projectCdsLib, { environment });
      library = selectDefinedLibrary(projectDetails, sourceDirectory, overrides.libraryName, sourceWasCdsFile);
      if (projectCdsLib !== cdsLib) {
        details.libraries = projectDetails.libraries;
        details.directLibraries = projectDetails.directLibraries;
      }
    }
    const canonicalLibrary = canonicalPath(library.path, 'OA library', 'directory');
    library.path = canonicalLibrary;
    const mappedPath = details.libraries.get(library.name) || null;
    const needsOverlay = mappedPath !== library.path;
    details.libraries.set(library.name, library.path);
    const cadenceEnv = options.cadenceEnv
      ? canonicalPath(options.cadenceEnv, 'cadenceEnv', 'file')
      : resolveCadencePath(this.root, overrides.cadenceEnv, environment);
    if (!cdsLib) warnings.push({
      code: 'VL3D-E2003',
      message: 'No cds.lib was found; referenced libraries may not open',
    });
    if (!cadenceEnv) warnings.push({
      code: 'VL3D-E2009',
      message: 'No readable Cadence environment script is configured',
    });
    const now = Date.now();
    const id = randomBytes(24).toString('hex');
    const session = {
      id,
      source: snapshot(selected, sourceWasCdsFile ? 'file' : 'directory'),
      library: { ...library, snapshot: snapshot(library.path, 'directory') },
      cdsLib,
      cdsSnapshot: cdsLib ? snapshot(cdsLib, 'file') : null,
      cadenceEnv,
      cadenceSnapshot: cadenceEnv ? snapshot(cadenceEnv, 'file') : null,
      libraries: details.libraries,
      views,
      strictSymlinks,
      exportPolicy: options.exportPolicy || this.exportPolicy,
      pdkProfiles: options.pdkProfiles || this.pdkProfiles,
      needsOverlay: needsOverlay || !cdsLib,
      warnings,
      createdAt: now,
      lastAccess: now,
      expiresAt: now + this.ttlMs,
    };
    this.sessions.set(id, session);
    this.prune();
    return this.publicSession(session);
  }

  get(id) {
    this.prune();
    if (!/^[a-f0-9]{48}$/.test(String(id || ''))) throw httpError(404, 'Library session was not found', null, 'E2023');
    const session = this.sessions.get(id);
    if (!session) throw httpError(404, 'Library session expired or was not found', null, 'E2023');
    assertSnapshot(session.source, 'Selected path');
    assertSnapshot(session.library.snapshot, 'OA library');
    if (session.cdsSnapshot) assertSnapshot(session.cdsSnapshot, 'cds.lib');
    if (session.cadenceSnapshot) assertSnapshot(session.cadenceSnapshot, 'Cadence environment');
    session.lastAccess = Date.now();
    session.expiresAt = session.lastAccess + this.ttlMs;
    return session;
  }

  catalog(session) {
    const discovered = discoverOaLayoutsForLibrary(
      session.library.name,
      session.library.path,
      { views: session.views },
      { requireRealEntries: session.strictSymlinks },
    );
    if (discovered.length > MAX_DIRECTORY_ENTRIES) throw httpError(413, 'Library contains too many layout views', null, 'E4004');
    const manifest = readManifest(this.root, this.dataRoot);
    const cachedByKey = new Map((manifest.cells || []).map((entry) => [
      layoutKey(entry.library, entry.cell, entry.view), entry,
    ]));
    return {
      config: { views: session.views },
      cdsLib: session.cdsLib,
      cadenceEnv: session.cadenceEnv,
      libraries: new Map(session.libraries),
      manifest,
      exportPolicy: session.exportPolicy,
      pdkProfiles: session.pdkProfiles,
      needsOverlay: session.needsOverlay,
      sessionScoped: true,
      strictSymlinks: session.strictSymlinks,
      selectedLibrary: { name: session.library.name, path: session.library.path },
      layouts: discovered.map((layout) => {
        const entry = cachedByKey.get(layout.key) || null;
        const record = {
          ...layout,
          cacheState: entry
            ? cacheState(
              this.root, entry, session.libraries, true, this.dataRoot, session.exportPolicy,
              session.pdkProfiles,
            )
            : 'missing',
          sourceType: 'oa',
          entry,
        };
        const source = resolveOaViewSource(
          session.library.path, layout.cell, layout.view,
          { requireRealEntries: session.strictSymlinks },
        );
        if (!source) throw httpError(409, 'OA layout changed while the library was being read', null, 'E3009');
        const metadata = source.oaMetadata;
        Object.defineProperty(record, 'sourceSnapshot', {
          enumerable: false,
          value: {
            path: source.oaPath,
            dev: metadata.dev,
            ino: metadata.ino,
            size: metadata.size,
            mtimeMs: metadata.mtimeMs,
            masterTag: source.masterTagPath ? {
              path: source.masterTagPath,
              dev: source.masterTagMetadata.dev,
              ino: source.masterTagMetadata.ino,
              size: source.masterTagMetadata.size,
              mtimeMs: source.masterTagMetadata.mtimeMs,
            } : null,
          },
        });
        return record;
      }),
    };
  }

  publicSession(session) {
    const catalog = this.catalog(session);
    return {
      sessionId: session.id,
      library: { name: session.library.name, path: session.library.path },
      layouts: catalog.layouts,
      resolved: {
        cdsLib: session.cdsLib, cadenceEnv: session.cadenceEnv,
        pdkProfile: session.pdkProfiles.profile || null,
        pdkProfileDirs: [...(session.pdkProfiles.directories || [])],
        pdkProfileSource: session.pdkProfiles.profile ? 'configured-file'
          : session.pdkProfiles.directories?.length ? 'configured-directories' : 'automatic-on-import',
      },
      settings: {
        views: session.views,
        strictSymlinks: session.strictSymlinks,
        resourceMode: session.exportPolicy.resourceMode || 'balanced',
      },
      warnings: session.warnings,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  describe(id) {
    return this.publicSession(this.get(id));
  }
}

export function resolveSessionCadenceEnvironment(root, input, environment = process.env) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw httpError(400, 'Request must be an object', null, 'E9003');
  }
  const overrides = normalizeOverrides(input.overrides);
  return resolveCadencePath(root, overrides.cadenceEnv, environment)
    || inferredCadenceEnvironment(root, input.path, environment);
}

export { assertSnapshot, findNearestCdsLib, httpError, inferredCadenceEnvironment };
