const traceReasons = {
  no_pin_selected: 'Select a pin first.',
  legacy_pathseg_bbox: 'This older OA export contains ambiguous path segments. Refresh the OA layout or re-export it before physical tracing.',
  pin_does_not_touch_indexed_conductor: 'The pin does not contact a supported conductor in this scope.',
  unmatched_pin_figures: 'Some pin figures could not be connected to a supported conductor.',
  disconnected_pin_components: 'Selected pin figures belong to separate physical components; they were not joined.',
  scope_boundary: 'Connected geometry continues outside this module. Use Whole layout to continue.',
  point_only_contacts: 'Point-only contacts were excluded; inspect them before treating the trace as complete.',
  incomplete_rules: 'Some connector or device rules are unavailable. See the trace diagnostics.',
  incomplete_export: 'The imported layout is partial; re-export the complete hierarchy.',
  unsupported_geometry: 'Some shapes could not be evaluated without changing their geometry.',
  cancelled_by_user: 'The trace was canceled.',
  maxSeconds: 'The time limit was reached. Use a smaller layout or reduce the trace scope.',
  maxMemoryMiB: 'The index memory limit was reached. Load a smaller layout or export fewer hierarchy levels.',
  maxShapes: 'The input shape limit was reached. Load a smaller layout or export fewer hierarchy levels.',
  maxVertices: 'The input geometry limit was reached. Load a smaller layout or export fewer hierarchy levels.',
  maxIndexCells: 'The spatial index limit was reached. Load a smaller layout or export fewer hierarchy levels.',
  maxCandidates: 'The contact search limit was reached. Trace a smaller module.',
  maxGeometryChecks: 'The geometry check limit was reached. Trace a smaller module.',
  maxResults: 'The result size limit was reached. Trace a smaller module.',
};

// Both desktop and browser use the local Python physical-connectivity engine.
export function traceResultSummary(result = {}) {
  const labels = {
    complete: 'Complete within the requested scope', cancelled: 'Trace canceled', limited: 'Incomplete trace',
    no_seed: 'No conductor touches the selected pin', ambiguous_seed: 'Pin touches separate conductive components',
  };
  const status = result.complete && result.status === 'complete' ? 'complete' : result.status === 'complete' ? 'limited' : result.status;
  const count = result.shapeIndices?.length || 0;
  const components = result.seedComponentCount > 1 ? ` ${result.seedComponentCount} separate components.` : '';
  return `${labels[status] || 'Incomplete trace'}; ${count} shapes.${components}${result.reason ? ` ${traceReasons[result.reason] || result.reason}` : ''}`;
}

export function traceDiagnostics(result = {}) {
  const groups = new Map();
  const records = [...(result.warnings || [])];
  if (result.reason && !records.some((item) => (typeof item === 'string' ? item : item.code) === result.reason)) records.unshift(result.reason);
  for (const warning of records) {
    const code = typeof warning === 'string' ? warning : warning.code || '';
    const raw = typeof warning === 'string' ? warning : warning.message || code;
    let category = '';
    let action = '';
    if (/^trace-(connector|layer|stop-layer)|incomplete_rules/.test(code)) {
      category = 'Layer and connector rules'; action = 'Re-import the original GDS/OAS with a verified layer map or viewer PDK profile, or correct and refresh the OA export. Existing JSON keeps its embedded rules; selecting a map does not relabel it.';
    } else if (/device/.test(code)) {
      category = 'Device boundaries'; action = 'Refresh the OA export or supply verified device metadata; routing through a device is not inferred.';
    } else if (/incomplete_export|unsupported_geometry|legacy_pathseg/.test(code)) {
      category = 'Source geometry'; action = 'Refresh or re-export the complete layout. The trace uses the available geometry only.';
    } else if (/^max/.test(code)) {
      category = 'Resource limit'; action = 'Indexing still reads the full input layout. Load a smaller source for index limits; use a smaller module scope for contact or result limits.';
    } else if (/scope_boundary/.test(code)) {
      category = 'Trace scope'; action = 'Select Whole layout to follow the route beyond the selected modules.';
    } else if (/pin|seed|component|point_only/.test(code)) {
      category = 'Pin contact'; action = 'Use Locate pin and inspect its physical footprint and layer. Check the pin annotation if the source has no native pins.';
    }
    const message = traceReasons[code] || raw;
    const label = typeof warning === 'object' && warning.layer ? `${warning.layer}: ${message}` : message;
    if (!label) continue;
    if (!groups.has(category)) groups.set(category, { messages: [], action });
    if (!groups.get(category).messages.includes(label)) groups.get(category).messages.push(label);
  }
  return [...groups].map(([category, group]) => category
    ? `${category}\n${group.messages.join('\n')}\nNext: ${group.action}` : group.messages.join('\n')).join('\n\n');
}

function abortError() {
  const error = new Error('Physical trace canceled');
  error.name = 'AbortError';
  return error;
}

export async function requestPhysicalTrace(payload, options = {}) {
  const fetcher = options.fetchImpl || fetch;
  const base = options.baseUrl || new URL('../../api/', import.meta.url).href;
  const signal = options.signal;
  let operationId = '';
  let canceledRemotely = false;
  const cancelRemote = () => {
    if (operationId && !canceledRemotely) {
      canceledRemotely = true;
      Promise.resolve(fetcher(new URL(`operations/${encodeURIComponent(operationId)}`, base), { method: 'DELETE' })).catch(() => {});
    }
  };
  const aborted = () => { cancelRemote(); };
  const decode = async (response) => {
    const data = await response.json();
    if (response.status === 413) throw new Error('This layout is too large for browser tracing. Open the JSON file in the desktop viewer to trace it locally.');
    if (!response.ok) throw new Error(data.error?.message || data.message || 'Physical trace backend is unavailable');
    return data;
  };
  if (signal?.aborted) throw abortError();
  signal?.addEventListener('abort', aborted);
  try {
    // Wait for the operation ID even if the user cancels during submission, so
    // cancellation can terminate the backend child instead of abandoning it.
    const body = JSON.stringify(payload);
    if (body.length > 64 * 1024 * 1024) throw new Error('This layout is too large for browser tracing. Open the JSON file in the desktop viewer to trace it locally.');
    const response = await fetcher(new URL('traces', base), {
      method: 'POST', headers: { 'content-type': 'application/json', prefer: 'respond-async' },
      body,
    });
    const operation = await decode(response);
    operationId = operation.operationId;
    if (!operationId) throw new Error('Physical trace backend did not return an operation identifier');
    options.onOperation?.(operationId);
    const deadline = Date.now() + (options.timeoutMs ?? 600000);
    while (true) {
      if (signal?.aborted) { cancelRemote(); throw abortError(); }
      if (Date.now() >= deadline) { cancelRemote(); throw new Error('Physical trace timed out and was canceled'); }
      const state = await decode(await fetcher(new URL(`operations/${encodeURIComponent(operationId)}`, base), {
        cache: 'no-store', signal,
      }));
      if (state.progress) options.onProgress?.(state.progress);
      if (['succeeded', 'completed', 'complete'].includes(state.state)) return state.result;
      if (['canceled', 'cancelled'].includes(state.state)) throw abortError();
      if (state.state === 'failed') {
        const message = state.error?.message || 'Physical trace failed';
        throw new Error(/(?:VL3D-)?E1013/.test(message) ? 'The selected Python runtime lacks geometry-tracing support. Run the viewer setup or select its installed native Python runtime.' : message);
      }
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 250));
    }
  } finally {
    signal?.removeEventListener('abort', aborted);
    if (signal?.aborted) cancelRemote();
  }
}
