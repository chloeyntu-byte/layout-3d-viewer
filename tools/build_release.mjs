#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { gzipSync } from 'node:zlib';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const canonicalRepository = realpathSync(repository);
const packageMetadata = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
const releaseName = `${packageMetadata.name}-${packageMetadata.version}`;
const REQUIRED_FILES = Object.freeze([
  '.gitignore',
  '.npmignore',
  'README.md',
  'README.zh-CN.md',
  'CHANGELOG.md',
  'RELEASE_NOTES.md',
  'LICENSE',
  'NOTICE',
  'CONTRIBUTING.md',
  'docs/USAGE.md',
  'docs/PIN_ANNOTATION.md',
  'docs/LAYOUT_JSON.md',
  'docs/LAYER_PROFILES.md',
  'docs/NET_TRACING_PLAN.md',
  'examples/hierarchy-demo.json',
  'examples/octagon-inductor.json',
  'profiles/example-process.json',
  'native/fieldwork_tk.py',
  'tools/make_example_inductor.py',
  'tests/test_ui_smoke.py',
  'examples/physical-trace-demo.json',
  'examples/pin-annotation-layout.json',
  'examples/pin-annotations.json',
  'bin/vl3d',
  'package.json',
  'package-lock.json',
  'docs/INSTALL.md',
  'docs/TROUBLESHOOTING.md',
  'requirements-native.txt',
  'native/__init__.py',
  'native/__main__.py',
  'native/app.py',
  'native/backend.py',
  'native/cache.py',
  'native/compiler.py',
  'native/compiler_worker.py',
  'native/physical_trace.py',
  'native/trace_worker.py',
  'native/config.py',
  'native/errors.py',
  'native/gl_view.py',
  'native/navigation.py',
  'native/pin_presentation.py',
  'native/palettes.py',
  'native/selection.py',
  'public/index.html',
  'public/errors.html',
  'public/styles.css',
  'public/src/fallback.js',
  'public/src/model.js',
  'public/src/geometry.js',
  'public/src/trace-client.js',
  'public/src/viewer-next.js',
  'public/vendor/THREE-LICENSE.txt',
  'public/vendor/THREE-VERSION.txt',
  'public/vendor/three.core.min.js',
  'public/vendor/three.module.min.js',
  'tools/STREAM_IMPORT.md',
  'tools/annotate_pins.py',
  'tools/layout_units.py',
  'tools/build_release.mjs',
  'tools/build_stress_layout.py',
  'tools/convert_layout_tsv.py',
  'tools/error_catalog.mjs',
  'tools/export_layouts.sh',
  'tools/import_stream_layout.py',
  'tools/layout_catalog.mjs',
  'tools/library_sessions.mjs',
  'tools/oa_dump.il',
  'tools/pdk_profile.py',
  'tools/technology_layers.py',
  'tools/runtime_paths.mjs',
  'tools/server.mjs',
  'tools/trace_service.mjs',
  'tools/trace_rules.py',
  'tools/klayout_macro.py',
  'tools/test_doctor.mjs',
  'tools/test_library_sessions.mjs',
  'tools/test_pdk_compat.py',
  'tools/test_runtime_paths.mjs',
  'tools/test_release.mjs',
  'tools/test_server_runtime.mjs',
  'tools/test_stream_import.py',
  'tools/verify_viewer.mjs',
  'tools/vl3d.mjs',
  'tests/backend/test_native_backend.mjs',
  'tests/backend/test_stream_import_gdstk.py',
  'tests/native/test_backend.py',
  'tests/native/test_bootstrap.py',
  'tests/native/test_cache.py',
  'tests/native/test_compiler.py',
  'tests/native/test_config.py',
  'tests/native/test_coordinate_axes.py',
  'tests/native/test_navigation.py',
  'tests/native/test_palettes.py',
  'tests/native/test_selection.py',
]);
const OPTIONAL_FILES = Object.freeze([
  '.github/workflows/ci.yml',
  'vl3d.config.example.json',
]);
const FORBIDDEN_PATH = /(^|\/)(?:public\/data|backups|exports|screenshots|reports|release|dist)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.bak-[^/]*$|(?:^|\/)(?:cds\.lib|lib\.defs|vl3d\.config\.json)$/i;
const FORBIDDEN_CONTENT = Object.freeze([
  { pattern: /\/home\/[A-Za-z0-9_.-]+\//, label: 'machine-specific home path' },
  { pattern: /\/root\//, label: 'machine-specific root path' },
]);
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_RELEASE_BYTES = 48 * 1024 * 1024;
const REQUIRED_NPM_ENTRIES = Object.freeze([
  'bin/vl3d',
  'requirements-native.txt',
  'native/*.py',
  'profiles/*.json',
  'public/index.html',
  'public/styles.css',
  'public/src/viewer-next.js',
  'public/vendor/three.core.min.js',
  'public/vendor/three.module.min.js',
  'tools/error_catalog.mjs',
  'tools/import_stream_layout.py',
  'tools/layout_catalog.mjs',
  'tools/library_sessions.mjs',
  'tools/server.mjs',
  'tools/vl3d.mjs',
]);
const PINNED_VENDOR_HASHES = Object.freeze({
  'public/vendor/three.module.min.js': '06552c54e4071fbc7305117aafe6765d92c5d2a2a83507d4f05b9bf4f3d4d463',
  'public/vendor/three.core.min.js': '79f2b4f58d3e99a9948a4d3b7f6d5c2daf705bdefe9fb82ebec715623966551c',
});

function usage() {
  return [
    'Usage: node tools/build_release.mjs [options]',
    '',
    'Options:',
    '  --output-dir PATH   Staged source directory',
    '  --archive PATH      Source tar.gz archive',
    '  --check             Audit only; write nothing',
    '  --json              Emit machine-readable summary',
    '  --help              Show this help',
  ].join('\n');
}

function argumentValue(argv, index, option) {
  if (index + 1 >= argv.length) throw new Error(`Missing value for ${option}`);
  return argv[index + 1];
}

function parseArguments(argv) {
  const defaults = join(repository, 'release', releaseName);
  const options = { outputDirectory: defaults, archive: `${defaults}.tar.gz`, check: false, json: false };
  let archiveExplicit = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--output-dir') {
      options.outputDirectory = resolve(argumentValue(argv, index++, argument));
      if (!archiveExplicit) options.archive = `${options.outputDirectory}.tar.gz`;
    } else if (argument === '--archive') {
      options.archive = resolve(argumentValue(argv, index++, argument));
      archiveExplicit = true;
    } else if (argument === '--check') options.check = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function pathWithin(parent, candidate) {
  const suffix = relative(parent, candidate);
  return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix));
}

function normalizedRelativePath(path) {
  return path.split(sep).join('/');
}

function profileFiles() {
  const directory = join(repository, 'profiles');
  if (!existsSync(directory)) throw new Error('Missing required profiles directory');
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.json')
    .map((entry) => `profiles/${entry.name}`)
    .sort();
}

function verifyAutomaticNpmFiles() {
  const allowed = new Set(['README.md', 'README.zh-CN.md', 'LICENSE', 'LICENSE.md', 'LICENCE', 'LICENCE.md', 'NOTICE', 'NOTICE.md']);
  const unexpected = readdirSync(repository, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(?:readme|license|licence|notice)(?:$|\.)/i.test(entry.name) && !allowed.has(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (unexpected.length) throw new Error(`npm would automatically include unexpected root documentation: ${unexpected.join(', ')}`);
}

function collectFiles() {
  verifyAutomaticNpmFiles();
  const tests = ['tests/native', 'tests/backend'].flatMap((directory) =>
    readdirSync(join(repository, directory), { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^test_[\w-]+\.(?:py|mjs)$/.test(entry.name))
      .map((entry) => `${directory}/${entry.name}`));
  const candidates = [...REQUIRED_FILES, ...OPTIONAL_FILES.filter((path) => existsSync(join(repository, path))), ...profileFiles(), ...tests];
  const unique = [...new Set(candidates)].sort();
  for (const path of REQUIRED_FILES) {
    if (!existsSync(join(repository, path))) throw new Error(`Missing required release file: ${path}`);
  }
  return unique.map((path) => {
    const normalized = normalizedRelativePath(path);
    if (!normalized || normalized.startsWith('/') || normalized.includes('../') || FORBIDDEN_PATH.test(normalized)) {
      throw new Error(`Forbidden release path: ${normalized}`);
    }
    const source = join(repository, path);
    const metadata = lstatSync(source);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Release source must be a regular file: ${normalized}`);
    const canonical = realpathSync(source);
    if (!pathWithin(canonicalRepository, canonical)) throw new Error(`Release source escapes repository: ${normalized}`);
    if (metadata.size > MAX_FILE_BYTES) throw new Error(`Release file exceeds ${MAX_FILE_BYTES} bytes: ${normalized}`);
    const contents = readFileSync(source);
    if (!contents.includes(0)) {
      const text = contents.toString('utf8');
      for (const rule of FORBIDDEN_CONTENT) {
        if (rule.pattern.test(text)) throw new Error(`${normalized} contains ${rule.label}`);
      }
    }
    return {
      path: normalized,
      contents,
      mode: metadata.mode & 0o111 ? 0o755 : 0o644,
      sha256: createHash('sha256').update(contents).digest('hex'),
    };
  });
}

function manifestContents(files) {
  return Buffer.from(`${files.map((file) => `${file.sha256}  ${file.path}`).join('\n')}\n`, 'utf8');
}

function writeFileAtomically(path, contents, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${Date.now()}`);
  let descriptor = null;
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== null) {
      closeSync(descriptor);
    }
    rmSync(temporary, { force: true });
  }
}

function stageDirectory(files, outputDirectory) {
  const parent = dirname(outputDirectory);
  mkdirSync(parent, { recursive: true, mode: 0o755 });
  const staging = join(parent, `.${basename(outputDirectory)}.tmp-${process.pid}-${Date.now()}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { mode: 0o755 });
  try {
    for (const file of files) {
      const target = join(staging, ...file.path.split('/'));
      mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
      writeFileSync(target, file.contents, { mode: file.mode, flag: 'wx' });
    }
    const manifest = manifestContents(files);
    writeFileSync(join(staging, 'MANIFEST.sha256'), manifest, { mode: 0o644, flag: 'wx' });
    const previous = join(parent, `.${basename(outputDirectory)}.old-${process.pid}-${Date.now()}`);
    if (existsSync(outputDirectory)) renameSync(outputDirectory, previous);
    try {
      renameSync(staging, outputDirectory);
      rmSync(previous, { recursive: true, force: true });
    } catch (error) {
      if (existsSync(previous) && !existsSync(outputDirectory)) renameSync(previous, outputDirectory);
      throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function writeTarString(header, offset, length, value) {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length > length) throw new Error(`Tar field is too long: ${value}`);
  encoded.copy(header, offset);
}

function writeTarOctal(header, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, '0');
  writeTarString(header, offset, length, `${encoded}\0`);
}

function splitTarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  for (let index = path.lastIndexOf('/'); index > 0; index = path.lastIndexOf('/', index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`Tar path is too long: ${path}`);
}

function tarHeader(path, size, mode, type, timestamp) {
  const header = Buffer.alloc(512);
  const split = splitTarPath(path);
  writeTarString(header, 0, 100, split.name);
  writeTarOctal(header, 100, 8, mode);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, timestamp);
  header.fill(0x20, 148, 156);
  writeTarString(header, 156, 1, type);
  writeTarString(header, 257, 6, 'ustar\0');
  writeTarString(header, 263, 2, '00');
  writeTarString(header, 265, 32, 'root');
  writeTarString(header, 297, 32, 'root');
  if (split.prefix) writeTarString(header, 345, 155, split.prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0');
  writeTarString(header, 148, 8, `${checksum}\0 `);
  return header;
}

function archiveContents(files) {
  const epochText = process.env.SOURCE_DATE_EPOCH || '1577836800';
  if (!/^\d+$/.test(epochText)) throw new Error('SOURCE_DATE_EPOCH must be a non-negative integer');
  const timestamp = Number(epochText);
  const manifest = manifestContents(files);
  const archiveFiles = [...files, {
    path: 'MANIFEST.sha256',
    contents: manifest,
    mode: 0o644,
    sha256: createHash('sha256').update(manifest).digest('hex'),
  }];
  const directories = new Set([`${releaseName}/`]);
  for (const file of archiveFiles) {
    const pieces = file.path.split('/');
    for (let index = 1; index < pieces.length; index += 1) {
      directories.add(`${releaseName}/${pieces.slice(0, index).join('/')}/`);
    }
  }
  const chunks = [];
  for (const path of [...directories].sort()) chunks.push(tarHeader(path, 0, 0o755, '5', timestamp));
  for (const file of archiveFiles) {
    const path = `${releaseName}/${file.path}`;
    chunks.push(tarHeader(path, file.contents.length, file.mode, '0', timestamp), file.contents);
    const padding = (512 - (file.contents.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

function verifyNpmAllowlist() {
  const permitted = new Set([
    'tools/annotate_pins.py', 'tools/layout_units.py', 'docs/PIN_ANNOTATION.md', 'docs/LAYOUT_JSON.md', 'docs/LAYER_PROFILES.md',
    'LICENSE', 'NOTICE', 'CONTRIBUTING.md', 'docs/USAGE.md', 'docs/NET_TRACING_PLAN.md', 'examples/*.json', 'tools/test_release.mjs',
    'README.md',
    'README.zh-CN.md',
    'CHANGELOG.md',
    'RELEASE_NOTES.md',
    'tests/test_ui_smoke.py',
    'tools/make_example_inductor.py',
    'bin/vl3d',
    'vl3d.config.example.json',
    'docs/INSTALL.md',
    'docs/TROUBLESHOOTING.md',
    'requirements-native.txt',
    'native/*.py',
    'profiles/*.json',
    'public/index.html',
    'public/errors.html',
    'public/styles.css',
    'public/src/fallback.js',
    'public/src/model.js',
  'public/src/geometry.js',
  'public/src/trace-client.js',
    'public/src/viewer-next.js',
    'public/vendor/THREE-LICENSE.txt',
    'public/vendor/THREE-VERSION.txt',
    'public/vendor/three.core.min.js',
    'public/vendor/three.module.min.js',
    'tools/STREAM_IMPORT.md',
    'tools/build_release.mjs',
    'tools/build_stress_layout.py',
    'tools/convert_layout_tsv.py',
    'tools/error_catalog.mjs',
    'tools/export_layouts.sh',
    'tools/import_stream_layout.py',
    'tools/layout_catalog.mjs',
    'tools/library_sessions.mjs',
    'tools/oa_dump.il',
    'tools/pdk_profile.py',
    'tools/technology_layers.py',
    'tools/runtime_paths.mjs',
    'tools/server.mjs',
    'tools/trace_service.mjs',
    'tools/trace_rules.py',
    'tools/klayout_macro.py',
    'tools/test_doctor.mjs',
    'tools/test_library_sessions.mjs',
    'tools/test_pdk_compat.py',
    'tools/test_runtime_paths.mjs',
    'tools/test_server_runtime.mjs',
    'tools/test_stream_import.py',
    'tools/verify_viewer.mjs',
    'tools/vl3d.mjs',
    'tests/backend/*.mjs',
    'tests/backend/*.py',
    'tests/native/*.py',
  ]);
  if (!Array.isArray(packageMetadata.files) || !packageMetadata.files.length) throw new Error('package.json must define a non-empty files allowlist');
  if (packageMetadata.license !== 'MIT') throw new Error('package.json must declare the project MIT license');
  for (const entry of REQUIRED_NPM_ENTRIES) {
    if (!packageMetadata.files.includes(entry)) throw new Error(`package.json files is missing required runtime entry: ${entry}`);
  }
  for (const entry of packageMetadata.files) {
    if (!permitted.has(entry)) throw new Error(`Unsafe or unknown package.json files entry: ${entry}`);
  }
}

// Resolve even not-yet-created destinations before any mkdir/rename. An output
// ancestor would otherwise move and delete the source tree along with staging.
function canonicalDestination(path) {
  let ancestor = resolve(path);
  const suffix = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
  return join(realpathSync(ancestor), ...suffix);
}

function verifyDestinations(options) {
  const output = canonicalDestination(options.outputDirectory);
  const archive = canonicalDestination(options.archive);
  if (pathWithin(output, canonicalRepository)) throw new Error('Output directory cannot contain or replace the repository');
  for (const candidate of [output, archive, `${archive}.sha256`]) {
    if (pathWithin(canonicalRepository, candidate)
        && !pathWithin(join(canonicalRepository, 'release'), candidate)
        && !pathWithin(join(canonicalRepository, 'dist'), candidate)) {
      throw new Error('Release destination cannot overwrite source files');
    }
  }
  if (pathWithin(output, archive)) throw new Error('Archive must be outside the staged source directory');
  if (existsSync(output)) {
    if (!lstatSync(output).isDirectory()) throw new Error('Output must be a directory');
    if (readdirSync(output).length && !existsSync(join(output, 'MANIFEST.sha256'))) {
      throw new Error('Refusing to replace a non-release directory');
    }
  }
}

function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!options.check) verifyDestinations(options);
  verifyNpmAllowlist();
  const files = collectFiles();
  for (const [path, expected] of Object.entries(PINNED_VENDOR_HASHES)) {
    const actual = files.find((file) => file.path === path)?.sha256;
    if (actual !== expected) throw new Error(`Pinned vendor hash mismatch for ${path}: ${actual || '<missing>'}`);
  }
  const totalBytes = files.reduce((sum, file) => sum + file.contents.length, 0);
  if (totalBytes > MAX_RELEASE_BYTES) throw new Error(`Release exceeds ${MAX_RELEASE_BYTES} bytes`);
  const archive = archiveContents(files);
  const archiveSha256 = createHash('sha256').update(archive).digest('hex');
  if (!options.check) {
    if (resolve(options.outputDirectory) === repository) throw new Error('Output directory cannot replace the repository');
    if (resolve(options.archive) === repository || resolve(options.archive) === resolve(options.outputDirectory)) throw new Error('Invalid archive path');
    stageDirectory(files, options.outputDirectory);
    writeFileAtomically(options.archive, archive);
    writeFileAtomically(`${options.archive}.sha256`, `${archiveSha256}  ${basename(options.archive)}\n`);
  }
  const summary = {
    ok: true,
    checkOnly: options.check,
    release: releaseName,
    fileCount: files.length,
    sourceBytes: totalBytes,
    archiveBytes: archive.length,
    archiveSha256,
    outputDirectory: options.check ? null : options.outputDirectory,
    archive: options.check ? null : options.archive,
  };
  process.stdout.write(`${options.json ? JSON.stringify(summary) : `Release audit passed: ${summary.fileCount} files, ${summary.sourceBytes} source bytes, ${summary.archiveBytes} archive bytes${options.check ? '' : `\nDirectory: ${summary.outputDirectory}\nArchive: ${summary.archive}`}`}\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`Release build failed: ${error.message}\n`);
  process.exitCode = 1;
}
