import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { linkSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = mkdtempSync(join(tmpdir(), 'vl3d-trace-api-test-'));
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
function fixture() {
  const box = (id, x1, x2) => ({ id, type: 'box', layer: 'M1', purpose: 'drawing', hierPath: 'TOP',
    bbox: { min: [x1, 0], max: [x2, 1] }, points: [[x1, 0], [x2, 0], [x2, 1], [x1, 1]] });
  return { schemaVersion: 2, units: 'um', dbuPerMicron: 1000, library: 'SYNTHETIC', cell: 'TOP', view: 'layout',
    layers: [{ name: 'M1', kind: 'metal', routing: true, semantic: 'metal-1' }],
    shapes: [box(19, 0, 1), box(42, 1, 3), box(7, 4, 5)],
    pins: [{ terminal: 'A', hierPath: 'TOP', layer: 'M1', points: [[0, 0], [0.5, 0], [0.5, 1], [0, 1]],
      worldBBox: { min: [0, 0], max: [0.5, 1] } }],
    instances: [], connections: [], shapeCount: 3, deviceScopes: {}, deviceMetadataComplete: true,
    bbox: { min: [0, 0], max: [5, 1] }, exportStatus: { complete: true, truncated: false } };
}
async function start(name, environment = {}) {
  const directory = join(temporary, name); mkdirSync(directory);
  const child = spawn(process.execPath, [join(root, 'tools/server.mjs'), '--root', root,
    '--host', '127.0.0.1', '--port', '0', '--data-dir', join(directory, 'data'), '--state-dir', join(directory, 'state')],
  { env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { output += data; });
  for (let n = 0; n < 500; n += 1) {
    const line = output.split('\n').find((value) => value.startsWith('VL3D_READY '));
    if (line) return { child, base: `http://127.0.0.1:${JSON.parse(line.slice(11)).port}`, directory };
    if (child.exitCode != null) throw Error(output);
    await pause(20);
  }
  child.kill('SIGTERM'); throw Error(`Server startup timeout: ${output}`);
}
async function stop(child) {
  if (child.exitCode != null) return;
  child.kill('SIGTERM');
  for (let n = 0; n < 200 && child.exitCode == null; n += 1) await pause(20);
  if (child.exitCode == null) child.kill('SIGKILL');
}
async function post(base, body, extra = {}) {
  return fetch(`${base}/api/traces`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
}
async function result(base, response) {
  assert.equal(response.status, 202, await response.clone().text());
  const accepted = await response.json();
  for (let n = 0; n < 1500; n += 1) {
    const operation = await (await fetch(`${base}/api/operations/${accepted.operationId}`)).json();
    if (!['running', 'cancelling'].includes(operation.state)) return operation;
    await pause(20);
  }
  throw Error('Trace operation timed out');
}
let normal; let slow;
try {
  normal = await start('normal');
  const layout = fixture(), request = { layout, pins: layout.pins };
  let response = await post(normal.base, request, { Origin: 'https://unrelated.invalid' });
  assert.equal(response.status, 403, 'Cross-origin trace request must be rejected');
  for (const body of [{ ...request, path: '/tmp/source.json' }, { layout, pins: [] },
    { ...request, limits: { maxShapes: -1 } }, { ...request, scopePaths: [] },
    { ...request, limits: { unsupported: 1 } }, { ...request, limits: { maxSeconds: 121 } }]) {
    response = await post(normal.base, body); assert.equal(response.status, 400, JSON.stringify(body));
  }
  let operation = await result(normal.base, await post(normal.base, request));
  assert.equal(operation.state, 'succeeded', JSON.stringify(operation));
  assert.equal(operation.result.complete, true, JSON.stringify(operation));
  assert.deepEqual(operation.result.shapeIndices, [0, 1], 'Physical contact must trace unnamed shapes by ordinal, excluding disconnected geometry');
  assert.equal(operation.result.cached, false);
  operation = await result(normal.base, await post(normal.base, request));
  assert.equal(operation.result.cached, true, 'Unchanged complete result should reuse its separate cache');
  layout.shapes[1].bbox.min[0] = 1.01; layout.shapes[1].points[0][0] = 1.01; layout.shapes[1].points[3][0] = 1.01;
  operation = await result(normal.base, await post(normal.base, { layout, pins: layout.pins }));
  assert.deepEqual(operation.result.shapeIndices, [0]);
  assert.equal(operation.result.cached, false, 'Geometry changes must invalidate the trace cache');
  const source = join(temporary, 'source.json'); writeFileSync(source, JSON.stringify(fixture()));
  operation = await result(normal.base, await post(normal.base, { path: source, pins: fixture().pins }));
  assert.equal(operation.state, 'succeeded', JSON.stringify(operation));
  assert.equal(operation.result.sourceDigest, createHash('sha256').update(readFileSync(source)).digest('hex'));
  assert.deepEqual(operation.result.shapeIndices, [0, 1]);
  const linkedSource = join(temporary, 'hard-linked-source.json'); linkSync(source, linkedSource);
  const linked = await result(normal.base, await post(normal.base, { path: linkedSource, pins: fixture().pins }));
  assert.equal(linked.state, 'succeeded', JSON.stringify(linked));
  assert.deepEqual(linked.result.shapeIndices, [0, 1], 'Read-only layout hard links are legitimate source inputs');
  const limited = await result(normal.base, await post(normal.base, { layout: fixture(), pins: fixture().pins, limits: { maxResults: 1 } }));
  assert.equal(limited.state, 'succeeded', JSON.stringify(limited));
  assert.equal(limited.result.complete, false, 'Limited results must not be labelled complete');
  assert.ok(limited.result.shapeIndices.length <= 1);
  const cachedLimited = await result(normal.base, await post(normal.base, { layout: fixture(), pins: fixture().pins, limits: { maxResults: 1 } }));
  assert.equal(cachedLimited.result.cached, false, 'Incomplete results must never be reused as a complete cache');
  const wrapper = join(temporary, 'slow-python');
  writeFileSync(wrapper, '#!/bin/sh\nsleep 30\nexit 0\n'); chmodSync(wrapper, 0o700);
  slow = await start('slow', { VL3D_PYTHON: wrapper });
  response = await post(slow.base, request); assert.equal(response.status, 202);
  const accepted = await response.json(); await pause(100);
  response = await fetch(`${slow.base}/api/operations/${accepted.operationId}`, { method: 'DELETE' });
  assert.equal(response.status, 202);
  let cancelled;
  for (let n = 0; n < 250; n += 1) {
    cancelled = await (await fetch(`${slow.base}/api/operations/${accepted.operationId}`)).json();
    if (cancelled.state === 'cancelled') break;
    await pause(20);
  }
  assert.equal(cancelled.state, 'cancelled', JSON.stringify(cancelled));
  assert.equal(cancelled.result, undefined, 'Cancelled trace must not publish stale highlighted shapes');
  assert.equal(existsSync(join(root, 'public/data/source.json')), false);
  console.log('Physical trace API passed: unnamed connectivity, gaps, ordinal IDs, source hashes, cache invalidation, incomplete limits, cancellation, input validation and same-origin protection');
} finally {
  if (normal) await stop(normal.child);
  if (slow) await stop(slow.child);
  rmSync(temporary, { recursive: true, force: true });
}
