#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { ERROR_CATALOG, errorPayload, getErrorDefinition, normalizeError } from './error_catalog.mjs';
import { INSTALL_ROOT, auditRuntimeCache, buildNativePlan, buildSetupConfig, buildStartPlan, defaultNativeVenv, nativeBootstrapPackages, parseCli, resolveConfiguration, resolveNativePython, runDoctor } from './vl3d.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(repository, 'tools', 'vl3d.mjs');
const bootstrapPath = join(repository, 'bin', 'vl3d');

function write(path, content, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode });
}

function executable(path, output = '') {
  write(path, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(output)}\n`, 0o755);
  chmodSync(path, 0o755);
  return path;
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolvePort(port));
    });
  });
}

function occupiedPort() {
  return new Promise((resolveServer, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveServer(server));
  });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'vl3d-doctor-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const bin = join(root, 'bin');
  const library = join(project, 'DEMO');
  mkdirSync(join(library, 'inv', 'layout'), { recursive: true });
  mkdirSync(join(project, 'public'), { recursive: true });
  write(join(project, 'tools', 'server.mjs'), 'process.exit(0);\n');
  write(join(project, 'public', 'index.html'), '<!doctype html>\n');
  write(join(project, 'public', 'vendor', 'three.core.min.js'), 'export const REVISION = "test";\n');
  write(join(project, 'public', 'vendor', 'three.module.min.js'), 'export const REVISION = "test";\n');
  write(join(project, 'cds.lib'), 'DEFINE DEMO ./DEMO\n');
  write(join(project, 'cadence_env.sh'), 'export DEMO_PDK=1\n', 0o700);
  const tools = {
    python: executable(join(bin, 'python3'), 'Python 3.11.9'),
    chromium: executable(join(bin, 'chromium'), 'Chromium'),
    firefox: executable(join(bin, 'firefox'), 'Firefox'),
    zenity: executable(join(bin, 'zenity'), 'Zenity'),
    xprop: executable(join(bin, 'xprop'), 'xprop'),
    klayout: executable(join(bin, 'klayout'), 'KLayout 0.29.12'),
    virtuoso: executable(join(bin, 'virtuoso'), 'Virtuoso'),
  };
  mkdirSync(home, { recursive: true });
  const environment = {
    HOME: home,
    PATH: bin,
    DISPLAY: ':99',
    CDS_LIC_FILE: '/tmp/example-license.dat',
  };
  return { root, home, project, bin, library, tools, environment };
}

function userConfigPath(fixtureState) {
  return join(fixtureState.home, '.config', 'vl3d', 'config.json');
}

function validRuntimeCache(fixtureState) {
  const dataRoot = join(fixtureState.home, '.cache', 'vl3d', 'data');
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  chmodSync(dataRoot, 0o700);
  const layout = {
    schemaVersion: 3,
    library: 'DEMO',
    cell: 'inv',
    view: 'layout',
    shapes: [],
    instances: [],
  };
  const layoutBytes = Buffer.from(`${JSON.stringify(layout)}\n`);
  const relativePath = 'data/DEMO@inv@layout.json';
  write(join(dataRoot, 'DEMO@inv@layout.json'), layoutBytes, 0o600);
  write(join(dataRoot, 'DEMO@inv@layout.json.gz'), gzipSync(layoutBytes), 0o600);
  const manifest = {
    schemaVersion: 2,
    generatedAt: new Date(0).toISOString(),
    cells: [{ library: 'DEMO', cell: 'inv', view: 'layout', path: relativePath }],
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  write(join(dataRoot, 'manifest.json'), manifestBytes, 0o600);
  write(join(dataRoot, 'manifest.json.gz'), gzipSync(manifestBytes), 0o600);
  return { dataRoot, layoutPath: join(dataRoot, 'DEMO@inv@layout.json'), manifestBytes };
}

function runCli(args, environment, cwd = repository) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: environment,
    cwd,
  });
}

const codes = ERROR_CATALOG.map((entry) => entry.code);
assert.equal(new Set(codes).size, codes.length);
assert.deepEqual([...new Set(ERROR_CATALOG.map((entry) => entry.category))], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
assert.equal(getErrorDefinition('e2012').code, 'VL3D-E2012');
assert.equal(getErrorDefinition('VL3D-E2012').shortCode, 'E2012');
assert.equal(normalizeError({ code: 'E2012', message: 'busy', details: { port: 1 } }).details.port, 1);
assert.deepEqual(errorPayload({ code: 'E2012', message: 'busy' }).error.code, 'VL3D-E2012');
assert.equal(parseCli([]).command, 'gui');
assert.equal(parseCli(['web']).command, 'web');
assert.deepEqual(nativeBootstrapPackages('3.6.8'), ['pip==21.3.1', 'setuptools==59.6.0', 'wheel==0.37.1']);
assert.deepEqual(nativeBootstrapPackages('3.13.12'), ['pip>=24,<27', 'setuptools>=68,<83', 'wheel>=0.42,<1']);

const unrelated = fixture();
const unrelatedPort = await freePort();
const unrelatedCwd = join(unrelated.root, 'unrelated-cwd');
mkdirSync(unrelatedCwd);
write(join(unrelated.home, 'cadence_env.sh'), `#!/bin/sh\ntouch ${JSON.stringify(join(unrelated.root, 'adapter-ran'))}\n`, 0o700);
const unrelatedEnvironment = { ...unrelated.environment };
delete unrelatedEnvironment.CDS_LIC_FILE;
const unrelatedLaunch = runCli(['doctor', '--json', '--no-oa', '--port', String(unrelatedPort)], unrelatedEnvironment, unrelatedCwd);
assert.equal(unrelatedLaunch.status, 0, unrelatedLaunch.stderr);
const unrelatedReport = JSON.parse(unrelatedLaunch.stdout);
assert.equal(unrelatedReport.paths.projectRoot, INSTALL_ROOT);
assert.equal(unrelatedReport.issues.some((issue) => issue.code === 'VL3D-E2020' || issue.code === 'VL3D-E2021'), false);
assert.equal(unrelatedReport.issues.some((issue) => ['VL3D-E2003', 'VL3D-E2009', 'VL3D-E1009'].includes(issue.code)), false);
assert.equal(existsSync(join(unrelated.root, 'adapter-ran')), false);
const bootstrapEnvironment = { ...unrelatedEnvironment, PATH: '/usr/bin:/bin', VL3D_NODE: process.execPath };
const bootstrapLaunch = spawnSync(bootstrapPath, ['doctor', '--json', '--no-oa', '--port', String(await freePort())], {
  cwd: unrelatedCwd,
  env: bootstrapEnvironment,
  encoding: 'utf8',
});
assert.equal(bootstrapLaunch.status, 0, bootstrapLaunch.stderr);
assert.equal(JSON.parse(bootstrapLaunch.stdout).paths.projectRoot, INSTALL_ROOT);

const nodeMissingBin = join(unrelated.root, 'node-missing-bin');
mkdirSync(nodeMissingBin);
symlinkSync('/usr/bin/python3', join(nodeMissingBin, 'python3'));
const nodeMissing = spawnSync(bootstrapPath, ['doctor', '--json'], {
  cwd: unrelatedCwd,
  env: { HOME: unrelated.home, PATH: nodeMissingBin, LANG: 'C', LC_ALL: 'C' },
  encoding: 'utf8',
});
assert.equal(nodeMissing.status, 2, nodeMissing.stderr);
assert.equal(JSON.parse(nodeMissing.stderr).error.code, 'VL3D-E1001');

const missingTk = fixture();
const missingTkSetup = runCli([
  'setup', '--json', '--install', '--no-oa', '--root', missingTk.project,
  '--python', missingTk.tools.python, '--venv', join(missingTk.root, 'native-venv'),
], missingTk.environment);
assert.equal(missingTkSetup.status, 2, missingTkSetup.stderr);
assert.equal(JSON.parse(missingTkSetup.stderr).error.code, 'VL3D-E1012');

const configuredNative = fixture();
const configuredVenv = join(configuredNative.root, 'private-native');
mkdirSync(join(configuredVenv, 'bin'), { recursive: true });
symlinkSync(configuredNative.tools.python, join(configuredVenv, 'bin', 'python'));
write(join(configuredVenv, 'pyvenv.cfg'), 'include-system-site-packages = true\n');
write(userConfigPath(configuredNative), JSON.stringify({
  schemaVersion: 1,
  native: { nativePython: join(configuredVenv, 'bin', 'python'), venv: configuredVenv },
}), 0o600);
const configuredCli = parseCli(['doctor', '--root', configuredNative.project, '--no-oa', '--port', String(await freePort())]);
const configuredResolved = await resolveConfiguration(configuredCli, { env: configuredNative.environment, cwd: configuredNative.project });
assert.equal(resolveNativePython({ internal: configuredResolved }, configuredCli).venvDirectory, configuredVenv);
const configuredDoctor = await runDoctor(configuredCli, { env: configuredNative.environment, cwd: configuredNative.project });
assert.equal(configuredDoctor.ready.native, false);
assert.equal(configuredDoctor.checks.find((check) => check.id === 'native-runtime').value.missing.includes('venv-isolation'), true);

const first = fixture();
write(join(first.project, 'vl3d.config.json'), JSON.stringify({ schemaVersion: 1, port: 41004 }));
write(userConfigPath(first), JSON.stringify({ schemaVersion: 1, port: 41003, tools: { browser: first.tools.firefox } }), 0o600);
const cliPort = await freePort();
const cli = parseCli(['doctor', '--root', first.project, '--port', String(cliPort), '--python', first.tools.python]);
const precedence = await resolveConfiguration(cli, { env: { ...first.environment, VL3D_PORT: '41002' }, cwd: first.project });
assert.equal(precedence.effective.port, cliPort);
assert.equal(precedence.selected.port.source, 'command-line');
assert.equal(precedence.tools.python.source, 'command-line');
const environmentPrecedence = await resolveConfiguration(parseCli(['doctor', '--root', first.project]), { env: { ...first.environment, VL3D_PORT: '41002' }, cwd: first.project });
assert.equal(environmentPrecedence.effective.port, 41002);
assert.equal(environmentPrecedence.selected.port.source, 'environment:VL3D_PORT');
const userPrecedence = await resolveConfiguration(parseCli(['doctor', '--root', first.project]), { env: first.environment, cwd: first.project });
assert.equal(userPrecedence.effective.port, 41003);
assert.equal(userPrecedence.selected.port.source, 'user-config');
renameSync(userConfigPath(first), `${userConfigPath(first)}.disabled`);
const projectPrecedence = await resolveConfiguration(parseCli(['doctor', '--root', first.project]), { env: first.environment, cwd: first.project });
assert.equal(projectPrecedence.effective.port, 41004);
assert.equal(projectPrecedence.selected.port.source, 'project-config');

const managedNativePython = join(defaultNativeVenv(first.environment, first.home), 'bin', 'python');
mkdirSync(dirname(managedNativePython), { recursive: true });
symlinkSync(first.tools.python, managedNativePython);
const doctorPort = await freePort();
const doctor = await runDoctor(parseCli(['doctor', '--root', first.project, '--port', String(doctorPort), '--cadence-env', join(first.project, 'cadence_env.sh')]), { env: first.environment, cwd: first.project });
assert.equal(doctor.ok, true);
assert.deepEqual(doctor.ready, { native: false, viewer: true, oa: true, stream: true, graphicalPicker: true });
assert.equal(doctor.checks.some((check) => check.id === 'runtime-cache' && check.status === 'pass'), true);
assert.equal(doctor.internal.effective.cdsLib, join(first.project, 'cds.lib'));
assert.equal(doctor.internal.effective.cadenceEnv, join(first.project, 'cadence_env.sh'));
assert.equal(doctor.internal.native.path, managedNativePython);
assert.equal(doctor.issues.some((issue) => issue.severity === 'error'), false);
const startPlan = buildStartPlan(doctor);
assert.equal(startPlan.args.includes('--enable-oa'), true);
assert.equal(startPlan.environment.VL3D_CDS_LIB, join(first.project, 'cds.lib'));
assert.equal(startPlan.environment.VL3D_CACHE_DIR, join(first.home, '.cache', 'vl3d'));
assert.equal(startPlan.environment.VL3D_FILE_PICKER, first.tools.zenity);
assert.equal(startPlan.environment.VL3D_XPROP, first.tools.xprop);
assert.equal(startPlan.environment.KLAYOUT_BIN, first.tools.klayout);
const headlessTracePlan = buildStartPlan({
  ...doctor, internal: { ...doctor.internal, native: {
    ...doctor.internal.native,
    probe: { ready: false, status: 0, error: null, missing: ['tk-display', 'OpenGL'],
      details: { versions: { numpy: '1.24', ijson: '3.2', gdstk: '0.9' } } },
  } },
});
assert.equal(headlessTracePlan.environment.VL3D_PYTHON, managedNativePython,
  'Browser geometry tracing must keep the prepared Python when Tk/OpenGL is unavailable');
const nativePlan = buildNativePlan(doctor);
assert.equal(nativePlan.server.args.includes('--native-private'), true);
assert.equal(nativePlan.server.args.includes('0'), true);
assert.equal(JSON.stringify(nativePlan).includes('token'), false);
assert.equal(nativePlan.native.venvDirectory, defaultNativeVenv(first.environment, first.home));
assert.equal(nativePlan.native.executable, managedNativePython);
assert.equal(nativePlan.server.environment.VL3D_PYTHON, managedNativePython);
const unusableKlayoutPlan = buildStartPlan({
  ...doctor,
  internal: {
    ...doctor.internal,
    tools: {
      ...doctor.internal.tools,
      klayout: { ...doctor.internal.tools.klayout, valid: false },
    },
  },
});
assert.equal(Object.hasOwn(unusableKlayoutPlan.environment, 'KLAYOUT_BIN'), false);

const cacheFixture = fixture();
const runtimeCache = validRuntimeCache(cacheFixture);
const validCacheAudit = auditRuntimeCache(runtimeCache.dataRoot);
assert.equal(validCacheAudit.status, 'pass');
assert.equal(validCacheAudit.details.deepValidated, 1);
write(join(runtimeCache.dataRoot, 'manifest.json'), '{broken\n', 0o600);
const corruptCacheAudit = auditRuntimeCache(runtimeCache.dataRoot);
assert.equal(corruptCacheAudit.issues.some((issue) => issue.code === 'VL3D-E7002'), true);
write(join(runtimeCache.dataRoot, 'manifest.json'), runtimeCache.manifestBytes, 0o600);
chmodSync(runtimeCache.layoutPath, 0o644);
const unsafeCacheAudit = auditRuntimeCache(runtimeCache.dataRoot);
assert.equal(unsafeCacheAudit.issues.some((issue) => issue.code === 'VL3D-E7006'), true);

const invalidPort = await freePort();
const invalid = await runDoctor(parseCli(['doctor', '--root', first.project, '--port', String(invalidPort), '--python', join(first.root, 'missing-python')]), { env: first.environment, cwd: first.project });
assert.equal(invalid.ready.viewer, true);
assert.equal(invalid.ready.oa, false);
assert.equal(invalid.issues.some((issue) => issue.code === 'VL3D-E2015' && issue.details.field === 'python'), true);
assert.equal(invalid.internal.tools.python.selected, join(first.root, 'missing-python'));
assert.equal(invalid.internal.tools.python.path, null);
const invalidBrowser = await resolveConfiguration(parseCli(['doctor', '--root', first.project, '--browser', join(first.root, 'missing-browser')]), { env: first.environment, cwd: first.project });
assert.equal(invalidBrowser.tools.browser.path, null);
assert.equal(invalidBrowser.tools.browser.selected, join(first.root, 'missing-browser'));
assert.equal(invalidBrowser.issues.some((issue) => issue.code === 'VL3D-E2015' && issue.details.field === 'browser'), true);

const staticOnly = fixture();
renameSync(staticOnly.tools.python, `${staticOnly.tools.python}.disabled`);
const staticPort = await freePort();
const staticDoctor = await runDoctor(parseCli(['doctor', '--root', staticOnly.project, '--port', String(staticPort), '--no-oa']), { env: staticOnly.environment, cwd: staticOnly.project });
assert.equal(staticDoctor.ready.viewer, true);
assert.equal(staticDoctor.ready.oa, false);
assert.equal(staticDoctor.issues.some((issue) => issue.code === 'VL3D-E1002' && issue.severity === 'warning'), true);
const staticLaunchPort = await freePort();
const staticLaunch = runCli(['start', '--root', staticOnly.project, '--port', String(staticLaunchPort), '--no-oa', '--python', join(staticOnly.root, 'missing-python')], staticOnly.environment);
assert.equal(staticLaunch.status, 0, staticLaunch.stderr);

const second = fixture();
const previewPort = await freePort();
const previewEnvironment = { ...second.environment, XDG_CONFIG_HOME: join(second.root, 'preview-config') };
const preview = runCli(['setup', '--json', '--root', second.project, '--port', String(previewPort)], previewEnvironment);
assert.equal(preview.status, 0, preview.stderr);
const previewPayload = JSON.parse(preview.stdout);
assert.equal(previewPayload.written, false);
assert.equal(statSync(join(second.root, 'preview-config'), { throwIfNoEntry: false }), undefined);

const writePort = await freePort();
const configPath = userConfigPath(second);
write(configPath, JSON.stringify({ schemaVersion: 1, tools: { browser: second.tools.firefox }, customSiteValue: 'keep' }), 0o600);
const writeEnvironment = { ...second.environment, VL3D_BROWSER: second.tools.chromium };
const setup = runCli(['setup', '--json', '--write', '--root', second.project, '--port', String(writePort)], writeEnvironment);
assert.equal(setup.status, 0, setup.stderr);
const setupPayload = JSON.parse(setup.stdout);
assert.equal(setupPayload.written, true);
const writtenConfig = JSON.parse(readFileSync(configPath, 'utf8'));
assert.equal(writtenConfig.port, writePort);
assert.equal(writtenConfig.tools.browser, second.tools.firefox);
assert.equal(writtenConfig.customSiteValue, 'keep');
assert.equal(statSync(configPath).mode & 0o777, 0o600);
assert.equal(statSync(dirname(configPath)).mode & 0o777, 0o700);

const third = fixture();
const externalConfig = join(third.root, 'selected-config.json');
const originalExternal = `${JSON.stringify({ schemaVersion: 1, tools: { browser: third.tools.firefox }, customExternal: true }, null, 2)}\n`;
write(externalConfig, originalExternal, 0o600);
const xdgWritePort = await freePort();
const xdgEnvironment = { ...third.environment, VL3D_CONFIG: externalConfig };
const xdgSetup = runCli(['setup', '--json', '--write', '--root', third.project, '--port', String(xdgWritePort)], xdgEnvironment);
assert.equal(xdgSetup.status, 0, xdgSetup.stderr);
const xdgPayload = JSON.parse(xdgSetup.stdout);
assert.equal(xdgPayload.configPath, userConfigPath(third));
assert.equal(readFileSync(externalConfig, 'utf8'), originalExternal);
assert.equal(JSON.parse(readFileSync(userConfigPath(third), 'utf8')).customExternal, undefined);

const fourth = fixture();
const occupied = await occupiedPort();
const busyPort = occupied.address().port;
const busySetup = runCli(['setup', '--json', '--write', '--root', fourth.project, '--port', String(busyPort)], fourth.environment);
await new Promise((resolveClose) => occupied.close(resolveClose));
assert.equal(busySetup.status, 0, busySetup.stderr);
assert.equal(JSON.parse(busySetup.stdout).written, true);
assert.equal(JSON.parse(readFileSync(userConfigPath(fourth), 'utf8')).port, busyPort);

const dryPort = await freePort();
const dryRun = runCli(['start', '--json', '--dry-run', '--root', second.project, '--port', String(dryPort)], second.environment);
assert.equal(dryRun.status, 0, dryRun.stderr);
const dryPayload = JSON.parse(dryRun.stdout);
assert.equal(dryPayload.command, 'start');
assert.equal(dryPayload.dryRun, true);
assert.equal(dryPayload.args.includes(join(second.project, 'tools', 'server.mjs')), true);
const launchPort = await freePort();
const launch = runCli(['start', '--root', second.project, '--port', String(launchPort), '--no-oa'], second.environment);
assert.equal(launch.status, 0, launch.stderr);
assert.equal(launch.stdout.includes('Starting VL3D at'), true);

const malformed = runCli(['doctor', '--json', '--unknown'], second.environment);
assert.equal(malformed.status, 2);
const malformedPayload = JSON.parse(malformed.stderr);
assert.equal(malformedPayload.error.code, 'VL3D-E2015');

const markdown = readFileSync(join(repository, 'docs', 'TROUBLESHOOTING.md'), 'utf8');
const html = readFileSync(join(repository, 'public', 'errors.html'), 'utf8');
for (const code of codes) {
  const shortCode = getErrorDefinition(code).shortCode;
  assert.equal(markdown.includes(`### ${code} (${shortCode}) -`), true, `${code} missing from troubleshooting Markdown`);
  assert.equal(html.includes(`id="${code}"`), true, `${code} missing from public error index`);
  assert.equal(html.includes(`id="${shortCode}"`), true, `${shortCode} alias missing from public error index`);
}

const viewerSource = readFileSync(join(repository, 'public', 'src', 'viewer-next.js'), 'utf8');
const fallbackSource = readFileSync(join(repository, 'public', 'src', 'fallback.js'), 'utf8');
assert.equal(viewerSource.includes('throw new Error'), false);
assert.equal(fallbackSource.includes('throw new Error'), false);
for (const code of ['E2019', 'E3001', 'E7002', 'E8006', 'E9001', 'E9003']) {
  assert.equal(viewerSource.includes(`codedError('${code}'`), true, `${code} missing from main viewer errors`);
}
for (const code of ['E7002', 'E8006', 'E9001']) {
  assert.equal(fallbackSource.includes(`codedError('${code}'`), true, `${code} missing from fallback errors`);
}

const proposed = buildSetupConfig(doctor, parseCli(['setup', '--root', first.project]));
assert.equal(proposed.schemaVersion, 1);
assert.equal(proposed.cdsLib, join(first.project, 'cds.lib'));

process.stdout.write(`doctor tests passed: ${codes.length} error codes\n`);
