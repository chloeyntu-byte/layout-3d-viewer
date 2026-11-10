# Layout 3D Viewer 1.0.0

First open-source release (MIT).

Highlights
- Hierarchy-aware 3D viewer for JSON, GDSII and OASIS layouts, with optional Virtuoso OA loading when you provide your own Cadence environment.
- Pin tracing by physical geometry (through declared via endpoints) or by named nets.
- New desktop look shared with the other RF-FIELDWORK tools: unified header, tabbed explorer, status chip and progress bar, readable pin labels, and screenshot save / copy.
- Browser client recoloured to match the native client.
- Runs without Cadence: `./bin/vl3d gui --no-oa`, then *Load example* (synthetic octagonal inductor).

Technology data: the repository contains no foundry or PDK data. Use your own layer profile or layer map (see `docs/LAYER_PROFILES.md`); only a generic name-based profile and a fictional example profile are bundled.

Install: see the README. `node_modules` is not included; `npm ci` is only needed for browser regression tests.
