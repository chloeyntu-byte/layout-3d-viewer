#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryRoot = mkdtempSync(join(tmpdir(), 'vl3d-server-test-'));
const port = 22000 + Math.floor(Math.random() * 20000);
const child = spawn(process.execPath, [
  join(root, 'tools', 'server.mjs'),
  '--root', root,
  '--host', '127.0.0.1',
  '--port', String(port),
  '--data-dir', join(temporaryRoot, 'data'),
  '--state-dir', join(temporaryRoot, 'state'),
  '--resource-mode', 'low',
], {
  cwd: root,
  env: { ...process.env, VL3D_PYTHON: '/does/not/exist' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

async function waitForServer() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (output.includes('Serving ')) return;
    if (child.exitCode != null) throw new Error(`Server exited early: ${output}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Server did not start: ${output}`);
}

async function stopServer() {
  if (child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolvePromise) => child.once('close', resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 3000)),
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

try {
  await waitForServer();
  const stateResponse = await fetch(`http://127.0.0.1:${port}/api/libraries/state`);
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.oaEnabled, false);
  assert.equal(state.runtime.exportPolicy.resourceMode, 'low');
  assert.equal(state.runtime.dataRoot, join(temporaryRoot, 'data'));

  const manifestResponse = await fetch(`http://127.0.0.1:${port}/public/data/manifest.json`);
  assert.equal(manifestResponse.status, 200);
  assert.deepEqual((await manifestResponse.json()).cells, []);
  assert.equal(statSync(join(temporaryRoot, 'data')).mode & 0o777, 0o700);
  assert.equal(statSync(join(temporaryRoot, 'data', 'manifest.json')).mode & 0o777, 0o600);

  const pageResponse = await fetch(`http://127.0.0.1:${port}/public/`);
  assert.equal(pageResponse.status, 200);
  assert.match(await pageResponse.text(), /Layout 3D Viewer/);
  const viewerResponse = await fetch(`http://127.0.0.1:${port}/public/src/viewer-next.js`);
  assert.equal(viewerResponse.status, 200);
  assert.match(await viewerResponse.text(), /vendor\/three\.module\.min\.js/);
  const threeResponse = await fetch(`http://127.0.0.1:${port}/public/vendor/three.module.min.js`);
  assert.equal(threeResponse.status, 200);
  assert.equal(Number(threeResponse.headers.get('content-length')), 338836);
  assert.match(threeResponse.headers.get('cache-control'), /immutable/);
  const threeCoreResponse = await fetch(`http://127.0.0.1:${port}/public/vendor/three.core.min.js`);
  assert.equal(threeCoreResponse.status, 200);
  assert.equal(Number(threeCoreResponse.headers.get('content-length')), 380374);
  console.log('server runtime tests passed');
} finally {
  await stopServer();
  rmSync(temporaryRoot, { recursive: true, force: true });
}
