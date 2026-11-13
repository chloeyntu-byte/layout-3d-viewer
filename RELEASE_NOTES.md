# Layout 3D Viewer 1.1.0

Browser client update. The native client and the file formats are unchanged.

Highlights
- **One find box** for pins, submodules and nets (press `/`). The camera flies to the match and the rest of the layout fades. A selected pin gets a light column and a pulsing ring; a selected module gets an outline box.
- **Metal / Studio** render styles. Studio is flat and bright, for presentations and light backgrounds. Switching changes materials, lights and colours only, so it adds no render cost.
- **Smoother motion.** While you drag, rotate or fly, only the top metals are drawn as outlines; solids return when you stop. The view renders at 1x while moving and supersamples at rest.
- **Less aliasing.** Vias and contacts no longer draw outlines by default; the new *Edges* control changes this.

Fixes from review: the search module is now shipped in the npm and source release, and a release test checks every browser import. Escape in the find box no longer clears the selection. View presets cancel a running camera flight. The find results are accessible (combobox, `aria-activedescendant`, click activation).

See `CHANGELOG.md` for the full list.
