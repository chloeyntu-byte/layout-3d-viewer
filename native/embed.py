"""Embeddable 3D preview for other Tk programs.

A small public surface over the native viewer: give it polygons, vias and pins in
micrometres plus a bottom-to-top layer order, and it shows them in 3D with pin labels.
Everything else in the viewer (hierarchy, nets, tracing, loading) stays out.

    from native import embed
    ok, reason = embed.available()
    layers = embed.layer_stack(['M1', 'M2', 'M3'], vias=[('M1', 'M2', 'VIA1'), ('M2', 'M3', 'VIA2')])
    scene = embed.scene_from_geometry(polygons, pins=pins, vias=vias, layers=layers)
    preview = embed.Preview3D(parent, style='studio')
    preview.pack(fill='both', expand=True)
    preview.set_scene(scene)

See docs/EMBEDDING.md for the full contract.
"""
from __future__ import absolute_import

import os
import sys

STYLES = ('metal', 'studio')
THEMES = ('dark', 'light')
DEFAULT_THICKNESS = {'metal': 0.30, 'via': 0.25, 'contact': 0.15, 'poly': 0.15, 'active': 0.10}
SCENE_ROOT = 'preview'


_SYSTEM_LIB_DIRS = ('/usr/lib64', '/usr/lib/x86_64-linux-gnu', '/lib64', '/usr/lib', '/lib/x86_64-linux-gnu')
# Loaded in this order with RTLD_GLOBAL so Tk and the GL driver share one X11/xcb/GLX stack.
_SYSTEM_GL_STACK = ('libX11.so.6', 'libxcb.so.1', 'libGLdispatch.so.0', 'libGLX.so.0', 'libGL.so.1')
_runtime_state = {'prepared': False, 'note': ''}


_SYSTEM_PREFIXES = ('/usr', '/usr/local', '/')


def _python_prefixes():
    """Prefixes of this Python that may hold private copies of system libraries (never /usr)."""
    prefixes = set(os.path.realpath(p) for p in (sys.prefix, getattr(sys, 'base_prefix', sys.prefix)) if p)
    return set(p for p in prefixes if p not in _SYSTEM_PREFIXES)


def _loaded_libraries(soname):
    """Real paths of every mapping of soname in this process."""
    found = set()
    try:
        with open('/proc/self/maps') as handle:
            for line in handle:
                parts = line.split()
                if len(parts) >= 6 and os.path.basename(parts[-1]).startswith(soname):
                    found.add(os.path.realpath(parts[-1]))
    except (IOError, OSError):
        pass
    return found


def _is_private(path):
    return any(path.startswith(prefix + os.sep) for prefix in _python_prefixes())


def _python_ships(soname):
    return any(os.path.exists(os.path.join(prefix, 'lib', soname)) for prefix in _python_prefixes())


def prepare_runtime():
    """Make Tk and OpenGL share the system X11/GL libraries. Call before importing tkinter.

    Pythons that bundle their own libX11 (conda/miniforge) load it for Tk, while the system OpenGL
    driver (libGLX_mesa etc.) is linked to the system libX11. Two X11 copies in one process crash
    on the first GL call. Loading the system stack first makes Tk reuse it. Does nothing on other
    Pythons, on non-Linux systems, or when VL3D_GL_SYSTEM_LIBS=0. Returns a short status string.
    """
    if _runtime_state['prepared']:
        return _runtime_state['note']
    _runtime_state['prepared'] = True
    if not sys.platform.startswith('linux') or os.environ.get('VL3D_GL_SYSTEM_LIBS') == '0':
        _runtime_state['note'] = 'not needed'
        return _runtime_state['note']
    if not _python_ships('libX11.so.6') or _python_ships('libGLX_mesa.so.0'):
        _runtime_state['note'] = 'not needed: Python has no private X11, or ships its own GL driver'
        return _runtime_state['note']
    if '_tkinter' in sys.modules or any(_is_private(path) for path in _loaded_libraries('libX11.so')):
        _runtime_state['note'] = 'too late: tkinter or a private libX11 was loaded first'
        return _runtime_state['note']
    import ctypes
    loaded = []
    for soname in _SYSTEM_GL_STACK:
        path = next((os.path.join(d, soname) for d in _SYSTEM_LIB_DIRS if os.path.exists(os.path.join(d, soname))), '')
        if not path:
            continue
        try:
            ctypes.CDLL(path, mode=ctypes.RTLD_GLOBAL)
            loaded.append(soname)
        except OSError as error:
            _runtime_state['note'] = 'partial: loaded %s; %s failed: %s' % (', '.join(loaded) or 'nothing', soname, error)
            return _runtime_state['note']
    _runtime_state['note'] = 'system GL stack loaded: ' + ', '.join(loaded) if loaded else 'no system GL libraries found'
    return _runtime_state['note']


def _mixed_x11():
    """True when two libX11 copies are mapped, or Tk's comes from the Python prefix while GL would be the system one."""
    copies = _loaded_libraries('libX11.so')
    if len(copies) > 1:
        return True
    if not copies or _python_ships('libGLX_mesa.so.0'):
        return False
    return any(_is_private(path) for path in copies)


def available():
    """(True, '') when the 3D widget can be created; otherwise (False, reason) and callers keep their 2D view."""
    try:
        import tkinter  # noqa: F401
    except ImportError as error:
        return False, 'Tk is unavailable: %s' % error
    try:
        from .gl_view import dependency_error
    except Exception as error:  # pragma: no cover - import guard
        return False, str(error)
    error = dependency_error()
    if error is not None:
        return False, str(error)
    if _mixed_x11() and os.environ.get('VL3D_GL_SYSTEM_LIBS') != '0':
        return False, ('Tk uses the libX11 bundled with this Python but OpenGL would use the system one; '
                       'call native.embed.prepare_runtime() before importing tkinter')
    try:
        import numpy  # noqa: F401
    except ImportError as error:
        return False, 'numpy is unavailable: %s' % error
    return True, ''


# ----------------------------------------------------------------------------------------------
# Scene building (pure Python, no Tk or OpenGL needed)

def _text(value):
    return str(value or '').strip()


def layer_stack(metals, vias=(), thickness=None, extra_below=()):
    """Return the layer list (bottom to top) for scene_from_geometry.

    metals       metal names from bottom to top, e.g. ['M1', ..., 'M9', 'AP'].
    vias         (lower_metal, upper_metal, cut_layer) tuples or dicts with those keys
                 ('lower', 'upper', 'cut_layer'); each cut layer is placed between its metals.
    thickness    optional {layer_name: um} overrides. Without them every metal is 0.30 um and
                 every cut 0.25 um: the stack order is exact, the heights are illustrative.
    extra_below  optional (name, kind) pairs placed under the first metal, e.g. ('POLY', 'poly').
    """
    thickness = dict((k.upper(), float(v)) for k, v in (thickness or {}).items())
    cuts = {}
    for via in vias or ():
        if isinstance(via, dict):
            lower, upper, cut = via.get('lower'), via.get('upper'), via.get('cut_layer') or via.get('cut')
        else:
            lower, upper, cut = via
        if _text(lower) and _text(cut):
            cuts.setdefault(_text(lower).upper(), []).append(_text(cut).upper())
    layers = []

    def add(name, kind, metal=None):
        name = _text(name).upper()
        if not name or any(layer['name'] == name for layer in layers):
            return
        entry = {'name': name, 'kind': kind, 'routing': True, 'defaultVisible': True,
                 'thickness': thickness.get(name, DEFAULT_THICKNESS.get(kind, 0.25))}
        if metal is not None:
            entry['metal'] = metal
        layers.append(entry)

    for name, kind in extra_below or ():
        add(name, kind)
    for number, metal in enumerate(metals or (), 1):
        add(metal, 'metal', number)
        for cut in cuts.get(_text(metal).upper(), []):
            add(cut, 'via')
    return layers


def _points_from(item):
    points = item.get('points')
    if points:
        return [(float(p[0]), float(p[1])) for p in points]
    box = item.get('bbox')
    if box:
        (x0, y0), (x1, y1) = box[0], box[1]
        x0, x1 = sorted((float(x0), float(x1)))
        y0, y1 = sorted((float(y0), float(y1)))
        return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    return []


def _bbox_of(points):
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return {'min': [min(xs), min(ys)], 'max': [max(xs), max(ys)]}


def scene_from_geometry(polygons, pins=(), vias=(), layers=None, cell=SCENE_ROOT):
    """Build an in-memory layout dict (schema v2, micrometres) for Preview3D.set_scene.

    polygons  dicts with 'layer' and 'points' [[x, y], ...] or 'bbox' [[x0, y0], [x1, y1]];
              optional 'net'.
    vias      dicts with 'bbox' and 'cut_layer' (as Flux and most generators emit); drawn as one
              block per via array on the cut layer between its metals.
    pins      dicts with 'name', 'layer' and 'points' or 'bbox'.
    layers    output of layer_stack(); layers not listed there are appended on top as unknown.
    """
    shapes = []
    all_points = []
    for item in polygons or ():
        points = _points_from(item)
        if len(points) < 3:
            continue
        shapes.append({'layer': _text(item.get('layer')).upper(), 'type': 'polygon', 'points': [list(p) for p in points],
                       'bbox': _bbox_of(points), 'hierPath': cell, 'net': _text(item.get('net')), 'purpose': 'drawing'})
        all_points.extend(points)
    for item in vias or ():
        points = _points_from(item)
        layer = _text(item.get('cut_layer') or item.get('layer')).upper()
        if len(points) < 3 or not layer:
            continue
        shapes.append({'layer': layer, 'type': 'rect', 'points': [list(p) for p in points], 'bbox': _bbox_of(points),
                       'hierPath': cell, 'net': _text(item.get('net')), 'purpose': 'drawing'})
        all_points.extend(points)
    pin_records = []
    for item in pins or ():
        points = _points_from(item)
        name = _text(item.get('name') or item.get('terminal'))
        if len(points) < 3 or not name:
            continue
        box = _bbox_of(points)
        pin_records.append({'name': name, 'terminal': name, 'layer': _text(item.get('layer')).upper(), 'hierPath': cell,
                            'points': [list(p) for p in points], 'bbox': box, 'worldBBox': box,
                            'figureIndex': 0, 'purpose': 'pin'})
        all_points.extend(points)
    stack = []
    known = set()
    for layer in layers or []:
        entry = dict(layer)
        entry['name'] = _text(entry.get('name')).upper()
        if entry['name'] and entry['name'] not in known:
            known.add(entry['name'])
            stack.append(entry)
    for shape in shapes:
        if shape['layer'] not in known:
            known.add(shape['layer'])
            stack.append({'name': shape['layer'], 'kind': 'metal', 'routing': True, 'defaultVisible': True,
                          'thickness': DEFAULT_THICKNESS['metal']})
    bbox = _bbox_of(all_points) if all_points else {'min': [-1.0, -1.0], 'max': [1.0, 1.0]}
    return {'schemaVersion': 2, 'units': 'um', 'library': 'preview', 'cell': cell, 'view': 'layout', 'bbox': bbox,
            'layers': stack, 'shapes': shapes, 'pins': pin_records, 'instances': [],
            'shapeCount': len(shapes), 'pinCount': len(pin_records)}


# ----------------------------------------------------------------------------------------------
# Tk widget

def _tk():
    import tkinter
    return tkinter


class Preview3D(object):
    """A Tk frame holding the 3D view. Construct it in the Tk main thread.

    If OpenGL is unavailable it shows a one-line message instead of raising, so callers can
    always create it; check .ok to decide whether to offer the 3D tab.
    """

    def __init__(self, master, style='studio', theme='dark', z_scale=1.0, debounce_ms=120,
                 on_pin_click=None, show_pins=True, **frame_options):
        tk = _tk()
        self.frame = tk.Frame(master, **frame_options)
        self.ok, self.reason = available()
        self.view = None
        self._pending = None
        self._pending_fit = None
        self._after = None
        self._has_scene = False
        self._bounds = None
        self._debounce_ms = max(0, int(debounce_ms))
        self._show_pins = bool(show_pins)
        self._on_pin_click = on_pin_click
        self._fit_bounds = None
        self._destroyed = False
        self.frame.bind('<Destroy>', self._frame_destroyed, add='+')
        if not self.ok:
            self._show_unavailable()
            return
        from .gl_view import LayoutGLView
        self.view = LayoutGLView(self.frame)
        self.view.init_error_callback = self._gl_failed
        self.view.pack(fill='both', expand=True)
        self.view.pin_selected_callback = self._pin_clicked
        self.view.compact_pin_labels = True
        self.view.extended_palette = True  # previews: metal colours repeat above M6 instead of one grey
        self.set_style(style)
        self.set_theme(theme)
        self.set_z_scale(z_scale)

    # geometry managers act on the frame
    def pack(self, *args, **kwargs):
        return self.frame.pack(*args, **kwargs)

    def grid(self, *args, **kwargs):
        return self.frame.grid(*args, **kwargs)

    def place(self, *args, **kwargs):
        return self.frame.place(*args, **kwargs)

    def _show_unavailable(self):
        _tk().Label(self.frame, text='3D preview unavailable: %s' % self.reason, anchor='w', justify='left',
                    wraplength=420).pack(fill='both', expand=True, padx=12, pady=12)

    def _gl_failed(self, error):
        """OpenGL context, extension or shader setup failed: degrade to the message, like available() == False.

        Runs inside the view's own <Map> callback, so the view is only hidden, never destroyed here;
        it stays inert (it no longer draws) and goes away with the frame. Nothing is scheduled.
        """
        self.ok, self.reason = False, str(error)
        self._cancel_pending()
        view, self.view = self.view, None
        if view is not None:
            view.pack_forget()
        if not self._destroyed:
            self._show_unavailable()

    def _cancel_pending(self):
        self._pending = None
        if self._after is not None:
            try:
                self.frame.after_cancel(self._after)
            except Exception:
                pass
            self._after = None

    def _frame_destroyed(self, event):
        # Also fires when the host destroys a parent: Tk then never calls our destroy().
        if event.widget is self.frame:
            self._destroyed = True
            self._cancel_pending()

    def destroy(self):
        self._cancel_pending()
        self._destroyed = True
        self.frame.destroy()

    # --- scene
    def set_scene(self, scene, fit=None, immediate=False):
        """Show a scene dict from scene_from_geometry (or any schema-v2 layout dict).

        Calls within debounce_ms collapse into one rebuild, so it is safe to call on every slider
        move. fit=None fits the camera on the first scene and when the outline changes a lot, and
        otherwise keeps the user's view.
        """
        if not self.ok or self._destroyed:
            return
        self._pending = scene
        self._pending_fit = fit
        if self._after is not None:
            self.frame.after_cancel(self._after)
            self._after = None
        if immediate or not self._debounce_ms:
            self._apply_pending()
        else:
            self._after = self.frame.after(self._debounce_ms, self._apply_pending)

    def _apply_pending(self):
        from .compiler import compile_scene

        self._after = None
        scene, fit = self._pending, self._pending_fit
        self._pending = None
        if scene is None or self._destroyed or self.view is None:
            return
        compiled = compile_scene(scene)
        box = compiled.metadata.get('bbox') or {}
        bounds = tuple(box.get('min', [0, 0])) + tuple(box.get('max', [0, 0]))
        if fit is None:
            fit = not self._has_scene or self._bounds_changed(bounds)
        if fit:
            self._fit_bounds = bounds  # compare later scenes with the last framed one, so drift accumulates
        self._bounds = bounds
        self._has_scene = True
        self.view.pin_paths = [compiled.metadata.get('cell') or SCENE_ROOT] if self._show_pins else []
        self.view.load_layout(compiled, fit=bool(fit))

    def _bounds_changed(self, bounds):
        if not self._fit_bounds:
            return True
        old = self._fit_bounds
        span = max(old[2] - old[0], old[3] - old[1], 1e-9)
        return max(abs(a - b) for a, b in zip(old, bounds)) > 0.25 * span

    def clear(self):
        self.set_scene(scene_from_geometry([]), fit=True, immediate=True)

    # --- appearance
    def set_style(self, name):
        if self.view is not None:
            self.view.set_style('studio' if name == 'studio' else 'metal')

    def set_theme(self, name):
        if self.view is not None:
            self.view.set_theme('light' if name == 'light' else 'dark')

    def set_z_scale(self, value):
        """Display-only vertical stretch, 0.1 to 4 (1 = default)."""
        if self.view is not None:
            self.view.set_z_scale(value)

    # --- camera and pins
    def fit(self):
        if self.view is not None:
            self.view.fit_layout()
            self._fit_bounds = self._bounds

    def show_pins(self, visible=True):
        self._show_pins = bool(visible)
        if self.view is not None and self.view.compiled is not None:
            cell = self.view.metadata.get('cell') or SCENE_ROOT
            self.view.set_pin_scope([cell] if self._show_pins else [])

    def highlight_pin(self, name, focus=False):
        """Mark one pin as current (bold ring and label); name=None clears it."""
        if self.view is None or self.view.compiled is None:
            return False
        pin = None
        if name is not None:
            pin = next((p for p in self.view.metadata.get('pins') or [] if p.get('terminal') == name or p.get('name') == name), None)
            if pin is None:
                return False
        self.view.select_pin(pin)
        if focus and pin is not None:
            self.view.fit_pin(pin)
        return True

    def capture_png(self, path):
        """Save the current view as PNG (needs Pillow). Returns the path."""
        from PIL import Image

        if self.view is None:
            raise RuntimeError('3D preview unavailable: %s' % self.reason)
        width, height, data = self.view.capture_rgb()
        Image.frombytes('RGB', (width, height), data).save(path)
        return path

    def _pin_clicked(self, pin):
        self.view.select_pin(pin)
        if self._on_pin_click is not None:
            self._on_pin_click(pin.get('terminal') or pin.get('name'))


def flux_scene(result, technology, thickness=None):
    """Convenience adapter for a Flux-style generator result.

    result      the dict returned by the generator; uses result['geometry'] with 'polygons',
                'vias' and 'ports' (port 'name', 'layer', 'bbox').
    technology  the generator's technology dict; uses 'layers' (metal names, bottom to top) and
                'vias' ('lower', 'upper', 'cut_layer'). When 'vias' is absent (for example a UI copy
                of the technology), the vias in the geometry, which carry the same three fields,
                place the cut layers instead.
    """
    geometry = result.get('geometry', result)
    metals = [_text(layer.get('name') if isinstance(layer, dict) else layer) for layer in technology.get('layers') or []]
    via_definitions = technology.get('vias') or [via for via in geometry.get('vias') or []
                                                 if via.get('lower') and via.get('cut_layer')]
    stack = layer_stack(metals, via_definitions, thickness=thickness)
    pins = [{'name': port.get('name'), 'layer': port.get('layer'), 'bbox': port.get('bbox'), 'points': port.get('points')}
            for port in geometry.get('ports') or []]
    return scene_from_geometry(geometry.get('polygons') or [], pins=pins, vias=geometry.get('vias') or [], layers=stack)
