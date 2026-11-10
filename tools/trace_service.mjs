import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const INPUT_MAX = 384 * 1024 * 1024;
const RESULT_MAX = 16 * 1024 * 1024;
const CACHE_MAX = 64 * 1024 * 1024;
const CACHE_TTL = 30 * 60 * 1000;
export const TRACE_REQUEST_MAX_BYTES = 64 * 1024 * 1024;
const LIMITS = Object.freeze({
  maxShapes: [200000, 1, 500000], maxVertices: [4000000, 4, 8000000],
  maxCandidates: [2000000, 1, 8000000], maxResults: [100000, 1, 500000],
  maxSeconds: [60, 1, 120], maxMemoryMiB: [256, 32, 1024],
  maxIndexCells: [2000000, 1, 4000000], maxGeometryChecks: [10000000, 1, 40000000],
});
const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');
function atomicPrivate(path, buffer) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, buffer, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

// User inputs may legitimately have hard links. Read only one canonical file
// descriptor, bound its bytes, and reject replacement/growth while reading.
function inputBuffer(path, maximumBytes) {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size <= 0 || before.size > maximumBytes) throw new Error('Input must be a regular JSON file within the size limit');
    const chunks = []; let size = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, maximumBytes - size + 1));
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (!count) break;
      size += count;
      if (size > maximumBytes) throw new Error('Input grew beyond the size limit');
      chunks.push(chunk.subarray(0, count));
    }
    const after = fstatSync(descriptor);
    if (before.size !== size || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || before.dev !== after.dev || before.ino !== after.ino) throw new Error('Input changed while being read');
    return Buffer.concat(chunks, size);
  } finally { closeSync(descriptor); }
}

export class TraceService {
  constructor({ root, stateRoot, pythonExecutable, runBuffered, sourceRecord, assertSnapshot, readRegular, codedError, environment }) {
    Object.assign(this, { root, pythonExecutable, runBuffered, sourceRecord, assertSnapshot, readRegular, codedError, environment });
    this.cacheRoot = join(stateRoot, 'physical-traces');
    this.active = 0;
  }
  normalize(body) {
    const fail = (message) => { throw this.codedError(400, 'E9003', message); };
    if ((body.path != null) === (body.layout != null)) fail('Provide exactly one layout object or absolute JSON path');
    if (body.layout != null && (!body.layout || typeof body.layout !== 'object' || Array.isArray(body.layout)
        || !Array.isArray(body.layout.shapes) || !Array.isArray(body.layout.layers))) fail('Layout must contain shapes and layers arrays');
    if (!Array.isArray(body.pins) || !body.pins.length || body.pins.length > 256
        || body.pins.some((pin) => !pin || typeof pin !== 'object' || Array.isArray(pin))) fail('Select between 1 and 256 pin figures');
    if (JSON.stringify(body.pins).length > 2 * 1024 * 1024) fail('Pin geometry exceeds the request limit');
    if (body.scopePaths != null && (!Array.isArray(body.scopePaths) || !body.scopePaths.length || body.scopePaths.length > 256
        || body.scopePaths.some((path) => typeof path !== 'string' || !path || path.length > 4096 || /[\x00-\x1f]/.test(path)))) fail('scopePaths must contain 1 to 256 hierarchy paths, or null for the whole layout');
    if (body.limits != null && (typeof body.limits !== 'object' || Array.isArray(body.limits))) fail('limits must be an object');
    const limits = {};
    for (const key of Object.keys(body.limits || {})) if (!Object.hasOwn(LIMITS, key)) fail(`Unsupported trace limit: ${key}`);
    for (const [key, [fallback, minimum, maximum]] of Object.entries(LIMITS)) {
      const value = body.limits?.[key] ?? fallback;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) fail(`${key} must be an integer from ${minimum} to ${maximum}`);
      limits[key] = value;
    }
    return { ...(body.path != null ? { path: body.path } : { layout: body.layout }), pins: body.pins,
      scopePaths: body.scopePaths || null, limits };
  }
  ensureCache() {
    if (!existsSync(this.cacheRoot)) mkdirSync(this.cacheRoot, { mode: 0o700 });
    const metadata = lstatSync(this.cacheRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw this.codedError(500, 'E4005', 'Physical trace cache is not a private directory');
    const records = readdirSync(this.cacheRoot).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).map((name) => {
      const path = join(this.cacheRoot, name), stat = lstatSync(path);
      return { path, stat };
    }).filter(({ stat }) => stat.isFile() && !stat.isSymbolicLink()).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    let bytes = 0;
    for (const [index, record] of records.entries()) {
      bytes += record.stat.size;
      if (index >= 64 || bytes > CACHE_MAX || Date.now() - record.stat.mtimeMs > CACHE_TTL) rmSync(record.path);
    }
  }
  codeDigest() {
    const hash = createHash('sha256');
    for (const directory of ['native', 'profiles', 'tools']) {
      const names = readdirSync(join(this.root, directory)).filter((name) => directory === 'profiles' ? name.endsWith('.json')
        : (directory === 'native' ? /^(?:physical_trace|trace_worker|compiler)\.py$/ : /^(?:trace_rules|pdk_profile)\.py$/).test(name)).sort();
      for (const name of names) hash.update(`${directory}/${name}\0`).update(readFileSync(join(this.root, directory, name)));
    }
    return hash.digest('hex');
  }
  async run(body, operation) {
    if (!this.pythonExecutable) throw this.codedError(503, 'E1013', 'Physical tracing requires the Python runtime; run vl3d doctor');
    if (this.active >= 2) throw this.codedError(429, 'E4004', 'Two physical traces are already running; cancel one or wait');
    this.active += 1;
    let temporary;
    try {
      operation.progress = { phase: 'loading', message: 'Reading layout geometry' };
      let source = null;
      let buffer;
      let compressed = false;
      if (body.path != null) {
        source = this.sourceRecord(body.path);
        if (source.kind !== 'json' || source.metadata.size > INPUT_MAX) throw this.codedError(400, 'E6001', 'Physical tracing needs a layout JSON/JSON.gz file under 384 MiB');
        try { buffer = inputBuffer(source.path, INPUT_MAX); }
        catch (error) { throw this.codedError(400, 'E6001', `Cannot read the selected layout JSON: ${error.message}`); }
        this.assertSnapshot(source);
        compressed = source.path.toLowerCase().endsWith('.gz');
      } else buffer = Buffer.from(JSON.stringify(body.layout));
      if (buffer.length > INPUT_MAX) throw this.codedError(413, 'E4004', 'Layout exceeds the physical trace input limit');
      const sourceDigest = digest(buffer);
      const query = { pins: body.pins, scopePaths: body.scopePaths, limits: body.limits };
      const cacheKey = digest(Buffer.from(JSON.stringify({ sourceDigest, code: this.codeDigest(), query })));
      this.ensureCache();
      const cachePath = join(this.cacheRoot, `${cacheKey}.json`);
      if (existsSync(cachePath)) {
        try {
          const cached = JSON.parse(this.readRegular(cachePath, RESULT_MAX, 'trace cache'));
          if (cached.complete === true && cached.sourceDigest === sourceDigest && cached.cacheKey === cacheKey) {
            operation.progress = { phase: 'complete', message: 'Using verified trace cache' };
            return { ...cached, cached: true };
          }
        } catch { /* Recompute an incomplete or damaged cache entry. */ }
      }
      temporary = mkdtempSync(join(tmpdir(), 'vl3d-physical-trace-'));
      const sourcePath = join(temporary, compressed ? 'layout.json.gz' : 'layout.json');
      const requestPath = join(temporary, 'request.json');
      const outputPath = join(temporary, 'result.json');
      writeFileSync(sourcePath, buffer, { mode: 0o600, flag: 'wx' });
      buffer = null;
      writeFileSync(requestPath, JSON.stringify({ source: sourcePath, ...query }), { mode: 0o600, flag: 'wx' });
      operation.progress = { phase: 'indexing', message: 'Indexing conductors' };
      try {
        await this.runBuffered(this.pythonExecutable, ['-m', 'native.trace_worker', '--request', requestPath, '--output', outputPath], {
          cwd: this.root, env: { ...this.environment(), PYTHONPATH: this.root, PYTHONDONTWRITEBYTECODE: '1',
            OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1' },
        }, (body.limits.maxSeconds + 15) * 1000, operation);
      } catch (error) {
        if (error.cancelled) throw error;
        throw this.codedError(500, /E1013/.test(error.message) ? 'E1013' : 'E4004', error.message, { phase: 'physical-trace' });
      }
      if (source) this.assertSnapshot(source);
      const result = JSON.parse(this.readRegular(outputPath, RESULT_MAX, 'physical trace result'));
      if (!result || !Array.isArray(result.shapeIndices) || result.shapeIndices.length > body.limits.maxResults
          || result.shapeIndices.some((index) => !Number.isInteger(index) || index < 0)
          || result.sourceDigest !== sourceDigest || typeof result.complete !== 'boolean') {
        throw this.codedError(500, 'E4002', 'Physical trace result did not match the source snapshot');
      }
      const published = { ...result, cached: false, cacheKey };
      if (published.complete) atomicPrivate(cachePath, JSON.stringify(published));
      operation.progress = { phase: result.status, message: result.reason || 'Trace finished' };
      return published;
    } finally {
      if (temporary) rmSync(temporary, { recursive: true, force: true });
      this.active -= 1;
    }
  }
}
