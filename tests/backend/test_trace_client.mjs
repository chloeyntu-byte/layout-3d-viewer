import assert from 'node:assert/strict';
import { requestPhysicalTrace, traceResultSummary, traceDiagnostics } from '../../public/src/trace-client.js';

const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const layout = { cell: 'TOP', shapes: [] };
const calls = [];
const result = await requestPhysicalTrace({ layout, pins: [{ terminal: 'A' }], scopePaths: null }, {
  baseUrl: 'http://127.0.0.1:9000/api/', intervalMs: 0,
  fetchImpl: async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return calls.length === 1 ? response({ operationId: 'op-a', state: 'running' }, 202)
      : response({ state: 'succeeded', result: { status: 'complete', complete: true, shapeIndices: [0, 7] } });
  },
});
assert.deepEqual(result.shapeIndices, [0, 7]);
assert.deepEqual(JSON.parse(calls[0].options.body).layout, layout);
assert.equal(calls[0].options.headers.prefer, 'respond-async');
assert.equal(calls[1].url, 'http://127.0.0.1:9000/api/operations/op-a');

const controller = new AbortController();
let resolveSubmit;
const canceledCalls = [];
const pending = requestPhysicalTrace({ layout, pins: [{}] }, {
  baseUrl: 'http://127.0.0.1:9000/api/', signal: controller.signal,
  fetchImpl: (url, options) => {
    canceledCalls.push(options.method);
    if (options.method === 'POST') return new Promise((resolve) => { resolveSubmit = resolve; });
    return Promise.resolve(response({ state: 'cancelled' }));
  },
});
controller.abort();
resolveSubmit(response({ operationId: 'op-cancel', state: 'running' }, 202));
await assert.rejects(pending, { name: 'AbortError' });
assert.deepEqual(canceledCalls, ['POST', 'DELETE'], 'Cancel while submitting must stop the newly-created backend operation');

await assert.rejects(requestPhysicalTrace({ layout, pins: [{}] }, {
  baseUrl: 'http://127.0.0.1:9000/api/', fetchImpl: async () => response({ message: 'too large' }, 413),
}), /desktop viewer/);
assert.match(traceResultSummary({ status: 'complete', complete: false, shapeIndices: [3] }), /^Incomplete trace/);
assert.match(traceResultSummary({ status: 'no_seed', complete: false }), /No conductor/);
assert.equal(traceDiagnostics({ warnings: ['One', { message: 'Two' }] }), 'One\nTwo');
assert.match(traceDiagnostics({ reason: 'scope_boundary' }), /Trace scope[\s\S]*Whole layout/);
assert.match(traceDiagnostics({ warnings: [{ code: 'trace-connector-unconfirmed', layer: 'V1', message: 'Endpoints unconfirmed' }, { code: 'trace-device-metadata-missing', message: 'Device metadata missing' }] }), /Layer and connector rules[\s\S]*V1[\s\S]*Device boundaries/);
assert.match(traceDiagnostics({ reason: 'maxMemoryMiB' }), /Indexing still reads the full input/);
console.log('Physical trace client, cancellation and diagnostic tests passed');
