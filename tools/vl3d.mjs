#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, chmodSync, constants, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, platform } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { diagnosticIssue, errorPayload, getErrorDefinition } from './error_catalog.mjs';
import { ensurePrivateDirectory, findExecutable, resolveRuntimePaths } from './runtime_paths.mjs';

export const CONFIG_SCHEMA_VERSION = 1;
export const INSTALL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NODE_MINIMUM_MAJOR = 18;
const PYTHON_MINIMUM = [3, 6];
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const CACHE_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
const CACHE_LAYOUT_MAX_BYTES = 384 * 1024 * 1024;
const CACHE_GZIP_MAX_BYTES = 128 * 1024 * 1024;
const CACHE_DEEP_FILE_MAX_BYTES = 8 * 1024 * 1024;
const CACHE_DEEP_TOTAL_MAX_BYTES = 32 * 1024 * 1024;
const CACHE_ENTRY_MAXIMUM = 100_000;
const CACHE_ISSUE_MAXIMUM = 32;
const CACHE_IDENTITY = /^[A-Za-z0-9_.$:+-]+$/;
const CACHE_ASSET_PATH = /^data\/[A-Za-z0-9_.$:+@-]+\.json$/;
const NATIVE_REQUIREMENTS = 'requirements-native.txt';
const NATIVE_READY_TIMEOUT_MS = 15_000;
const TOOL_SPECS = Object.freeze({
  python: { env: ['VL3D_PYTHON'], candidates: ['python3'], code: 'E1002' },
  chromium: { env: ['VL3D_BROWSER', 'CHROMIUM_BIN'], candidates: ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'], code: 'E1003' },
  firefox: { env: ['VL3D_FIREFOX'], candidates: ['firefox'], code: 'E1003' },
  picker: { env: ['VL3D_FILE_PICKER', 'VL3D_PICKER'], candidates: ['zenity', 'kdialog', 'yad'], code: 'E1004' },
  xprop: { env: ['VL3D_XPROP'], candidates: ['xprop'], code: 'E1005' },
  klayout: { env: ['VL3D_KLAYOUT', 'KLAYOUT_BIN'], candidates: ['klayout'], code: 'E1006' },
  virtuoso: { env: ['VL3D_VIRTUOSO'], candidates: ['virtuoso', 'icfb'], code: 'E1008' },
});

class CliError extends Error {
  constructor(message, code = 'E2015') {
    super(message);
    this.code = code;
  }
}

function asString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  return null;
}

function expandHome(value, home = homedir()) {
  const text = asString(value);
  if (!text) return null;
  if (text === '~') return home;
  if (text.startsWith(`~${sep}`)) return join(home, text.slice(2));
  return text;
}

function absolutePath(value, base, home) {
  const expanded = expandHome(value, home);
  if (!expanded) return null;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

function safeStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function readableFile(path) {
  try {
    const metadata = statSync(path);
    if (!metadata.isFile()) return false;
    const descriptor = openSync(path, constants.O_RDONLY);
    closeSync(descriptor);
    return true;
  } catch {
    return false;
  }
}

function commandPath(candidate, env, base, home) {
  const value = asString(candidate);
  if (!value) return null;
  if (value.includes(sep) || isAbsolute(value) || value.startsWith('~')) {
    const path = absolutePath(value, base, home);
    return findExecutable(path, env);
  }
  return findExecutable(value, env);
}

function fieldValue(config, field) {
  if (!config || typeof config !== 'object') return null;
  if (field in config) return config[field];
  if (config.tools && typeof config.tools === 'object' && field in config.tools) return config.tools[field];
  return null;
}

function chosenValue(field, cli, env, configs, envNames = []) {
  if (cli.values[field] !== undefined) return { value: cli.values[field], source: 'command-line' };
  for (const name of envNames) {
    if (asString(env[name])) return { value: env[name], source: `environment:${name}` };
  }
  for (const candidate of configs) {
    const value = fieldValue(candidate.config, field);
    if (value !== undefined && value !== null && value !== '') return { value, source: candidate.source };
  }
  return { value: null, source: 'automatic' };
}

export function defaultXdgPaths(env = process.env, root = INSTALL_ROOT) {
  const paths = resolveRuntimePaths(root, { ...env, VL3D_CONFIG: '' });
  return {
    configDir: paths.configDirectory,
    configFile: paths.configFile,
    cacheDir: paths.cacheDirectory,
    stateDir: paths.stateDirectory,
    dataDir: paths.dataRoot,
    projectConfigFile: paths.projectConfigFile,
  };
}

export function defaultNativeVenv(env = process.env, home = env.HOME || homedir()) {
  const dataHome = asString(env.XDG_DATA_HOME) || join(home, '.local', 'share');
  return resolve(dataHome, 'vl3d', 'native-venv');
}

function nestedConfigurationValue(config, field) {
  if (!config || typeof config !== 'object') return null;
  if (field in config) return config[field];
  if (config.native && typeof config.native === 'object' && field in config.native) return config.native[field];
  if (config.tools && typeof config.tools === 'object' && field in config.tools) return config.tools[field];
  return null;
}

export function resolveNativePython(report, cli = { values: {} }) {
  const { env, home, root, configs } = report.internal;
  const configured = [
    { value: cli.values.nativePython, source: 'command-line' },
    { value: env.VL3D_NATIVE_PYTHON, source: 'environment:VL3D_NATIVE_PYTHON' },
    ...configs.map((candidate) => ({ value: nestedConfigurationValue(candidate.config, 'nativePython'), source: candidate.source })),
  ].find((candidate) => asString(candidate.value));
  const configuredVenv = [
    cli.values.nativeVenv,
    env.VL3D_NATIVE_VENV,
    ...configs.map((candidate) => nestedConfigurationValue(candidate.config, 'venv')),
    ...configs.map((candidate) => nestedConfigurationValue(candidate.config, 'nativeVenv')),
  ].find((value) => asString(value));
  const venvDirectory = absolutePath(
    configuredVenv || defaultNativeVenv(env, home),
    root,
    home,
  );
  const candidates = [];
  if (configured) {
    const path = commandPath(configured.value, env, root, home);
    return {
      path,
      configuredPath: path || absolutePath(configured.value, root, home),
      invalid: !path,
      source: configured.source,
      venvDirectory,
    };
  }
  candidates.push({ value: join(venvDirectory, 'bin', 'python'), source: 'managed-native-venv' });
  if (report.internal.tools.python?.path) candidates.push({ value: report.internal.tools.python.path, source: 'python-fallback' });
  for (const candidate of candidates) {
    const path = commandPath(candidate.value, env, root, home);
    if (path) return { path, source: candidate.source, venvDirectory };
  }
  return { path: null, source: 'automatic', venvDirectory };
}

function optionValue(argv, index, option) {
  if (index + 1 >= argv.length) throw new CliError(`Missing value for ${option}`);
  return argv[index + 1];
}

export function parseCli(argv = process.argv.slice(2)) {
  const cli = {
    command: 'gui',
    values: {},
    json: false,
    write: false,
    dryRun: false,
    install: false,
    native: false,
    help: false,
  };
  let index = 0;
  if (argv[0] && !argv[0].startsWith('-')) {
    cli.command = argv[0];
    index = 1;
  }
  if (!['doctor', 'setup', 'gui', 'web', 'start'].includes(cli.command)) throw new CliError(`Unknown command: ${cli.command}`);
  const valueOptions = new Map([
    ['--root', 'root'], ['--host', 'host'], ['--port', 'port'], ['--config', 'config'],
    ['--python', 'python'], ['--browser', 'browser'], ['--picker', 'picker'], ['--xprop', 'xprop'],
    ['--klayout', 'klayout'], ['--virtuoso', 'virtuoso'], ['--cds-lib', 'cdsLib'],
    ['--cadence-env', 'cadenceEnv'], ['--license', 'license'], ['--library', 'libraryPath'],
    ['--native-python', 'nativePython'], ['--venv', 'nativeVenv'], ['--wheelhouse', 'wheelhouse'],
  ]);
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (valueOptions.has(arg)) cli.values[valueOptions.get(arg)] = optionValue(argv, index++, arg);
    else if (arg === '--json') cli.json = true;
    else if (arg === '--write') cli.write = true;
    else if (arg === '--dry-run') cli.dryRun = true;
    else if (arg === '--install') cli.install = true;
    else if (arg === '--native') cli.native = true;
    else if (arg === '--enable-oa') cli.values.enableOa = true;
    else if (arg === '--no-oa') cli.values.enableOa = false;
    else if (arg === '--help' || arg === '-h') cli.help = true;
    else throw new CliError(`Unknown option: ${arg}`);
  }
  if (cli.write && cli.command !== 'setup') throw new CliError('--write is only valid with setup');
  if (cli.install && cli.command !== 'setup') throw new CliError('--install is only valid with setup');
  if (cli.native && !['doctor', 'setup'].includes(cli.command)) throw new CliError('--native is only valid with doctor or setup');
  if (cli.dryRun && !['gui', 'web', 'start'].includes(cli.command)) throw new CliError('--dry-run is only valid with gui, web, or start');
  return cli;
}

function readConfiguration(path, source, issues) {
  if (!path || !existsSync(path)) return { source, path, config: {}, exists: false };
  let parsed;
  try {
    const metadata = statSync(path);
    if (!metadata.isFile() || metadata.size > 1024 * 1024) throw new Error('configuration must be a regular file no larger than 1 MiB');
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    issues.push(diagnosticIssue('E2001', { source, path, message: error.message }));
    return { source, path, config: {}, exists: true, invalid: true };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    issues.push(diagnosticIssue('E2002', { source, path }));
    return { source, path, config: {}, exists: true, invalid: true };
  }
  if (parsed.schemaVersion !== undefined && Number(parsed.schemaVersion) > CONFIG_SCHEMA_VERSION) {
    issues.push(diagnosticIssue('E2016', { source, path, schemaVersion: parsed.schemaVersion }));
  }
  return { source, path, config: parsed, exists: true };
}

function nearestCandidates(start, names, maximumLevels = 5) {
  const candidates = [];
  let current = resolve(start);
  for (let depth = 0; depth <= maximumLevels; depth += 1) {
    for (const name of names) {
      const path = join(current, name);
      if (readableFile(path)) candidates.push({ path: realpathSync(path), depth });
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!candidates.length) return { path: null, ambiguous: [] };
  const bestDepth = Math.min(...candidates.map((entry) => entry.depth));
  const best = [...new Set(candidates.filter((entry) => entry.depth === bestDepth).map((entry) => entry.path))];
  return best.length === 1 ? { path: best[0], ambiguous: [] } : { path: null, ambiguous: best };
}

function detectCdsLib(root, libraryPath, home) {
  if (libraryPath) {
    const selected = absolutePath(libraryPath, root, home);
    const metadata = safeStat(selected);
    if (metadata?.isFile() && ['cds.lib', 'lib.defs'].includes(basename(selected))) {
      return { path: realpathSync(selected), ambiguous: [] };
    }
    if (metadata?.isDirectory()) {
      const nearLibrary = nearestCandidates(selected, ['cds.lib', 'lib.defs']);
      if (nearLibrary.path || nearLibrary.ambiguous.length) return nearLibrary;
    }
  }
  return nearestCandidates(root, ['cds.lib', 'lib.defs']);
}

function pathAncestors(start, maximumLevels = 6) {
  const directories = [];
  let current = resolve(start);
  for (let depth = 0; depth <= maximumLevels; depth += 1) {
    directories.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directories;
}

function detectCadenceEnvironment(root, cdsLib, libraryPath, home) {
  const selectedBase = libraryPath && safeStat(libraryPath)?.isFile() ? dirname(libraryPath) : libraryPath;
  const primaryDirectories = [root, cdsLib ? dirname(cdsLib) : null, home, selectedBase].filter(Boolean);
  const directories = [...new Set([
    ...primaryDirectories,
    ...(selectedBase ? pathAncestors(selectedBase) : []),
  ])];
  const paths = [];
  for (const directory of directories) {
    for (const name of ['cadence_env.sh', 'cadence_environment.sh', 'cadence_bridge_env.sh']) {
      const path = resolve(directory, name);
      if (readableFile(path)) paths.push(realpathSync(path));
    }
    if (primaryDirectories.includes(directory)) {
      const hidden = resolve(directory, '.vl3d', 'cadence_env.sh');
      if (readableFile(hidden)) paths.push(realpathSync(hidden));
    }
  }
  const unique = [...new Set(paths)];
  return unique.length === 1 ? { path: unique[0], ambiguous: [] } : { path: null, ambiguous: unique };
}

function cadenceExecutableCandidates(env) {
  const candidates = [];
  for (const name of ['CDS_ROOT', 'CDSHOME', 'CDS_INST_DIR']) {
    const root = asString(env[name]);
    if (!root) continue;
    candidates.push(join(root, 'tools', 'dfII', 'bin', 'virtuoso'), join(root, 'bin', 'virtuoso'));
  }
  return candidates;
}

function addIssueOnce(issues, issue) {
  const identity = `${issue.code}:${JSON.stringify(issue.details || {})}`;
  if (!issues.some((candidate) => `${candidate.code}:${JSON.stringify(candidate.details || {})}` === identity)) issues.push(issue);
}

function removeIssuesByCode(issues, codes) {
  const selected = new Set(codes.map((code) => getErrorDefinition(code).code));
  for (let index = issues.length - 1; index >= 0; index -= 1) {
    if (selected.has(issues[index].code)) issues.splice(index, 1);
  }
}

function resolveTool(name, choice, spec, context, issues) {
  const configured = asString(choice.value);
  if (configured) {
    const path = commandPath(configured, context.env, context.root, context.home);
    if (!path) {
      addIssueOnce(issues, diagnosticIssue('E2015', { field: name === 'chromium' ? 'browser' : name, value: configured, source: choice.source }));
      return { name, selected: configured, path: null, source: choice.source, valid: false };
    }
    return { name, selected: configured, path, source: choice.source, valid: true };
  }
  const candidates = name === 'virtuoso'
    ? [...cadenceExecutableCandidates(context.env), ...spec.candidates]
    : spec.candidates;
  for (const candidate of candidates) {
    const path = commandPath(candidate, context.env, context.root, context.home);
    if (path) return { name, selected: path, path, source: 'automatic', valid: true };
  }
  addIssueOnce(issues, diagnosticIssue(spec.code, { searched: candidates }));
  return { name, selected: null, path: null, source: 'automatic', valid: false };
}

function versionProbe(path, args, pattern, timeout = 3000, env = process.env) {
  if (!path) return null;
  const completed = spawnSync(path, args, { encoding: 'utf8', timeout, env: { ...env, LC_ALL: 'C', LANG: 'C' } });
  const output = `${completed.stdout || ''}\n${completed.stderr || ''}`.trim();
  return {
    ok: !completed.error && completed.status === 0,
    version: output.match(pattern)?.[1] || null,
    status: completed.status,
    error: completed.error?.message || null,
    output: output.slice(0, 300),
  };
}

function pythonMajorMinor(version) {
  const parts = String(version || '').split('.').slice(0, 2).map(Number);
  return parts.length === 2 && parts.every(Number.isInteger) ? parts : null;
}

export function nativeBootstrapPackages(version) {
  const parts = pythonMajorMinor(version);
  if (!parts) throw new CliError(`Cannot determine Python version from ${version || '<empty>'}`, 'E1002');
  if (parts[0] === 3 && parts[1] < 8) {
    return ['pip==21.3.1', 'setuptools==59.6.0', 'wheel==0.37.1'];
  }
  return ['pip>=24,<27', 'setuptools>=68,<83', 'wheel>=0.42,<1'];
}

function nativeEnvironmentNeedsRebuild(sourcePython, nativePython, venvDirectory, env) {
  if (!findExecutable(nativePython, env)) return true;
  let configuration = '';
  try {
    configuration = readFileSync(join(venvDirectory, 'pyvenv.cfg'), 'utf8');
  } catch {
    return true;
  }
  if (!/^include-system-site-packages\s*=\s*false\s*$/im.test(configuration)) return true;
  const source = versionProbe(sourcePython, ['--version'], /Python\s+(\d+\.\d+(?:\.\d+)?)/i, 3000, env);
  const native = versionProbe(nativePython, ['--version'], /Python\s+(\d+\.\d+(?:\.\d+)?)/i, 3000, env);
  if (!source?.ok || !native?.ok) return true;
  if (pythonMajorMinor(source.version)?.join('.') !== pythonMajorMinor(native.version)?.join('.')) return true;
  const pip = versionProbe(nativePython, ['-m', 'pip', '--version'], /pip\s+([0-9]+(?:\.[0-9]+)+)/i, 10_000, env);
  return !pip?.ok;
}

export function probeNativeRuntime(pythonPath, root, env = process.env, options = {}) {
  if (!pythonPath) return { ready: false, path: null, missing: ['python'], error: 'Python executable was not found' };
  const script = [
    'from __future__ import print_function',
    'import json, pkgutil',
    "modules = ['tkinter', 'OpenGL', 'pyopengltk', 'numpy', 'ijson', 'gdstk']",
    'missing = {}',
    'versions = {}',
    'for name in modules:',
    '    try:',
    '        module = __import__(name)',
    "        versions[name] = getattr(module, '__version__', None)",
    '    except Exception as exc:',
    '        missing[name] = str(exc)',
    "if pkgutil.find_loader('native.app') is None:",
    "    missing['native.app'] = 'module not installed in project'",
    ...(options.checkDisplay ? [
      'try:',
      '    window = __import__(\'tkinter\').Tk()',
      '    window.withdraw()',
      '    window.update_idletasks()',
      '    window.destroy()',
      "    versions['tk-display'] = 'ready'",
      'except Exception as exc:',
      "    missing['tk-display'] = str(exc)",
    ] : []),
    "print(json.dumps({'missing': missing, 'versions': versions}, sort_keys=True))",
  ].join('\n');
  const completed = spawnSync(pythonPath, ['-c', script], {
    cwd: root,
    env: { ...env, LANG: 'C', LC_ALL: 'C' },
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  let payload = null;
  try {
    payload = JSON.parse(String(completed.stdout || '').trim());
  } catch {}
  const missing = payload?.missing && typeof payload.missing === 'object' ? Object.keys(payload.missing) : ['runtime-probe'];
  return {
    ready: !completed.error && completed.status === 0 && missing.length === 0,
    path: pythonPath,
    missing,
    details: payload,
    status: completed.status,
    error: completed.error?.message || (!payload ? String(completed.stderr || '').trim().slice(-1000) : null),
  };
}

function inspectManagedNativeIsolation(selection) {
  const executableVenv = selection.path ? resolve(dirname(selection.path), '..') : null;
  const executableConfiguration = executableVenv ? join(executableVenv, 'pyvenv.cfg') : null;
  const configuredEnvironment = executableConfiguration && readableFile(executableConfiguration)
    ? executableVenv
    : selection.source === 'managed-native-venv' ? selection.venvDirectory : null;
  if (!configuredEnvironment) return { required: false, ready: true, reason: null };
  try {
    const configuration = readFileSync(join(configuredEnvironment, 'pyvenv.cfg'), 'utf8');
    if (/^include-system-site-packages\s*=\s*false\s*$/im.test(configuration)) {
      return { required: true, ready: true, reason: null, venvDirectory: configuredEnvironment };
    }
    return { required: true, ready: false, reason: 'include-system-site-packages is not false', venvDirectory: configuredEnvironment };
  } catch (error) {
    return { required: true, ready: false, reason: error.message, venvDirectory: configuredEnvironment };
  }
}

function runNativeInstallStep(pythonPath, args, options, code = 'E1013') {
  const completed = spawnSync(pythonPath, args, {
    cwd: options.root,
    env: { ...options.env, LANG: 'C', LC_ALL: 'C', PIP_DISABLE_PIP_VERSION_CHECK: '1' },
    encoding: 'utf8',
    timeout: 15 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (completed.error || completed.status !== 0) {
    const detail = String(completed.stderr || completed.stdout || completed.error?.message || '').trim().slice(-4000);
    throw new CliError(`Native dependency installation failed: ${detail || `exit ${completed.status}`}`, code);
  }
}

export function installNativeRuntime(report, cli) {
  const sourcePython = report.internal.tools.python?.path;
  if (!sourcePython) throw new CliError('Python 3 is required to create the native environment', 'E1002');
  const sourceProbe = versionProbe(sourcePython, ['--version'], /Python\s+(\d+\.\d+(?:\.\d+)?)/i, 3000, report.internal.env);
  if (!sourceProbe?.ok || !sourceProbe.version) {
    throw new CliError(`Cannot determine the selected Python version: ${sourceProbe?.output || sourcePython}`, 'E1002');
  }
  const tkinterProbe = versionProbe(sourcePython, ['-c', 'import tkinter; print("tkinter")'], /\b(tkinter)\b/, 10_000, report.internal.env);
  if (!tkinterProbe?.ok || tkinterProbe.version !== 'tkinter') {
    throw new CliError(`The selected Python cannot import tkinter: ${tkinterProbe?.output || sourcePython}`, 'E1012');
  }
  const selection = resolveNativePython(report, cli);
  const venvDirectory = selection.venvDirectory;
  const nativePython = join(venvDirectory, 'bin', 'python');
  if (existsSync(venvDirectory)) {
    const metadata = lstatSync(venvDirectory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new CliError(`Unsafe native environment path: ${venvDirectory}`, 'E2014');
    if (nativeEnvironmentNeedsRebuild(sourcePython, nativePython, venvDirectory, report.internal.env)) {
      runNativeInstallStep(sourcePython, ['-m', 'venv', '--clear', venvDirectory], {
        root: report.internal.effective.root,
        env: report.internal.env,
      });
    }
  } else {
    ensurePrivateDirectory(dirname(venvDirectory));
    runNativeInstallStep(sourcePython, ['-m', 'venv', venvDirectory], {
      root: report.internal.effective.root,
      env: report.internal.env,
    });
  }
  chmodSync(venvDirectory, 0o700);
  if (!findExecutable(nativePython, report.internal.env)) throw new CliError(`Native Python was not created at ${nativePython}`, 'E1013');
  const wheelhouseValue = asString(cli.values.wheelhouse || report.internal.env.VL3D_WHEELHOUSE);
  const wheelhouse = wheelhouseValue ? absolutePath(wheelhouseValue, report.internal.effective.root, report.internal.home) : null;
  if (wheelhouse && !safeStat(wheelhouse)?.isDirectory()) throw new CliError(`Wheelhouse is not a directory: ${wheelhouse}`, 'E2015');
  const indexArguments = wheelhouse ? ['--no-index', '--find-links', wheelhouse] : [];
  runNativeInstallStep(nativePython, [
    '-m', 'pip', 'install', '--no-input', '--no-cache-dir', ...indexArguments,
    ...nativeBootstrapPackages(sourceProbe.version),
  ], { root: report.internal.effective.root, env: report.internal.env });
  const requirementsPath = join(report.internal.effective.root, NATIVE_REQUIREMENTS);
  if (!readableFile(requirementsPath)) throw new CliError(`Missing native requirements: ${requirementsPath}`, 'E2021');
  runNativeInstallStep(nativePython, [
    '-m', 'pip', 'install', '--no-input', '--no-cache-dir', '--prefer-binary',
    '--only-binary', 'numpy,gdstk,ijson', ...indexArguments,
    '--requirement', requirementsPath,
  ], { root: report.internal.effective.root, env: report.internal.env });
  const probe = probeNativeRuntime(nativePython, report.internal.effective.root, report.internal.env);
  if (!probe.ready) {
    const code = probe.missing.includes('tkinter') ? 'E1012' : 'E1013';
    throw new CliError(`Native runtime is incomplete: ${probe.missing.join(', ')}`, code);
  }
  return { pythonPath: nativePython, venvDirectory, probe };
}

function captureCadenceEnvironment(path, baseEnvironment, cwd) {
  if (!path) return { ok: false, environment: baseEnvironment, status: null, error: null };
  const completed = spawnSync('/bin/bash', [
    '--noprofile', '--norc', '-c',
    'set -e; source "$1" >/dev/null 2>&1; /usr/bin/env -0',
    'vl3d-doctor-environment', path,
  ], {
    cwd,
    env: { ...baseEnvironment, LANG: 'C', LC_ALL: 'C' },
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (completed.error || completed.status !== 0) {
    return {
      ok: false,
      environment: baseEnvironment,
      status: completed.status,
      error: completed.error?.message || String(completed.stderr || '').trim().slice(-500) || 'adapter exited unsuccessfully',
    };
  }
  const environment = { ...baseEnvironment };
  for (const record of Buffer.from(completed.stdout || '').toString('utf8').split('\0')) {
    const separator = record.indexOf('=');
    if (separator <= 0) continue;
    const name = record.slice(0, separator);
    const value = record.slice(separator + 1);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) environment[name] = value;
  }
  return { ok: true, environment, status: completed.status, error: null };
}

function directoryWritable(target) {
  let current = resolve(target);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  try {
    const metadata = statSync(current);
    if (!metadata.isDirectory()) return false;
    accessSync(current, constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readPrefix(path, byteCount = 4096) {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    const buffer = Buffer.alloc(byteCount);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
}

function privateCacheMetadata(path, expectedType, currentUid) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    return { problem: error.message, systemCode: error.code || null, code: 'E7001' };
  }
  if (metadata.isSymbolicLink()) return { problem: 'symbolic links are not allowed', metadata, code: 'E7001' };
  if (expectedType === 'directory' ? !metadata.isDirectory() : !metadata.isFile()) {
    return { problem: `expected a regular ${expectedType}`, metadata, code: 'E7001' };
  }
  const mode = metadata.mode & 0o777;
  if (currentUid !== null && metadata.uid !== currentUid) {
    return { problem: 'owned by another account', uid: metadata.uid, expectedUid: currentUid, mode, metadata, code: 'E7006' };
  }
  if ((mode & 0o077) !== 0) {
    return { problem: 'group/other permissions are enabled', mode, expectedMode: expectedType === 'directory' ? 0o700 : 0o600, metadata, code: 'E7006' };
  }
  return { metadata, mode };
}

function cacheMetadataIssue(result) {
  const { metadata, code, ...details } = result;
  return details;
}

export function auditRuntimeCache(dataDirectory) {
  const dataRoot = resolve(dataDirectory);
  const issues = [];
  let omittedIssues = 0;
  const details = {
    path: dataRoot,
    state: 'empty',
    entries: 0,
    deepValidated: 0,
    shallowValidated: 0,
  };
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const add = (code, issueDetails) => {
    if (issues.length < CACHE_ISSUE_MAXIMUM) issues.push(diagnosticIssue(code, issueDetails));
    else omittedIssues += 1;
  };
  const directory = privateCacheMetadata(dataRoot, 'directory', currentUid);
  if (directory.problem) {
    if (directory.systemCode === 'ENOENT') return { status: 'pass', details, issues };
    add(directory.code, { path: dataRoot, ...cacheMetadataIssue(directory) });
    details.state = 'invalid';
    return { status: 'fail', details, issues };
  }
  try {
    accessSync(dataRoot, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch (error) {
    add('E7001', { path: dataRoot, message: error.message, systemCode: error.code || null });
  }
  const manifestPath = join(dataRoot, 'manifest.json');
  if (!existsSync(manifestPath)) {
    details.state = issues.length ? 'invalid' : 'empty';
    return { status: issues.length ? 'fail' : 'pass', details, issues };
  }
  details.state = 'populated';
  let manifestBytes;
  let manifest;
  const manifestMetadata = privateCacheMetadata(manifestPath, 'file', currentUid);
  if (manifestMetadata.problem) add(manifestMetadata.code === 'E7006' ? 'E7006' : 'E7002', { path: manifestPath, ...cacheMetadataIssue(manifestMetadata) });
  try {
    const size = statSync(manifestPath).size;
    if (size < 2 || size > CACHE_MANIFEST_MAX_BYTES) throw new Error(`manifest size ${size} is outside 2..${CACHE_MANIFEST_MAX_BYTES} bytes`);
    manifestBytes = readFileSync(manifestPath);
    manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (!manifest || manifest.schemaVersion !== 2 || !Array.isArray(manifest.cells)) {
      throw new Error('manifest must be a schema-v2 object with a cells array');
    }
    if (manifest.cells.length > CACHE_ENTRY_MAXIMUM) throw new Error(`manifest exceeds ${CACHE_ENTRY_MAXIMUM} entries`);
  } catch (error) {
    add('E7002', { path: manifestPath, message: error.message });
  }

  const manifestGzipPath = `${manifestPath}.gz`;
  const manifestGzipMetadata = privateCacheMetadata(manifestGzipPath, 'file', currentUid);
  if (manifestGzipMetadata.problem) add(manifestGzipMetadata.code === 'E7006' ? 'E7006' : 'E7002', { path: manifestGzipPath, ...cacheMetadataIssue(manifestGzipMetadata) });
  else if (manifestBytes) {
    try {
      const expanded = gunzipSync(readFileSync(manifestGzipPath), { maxOutputLength: CACHE_MANIFEST_MAX_BYTES });
      if (!expanded.equals(manifestBytes)) throw new Error('manifest gzip content differs from manifest.json');
    } catch (error) {
      add('E7002', { path: manifestGzipPath, message: error.message });
    }
  }

  if (manifest) {
    details.entries = manifest.cells.length;
    const identities = new Set();
    const paths = new Set();
    let deepBudget = CACHE_DEEP_TOTAL_MAX_BYTES;
    for (const entry of manifest.cells) {
      try {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('entry must be an object');
        const view = entry.view || 'layout';
        if (![entry.library, entry.cell, view].every((value) => CACHE_IDENTITY.test(String(value || '')))) {
          throw new Error('entry has an invalid library/cell/view identity');
        }
        const identity = `${entry.library}/${entry.cell}/${view}`;
        if (identities.has(identity)) throw new Error(`duplicate identity ${identity}`);
        identities.add(identity);
        if (!CACHE_ASSET_PATH.test(String(entry.path || ''))) throw new Error(`invalid asset path ${entry.path || '<missing>'}`);
        if (paths.has(entry.path)) throw new Error(`duplicate asset path ${entry.path}`);
        paths.add(entry.path);
        const relativePath = entry.path.slice('data/'.length);
        const jsonPath = resolve(dataRoot, relativePath);
        const pathFromRoot = relative(dataRoot, jsonPath);
        if (!pathFromRoot || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
          throw new Error(`asset escapes cache root: ${entry.path}`);
        }
        const gzipPath = `${jsonPath}.gz`;
        const jsonMetadata = privateCacheMetadata(jsonPath, 'file', currentUid);
        const gzipMetadata = privateCacheMetadata(gzipPath, 'file', currentUid);
        if (jsonMetadata.problem) {
          add(jsonMetadata.code === 'E7006' ? 'E7006' : 'E7002', { identity, path: jsonPath, ...cacheMetadataIssue(jsonMetadata) });
          continue;
        }
        if (gzipMetadata.problem) {
          add(gzipMetadata.code === 'E7006' ? 'E7006' : 'E7002', { identity, path: gzipPath, ...cacheMetadataIssue(gzipMetadata) });
          continue;
        }
        if (jsonMetadata.metadata.size < 2 || jsonMetadata.metadata.size > CACHE_LAYOUT_MAX_BYTES) {
          throw new Error(`layout JSON size ${jsonMetadata.metadata.size} is outside 2..${CACHE_LAYOUT_MAX_BYTES} bytes`);
        }
        if (gzipMetadata.metadata.size < 2 || gzipMetadata.metadata.size > CACHE_GZIP_MAX_BYTES) {
          throw new Error(`layout gzip size ${gzipMetadata.metadata.size} is outside 2..${CACHE_GZIP_MAX_BYTES} bytes`);
        }
        const jsonPrefix = readPrefix(jsonPath).toString('utf8');
        if (!/^\uFEFF?\s*[\[{]/.test(jsonPrefix)) throw new Error('layout JSON does not start with an object or array');
        const gzipPrefix = readPrefix(gzipPath, 2);
        if (gzipPrefix.length !== 2 || gzipPrefix[0] !== 0x1f || gzipPrefix[1] !== 0x8b) throw new Error('layout gzip header is invalid');
        if (jsonMetadata.metadata.size <= CACHE_DEEP_FILE_MAX_BYTES && jsonMetadata.metadata.size <= deepBudget) {
          const jsonBytes = readFileSync(jsonPath);
          const layout = JSON.parse(jsonBytes.toString('utf8'));
          if (!layout || typeof layout !== 'object' || Array.isArray(layout)
              || !Array.isArray(layout.shapes) || !Array.isArray(layout.instances)) {
            throw new Error('layout JSON is missing shapes/instances arrays');
          }
          if (String(layout.library || '') !== entry.library || String(layout.cell || '') !== entry.cell
              || String(layout.view || 'layout') !== view) {
            throw new Error('layout JSON identity differs from its manifest entry');
          }
          const expanded = gunzipSync(readFileSync(gzipPath), { maxOutputLength: jsonBytes.length + 1 });
          if (!expanded.equals(jsonBytes)) throw new Error('layout gzip content differs from layout JSON');
          deepBudget -= jsonBytes.length;
          details.deepValidated += 1;
        } else {
          details.shallowValidated += 1;
        }
      } catch (error) {
        add('E7002', { path: entry?.path || manifestPath, message: error.message });
      }
    }
  }
  if (omittedIssues) details.omittedIssues = omittedIssues;
  if (issues.length) details.state = 'invalid';
  return { status: issues.length ? 'fail' : 'pass', details, issues };
}

function probePort(host, port) {
  return new Promise((resolveProbe) => {
    const server = createServer();
    server.unref();
    server.once('error', (error) => resolveProbe({ available: false, code: error.code, message: error.message }));
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolveProbe({ available: true }));
    });
  });
}

function checkRecord(id, label, status, value = null, code = null) {
  return { id, label, status, ...(value !== null ? { value } : {}), ...(code ? { code: getErrorDefinition(code).code } : {}) };
}

function resolvedPathChoice(field, choice, root, home, kind, issues) {
  const value = asString(choice.value);
  if (!value) return { selected: null, path: null, source: choice.source, valid: false };
  const path = absolutePath(value, root, home);
  const metadata = safeStat(path);
  const valid = kind === 'file' ? metadata?.isFile() && readableFile(path) : metadata?.isDirectory();
  if (!valid) addIssueOnce(issues, diagnosticIssue(choice.source === 'automatic' ? 'E2004' : 'E2015', { field, value, source: choice.source }));
  return { selected: value, path: valid ? realpathSync(path) : null, source: choice.source, valid: Boolean(valid) };
}

function sanitizeEffective(effective) {
  return {
    ...effective,
    license: effective.license ? '<configured>' : null,
  };
}

export async function resolveConfiguration(cli, options = {}) {
  const env = options.env || process.env;
  const home = env.HOME || homedir();
  const invocationCwd = options.cwd || process.cwd();
  const initialRoot = absolutePath(cli.values.root || env.VL3D_ROOT || options.cwd || INSTALL_ROOT, invocationCwd, home);
  const xdg = defaultXdgPaths(env, initialRoot);
  const issues = [];
  const explicitConfigPath = cli.values.config || env.VL3D_CONFIG;
  const projectPath = xdg.projectConfigFile;
  const configCandidates = [];
  if (explicitConfigPath) configCandidates.push(readConfiguration(absolutePath(explicitConfigPath, initialRoot, home), 'explicit-config', issues));
  if (!explicitConfigPath || resolve(absolutePath(explicitConfigPath, initialRoot, home)) !== resolve(xdg.configFile)) {
    configCandidates.push(readConfiguration(xdg.configFile, 'user-config', issues));
  }
  if ((!explicitConfigPath || resolve(absolutePath(explicitConfigPath, initialRoot, home)) !== resolve(projectPath))
      && resolve(projectPath) !== resolve(xdg.configFile)) {
    configCandidates.push(readConfiguration(projectPath, 'project-config', issues));
  }
  const rootChoice = chosenValue('root', cli, env, configCandidates, ['VL3D_ROOT']);
  const root = absolutePath(rootChoice.value || initialRoot, initialRoot, home);
  const enableChoice = chosenValue('enableOa', cli, env, configCandidates, ['VL3D_ENABLE_OA']);
  const parsedEnable = asBoolean(enableChoice.value);
  const oaExplicitlyDisabled = parsedEnable === false;
  const libraryChoice = chosenValue('libraryPath', cli, env, configCandidates, ['VL3D_LIBRARY']);
  const libraryPath = asString(libraryChoice.value) ? absolutePath(libraryChoice.value, root, home) : null;
  if (libraryPath) {
    const selected = safeStat(libraryPath);
    if (!selected || (!selected.isDirectory() && !(['cds.lib', 'lib.defs'].includes(basename(libraryPath)) && selected.isFile()))) {
      addIssueOnce(issues, diagnosticIssue('E2007', { path: libraryPath, source: libraryChoice.source }));
    }
  }
  const cdsChoice = chosenValue('cdsLib', cli, env, configCandidates, ['VL3D_CDS_LIB']);
  const automaticCds = cdsChoice.value || oaExplicitlyDisabled
    ? { path: null, ambiguous: [] }
    : detectCdsLib(root, libraryPath, home);
  if (automaticCds.ambiguous.length) addIssueOnce(issues, diagnosticIssue('E2008', { field: 'cdsLib', candidates: automaticCds.ambiguous }));
  if (automaticCds.path) Object.assign(cdsChoice, { value: automaticCds.path, source: 'automatic' });
  const cdsLib = cdsChoice.value
    ? resolvedPathChoice('cdsLib', cdsChoice, root, home, 'file', issues)
    : { selected: null, path: null, source: 'automatic', valid: false };
  if (!oaExplicitlyDisabled && !cdsLib.path && !cdsChoice.value && !automaticCds.ambiguous.length) {
    addIssueOnce(issues, diagnosticIssue('E2003', { root }));
  }
  const cadenceChoice = chosenValue('cadenceEnv', cli, env, configCandidates, ['VL3D_CADENCE_ENV']);
  const automaticCadence = cadenceChoice.value || oaExplicitlyDisabled
    ? { path: null, ambiguous: [] }
    : detectCadenceEnvironment(root, cdsLib.path, libraryPath, home);
  if (automaticCadence.ambiguous.length) addIssueOnce(issues, diagnosticIssue('E2008', { field: 'cadenceEnv', candidates: automaticCadence.ambiguous }));
  if (automaticCadence.path) Object.assign(cadenceChoice, { value: automaticCadence.path, source: 'automatic' });
  const cadenceEnv = cadenceChoice.value
    ? resolvedPathChoice('cadenceEnv', cadenceChoice, root, home, 'file', issues)
    : { selected: null, path: null, source: 'automatic', valid: false };
  if (!oaExplicitlyDisabled && !cadenceEnv.path && !cadenceChoice.value && !automaticCadence.ambiguous.length) {
    addIssueOnce(issues, diagnosticIssue('E2009', { root }));
  }
  const cadenceProbe = oaExplicitlyDisabled
    ? { ok: false, environment: env, status: null, error: null, skipped: true }
    : captureCadenceEnvironment(cadenceEnv.path, env, root);
  if (!oaExplicitlyDisabled && cadenceEnv.path && !cadenceProbe.ok) {
    addIssueOnce(issues, diagnosticIssue('E3002', {
      cadenceEnv: cadenceEnv.path,
      status: cadenceProbe.status,
      message: cadenceProbe.error,
    }));
  }
  const discoveryEnvironment = cadenceProbe.ok ? cadenceProbe.environment : env;
  const configs = configCandidates;
  const context = { env: discoveryEnvironment, root, home };
  const tools = {};
  for (const [name, spec] of Object.entries(TOOL_SPECS)) {
    let choice;
    if (name === 'chromium') choice = chosenValue('browser', cli, discoveryEnvironment, configs, spec.env);
    else choice = chosenValue(name, cli, discoveryEnvironment, configs, spec.env);
    if (oaExplicitlyDisabled && name === 'virtuoso' && !asString(choice.value)) {
      tools[name] = { name, selected: null, path: null, source: 'automatic', valid: false };
    } else {
      tools[name] = resolveTool(name, choice, spec, context, issues);
    }
  }
  if (!tools.chromium.valid && tools.chromium.source === 'automatic' && tools.firefox.valid) {
    tools.browser = { ...tools.firefox, name: 'browser' };
    for (let index = issues.length - 1; index >= 0; index -= 1) {
      if (issues[index].code === 'VL3D-E1003') issues.splice(index, 1);
    }
  } else {
    tools.browser = { ...tools.chromium, name: 'browser' };
    if (!tools.browser.valid && tools.browser.source === 'automatic') {
      for (let index = issues.length - 1; index >= 0; index -= 1) {
        if (issues[index].code === 'VL3D-E1003') issues.splice(index, 1);
      }
      addIssueOnce(issues, diagnosticIssue('E1003', { searched: [...TOOL_SPECS.chromium.candidates, ...TOOL_SPECS.firefox.candidates] }));
    }
  }
  const pythonProbe = versionProbe(tools.python.path, ['--version'], /Python\s+(\d+\.\d+(?:\.\d+)?)/i, 3000, env);
  if (tools.python.path && (!pythonProbe?.ok || !pythonProbe.version)) {
    tools.python.valid = false;
    addIssueOnce(issues, diagnosticIssue('E1002', { path: tools.python.path, probe: pythonProbe }));
  } else if (pythonProbe?.version) {
    const parts = pythonProbe.version.split('.').map(Number);
    if (parts[0] < PYTHON_MINIMUM[0] || (parts[0] === PYTHON_MINIMUM[0] && parts[1] < PYTHON_MINIMUM[1])) {
      tools.python.valid = false;
      addIssueOnce(issues, diagnosticIssue('E1002', { path: tools.python.path, version: pythonProbe.version, minimum: PYTHON_MINIMUM.join('.') }));
    }
  }
  const klayoutProbe = versionProbe(tools.klayout.path, ['-v'], /(?:KLayout\s*)?([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i, 5000, env);
  if (tools.klayout.path && !klayoutProbe?.ok) {
    tools.klayout.valid = false;
    addIssueOnce(issues, diagnosticIssue('E1007', { path: tools.klayout.path, probe: klayoutProbe }));
  } else if (tools.klayout.path && platform() === 'linux' && dirname(tools.klayout.path) === '/usr/bin') {
    const pluginDirectories = ['/usr/lib64/klayout/db_plugins', '/usr/lib/klayout/db_plugins', '/usr/lib64/klayout/plugins', '/usr/lib/klayout/plugins'];
    if (!pluginDirectories.some((path) => safeStat(path)?.isDirectory())) {
      tools.klayout.valid = false;
      addIssueOnce(issues, diagnosticIssue('E1007', { path: tools.klayout.path, missingPluginDirectories: pluginDirectories }));
    }
  }
  const hostChoice = chosenValue('host', cli, env, configs, ['VL3D_HOST']);
  const host = asString(hostChoice.value) || '127.0.0.1';
  const portChoice = chosenValue('port', cli, env, configs, ['VL3D_PORT']);
  const port = Number(portChoice.value ?? 5177);
  if (!Number.isInteger(port) || port < 1 || port > 65535) addIssueOnce(issues, diagnosticIssue('E2011', { value: portChoice.value }));
  const licenseChoice = chosenValue('license', cli, discoveryEnvironment, configs, ['VL3D_LICENSE', 'CDS_LIC_FILE', 'LM_LICENSE_FILE']);
  const license = asString(licenseChoice.value);
  if (!license && !oaExplicitlyDisabled) addIssueOnce(issues, diagnosticIssue('E1009'));
  else if (license && (license.startsWith('/') || license.startsWith('.') || license.startsWith('~'))
      && !readableFile(absolutePath(license, root, home))) {
    addIssueOnce(issues, diagnosticIssue('E1010', { path: absolutePath(license, root, home), source: licenseChoice.source }));
  }
  const effective = {
    root,
    host,
    port,
    enableOa: parsedEnable ?? Boolean(cdsLib.path && cadenceEnv.path && cadenceProbe.ok
      && tools.python.valid && tools.virtuoso.valid),
    cdsLib: cdsLib.path || cdsLib.selected,
    cadenceEnv: cadenceEnv.path || cadenceEnv.selected,
    libraryPath,
    license,
    tools: Object.fromEntries(Object.entries(tools).filter(([name]) => name !== 'browser').map(([name, tool]) => [name, tool.path || tool.selected])),
  };
  effective.tools.browser = tools.browser.path || tools.browser.selected;
  return {
    env,
    home,
    root,
    xdg,
    issues,
    effective,
    selected: { root: rootChoice, libraryPath: libraryChoice, cdsLib, cadenceEnv, license: licenseChoice, host: hostChoice, port: portChoice, enableOa: enableChoice },
    tools,
    probes: { python: pythonProbe, klayout: klayoutProbe, cadence: cadenceProbe },
    configs: configCandidates,
  };
}

export async function runDoctor(cli, options = {}) {
  const resolved = await resolveConfiguration(cli, options);
  const { issues, effective, tools, xdg, root } = resolved;
  const checks = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < NODE_MINIMUM_MAJOR) addIssueOnce(issues, diagnosticIssue('E1001', { version: process.versions.node, minimum: NODE_MINIMUM_MAJOR }));
  checks.push(checkRecord('node', 'Node.js', nodeMajor >= NODE_MINIMUM_MAJOR ? 'pass' : 'fail', { path: process.execPath, version: process.versions.node }, nodeMajor >= NODE_MINIMUM_MAJOR ? null : 'E1001'));
  const rootMetadata = safeStat(root);
  if (!rootMetadata?.isDirectory()) addIssueOnce(issues, diagnosticIssue('E2020', { root }));
  const serverPath = join(root, 'tools', 'server.mjs');
  const publicPath = join(root, 'public', 'index.html');
  const threePath = join(root, 'public', 'vendor', 'three.module.min.js');
  const threeCorePath = join(root, 'public', 'vendor', 'three.core.min.js');
  if (rootMetadata?.isDirectory() && (!readableFile(serverPath) || !readableFile(publicPath))) addIssueOnce(issues, diagnosticIssue('E2021', { serverPath, publicPath }));
  if (rootMetadata?.isDirectory() && !readableFile(threePath)) addIssueOnce(issues, diagnosticIssue('E2021', { threePath }));
  if (rootMetadata?.isDirectory() && !readableFile(threeCorePath)) addIssueOnce(issues, diagnosticIssue('E2021', { threeCorePath }));
  const projectReady = readableFile(serverPath) && readableFile(publicPath) && readableFile(threePath) && readableFile(threeCorePath);
  checks.push(checkRecord('project', 'Project installation', projectReady ? 'pass' : 'fail', root, projectReady ? null : 'E2021'));
  for (const [name, path] of Object.entries({ config: xdg.configDir, cache: xdg.cacheDir, state: xdg.stateDir })) {
    const writable = directoryWritable(path);
    if (!writable) addIssueOnce(issues, diagnosticIssue('E2013', { directory: name, path }));
    checks.push(checkRecord(`xdg-${name}`, `XDG ${name} directory`, writable ? 'pass' : 'fail', path, writable ? null : 'E2013'));
  }
  const cacheAudit = auditRuntimeCache(xdg.dataDir);
  for (const issue of cacheAudit.issues) addIssueOnce(issues, issue);
  checks.push(checkRecord(
    'runtime-cache',
    'Runtime cache integrity',
    cacheAudit.status,
    cacheAudit.details,
    cacheAudit.issues[0]?.code || null,
  ));
  const displayConfigured = platform() === 'linux' ? Boolean(resolved.env.DISPLAY) : true;
  if (!displayConfigured) addIssueOnce(issues, diagnosticIssue('E1011'));
  const nativeSelection = resolveNativePython({ internal: resolved }, cli);
  const nativeIsolation = inspectManagedNativeIsolation(nativeSelection);
  const nativeProbe = probeNativeRuntime(nativeSelection.path, root, resolved.env, { checkDisplay: displayConfigured });
  const nativeReady = nativeProbe.ready && nativeIsolation.ready;
  const nativeMissing = [...nativeProbe.missing, ...(nativeIsolation.ready ? [] : ['venv-isolation'])];
  const nativePickerReady = displayConfigured && nativeReady;
  const gdstkReady = Boolean(nativeProbe.details?.versions?.gdstk);
  resolved.native = { ...nativeSelection, isolation: nativeIsolation, probe: nativeProbe };
  if (nativePickerReady) removeIssuesByCode(issues, ['E1004', 'E1005']);
  if (gdstkReady && tools.klayout.source === 'automatic') removeIssuesByCode(issues, ['E1006', 'E1007']);
  const toolLabels = { python: 'Python 3', browser: 'Browser', picker: 'File picker', xprop: 'xprop', klayout: 'KLayout compatibility fallback', virtuoso: 'Virtuoso' };
  for (const name of ['python', 'browser', 'picker', 'xprop', 'klayout', 'virtuoso']) {
    const tool = name === 'browser' ? tools.browser : tools[name];
    const code = TOOL_SPECS[name === 'browser' ? 'chromium' : name].code;
    const alternativeReady = (name === 'picker' || name === 'xprop') ? nativePickerReady : name === 'klayout' && gdstkReady;
    const alternativeValue = name === 'klayout'
      ? `gdstk ${nativeProbe.details?.versions?.gdstk || ''} (primary importer)`
      : 'Tkinter (built-in)';
    checks.push(checkRecord(
      `tool-${name}`,
      toolLabels[name],
      tool.valid || alternativeReady ? 'pass' : 'warn',
      tool.path || tool.selected || (alternativeReady ? alternativeValue : null),
      tool.valid || alternativeReady ? null : code,
    ));
  }
  checks.push(checkRecord(
    'display',
    'Desktop display',
    displayConfigured && (!nativeSelection.path || !nativeProbe.missing.includes('tk-display')) ? 'pass' : 'warn',
    resolved.env.DISPLAY || resolved.env.WAYLAND_DISPLAY || null,
    displayConfigured ? (nativeProbe.missing.includes('tk-display') ? 'E1012' : null) : 'E1011',
  ));
  if (!nativeReady) {
    const missingTk = nativeProbe.missing.includes('tkinter') || nativeProbe.missing.includes('tk-display');
    addIssueOnce(issues, diagnosticIssue(missingTk ? 'E1012' : 'E1013', {
      python: nativeSelection.path,
      missing: nativeMissing,
      venvDirectory: nativeSelection.venvDirectory,
      isolation: nativeIsolation,
    }, 'warning'));
  }
  checks.push(checkRecord(
    'native-runtime',
    'Native Tk/OpenGL runtime',
    nativeReady ? 'pass' : 'warn',
    { python: nativeSelection.path, missing: nativeMissing, isolated: nativeIsolation.ready },
    nativeReady ? null : (nativeProbe.missing.includes('tkinter') || nativeProbe.missing.includes('tk-display') ? 'E1012' : 'E1013'),
  ));
  checks.push(checkRecord('cds-lib', 'Cadence library registry', resolved.selected.cdsLib.valid ? 'pass' : 'warn', effective.cdsLib, resolved.selected.cdsLib.valid ? null : 'E2003'));
  const cadenceReady = resolved.selected.cadenceEnv.valid && resolved.probes.cadence.ok;
  checks.push(checkRecord('cadence-env', 'Cadence environment adapter', cadenceReady ? 'pass' : 'warn', effective.cadenceEnv, cadenceReady ? null : (resolved.selected.cadenceEnv.valid ? 'E3002' : 'E2009')));
  checks.push(checkRecord('license', 'Cadence license setting', effective.license ? 'pass' : 'warn', effective.license ? '<configured>' : null, effective.license ? null : 'E1009'));
  if (effective.cdsLib && readableFile(effective.cdsLib)) {
    const content = readFileSync(effective.cdsLib, 'utf8').slice(0, 4 * 1024 * 1024);
    const unresolved = [...content.matchAll(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g)]
      .map((match) => match[1] || match[2]).filter((name) => !resolved.probes.cadence.environment[name]);
    if (unresolved.length) addIssueOnce(issues, diagnosticIssue('E2010', { variables: [...new Set(unresolved)] }));
    if (!/^\s*(?:DEFINE|INCLUDE|SOFTINCLUDE)\b/im.test(content)) addIssueOnce(issues, diagnosticIssue('E2005', { path: effective.cdsLib }));
  }
  const dynamicNativePort = cli.command === 'gui';
  const configuredPortBlocking = cli.command === 'web' || cli.command === 'start';
  let portProbe = dynamicNativePort
    ? { available: true, dynamic: true }
    : { available: false, code: 'EINVAL', message: 'invalid port' };
  if (!dynamicNativePort && Number.isInteger(effective.port) && effective.port >= 1 && effective.port <= 65535) {
    portProbe = await probePort(effective.host, effective.port);
    if (!portProbe.available) addIssueOnce(issues, diagnosticIssue('E2012', {
      host: effective.host,
      port: effective.port,
      systemCode: portProbe.code,
      message: portProbe.message,
    }, configuredPortBlocking ? undefined : 'warning'));
  }
  const validPort = Number.isInteger(effective.port) && effective.port >= 1 && effective.port <= 65535;
  checks.push(checkRecord(
    'port',
    dynamicNativePort ? 'Native loopback port' : 'Server port',
    portProbe.available ? 'pass' : (configuredPortBlocking ? 'fail' : 'warn'),
    dynamicNativePort ? 'dynamic' : `${effective.host}:${effective.port}`,
    portProbe.available ? null : (validPort ? 'E2012' : 'E2011'),
  ));
  if (effective.enableOa && !LOOPBACK_HOSTS.has(effective.host.toLowerCase())) {
    addIssueOnce(issues, diagnosticIssue('E2015', { field: 'host', value: effective.host, message: 'OA loading requires a loopback host' }));
  }
  if (effective.enableOa && !resolved.selected.cadenceEnv.valid) addIssueOnce(issues, diagnosticIssue('E3002', { cadenceEnv: effective.cadenceEnv }));
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const viewerErrorCount = issues.filter((issue) => (
    issue.severity === 'error'
    && !(issue.code === 'VL3D-E2015' && issue.details?.field === 'python')
  )).length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
  const ready = {
    native: Boolean(nativePickerReady),
    viewer: viewerErrorCount === 0 && portProbe.available && projectReady,
    oa: Boolean(tools.python.valid && tools.virtuoso.valid && resolved.selected.cdsLib.valid
      && resolved.selected.cadenceEnv.valid && resolved.probes.cadence.ok),
    stream: Boolean(tools.python.valid && (tools.klayout.valid || gdstkReady)),
    graphicalPicker: Boolean(nativePickerReady || (tools.picker.valid && displayConfigured)),
  };
  return {
    schemaVersion: 1,
    command: 'doctor',
    ok: errorCount === 0,
    timestamp: new Date().toISOString(),
    platform: { os: platform(), arch: process.arch, node: process.versions.node },
    ready,
    summary: { passed: checks.filter((check) => check.status === 'pass').length, warnings: warningCount, errors: errorCount },
    paths: { projectRoot: root, ...xdg },
    effective: sanitizeEffective(effective),
    sources: Object.fromEntries(resolved.configs.map((candidate) => [candidate.source, { path: candidate.path, exists: candidate.exists, invalid: Boolean(candidate.invalid) }])),
    checks,
    issues,
    internal: resolved,
  };
}

function withoutInternal(report) {
  const { internal, ...publicReport } = report;
  return publicReport;
}

function existingUserConfig(report) {
  return report.internal.configs.find((candidate) => candidate.source === 'user-config')?.config || {};
}

function explicitCliFields(cli) {
  return new Set(Object.keys(cli.values));
}

export function buildSetupConfig(report, cli) {
  const existing = existingUserConfig(report);
  const proposed = JSON.parse(JSON.stringify(existing));
  proposed.schemaVersion = CONFIG_SCHEMA_VERSION;
  const explicit = explicitCliFields(cli);
  const simpleFields = ['host', 'port', 'enableOa', 'cdsLib', 'cadenceEnv', 'libraryPath'];
  for (const field of simpleFields) {
    if (explicit.has(field)) proposed[field] = report.internal.effective[field];
    else if (proposed[field] === undefined && report.internal.effective[field] !== null) proposed[field] = report.internal.effective[field];
  }
  if (explicit.has('root')) proposed.root = report.internal.effective.root;
  if (explicit.has('license')) proposed.license = report.internal.effective.license;
  if (!proposed.tools || typeof proposed.tools !== 'object' || Array.isArray(proposed.tools)) proposed.tools = {};
  for (const field of ['python', 'browser', 'picker', 'xprop', 'klayout', 'virtuoso']) {
    const cliField = field === 'browser' ? 'browser' : field;
    const detected = report.internal.effective.tools[field];
    if (explicit.has(cliField)) proposed.tools[field] = detected;
    else if (proposed.tools[field] === undefined && detected && report.internal.tools[field].valid) {
      proposed.tools[field] = detected;
    }
  }
  if (cli.install || cli.values.nativePython || cli.values.nativeVenv) {
    if (!proposed.native || typeof proposed.native !== 'object' || Array.isArray(proposed.native)) proposed.native = {};
    const native = resolveNativePython(report, cli);
    const installedPython = cli.install ? join(native.venvDirectory, 'bin', 'python') : native.path;
    if (installedPython) proposed.native.nativePython = installedPython;
    proposed.native.venv = native.venvDirectory;
  }
  return proposed;
}

export function atomicWriteJson(path, payload) {
  const directory = dirname(path);
  ensurePrivateDirectory(directory);
  const directoryMetadata = lstatSync(directory);
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) throw new CliError(`Unsafe configuration directory: ${directory}`, 'E2014');
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new CliError(`Refusing to replace symlinked configuration: ${path}`, 'E2014');
  const temporary = join(directory, `.config.json.tmp-${process.pid}-${Date.now()}`);
  let descriptor = null;
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    if (existsSync(path)) {
      const now = new Date();
      const stamp = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
        '-',
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
        String(now.getSeconds()).padStart(2, '0'),
      ].join('');
      const backup = `${path}.bak-${stamp}`;
      if (!existsSync(backup)) {
        copyFileSync(path, backup, constants.COPYFILE_EXCL);
        chmodSync(backup, 0o600);
      }
    }
    renameSync(temporary, path);
    const directoryDescriptor = openSync(directory, constants.O_RDONLY);
    fsyncSync(directoryDescriptor);
    closeSync(directoryDescriptor);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    try { unlinkSync(temporary); } catch {}
  }
}

export function buildStartPlan(report) {
  const effective = report.internal.effective;
  const serverPath = join(effective.root, 'tools', 'server.mjs');
  const args = [serverPath, '--root', effective.root, '--host', effective.host, '--port', String(effective.port)];
  if (effective.enableOa) args.push('--enable-oa');
  const environment = { ...report.internal.env };
  const assignments = {};
  const add = (name, value) => {
    if (!value) return;
    environment[name] = String(value);
    assignments[name] = name.includes('LIC') ? '<configured>' : String(value);
  };
  const validToolPath = (name) => (
    report.internal.tools[name]?.valid ? report.internal.tools[name].path : null
  );
  const nativeProbe = report.internal.native?.probe;
  // Geometry work does not require Tk, an X display or an OpenGL context.
  const traceRuntimeReady = nativeProbe?.status === 0 && !nativeProbe.error
    && ['numpy', 'ijson', 'gdstk'].every((name) => Object.hasOwn(nativeProbe.details?.versions || {}, name));
  add('VL3D_PYTHON', nativeProbe?.ready || traceRuntimeReady
    ? report.internal.native.path
    : validToolPath('python'));
  add('VL3D_CDS_LIB', report.internal.selected.cdsLib.valid ? report.internal.selected.cdsLib.path : null);
  add('VL3D_CADENCE_ENV', report.internal.selected.cadenceEnv.valid ? report.internal.selected.cadenceEnv.path : null);
  add('KLAYOUT_BIN', validToolPath('klayout'));
  add('VL3D_VIRTUOSO', validToolPath('virtuoso'));
  add('VL3D_FILE_PICKER', validToolPath('picker'));
  add('VL3D_XPROP', validToolPath('xprop'));
  add('VL3D_CONFIG_DIR', report.internal.xdg.configDir);
  add('VL3D_CACHE_DIR', report.internal.xdg.cacheDir);
  add('VL3D_STATE_DIR', report.internal.xdg.stateDir);
  add('VL3D_DATA_DIR', report.internal.xdg.dataDir);
  const selectedConfig = report.internal.configs.find((candidate) => candidate.exists && !candidate.invalid);
  add('VL3D_CONFIG', selectedConfig?.path);
  if (effective.license && !environment.CDS_LIC_FILE && !environment.LM_LICENSE_FILE) add('CDS_LIC_FILE', effective.license);
  return {
    executable: process.execPath,
    args,
    environment,
    displayedEnvironment: assignments,
    url: `http://${effective.host.includes(':') ? `[${effective.host}]` : effective.host}:${effective.port}/public/`,
  };
}

export function buildNativePlan(report, cli = { values: {} }) {
  const web = buildStartPlan(report);
  const native = resolveNativePython(report, cli);
  const serverArgs = [
    join(report.internal.effective.root, 'tools', 'server.mjs'),
    '--root', report.internal.effective.root,
    '--host', '127.0.0.1',
    '--port', '0',
    '--native-private',
    '--auth-fd', '3',
    '--parent-fd', '3',
  ];
  if (report.internal.effective.enableOa) serverArgs.push('--enable-oa');
  return {
    server: {
      executable: process.execPath,
      args: serverArgs,
      environment: { ...web.environment, ...(native.path ? { VL3D_PYTHON: native.path } : {}) },
    },
    native: {
      executable: native.path,
      args: ['-m', 'native.app', '--root', report.internal.effective.root, '--backend-stdin'],
      venvDirectory: native.venvDirectory,
    },
  };
}

function waitForNativeServer(child) {
  return new Promise((resolveReady, rejectReady) => {
    let buffer = '';
    let settled = false;
    const finishError = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectReady(error instanceof CliError ? error : new CliError(error.message, 'E8009'));
    };
    const timer = setTimeout(() => finishError(new CliError('Native backend readiness timed out', 'E8009')), NATIVE_READY_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trimEnd();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('VL3D_READY ')) {
          if (settled) continue;
          try {
            const ready = JSON.parse(line.slice('VL3D_READY '.length));
            if (!LOOPBACK_HOSTS.has(String(ready.host || '').toLowerCase())
                || !Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535) {
              throw new Error('backend returned an unsafe readiness address');
            }
            settled = true;
            clearTimeout(timer);
            resolveReady(ready);
          } catch (error) {
            finishError(new CliError(`Invalid native backend readiness payload: ${error.message}`, 'E8009'));
          }
        } else if (line) {
          process.stdout.write(`${line}\n`);
        }
      }
    });
    child.once('error', (error) => finishError(new CliError(`Native backend failed to start: ${error.message}`, 'E8009')));
    child.once('exit', (code, signal) => {
      if (!settled) finishError(new CliError(`Native backend exited before readiness (${code ?? signal ?? 'unknown'})`, 'E8009'));
    });
  });
}

async function stopOwnedChild(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function launchNative(report, cli) {
  const plan = buildNativePlan(report, cli);
  if (platform() === 'linux' && !report.internal.env.DISPLAY) throw new CliError('Native GUI requires an X11 or XWayland display', 'E1011');
  const isolation = inspectManagedNativeIsolation(report.internal.native || {
    source: plan.native.source,
    venvDirectory: plan.native.venvDirectory,
  });
  if (!isolation.ready) throw new CliError('Managed native environment is not isolated; rerun `vl3d setup --native --install`', 'E1013');
  const probe = probeNativeRuntime(plan.native.executable, report.internal.effective.root, report.internal.env, { checkDisplay: true });
  if (!probe.ready) {
    const code = probe.missing.includes('tkinter') || probe.missing.includes('tk-display') ? 'E1012' : 'E8008';
    throw new CliError(`Native GUI runtime is incomplete: ${probe.missing.join(', ')}`, code);
  }
  const token = randomBytes(32).toString('base64url');
  const server = spawn(plan.server.executable, plan.server.args, {
    cwd: report.internal.effective.root,
    env: plan.server.environment,
    stdio: ['ignore', 'pipe', 'inherit', 'pipe'],
  });
  let native = null;
  const forwardSignal = (signal) => {
    if (native && !native.killed) native.kill(signal);
    if (!server.killed) server.kill(signal);
  };
  const interrupt = () => forwardSignal('SIGINT');
  const terminate = () => forwardSignal('SIGTERM');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    server.stdio[3].on('error', () => {});
    server.stdio[3].write(`${token}\n`);
    const ready = await waitForNativeServer(server);
    const backendUrl = `http://${ready.host.includes(':') ? `[${ready.host}]` : ready.host}:${ready.port}`;
    const nativeEnvironment = { ...plan.server.environment, LANG: report.internal.env.LANG || 'C' };
    delete nativeEnvironment.CDS_LIC_FILE;
    delete nativeEnvironment.LM_LICENSE_FILE;
    delete nativeEnvironment.VL3D_LICENSE;
    native = spawn(plan.native.executable, plan.native.args, {
      cwd: report.internal.effective.root,
      env: nativeEnvironment,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    native.stdin.on('error', () => {});
    native.stdin.end(`${JSON.stringify({
      backendUrl,
      token,
      configFile: report.paths.configFile,
      advancedSettings: ready.advancedSettings || {},
    })}\n`);
    return await new Promise((resolveExit, rejectExit) => {
      native.once('error', (error) => rejectExit(new CliError(`Native GUI failed to start: ${error.message}`, 'E8008')));
      native.once('exit', (code, signal) => resolveExit(Number.isInteger(code) ? code : signal === 'SIGINT' ? 130 : 1));
      server.once('exit', (code, signal) => {
        if (native.exitCode === null && native.signalCode === null) {
          native.kill('SIGTERM');
          rejectExit(new CliError(`Native backend disconnected (${code ?? signal ?? 'unknown'})`, 'E8009'));
        }
      });
    });
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    try { server.stdio[3].end(); } catch {}
    await stopOwnedChild(native);
    await stopOwnedChild(server);
  }
}

function printDoctor(report) {
  const symbol = { pass: 'OK', warn: 'WARN', fail: 'FAIL' };
  process.stdout.write(`VL3D doctor: ${report.ok ? 'ready' : 'blocked'}\n`);
  for (const check of report.checks) {
    const suffix = check.value === undefined || check.value === null ? '' : ` — ${typeof check.value === 'object' ? JSON.stringify(check.value) : check.value}`;
    process.stdout.write(`[${symbol[check.status]}] ${check.label}${check.code ? ` (${check.code})` : ''}${suffix}\n`);
  }
  for (const issue of report.issues) process.stdout.write(`${issue.code} ${issue.severity.toUpperCase()}: ${issue.title}\n  ${issue.remedy}\n`);
  process.stdout.write(`Ready: native=${report.ready.native} web=${report.ready.viewer} oa=${report.ready.oa} stream=${report.ready.stream} picker=${report.ready.graphicalPicker}\n`);
}

function usage() {
  return [
    'Usage: vl3d [gui|web|doctor|setup] [options]',
    '',
    'Commands:',
    '  gui                 Start the native Tk/OpenGL application (default)',
    '  web                 Start the browser compatibility UI',
    '  start               Deprecated alias for web',
    '  doctor              Detect dependencies, paths, permissions, and port readiness',
    '  setup [--write]      Propose or save configuration',
    '  setup --native --install  Create the private native Python environment and save it',
    '',
    'Options:',
    '  --json --root PATH --host HOST --port PORT --config FILE',
    '  --python FILE --browser FILE --picker FILE --xprop FILE',
    '  --klayout FILE --virtuoso FILE --cds-lib FILE --cadence-env FILE',
    '  --library PATH --license VALUE --enable-oa --no-oa',
    '  --native-python FILE --venv DIR --wheelhouse DIR --dry-run',
    '',
    'Priority: command line > VL3D environment > user XDG config > project config > auto-detection.',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  let cli;
  const requestedJson = argv.includes('--json');
  try {
    cli = parseCli(argv);
    if (cli.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    let report = await runDoctor(cli);
    if (cli.command === 'doctor') {
      if (cli.json) process.stdout.write(`${JSON.stringify(withoutInternal(report), null, 2)}\n`);
      else printDoctor(report);
      return report.ok ? 0 : 1;
    }
    if (cli.command === 'setup') {
      let nativeInstall = null;
      if (cli.install) {
        nativeInstall = installNativeRuntime(report, cli);
        report = await runDoctor(cli);
      }
      const proposed = buildSetupConfig(report, cli);
      const setupBlocking = report.issues.filter((issue) => issue.severity === 'error' && issue.code !== 'VL3D-E2012');
      let written = false;
      if (cli.write || cli.install) {
        if (setupBlocking.length) throw new CliError('Refusing to write configuration while setup reports blocking errors', 'E2014');
        try {
          atomicWriteJson(report.paths.configFile, proposed);
        } catch (error) {
          if (error instanceof CliError) throw error;
          throw new CliError(error.message, 'E2014');
        }
        written = true;
      }
      const output = {
        ...withoutInternal(report),
        command: 'setup',
        written,
        configPath: report.paths.configFile,
        proposed,
        ...(nativeInstall ? { nativeInstall: { pythonPath: nativeInstall.pythonPath, venvDirectory: nativeInstall.venvDirectory } } : {}),
      };
      if (cli.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      else {
        process.stdout.write(`${written ? 'Wrote' : 'Proposed'} ${report.paths.configFile}\n${JSON.stringify(proposed, null, 2)}\n`);
        if (!written) process.stdout.write('No files changed; rerun with --write to save.\n');
      }
      return setupBlocking.length ? 1 : 0;
    }
    if (cli.command === 'gui') {
      const plan = buildNativePlan(report, cli);
      if (!readableFile(plan.server.args[0]) || !readableFile(join(report.internal.effective.root, 'native', 'app.py'))) {
        throw new CliError('Native application files are missing from this installation', 'E2021');
      }
      if (cli.dryRun) {
        const output = {
          command: 'gui',
          dryRun: true,
          server: { executable: plan.server.executable, args: plan.server.args },
          native: plan.native,
          secretTransport: 'anonymous pipes',
        };
        process.stdout.write(`${cli.json ? JSON.stringify(output, null, 2) : `${plan.native.executable} ${plan.native.args.map((arg) => JSON.stringify(arg)).join(' ')}`}\n`);
        return 0;
      }
      if (cli.json) throw new CliError('Use --json together with --dry-run for gui', 'E2015');
      process.stdout.write('Starting VL3D native UI\n');
      return await launchNative(report, cli);
    }
    const plan = buildStartPlan(report);
    if (!report.ready.viewer) throw new CliError('Viewer preflight failed; run doctor and resolve the reported errors', 'E2020');
    if (report.internal.effective.enableOa && !report.ready.oa) throw new CliError('OA was requested but its preflight is incomplete', 'E3002');
    if (cli.dryRun) {
      const output = { command: 'start', dryRun: true, executable: plan.executable, args: plan.args, environment: plan.displayedEnvironment, url: plan.url };
      process.stdout.write(`${cli.json ? JSON.stringify(output, null, 2) : `${plan.executable} ${plan.args.map((arg) => JSON.stringify(arg)).join(' ')}\n${plan.url}`}\n`);
      return 0;
    }
    if (cli.json) throw new CliError('Use --json together with --dry-run for start', 'E2015');
    if (cli.command === 'start') process.stdout.write('VL3D: `start` is deprecated; use `web`.\n');
    process.stdout.write(`Starting VL3D at ${plan.url}\n`);
    const child = spawn(plan.executable, plan.args, { cwd: report.internal.effective.root, env: plan.environment, stdio: 'inherit' });
    const forward = (signal) => {
      if (!child.killed) child.kill(signal);
    };
    process.once('SIGINT', () => forward('SIGINT'));
    process.once('SIGTERM', () => forward('SIGTERM'));
    return await new Promise((resolveExit, reject) => {
      child.once('error', (error) => reject(new CliError(error.message, 'E9004')));
      child.once('exit', (code, signal) => resolveExit(Number.isInteger(code) ? code : signal === 'SIGINT' ? 130 : 1));
    });
  } catch (error) {
    const payload = errorPayload(error, error.code || 'E9001');
    if (cli?.json || requestedJson) process.stderr.write(`${JSON.stringify(payload)}\n`);
    else process.stderr.write(`${payload.error.code}: ${payload.error.message}\n${payload.error.remedy}\n`);
    return 2;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : null;
if (invokedPath === import.meta.url) process.exitCode = await main();
