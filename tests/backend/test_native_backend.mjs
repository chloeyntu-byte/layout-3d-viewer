#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function fixture() {
  return {
    schemaVersion: 2,
    sourceSchemaVersion: 2,
    generatedAt: new Date(0).toISOString(),
    units: 'um',
    library: 'JSON_FIXTURE',
    cell: 'TOP',
    view: 'layout',
    bbox: { min: [0, 0], max: [10, 5] },
    sourceShapeCount: 1,
    shapeCount: 1,
    instanceCount: 0,
    pinCount: 1,
    connectionCount: 0,
    maxShapeDepth: 0,
    maxInstanceDepth: 0,
    ownerCellCount: 1,
    layers: [{
      index: 0, name: 'M1', layerNumber: 1, datatype: 0, color: '#4dabf7',
      kind: 'metal', semantic: 'metal-1', routing: true, defaultVisible: true,
      stackIndex: 3, thickness: 0.2, z: 0, height: 0.35, shapeCount: 1,
      connectorCount: 0,
    }],
    shapes: [{
      id: 0, ownerCell: 'TOP', hierPath: 'TOP', layer: 'M1', layerNumber: 1,
      datatype: 0, purpose: 'drawing', net: 'N', label: '', type: 'box', width: 0,
      bbox: { min: [0, 0], max: [10, 5] }, points: [[0, 0], [10, 0], [10, 5], [0, 5]],
    }],
    instances: [],
    pins: [{
      id: 0, name: 'P', terminal: 'P', net: 'N', ownerCell: 'TOP', hierPath: 'TOP',
      layer: 'M1', purpose: 'pin', points: [[0, 0], [1, 0], [1, 1], [0, 1]],
      worldBBox: { min: [0, 0], max: [1, 1] },
    }],
    connections: [],
    technology: { profile: 'fixture', source: 'test', unclassifiedLayers: [] },
    warnings: [],
    exportStatus: { shapesSeen: 1, shapesEmitted: 1, pinsEmitted: 1, connectionsEmitted: 0 },
  };
}

async function waitForReady(child, output) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const line = output.value.split('\n').find((candidate) => candidate.startsWith('VL3D_READY '));
    if (line) return JSON.parse(line.slice('VL3D_READY '.length));
    if (child.exitCode != null) throw new Error(`Server exited early: ${output.value}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`Server did not become ready: ${output.value}`);
}

async function stop(child) {
  if (child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolvePromise) => child.once('close', resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 4000)),
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

function startServer(temporary, extraArgs = [], options = {}) {
  const child = spawn(process.execPath, [
    join(root, 'tools', 'server.mjs'),
    '--root', root,
    '--host', '127.0.0.1',
    '--port', '0',
    '--data-dir', join(temporary, 'data'),
    '--state-dir', join(temporary, 'state'),
    ...extraArgs,
  ], {
    cwd: root,
    env: { ...process.env, ...(options.env || {}) },
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  });
  const output = { value: '' };
  child.stdout.on('data', (chunk) => { output.value += chunk; });
  child.stderr.on('data', (chunk) => { output.value += chunk; });
  return { child, output };
}

async function normalApiTest(temporary) {
  mkdirSync(temporary, { recursive: true });
  const source = join(temporary, 'fixture.json');
  writeFileSync(source, `${JSON.stringify(fixture())}\n`);
  const { child, output } = startServer(temporary);
  try {
    const ready = await waitForReady(child, output);
    assert.ok(ready.port > 0);
    const base = `http://127.0.0.1:${ready.port}`;
    let response = await fetch(`${base}/api/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).port, ready.port);

    response = await fetch(`${base}/api/streams/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: source, overrides: { layerMapPath: 'relative.json' } }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'VL3D-E6003');

    response = await fetch(`${base}/api/streams/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: source, topCell: 'MISSING' }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'VL3D-E6002');

    response = await fetch(`${base}/api/streams/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'respond-async; wait=1' },
      body: JSON.stringify({ path: source }),
    });
    assert.equal(response.status, 202);
    assert.equal(response.headers.get('preference-applied'), 'respond-async');
    const accepted = await response.json();
    let operation;
    for (let index = 0; index < 200; index += 1) {
      response = await fetch(`${base}/api/operations/${accepted.operationId}`);
      assert.equal(response.status, 200);
      operation = await response.json();
      if (!['running', 'cancelling'].includes(operation.state)) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    assert.equal(operation.state, 'succeeded', JSON.stringify(operation));
    assert.equal(operation.result.entry.library, 'JSON_FIXTURE');
    assert.equal(operation.result.entry.pinCount, 1);
    assert.equal(operation.result.entry.sourceFormat, 'VL3D-JSON');
    const manifest = JSON.parse(readFileSync(join(temporary, 'data', 'manifest.json')));
    assert.equal(manifest.cells.length, 1);

    response = await fetch(`${base}/api/operations/${accepted.operationId}`, { method: 'DELETE' });
    assert.equal(response.status, 204);
    response = await fetch(`${base}/api/library-sessions/${'a'.repeat(48)}`, { method: 'DELETE' });
    assert.equal(response.status, 404);
  } finally {
    await stop(child);
  }
}

async function cancellationTest(temporary) {
  mkdirSync(temporary, { recursive: true });
  const source = join(temporary, 'cancel-source.json');
  writeFileSync(source, `${JSON.stringify(fixture())}\n`);
  const wrapper = join(temporary, 'slow-python');
  writeFileSync(wrapper, '#!/bin/sh\nsleep 30\nexec /usr/bin/python3 "$@"\n');
  chmodSync(wrapper, 0o755);
  const { child, output } = startServer(temporary, [], { env: { VL3D_PYTHON: wrapper } });
  try {
    const ready = await waitForReady(child, output);
    const base = `http://127.0.0.1:${ready.port}`;
    let response = await fetch(`${base}/api/streams/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'respond-async' },
      body: JSON.stringify({ path: source, library: 'CANCELLED' }),
    });
    assert.equal(response.status, 202);
    const accepted = await response.json();
    response = await fetch(`${base}/api/operations/${accepted.operationId}`, { method: 'DELETE' });
    assert.equal(response.status, 202);
    let operation;
    for (let index = 0; index < 200; index += 1) {
      response = await fetch(`${base}/api/operations/${accepted.operationId}`);
      operation = await response.json();
      if (operation.state === 'cancelled') break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    assert.equal(operation.state, 'cancelled', JSON.stringify(operation));
    assert.deepEqual(JSON.parse(readFileSync(join(temporary, 'data', 'manifest.json'))).cells, []);
  } finally {
    await stop(child);
  }
}

async function venvExecutablePathTest(temporary) {
  mkdirSync(temporary, { recursive: true });
  const source = join(temporary, 'fixture.json');
  const invocationLog = join(temporary, 'python-entry.txt');
  const target = join(temporary, 'system-python-wrapper');
  const venvPython = join(temporary, 'native-venv', 'bin', 'python');
  writeFileSync(source, `${JSON.stringify(fixture())}\n`);
  mkdirSync(dirname(venvPython), { recursive: true });
  writeFileSync(target, [
    '#!/bin/sh',
    `printf '%s\\n' "$0" > ${JSON.stringify(invocationLog)}`,
    'exec /usr/bin/python3 "$@"',
    '',
  ].join('\n'));
  chmodSync(target, 0o755);
  symlinkSync(target, venvPython);
  const { child, output } = startServer(temporary, [], {
    env: { VL3D_PYTHON: venvPython },
  });
  try {
    const ready = await waitForReady(child, output);
    const response = await fetch(`http://127.0.0.1:${ready.port}/api/streams/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: source }),
    });
    assert.equal(response.status, 201, await response.text());
    assert.equal(readFileSync(invocationLog, 'utf8').trim(), venvPython);
  } finally {
    await stop(child);
  }
}

async function resourceAndProfileArgsTest(temporary) {
  mkdirSync(temporary, { recursive: true });
  const source = join(temporary, 'fixture.json');
  const argumentLog = join(temporary, 'import-args.txt');
  const wrapper = join(temporary, 'logging-python');
  const profileDirectory = join(temporary, 'profiles');
  const explicitProfile = join(temporary, 'explicit.json');
  writeFileSync(source, `${JSON.stringify(fixture())}\n`);
  mkdirSync(profileDirectory);
  writeFileSync(join(profileDirectory, 'portable.json'), `${JSON.stringify({
    schemaVersion: 1,
    id: 'portable-external',
    streamLayers: { '101/0': { name: 'M1', kind: 'metal', routing: true } },
  })}\n`);
  writeFileSync(explicitProfile, `${JSON.stringify({
    schemaVersion: 1,
    id: 'portable-explicit',
    streamLayers: { '101/0': { name: 'XM1', kind: 'metal', routing: true } },
  })}\n`);
  writeFileSync(wrapper, [
    '#!/bin/sh',
    `case "$1" in *import_stream_layout.py) printf '%s\\n' "$@" > ${JSON.stringify(argumentLog)} ;; esac`,
    'exec /usr/bin/python3 "$@"',
    '',
  ].join('\n'));
  chmodSync(wrapper, 0o755);
  const { child, output } = startServer(temporary, ['--resource-mode', 'low'], {
    env: { VL3D_PYTHON: wrapper, VL3D_PDK_PROFILE_DIRS: profileDirectory },
  });
  try {
    const ready = await waitForReady(child, output);
    const base = `http://127.0.0.1:${ready.port}`;
    let response = await fetch(`${base}/api/streams/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: source }),
    });
    assert.equal(response.status, 201, await response.text());
    let importerArgs = readFileSync(argumentLog, 'utf8').trim().split('\n');
    assert.deepEqual(importerArgs.slice(importerArgs.indexOf('--resource-mode'), importerArgs.indexOf('--resource-mode') + 2), [
      '--resource-mode', 'low',
    ], JSON.stringify(importerArgs));
    assert.deepEqual(importerArgs.slice(importerArgs.indexOf('--max-depth'), importerArgs.indexOf('--max-depth') + 2), [
      '--max-depth', '6',
    ]);
    assert.deepEqual(importerArgs.slice(importerArgs.indexOf('--max-shapes'), importerArgs.indexOf('--max-shapes') + 2), [
      '--max-shapes', '100000',
    ]);
    let directoryArgument = importerArgs.indexOf('--pdk-profile-dir');
    assert.ok(directoryArgument > 0);
    assert.match(importerArgs[directoryArgument + 1], /vl3d-stream-import-.*pdk-profiles-0$/);

    response = await fetch(`${base}/api/streams/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: source, pdkProfileDirs: [] }),
    });
    assert.equal(response.status, 201, await response.text());
    importerArgs = readFileSync(argumentLog, 'utf8').trim().split('\n');
    assert.equal(importerArgs.includes('--pdk-profile-dir'), false);

    response = await fetch(`${base}/api/streams/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: source,
        layerMap: { '101/0': { name: 'LOCAL_M1', kind: 'metal', routing: true } },
      }),
    });
    assert.equal(response.status, 201, await response.text());
    importerArgs = readFileSync(argumentLog, 'utf8').trim().split('\n');
    assert.ok(importerArgs.includes('--layer-map'));
    assert.equal(importerArgs.includes('--pdk-profile-dir'), false);

    response = await fetch(`${base}/api/streams/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: source, resourceMode: 'large', pdkProfileDirs: [profileDirectory],
      }),
    });
    assert.equal(response.status, 201, await response.text());
    importerArgs = readFileSync(argumentLog, 'utf8').trim().split('\n');
    assert.deepEqual(importerArgs.slice(importerArgs.indexOf('--resource-mode'), importerArgs.indexOf('--resource-mode') + 2), [
      '--resource-mode', 'large',
    ]);
    assert.deepEqual(importerArgs.slice(importerArgs.indexOf('--max-depth'), importerArgs.indexOf('--max-depth') + 2), [
      '--max-depth', '16',
    ]);
    assert.deepEqual(importerArgs.slice(importerArgs.indexOf('--max-shapes'), importerArgs.indexOf('--max-shapes') + 2), [
      '--max-shapes', '1000000',
    ]);
    directoryArgument = importerArgs.indexOf('--pdk-profile-dir');
    assert.ok(directoryArgument > 0);
    assert.match(importerArgs[directoryArgument + 1], /vl3d-stream-import-.*pdk-profiles-0$/);

    for (const body of [
      { path: source, resourceMode: 'unlimited' },
      { path: source, maxShapes: 0 },
    ]) {
      response = await fetch(`${base}/api/streams/import`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'VL3D-E4004');
    }

    const linkedDirectory = join(temporary, 'linked-profiles');
    symlinkSync(profileDirectory, linkedDirectory);
    response = await fetch(`${base}/api/streams/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: source, pdkProfileDirs: [linkedDirectory] }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'VL3D-E5008');

    const linkedFileDirectory = join(temporary, 'linked-profile-file');
    mkdirSync(linkedFileDirectory);
    symlinkSync(explicitProfile, join(linkedFileDirectory, 'linked.json'));
    response = await fetch(`${base}/api/streams/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: source, pdkProfileDirs: [linkedFileDirectory] }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'VL3D-E5008');

    response = await fetch(`${base}/api/streams/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: source, pdkProfileDirs: new Array(17).fill(profileDirectory) }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'VL3D-E5008');

    response = await fetch(`${base}/api/streams/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: source, pdkProfilePath: explicitProfile, pdkProfileDirs: [linkedDirectory],
      }),
    });
    assert.equal(response.status, 201, await response.text());
    importerArgs = readFileSync(argumentLog, 'utf8').trim().split('\n');
    assert.ok(importerArgs.includes('--pdk-profile'));
    assert.equal(importerArgs.includes('--pdk-profile-dir'), false);
  } finally {
    await stop(child);
  }
}

async function privateApiTest(temporary) {
  mkdirSync(temporary, { recursive: true });
  const bearer = '0123456789abcdef'.repeat(4);
  const { child, output } = startServer(temporary, [
    '--native-private', '--auth-fd', '3', '--parent-fd', '3',
  ], {
    env: {
      VL3D_CONFIG: join(temporary, 'missing-config.json'),
      VL3D_PDK_PROFILE: '',
      VL3D_PDK_PROFILE_DIR: '',
      VL3D_PDK_PROFILE_DIRS: '',
      VL3D_RESOURCE_MODE: 'low',
      VL3D_STREAM_LAYER_MAP: '',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  child.stdio[3].write(`${bearer}\n`);
  const startedAt = Date.now();
  const ready = await waitForReady(child, output);
  assert.equal(ready.advancedSettings.resourceMode, 'low');
  assert.deepEqual(ready.advancedSettings.views, [
    'layout', 'maskLayout', 'chip', 'cLayout', 'dLayout', 'ivpcell',
  ]);
  const base = `http://127.0.0.1:${ready.port}`;
  let response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 401);
  response = await fetch(`${base}/api/health`, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).mode, 'native-private');
  response = await fetch(`${base}/public/`);
  assert.equal(response.status, 200);
  response = await fetch(`${base}/public/data/manifest.json`);
  assert.equal(response.status, 401);
  child.stdio[3].end();
  const exitCode = await Promise.race([
    new Promise((resolvePromise) => child.once('close', resolvePromise)),
    new Promise((resolvePromise, rejectPromise) => setTimeout(
      () => rejectPromise(new Error(`Parent EOF did not stop server: ${output.value}`)), 4000,
    )),
  ]);
  assert.equal(exitCode, 0, output.value);
  assert.ok(Date.now() - startedAt < 4000);
  assert.equal(output.value.includes(bearer), false);
}

const temporary = mkdtempSync(join(tmpdir(), 'vl3d-native-backend-test-'));
try {
  await normalApiTest(join(temporary, 'normal'));
  await cancellationTest(join(temporary, 'cancel'));
  await venvExecutablePathTest(join(temporary, 'venv-entry'));
  await resourceAndProfileArgsTest(join(temporary, 'stream-portability'));
  await privateApiTest(join(temporary, 'private'));
  console.log('PASS: backend random port, bounded stream profiles/resources, async/cancel, bearer auth, and parent EOF');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
