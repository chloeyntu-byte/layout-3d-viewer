# Changelog

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
