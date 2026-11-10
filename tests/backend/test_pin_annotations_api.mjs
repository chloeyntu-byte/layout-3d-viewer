import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = mkdtempSync(join(tmpdir(), 'vl3d-pin-api-'));
const directory = join(temporary, 'data'); mkdirSync(directory);
const source = join(temporary, 'source.json'), annotations = join(temporary, 'pins.json');
const original = readFileSync(join(root, 'examples/pin-annotation-layout.json'));
writeFileSync(source, original);
const sidecar = JSON.parse(readFileSync(join(root, 'examples/pin-annotations.json')));
writeFileSync(annotations, JSON.stringify(sidecar));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const child = spawn(process.execPath, [join(root, 'tools/server.mjs'), '--root', root, '--host', '127.0.0.1',
  '--port', '0', '--data-dir', directory, '--state-dir', join(temporary, 'state')],
{ cwd: temporary, env: { ...process.env, XDG_CONFIG_HOME: join(temporary, 'config') }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { output += data; });
try {
  let base;
  for (let n = 0; n < 500 && !base; n += 1) {
    const line = output.split('\n').find((value) => value.startsWith('VL3D_READY '));
    if (line) base = `http://127.0.0.1:${JSON.parse(line.slice(11)).port}`;
    else if (child.exitCode != null) throw Error(output);
    else await pause(20);
  }
  assert(base, output);
  const api = async (body) => {
    const response = await fetch(`${base}/api/streams/import`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const payload = async (entry) => JSON.parse(await (await fetch(new URL('/public/' + entry.path, base))).text());
  let response = await api({ path: source });
  assert.equal(response.status, 201, JSON.stringify(response));
  const unannotated = await payload(response.body.entry);
  response = await api({ path: source, pinAnnotationsPath: annotations });
  assert.equal(response.status, 201, JSON.stringify(response));
  const firstEntry = response.body.entry, annotated = await payload(firstEntry);
  assert.deepEqual(annotated.shapes, unannotated.shapes, 'Pin annotations must preserve every imported source shape exactly');
  assert.deepEqual(annotated.instances, unannotated.instances);
  assert.deepEqual(annotated.layers, unannotated.layers);
  assert.equal(annotated.pins.length, 3);
  assert.equal(annotated.pinCount, 3);
  assert.deepEqual(annotated.pins.map((pin) => pin.worldBBox), sidecar.pins.map((pin) => pin.worldBBox));
  assert.deepEqual(annotated.pins.map((pin) => pin.terminal), ['A', 'A', 'A']);
  assert.equal(new Set(annotated.pins.map((pin) => pin.hierPath)).size, 2);
  assert.equal(annotated.pinAnnotations.sha256, digest(readFileSync(annotations)));
  assert.equal(firstEntry.pinAnnotations.sha256, annotated.pinAnnotations.sha256);
  assert.equal(typeof annotated.pinAnnotations.mtimeMs, 'number');
  assert.equal(annotated.pins.every((pin) => pin.net === ''), true, 'Manual terminals must not imply named nets');
  const traceResponse = await fetch(`${base}/api/traces`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ layout: annotated, pins: annotated.pins.slice(0, 2) }) });
  assert.equal(traceResponse.status, 202, await traceResponse.clone().text());
  const accepted = await traceResponse.json();
  let trace;
  for (let n = 0; n < 1000; n += 1) {
    trace = await (await fetch(`${base}/api/operations/${accepted.operationId}`)).json();
    if (!['running', 'cancelling'].includes(trace.state)) break;
    await pause(20);
  }
  assert.equal(trace.state, 'succeeded', JSON.stringify(trace));
  assert.equal(trace.result.complete, true, JSON.stringify(trace));
  assert.deepEqual(trace.result.shapeIndices, [0, 1, 2, 3, 4, 5, 6, 7],
    'Both figures of the manually annotated port must seed the intended unnamed route without merging the same-name crossing pin');
  sidecar.pins[0].name = ' A renamed 原名 ';
  writeFileSync(annotations, JSON.stringify(sidecar));
  response = await api({ path: source, pinAnnotationsPath: annotations });
  assert.equal(response.status, 201, JSON.stringify(response));
  const second = await payload(response.body.entry);
  assert.equal(second.pins[0].name, ' A renamed 原名 ');
  assert.notEqual(second.pinAnnotations.sha256, annotated.pinAnnotations.sha256, 'Sidecar changes must produce a new cache fingerprint');
  const finalBytes = readFileSync(join(directory, response.body.entry.path.replace(/^data\//, '')));
  sidecar.pins[0].layer = 'NONEXISTENT'; writeFileSync(annotations, JSON.stringify(sidecar));
  response = await api({ path: source, pinAnnotationsPath: annotations });
  assert.equal(response.status, 422, JSON.stringify(response));
  assert.match(JSON.stringify(response.body), /E6009/);
  assert.match(JSON.stringify(response.body), /layer/i, 'User must receive the actual failing field');
  assert.deepEqual(readFileSync(join(directory, firstEntry.path.replace(/^data\//, ''))), finalBytes,
    'An invalid annotation must leave the previous valid cache untouched');
  assert.deepEqual(readFileSync(source), original, 'Source JSON must never be modified');

  // Real stream conversion, including occurrence transform, then the same sidecar
  // applied through the public Load API. No OA or private fixture is involved.
  const generated = spawnSync(process.env.VL3D_PYTHON || 'python3', ['-c', `
import json, os, sys, subprocess
sys.path.insert(0, sys.argv[1])
import gdstk
from tools.annotate_pins import source_description
folder=sys.argv[2]
library=gdstk.Library(unit=1e-6,precision=1e-9)
unit=library.new_cell('UNIT'); unit.add(gdstk.rectangle((0,0),(2,1),layer=201))
top=library.new_cell('TOP'); top.add(gdstk.Reference(unit,origin=(10.25,20.5),rotation=1.5707963267948966))
library.write_gds(os.path.join(folder,'source.gds'))
with open(os.path.join(folder,'map.json'),'w') as handle:
 json.dump({'201/0':{'name':'M1','kind':'metal','routing':True}},handle)
subprocess.check_call([sys.executable,os.path.join(sys.argv[1],'tools/import_stream_layout.py'),os.path.join(folder,'source.gds'),'--output',os.path.join(folder,'stream.json'),'--top','TOP','--library','SYNTHETIC_STREAM','--layer-map',os.path.join(folder,'map.json')],stdout=subprocess.DEVNULL)
with open(os.path.join(folder,'stream.json')) as handle: layout=json.load(handle)
sidecar,_=source_description(layout); shape=layout['shapes'][0]
sidecar['pins']=[{'terminal':'PAD','name':' PAD original ','hierPath':shape['hierPath'],'layer':shape['layer'],'points':shape['points']}]
with open(os.path.join(folder,'stream-pins.json'),'w') as handle: json.dump(sidecar,handle)
`, root, temporary], { encoding: 'utf8', env: { ...process.env, OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1' } });
  assert.equal(generated.status, 0, generated.stderr);
  const rawGds = readFileSync(join(temporary, 'source.gds'));
  response = await api({ path: join(temporary, 'source.gds'), top: 'TOP', library: 'SYNTHETIC_STREAM',
    layerMapPath: join(temporary, 'map.json'), pinAnnotationsPath: join(temporary, 'stream-pins.json') });
  assert.equal(response.status, 201, JSON.stringify(response));
  const streamAnnotated = await payload(response.body.entry);
  const streamOriginal = JSON.parse(readFileSync(join(temporary, 'stream.json')));
  assert.deepEqual(streamAnnotated.shapes, streamOriginal.shapes, 'GDS pin annotation must retain exact transformed source shapes');
  assert.deepEqual(streamAnnotated.pins[0].points, streamOriginal.shapes[0].points);
  assert.equal(streamAnnotated.pins[0].name, ' PAD original ');
  assert.deepEqual(readFileSync(join(temporary, 'source.gds')), rawGds);
  const demo = await fetch(`${base}/api/examples/physical-trace`);
  assert.equal(demo.status, 200); assert.equal((await demo.json()).cell, 'TRACE');
  const forbidden = await fetch(`${base}/api/examples/anything-else`); assert.equal(forbidden.status, 404);
  const guide = await fetch(`${base}/api/guides/pin-annotation`);
  assert.equal(guide.status, 200); assert.match(guide.headers.get('content-type'), /text\/plain/);
  assert.equal(await guide.text(), readFileSync(join(root, 'docs/PIN_ANNOTATION.md'), 'utf8'));
  assert.equal((await fetch(`${base}/api/guides/anything-else`)).status, 404);

  console.log('Pin annotation API passed: isolated cwd/config, same-name hierarchy and multi-figure pins, exact geometry, digest/mtime, safe failure, rotated GDS, physical trace, fixed public example');
} finally {
  child.kill('SIGTERM');
  for (let n = 0; n < 100 && child.exitCode == null; n += 1) await pause(20);
  if (child.exitCode == null) child.kill('SIGKILL');
  rmSync(temporary, { recursive: true, force: true });
}
