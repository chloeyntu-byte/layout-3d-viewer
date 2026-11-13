# Changelog

## 1.1.0 (unreleased)

Browser client.

### Added
- One find box for pins, modules and nets (`/` to focus, arrow keys and Enter). Results are grouped by kind; choosing one selects it, flies the camera there and fades everything else toward the background.
- Selected pin: a light column and ring in the scene plus a CSS pulse on screen (three pulses, then a static ring; no extra WebGL frames).
- Selected modules get an outline box.
- *Metal / Studio* render style switch. Studio is flat and bright (one luminous top metal, muted lower layers, faint edges) and works with the Dark and Light themes. Switching changes materials, lights and colours only; no geometry is rebuilt.
- *Edges* control: conductors (default), all including vias, or none.

### Changed
- Vias and contacts no longer draw outlines by default; they were most of the line aliasing on dense layouts.
- Fast preview also runs during auto-rotation and camera flights; the drawing buffer drops to 1× while moving and supersamples up to 1.5× (within a pixel budget) when still.
- The status object and pin label are updated less often while moving; the label HTML is rewritten only when its text changes.
- *Locate pin* and *Fit routes* animate the camera (reduced-motion users get a jump); Back, Fit and any drag or wheel cancel a flight.
- Module and net searches in the explorer are labelled "Find submodule" and "Find net by name".

## 1.0.0

First public release.

### Changed
- Native client: shared RF-FIELDWORK theme (`native/fieldwork_tk.py`), unified header, one primary action per panel, status chip with progress bar, Hierarchy / Layers tabs in the explorer, 4/8/12/16 px spacing, larger 3D viewport.
- Pin labels are larger, bordered and use the product accent for the current pin.
- Added *Save screenshot* (PNG) and *Copy screenshot* (clipboard via `wl-copy` or `xclip`) for the 3D view.
- Empty state with a *Load example* button.
- Browser client uses the same colour values as the native client, plus the accent stripe.
- Window and page titles are now "Layout 3D Viewer".

### Added
- Synthetic octagonal-inductor example (`examples/octagon-inductor.json`) and its generator `tools/make_example_inductor.py`.
- Fictional `profiles/example-process.json` and `docs/LAYER_PROFILES.md`: layer meaning for a real technology comes from profiles you provide.
- `tests/test_ui_smoke.py`.

### Removed
- All built-in foundry layer profiles, their stream layer tables and the foundry-specific name fallbacks (top-layer and capacitor-top-metal special cases) in the Python and JavaScript code and tests.
- Legacy renderer script, handoff/agent notes and private-design verification profiles.
- The standalone KLayout macro file; it is now embedded in `tools/klayout_macro.py` and written to a temporary file at run time.
