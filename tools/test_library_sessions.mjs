#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  parseCdsLibraryDetails,
  resolveOaExportPolicy,
  resolveOaViewSource,
} from './layout_catalog.mjs';
import {
  LibrarySessionStore,
  findNearestCdsLib,
  resolveSessionCadenceEnvironment,
} from './library_sessions.mjs';

const temporaryRoot = mkdtempSync(join(tmpdir(), 'vl3d-library-session-test-'));

function write(path, contents = '') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function createLayout(libraryPath, cell, view = 'layout') {
  const viewPath = join(libraryPath, cell, view);
  mkdirSync(viewPath, { recursive: true });
  writeFileSync(join(viewPath, `${view}.oa`), 'test');
}

try {
  mkdirSync(join(temporaryRoot, 'public', 'data'), { recursive: true });
  write(join(temporaryRoot, 'public', 'data', 'manifest.json'), '{"schemaVersion":2,"cells":[]}\n');
  const project = join(temporaryRoot, 'project');
  const userLibrary = join(project, 'USERLIB');
  const dependencyLibrary = join(project, 'PDKLIB');
  mkdirSync(userLibrary, { recursive: true });
  mkdirSync(dependencyLibrary, { recursive: true });
  createLayout(userLibrary, 'inv');
  const taggedView = join(userLibrary, 'tagged', 'layout');
  write(join(taggedView, 'master.tag'), '-- Master.tag File, Rev:1.0\ntagged-layout.oa\n');
  write(join(taggedView, 'tagged-layout.oa'), 'tagged');
  assert.equal(resolveOaViewSource(userLibrary, 'tagged', 'layout').oaPath,
    join(taggedView, 'tagged-layout.oa'));
  write(join(userLibrary, 'invalid_tag', 'layout', 'master.tag'), '../outside.oa\n');
  assert.equal(resolveOaViewSource(userLibrary, 'invalid_tag', 'layout'), null);
  createLayout(dependencyLibrary, 'device');
  write(join(project, 'cds.lib'), [
    'DEFINE USERLIB ./USERLIB',
    'DEFINE PDKLIB ./PDKLIB',
    '',
  ].join('\n'));
  const cadenceEnvironment = join(project, 'cadence_env.sh');
  write(cadenceEnvironment, 'export TEST_TECH_HOME=/tmp\n');
  assert.equal(resolveSessionCadenceEnvironment(temporaryRoot, {
    path: userLibrary,
    overrides: {},
  }, {
    ...process.env,
    HOME: join(temporaryRoot, 'empty-home'),
    XDG_CONFIG_HOME: join(temporaryRoot, 'empty-config'),
    VL3D_CADENCE_ENV: '',
  }), cadenceEnvironment);

  assert.equal(findNearestCdsLib(join(userLibrary, 'inv')), join(project, 'cds.lib'));
  const parsed = parseCdsLibraryDetails(join(project, 'cds.lib'));
  assert.equal(parsed.libraries.get('USERLIB'), userLibrary);
  assert.equal(parsed.directLibraries.size, 2);

  const store = new LibrarySessionStore(temporaryRoot, { maxSessions: 2, ttlMs: 60000 });
  const created = store.create({
    path: userLibrary,
    overrides: { cadenceEnv: cadenceEnvironment },
  });
  assert.match(created.sessionId, /^[a-f0-9]{48}$/);
  assert.deepEqual(created.library, { name: 'USERLIB', path: userLibrary });
  assert.equal(created.resolved.cdsLib, join(project, 'cds.lib'));
  assert.equal(created.resolved.cadenceEnv, cadenceEnvironment);
  assert.deepEqual(created.layouts.map((layout) => layout.key), [
    'USERLIB/inv/layout', 'USERLIB/tagged/layout',
  ]);
  assert.equal(store.get(created.sessionId).needsOverlay, false);
  assert.equal(created.resolved.pdkProfile, null);
  assert.deepEqual(created.resolved.pdkProfileDirs, []);
  assert.equal(created.resolved.pdkProfileSource, 'automatic-on-import');
  const configuredProfile = join(temporaryRoot, 'explicit-profile.json');
  const configured = new LibrarySessionStore(temporaryRoot).create({ path: userLibrary }, {
    pdkProfiles: { profile: configuredProfile, directories: [] },
  });
  assert.equal(configured.resolved.pdkProfile, configuredProfile);
  assert.equal(configured.resolved.pdkProfileSource, 'configured-file');
  assert.equal(configured.resolved.rulesComplete, undefined, 'Configured profile does not imply complete electrical rules');


  const lowPolicy = resolveOaExportPolicy({}, {}, { resourceMode: 'low' });
  const lowResourceSession = store.create({
    path: userLibrary,
    overrides: { cadenceEnv: cadenceEnvironment, resourceMode: 'LOW' },
  }, { exportPolicy: lowPolicy });
  assert.equal(store.get(lowResourceSession.sessionId).exportPolicy.resourceMode, 'low');
  assert.equal(store.get(lowResourceSession.sessionId).exportPolicy.shapeLimit, 100000);
  assert.equal(lowResourceSession.settings.resourceMode, 'low');
  assert.throws(
    () => store.create({
      path: userLibrary,
      overrides: { cadenceEnv: cadenceEnvironment, resourceMode: 'unbounded' },
    }),
    (error) => error.status === 400 && error.code === 'E2015',
  );

  createLayout(userLibrary, 'manual_cell');
  assert.deepEqual(
    store.describe(created.sessionId).layouts.map((layout) => layout.cell),
    ['inv', 'manual_cell', 'tagged'],
  );

  mkdirSync(join(userLibrary, 'linked', 'layout'), { recursive: true });
  symlinkSync(join(userLibrary, 'inv', 'layout', 'layout.oa'), join(userLibrary, 'linked', 'layout', 'layout.oa'));
  assert.equal(store.describe(created.sessionId).layouts.some((layout) => layout.cell === 'linked'), true);
  const strictStore = new LibrarySessionStore(temporaryRoot, {
    maxSessions: 2,
    ttlMs: 60000,
    strictSymlinks: true,
  });
  const strictSession = strictStore.create({
    path: userLibrary,
    overrides: { cadenceEnv: cadenceEnvironment },
  });
  assert.equal(
    strictSession.layouts.some((layout) => layout.cell === 'linked'),
    false,
  );

  createLayout(userLibrary, 'custom', 'routingView');
  const customViewStore = new LibrarySessionStore(temporaryRoot);
  const customViewSession = customViewStore.create({
    path: userLibrary,
    overrides: { cadenceEnv: cadenceEnvironment, views: ['layout', 'routingView'] },
  });
  assert.equal(
    customViewSession.layouts.some((layout) => layout.key === 'USERLIB/custom/routingView'),
    true,
  );

  const environmentProject = join(temporaryRoot, 'environment-project');
  const environmentLibrary = join(environmentProject, 'libraries', 'ENVLIB');
  createLayout(environmentLibrary, 'env_cell');
  write(join(environmentProject, 'cds.lib'), 'DEFINE ENVLIB $TEST_LIBRARY_ROOT/ENVLIB\n');
  const environmentStore = new LibrarySessionStore(temporaryRoot);
  const environmentSession = environmentStore.create({
    path: join(environmentProject, 'cds.lib'),
    overrides: { libraryName: 'ENVLIB', cadenceEnv: cadenceEnvironment },
  }, {
    environment: { ...process.env, TEST_LIBRARY_ROOT: join(environmentProject, 'libraries') },
  });
  assert.equal(environmentSession.library.path, environmentLibrary);

  const alias = store.create({
    path: userLibrary,
    overrides: { cadenceEnv: cadenceEnvironment, libraryName: 'ALIAS' },
  });
  assert.equal(alias.library.name, 'ALIAS');
  assert.equal(store.get(alias.sessionId).needsOverlay, true);

  assert.throws(
    () => store.create({ path: project, overrides: { cadenceEnv: cadenceEnvironment } }),
    (error) => error.status === 409 && error.details.candidates.length === 2,
  );
  const selectedProjectLibrary = store.create({
    path: project,
    overrides: { cadenceEnv: cadenceEnvironment, libraryName: 'USERLIB' },
  });
  assert.equal(selectedProjectLibrary.library.name, 'USERLIB');

  const tinyCdsLib = join(project, 'tiny.lib');
  write(tinyCdsLib, 'DEFINE X ./USERLIB\n');
  assert.throws(
    () => parseCdsLibraryDetails(tinyCdsLib, { limits: { maxFileBytes: 4 } }),
    /exceeds 4 bytes/,
  );

  write(join(project, 'cds.lib'), 'DEFINE USERLIB ./USERLIB\n');
  assert.throws(
    () => store.describe(selectedProjectLibrary.sessionId),
    (error) => error.status === 409 && /changed after/.test(error.message),
  );

  const backupLibrary = join(temporaryRoot, 'backup-project', 'BACKUPLIB');
  const activeNames = ['B', 'A.bak-20261003-extra', 'A.bak-2026100', 'A_backup'];
  const backupNames = ['A.bak-20261003', 'A.bak-20261003-145044'];
  for (const cell of [...activeNames, ...backupNames]) createLayout(backupLibrary, cell);
  write(join(temporaryRoot, 'backup-project', 'cds.lib'), 'DEFINE BACKUPLIB ./BACKUPLIB\n');
  const backupSession = new LibrarySessionStore(temporaryRoot).create({ path: backupLibrary });
  assert.equal(backupSession.layouts.length, activeNames.length + backupNames.length,
    'Timestamp backup cell names remain valid selectable OA identities');
  assert.deepEqual(new Set(backupSession.layouts.filter((layout) => layout.isBackup).map((layout) => layout.cell)), new Set(backupNames));
  assert(backupSession.layouts.slice(0, activeNames.length).every((layout) => !layout.isBackup),
    'Normal cells sort before timestamp backup cells');
  for (const layout of backupSession.layouts) assert.equal(layout.key, `BACKUPLIB/${layout.cell}/layout`);

  console.log('library session tests passed');
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
