const entries = [
  ['E1001', 'error', 'Node.js is missing or unsupported', 'The launcher could not find a usable Node.js runtime at the supported baseline.', 'Install Node.js 18 or newer, or set `VL3D_NODE` to its executable path, then run `vl3d doctor` again.'],
  ['E1002', 'warning', 'Python 3 was not found', 'OA export, conversion, and stream import require Python 3; the static JSON viewer does not.', 'Install Python 3.6 or newer for OA/stream workflows, or set `VL3D_PYTHON`/`--python` to an executable path.'],
  ['E1003', 'warning', 'No supported browser was found', 'Neither Chromium nor Firefox was found in the configured path or PATH.', 'Install Chromium or Firefox, or select one with `--browser`.'],
  ['E1004', 'warning', 'No graphical file picker was found', 'Neither the built-in Tk picker nor a compatible Zenity/KDialog/YAD fallback is ready.', 'Repair the native Tk runtime, install one small picker package, or enter library paths manually in Advanced settings.'],
  ['E1005', 'warning', 'xprop was not found', 'The legacy external picker cannot attach itself to the active desktop window without xprop; the built-in Tk picker does not need it.', 'Use the built-in native picker, install the X11 utilities package containing xprop, or enter the path manually.'],
  ['E1006', 'warning', 'KLayout compatibility fallback was not found', 'The optional KLayout stream-import fallback is unavailable; the primary gdstk importer may still be ready.', 'Install the native runtime for gdstk, or install KLayout and set `KLAYOUT_BIN`/`--klayout`.'],
  ['E1007', 'warning', 'KLayout compatibility fallback is not usable', 'The optional KLayout executable failed its version probe or its runtime/plugins are incomplete.', 'Use the primary gdstk importer, or run `<klayout> -v` and repair the KLayout installation.'],
  ['E1008', 'warning', 'Virtuoso was not found', 'OA export requires a Virtuoso executable after the Cadence environment is loaded.', 'Select a Cadence environment adapter or set `VL3D_VIRTUOSO`/`--virtuoso`.'],
  ['E1009', 'warning', 'Cadence license setting was not found', 'Neither CDS_LIC_FILE nor LM_LICENSE_FILE is configured.', 'Load the site Cadence environment or provide `--license`; confirm the license server with your CAD administrator.'],
  ['E1010', 'warning', 'Configured license file is unreadable', 'The selected license value is a local file path that cannot be read.', 'Correct its path or permissions, or use the valid port@host license-server form.'],
  ['E1011', 'warning', 'Display session was not detected', 'On Linux, DISPLAY is absent, so Tk has no X11/XWayland display target.', 'Run in a desktop session, forward X11 correctly, enable XWayland when needed, or use non-GUI commands.'],
  ['E1012', 'error', 'System Tk is unavailable', 'The selected Python runtime cannot import Tkinter or cannot initialize Tk against the active display.', 'Install the OS Tk package matching Python, verify DISPLAY, and rerun `vl3d doctor`.'],
  ['E1013', 'error', 'Native Python package setup failed', 'A required native-client Python package could not be detected or installed in the portable user environment.', 'Check the reported package, Python version, network or wheel compatibility, then rerun `vl3d setup`.'],
  ['E2001', 'error', 'Configuration JSON is invalid', 'A selected project or user configuration file cannot be parsed as JSON.', 'Validate the file with `python3 -m json.tool`, fix the reported syntax, and retry.'],
  ['E2002', 'error', 'Configuration root must be an object', 'The parsed configuration contains an array or scalar at its root.', 'Use a JSON object matching `vl3d.config.example.json`.'],
  ['E2003', 'warning', 'cds.lib was not found', 'No explicit, configured, environment, or nearby cds.lib/lib.defs candidate exists.', 'Use Load Library or pass `--cds-lib`; keep automatic discovery enabled for later runs.'],
  ['E2004', 'error', 'cds.lib is unreadable', 'The selected cds.lib/lib.defs path is not a readable regular file.', 'Correct the manual path and file permissions; do not replace it with a directory.'],
  ['E2005', 'warning', 'No OA library was discovered', 'The resolved cds.lib contains no readable DEFINE target with OA layouts.', 'Check INCLUDE variables, load the Cadence/PDK environment, or select the OA library directory manually.'],
  ['E2006', 'warning', 'Library selection was cancelled', 'The graphical picker closed without selecting a path.', 'Run Load Library again or type the library path manually.'],
  ['E2007', 'error', 'Selected library path is invalid', 'The manual library selection is missing, unreadable, or not a directory/cds.lib file.', 'Choose the OA library directory or its cds.lib/lib.defs file.'],
  ['E2008', 'warning', 'Library discovery is ambiguous', 'Multiple equally ranked library or configuration candidates were found.', 'Select the intended candidate manually; VL3D will not silently choose between equal candidates.'],
  ['E2009', 'warning', 'Cadence environment adapter was not found', 'No explicit, configured, or nearby environment adapter is available.', 'Select a site-provided adapter script in Advanced settings or set `VL3D_CADENCE_ENV`.'],
  ['E2010', 'warning', 'cds.lib contains unresolved variables', 'One or more INCLUDE/DEFINE paths depend on variables not present in the current process.', 'Select the Cadence environment adapter first, or replace the variable with a portable site configuration.'],
  ['E2011', 'error', 'Server port is invalid', 'The configured port is outside 1 through 65535 or is not an integer.', 'Choose a valid unprivileged port, for example 5177.'],
  ['E2012', 'error', 'Server port is already in use', 'Another process is listening on the requested host and port.', 'Stop the conflicting process or start VL3D with another `--port`.'],
  ['E2013', 'error', 'XDG directory is not writable', 'The configuration, cache, or state directory cannot be created or written safely.', 'Correct ownership/permissions or set the matching XDG environment variable to a writable location.'],
  ['E2014', 'error', 'Configuration write failed', 'The atomic setup write could not create, sync, or rename the user configuration.', 'Check free space and directory permissions, then rerun `vl3d setup --write`.'],
  ['E2015', 'error', 'Manual override is invalid', 'An explicit command-line or environment path was supplied but is unusable.', 'Correct or remove that explicit override; automatic detection never replaces it silently.'],
  ['E2016', 'error', 'Configuration schema is unsupported', 'The configuration schemaVersion is newer than this VL3D build understands.', 'Upgrade VL3D or migrate the configuration using the matching release notes.'],
  ['E2017', 'warning', 'Library is absent from cds.lib', 'The selected OA directory has no matching DEFINE entry.', 'Continue with the temporary library overlay, or add a site-approved DEFINE entry outside VL3D.'],
  ['E2018', 'warning', 'No OA layout view was found', 'The selected cell has no supported layout/maskLayout/chip/cLayout/dLayout/ivpcell view.', 'Enter a custom OA view in Advanced settings or confirm the layout was migrated.'],
  ['E2019', 'warning', 'Graphical picker cannot be started', 'A picker exists but the desktop launch failed.', 'Check DISPLAY/WAYLAND_DISPLAY and DBUS_SESSION_BUS_ADDRESS, then use manual entry if needed.'],
  ['E2020', 'error', 'Project root is invalid', 'The selected project root is missing, unreadable, or lacks tools/server.mjs.', 'Run VL3D from the installed project or pass its directory with `--root`.'],
  ['E2021', 'error', 'Project files are not readable', 'The server or public frontend cannot be read by the current account.', 'Correct project ownership/permissions or reinstall into a readable directory.'],
  ['E2022', 'error', 'Local API request was rejected', 'The request came from a non-loopback client, an untrusted origin, or an unsupported HTTP shape.', 'Open VL3D through its local server URL and do not proxy OA controls to untrusted clients.'],
  ['E2023', 'warning', 'Library session expired', 'The in-memory library token expired, was evicted, or belongs to an earlier server process.', 'Use Load Library again; saved paths remain available but session tokens are intentionally not persisted.'],
  ['E3001', 'warning', 'OA loading is disabled', 'The server was started without OA export enabled.', 'Restart with `vl3d start --enable-oa` after configuring Cadence safely.'],
  ['E3002', 'error', 'Cadence environment is unavailable', 'OA loading was requested without a readable Cadence environment adapter.', 'Select the adapter in Advanced settings or set `VL3D_CADENCE_ENV`.'],
  ['E3003', 'error', 'Virtuoso export process failed to launch', 'The sanitized OA export process could not execute Virtuoso.', 'Check the adapter, executable path, execute permissions, and supported OS libraries.'],
  ['E3004', 'error', 'OA database could not be opened', 'Virtuoso/OpenAccess rejected the selected library, cell, or view.', 'Open the same view in Virtuoso, inspect its log, and verify library/technology attachment.'],
  ['E3005', 'error', 'PCell evaluation failed', 'A PCell dependency, callback, or technology context failed during OA traversal.', 'Load the correct PDK initialization and verify the PCell in Virtuoso before retrying.'],
  ['E3006', 'error', 'OA master.tag is invalid', 'master.tag is malformed, unsafe, or points outside the selected view.', 'Repair the OA view through Virtuoso; do not hand-edit binary OA data.'],
  ['E3007', 'error', 'OA export timed out', 'Virtuoso traversal exceeded the configured export timeout.', 'Check for license dialogs or broken PCells, then reduce hierarchy/shape scope or raise the advanced timeout.'],
  ['E3008', 'error', 'Cadence license checkout failed', 'Virtuoso reported that a required license feature could not be checked out.', 'Verify license variables, server reachability, feature availability, and vendor daemon status.'],
  ['E3009', 'error', 'OA source changed during export', 'The selected OA view or configuration changed after discovery.', 'Close active edits, reload the library session, and export again.'],
  ['E3010', 'error', 'OA identity is invalid', 'Library, cell, or view names contain unsupported characters.', 'Select an OA-valid identity and avoid passing filesystem paths as cell names.'],
  ['E4001', 'error', 'Layout TSV schema is unsupported', 'The exporter and converter disagree on the intermediate schema version.', 'Use matching VL3D tools and regenerate the TSV instead of editing it manually.'],
  ['E4002', 'error', 'Layout TSV is malformed', 'A required record, field, number, or hierarchy reference cannot be parsed.', 'Inspect the export log, regenerate the source, and report the first rejected record.'],
  ['E4003', 'error', 'Layout units are invalid', 'The source database unit is invalid, or viewer JSON uses unsupported coordinate units.', 'Export normalized micrometer (um) geometry. Convert all coordinates and dimensions consistently; never just relabel the units field.'],
  ['E4004', 'error', 'Conversion resource limit was exceeded', 'Input size, shape count, hierarchy depth, or conversion time exceeded a safety limit.', 'Use advanced limits cautiously, flatten/select a smaller top cell, or run on a machine with more memory.'],
  ['E4005', 'error', 'Converted JSON could not be published', 'The converter could not atomically write the JSON or manifest entry.', 'Check cache permissions, free space, and stale lock files.'],
  ['E4006', 'warning', 'Unsupported geometry was skipped', 'The OA/stream source contains a shape type not represented by this viewer build.', 'Review the warning count and source layer; upgrade or add a minimal geometry handler if visually significant.'],
  ['E5001', 'warning', 'Technology library was not identified', 'No authoritative technology name was exported and no reliable fallback matched.', 'Select/create a PDK profile and confirm the technology attached to the OA library.'],
  ['E5002', 'warning', 'PDK layer is unclassified', 'A layer-purpose pair has no routing, via, device, pin, or auxiliary semantic.', 'Map it in a PDK profile; it remains preserved but hidden to avoid misleading geometry.'],
  ['E5003', 'warning', 'Physical layer stack is incomplete', 'One or more conductive layers lack trustworthy Z position or thickness.', 'Import the PDK stack/profile and confirm units; fallback spacing is visualization-only.'],
  ['E5004', 'warning', 'Via endpoints are unknown', 'A via could not be connected to unambiguous lower and upper routing layers.', 'Add via endpoint aliases to the PDK profile and verify its cut-layer purpose.'],
  ['E5005', 'error', 'PDK profile is invalid', 'The selected profile has an unsupported schema, duplicate mapping, or invalid numeric stack value.', 'Validate against the profile schema and correct the first reported field.'],
  ['E5006', 'warning', 'Layer map conflicts with PDK metadata', 'Stream mapping and profile semantics disagree for the same layer-purpose pair.', 'Prefer the foundry-approved map and explicitly override only the conflicting entry.'],
  ['E5007', 'warning', 'PDK profile was inferred', 'No authoritative technology identity was available, so a design-library or layer-signature matcher selected the profile.', 'Confirm the inferred profile and set an explicit profile override when physical Z accuracy matters.'],
  ['E5008', 'error', 'PDK profile source is unavailable', 'A configured profile file or directory is missing, unreadable, unsafe, oversized, or contains too many files.', 'Correct the profile path and permissions, or remove the invalid manual override.'],
  ['E5009', 'warning', 'PDK profile selection is ambiguous', 'More than one profile exactly matches the exported technology identity.', 'Remove duplicate aliases or explicitly select the intended profile; the highest-precedence match is temporary.'],
  ['E5010', 'warning', 'Source technology layers conflict', 'Multiple source technologies or contradictory OA materials share a layer identity.', 'Check source technology attachment. Conflicting material layers stay hidden; do not infer cross-technology connectivity.'],
  ['E6001', 'error', 'Stream file cannot be read', 'The selected GDSII/OASIS path is missing, unreadable, or not a regular file.', 'Select a readable `.gds`, `.gdsii`, or `.oas` file.'],
  ['E6002', 'error', 'Stream top cell selection is required', 'The requested top cell is absent, or the stream contains multiple top cells and none was selected.', 'Choose one of the returned topCells candidates and retry with that exact name.'],
  ['E6003', 'error', 'Stream layer map is invalid', 'The JSON layer map is malformed or contains invalid routing/defaultVisible types.', 'Start from the example map and correct the reported layer entry.'],
  ['E6004', 'error', 'Stream parser failed', 'gdstk and/or the configured KLayout fallback could not read or traverse the stream database.', 'Check file integrity and the parser details; prefer a compatible gdstk wheel, or verify a complete KLayout installation.'],
  ['E6005', 'error', 'Stream import timed out', 'Stream parsing or hierarchy expansion exceeded the configured timeout.', 'Check file integrity, choose the correct top cell, reduce limits, or raise the advanced timeout on a capable machine.'],
  ['E6006', 'warning', 'Stream has unmapped layers', 'One or more layer/datatype pairs have no PDK mapping.', 'Select a layer map or PDK profile in Load setup. Unknown layers are retained but hidden until explicitly mapped.'],
  ['E6007', 'error', 'No usable stream parser is available', 'Neither a compatible gdstk installation nor a complete KLayout database reader is available.', 'Install the pinned gdstk wheel, or explicitly select a complete portable KLayout installation.'],
  ['E6008', 'error', 'Stream source changed during import', 'The selected JSON/GDSII/OASIS file changed after validation and before cache publication.', 'Stop the writer, select the stable file again, and retry; no generated result from this attempt was published.'],
  ['E6009', 'error', 'Pin annotations are invalid', 'The annotation identity, units, paths, layers or pin geometry do not match the layout.', 'Use annotate_pins.py --inspect for the exact source binding; correct the reported pin field and retry. The original input is unchanged.'],
  ['E7001', 'error', 'Cache directory is unavailable', 'The runtime cache directory is missing, unsafe, or not writable.', 'Set XDG_CACHE_HOME/VL3D_CACHE_DIR to a writable local filesystem.'],
  ['E7002', 'error', 'Cache manifest is corrupt', 'manifest.json is invalid, oversized, or inconsistent with its entries.', 'Move the corrupt runtime cache aside and regenerate affected cells from source.'],
  ['E7003', 'warning', 'Cached layout is stale', 'OA source or converter fingerprints no longer match the cached entry.', 'Open the cell again to refresh it; do not reuse stale JSON for signoff.'],
  ['E7004', 'error', 'Cache lock could not be acquired', 'Another export holds the lock or a stale lock exceeded its timeout.', 'Wait for the active export; if none exists, inspect ownership before removing only the stale lock.'],
  ['E7005', 'error', 'Cache storage is full', 'The cache publish failed because the filesystem has insufficient free space or quota.', 'Use vl3d doctor to locate the data directory, move that entire directory aside, then reopen cells; or point VL3D_DATA_DIR at a filesystem with more free space. Do not delete individual cache files.'],
  ['E7006', 'error', 'Cache ownership is unsafe', 'Runtime files are owned by another account or are writable by untrusted users.', 'Correct ownership and use private XDG directories with 0700/0600 permissions.'],
  ['E8001', 'error', 'WebGL is unavailable', 'The browser cannot create the required WebGL rendering context.', 'Enable hardware acceleration/update graphics drivers, or use the Canvas fallback for smaller layouts.'],
  ['E8002', 'error', 'Shader or GPU initialization failed', 'The GPU driver rejected a shader, buffer, or texture allocation.', 'Update the browser/driver, reduce visual quality, and capture the browser console error.'],
  ['E8003', 'error', 'Frontend ran out of memory', 'The browser process exceeded available memory while loading/building geometry.', 'Use LOD/shape limits, close other tabs, or select a smaller hierarchy.'],
  ['E8004', 'warning', 'Interaction latency is excessive', 'Frame time or fast-mode transition exceeds the interactive target.', 'Keep fast mode enabled, reduce edge/detail quality, and inspect the performance panel for the reported phase.'],
  ['E8005', 'warning', 'Pointer controls behave unexpectedly', 'Browser, touchpad, or configured orbit direction conflicts with expected gestures.', 'Reset controls, select the preferred orbit/pan direction, and verify with the interaction self-test.'],
  ['E8006', 'error', 'Layout data fetch failed', 'The browser could not fetch or decode the selected manifest/JSON resource.', 'Check the server response, cache entry, gzip sidecar, and browser network console.'],
  ['E8007', 'warning', 'Canvas fallback limit was reached', 'The non-WebGL renderer omitted detail to remain responsive.', 'Use WebGL or lower the visible hierarchy/layer count.'],
  ['E8008', 'error', 'Native Tk/OpenGL is unavailable', 'The native client cannot initialize Tk, the OpenGL widget, or the required GL capabilities.', 'Install the documented Tk/PyOpenGL packages, verify DISPLAY and glxinfo, then rerun `vl3d doctor`.'],
  ['E8009', 'error', 'Native backend connection failed', 'The private local backend failed to start, authenticate, or remain attached to its owning GUI process.', 'Restart VL3D, verify the local control pipe and loopback access, and inspect the backend startup diagnostic.'],
  ['E9001', 'error', 'Unhandled internal error', 'VL3D reached an unexpected code path.', 'Record the error code, command, version, and minimal reproducer, then open an issue.'],
  ['E9002', 'error', 'Internal data invariant failed', 'Data passed an earlier stage but violates a required internal contract.', 'Clear only the affected generated cache, reproduce, and report the input schema/technology metadata.'],
  ['E9003', 'error', 'Frontend/backend protocol mismatch', 'The UI and server API/schema versions are incompatible.', 'Restart from one VL3D installation and clear stale browser assets.'],
  ['E9004', 'error', 'Child process failed unexpectedly', 'A managed converter, exporter, or server process exited without a classified error.', 'Inspect its captured stdout/stderr and rerun `vl3d doctor --json`.'],
];

const seen = new Set();
for (const [code] of entries) {
  if (!/^E[1-9]\d{3}$/.test(code) || seen.has(code)) throw new Error(`Invalid error catalog code: ${code}`);
  seen.add(code);
}

export const ERROR_CATALOG = Object.freeze(entries.map(([shortCode, severity, title, cause, remedy]) => Object.freeze({
  code: `VL3D-${shortCode}`,
  shortCode,
  severity,
  category: Number(shortCode[1]),
  title,
  cause,
  remedy,
})));

export const ERROR_BY_CODE = new Map(ERROR_CATALOG.flatMap((entry) => [
  [entry.code, entry],
  [entry.shortCode, entry],
]));

export function errorInfo(code) {
  return ERROR_BY_CODE.get(String(code || '').toUpperCase()) || ERROR_BY_CODE.get('E9001');
}

export function getErrorDefinition(code) {
  return errorInfo(code);
}

export function normalizeError(value, fallbackCode = 'E9001') {
  const nested = value && typeof value === 'object' && value.error && typeof value.error === 'object'
    ? value.error
    : value;
  const requestedCode = String(nested?.code || value?.code || '').toUpperCase();
  const definition = ERROR_BY_CODE.get(requestedCode) || errorInfo(fallbackCode);
  const message = typeof nested === 'string'
    ? nested
    : nested?.message || value?.message || definition.title;
  const details = nested?.details ?? value?.details ?? null;
  return {
    code: definition.code,
    message: String(message),
    title: definition.title,
    cause: definition.cause,
    remedy: definition.remedy,
    ...(details !== null ? { details } : {}),
  };
}

export function errorPayload(value, fallbackCode = 'E9001') {
  return { error: normalizeError(value, fallbackCode) };
}

export function diagnosticIssue(code, details = null, severity = null) {
  const entry = errorInfo(code);
  return {
    code: entry.code,
    severity: severity || entry.severity,
    title: entry.title,
    cause: entry.cause,
    remedy: entry.remedy,
    ...(details ? { details } : {}),
  };
}

export function errorsByCategory() {
  const grouped = new Map();
  for (const entry of ERROR_CATALOG) {
    if (!grouped.has(entry.category)) grouped.set(entry.category, []);
    grouped.get(entry.category).push(entry);
  }
  return grouped;
}
