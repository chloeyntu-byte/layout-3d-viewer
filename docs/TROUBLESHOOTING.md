# VL3D Troubleshooting

Every diagnosable failure has a canonical `VL3D-E####` code. Short `E####` input remains accepted. Search this file for either form; the offline index supports `/public/errors.html#VL3D-E####` and `/public/errors.html#E####`.

## First response

1. Run `node tools/vl3d.mjs doctor --json > vl3d-doctor.json`.
2. Fix the first `error` before optional `warning` entries.
3. Keep manual choices in Advanced settings or CLI flags; automatic detection never replaces an explicit value.
4. Preview setup with `node tools/vl3d.mjs setup`; only `setup --write` changes the XDG user configuration.
5. Attach the code, doctor JSON, VL3D version, OS, PDK name, and the smallest reproducible cell when reporting a defect.

Configuration priority is: command line -> `VL3D_*` environment -> user XDG config -> project config -> bounded auto-detection. `Load Library` and manual cell/view entry remain available even when discovery is incomplete.

## VL3D-E1xxx - Dependencies

### VL3D-E1001 (E1001) - Node.js is missing or unsupported

- **Severity:** error
- **Cause:** The launcher could not find a usable Node.js runtime at the supported baseline.
- **Recommended action:** Install Node.js 18 or newer, or set `VL3D_NODE` to its executable path, then run `vl3d doctor` again.

### VL3D-E1002 (E1002) - Python 3 was not found

- **Severity:** warning
- **Cause:** OA export, conversion, and stream import require Python 3; the static JSON viewer does not.
- **Recommended action:** Install Python 3.6 or newer for OA/stream workflows, or set `VL3D_PYTHON`/`--python` to an executable path.

### VL3D-E1003 (E1003) - No supported browser was found

- **Severity:** warning
- **Cause:** Neither Chromium nor Firefox was found in the configured path or PATH.
- **Recommended action:** Install Chromium or Firefox, or select one with `--browser`.

### VL3D-E1004 (E1004) - No graphical file picker was found

- **Severity:** warning
- **Cause:** Neither the built-in Tk picker nor a compatible Zenity/KDialog/YAD fallback is ready.
- **Recommended action:** Repair the native Tk runtime, install one small picker package, or enter library paths manually in Advanced settings.

### VL3D-E1005 (E1005) - xprop was not found

- **Severity:** warning
- **Cause:** The legacy external picker cannot attach itself to the active desktop window without xprop; the built-in Tk picker does not need it.
- **Recommended action:** Use the built-in native picker, install the X11 utilities package containing xprop, or enter the path manually.

### VL3D-E1006 (E1006) - KLayout compatibility fallback was not found

- **Severity:** warning
- **Cause:** The optional KLayout stream-import fallback is unavailable; the primary gdstk importer may still be ready.
- **Recommended action:** Install the native runtime for gdstk, or install KLayout and set `KLAYOUT_BIN`/`--klayout`.

### VL3D-E1007 (E1007) - KLayout compatibility fallback is not usable

- **Severity:** warning
- **Cause:** The optional KLayout executable failed its version probe or its runtime/plugins are incomplete.
- **Recommended action:** Use the primary gdstk importer, or run `<klayout> -v` and repair the KLayout installation.

### VL3D-E1008 (E1008) - Virtuoso was not found

- **Severity:** warning
- **Cause:** OA export requires a Virtuoso executable after the Cadence environment is loaded.
- **Recommended action:** Select a Cadence environment adapter or set `VL3D_VIRTUOSO`/`--virtuoso`.

### VL3D-E1009 (E1009) - Cadence license setting was not found

- **Severity:** warning
- **Cause:** Neither CDS_LIC_FILE nor LM_LICENSE_FILE is configured.
- **Recommended action:** Load the site Cadence environment or provide `--license`; confirm the license server with your CAD administrator.

### VL3D-E1010 (E1010) - Configured license file is unreadable

- **Severity:** warning
- **Cause:** The selected license value is a local file path that cannot be read.
- **Recommended action:** Correct its path or permissions, or use the valid port@host license-server form.

### VL3D-E1011 (E1011) - Display session was not detected

- **Severity:** warning
- **Cause:** On Linux, DISPLAY is absent, so Tk has no X11/XWayland display target.
- **Recommended action:** Run in a desktop session, forward X11 correctly, enable XWayland when needed, or use non-GUI commands.

### VL3D-E1012 (E1012) - System Tk is unavailable

- **Severity:** error
- **Cause:** The selected Python cannot import Tkinter, or Tk cannot initialize against the active DISPLAY/X11/XWayland session.
- **Recommended action:** Install the Tk package matching Python, verify DISPLAY and X11/XWayland access, then rerun `vl3d doctor`.

### VL3D-E1013 (E1013) - Native Python package setup failed

- **Severity:** error
- **Cause:** A required native-client Python package could not be detected or installed in the portable user environment.
- **Recommended action:** Check the reported package, Python version, network or wheel compatibility, then rerun `vl3d setup`.

## VL3D-E2xxx - Configuration and libraries

### VL3D-E2001 (E2001) - Configuration JSON is invalid

- **Severity:** error
- **Cause:** A selected project or user configuration file cannot be parsed as JSON.
- **Recommended action:** Validate the file with `python3 -m json.tool`, fix the reported syntax, and retry.

### VL3D-E2002 (E2002) - Configuration root must be an object

- **Severity:** error
- **Cause:** The parsed configuration contains an array or scalar at its root.
- **Recommended action:** Use a JSON object matching `vl3d.config.example.json`.

### VL3D-E2003 (E2003) - cds.lib was not found

- **Severity:** warning
- **Cause:** No explicit, configured, environment, or nearby cds.lib/lib.defs candidate exists.
- **Recommended action:** Use Load Library or pass `--cds-lib`; keep automatic discovery enabled for later runs.

### VL3D-E2004 (E2004) - cds.lib is unreadable

- **Severity:** error
- **Cause:** The selected cds.lib/lib.defs path is not a readable regular file.
- **Recommended action:** Correct the manual path and file permissions; do not replace it with a directory.

### VL3D-E2005 (E2005) - No OA library was discovered

- **Severity:** warning
- **Cause:** The resolved cds.lib contains no readable DEFINE target with OA layouts.
- **Recommended action:** Check INCLUDE variables, load the Cadence/PDK environment, or select the OA library directory manually.

### VL3D-E2006 (E2006) - Library selection was cancelled

- **Severity:** warning
- **Cause:** The graphical picker closed without selecting a path.
- **Recommended action:** Run Load Library again or type the library path manually.

### VL3D-E2007 (E2007) - Selected library path is invalid

- **Severity:** error
- **Cause:** The manual library selection is missing, unreadable, or not a directory/cds.lib file.
- **Recommended action:** Choose the OA library directory or its cds.lib/lib.defs file.

### VL3D-E2008 (E2008) - Library discovery is ambiguous

- **Severity:** warning
- **Cause:** Multiple equally ranked library or configuration candidates were found.
- **Recommended action:** Select the intended candidate manually; VL3D will not silently choose between equal candidates.

### VL3D-E2009 (E2009) - Cadence environment adapter was not found

- **Severity:** warning
- **Cause:** No explicit, configured, or nearby environment adapter is available.
- **Recommended action:** Select a site-provided adapter script in Advanced settings or set `VL3D_CADENCE_ENV`.

### VL3D-E2010 (E2010) - cds.lib contains unresolved variables

- **Severity:** warning
- **Cause:** One or more INCLUDE/DEFINE paths depend on variables not present in the current process.
- **Recommended action:** Select the Cadence environment adapter first, or replace the variable with a portable site configuration.

### VL3D-E2011 (E2011) - Server port is invalid

- **Severity:** error
- **Cause:** The configured port is outside 1 through 65535 or is not an integer.
- **Recommended action:** Choose a valid unprivileged port, for example 5177.

### VL3D-E2012 (E2012) - Server port is already in use

- **Severity:** error
- **Cause:** Another process is listening on the requested host and port.
- **Recommended action:** Stop the conflicting process or start VL3D with another `--port`.

### VL3D-E2013 (E2013) - XDG directory is not writable

- **Severity:** error
- **Cause:** The configuration, cache, or state directory cannot be created or written safely.
- **Recommended action:** Correct ownership/permissions or set the matching XDG environment variable to a writable location.

### VL3D-E2014 (E2014) - Configuration write failed

- **Severity:** error
- **Cause:** The atomic setup write could not create, sync, or rename the user configuration.
- **Recommended action:** Check free space and directory permissions, then rerun `vl3d setup --write`.

### VL3D-E2015 (E2015) - Manual override is invalid

- **Severity:** error
- **Cause:** An explicit command-line or environment path was supplied but is unusable.
- **Recommended action:** Correct or remove that explicit override; automatic detection never replaces it silently.

### VL3D-E2016 (E2016) - Configuration schema is unsupported

- **Severity:** error
- **Cause:** The configuration schemaVersion is newer than this VL3D build understands.
- **Recommended action:** Upgrade VL3D or migrate the configuration using the matching release notes.

### VL3D-E2017 (E2017) - Library is absent from cds.lib

- **Severity:** warning
- **Cause:** The selected OA directory has no matching DEFINE entry.
- **Recommended action:** Continue with the temporary library overlay, or add a site-approved DEFINE entry outside VL3D.

### VL3D-E2018 (E2018) - No OA layout view was found

- **Severity:** warning
- **Cause:** The selected cell has no supported layout/maskLayout/chip/cLayout/dLayout/ivpcell view.
- **Recommended action:** Enter a custom OA view in Advanced settings or confirm the layout was migrated.

### VL3D-E2019 (E2019) - Graphical picker cannot be started

- **Severity:** warning
- **Cause:** A picker exists but the desktop launch failed.
- **Recommended action:** Check DISPLAY/WAYLAND_DISPLAY and DBUS_SESSION_BUS_ADDRESS, then use manual entry if needed.

### VL3D-E2020 (E2020) - Project root is invalid

- **Severity:** error
- **Cause:** The selected project root is missing, unreadable, or lacks tools/server.mjs.
- **Recommended action:** Run VL3D from the installed project or pass its directory with `--root`.

### VL3D-E2021 (E2021) - Project files are not readable

- **Severity:** error
- **Cause:** The server or public frontend cannot be read by the current account.
- **Recommended action:** Correct project ownership/permissions or reinstall into a readable directory.

### VL3D-E2022 (E2022) - Local API request was rejected

- **Severity:** error
- **Cause:** The request came from a non-loopback client, an untrusted origin, or an unsupported HTTP shape.
- **Recommended action:** Open VL3D through its local server URL and do not proxy OA controls to untrusted clients.

### VL3D-E2023 (E2023) - Library session expired

- **Severity:** warning
- **Cause:** The in-memory library token expired, was evicted, or belongs to an earlier server process.
- **Recommended action:** Use Load Library again; saved paths remain available but session tokens are intentionally not persisted.

## VL3D-E3xxx - OpenAccess

### VL3D-E3001 (E3001) - OA loading is disabled

- **Severity:** warning
- **Cause:** The server was started without OA export enabled.
- **Recommended action:** Restart with `vl3d start --enable-oa` after configuring Cadence safely.

### VL3D-E3002 (E3002) - Cadence environment is unavailable

- **Severity:** error
- **Cause:** OA loading was requested without a readable Cadence environment adapter.
- **Recommended action:** Select the adapter in Advanced settings or set `VL3D_CADENCE_ENV`.

### VL3D-E3003 (E3003) - Virtuoso export process failed to launch

- **Severity:** error
- **Cause:** The sanitized OA export process could not execute Virtuoso.
- **Recommended action:** Check the adapter, executable path, execute permissions, and supported OS libraries.

### VL3D-E3004 (E3004) - OA database could not be opened

- **Severity:** error
- **Cause:** Virtuoso/OpenAccess rejected the selected library, cell, or view.
- **Recommended action:** Open the same view in Virtuoso, inspect its log, and verify library/technology attachment.

### VL3D-E3005 (E3005) - PCell evaluation failed

- **Severity:** error
- **Cause:** A PCell dependency, callback, or technology context failed during OA traversal.
- **Recommended action:** Load the correct PDK initialization and verify the PCell in Virtuoso before retrying.

### VL3D-E3006 (E3006) - OA master.tag is invalid

- **Severity:** error
- **Cause:** master.tag is malformed, unsafe, or points outside the selected view.
- **Recommended action:** Repair the OA view through Virtuoso; do not hand-edit binary OA data.

### VL3D-E3007 (E3007) - OA export timed out

- **Severity:** error
- **Cause:** Virtuoso traversal exceeded the configured export timeout.
- **Recommended action:** Check for license dialogs or broken PCells, then reduce hierarchy/shape scope or raise the advanced timeout.

### VL3D-E3008 (E3008) - Cadence license checkout failed

- **Severity:** error
- **Cause:** Virtuoso reported that a required license feature could not be checked out.
- **Recommended action:** Verify license variables, server reachability, feature availability, and vendor daemon status.

### VL3D-E3009 (E3009) - OA source changed during export

- **Severity:** error
- **Cause:** The selected OA view or configuration changed after discovery.
- **Recommended action:** Close active edits, reload the library session, and export again.

### VL3D-E3010 (E3010) - OA identity is invalid

- **Severity:** error
- **Cause:** Library, cell, or view names contain unsupported characters.
- **Recommended action:** Select an OA-valid identity and avoid passing filesystem paths as cell names.

## VL3D-E4xxx - Conversion

### VL3D-E4001 (E4001) - Layout TSV schema is unsupported

- **Severity:** error
- **Cause:** The exporter and converter disagree on the intermediate schema version.
- **Recommended action:** Use matching VL3D tools and regenerate the TSV instead of editing it manually.

### VL3D-E4002 (E4002) - Layout TSV is malformed

- **Severity:** error
- **Cause:** A required record, field, number, or hierarchy reference cannot be parsed.
- **Recommended action:** Inspect the export log, regenerate the source, and report the first rejected record.

### VL3D-E4003 (E4003) - Layout units are invalid

- **Severity:** error
- **Cause:** The source database unit is invalid, or viewer JSON uses unsupported coordinate units.
- **Recommended action:** Export normalized micrometer (um) geometry. Convert all coordinates and dimensions consistently; never just relabel the units field.

### VL3D-E4004 (E4004) - Conversion resource limit was exceeded

- **Severity:** error
- **Cause:** Input size, shape count, hierarchy depth, or conversion time exceeded a safety limit. GDS/OAS imports may publish a clearly marked partial result when only the shape/depth cap is reached.
- **Recommended action:** Inspect `exportStatus.complete`, `truncationReasons`, and warnings. Prefer `low` on constrained machines, `balanced` normally, and `large` only with sufficient memory; otherwise select/flatten a smaller top cell.

### VL3D-E4005 (E4005) - Converted JSON could not be published

- **Severity:** error
- **Cause:** The converter could not atomically write the JSON or manifest entry.
- **Recommended action:** Check cache permissions, free space, and stale lock files.

### VL3D-E4006 (E4006) - Unsupported geometry was skipped

- **Severity:** warning
- **Cause:** The OA/stream source contains a shape type not represented by this viewer build.
- **Recommended action:** Review the warning count and source layer; upgrade or add a minimal geometry handler if visually significant.

## VL3D-E5xxx - PDK semantics

### VL3D-E5001 (E5001) - Technology library was not identified

- **Severity:** warning
- **Cause:** No authoritative technology name was exported and no reliable fallback matched.
- **Recommended action:** Select/create a PDK profile and confirm the technology attached to the OA library.

### VL3D-E5002 (E5002) - PDK layer is unclassified

- **Severity:** warning
- **Cause:** A layer-purpose pair has no routing, via, device, pin, or auxiliary semantic.
- **Recommended action:** Map it in a PDK profile; it remains preserved but hidden to avoid misleading geometry.

### VL3D-E5003 (E5003) - Physical layer stack is incomplete

- **Severity:** warning
- **Cause:** One or more conductive layers lack trustworthy Z position or thickness.
- **Recommended action:** Import the PDK stack/profile and confirm units; fallback spacing is visualization-only.

### VL3D-E5004 (E5004) - Via endpoints are unknown

- **Severity:** warning
- **Cause:** A via could not be connected to unambiguous lower and upper routing layers.
- **Recommended action:** Add via endpoint aliases to the PDK profile and verify its cut-layer purpose.

### VL3D-E5005 (E5005) - PDK profile is invalid

- **Severity:** error
- **Cause:** The selected profile has an unsupported schema, duplicate mapping, or invalid numeric stack value.
- **Recommended action:** Validate against the profile schema and correct the first reported field.

### VL3D-E5006 (E5006) - Layer map conflicts with PDK metadata

- **Severity:** warning
- **Cause:** Stream mapping and profile semantics disagree for the same layer-purpose pair.
- **Recommended action:** Prefer the foundry-approved map and explicitly override only the conflicting entry.

### VL3D-E5007 (E5007) - PDK profile was inferred

- **Severity:** warning
- **Cause:** No authoritative technology identity was available, so a design-library or layer-signature matcher selected the profile.
- **Recommended action:** Confirm the inferred profile and set an explicit profile override when physical Z accuracy matters.

### VL3D-E5008 (E5008) - PDK profile source is unavailable

- **Severity:** error
- **Cause:** A configured profile directory is missing, unreadable, symlinked, oversized, malformed, or exceeds the bounded directory/file limits.
- **Recommended action:** Use an absolute real directory containing regular JSON profile files only, correct permissions/content, or remove the invalid manual override. Explicit profile selection takes precedence over discovery directories.

### VL3D-E5009 (E5009) - PDK profile selection is ambiguous

- **Severity:** warning
- **Cause:** More than one profile exactly matches the exported technology identity.
- **Recommended action:** Remove duplicate aliases or explicitly select the intended profile; the highest-precedence match is temporary.

### VL3D-E5010 (E5010) - Source technology layers conflict

- **Severity:** warning
- **Cause:** Multiple source technologies or contradictory OA materials share a layer identity.
- **Recommended action:** Check source technology attachment. Conflicting material layers stay hidden; do not infer cross-technology connectivity.

## VL3D-E6xxx - GDSII/OASIS stream

### VL3D-E6001 (E6001) - Stream file cannot be read

- **Severity:** error
- **Cause:** The selected GDSII/OASIS path is missing, unreadable, or not a regular file.
- **Recommended action:** Select a readable `.gds`, `.gdsii`, or `.oas` file.

### VL3D-E6002 (E6002) - Stream top cell selection is required

- **Severity:** error
- **Cause:** The requested top is absent, or the stream has multiple top cells and none was selected.
- **Recommended action:** Choose one of the returned `topCells` candidates and retry with the exact name.

### VL3D-E6003 (E6003) - Stream layer map is invalid

- **Severity:** error
- **Cause:** The JSON layer map is malformed or contains invalid routing/defaultVisible types.
- **Recommended action:** Start from the example map and correct the reported layer entry.

### VL3D-E6004 (E6004) - Stream parser failed

- **Severity:** error
- **Cause:** gdstk and/or the configured KLayout fallback failed while reading or traversing the stream database.
- **Recommended action:** Check file integrity and parser details; prefer a compatible gdstk wheel or repair the complete KLayout installation.

### VL3D-E6005 (E6005) - Stream import timed out

- **Severity:** error
- **Cause:** Stream parsing or hierarchy expansion exceeded the configured timeout.
- **Recommended action:** Check file integrity, choose the correct top cell, or raise the advanced timeout on a capable machine.

### VL3D-E6006 (E6006) - Stream has unmapped layers

- **Severity:** warning
- **Cause:** One or more layer/datatype pairs have no PDK mapping.
- **Recommended action:** The used pairs remain visible in deterministic layer/datatype order with approximate Z spacing so the first view is not blank. This fallback is visualization-only and non-signoff; load an explicit foundry profile/layer map for trustworthy names and physical Z values.

### VL3D-E6007 (E6007) - No usable stream parser is available

- **Severity:** error
- **Cause:** Neither the managed gdstk package nor a complete KLayout database reader is usable.
- **Recommended action:** Rerun native setup, use an offline wheelhouse, or manually select a complete KLayout installation.

### VL3D-E6008 (E6008) - Stream source changed during import

- **Severity:** error
- **Cause:** The selected JSON/GDSII/OASIS file changed after validation and before publication.
- **Recommended action:** Stop the writer, select the stable file again, and retry; the failed result was not published.

## VL3D-E7xxx - Runtime cache

### VL3D-E7001 (E7001) - Cache directory is unavailable

- **Severity:** error
- **Cause:** The runtime cache directory is missing, unsafe, or not writable.
- **Recommended action:** Set XDG_CACHE_HOME/VL3D_CACHE_DIR to a writable local filesystem.

### VL3D-E7002 (E7002) - Cache manifest is corrupt

- **Severity:** error
- **Cause:** manifest.json is invalid, oversized, or inconsistent with its entries.
- **Recommended action:** Move the corrupt runtime cache aside and regenerate affected cells from source.

### VL3D-E7003 (E7003) - Cached layout is stale

- **Severity:** warning
- **Cause:** OA source or converter fingerprints no longer match the cached entry.
- **Recommended action:** Open the cell again to refresh it; do not reuse stale JSON for signoff.

### VL3D-E7004 (E7004) - Cache lock could not be acquired

- **Severity:** error
- **Cause:** Another export holds the lock or a stale lock exceeded its timeout.
- **Recommended action:** Wait for the active export; if none exists, inspect ownership before removing only the stale lock.

### VL3D-E7005 (E7005) - Cache storage is full

- **Severity:** error
- **Cause:** The cache publish failed because the filesystem has insufficient free space or quota.
- **Recommended action:** Use `vl3d doctor` to locate the data directory, move that entire directory aside, then reopen cells; or point `VL3D_DATA_DIR` at a filesystem with more free space. Do not delete individual cache files.

### VL3D-E7006 (E7006) - Cache ownership is unsafe

- **Severity:** error
- **Cause:** Runtime files are owned by another account or are writable by untrusted users.
- **Recommended action:** Correct ownership and use private XDG directories with 0700/0600 permissions.

## VL3D-E8xxx - Frontend and interaction

### VL3D-E8001 (E8001) - WebGL is unavailable

- **Severity:** error
- **Cause:** The browser cannot create the required WebGL rendering context.
- **Recommended action:** Use `vl3d gui`; for browser compatibility mode, enable hardware acceleration or update the graphics driver.

### VL3D-E8002 (E8002) - Shader or GPU initialization failed

- **Severity:** error
- **Cause:** The GPU driver rejected a shader, buffer, or texture allocation.
- **Recommended action:** Update the graphics driver, reduce browser visual quality, and capture the console error.

### VL3D-E8003 (E8003) - Frontend ran out of memory

- **Severity:** error
- **Cause:** The browser process exceeded available memory while loading/building geometry.
- **Recommended action:** Use LOD/shape limits, close other tabs, or select a smaller hierarchy.

### VL3D-E8004 (E8004) - Interaction latency is excessive

- **Severity:** warning
- **Cause:** Frame time or fast-mode transition exceeds the interactive target.
- **Recommended action:** Keep fast mode enabled, reduce edge/detail quality, and inspect the performance panel for the reported phase.

### VL3D-E8005 (E8005) - Pointer controls behave unexpectedly

- **Severity:** warning
- **Cause:** Browser, touchpad, or configured orbit direction conflicts with expected gestures.
- **Recommended action:** Reset controls, select the preferred orbit/pan direction, and verify with the interaction self-test.

### VL3D-E8006 (E8006) - Layout data fetch failed

- **Severity:** error
- **Cause:** The browser could not fetch or decode the selected manifest/JSON resource.
- **Recommended action:** Check the server response, cache entry, gzip sidecar, and browser network console.

### VL3D-E8007 (E8007) - Canvas fallback limit was reached

- **Severity:** warning
- **Cause:** The non-WebGL renderer omitted detail to remain responsive.
- **Recommended action:** Use WebGL or lower the visible hierarchy/layer count.

### VL3D-E8008 (E8008) - Native Tk/OpenGL is unavailable

- **Severity:** error
- **Cause:** Tk, the OpenGL widget, shaders, or required OpenGL 2.1 instancing extensions could not initialize.
- **Recommended action:** Run `vl3d doctor`, verify `glxinfo`, install the documented native packages, and confirm the desktop display is accessible.

### VL3D-E8009 (E8009) - Native backend connection failed

- **Severity:** error
- **Cause:** The private loopback backend failed to start, authenticate, or remain attached to the GUI control pipe.
- **Recommended action:** Restart VL3D and inspect the first backend startup diagnostic; do not reuse tokens or expose the private port.

## VL3D-E9xxx - Internal

### VL3D-E9001 (E9001) - Unhandled internal error

- **Severity:** error
- **Cause:** VL3D reached an unexpected code path.
- **Recommended action:** Record the error code, command, version, and minimal reproducer, then open an issue.

### VL3D-E9002 (E9002) - Internal data invariant failed

- **Severity:** error
- **Cause:** Data passed an earlier stage but violates a required internal contract.
- **Recommended action:** Clear only the affected generated cache, reproduce, and report the input schema/technology metadata.

### VL3D-E9003 (E9003) - Frontend/backend protocol mismatch

- **Severity:** error
- **Cause:** The UI and server API/schema versions are incompatible.
- **Recommended action:** Restart from one VL3D installation and clear stale browser assets.

### VL3D-E9004 (E9004) - Child process failed unexpectedly

- **Severity:** error
- **Cause:** A managed converter, exporter, or server process exited without a classified error.
- **Recommended action:** Inspect its captured stdout/stderr and rerun `vl3d doctor --json`.

### VL3D-E6009 (E6009) - Pin annotations are invalid

The annotation source identity, geometry digest, units, instance path, layer or pin geometry does not match the loaded source. Use `tools/annotate_pins.py --inspect` to obtain its exact binding, correct the reported field, then select the annotation file in **Load setup** and retry. Original layout geometry is not changed.
