# Embedding the 3D preview

`native/embed.py` lets another Tk program show geometry in 3D with pin labels, without the rest of the viewer (no hierarchy, nets, tracing or file loading). It is meant for generators that want a live 3D preview of a structure before any layout cell exists, for example a parametric inductor or transformer tool.

Try it: `python3 examples/embed_preview.py` (a synthetic inductor; no PDK or Cadence).

## Requirements

- Python 3.6+ with Tk, `numpy`, `PyOpenGL` and `pyopengltk` (the same packages as the native client, see `requirements-native.txt`). `ijson` and `gdstk` are not needed for embedding.
- An X11 display with OpenGL 2.1 and the instancing extensions (any Mesa from the last decade, including software rendering through VNC).
- Coordinates in micrometres.

## Five calls

```python
from native import embed            # the repository root (or an installed copy) on sys.path

embed.prepare_runtime()             # 1. before `import tkinter` anywhere in the process
import tkinter as tk

ok, reason = embed.available()      # 2. False -> keep your 2D view and show `reason`

layers = embed.layer_stack(         # 3. bottom-to-top order; cut layers go between their metals
    ['M1', 'M2', 'M3'],
    vias=[('M1', 'M2', 'VIA1'), ('M2', 'M3', 'VIA2')],
    thickness={'M3': 0.9},          #    optional; defaults: metal 0.30 um, cut 0.25 um
)
scene = embed.scene_from_geometry(  # 4. plain dicts in, a schema-v2 layout dict out
    polygons=[{'layer': 'M3', 'points': [[0, 0], [40, 0], [40, 8], [0, 8]]}],
    vias=[{'cut_layer': 'VIA2', 'bbox': [[2, 2], [6, 6]]}],
    pins=[{'name': 'P1', 'layer': 'M3', 'bbox': [[0, 0], [4, 8]]}],
    layers=layers,
)

preview = embed.Preview3D(parent, style='studio', theme='dark', on_pin_click=print)
preview.pack(fill='both', expand=True)
preview.set_scene(scene)            # 5. call again whenever the geometry changes
```

## Data contract

| Input | Fields | Notes |
|---|---|---|
| polygon | `layer`, `points` `[[x, y], ...]` or `bbox` `[[x0, y0], [x1, y1]]`, optional `net` | Axis-aligned rectangles are drawn as instanced boxes; anything else is triangulated. Fewer than three points are skipped. |
| via | `cut_layer` (or `layer`), `bbox` | One block per via array is enough for a preview. |
| pin | `name`, `layer`, `points` or `bbox` | The label shows the name and the layer; the pin outline is drawn at the top of its layer. |
| layer | from `layer_stack()`, or dicts with `name`, `kind` (`metal`, `via`, `contact`, `poly`), `thickness`, `routing: True` | Layers that appear in shapes but not in the list are appended on top, so nothing disappears silently. |

The stack order is exact. Heights are illustrative unless you pass real thicknesses: technology databases often do not include them, and the preview does not invent them.

`flux_scene(result, technology)` is a ready-made adapter for generators whose result has `geometry.polygons`, `geometry.vias` (`cut_layer`, `bbox`) and `geometry.ports` (`name`, `layer`, `bbox`), and whose technology dict has `layers` (metal names, bottom to top) and `vias` (`lower`, `upper`, `cut_layer`).

## Preview3D

| Method | Effect |
|---|---|
| `set_scene(scene, fit=None, immediate=False)` | Calls within `debounce_ms` (default 120 ms) collapse into one rebuild, so it is safe on every slider move. `fit=None` frames the camera on the first scene and when the outline moves by more than a quarter of its size; otherwise the user's view is kept. |
| `set_style('metal' \| 'studio')` | Metal is the original look. Studio is flat and bright, with faint edges and no outlines on vias. Switching changes colours and shader constants only. |
| `set_theme('dark' \| 'light')` | Background, grid and label colours. |
| `set_z_scale(value)` | Display-only vertical stretch, 0.1 to 4. |
| `show_pins(bool)`, `highlight_pin(name, focus=False)` | Pin labels on or off; mark one pin as current and optionally fly to it. |
| `fit()`, `clear()`, `capture_png(path)` | Frame everything; empty scene; save the GL view (needs Pillow). |
| `.ok`, `.reason`, `.view` | Availability; why not; the underlying `LayoutGLView` for advanced use. |

Mouse: drag to orbit, Shift-drag or right-drag to pan, wheel to zoom. While the camera moves, only the top three metal layers are drawn as outlines; solids return when it stops.

## Performance

The preview is idle unless the scene or the camera changes; there is no animation loop. A generator structure of a few hundred polygons compiles in under 10 ms and uploads in one idle callback. Build the scene in the Tk thread (it is cheap), or build the dict in a worker and pass it to `set_scene` from the Tk thread; never call widget methods from another thread.

## Why `prepare_runtime()`

Pythons that bundle their own `libX11` (conda, miniforge) load it for Tk, while the system OpenGL driver is linked to the system `libX11`. Two copies in one process crash on the first GL call. `prepare_runtime()` loads the system X11/xcb/GL libraries first so Tk reuses them. It does nothing on Pythons without a private `libX11`, on Pythons that ship their own GL driver, outside Linux, or when `VL3D_GL_SYSTEM_LIBS=0`. If tkinter was already imported, it returns `too late: ...` and `available()` reports the problem instead of letting the process crash.
