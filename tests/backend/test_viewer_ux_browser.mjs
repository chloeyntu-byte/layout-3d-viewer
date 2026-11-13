import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = mkdtempSync(join(tmpdir(), 'vl3d-ux-browser-'));
const dataDirectory = join(directory, 'data');
mkdirSync(dataDirectory);
const outputDirectory = process.env.VL3D_UX_OUTPUT || join(directory, 'screenshots');
mkdirSync(outputDirectory, { recursive: true });
const demo = JSON.parse(readFileSync(join(root, 'examples/physical-trace-demo.json')));
writeFileSync(join(dataDirectory, 'demo.json'), JSON.stringify(demo));
writeFileSync(join(dataDirectory, 'manifest.json'), JSON.stringify({ schemaVersion: 2, cells: [] }));
const child = spawn(process.execPath, [join(root, 'tools/server.mjs'), '--root', root, '--host', '127.0.0.1', '--port', '0',
  '--data-dir', dataDirectory, '--state-dir', join(directory, 'state')], { stdio: ['ignore', 'pipe', 'pipe'] });
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
let output = '', browser;
child.stdout.on('data', (value) => { output += value; }); child.stderr.on('data', (value) => { output += value; });
try {
  let ready;
  for (let attempt = 0; attempt < 400 && !ready; attempt += 1) {
    const line = output.split('\n').find((value) => value.startsWith('VL3D_READY '));
    if (line) ready = JSON.parse(line.slice(11)); else if (child.exitCode !== null) throw new Error(output); else await pause(25);
  }
  assert(ready, output);
  const executablePath = [process.env.CHROMIUM_BIN, '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome', '/opt/google/chrome/chrome'].filter(Boolean)
    .find((candidate) => { try { accessSync(candidate, constants.X_OK); return true; } catch { return false; } });
  assert(executablePath, 'An existing Chromium executable is required');
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [], evidence = { screenshots: [], bounds: [] };
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${ready.port}`);
  await page.waitForFunction(() => window.__VL3D_APP_BOOTING === false);
  assert.equal(await page.locator('#sceneGuide').isVisible(), true);
  assert.equal(await page.locator('#cellSelect').isVisible(), false);
  await page.screenshot({ path: join(outputDirectory, 'web-empty-1440.png') });
  await page.locator('#loadLibraryBtn').click();
  assert.equal(await page.locator('#loadSourceKind').inputValue(), 'browser');
  assert.equal(await page.locator('#advancedSettings').isVisible(), false);
  await page.locator('#loadExampleBtn').click();
  await page.waitForFunction(() => window.__VL3D_STATE?.cell === 'TRACE');
  assert.equal(await page.locator('#traceMode').inputValue(), 'physical');
  await page.locator('.hierarchy-row[data-path="TRACE/ROUTE"] .hierarchy-item').click();
  const cameraBefore = await page.evaluate(() => window.__VL3D_STATE.camera);
  const pinPoint = await page.evaluate(() => window.__VL3D_PIN_SCREEN_POINTS().find((pin) => pin.terminal === 'IN'));
  await page.mouse.move(pinPoint.x, pinPoint.y);
  await page.waitForFunction(() => /^IN\nTRACE\/ROUTE/.test(document.querySelector('#scene').title));
  await page.mouse.click(pinPoint.x, pinPoint.y);
  await page.waitForFunction(() => window.__VL3D_STATE?.selectedPin?.terminal === 'IN');
  assert.equal((await page.evaluate(() => window.__VL3D_STATE.selectedPin)).figureIndex, pinPoint.figureIndex, 'Clicking a pin dot must select that source figure');
  await page.waitForFunction(() => window.__VL3D_STATE?.physicalTraceStatus === 'complete' && window.__VL3D_STATE.physicalTraceShapes === 8);
  assert.deepEqual(await page.evaluate(() => window.__VL3D_STATE.camera), cameraBefore, 'Single pin selection must not move the camera');
  const chosen = await page.evaluate(() => window.__VL3D_STATE.selectedPin);
  const raw = demo.pins.find((pin) => pin.terminal === 'IN' && pin.hierPath === 'TRACE/ROUTE');
  assert.deepEqual(chosen.bbox, raw.worldBBox || raw.bbox);
  assert.match(await page.locator('#pinAnnotation').innerText(), /IN/);
  await page.locator('[data-action="fit-record"]').click();
  await pause(200);
  assert.notDeepEqual(await page.evaluate(() => window.__VL3D_STATE.camera), cameraBefore, 'Locate pin is an explicit camera action');
  await page.locator('#backViewBtn').click();
  await pause(200);
  const restored = await page.evaluate(() => window.__VL3D_STATE.camera);
  for (const key of ['position', 'target']) restored[key].forEach((value, index) => assert(Math.abs(value - cameraBefore[key][index]) < 1e-8));
  await page.locator('[data-action="fit-nets"]').click();
  const otherPoint = await page.evaluate(() => window.__VL3D_PIN_SCREEN_POINTS().find((pin) => pin.terminal === 'UP'));
  await page.mouse.move(otherPoint.x, otherPoint.y); await page.mouse.down();
  await page.mouse.move(otherPoint.x + 40, otherPoint.y + 35, { steps: 6 }); await page.mouse.up();
  await page.waitForFunction(() => window.__VL3D_STATE?.fastMode === false);
  assert.equal((await page.evaluate(() => window.__VL3D_STATE.selectedPin)).terminal, 'IN', 'Dragging from a different pin must navigate, not select the pin at release');
  await page.locator('#fitBtn').click();
  await page.locator('[data-action="fit-nets"]').click();
  await page.locator('#wireToggle').uncheck();
  assert.match(await page.locator('#hiddenRoutesNote').innerText(), /8 hidden/);
  await page.locator('#wireToggle').check();
  assert.doesNotMatch(await page.locator('#hiddenRoutesNote').innerText(), /hidden/);

  async function screenshotSize(width, height) {
    await page.setViewportSize({ width, height });
    await pause(250);
    if (width <= 900 && await page.locator('#pinsTab').getAttribute('aria-pressed') !== 'true') await page.locator('#pinsTab').click();
    await page.locator('#pinSearch').scrollIntoViewIfNeeded();
    const bounds = await page.evaluate(() => {
      const box = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
      return { viewport: box('viewport'), toolbar: document.querySelector('.topbar').getBoundingClientRect().toJSON(), pinSearch: box('pinSearch'), app: box('app'), state: window.__VL3D_STATE.viewport };
    });
    assert(bounds.viewport.width >= (width > 900 ? 400 : width - 20), JSON.stringify(bounds));
    assert(bounds.viewport.height >= 125, JSON.stringify(bounds));
    assert(bounds.viewport.y >= bounds.toolbar.bottom - 1, 'Toolbar and viewport must not overlap');
    assert(bounds.viewport.bottom <= height, 'Viewport must remain inside the window');
    assert(bounds.pinSearch.x >= 0 && bounds.pinSearch.right <= width + 1 && bounds.pinSearch.y >= 0 && bounds.pinSearch.bottom <= height,
      'Pin search must remain reachable without covering the viewport');
    const actionable = await page.locator('#selectionActions button').evaluateAll((elements) => elements.map((element) => ({ text: element.textContent, width: element.clientWidth, scroll: element.scrollWidth })));
    for (const button of actionable) assert(button.scroll <= button.width + 1, `Action label is clipped: ${JSON.stringify(button)}`);
    if (width <= 900) {
      await page.locator('#pinList .pin-row').first().scrollIntoViewIfNeeded();
      assert.equal(await page.locator('#pinList .pin-row').first().isVisible(), true);
    }
    const file = `web-trace-${width}x${height}.png`;
    await page.screenshot({ path: join(outputDirectory, file) });
    evidence.screenshots.push(file); evidence.bounds.push({ width, height, ...bounds });
    if (width <= 900) {
      const before = bounds.viewport.height;
      await page.locator('#pinsTab').click();
      await pause(100);
      assert(await page.locator('#viewport').evaluate((element) => element.clientHeight) > before, 'Collapsing the dock must return space to the viewport');
      await page.locator('#pinsTab').click();
      await page.locator('#tracePhysicalBtn').scrollIntoViewIfNeeded();
      const traceRect = await page.locator('#tracePhysicalBtn').boundingBox();
      assert(traceRect.y >= 0 && traceRect.y + traceRect.height <= height, 'Trace action must be reachable in the scrollable dock');
      await page.locator('#pinList .pin-row').first().scrollIntoViewIfNeeded();
    }
  }
  for (const size of [[1440, 900], [1040, 768], [740, 600], [390, 700]]) await screenshotSize(...size);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press('Escape');
  await page.locator('.hierarchy-row[data-path="TRACE/ROUTE"] input[type="checkbox"]').check();
  assert.equal(await page.locator('#pinList .pin-row').count(), 2, 'A first checkbox selection must list its own pins');
  await page.locator('.hierarchy-row[data-path="TRACE/CONTACT"] input[type="checkbox"]').check();
  assert.equal(await page.locator('#pinList .pin-row').count(), 3, 'Checkbox additions must aggregate each module own pins');
  await page.locator('.hierarchy-row[data-path="TRACE/ROUTE"] input[type="checkbox"]').uncheck();
  assert.equal(await page.locator('#pinList .pin-row').count(), 1, 'Removing the active module must keep the remaining selected module pins reachable');
  // Unified find box: a pin in another module replaces the module scope; Escape only closes the list;
  // a result is reachable by a native click; options are announced through aria-activedescendant.
  await page.locator('#findAll').fill('IN');
  await page.waitForSelector('#findResults .find-row');
  assert.equal(await page.locator('#findAll').getAttribute('aria-activedescendant'), 'find-option-0');
  await page.keyboard.press('Enter');
  await pause(900);
  let found = await page.evaluate(() => window.__VL3D_STATE);
  assert.equal(found.selectedPin?.terminal, 'IN', 'Enter in the find box selects the best pin match');
  assert.equal(found.selectedInstances, 0, 'A found pin replaces the previous module scope');
  assert(await page.locator('#pinList .pin-row').count() >= 1, 'The found pin scope lists its pins');
  await page.locator('#findAll').fill('IN');
  await page.waitForSelector('#findResults .find-row');
  await page.keyboard.press('Escape');
  found = await page.evaluate(() => window.__VL3D_STATE);
  assert.equal(found.selectedPin?.terminal, 'IN', 'Escape in the find box must not clear the current selection');
  assert.equal(await page.locator('#findResults').isHidden(), true);
  await page.locator('#findAll').fill('CONTACT');
  await page.locator('#findResults .find-row.kind-module').first().click();
  await pause(900);
  assert.equal((await page.evaluate(() => window.__VL3D_STATE)).selectedInstances, 1, 'Clicking a module result selects that module');
  await page.locator('#viewTopBtn').click();
  await pause(150);
  const topCamera = (await page.evaluate(() => window.__VL3D_STATE)).camera;
  await pause(800);
  assert.deepEqual((await page.evaluate(() => window.__VL3D_STATE)).camera, topCamera, 'A view preset cancels a running camera flight');
  await page.locator('#hierarchyAllBtn').click();
  assert.match(await page.locator('#pinCountNote').innerText(), /7/);
  await page.locator('#pinSearch').fill('TRACE/REMOTE');
  assert.equal((await page.evaluate(() => window.__VL3D_STATE)).selectedInstances, 4, 'Pin filtering must not alter module scope');
  for (const text of await page.locator('#pinList .pin-row').allTextContents()) assert.match(text, /TRACE\/REMOTE/);
  await page.locator('#pinSearch').fill('');

  for (const units of ['nm', 'dbu', null, '', 1000]) {
    await page.locator('#fileInput').setInputFiles({ name: `invalid-units-${String(units)}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...demo, units })) });
    await page.waitForFunction(() => /requires micrometre/.test(document.querySelector('#pickInfo').textContent));
    assert.equal((await page.evaluate(() => window.__VL3D_STATE)).source, 'physical-trace-demo.json', 'Invalid units must preserve the loaded layout');
  }
  for (const units of ['um', ' µm ', 'μm']) {
    const name = `micrometre-${units.trim()}.json`;
    await page.locator('#fileInput').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...demo, units })) });
    await page.waitForFunction((source) => window.__VL3D_STATE?.source === source, name);
  }
  // A terminal with several figures keeps its exact name and independent source identities.
  const many = structuredClone(demo);
  const longName = 'PORT<255:0> / exact original pin name and spelling '.repeat(4);
  many.pins = Array.from({ length: 305 }, (_, index) => ({ ...raw, terminal: index < 2 ? longName : `PIN_${index}`, net: '', hierPath: 'TRACE/ROUTE' }));
  many.pinCount = many.pins.length;
  await page.locator('#fileInput').setInputFiles({ name: 'many-pins.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(many)) });
  await page.waitForFunction(() => window.__VL3D_STATE?.source === 'many-pins.json');
  await page.locator('.hierarchy-row[data-path="TRACE/ROUTE"] .hierarchy-item').click();
  await page.locator('#traceMode').selectOption('named');
  await page.locator('#pinSearch').fill('PIN_304');
  assert.equal(await page.locator('#pinList .pin-row').count(), 1);
  await page.locator('#pinSearch').fill('PORT<255:0>');
  assert.equal(await page.locator('#pinList .pin-row').count(), 2);
  assert.deepEqual(await page.locator('#pinList .pin-row strong').allTextContents(), [longName, longName]);
  await page.locator('#pinList .pin-row').last().click();
  await page.waitForFunction(() => window.__VL3D_STATE?.selectedPin?.figureIndex === 1);
  assert.equal((await page.evaluate(() => window.__VL3D_STATE.selectedPin)).figureIndex, 1);
  assert.match(await page.locator('#pinList .pin-row').last().innerText(), /Figure 2\/2/);
  assert(await page.locator('#pinAnnotation').evaluate((element) => element.getBoundingClientRect().height) <= 152, 'Long pin labels must not cover the routing view');
  assert.equal(await page.locator('#pinAnnotation').getAttribute('title'), `${longName}\nTRACE/ROUTE · M1`);
  assert.match(await page.locator('#pinAnnotation').innerText(), /Long name shortened/);
  await page.screenshot({ path: join(outputDirectory, 'web-long-pins.png') });

  // Required OA information and ambiguous sources must be completed in Load, without visiting Advanced.
  let sessions = 0;
  const sessionPayload = { sessionId: 'a'.repeat(48), library: { name: 'DEMO', path: '/synthetic/library' },
    layouts: [{ key: 'DEMO/TRACE/layout', library: 'DEMO', cell: 'TRACE', view: 'layout', sourceType: 'oa', cacheState: 'ready',
      entry: { library: 'DEMO', cell: 'TRACE', view: 'layout', path: 'data/demo.json' } }], resolved: { cdsLib: '/synthetic/cds.lib', cadenceEnv: '' },
    warnings: [{ code: 'VL3D-E2009', message: 'Cadence environment script is required for a fresh export' }] };
  await page.route('**/api/library-sessions', async (route) => {
    sessions += 1;
    const body = route.request().postDataJSON();
    if (sessions > 1) assert.equal(body.overrides.libraryName, 'DEMO');
    await route.fulfill({ status: sessions === 1 ? 409 : 201, contentType: 'application/json', body: JSON.stringify(sessions === 1
      ? { error: { code: 'VL3D-E2008', message: 'Several libraries found', details: { candidates: [{ name: 'DEMO', path: '/synthetic/library/DEMO' }, { name: 'OTHER', path: '/synthetic/library/OTHER' }] } } }
      : sessionPayload) });
  });
  await page.locator('#loadLibraryBtn').click();
  await page.locator('#loadSourceKind').selectOption('oa');
  await page.locator('#libraryPathInput').fill('/synthetic/library');
  await page.locator('#applyLibraryBtn').click();
  await page.waitForSelector('#loadCandidates:not([hidden])');
  await page.locator('#applyLoadCandidateBtn').click();
  await page.waitForFunction(() => document.querySelector('#cadenceRequirement').open);
  assert.equal(await page.locator('#cadenceInputStatus').innerText(), 'Needs input');
  assert.equal(await page.locator('#advancedSettings').getAttribute('open'), null);
  assert.equal(await page.locator('#cadenceEnvInput').isVisible(), true);
  assert.equal(await page.locator('#loadCellFields').isVisible(), true);
  assert.equal(await page.locator('#libraryNameInput').inputValue(), '', 'A candidate choice must not silently become a persistent Advanced override');
  await page.screenshot({ path: join(outputDirectory, 'web-load-required.png') });
  await page.locator('#cancelLibraryBtn').click();
  await page.unroute('**/api/library-sessions');

  // Real server-local JSON import exercises the same API used by GDS/OAS; a browser filename is never substituted.
  await page.locator('#loadLibraryBtn').click();
  await page.locator('#loadSourceKind').selectOption('stream');
  await page.locator('#streamPathInput').fill(join(root, 'examples/physical-trace-demo.json'));
  const importRequest = page.waitForRequest((request) => request.url().endsWith('/api/streams/import') && request.method() === 'POST');
  await page.locator('#applyLibraryBtn').click();
  assert.equal((await importRequest).postDataJSON().path, join(root, 'examples/physical-trace-demo.json'));
  await page.waitForFunction((source) => window.__VL3D_STATE?.source === source, join(root, 'examples/physical-trace-demo.json'), { timeout: 30000 });
  assert.equal(await page.locator('#libraryDialog').isVisible(), false);
  const importSource = join(root, 'examples/physical-trace-demo.json');
  // An asynchronous import failure must return control to the main Load fields.
  await page.route('**/api/streams/import', (route) => route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ operationId: 'failed-import', state: 'running' }) }));
  await page.route('**/api/operations/failed-import', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'failed', error: { code: 'VL3D-E6006', message: 'A layer map is needed for this source' } }) }));
  await page.locator('#loadLibraryBtn').click();
  await page.locator('#applyLibraryBtn').click();
  await page.waitForFunction(() => /JSON keeps/.test(document.querySelector('#libraryDialogMessage').textContent));
  assert.equal(await page.locator('#loadingOverlay').isVisible(), false, 'A failed import must remove the loading overlay');
  assert.equal(await page.locator('#layerMapRequirement').isVisible(), false, 'JSON must not suggest an unsupported mapping retry');
  assert.equal(await page.locator('#pdkRequirement').isVisible(), false);
  assert.equal((await page.evaluate(() => window.__VL3D_STATE)).source, importSource);
  await page.locator('#cancelLibraryBtn').click();
  await page.unroute('**/api/streams/import'); await page.unroute('**/api/operations/failed-import');
  let releaseSubmit, markSubmitted;
  const submittedImport = new Promise((resolve) => { markSubmitted = resolve; });
  const releaseImport = new Promise((resolve) => { releaseSubmit = resolve; });
  const cancelled = [];
  await page.route('**/api/streams/import', async (route) => {
    markSubmitted(); await releaseImport;
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ operationId: 'cancel-import', state: 'running' }) });
  });
  await page.route('**/api/operations/cancel-import', async (route) => {
    cancelled.push(route.request().method());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'cancelled' }) });
  });
  await page.locator('#loadLibraryBtn').click(); await page.locator('#applyLibraryBtn').click(); await submittedImport;
  await page.locator('#cancelLoadBtn').click(); releaseSubmit();
  for (let attempt = 0; attempt < 100 && !cancelled.includes('DELETE'); attempt += 1) await pause(20);
  assert.deepEqual(cancelled, ['DELETE'], 'Cancel during import submission must cancel the eventual remote operation, with no stale poll');
  assert.equal((await page.evaluate(() => window.__VL3D_STATE)).source, importSource);
  assert.equal(await page.locator('#loadingOverlay').isVisible(), false);
  await page.unroute('**/api/streams/import'); await page.unroute('**/api/operations/cancel-import');
  assert.deepEqual(errors, []);
  writeFileSync(join(outputDirectory, 'web-ux-evidence.json'), JSON.stringify({ ...evidence, errors, completed: true }, null, 2));
  console.log('Viewer UX browser passed: real example/import, required OA inputs/candidates, camera preservation/history, exact multi-figure pins/search, hidden-route legend and four viewport sizes');
} catch (error) {
  console.error(output);
  if (browser) {
    for (const context of browser.contexts()) for (const page of context.pages()) {
      console.error(JSON.stringify(await page.evaluate(() => ({ state: window.__VL3D_STATE, message: document.querySelector('#libraryDialogMessage')?.textContent, text: document.body.innerText.slice(-5000) }))));
      await page.screenshot({ path: join(outputDirectory, 'web-ux-failed.png') }).catch(() => {});
    }
  }
  throw error;
} finally {
  await browser?.close(); child.kill('SIGTERM'); await pause(150); if (child.exitCode === null) child.kill('SIGKILL'); rmSync(directory, { recursive: true, force: true });
}
