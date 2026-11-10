#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cacheState,
  decorateOaCacheEntry,
  loadProjectConfig,
  pipelineFingerprint,
  readManifest,
  resolveOaExportPolicy,
  writeManifest,
} from './layout_catalog.mjs';
import { ensurePrivateDirectory, findExecutable, resolveRuntimePaths } from './runtime_paths.mjs';

const temporaryRoot = mkdtempSync(join(tmpdir(), 'vl3d-runtime-test-'));
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

try {
  const project = join(temporaryRoot, 'project');
  const home = join(temporaryRoot, 'home');
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  const environment = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_CACHE_HOME: join(home, 'cache'),
    XDG_STATE_HOME: join(home, 'state'),
    PATH: '/usr/bin:/bin',
  };
  const paths = resolveRuntimePaths(project, environment);
  assert.equal(paths.configFile, join(home, 'config', 'vl3d', 'config.json'));
  assert.equal(paths.dataRoot, join(home, 'cache', 'vl3d', 'data'));
  assert.equal(paths.stateDirectory, join(home, 'state', 'vl3d'));

  const systemBin = join(temporaryRoot, 'system-bin');
  const venvBin = join(temporaryRoot, 'venv', 'bin');
  const systemPython = join(systemBin, 'python3.6');
  const venvPython = join(venvBin, 'python');
  mkdirSync(systemBin, { recursive: true });
  mkdirSync(venvBin, { recursive: true });
  writeFileSync(systemPython, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  chmodSync(systemPython, 0o755);
  symlinkSync(systemPython, venvPython);
  assert.equal(findExecutable(venvPython, environment), venvPython);
  assert.equal(
    findExecutable(relative(process.cwd(), venvPython), environment),
    venvPython,
  );
  assert.equal(findExecutable('python', { ...environment, PATH: venvBin }), venvPython);
  assert.equal(findExecutable(systemPython, environment), systemPython);
  symlinkSync(join(systemBin, 'missing-python'), join(venvBin, 'broken-python'));
  assert.equal(findExecutable(join(venvBin, 'broken-python'), environment), null);

  mkdirSync(paths.configDirectory, { recursive: true });
  writeFileSync(paths.projectConfigFile, '{"resourceMode":"low","views":["layout"]}\n');
  writeFileSync(paths.configFile, '{"resourceMode":"large","strictSymlinks":true}\n');
  const loaded = loadProjectConfig(project, environment);
  assert.equal(loaded.config.resourceMode, 'large');
  assert.equal(loaded.config.strictSymlinks, true);
  assert.deepEqual(loaded.config.views, ['layout']);

  const low = resolveOaExportPolicy({ resourceMode: 'low' }, environment);
  assert.equal(low.resourceMode, 'low');
  assert.equal(low.shapeLimit, 100000);
  const overridden = resolveOaExportPolicy({ resourceMode: 'low' }, {
    ...environment,
    VL3D_SHAPE_LIMIT: '123456',
  });
  assert.equal(overridden.shapeLimit, 123456);
  assert.throws(
    () => resolveOaExportPolicy({ resourceMode: 'unbounded' }, environment),
    /low, balanced, or large/,
  );

  const profileDirectory = join(temporaryRoot, 'profiles');
  mkdirSync(profileDirectory);
  const profilePath = join(profileDirectory, 'custom.json');
  writeFileSync(profilePath, '{"id":"first"}\n');
  const firstFingerprint = pipelineFingerprint(repositoryRoot, low, {
    profile: null,
    directories: [profileDirectory],
  });
  writeFileSync(profilePath, '{"id":"second"}\n');
  const secondFingerprint = pipelineFingerprint(repositoryRoot, low, {
    profile: null,
    directories: [profileDirectory],
  });
  assert.notEqual(firstFingerprint, secondFingerprint);

  const pipelineRoot = join(temporaryRoot, 'pipeline');
  mkdirSync(join(pipelineRoot, 'tools'), { recursive: true });
  for (const name of ['oa_dump.il', 'export_layouts.sh', 'convert_layout_tsv.py',
    'pdk_profile.py', 'trace_rules.py', 'technology_layers.py']) {
    writeFileSync(join(pipelineRoot, 'tools', name), readFileSync(join(repositoryRoot, 'tools', name)));
  }
  const sourceLibrary = join(pipelineRoot, 'LIB');
  mkdirSync(join(sourceLibrary, 'TOP', 'layout'), { recursive: true });
  writeFileSync(join(sourceLibrary, 'TOP', 'layout', 'layout.oa'), 'readonly-source-fixture');
  const pipelineData = join(pipelineRoot, 'data');
  mkdirSync(pipelineData);
  writeFileSync(join(pipelineData, 'top.json'), '{}');
  const libraries = new Map([['LIB', sourceLibrary]]);
  for (const dependency of ['trace_rules.py', 'technology_layers.py']) {
    const entry = decorateOaCacheEntry(pipelineRoot, libraries,
      { library: 'LIB', cell: 'TOP', view: 'layout', path: 'data/top.json' }, 'LIB', 'TOP', 'layout');
    assert.equal(cacheState(pipelineRoot, entry, libraries, true, pipelineData), 'ready');
    const path = join(pipelineRoot, 'tools', dependency);
    writeFileSync(path, readFileSync(path, 'utf8') + '\n# Changed converter dependency\n');
    assert.equal(cacheState(pipelineRoot, entry, libraries, true, pipelineData), 'stale',
      `Changing ${dependency} must invalidate previous exported electrical/layer metadata`);
  }
  const technologyLibrary = join(pipelineRoot, 'PDK');
  mkdirSync(technologyLibrary);
  libraries.set('PDK', technologyLibrary);
  const childLibrary = join(pipelineRoot, 'CHILDLIB');
  mkdirSync(join(childLibrary, 'CHILD', 'layout'), { recursive: true });
  writeFileSync(join(childLibrary, 'CHILD', 'layout', 'layout.oa'), 'child-source-fixture');
  libraries.set('CHILDLIB', childLibrary);
  for (const dependency of [join(sourceLibrary, 'data.dm'), join(childLibrary, 'data.dm'),
    join(technologyLibrary, 'tech.db')]) {
    writeFileSync(dependency, 'first');
    const metadata = statSync(dependency);
    const entry = decorateOaCacheEntry(pipelineRoot, libraries, {
      library: 'LIB', cell: 'TOP', view: 'layout', path: 'data/top.json',
      sourceViews: [{ library: 'LIB', cell: 'TOP', view: 'layout' },
        { library: 'CHILDLIB', cell: 'CHILD', view: 'layout' }],
    }, 'LIB', 'TOP', 'layout');
    assert.equal(cacheState(pipelineRoot, entry, libraries, true, pipelineData), 'ready');
    writeFileSync(dependency, 'other');
    utimesSync(dependency, metadata.atime, metadata.mtime);
    assert.equal(cacheState(pipelineRoot, entry, libraries, true, pipelineData), 'stale',
      'Attachment and technology changes must invalidate caches even when size/mtime are preserved');
  }

  const dataRoot = ensurePrivateDirectory(paths.dataRoot);
  writeManifest(project, {
    schemaVersion: 2,
    generatedAt: new Date(0).toISOString(),
    cells: [],
  }, dataRoot);
  assert.deepEqual(readManifest(project, dataRoot).cells, []);
  assert.equal(statSync(dataRoot).mode & 0o777, 0o700);
  assert.equal(statSync(join(dataRoot, 'manifest.json')).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(join(dataRoot, 'manifest.json'), 'utf8')).schemaVersion, 2);

  chmodSync(paths.configFile, 0o600);
  writeFileSync(paths.configFile, '{invalid json\n');
  assert.throws(() => loadProjectConfig(project, environment), /Cannot parse VL3D configuration/);

  console.log('runtime path tests passed');
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
