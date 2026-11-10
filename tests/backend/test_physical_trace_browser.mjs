import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = mkdtempSync(join(tmpdir(), 'vl3d-trace-browser-'));
const dataDirectory = join(directory, 'data');
mkdirSync(dataDirectory);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const box = (id, x1, x2) => ({ id, type: 'box', layer: 'M1', purpose: 'drawing', hierPath: 'TOP',
  bbox: { min: [x1, 0], max: [x2, 1] }, points: [[x1, 0], [x2, 0], [x2, 1], [x1, 1]] });
const layout = { schemaVersion: 2, units: 'um', dbuPerMicron: 1000, library: 'SYNTHETIC', cell: 'TOP', view: 'layout',
  layers: [{ name: 'M1', kind: 'metal', routing: true, semantic: 'metal-1', thickness: 0.2, zBottomUm: 0, zTopUm: 0.2 }],
  shapes: [box(19, 0, 1), box(42, 1, 3), box(7, 4, 5)],
  pins: [{ terminal: 'A', hierPath: 'TOP', layer: 'M1', points: [[0, 0], [0.5, 0], [0.5, 1], [0, 1]],
    worldBBox: { min: [0, 0], max: [0.5, 1] } }], instances: [], connections: [], shapeCount: 3,
  deviceScopes: {}, deviceMetadataComplete: true, bbox: { min: [0, 0], max: [5, 1] },
  exportStatus: { complete: true, truncated: false } };
writeFileSync(join(dataDirectory, 'synthetic.json'), JSON.stringify(layout));
writeFileSync(join(dataDirectory, 'manifest.json'), JSON.stringify({ schemaVersion: 2, cells: [
  { library: layout.library, cell: layout.cell, view: 'layout', path: 'data/synthetic.json', shapeCount: 3, instanceCount: 0 },
] }));
const child = spawn(process.execPath, [join(root, 'tools/server.mjs'), '--root', root,
  '--host', '127.0.0.1', '--port', '0', '--data-dir', dataDirectory, '--state-dir', join(directory, 'state')],
{ stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', (data) => { output += data; });
child.stderr.on('data', (data) => { output += data; });
let browser;
try {
  let ready;
  for (let attempt = 0; attempt < 400 && !ready; attempt += 1) {
    const line = output.split('\n').find((value) => value.startsWith('VL3D_READY '));
    if (line) ready = JSON.parse(line.slice(11));
    else if (child.exitCode !== null) throw new Error(output);
    else await pause(25);
  }
  assert(ready, output);
  const executablePath = [process.env.CHROMIUM_BIN, '/usr/bin/chromium-browser', '/usr/bin/chromium',
    '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/opt/google/chrome/chrome']
    .filter(Boolean).find((candidate) => { try { accessSync(candidate, constants.X_OK); return true; } catch { return false; } });
  assert(executablePath, 'An existing Chromium executable is required');
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  const requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => { if (request.url().endsWith('/api/traces')) requests.push(request.postDataJSON()); });
  await page.goto(`http://127.0.0.1:${ready.port}/?library=SYNTHETIC&cell=TOP&view=layout`);
  await page.waitForFunction(() => window.__VL3D_STATE?.cell === 'TOP', { timeout: 30000 });
  async function tracePin() {
    await page.locator('.hierarchy-row.root-row .hierarchy-item').click();
    await page.locator('#traceMode').selectOption('physical');
    await page.locator('#pinList button').first().click();
    try {
      await page.waitForFunction(() => window.__VL3D_STATE?.physicalTraceStatus === 'complete'
        && window.__VL3D_STATE?.physicalTraceShapes === 2, null, { timeout: 15000 });
    } catch (error) {
      console.error(JSON.stringify({ state: await page.evaluate(() => window.__VL3D_STATE),
        status: await page.locator('#physicalTraceStatus').innerText(),
        diagnostics: await page.locator('#physicalTraceDiagnosticText').innerText(), errors, requests: requests.length }));
      throw error;
    }
    const state = await page.evaluate(() => window.__VL3D_STATE);
    assert.deepEqual(state.physicalTraceShapeIndices, [0, 1], 'UI must highlight connected unnamed source ordinals, not arbitrary shape.id or a disconnected shape');
    assert.equal(state.visiblePinMarkers, 1, 'Physical tracing must preserve the selected module pin marker');
    assert.match(await page.locator('#physicalTraceStatus').innerText(), /Complete within/);
    assert.equal(await page.locator('#cancelPhysicalTraceBtn').isDisabled(), true);
  }
  await tracePin();
  await page.locator('#traceMode').selectOption('named');
  await page.waitForFunction(() => window.__VL3D_STATE?.physicalTraceShapes === 0);
  await page.locator('#fileInput').setInputFiles({ name: 'local-with-no-server-path.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(layout)) });
  await page.waitForFunction(() => window.__VL3D_STATE?.source === 'local-with-no-server-path.json');
  await tracePin();
  async function loadFixture(name, value) {
    await page.locator('#fileInput').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
    await page.waitForFunction((source) => window.__VL3D_STATE?.source === source, name);
  }
  async function chooseDemoPin() {
    await page.locator('.hierarchy-row[data-path="TRACE/ROUTE"] .hierarchy-item').click();
    await page.locator('#traceMode').selectOption('physical');
    await page.locator('#pinList button').filter({ has: page.locator('strong').filter({ hasText: /^IN$/ }) }).click();
  }
  const pathPin = { ...layout, shapes: [box(0, 3, 3.5)], shapeCount: 1,
    pins: [{ terminal: 'EXT', hierPath: 'TOP', layer: 'M1', type: 'path', width: 1, pathStyle: 'extend', beginExt: 0, endExt: 2,
      points: [[1, 0.5], [2, 0.5]], worldBBox: { min: [1, 0], max: [4, 1] } }] };
  await loadFixture('pin-path-extensions.json', pathPin);
  await page.locator('.hierarchy-row.root-row .hierarchy-item').click();
  await page.locator('#traceMode').selectOption('physical');
  await page.locator('#pinList button').first().click();
  await page.waitForFunction(() => window.__VL3D_STATE?.physicalTraceStatus === 'complete' && window.__VL3D_STATE.physicalTraceShapes === 1);
  assert.deepEqual(requests.at(-1).pins, pathPin.pins, 'Trace seeds must preserve the original pin path style, endpoint extensions and figure geometry');

  const demo = JSON.parse(readFileSync(join(root, 'examples/physical-trace-demo.json')));
  await loadFixture('public-physical-demo.json', demo);
  const submitted = page.waitForResponse((response) => response.url().endsWith('/api/traces') && response.request().method() === 'POST');
  await chooseDemoPin();
  const acceptedDemo = await (await submitted).json();
  await page.waitForFunction(() => window.__VL3D_STATE?.physicalTraceStatus === 'complete'
    && window.__VL3D_STATE?.physicalTraceShapes === 8, null, { timeout: 15000 });
  assert.deepEqual((await page.evaluate(() => window.__VL3D_STATE)).physicalTraceShapeIndices, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(requests.at(-1).layout, demo, 'Display layer completion and index decoration must never alter submitted electrical evidence');
  const demoOperation = await (await page.request.get(`http://127.0.0.1:${ready.port}/api/operations/${acceptedDemo.operationId}`)).json();
  assert.equal(demoOperation.result.sourceDigest, createHash('sha256').update(JSON.stringify(demo)).digest('hex'),
    'The source digest must bind the original electrical layout, with unchanged shape ordinals');

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__VL3D_STATE?.physicalTraceShapes === 0
    && window.__VL3D_STATE?.selectedInstances === 0 && window.__VL3D_STATE?.visiblePinMarkers === 0);
  await page.locator('#hierarchyAllBtn').click();
  await page.waitForFunction(() => window.__VL3D_STATE?.selectedInstances === 4
    && window.__VL3D_STATE?.visiblePinMarkers === 7);
  assert.equal(await page.locator('#pinList button').count(), 7, 'Visible selection must list and mark each selected module own pins');

  const cancelledOperations = [];
  page.on('request', (request) => {
    if (request.method() === 'DELETE' && /\/api\/operations\//.test(request.url())) cancelledOperations.push(request.url());
  });
  for (const action of ['Escape', 'Visible']) {
    let releasePoll;
    let markBlocked;
    const blocked = new Promise((resolve) => { markBlocked = resolve; });
    const released = new Promise((resolve) => { releasePoll = resolve; });
    const holdPoll = async (route) => {
      if (route.request().method() === 'GET') {
        markBlocked();
        await released;
      }
      try { await route.continue(); } catch { /* The canceled fetch may already be gone. */ }
    };
    await page.route('**/api/operations/*', holdPoll);
    const previousCancels = cancelledOperations.length;
    await chooseDemoPin();
    await Promise.race([blocked, pause(5000).then(() => { throw new Error('The test did not reach an asynchronous trace poll'); })]);
    await page.waitForFunction(() => window.__VL3D_STATE?.physicalTracePending === true);
    if (action === 'Escape') await page.keyboard.press('Escape');
    else await page.locator('#hierarchyAllBtn').click();
    releasePoll();
    await page.waitForFunction(() => window.__VL3D_STATE?.physicalTracePending === false && window.__VL3D_STATE?.physicalTraceShapes === 0);
    await pause(300);
    await page.unroute('**/api/operations/*', holdPoll);
    const cleared = await page.evaluate(() => window.__VL3D_STATE);
    assert.equal(cleared.physicalTraceShapes, 0, `${action} must invalidate results that arrive after the selection changes`);
    assert.equal(cleared.physicalTraceStatus, '');
    assert(cancelledOperations.length > previousCancels, `${action} must cancel the backend operation as well as clear the visual result`);
    assert.equal(cleared.visiblePinMarkers, action === 'Escape' ? 0 : 7);
  }

  const undeclaredVia = { ...layout, layers: [
    { name: 'M1', kind: 'metal', routing: true }, { name: 'V1', kind: 'via', routing: true },
    { name: 'M2', kind: 'metal', routing: true },
  ], shapes: ['M1', 'V1', 'M2'].map((layer, index) => ({ ...box(index + 20, 0, 1), layer })) };
  await loadFixture('via-without-endpoints.json', undeclaredVia);
  await page.locator('.hierarchy-row.root-row .hierarchy-item').click();
  await page.locator('#traceMode').selectOption('physical');
  await page.locator('#pinList button').first().click();
  await page.waitForFunction(() => window.__VL3D_STATE?.physicalTraceStatus === 'limited'
    && window.__VL3D_STATE?.physicalTracePending === false, null, { timeout: 15000 });
  const conservative = await page.evaluate(() => window.__VL3D_STATE);
  assert.deepEqual(conservative.physicalTraceShapeIndices, [0], 'A VIA without declared endpoints must not gain a physical connection from display name inference');
  assert.match(await page.locator('#physicalTraceDiagnosticText').textContent(), /endpoints are missing/);
  assert.deepEqual(requests.at(-1).layout, undeclaredVia);

  assert(requests.length >= 2);
  for (const request of requests) {
    assert(request.layout?.shapes, 'Local browser files must submit their actual layout');
    assert.equal(request.path, undefined, 'A browser filename must never be sent as a server path');
  }
  assert.deepEqual(errors, []);
  console.log('Physical trace browser flow passed: source evidence/digest preservation, public demo complete8, undeclared VIA exclusion, Escape/Visible cancellation, stale result suppression, pin markers, unnamed contacts and local upload');
} finally {
  if (browser) await browser.close();
  child.kill('SIGTERM');
  for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt += 1) await pause(20);
  if (child.exitCode === null) child.kill('SIGKILL');
  rmSync(directory, { recursive: true, force: true });
}
