import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(tmpdir(), 'vl3d-release-regression-'));
const run = (...args) => spawnSync(process.execPath, [join(root, 'tools/build_release.mjs'), ...args], {encoding: 'utf8'});
const reject = (args, pattern) => {
  const result = run(...args);
  assert.notEqual(result.status, 0, 'Unsafe release destination accepted');
  assert.match(result.stderr, pattern);
};
try {
  reject(['--output-dir', root], /cannot contain or replace/);
  reject(['--output-dir', dirname(root)], /cannot contain or replace/);
  reject(['--output-dir', join(root, 'native')], /cannot overwrite source/);
  symlinkSync(root, join(temp, 'source-alias'), 'dir');
  reject(['--output-dir', join(temp, 'source-alias')], /cannot contain or replace/);
  mkdirSync(join(temp, 'unrelated'));
  writeFileSync(join(temp, 'unrelated', 'keep.txt'), 'preserve me');
  reject(['--output-dir', join(temp, 'unrelated')], /non-release directory/);
  assert.equal(readFileSync(join(temp, 'unrelated', 'keep.txt'), 'utf8'), 'preserve me');
  const output = join(temp, 'source');
  const result = run('--output-dir', output, '--json');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(JSON.parse(readFileSync(join(output, 'package.json'))).license, 'MIT');
  for (const file of ['LICENSE', 'NOTICE', 'CONTRIBUTING.md', 'docs/USAGE.md', 'examples/hierarchy-demo.json']) {
    assert.ok(existsSync(join(output, file)), `Missing distributable ${file}`);
    assert.ok(readFileSync(join(output, 'MANIFEST.sha256'), 'utf8').includes(`  ${file}\n`));
  }
  assert.equal(existsSync(join(output, 'node_modules')), false);
  // Every browser module that the released code imports must ship with it (missing ones fail at startup).
  const srcDir = join(output, 'public', 'src');
  const npmFiles = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).files || [];
  for (const name of readdirSync(srcDir).filter((file) => file.endsWith('.js'))) {
    for (const match of readFileSync(join(srcDir, name), 'utf8').matchAll(/from\s+'\.\/([\w.-]+\.js)'/g)) {
      assert(existsSync(join(srcDir, match[1])), `Release is missing public/src/${match[1]} imported by ${name}`);
      assert(npmFiles.includes(`public/src/${match[1]}`), `package.json files is missing public/src/${match[1]}`);
    }
  }
  const rebuilt = run('--output-dir', output, '--json');
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  assert.equal(JSON.parse(rebuilt.stdout).archiveSha256, report.archiveSha256, 'Release must be reproducible');
  console.log('Release regressions passed: unsafe destinations, licenses, standalone example, reproducible archive');
} finally {
  rmSync(temp, {recursive: true, force: true});
}
