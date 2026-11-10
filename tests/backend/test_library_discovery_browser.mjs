import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = mkdtempSync(join(tmpdir(), 'vl3d-library-browser-'));
const library = join(directory, 'LIB');
const names = ['Z', 'A.bak-not-a-date', 'A.bak-20261003', 'A.bak-20261003-145044'];
for (const name of names) {
  const view = join(library, name, 'layout');
  mkdirSync(view, { recursive: true });
  writeFileSync(join(view, 'layout.oa'), 'discovery-only fixture; never opened or exported');
}
writeFileSync(join(directory, 'cds.lib'), 'DEFINE LIB ./LIB\n');
mkdirSync(join(directory, 'data'));
writeFileSync(join(directory, 'data/manifest.json'), JSON.stringify({ schemaVersion: 2, cells: [] }));
const child = spawn(process.execPath, [join(root, 'tools/server.mjs'), '--root', root,
  '--host', '127.0.0.1', '--port', '0', '--enable-oa', '--data-dir', join(directory, 'data'),
  '--state-dir', join(directory, 'state')], { stdio: ['ignore', 'pipe', 'pipe'] });
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
let output = '', browser;
child.stdout.on('data', (value) => { output += value; });
child.stderr.on('data', (value) => { output += value; });
try {
  let ready;
  for (let attempt = 0; attempt < 400 && !ready; attempt += 1) {
    const line = output.split('\n').find((value) => value.startsWith('VL3D_READY '));
    if (line) ready = JSON.parse(line.slice(11));
    else if (child.exitCode !== null) throw new Error(output);
    else await pause(25);
  }
  assert(ready, output);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN || '/usr/bin/chromium-browser',
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1040, height: 768 } });
  const evidence = { console: [], pageErrors: [], requestFailures: [], httpErrors: [] };
  page.on('console', (message) => { if (message.type() === 'error') evidence.console.push(message.text()); });
  page.on('pageerror', (error) => evidence.pageErrors.push(String(error)));
  page.on('requestfailed', (request) => evidence.requestFailures.push({ url: request.url(), error: request.failure() }));
  page.on('response', (response) => { if (response.status() >= 400) evidence.httpErrors.push({ url: response.url(), status: response.status() }); });
  await page.goto(`http://127.0.0.1:${ready.port}`);
  await page.waitForFunction(() => window.__VL3D_APP_BOOTING === false);
  await page.locator('#loadLibraryBtn').click();
  await page.locator('#loadSourceKind').selectOption('oa');
  await page.locator('#libraryPathInput').fill(library);
  await page.locator('#libraryPathInput').press('Enter');
  await page.waitForFunction(() => document.querySelector('#loadCellSelect')?.options.length === 5);
  const options = await page.locator('#loadCellSelect option').evaluateAll((items) => items.slice(1)
    .map((item) => ({ value: item.value, label: item.textContent })));
  assert.deepEqual(options.slice(0, 2).map((item) => item.value), ['LIB/A.bak-not-a-date/layout', 'LIB/Z/layout']);
  assert.deepEqual(new Set(options.slice(2).map((item) => item.value)),
    new Set(['LIB/A.bak-20261003/layout', 'LIB/A.bak-20261003-145044/layout']));
  assert(options.slice(0, 2).every((item) => !item.label.includes(' · Backup')));
  assert(options.slice(2).every((item) => item.label.includes(' · Backup')));
  const backupKey = options[3].value;
  await page.locator('#loadCellSelect').selectOption(backupKey);
  assert.equal(await page.locator('#cellSelect').inputValue(), backupKey,
    'The visible backup label must not replace its real OA selection identity');
  assert.equal(await page.locator('#loadChosenCellBtn').isEnabled(), true);
  if (process.env.VL3D_DISCOVERY_OUTPUT) {
    mkdirSync(process.env.VL3D_DISCOVERY_OUTPUT, { recursive: true });
    await page.screenshot({ path: join(process.env.VL3D_DISCOVERY_OUTPUT, 'backup-choice.png') });
    writeFileSync(join(process.env.VL3D_DISCOVERY_OUTPUT, 'browser-evidence.json'), JSON.stringify({ options, ...evidence }, null, 2));
  }
  assert.deepEqual(evidence, { console: [], pageErrors: [], requestFailures: [], httpErrors: [] });
  console.log('Library discovery browser test passed: backup labels/order/identity and no browser errors');
} finally {
  if (browser) await browser.close();
  child.kill('SIGTERM');
  await pause(100);
  if (child.exitCode === null) child.kill('SIGKILL');
  rmSync(directory, { recursive: true, force: true });
}
