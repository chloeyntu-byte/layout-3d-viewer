# Contributing

VL3D is a local layout viewer. Keep the OA export, JSON conversion and native
viewer interfaces compatible; prefer focused fixes over framework replacements.

1. Install the native dependencies with `./bin/vl3d setup --native --install`.
2. For development only, run `npm ci`.
3. Run `npm test` and `npm run release:check` before submitting changes. Use the
   configured native Python environment when running Python tests directly.
4. Add synthetic regression data for geometry, layer or connectivity fixes.
   Never include real layouts, PDK files, local paths, credentials or caches.
5. For a UI change, exercise loading, hierarchy selection, pin tracing and
   camera movement in the native application. Unit tests do not verify GPU
   driver compatibility or perceived latency.

New layer profiles should declare layer semantics explicitly and mark estimated
thicknesses as approximate. Do not infer electrical connections from matching
net names in different instances or from bounding-box proximity.

Contributions are submitted under the project's MIT license. No contributor
license agreement or activation service is required.
