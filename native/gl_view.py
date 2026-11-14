from __future__ import absolute_import

import ctypes
import math
import time

from .errors import Vl3dError
from .navigation import CameraState, PointerStateMachine
from .palettes import STYLES, palette_color, rgb, style_for_palette
from .pin_presentation import pin_annotations, pin_bounds, place_labels
from .selection import connected_net_keys, hierarchy_ids, net_ids, outline_indices, physical_shape_rows, selected_pins


try:
    from pyopengltk import OpenGLFrame
    _OPENGLTK_ERROR = None
except Exception as error:
    OpenGLFrame = object
    _OPENGLTK_ERROR = error


AXIS_COLORS = {
    'x': (0.68, 0.38, 0.38),
    'y': (0.42, 0.62, 0.46),
    'z': (0.37, 0.48, 0.65),
}

LAYOUT_AXIS_VECTORS = {
    'x': (1.0, 0.0, 0.0),
    'y': (0.0, 0.0, -1.0),
    'z': (0.0, 1.0, 0.0),
}

PIN_LABEL_LIMIT = 48
PIN_SEGMENTS = {
    'a': ((0.0, 1.0), (0.6, 1.0)),
    'b': ((0.6, 1.0), (0.6, 0.5)),
    'c': ((0.6, 0.5), (0.6, 0.0)),
    'd': ((0.0, 0.0), (0.6, 0.0)),
    'e': ((0.0, 0.5), (0.0, 0.0)),
    'f': ((0.0, 1.0), (0.0, 0.5)),
    'g': ((0.0, 0.5), (0.6, 0.5)),
}
PIN_DIGITS = {
    '0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg',
    '5': 'acdfg', '6': 'acdefg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
}


def pin_number(index):
    return '#%d' % (int(index) + 1)


def dependency_error():
    if _OPENGLTK_ERROR is not None:
        return Vl3dError('E8008', 'Tk OpenGL adapter is unavailable: %s' % _OPENGLTK_ERROR)
    try:
        import numpy
        from OpenGL import GL
        from OpenGL import GLU
    except ImportError as error:
        return Vl3dError('E8008', 'Native OpenGL dependency is unavailable: %s' % error)
    return None


def _metal_number(layer):
    try:
        value = int(layer.get('metal'))
        if value > 0:
            return value
    except (TypeError, ValueError):
        pass
    name = str(layer.get('name') or '').upper()
    digits = name[5:] if name.startswith('METAL') else (name[1:] if name.startswith('M') else '')
    return int(digits) if digits.isdigit() else 0


def _cube_vertices(numpy):
    vertices = []

    def face(normal, corners):
        order = (0, 1, 2, 0, 2, 3)
        for index in order:
            point = corners[index]
            vertices.append((point[0], point[1], point[2], normal[0], normal[1], normal[2]))

    face((0, 1, 0), ((0, 1, 0), (1, 1, 0), (1, 1, 1), (0, 1, 1)))
    face((0, -1, 0), ((0, 0, 1), (1, 0, 1), (1, 0, 0), (0, 0, 0)))
    face((1, 0, 0), ((1, 0, 0), (1, 0, 1), (1, 1, 1), (1, 1, 0)))
    face((-1, 0, 0), ((0, 0, 1), (0, 0, 0), (0, 1, 0), (0, 1, 1)))
    face((0, 0, 1), ((1, 0, 1), (0, 0, 1), (0, 1, 1), (1, 1, 1)))
    face((0, 0, -1), ((0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)))
    return numpy.asarray(vertices, dtype=numpy.float32)


def _edge_vertices(numpy):
    points = (
        (0, 0, 0), (1, 0, 0), (1, 0, 0), (1, 0, 1),
        (1, 0, 1), (0, 0, 1), (0, 0, 1), (0, 0, 0),
        (0, 1, 0), (1, 1, 0), (1, 1, 0), (1, 1, 1),
        (1, 1, 1), (0, 1, 1), (0, 1, 1), (0, 1, 0),
        (0, 0, 0), (0, 1, 0), (1, 0, 0), (1, 1, 0),
        (1, 0, 1), (1, 1, 1), (0, 0, 1), (0, 1, 1),
    )
    return numpy.asarray(points, dtype=numpy.float32)


def _top_edge_vertices(numpy):
    points = (
        (0, 1, 0), (1, 1, 0),
        (1, 1, 0), (1, 1, 1),
        (1, 1, 1), (0, 1, 1),
        (0, 1, 1), (0, 1, 0),
    )
    return numpy.asarray(points, dtype=numpy.float32)


class LayoutGLView(OpenGLFrame):
    def __init__(self, master, **keywords):
        error = dependency_error()
        if error:
            raise error
        self.compiled = None
        self.metadata = {}
        self.arrays = {}
        self.palette_name = 'classic-dark-metal'
        self._metal_palette_name = 'classic-dark-metal'
        self.pin_paths = None  # None: pins of the selected modules; a list: always show these scopes' pins
        self.compact_pin_labels = False  # True: label detail is the layer name only (embedded previews)
        self.extended_palette = False  # True: repeat metal colours above M6 and share VIA aliases (previews)
        self.init_error_callback = None  # called with the error if OpenGL setup fails; otherwise it is raised
        self.theme = 'dark'
        self.resource_mode = 'balanced'
        self.z_scale = 1.0
        self.wires_visible = True
        self.instances_visible = False
        self.layer_visibility = {}
        self.selected_paths = []
        self.selected_pin = None
        self.physical_shape_indices = None
        self.selected_hierarchy_ids = set()
        self._selected_layer_ids = []
        self._connected_layer_ids = []
        self.selected_external_net_keys = []
        self.fast_mode = False
        self.camera = CameraState()
        self.pointer = PointerStateMachine()
        self.pin_selected_callback = None
        self.xray_highlights = True
        self._pin_annotations = []
        self._pin_label_widgets = {}
        self._pin_label_fonts = None
        self._pin_label_layout = []
        self.camera_changed_callback = None
        self.upload_progress_callback = None
        self._poll_callback = None
        self._upload_callback = None
        self._upload_index = 0
        self._gl_ready = False
        self._shader = None
        self._polygon_shader = None
        self._rect_buffer = 0
        self._lod_buffer = 0
        self._triangle_buffer = 0
        self._outline_buffer = 0
        self._instance_buffer = 0
        self._selected_buffer = 0
        self._net_buffer = 0
        self._cube_buffer = 0
        self._edge_buffer = 0
        self._top_edge_buffer = 0
        self._rect_ranges = {}
        self._lod_ranges = {}
        self._triangle_ranges = {}
        self._outline_layer_indices = {}
        self._selected_rect_ranges = {}
        self._net_rect_ranges = {}
        self._selected_rects = None
        self._net_rects = None
        self._selected_outline_indices = None
        self._net_outline_indices = None
        self._stack_top = 1.0
        self._bounds = (-1.0, -1.0, 1.0, 1.0)
        self._upload_source = None
        self._upload_target = 0
        self._upload_total = 0
        self._upload_phase = ''
        OpenGLFrame.__init__(self, master, **keywords)
        self.animate = 0
        self.bind('<ButtonPress-1>', self._button_one_press)
        self.bind('<B1-Motion>', self._button_motion)
        self.bind('<ButtonRelease-1>', self._button_release)
        self.bind('<ButtonPress-2>', lambda event: self._button_press(event, 'pan'))
        self.bind('<B2-Motion>', self._button_motion)
        self.bind('<ButtonRelease-2>', self._button_release)
        self.bind('<ButtonPress-3>', lambda event: self._button_press(event, 'pan'))
        self.bind('<B3-Motion>', self._button_motion)
        self.bind('<ButtonRelease-3>', self._button_release)
        self.bind('<Button-4>', lambda event: self._wheel(1.0))
        self.bind('<Button-5>', lambda event: self._wheel(-1.0))
        self.bind('<MouseWheel>', self._mouse_wheel)

    def initgl(self):
        try:
            self._initgl()
        except Exception as error:
            if self.init_error_callback is None:
                raise
            self.init_error_callback(error)

    def _initgl(self):
        from OpenGL import GL
        from OpenGL.GL import shaders
        from OpenGL.GL.ARB.draw_instanced import glDrawArraysInstancedARB
        from OpenGL.GL.ARB.instanced_arrays import glVertexAttribDivisorARB
        import numpy

        if self._gl_ready:
            GL.glViewport(0, 0, max(1, int(self.winfo_width())), max(1, int(self.winfo_height())))
            self.request_redraw()
            return

        extensions = GL.glGetString(GL.GL_EXTENSIONS) or b''
        if isinstance(extensions, bytes):
            extensions = extensions.decode('ascii', 'ignore')
        if 'GL_ARB_instanced_arrays' not in extensions or 'GL_ARB_draw_instanced' not in extensions:
            raise Vl3dError('E8008', 'OpenGL 2.1 instancing extensions are required')
        self._draw_instanced = glDrawArraysInstancedARB
        self._attribute_divisor = glVertexAttribDivisorARB
        vertex_source = r'''
            #version 120
            attribute vec4 aRect;
            attribute vec2 aHeight;
            uniform float uZScale;
            uniform float uOutline;
            uniform vec2 uShade;
            varying float vShade;
            void main() {
                vec3 unit = gl_Vertex.xyz;
                vec3 world = vec3(
                    mix(aRect.x, aRect.z, unit.x),
                    mix(aHeight.x, aHeight.y, unit.y) * uZScale,
                    -mix(aRect.y, aRect.w, unit.z)
                );
                gl_Position = gl_ModelViewProjectionMatrix * vec4(world, 1.0);
                vec3 normal = normalize(gl_NormalMatrix * vec3(gl_Normal.xy, -gl_Normal.z));
                float diffuse = max(dot(normal, normalize(vec3(0.32, 0.82, 0.46))), 0.0);
                vShade = mix(uShade.x + diffuse * uShade.y, 1.0, uOutline);
            }
        '''
        fragment_source = r'''
            #version 120
            uniform vec3 uColor;
            uniform float uOutline;
            uniform vec3 uFillGain;
            uniform vec3 uFillBias;
            varying float vShade;
            void main() {
                vec3 metallic = uColor * vShade;
                vec3 fill = metallic * uFillGain + uFillBias;
                gl_FragColor = vec4(mix(fill, uColor, uOutline), 1.0);
            }
        '''
        self._shader = shaders.compileProgram(
            shaders.compileShader(vertex_source, GL.GL_VERTEX_SHADER),
            shaders.compileShader(fragment_source, GL.GL_FRAGMENT_SHADER),
        )
        polygon_vertex_source = r'''
            #version 120
            uniform float uZScale;
            varying vec3 vEyePosition;
            void main() {
                vec3 world = vec3(gl_Vertex.x, gl_Vertex.z * uZScale, -gl_Vertex.y);
                vEyePosition = (gl_ModelViewMatrix * vec4(world, 1.0)).xyz;
                gl_Position = gl_ModelViewProjectionMatrix * vec4(world, 1.0);
            }
        '''
        polygon_fragment_source = r'''
            #version 120
            uniform vec3 uColor;
            uniform float uOutline;
            uniform vec2 uShade;
            uniform vec3 uFillGain;
            uniform vec3 uFillBias;
            varying vec3 vEyePosition;
            void main() {
                vec3 normal = normalize(cross(dFdx(vEyePosition), dFdy(vEyePosition)));
                float diffuse = max(dot(normal, normalize(vec3(0.32, 0.82, 0.46))), 0.0);
                vec3 fill = uColor * (uShade.x + diffuse * uShade.y) * uFillGain + uFillBias;
                gl_FragColor = vec4(mix(fill, uColor, uOutline), 1.0);
            }
        '''
        self._polygon_shader = shaders.compileProgram(
            shaders.compileShader(polygon_vertex_source, GL.GL_VERTEX_SHADER),
            shaders.compileShader(polygon_fragment_source, GL.GL_FRAGMENT_SHADER),
        )
        self._polygon_z_location = GL.glGetUniformLocation(self._polygon_shader, 'uZScale')
        self._polygon_color_location = GL.glGetUniformLocation(self._polygon_shader, 'uColor')
        self._polygon_outline_location = GL.glGetUniformLocation(self._polygon_shader, 'uOutline')
        self._style_locations = {}
        for program in (self._shader, self._polygon_shader):
            self._style_locations[program] = tuple(
                GL.glGetUniformLocation(program, name) for name in ('uShade', 'uFillGain', 'uFillBias'))
        self._rect_location = GL.glGetAttribLocation(self._shader, 'aRect')
        self._height_location = GL.glGetAttribLocation(self._shader, 'aHeight')
        self._z_location = GL.glGetUniformLocation(self._shader, 'uZScale')
        self._color_location = GL.glGetUniformLocation(self._shader, 'uColor')
        self._outline_location = GL.glGetUniformLocation(self._shader, 'uOutline')
        self._cube_buffer = GL.glGenBuffers(1)
        GL.glBindBuffer(GL.GL_ARRAY_BUFFER, self._cube_buffer)
        GL.glBufferData(GL.GL_ARRAY_BUFFER, _cube_vertices(numpy), GL.GL_STATIC_DRAW)
        self._edge_buffer = GL.glGenBuffers(1)
        GL.glBindBuffer(GL.GL_ARRAY_BUFFER, self._edge_buffer)
        GL.glBufferData(GL.GL_ARRAY_BUFFER, _edge_vertices(numpy), GL.GL_STATIC_DRAW)
        self._top_edge_buffer = GL.glGenBuffers(1)
        GL.glBindBuffer(GL.GL_ARRAY_BUFFER, self._top_edge_buffer)
        GL.glBufferData(GL.GL_ARRAY_BUFFER, _top_edge_vertices(numpy), GL.GL_STATIC_DRAW)
        self._rect_buffer = GL.glGenBuffers(1)
        self._lod_buffer = GL.glGenBuffers(1)
        self._triangle_buffer = GL.glGenBuffers(1)
        self._outline_buffer = GL.glGenBuffers(1)
        self._instance_buffer = GL.glGenBuffers(1)
        self._selected_buffer = GL.glGenBuffers(1)
        self._net_buffer = GL.glGenBuffers(1)
        GL.glEnable(GL.GL_DEPTH_TEST)
        GL.glDepthFunc(GL.GL_LEQUAL)
        GL.glEnable(GL.GL_BLEND)
        GL.glBlendFunc(GL.GL_SRC_ALPHA, GL.GL_ONE_MINUS_SRC_ALPHA)
        GL.glLineWidth(1.0)
        self._gl_ready = True
        if self.compiled is not None:
            self._begin_upload()
        self.request_redraw()

    def tkResize(self, event):
        from OpenGL import GL

        self.width = max(1, int(event.width))
        self.height = max(1, int(event.height))
        if getattr(self, 'context_created', False) and self.winfo_ismapped():
            self.tkMakeCurrent()
            GL.glViewport(0, 0, self.width, self.height)
            self.request_redraw()

    def _release_gl_resources(self):
        if not self._gl_ready or not getattr(self, 'context_created', False):
            return
        try:
            from OpenGL import GL

            self.tkMakeCurrent()
            buffers = [
                int(buffer_id) for buffer_id in (
                    self._rect_buffer, self._lod_buffer, self._triangle_buffer,
                    self._outline_buffer, self._instance_buffer, self._selected_buffer,
                    self._net_buffer, self._cube_buffer, self._edge_buffer,
                    self._top_edge_buffer,
                ) if buffer_id
            ]
            if buffers:
                GL.glDeleteBuffers(len(buffers), buffers)
            for program in (self._shader, self._polygon_shader):
                if program:
                    GL.glDeleteProgram(program)
        except Exception:
            pass
        self._gl_ready = False

    def destroy(self):
        self._clear_pin_labels()
        for callback in (self._poll_callback, self._upload_callback, getattr(self, 'cb', None)):
            if callback:
                try:
                    self.after_cancel(callback)
                except Exception:
                    pass
        self._poll_callback = None
        self._upload_callback = None
        self.cb = None
        self._release_gl_resources()
        OpenGLFrame.destroy(self)

    def request_redraw(self):
        if not getattr(self, 'context_created', False):
            return
        if self.cb:
            try:
                self.after_cancel(self.cb)
            except Exception:
                pass
        self.cb = self.after_idle(self._display)

    def load_layout(self, compiled, fit=True):
        self._clear_pin_labels()
        self._pin_annotations = []
        self.camera.history[:] = []
        self.compiled = compiled
        self.metadata = compiled.metadata
        self.arrays = compiled.arrays
        self.layer_visibility = dict(
            (int(layer.get('index', index)), bool(layer.get('defaultVisible', True)))
            for index, layer in enumerate(self.metadata.get('layers') or []))
        bbox = self.metadata.get('bbox') or {}
        minimum = bbox.get('min') or [-1, -1]
        maximum = bbox.get('max') or [1, 1]
        self._bounds = (float(minimum[0]), float(minimum[1]), float(maximum[0]), float(maximum[1]))
        self._stack_top = max([
            float(layer.get('nativeTopUm', 0.0)) for layer in self.metadata.get('layers') or []
        ] or [1.0])
        self._build_rect_ranges()
        self._build_lod_ranges()
        self._build_triangle_ranges()
        self._build_outline_layer_indices()
        self.selected_paths = []
        self.selected_pin = None
        self.physical_shape_indices = None
        self.selected_hierarchy_ids = set()
        self._selected_layer_ids = []
        self._connected_layer_ids = []
        self.selected_external_net_keys = []
        self._selected_rects = None
        self._net_rects = None
        self._selected_rect_ranges = {}
        self._net_rect_ranges = {}
        self._selected_outline_indices = None
        self._net_outline_indices = None
        if fit:
            self.fit_layout(remember=False)
        if self.pin_paths is not None:
            self._update_selection()
        if self._gl_ready:
            self._begin_upload()

    def _build_rect_ranges(self):
        layers = self.arrays.get('rect_layers')
        self._rect_ranges = {}
        if layers is None or not len(layers):
            return
        start = 0
        current = int(layers[0])
        for index in range(1, len(layers)):
            value = int(layers[index])
            if value != current:
                self._rect_ranges[current] = (start, index - start)
                start = index
                current = value
        self._rect_ranges[current] = (start, len(layers) - start)

    def _build_lod_ranges(self):
        layers = self.arrays.get('lod_layers')
        self._lod_ranges = {}
        if layers is None or not len(layers):
            return
        start = 0
        current = int(layers[0])
        for index in range(1, len(layers)):
            value = int(layers[index])
            if value != current:
                self._lod_ranges[current] = (start, index - start)
                start = index
                current = value
        self._lod_ranges[current] = (start, len(layers) - start)

    def _build_triangle_ranges(self):
        layers = self.arrays.get('triangle_layers')
        self._triangle_ranges = {}
        if layers is None or not len(layers):
            return
        start = 0
        current = int(layers[0])
        for index in range(1, len(layers)):
            value = int(layers[index])
            if value != current:
                self._triangle_ranges.setdefault(current, []).append((start, index - start))
                start = index
                current = value
        self._triangle_ranges.setdefault(current, []).append((start, len(layers) - start))

    def _build_outline_layer_indices(self):
        import numpy

        layers = self.arrays.get('outline_layers')
        self._outline_layer_indices = {}
        if layers is None or not len(layers):
            return
        for layer_id in numpy.unique(layers):
            value = int(layer_id)
            self._outline_layer_indices[value] = numpy.flatnonzero(layers == layer_id)

    def _ranges_for_layers(self, layers):
        import numpy

        ranges = {}
        if layers is None or not len(layers):
            return ranges
        changes = numpy.flatnonzero(layers[1:] != layers[:-1]) + 1
        starts = numpy.concatenate((numpy.asarray([0], dtype=numpy.int64), changes))
        endings = numpy.concatenate((changes, numpy.asarray([len(layers)], dtype=numpy.int64)))
        for start, ending in zip(starts, endings):
            ranges[int(layers[int(start)])] = (int(start), int(ending - start))
        return ranges

    def _begin_upload(self):
        from OpenGL import GL
        import numpy

        if self._upload_callback:
            try:
                self.after_cancel(self._upload_callback)
            except Exception:
                pass
        rects = self.arrays.get('rects')
        self.tkMakeCurrent()
        GL.glBindBuffer(GL.GL_ARRAY_BUFFER, self._rect_buffer)
        GL.glBufferData(GL.GL_ARRAY_BUFFER, int(rects.nbytes if rects is not None else 0), None, GL.GL_STATIC_DRAW)
        self._upload_source = rects
        self._upload_target = self._rect_buffer
        self._upload_total = len(rects) if rects is not None else 0
        self._upload_index = 0
        self._upload_phase = 'routes'
        self._upload_callback = self.after_idle(self._upload_slice)

    def _upload_slice(self):
        from OpenGL import GL
        import numpy

        started = time.monotonic()
        self.tkMakeCurrent()
        source = self._upload_source
        row_bytes = int(source.dtype.itemsize * source.shape[1]) if source is not None and source.ndim > 1 else 0
        GL.glBindBuffer(GL.GL_ARRAY_BUFFER, self._upload_target)
        while self._upload_index < self._upload_total and time.monotonic() - started < 0.008:
            ending = min(self._upload_total, self._upload_index + 8192)
            chunk = numpy.ascontiguousarray(source[self._upload_index:ending])
            GL.glBufferSubData(GL.GL_ARRAY_BUFFER, self._upload_index * row_bytes, chunk)
            self._upload_index = ending
        if self.upload_progress_callback:
            self.upload_progress_callback(self._upload_phase, self._upload_index, self._upload_total)
        if self._upload_index < self._upload_total:
            self._upload_callback = self.after_idle(self._upload_slice)
            return
        if self._upload_phase == 'routes':
            lod_rects = self.arrays.get('lod_rects')
            GL.glBindBuffer(GL.GL_ARRAY_BUFFER, self._lod_buffer)
            if lod_rects is not None and len(lod_rects):
                GL.glBufferData(GL.GL_ARRAY_BUFFER, numpy.ascontiguousarray(lod_rects), GL.GL_STATIC_DRAW)
            else:
                GL.glBufferData(GL.GL_ARRAY_BUFFER, 0, None, GL.GL_STATIC_DRAW)
            triangles = self.arrays.get('triangle_vertices')
            GL.glBindBuffer(GL.GL_ARRAY_BUFFER, self._triangle_buffer)
            if triangles is not None and len(triangles):
                GL.glBufferData(GL.GL_ARRAY_BUFFER, numpy.ascontiguousarray(triangles), GL.GL_STATIC_DRAW)
            else:
                GL.glBufferData(GL.GL_ARRAY_BUFFER, 0, None, GL.GL_STATIC_DRAW)
            outlines = self.arrays.get('outline_vertices')
            GL.glBindBuffer(GL.GL_ARRAY_BUFFER, self._outline_buffer)
            if outlines is not None and len(outlines):
                GL.glBufferData(GL.GL_ARRAY_BUFFER, numpy.ascontiguousarray(outlines), GL.GL_STATIC_DRAW)
            else:
                GL.glBufferData(GL.GL_ARRAY_BUFFER, 0, None, GL.GL_STATIC_DRAW)
            instances = self.arrays.get('instances')
            count = len(instances) if instances is not None else 0
            expanded = numpy.empty((count, 6), dtype=numpy.float32)
            if count:
                expanded[:, :4] = instances
                expanded[:, 4] = 0.0
                expanded[:, 5] = self._stack_top
            GL.glBindBuffer(GL.GL_ARRAY_BUFFER, self._instance_buffer)
            GL.glBufferData(GL.GL_ARRAY_BUFFER, expanded, GL.GL_STATIC_DRAW)
            self._instance_count = count
        self._upload_callback = None
        self.request_redraw()

    def _focus_bounds(self, bounds, bottom=0.0, top=None, remember=True):
        if bounds is None:
            return False
        previous = self.camera.snapshot()
        width, height = max(1, self.winfo_width()), max(1, self.winfo_height())
        self.camera.fit_bounds(bounds, float(bottom) * 10.0 * self.z_scale,
                               float(self._stack_top if top is None else top) * 10.0 * self.z_scale,
                               float(width) / height)
        if remember and self.camera.snapshot() != previous:
            self.camera.remember_view(previous)
        self._camera_changed()
        self.request_redraw()
        return True

    def fit_layout(self, remember=True):
        bottom = min([float(layer.get('nativeBottomUm', 0))
                      for layer in self.metadata.get('layers') or []] or [0.0])
        return self._focus_bounds(self._bounds, bottom, self._stack_top, remember)

    def fit_pin(self, pin=None):
        pin = pin if pin is not None else self.selected_pin
        if pin is None:
            return False
        bounds = pin_bounds(pin)
        if bounds is None:
            return False
        layer = next((layer for layer in self.metadata.get('layers') or []
                      if str(layer.get('name') or '').upper() == str(pin.get('layer') or '').upper()), {})
        bottom = float(layer.get('nativeBottomUm', 0.0))
        top = float(layer.get('nativeTopUm', bottom))
        # Explicit pin fit includes a small context margin, never changes its mask.
        margin = max(bounds[2] - bounds[0], bounds[3] - bounds[1], 0.001) * 0.6
        return self._focus_bounds((bounds[0] - margin, bounds[1] - margin,
                                   bounds[2] + margin, bounds[3] + margin), bottom, top)

    def _selection_bounds(self, rectangles, outline_indices):
        parts = []
        if rectangles is not None and len(rectangles):
            parts.append((float(rectangles[:, 0].min()), float(rectangles[:, 1].min()),
                          float(rectangles[:, 2].max()), float(rectangles[:, 3].max()),
                          float(rectangles[:, 4].min()), float(rectangles[:, 5].max())))
        vertices, offsets = self.arrays.get('outline_vertices'), self.arrays.get('outline_offsets')
        if vertices is not None and offsets is not None and outline_indices is not None:
            for index in outline_indices:
                points = vertices[int(offsets[index]):int(offsets[index + 1])]
                if len(points):
                    bottom, top = float(points[:, 2].min()), float(points[:, 2].max())
                    outline_layers = self.arrays.get('outline_layers')
                    layers = self.metadata.get('layers') or []
                    if outline_layers is not None and int(outline_layers[index]) < len(layers):
                        layer = layers[int(outline_layers[index])]
                        bottom = min(bottom, float(layer.get('nativeBottomUm', bottom)))
                        top = max(top, float(layer.get('nativeTopUm', top)))
                    parts.append((float(points[:, 0].min()), float(points[:, 1].min()),
                                  float(points[:, 0].max()), float(points[:, 1].max()), bottom, top))
        if not parts:
            return None
        return (min(p[0] for p in parts), min(p[1] for p in parts),
                max(p[2] for p in parts), max(p[3] for p in parts),
                min(p[4] for p in parts), max(p[5] for p in parts))

    def fit_trace(self):
        bounds = self._selection_bounds(self._net_rects, self._net_outline_indices)
        return self._focus_bounds(bounds[:4], bounds[4], bounds[5]) if bounds else False

    def fit_selected_modules(self):
        bounds = self._selection_bounds(self._selected_rects, self._selected_outline_indices)
        if bounds:
            return self._focus_bounds(bounds[:4], bounds[4], bounds[5])
        if not self.selected_paths:
            return False
        if str(self.metadata.get('cell') or '') in self.selected_paths:
            return self.fit_layout()
        parts = []
        for instance in self.metadata.get('instances') or []:
            if instance.get('hierPath') in self.selected_paths:
                bbox = instance.get('bbox') or instance.get('worldBBox') or {}
                lo, hi = bbox.get('min'), bbox.get('max')
                if lo and hi:
                    parts.append((lo[0], lo[1], hi[0], hi[1]))
        if not parts:
            return False
        return self._focus_bounds((min(b[0] for b in parts), min(b[1] for b in parts),
                                   max(b[2] for b in parts), max(b[3] for b in parts)))

    def previous_view(self):
        if not self.camera.previous_view():
            return False
        self._camera_changed()
        self.request_redraw()
        return True

    def orbit_by(self, delta_x, delta_y):
        self.camera.orbit(delta_x, delta_y)
        self._camera_changed()
        self.request_redraw()

    def pan_by(self, delta_x, delta_y):
        self.camera.pan(delta_x, delta_y)
        self._camera_changed()
        self.request_redraw()

    def zoom_by(self, steps):
        self._wheel(steps)

    def layer_color_hex(self, layer_id):
        color = self._layer_color(layer_id)
        return '#%02x%02x%02x' % tuple(int(round(component * 255)) for component in color)

    def set_xray_highlights(self, visible):
        self.xray_highlights = bool(visible)
        self.request_redraw()

    def set_palette(self, name):
        self.palette_name = name
        if name != 'studio':
            self._metal_palette_name = name
        self.request_redraw()

    @property
    def style(self):
        return style_for_palette(self.palette_name)

    def set_style(self, name):
        """'metal' (original look, keeps the last metal palette) or 'studio' (flat and bright)."""
        self.set_palette('studio' if name == 'studio' else self._metal_palette_name)

    def set_pin_scope(self, paths=None):
        """Show pin labels for these hierarchy paths regardless of the module selection (None restores the default)."""
        self.pin_paths = None if paths is None else [str(path) for path in paths]
        self._update_selection()

    def _style(self):
        return STYLES[self.style]

    def _apply_style(self, program):
        from OpenGL import GL

        spec = self._style()
        shade, gain, bias = self._style_locations.get(program, (-1, -1, -1))
        if shade >= 0:
            GL.glUniform2f(shade, spec['shadeBase'], spec['shadeDiffuse'])
        if gain >= 0:
            GL.glUniform3f(gain, *spec['fillGain'])
        if bias >= 0:
            GL.glUniform3f(bias, *spec['fillBias'])

    def _outline_color(self, color):
        gain = self._style()['outlineGain']
        return (color[0] * gain, color[1] * gain, color[2] * gain)

    def _is_connector(self, layer_id):
        layers = self.metadata.get('layers') or []
        layer = layers[layer_id] if 0 <= layer_id < len(layers) else {}
        return (layer.get('nativeSemantic') or layer.get('kind')) in ('via', 'contact')

    def set_theme(self, name):
        self.theme = 'light' if name == 'light' else 'dark'
        self.request_redraw()

    def set_resource_mode(self, mode):
        self.resource_mode = mode if mode in ('low', 'balanced', 'large') else 'balanced'
        self.request_redraw()

    def set_z_scale(self, value):
        self.z_scale = max(0.1, min(4.0, float(value)))
        self.request_redraw()

    def set_wires_visible(self, visible):
        self.wires_visible = bool(visible)
        self.request_redraw()

    def set_instances_visible(self, visible):
        self.instances_visible = bool(visible)
        self.request_redraw()

    def set_all_layers(self, visible):
        layers = self.metadata.get('layers') or []
        for key in list(self.layer_visibility):
            layer = layers[key] if key < len(layers) else {}
            semantic = layer.get('nativeSemantic') or layer.get('kind')
            conductor = semantic in ('poly', 'contact', 'metal', 'via') and layer.get('routing') is not False
            self.layer_visibility[key] = bool(visible and conductor and layer.get('stackSource') != 'unresolved')
        self.request_redraw()

    def set_layer_visibility(self, layer_id, visible):
        self.layer_visibility[int(layer_id)] = bool(visible)
        self.request_redraw()

    def select_hierarchy(self, paths):
        self.selected_paths = [str(path) for path in paths if str(path)]
        self.selected_pin = None
        self.physical_shape_indices = None
        self._update_selection()

    def select_pin(self, pin=None):
        self.selected_pin = pin
        self.physical_shape_indices = None
        self._update_selection()

    def set_physical_trace(self, shape_indices=None):
        self.physical_shape_indices = None if shape_indices is None else set(shape_indices)
        self._update_selection()

    def _update_selection(self):
        import numpy

        self._pin_annotations = pin_annotations(self._annotated_pins(), self.selected_pin)
        selected = hierarchy_ids(self.metadata, self.selected_paths)
        pins = [self.selected_pin] if self.selected_pin is not None else None
        physical = self.physical_shape_indices is not None
        connected = set() if physical else net_ids(self.metadata, self.selected_paths, pins=pins)
        self.selected_external_net_keys = [] if physical else connected_net_keys(self.metadata, self.selected_paths, pins=pins)
        physical_rect_rows, physical_outline_rows = physical_shape_rows(
            self.arrays, self.physical_shape_indices, numpy) if physical else (None, None)
        self.selected_hierarchy_ids = selected
        rects = self.arrays.get('rects')
        hierarchy = self.arrays.get('rect_hierarchy')
        rect_nets = self.arrays.get('rect_nets')
        selected_layer_ids = set()
        connected_layer_ids = set()
        if rects is None or hierarchy is None or not selected:
            self._selected_rects = None
            self._selected_rect_ranges = {}
        else:
            mask = numpy.isin(hierarchy, numpy.asarray(sorted(selected), dtype=hierarchy.dtype))
            self._selected_rects = numpy.ascontiguousarray(rects[mask], dtype=numpy.float32)
            selected_layers = self.arrays.get('rect_layers')[mask]
            self._selected_rect_ranges = self._ranges_for_layers(selected_layers)
            selected_layer_ids.update(int(value) for value in numpy.unique(selected_layers))
        if rects is None or (not physical and (rect_nets is None or not connected)) or (physical and not len(physical_rect_rows)):
            self._net_rects = None
            self._net_rect_ranges = {}
        else:
            net_mask = physical_rect_rows if physical else numpy.isin(rect_nets, numpy.asarray(sorted(connected), dtype=rect_nets.dtype))
            self._net_rects = numpy.ascontiguousarray(rects[net_mask], dtype=numpy.float32)
            net_layers = self.arrays.get('rect_layers')[net_mask]
            self._net_rect_ranges = self._ranges_for_layers(net_layers)
            connected_layer_ids.update(int(value) for value in numpy.unique(net_layers))
        self._selected_outline_indices, self._net_outline_indices = outline_indices(
            self.arrays, selected, connected, numpy)
        if physical:
            self._net_outline_indices = physical_outline_rows
        outline_layers = self.arrays.get('outline_layers')
        if outline_layers is not None:
            if len(self._selected_outline_indices):
                selected_layer_ids.update(
                    int(value) for value in numpy.unique(outline_layers[self._selected_outline_indices]))
            if len(self._net_outline_indices):
                connected_layer_ids.update(
                    int(value) for value in numpy.unique(outline_layers[self._net_outline_indices]))
        layers = self.metadata.get('layers') or []
        priority = lambda layer_id: (
            _metal_number(layers[layer_id]) if layer_id < len(layers) else 0,
            layer_id,
        )
        self._selected_layer_ids = sorted(selected_layer_ids, key=priority, reverse=True)
        self._connected_layer_ids = sorted(connected_layer_ids, key=priority, reverse=True)
        if self._gl_ready:
            from OpenGL import GL
            self.tkMakeCurrent()
            GL.glBindBuffer(GL.GL_ARRAY_BUFFER, self._selected_buffer)
            if self._selected_rects is not None:
                GL.glBufferData(GL.GL_ARRAY_BUFFER, self._selected_rects, GL.GL_DYNAMIC_DRAW)
            else:
                GL.glBufferData(GL.GL_ARRAY_BUFFER, 0, None, GL.GL_DYNAMIC_DRAW)
            GL.glBindBuffer(GL.GL_ARRAY_BUFFER, self._net_buffer)
            if self._net_rects is not None:
                GL.glBufferData(GL.GL_ARRAY_BUFFER, self._net_rects, GL.GL_DYNAMIC_DRAW)
            else:
                GL.glBufferData(GL.GL_ARRAY_BUFFER, 0, None, GL.GL_DYNAMIC_DRAW)
        self.request_redraw()

    def selected_pins(self):
        return selected_pins(self.metadata, self.selected_paths)

    def _annotated_pins(self):
        return selected_pins(self.metadata, self.pin_paths) if self.pin_paths is not None else self.selected_pins()

    def _button_one_press(self, event):
        mode = 'pan' if int(getattr(event, 'state', 0)) & 0x0001 else 'orbit'
        self._button_press(event, mode)

    def _button_press(self, event, mode):
        self.focus_set()
        self.pointer.press(event.x, event.y, mode)
        if self._poll_callback:
            try:
                self.after_cancel(self._poll_callback)
            except Exception:
                pass
            self._poll_callback = None

    def _button_motion(self, event):
        update = self.pointer.move(event.x, event.y)
        if not update.changed:
            return
        if update.entered_fast:
            self.fast_mode = True
        if update.mode == 'pan':
            self.camera.pan(update.delta_x, update.delta_y)
        else:
            self.camera.orbit(update.delta_x, update.delta_y)
        self._camera_changed()
        self.request_redraw()

    def _button_release(self, event):
        self.pointer.release()
        if self.pointer.fast:
            self._schedule_restore_poll()

    def _mouse_wheel(self, event):
        delta = float(getattr(event, 'delta', 0.0))
        self._wheel(delta / 120.0 if delta else 0.0)

    def _wheel(self, steps):
        if not steps:
            return
        update = self.pointer.wheel()
        if update.entered_fast:
            self.fast_mode = True
        self.camera.zoom(steps)
        self._camera_changed()
        self.request_redraw()
        self._schedule_restore_poll()

    def _schedule_restore_poll(self):
        if not self.pointer.fast:
            self._poll_callback = None
            return
        if self._poll_callback:
            try:
                self.after_cancel(self._poll_callback)
            except Exception:
                pass
        self._poll_callback = self.after(16, self._restore_poll)

    def _restore_poll(self):
        update = self.pointer.poll()
        if update.left_fast:
            self.fast_mode = False
            self._poll_callback = None
            self.request_redraw()
            return
        if not self.pointer.fast:
            self._poll_callback = None
            return
        self._poll_callback = self.after(16, self._restore_poll)

    def _camera_changed(self):
        if self.camera_changed_callback:
            self.camera_changed_callback(self.camera)

    def _layer_color(self, layer_id):
        layers = self.metadata.get('layers') or []
        layer = layers[layer_id] if 0 <= layer_id < len(layers) else {}
        return rgb(palette_color(
            self.palette_name, layer.get('name'), layer.get('color') or '#8ecae6', extended=self.extended_palette))

    def _fast_layers(self):
        layers = self.metadata.get('layers') or []
        visible = [
            index for index in set(self._rect_ranges).union(self._outline_layer_indices)
            if self.layer_visibility.get(index, True)
        ]
        metals = sorted(
            [index for index in visible if str(layers[index].get('nativeSemantic')) == 'metal'],
            key=lambda index: (_metal_number(layers[index]), index),
            reverse=True,
        )[:3]
        selected_layers = self._selected_layer_ids + self._connected_layer_ids
        result = list(metals)
        for layer_id in selected_layers:
            if layer_id not in result and self.layer_visibility.get(layer_id, True):
                result.append(layer_id)
            if len(result) >= 6:
                break
        return result or visible[-3:]

    def _set_camera(self):
        from OpenGL import GL, GLU

        width = max(1, int(getattr(self, 'width', self.winfo_width())))
        height = max(1, int(getattr(self, 'height', self.winfo_height())))
        GL.glViewport(0, 0, width, height)
        GL.glMatrixMode(GL.GL_PROJECTION)
        GL.glLoadIdentity()
        near = max(0.00001, self.camera.distance * 0.0002)
        min_x, min_y, max_x, max_y = self._bounds
        center = ((min_x + max_x) * 0.5, self._stack_top * 5.0 * self.z_scale,
                  -(min_y + max_y) * 0.5)
        radius = math.sqrt((max_x - min_x) ** 2 + (max_y - min_y) ** 2
                           + (self._stack_top * 10.0 * self.z_scale) ** 2) * 0.5
        offset = math.sqrt(sum((center[i] - self.camera.target[i]) ** 2 for i in range(3)))
        far = max(near * 100, self.camera.distance + offset + radius * 2.0)
        GLU.gluPerspective(48.0, float(width) / float(height), near, far)
        eye = self.camera.eye()
        target = self.camera.target
        GL.glMatrixMode(GL.GL_MODELVIEW)
        GL.glLoadIdentity()
        GLU.gluLookAt(
            eye[0], eye[1], eye[2], target[0], target[1], target[2], 0.0, 1.0, 0.0)

    def _bind_unit(self, buffer_id, outline):
        from OpenGL import GL

        GL.glBindBuffer(GL.GL_ARRAY_BUFFER, buffer_id)
        GL.glEnableClientState(GL.GL_VERTEX_ARRAY)
        if outline:
            GL.glVertexPointer(3, GL.GL_FLOAT, 12, ctypes.c_void_p(0))
            GL.glDisableClientState(GL.GL_NORMAL_ARRAY)
            GL.glNormal3f(0.0, 1.0, 0.0)
        else:
            GL.glVertexPointer(3, GL.GL_FLOAT, 24, ctypes.c_void_p(0))
            GL.glEnableClientState(GL.GL_NORMAL_ARRAY)
            GL.glNormalPointer(GL.GL_FLOAT, 24, ctypes.c_void_p(12))

    def _draw_instances(self, buffer_id, start, count, color, outline, top_outline=False):
        from OpenGL import GL

        if count <= 0:
            return
        unit_buffer = self._top_edge_buffer if top_outline else (self._edge_buffer if outline else self._cube_buffer)
        vertex_count = 8 if top_outline else (24 if outline else 36)
        primitive = GL.GL_LINES if outline else GL.GL_TRIANGLES
        self._bind_unit(unit_buffer, outline)
        GL.glBindBuffer(GL.GL_ARRAY_BUFFER, buffer_id)
        stride = 24
        GL.glEnableVertexAttribArray(self._rect_location)
        GL.glEnableVertexAttribArray(self._height_location)
        GL.glVertexAttribPointer(self._rect_location, 4, GL.GL_FLOAT, False, stride, ctypes.c_void_p(start * stride))
        GL.glVertexAttribPointer(self._height_location, 2, GL.GL_FLOAT, False, stride, ctypes.c_void_p(start * stride + 16))
        self._attribute_divisor(self._rect_location, 1)
        self._attribute_divisor(self._height_location, 1)
        GL.glUniform3f(self._color_location, color[0], color[1], color[2])
        GL.glUniform1f(self._outline_location, 1.0 if outline else 0.0)
        self._draw_instanced(primitive, 0, vertex_count, count)
        self._attribute_divisor(self._rect_location, 0)
        self._attribute_divisor(self._height_location, 0)
        GL.glDisableVertexAttribArray(self._rect_location)
        GL.glDisableVertexAttribArray(self._height_location)

    def _draw_rect_layers(self, include_routes=True):
        from OpenGL import GL

        layers = (self._fast_layers() if self.fast_mode else sorted(self._rect_ranges)) if include_routes else []
        GL.glUseProgram(self._shader)
        GL.glUniform1f(self._z_location, 10.0 * self.z_scale)
        self._apply_style(self._shader)
        connector_outlines = self._style()['connectorOutlines']
        for layer_id in layers:
            if not self.layer_visibility.get(layer_id, True):
                continue
            use_lod = self._use_lod_for_layer(layer_id)
            ranges = self._lod_ranges if use_lod else self._rect_ranges
            buffer_id = self._lod_buffer if use_lod else self._rect_buffer
            if layer_id not in ranges:
                continue
            start, count = ranges[layer_id]
            color = self._layer_color(layer_id)
            if not self.fast_mode and not use_lod:
                self._draw_instances(buffer_id, start, count, color, False)
            if self.fast_mode or connector_outlines or not self._is_connector(layer_id):
                self._draw_instances(buffer_id, start, count,
                                     color if self.fast_mode else self._outline_color(color), True, True)
        if self.instances_visible:
            self._draw_instances(
                self._instance_buffer, 0, getattr(self, '_instance_count', 0),
                (0.40, 0.50, 0.56), True)
        GL.glUseProgram(0)

    def _draw_highlight_ranges(self, buffer_id, ranges, color, allowed_layers=None):
        for layer_id in sorted(ranges):
            if not self.layer_visibility.get(layer_id, True):
                continue
            if allowed_layers is not None and layer_id not in allowed_layers:
                continue
            start, count = ranges[layer_id]
            layers = self.metadata.get('layers') or []
            layer = layers[layer_id] if layer_id < len(layers) else {}
            connector = (layer.get('nativeSemantic') or layer.get('kind')) in ('via', 'contact')
            # The vertical edges make the selected layer-to-layer transition legible.
            self._draw_instances(buffer_id, start, count, color, True, not connector)

    def _use_lod_for_layer(self, layer_id):
        if self.fast_mode or layer_id not in self._lod_ranges or self.resource_mode == 'large':
            return False
        layers = self.metadata.get('layers') or []
        if layer_id >= len(layers) or layers[layer_id].get('nativeSemantic') not in ('via', 'contact'):
            return False
        source_count = int((self.metadata.get('viaLod') or {}).get('sourceConnectorCount') or 0)
        return self.resource_mode == 'low' or source_count >= 100000

    def _visible_outline_indices(self, indices, fast_layers=None):
        import numpy

        if indices is None or not len(indices):
            return numpy.empty((0,), dtype=numpy.int64)
        layers = self.arrays.get('outline_layers')
        allowed = [
            layer_id for layer_id in self.layer_visibility
            if self.layer_visibility.get(layer_id, True)
            and (fast_layers is None or layer_id in fast_layers)
        ]
        if not allowed:
            return numpy.empty((0,), dtype=numpy.int64)
        values = numpy.asarray(allowed, dtype=layers.dtype)
        return indices[numpy.isin(layers[indices], values)]

    def _draw_outline_indices(self, indices, color, width=1.0):
        from OpenGL import GL
        import numpy

        if indices is None or not len(indices):
            return
        offsets = self.arrays.get('outline_offsets')
        starts = numpy.ascontiguousarray(offsets[indices], dtype=numpy.int32)
        counts = numpy.ascontiguousarray(offsets[indices + 1] - offsets[indices], dtype=numpy.int32)
        GL.glBindBuffer(GL.GL_ARRAY_BUFFER, self._outline_buffer)
        GL.glEnableClientState(GL.GL_VERTEX_ARRAY)
        GL.glVertexPointer(3, GL.GL_FLOAT, 12, ctypes.c_void_p(0))
        GL.glUniform3f(self._polygon_color_location, color[0], color[1], color[2])
        GL.glUniform1f(self._polygon_outline_location, 1.0)
        GL.glLineWidth(width)
        GL.glMultiDrawArrays(GL.GL_LINE_LOOP, starts, counts, len(starts))

    def _draw_polygons(self):
        from OpenGL import GL

        triangles = self.arrays.get('triangle_vertices')
        outline_vertices = self.arrays.get('outline_vertices')
        if ((triangles is None or not len(triangles))
                and (outline_vertices is None or not len(outline_vertices))):
            return
        fast_layers = set(self._fast_layers()) if self.fast_mode else None
        scale = 10.0 * self.z_scale
        GL.glUseProgram(self._polygon_shader)
        GL.glUniform1f(self._polygon_z_location, scale)
        self._apply_style(self._polygon_shader)
        if not self.fast_mode:
            GL.glUniform1f(self._polygon_outline_location, 0.0)
            GL.glBindBuffer(GL.GL_ARRAY_BUFFER, self._triangle_buffer)
            GL.glEnableClientState(GL.GL_VERTEX_ARRAY)
            GL.glVertexPointer(3, GL.GL_FLOAT, 12, ctypes.c_void_p(0))
            for layer_id in sorted(self._triangle_ranges):
                if not self.layer_visibility.get(layer_id, True):
                    continue
                color = self._layer_color(layer_id)
                GL.glUniform3f(self._polygon_color_location, color[0], color[1], color[2])
                for start, count in self._triangle_ranges[layer_id]:
                    GL.glDrawArrays(GL.GL_TRIANGLES, start, count)
        for layer_id in sorted(self._outline_layer_indices):
            if not self.layer_visibility.get(layer_id, True) or (fast_layers is not None and layer_id not in fast_layers):
                continue
            if not self.fast_mode and not self._style()['connectorOutlines'] and self._is_connector(layer_id):
                continue
            color = self._layer_color(layer_id)
            self._draw_outline_indices(self._outline_layer_indices[layer_id],
                                       color if self.fast_mode else self._outline_color(color))
        GL.glLineWidth(1.0)
        GL.glUseProgram(0)

    def _draw_selection_overlays(self):
        from OpenGL import GL

        fast_layers = set(self._fast_layers()) if self.fast_mode else None
        selected = self._visible_outline_indices(self._selected_outline_indices, fast_layers)
        connected = self._visible_outline_indices(self._net_outline_indices, fast_layers)
        GL.glPushAttrib(GL.GL_ENABLE_BIT | GL.GL_LINE_BIT | GL.GL_DEPTH_BUFFER_BIT)
        GL.glEnable(GL.GL_DEPTH_TEST)
        GL.glDepthMask(GL.GL_FALSE)

        def draw(buffer_id, ranges, indices, color, width, pattern):
            if pattern is None:
                GL.glDisable(GL.GL_LINE_STIPPLE)
            else:
                GL.glEnable(GL.GL_LINE_STIPPLE)
                GL.glLineStipple(1, pattern)
            GL.glLineWidth(width)
            GL.glUseProgram(self._shader)
            GL.glUniform1f(self._z_location, 10.0 * self.z_scale)
            self._draw_highlight_ranges(buffer_id, ranges, color, fast_layers)
            GL.glUseProgram(self._polygon_shader)
            GL.glUniform1f(self._polygon_z_location, 10.0 * self.z_scale)
            self._draw_outline_indices(indices, color, width)

        try:
            # Hidden segments remain available, but look different from surface routes.
            if self.xray_highlights:
                GL.glDepthFunc(GL.GL_GREATER)
                draw(self._selected_buffer, self._selected_rect_ranges, selected,
                     (0.22, 0.44, 0.42), 1.0, 0x1111)
                draw(self._net_buffer, self._net_rect_ranges, connected,
                     (0.68, 0.49, 0.20), 1.5, 0x0F0F)
            GL.glDepthFunc(GL.GL_LEQUAL)
            draw(self._selected_buffer, self._selected_rect_ranges, selected,
                 (0.35, 0.93, 0.82), 1.2, 0x3333)
            draw(self._net_buffer, self._net_rect_ranges, connected,
                 (1.0, 0.78, 0.28), 3.0, None)
        finally:
            GL.glUseProgram(0)
            GL.glPopAttrib()

    def _draw_grid_and_axes(self):
        from OpenGL import GL

        min_x, min_y, max_x, max_y = self._bounds
        span = max(max_x - min_x, max_y - min_y, 2.0)
        raw_step = span / 12.0
        magnitude = 10 ** math.floor(math.log10(max(raw_step, 0.001)))
        normalized = raw_step / magnitude
        multiple = 1 if normalized < 1.5 else (2 if normalized < 3.0 else (5 if normalized < 7.0 else 10))
        step = magnitude * multiple
        first_x = math.floor(min_x / step) * step
        first_y = math.floor(min_y / step) * step
        grid = (0.18, 0.21, 0.22) if self.theme == 'dark' else (0.72, 0.72, 0.70)
        GL.glColor3f(*grid)
        GL.glBegin(GL.GL_LINES)
        value = first_x
        while value <= max_x + step:
            GL.glVertex3f(value, 0.0, -min_y)
            GL.glVertex3f(value, 0.0, -max_y)
            value += step
        value = first_y
        while value <= max_y + step:
            GL.glVertex3f(min_x, 0.0, -value)
            GL.glVertex3f(max_x, 0.0, -value)
            value += step
        GL.glEnd()
        axis_length = span * 0.08
        origin = (min_x, 0.0, -min_y)
        GL.glLineWidth(2.0)
        GL.glBegin(GL.GL_LINES)
        for name in ('x', 'y', 'z'):
            vector = LAYOUT_AXIS_VECTORS[name]
            GL.glColor3f(*AXIS_COLORS[name])
            GL.glVertex3f(*origin)
            GL.glVertex3f(
                origin[0] + vector[0] * axis_length,
                origin[1] + vector[1] * axis_length,
                origin[2] + vector[2] * axis_length,
            )
        GL.glEnd()
        GL.glLineWidth(1.0)

    def _pin_layer_height(self, pin):
        name = str(pin.get('layer') or '').upper()
        for layer in self.metadata.get('layers') or []:
            if str(layer.get('name') or '').upper() == name:
                return float(layer.get('nativeTopUm', self._stack_top)) * 10.0 * self.z_scale
        return self._stack_top * 10.0 * self.z_scale

    def _clear_pin_labels(self):
        for entry in getattr(self, '_pin_label_widgets', {}).values():
            try:
                entry['frame'].destroy()
            except Exception:
                pass
        self._pin_label_widgets = {}
        self._pin_label_layout = []

    def _pin_label_click(self, source_index):
        if source_index >= len(self._pin_annotations):
            return
        pin = self._pin_annotations[source_index]['source']
        self.focus_set()
        if self.pin_selected_callback:
            self.pin_selected_callback(pin)
        else:
            self.select_pin(pin)

    def _fit_pin_label(self, source_index):
        entry = self._pin_label_widgets.get(source_index)
        return self.fit_pin(entry['source']) if entry else False

    def _prepare_pin_labels(self, width, height):
        import tkinter as tk
        from tkinter import font as tkfont

        if self._pin_label_fonts is None:
            self._pin_label_fonts = (
                tkfont.Font(root=self, size=12, weight='bold'),
                tkfont.Font(root=self, size=10),
            )
        name_font, detail_font = self._pin_label_fonts
        candidates = []
        annotations = sorted(self._pin_annotations,
                             key=lambda item: (not item['active'], item['sourceIndex']))
        dark = self.theme == 'dark'
        background = '#202522' if dark else '#fafaf4'
        foreground = '#F2F5F3' if dark else '#182025'
        for annotation in annotations:
            bounds = annotation['bounds']
            if bounds is None:
                continue
            center = ((bounds[0] + bounds[2]) * 0.5,
                      self._pin_layer_height(annotation['source']),
                      -(bounds[1] + bounds[3]) * 0.5)
            projected = self.camera.project(center, width, height)
            if projected is None:
                if not annotation['active']:
                    continue
                projected = (width * 0.5, height + 30, -1)
            if not annotation['active'] and not (0 <= projected[0] <= width and 0 <= projected[1] <= height):
                continue
            index = annotation['sourceIndex']
            entry = self._pin_label_widgets.get(index)
            if entry is None:
                frame = tk.Frame(self, borderwidth=0, highlightthickness=2, takefocus=0)
                name = tk.Label(frame, font=name_font, anchor='w', justify='left', borderwidth=0, padx=8, pady=3)
                detail = tk.Label(frame, font=detail_font, anchor='w', justify='left', borderwidth=0, padx=8, pady=3)
                name.pack(fill='x')
                detail.pack(fill='x')
                entry = {'frame': frame, 'name': name, 'detail': detail, 'source': annotation['source']}
                self._pin_label_widgets[index] = entry
                for widget in (frame, name, detail):
                    widget.bind('<Button-1>', lambda event, value=index: self._pin_label_click(value))
                    widget.bind('<Double-Button-1>', lambda event, value=index: self._fit_pin_label(value))
                    widget.bind('<Button-4>', lambda event: self._wheel(1.0))
                    widget.bind('<Button-5>', lambda event: self._wheel(-1.0))
                    widget.bind('<MouseWheel>', self._mouse_wheel)
            entry['source'] = annotation['source']
            # The source name is the entire name row; figure identity is separate.
            name_text = annotation['name'] or '(unnamed pin)'
            if self.compact_pin_labels:
                detail_text = annotation['layer']
            else:
                detail_text = '%s | figure %d/%d' % (annotation['layer'], annotation['figureNumber'], annotation['figureCount'])
                if annotation['path']:
                    detail_text += ' | ' + annotation['path'].rsplit('/', 1)[-1]
            if annotation['active']:
                detail_text = 'CURRENT | ' + detail_text
            if not (0 <= projected[0] <= width and 0 <= projected[1] <= height):
                detail_text = 'OFFSCREEN | ' + detail_text
            wrap = max(24, min(280, width - 30))
            name_lines = max(1, int(math.ceil(name_font.measure(name_text) / float(wrap))))
            detail_lines = max(1, int(math.ceil(detail_font.measure(detail_text) / float(wrap))))
            measured_width = min(wrap, max(name_font.measure(name_text), detail_font.measure(detail_text))) + 20
            measured_height = name_lines * name_font.metrics('linespace') + detail_lines * detail_font.metrics('linespace') + 16
            border = '#EC5AA5' if annotation['active'] else ('#8C978F' if dark else '#82764a')
            entry['frame'].configure(background=background, highlightbackground=border, highlightcolor=border)
            entry['name'].configure(text=name_text, background=background, foreground=foreground, wraplength=wrap)
            entry['detail'].configure(text=detail_text, background=background,
                                      foreground='#B4BEB7' if dark else '#465258', wraplength=wrap)
            candidate = dict(annotation)
            candidate.update({'anchor': projected, 'size': (measured_width, measured_height)})
            candidates.append(candidate)
            if len(candidates) >= PIN_LABEL_LIMIT:
                break
        labels = place_labels(candidates, width, height, PIN_LABEL_LIMIT)
        visible = set(label['sourceIndex'] for label in labels)
        for index, entry in list(self._pin_label_widgets.items()):
            if index not in visible:
                entry['frame'].place_forget()
            if index >= len(self._pin_annotations) or index not in set(a['sourceIndex'] for a in candidates):
                entry['frame'].destroy()
                del self._pin_label_widgets[index]
        for label in labels:
            left, top, right, bottom = label['box']
            widget = self._pin_label_widgets[label['sourceIndex']]['frame']
            widget.place(x=int(left), y=int(top), width=int(right - left), height=int(bottom - top))
            widget.lift()
        self._pin_label_layout = labels
        return labels

    def _draw_pin_callouts(self, labels, width, height):
        from OpenGL import GL

        dark = self.theme == 'dark'
        GL.glPushAttrib(GL.GL_ENABLE_BIT | GL.GL_CURRENT_BIT | GL.GL_LINE_BIT | GL.GL_DEPTH_BUFFER_BIT)
        GL.glDisable(GL.GL_DEPTH_TEST)
        GL.glDisable(GL.GL_LINE_STIPPLE)
        GL.glDepthMask(GL.GL_FALSE)
        GL.glMatrixMode(GL.GL_PROJECTION)
        GL.glPushMatrix()
        GL.glLoadIdentity()
        GL.glOrtho(0, width, height, 0, -1, 1)
        GL.glMatrixMode(GL.GL_MODELVIEW)
        GL.glPushMatrix()
        GL.glLoadIdentity()
        try:
            for label in labels:
                x, y = label['screenAnchor']
                left, top, right, bottom = label['box']
                endpoint = (min(max(x, left), right), min(max(y, top), bottom))
                # A dark/light halo and shape difference preserve meaning without color.
                for halo in (True, False):
                    GL.glLineWidth((4.0 if label['active'] else 3.0) if halo else 1.3)
                    if halo:
                        GL.glColor3f(*( (0.02, 0.025, 0.03) if dark else (1.0, 1.0, 1.0) ))
                    elif label['active']:
                        GL.glColor3f(*( (1.0, 1.0, 1.0) if dark else (0.05, 0.08, 0.1) ))
                    else:
                        GL.glColor3f(*( (0.90, 0.82, 0.52) if dark else (0.40, 0.31, 0.08) ))
                    GL.glBegin(GL.GL_LINES)
                    GL.glVertex2f(x, y)
                    GL.glVertex2f(endpoint[0], endpoint[1])
                    GL.glEnd()
                    GL.glBegin(GL.GL_LINE_LOOP)
                    if label['active']:
                        for step in range(24):
                            angle = step * math.pi / 12
                            GL.glVertex2f(x + 8 * math.cos(angle), y + 8 * math.sin(angle))
                    else:
                        for dx, dy in ((0, -4), (4, 0), (0, 4), (-4, 0)):
                            GL.glVertex2f(x + dx, y + dy)
                    GL.glEnd()
        finally:
            GL.glPopMatrix()
            GL.glMatrixMode(GL.GL_PROJECTION)
            GL.glPopMatrix()
            GL.glMatrixMode(GL.GL_MODELVIEW)
            GL.glPopAttrib()

    def _draw_pins(self):
        from OpenGL import GL

        if not self._pin_annotations:
            for entry in self._pin_label_widgets.values():
                entry['frame'].place_forget()
            self._pin_label_layout = []
            return
        GL.glPushAttrib(GL.GL_ENABLE_BIT | GL.GL_CURRENT_BIT | GL.GL_LINE_BIT | GL.GL_DEPTH_BUFFER_BIT)
        GL.glDisable(GL.GL_DEPTH_TEST)
        GL.glDisable(GL.GL_LINE_STIPPLE)
        GL.glDepthMask(GL.GL_FALSE)
        try:
            for annotation in self._pin_annotations:
                height = self._pin_layer_height(annotation['source'])
                GL.glLineWidth(2.5 if annotation['active'] else 1.2)
                active_color = (1.0, 1.0, 1.0) if self.theme == 'dark' else (0.05, 0.08, 0.1)
                pin_color = self._style()['pin'][self.theme]
                GL.glColor3f(*(active_color if annotation['active'] else pin_color))
                # Draw the actual source boundary at its layer, with no size inflation.
                for ring in annotation['rings']:
                    GL.glBegin(GL.GL_LINE_LOOP)
                    for x, y in ring:
                        GL.glVertex3f(x, height, -y)
                    GL.glEnd()
        finally:
            GL.glPopAttrib()
        width, height = max(1, self.winfo_width()), max(1, self.winfo_height())
        labels = self._prepare_pin_labels(width, height)
        self._draw_pin_callouts(labels, width, height)

    def capture_rgb(self):
        """Render the current scene off-screen and return (width, height, rgb_bytes_top_down)."""
        from OpenGL import GL

        width, height = max(1, int(self.winfo_width())), max(1, int(self.winfo_height()))
        self.tkMakeCurrent()
        GL.glViewport(0, 0, width, height)
        self.redraw()
        GL.glFinish()
        GL.glReadBuffer(GL.GL_BACK)
        GL.glPixelStorei(GL.GL_PACK_ALIGNMENT, 1)
        data = GL.glReadPixels(0, 0, width, height, GL.GL_RGB, GL.GL_UNSIGNED_BYTE)
        if not isinstance(data, (bytes, bytearray)):
            data = data.tobytes() if hasattr(data, 'tobytes') else bytes(data)
        stride = width * 3
        rows = [data[row * stride:(row + 1) * stride] for row in range(height - 1, -1, -1)]
        return width, height, b''.join(rows)

    def redraw(self):
        from OpenGL import GL

        if not self._gl_ready:
            return

        background = tuple(self._style()['background'][self.theme]) + (1.0,)
        GL.glClearColor(*background)
        GL.glClear(GL.GL_COLOR_BUFFER_BIT | GL.GL_DEPTH_BUFFER_BIT)
        self._set_camera()
        self._draw_grid_and_axes()
        if self.compiled is None or self._upload_callback is not None:
            return
        self._draw_rect_layers(include_routes=self.wires_visible)
        if self.wires_visible:
            self._draw_polygons()
            self._draw_selection_overlays()
        self._draw_pins()
