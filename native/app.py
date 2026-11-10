from __future__ import absolute_import

import argparse
import json
import math
import os
import queue
import sys
import shutil
import struct
import subprocess
import threading
import zlib

from .backend import BackendClient, LibraryChoiceRequired, TopCellChoiceRequired
from .cache import CacheManager
from .config import AdvancedSettings, apply_advanced_settings, load_config, save_config
from . import fieldwork_tk as fw
from .errors import Vl3dError
from .gl_view import (
    AXIS_COLORS, LAYOUT_AXIS_VECTORS, PIN_LABEL_LIMIT,
    LayoutGLView, dependency_error, pin_number,
)
from .palettes import PALETTES
from .selection import hierarchy_tree_rows


PALETTE_LABELS = {
    'Classic Dark Metal': 'classic-dark-metal',
    'Cyberpunk': 'cyberpunk',
    'Aurora': 'aurora',
    'Plasma': 'plasma',
    'Titanium': 'titanium',
}


def approximate_stack_note(metadata):
    """Display provenance only; never change source coordinates or layer geometry."""
    metadata = metadata or {}
    technology = metadata.get('technology')
    technology = technology if isinstance(technology, dict) else {}
    notes = []
    if technology.get('approximateLayers') or any(
            layer.get('routing') is not False and layer.get('geometryApproximate') is True
            for layer in metadata.get('layers') or []):
        notes.append('Z heights/thicknesses are approximate; XY dimensions match the original layout.')
    unresolved = technology.get('unresolvedStackLayers') or []
    if unresolved:
        notes.append('Layer position unconfirmed (hidden by default): %s.' % ', '.join(map(str, unresolved)))
    return '\n'.join(notes)


def _read_fd_line(file_descriptor):
    chunks = []
    total = 0
    try:
        while total <= 65536:
            chunk = os.read(file_descriptor, min(4096, 65537 - total))
            if not chunk or b'\n' in chunk:
                chunks.append(chunk.split(b'\n', 1)[0])
                break
            chunks.append(chunk)
            total += len(chunk)
    finally:
        os.close(file_descriptor)
    value = b''.join(chunks)
    if len(value) > 65536:
        raise Vl3dError('E8009', 'Native backend bootstrap exceeds 64 KiB')
    return value.decode('utf-8', 'strict').strip()


def read_bootstrap(options, input_stream=None):
    backend_url = str(options.backend_url or '').strip()
    token = ''
    config_file = str(options.config or '').strip()
    advanced_settings = {}
    if options.backend_stdin:
        stream = input_stream or sys.stdin
        line = stream.readline(65537)
        try:
            stream.close()
        except Exception:
            pass
        if len(line) > 65536:
            raise Vl3dError('E8009', 'Native backend bootstrap exceeds 64 KiB')
        try:
            payload = json.loads(line)
        except ValueError as error:
            raise Vl3dError('E8009', 'Cannot decode native backend bootstrap: %s' % error)
        if not isinstance(payload, dict):
            raise Vl3dError('E8009', 'Native backend bootstrap must be a JSON object')
        backend_url = str(payload.get('backendUrl') or backend_url).strip()
        token = str(payload.get('token') or '')
        config_file = str(payload.get('configFile') or config_file).strip()
        advanced_settings = payload.get('advancedSettings', {})
        if advanced_settings is None:
            advanced_settings = {}
        if not isinstance(advanced_settings, dict):
            raise Vl3dError('E8009', 'Native advanced bootstrap settings must be a JSON object')
    elif options.backend_token_stdin_fd is not None:
        token = _read_fd_line(options.backend_token_stdin_fd)
    if not backend_url:
        raise Vl3dError('E8009', 'Native backend URL was not supplied by the launcher')
    return {
        'backendUrl': backend_url,
        'token': token,
        'configFile': config_file,
        'advancedSettings': advanced_settings,
    }


def argument_parser():
    parser = argparse.ArgumentParser(prog='python -m native.app')
    parser.add_argument('--root', default=os.path.realpath(os.path.join(os.path.dirname(__file__), os.pardir)))
    parser.add_argument('--config', default='')
    parser.add_argument('--backend-stdin', action='store_true')
    parser.add_argument('--backend-url', default='')
    parser.add_argument('--backend-token-stdin-fd', type=int, default=None)
    return parser


TRACE_REASONS = {
    'legacy_pathseg_bbox': 'This older OA export contains ambiguous path segments. Refresh the OA layout or re-export it before physical tracing.',
    'no_pin_selected': 'Select a pin first.',
    'pin_does_not_touch_indexed_conductor': 'The pin does not contact a supported conductor in this scope.',
    'unmatched_pin_figures': 'Some pin figures could not be connected to a supported conductor.',
    'disconnected_pin_components': 'The selected pin figures belong to separate physical components; they were not joined.',
    'scope_boundary': 'Connected geometry continues outside the selected module. Use Whole layout to continue.',
    'point_only_contacts': 'Point-only contacts were excluded; inspect these contacts before treating the trace as complete.',
    'incomplete_rules': 'Some connector or device rules are unavailable. See the trace details.',
    'incomplete_export': 'The imported layout is partial; re-export the complete hierarchy.',
    'unsupported_geometry': 'Some shapes could not be evaluated without changing their geometry.',
    'cancelled_by_user': 'The trace was canceled.',
    'maxSeconds': 'The time limit was reached. Use a smaller layout or reduce the trace scope.',
    'maxMemoryMiB': 'The index memory limit was reached. Load a smaller layout or export fewer hierarchy levels.',
    'maxShapes': 'The input shape limit was reached. Load a smaller layout or export fewer hierarchy levels.',
    'maxVertices': 'The input geometry limit was reached. Load a smaller layout or export fewer hierarchy levels.',
    'maxIndexCells': 'The spatial index limit was reached. Load a smaller layout or export fewer hierarchy levels.',
    'maxCandidates': 'The contact search limit was reached. Trace a smaller module.',
    'maxGeometryChecks': 'The geometry check limit was reached. Trace a smaller module.',
    'maxResults': 'The result size limit was reached. Trace a smaller module.',
}


def encode_png(width, height, rgb):
    """Encode top-down 8-bit RGB bytes as a PNG without third-party imaging packages."""
    stride = width * 3
    raw = b''.join(b'\x00' + rgb[row * stride:(row + 1) * stride] for row in range(height))

    def chunk(kind, payload):
        body = kind + payload
        return struct.pack('>I', len(payload)) + body + struct.pack('>I', zlib.crc32(body) & 0xffffffff)

    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b''))


CLIPBOARD_COMMANDS = (
    ('wl-copy', ['wl-copy', '--type', 'image/png']),
    ('xclip', ['xclip', '-selection', 'clipboard', '-t', 'image/png', '-i']),
)


def trace_warning_text(warning):
    if not isinstance(warning, dict):
        return TRACE_REASONS.get(str(warning), str(warning))
    code = str(warning.get('code') or '')
    message = str(warning.get('message') or TRACE_REASONS.get(code, code))
    if warning.get('layer'):
        message = str(warning['layer']) + ': ' + message
    if code == 'trace-stop-layer-semantics-unconfirmed':
        message += ' Current viewer coverage stops at device pins. Refresh cannot supply undeclared extraction rules; compare within this routing scope.'
    elif code.startswith('trace-connector-'):
        message += ' In Load setup, provide a profile/layer map with explicit VIA/CT endpoints, or refresh an older OA export.'
    elif code == 'trace-device-metadata-missing':
        message += ' Refresh old OA data. For geometry-only files, supply verified device metadata before expecting complete circuit coverage.'
    return message


def physical_trace_summary(result):
    result = result or {}
    status = str(result.get('status') or 'limited')
    count = len(result.get('shapeIndices') or [])
    labels = {'complete': 'Complete within the requested scope', 'cancelled': 'Trace canceled',
              'limited': 'Incomplete trace', 'no_seed': 'No conductor touches the selected pin',
              'ambiguous_seed': 'Pin touches separate conductive components'}
    label = labels.get(status, 'Incomplete trace')
    if not result.get('complete') and status == 'complete':
        label = 'Incomplete trace'
    message = '%s; %d shapes.' % (label, count)
    if result.get('seedComponentCount', 0) > 1:
        message += ' %d separate components.' % result['seedComponentCount']
    if result.get('reason'):
        reason = str(result['reason'])
        message += ' ' + ({'incomplete_rules': 'Rules limit coverage; see details.',
                          'scope_boundary': 'Continues outside this scope.',
                          'disconnected_pin_components': 'Figures stay separate.'}.get(reason, 'See details for the next step.'))
    return message


class AdvancedDialog(object):
    def __init__(self, parent, settings, tkinter, ttk, filedialog):
        self.parent = parent
        self.settings = settings
        self.tk = tkinter
        self.ttk = ttk
        self.filedialog = filedialog
        self.result = None
        self.window = tkinter.Toplevel(parent)
        self.window.title('VL3D — Optional settings')
        self.window.transient(parent)
        self.window.resizable(True, False)
        self.variables = {
            'library_name': tkinter.StringVar(value=settings.library_name),
            'cds_lib': tkinter.StringVar(value=settings.cds_lib),
            'cadence_env': tkinter.StringVar(value=settings.cadence_env),
            'views': tkinter.StringVar(value=', '.join(settings.views)),
            'pdk_profile': tkinter.StringVar(value=settings.pdk_profile),
            'pdk_profile_dirs': tkinter.StringVar(value=os.pathsep.join(settings.pdk_profile_dirs)),
            'stream_layer_map': tkinter.StringVar(value=settings.stream_layer_map),
            'resource_mode': tkinter.StringVar(value=settings.resource_mode),
            'strict_symlinks': tkinter.BooleanVar(value=settings.strict_symlinks),
        }
        frame = ttk.Frame(self.window, padding=12)
        frame.grid(row=0, column=0, sticky='nsew')
        frame.columnconfigure(1, weight=1)
        rows = [
            ('Library name override', 'library_name', None),
            ('OA views to search', 'views', None),
            ('Extra profile search dirs', 'pdk_profile_dirs', 'directory'),
        ]
        for row, (label, name, picker) in enumerate(rows):
            ttk.Label(frame, text=label).grid(row=row, column=0, sticky='w', padx=(0, 8), pady=4)
            ttk.Entry(frame, textvariable=self.variables[name], width=58).grid(row=row, column=1, sticky='ew', pady=4)
            if picker:
                ttk.Button(
                    frame, text='Browse', width=8,
                    command=lambda key=name, mode=picker: self._pick(key, mode),
                ).grid(row=row, column=2, padx=(8, 0), pady=4)
        row = len(rows)
        ttk.Label(frame, text='Resource mode').grid(row=row, column=0, sticky='w', padx=(0, 8), pady=4)
        ttk.Combobox(
            frame, textvariable=self.variables['resource_mode'], state='readonly',
            values=('low', 'balanced', 'large'), width=16,
        ).grid(row=row, column=1, sticky='w', pady=4)
        row += 1
        ttk.Checkbutton(
            frame, text='Strict symlink and source-change checks',
            variable=self.variables['strict_symlinks'],
        ).grid(row=row, column=0, columnspan=3, sticky='w', pady=5)
        row += 1
        ttk.Label(
            frame,
            text='All settings here are optional. Library name: override an ambiguous library identity.\n'
                 'Views: change which OA views are listed. Profile dirs: additional automatic search locations.\n'
                 'Resource mode: geometry/depth budget. Strict checks: detect changed or redirected sources.\n'
                 'Required source, Cadence and layer-map inputs are in Load setup.',
            style='Muted.TLabel',
        ).grid(row=row, column=0, columnspan=3, sticky='w', pady=(4, 10))
        row += 1
        buttons = ttk.Frame(frame)
        buttons.grid(row=row, column=0, columnspan=3, sticky='e')
        ttk.Button(buttons, text='Cancel', command=self.window.destroy).pack(side='right', padx=(8, 0))
        ttk.Button(buttons, text='Apply', command=self._apply).pack(side='right')
        self.window.protocol('WM_DELETE_WINDOW', self.window.destroy)

    def _pick(self, name, mode):
        current = self.variables[name].get()
        if mode == 'directory':
            value = self.filedialog.askdirectory(parent=self.window, initialdir=current or os.path.expanduser('~'))
        else:
            value = self.filedialog.askopenfilename(parent=self.window, initialdir=os.path.dirname(current) if current else os.path.expanduser('~'))
        if value:
            self.variables[name].set(value)

    def _apply(self):
        views = [item.strip() for item in self.variables['views'].get().split(',') if item.strip()]
        directories = [item.strip() for item in self.variables['pdk_profile_dirs'].get().split(os.pathsep) if item.strip()]
        self.result = AdvancedSettings(
            library_name=self.variables['library_name'].get(),
            cds_lib=self.variables['cds_lib'].get(),
            cadence_env=self.variables['cadence_env'].get(),
            views=views,
            pdk_profile=self.variables['pdk_profile'].get(),
            pdk_profile_dirs=directories,
            stream_layer_map=self.variables['stream_layer_map'].get(),
            strict_symlinks=self.variables['strict_symlinks'].get(),
            resource_mode=self.variables['resource_mode'].get(),
        )
        self.window.destroy()

    def show(self):
        self.window.grab_set()
        self.parent.wait_window(self.window)
        return self.result


class NativeApplication(object):
    def __init__(self, root, project_root, backend, config, tkinter, ttk,
                 filedialog, messagebox, simpledialog):
        self.root = root
        self.project_root = project_root
        self.backend = backend
        self.config = config
        self.tk = tkinter
        self.ttk = ttk
        self.filedialog = filedialog
        self.messagebox = messagebox
        self.simpledialog = simpledialog
        self.cache = CacheManager(maximum_mib=config.cache_mib, project_root=project_root)
        self.session = None
        self.records = []
        self.record_labels = {}
        self.compiled = None
        self.compile_job = None
        self.closed = False
        self.busy = False
        self._load_generation = 0
        self.active_operation = ''
        self._pending_clear_library = False
        self.cancel_event = threading.Event()
        self.hierarchy_item_paths = {}
        self.pin_item_records = {}
        self._pin_list_generation = 0
        self.trace_generation = 0
        self.trace_cancel_event = None
        self.trace_operation = None
        self.trace_result = None
        self.layer_variables = []
        self.config_dirty = False
        self._status_state = 'idle'
        self._configure_style()
        self._build_ui()
        self.root.protocol('WM_DELETE_WINDOW', self.close)
        self.root.after(50, self._check_backend)

    def _configure_style(self):
        self.root.title('Layout 3D Viewer')
        self.root.geometry('1440x900')
        self.root.minsize(1000, 700)
        try:
            fw.apply(self.root, product='layout')
        except self.tk.TclError:
            pass
        style = self.ttk.Style(self.root)
        style.configure('Muted.TLabel', background=fw.PANEL, foreground=fw.DIM)
        style.configure('Heading.TLabel', background=fw.PANEL, foreground=fw.DIM, font=self.root.fw_fonts['h2'])
        style.configure('Section.TLabel', background=fw.PANEL, foreground=fw.DIM, font=self.root.fw_fonts['h2'])

    def _build_ui(self):
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(3, weight=1)
        self.source_value = self.tk.StringVar(value='No layout loaded')
        header_actions = {}

        def header_right(box):
            header_actions['file'] = self.ttk.Button(box, text='Open file', command=self.open_file)
            header_actions['file'].pack(side='left', padx=(0, 8))
            header_actions['oa'] = self.ttk.Button(box, text='OA library', command=self.load_library)
            header_actions['oa'].pack(side='left', padx=(0, 8))
            header_actions['example'] = self.ttk.Button(box, text='Load example', command=self.open_example)
            header_actions['example'].pack(side='left', padx=(0, 8))
            self.ttk.Button(box, text='Load setup', style='Ghost.TButton', command=self._toggle_load_setup).pack(side='left')
            header_actions['advanced'] = self.ttk.Button(box, text='Advanced', style='Ghost.TButton', command=self.open_advanced)
            header_actions['advanced'].pack(side='left')

        self.header = fw.header(self.root, 'Layout 3D Viewer', 'Hierarchy-aware 3D layout explorer', right=header_right)
        self.header.grid(row=0, column=0, sticky='ew')
        self.file_button = header_actions['file']
        self.load_button = header_actions['oa']
        self.example_button = header_actions['example']
        self.advanced_button = header_actions['advanced']
        toolbar = self.ttk.Frame(self.root, style='Panel.TFrame', padding=(16, 8))
        toolbar.grid(row=1, column=0, sticky='ew')
        views = self.ttk.Frame(toolbar, style='Panel.TFrame')
        views.pack(fill='x')
        for text, method, style in [('Fit all', 'fit_layout', 'Primary.TButton'), ('Module', 'fit_selected_modules', 'TButton'),
                                    ('Locate pin', 'fit_pin', 'TButton'), ('Fit routes', 'fit_trace', 'TButton'),
                                    ('Back', 'previous_view', 'Ghost.TButton')]:
            self.ttk.Button(views, text=text, style=style,
                command=lambda name=method: self._view_action(name)).pack(side='left', padx=(0, 4))
        self.ttk.Button(views, text='Explorer', style='Ghost.TButton', command=lambda: self._toggle_dock('left')).pack(side='left', padx=(12, 0))
        self.ttk.Button(views, text='Pins', style='Ghost.TButton', command=lambda: self._toggle_dock('right')).pack(side='left')
        self.z_value = self.tk.DoubleVar(value=self.config.z_scale)
        self.z_label = self.ttk.Label(views, text='Z %.1f×' % (10*self.config.z_scale), style='Panel.TLabel')
        self.z_label.pack(side='left', padx=(16, 8))
        self.z_slider = self.ttk.Scale(views, from_=0.1, to=4.0, variable=self.z_value, command=self._z_changed, length=100)
        self.z_slider.pack(side='left')
        self.ttk.Button(views, text='Z 1×', style='Ghost.TButton', command=self._physical_z_scale).pack(side='left', padx=4)
        self.save_shot_button = self.ttk.Button(views, text='Save screenshot', command=self.save_screenshot)
        self.copy_shot_button = self.ttk.Button(views, text='Copy screenshot', command=self.copy_screenshot)
        self.copy_shot_button.pack(side='right')
        self.save_shot_button.pack(side='right', padx=(0, 8))
        self._build_load_setup()
        self.workspace = self.ttk.Frame(self.root)
        self.workspace.grid_propagate(False)
        self.workspace.columnconfigure(1, weight=1)
        self.workspace.rowconfigure(0, weight=1)
        self.workspace.grid(row=3, column=0, sticky='nsew')
        self.left_panel = self.ttk.Frame(self.workspace, style='Panel.TFrame', padding=16, width=264)
        self.center_panel = self.ttk.Frame(self.workspace, padding=0, width=420)
        self.center_panel.pack_propagate(False)
        self.right_panel = self.ttk.Frame(self.workspace, style='Panel.TFrame', padding=16, width=296)
        self.left_panel.pack_propagate(False)
        self.right_panel.pack_propagate(False)
        self.dock_visible = {'left': True, 'right': True}
        self.narrow_dock = 'left'
        self._last_width = 0
        self.left_panel.grid(row=0, column=0, sticky='nsew')
        self.center_panel.grid(row=0, column=1, sticky='nsew')
        self.right_panel.grid(row=0, column=2, sticky='nsew')
        self._build_left(self.left_panel)
        self.view = LayoutGLView(self.center_panel, width=560, height=500)
        self.view.pack(fill='both', expand=True)
        self.view.set_palette(self.config.palette)
        self.view.set_theme(self.config.theme)
        self.view.set_z_scale(self.config.z_scale)
        self.view.set_resource_mode(self.config.advanced.resource_mode)
        self.view.camera_changed_callback = self._draw_attitude
        self.view.upload_progress_callback = self._upload_progress
        self.view.pin_selected_callback = self._select_pin_record
        self._build_right(self.right_panel)
        self.welcome = self.ttk.Frame(self.center_panel, style='Panel.TFrame', padding=24)
        self.ttk.Label(self.welcome, text='Explore a layout in 3D', style='Panel.TLabel', font=self.root.fw_fonts['title']).pack(pady=(0, 8))
        self.ttk.Label(self.welcome, text='Open a JSON, GDS or OASIS file, or load the bundled example inductor.\nNo Cadence installation is needed.', style='PanelDim.TLabel', justify='center').pack()
        self.ttk.Button(self.welcome, text='Load example', style='Primary.TButton', command=self.open_example).pack(pady=(16, 0))
        self.welcome.place(relx=.5, rely=.45, anchor='center')
        self.status_value = self.tk.StringVar(value='Connecting to the local viewer…')
        self.status_bar = self.tk.Frame(self.root, bg=fw.PANEL)
        self.status_bar.grid(row=4, column=0, sticky='ew')
        self.tk.Frame(self.status_bar, bg=fw.LINE, height=1).pack(fill='x', side='top')
        self.status_chip = fw.StatusChip(self.status_bar)
        self.status_chip.pack(side='left', padx=(16, 8), pady=8)
        self.progress = self.ttk.Progressbar(self.status_bar, mode='indeterminate', length=120, style='Horizontal.TProgressbar')
        self.status_label = self.ttk.Label(self.status_bar, textvariable=self.status_value, style='Muted.TLabel', padding=(0, 4))
        self.status_label.pack(side='left', fill='x', expand=True)
        self.status_value.trace('w', lambda *args: self._status_changed())
        self.root.bind('<Configure>', self._window_resized, add='+')
        self.root.bind('<KeyPress>', self._shortcut, add='+')
        self._natural_button_widths(self.root)
        self._toggle_load_setup(False)
        self.root.after(80, self._arrange_panes)

    def _natural_button_widths(self, widget):
        # clam gives every ttk button a minimum width; size toolbar buttons to their text instead.
        for child in widget.winfo_children():
            if child.winfo_class() == 'TButton' and not str(child.cget('width')):
                child.configure(width=0)
            self._natural_button_widths(child)

    def _build_load_setup(self):
        self.load_panel = self.ttk.LabelFrame(self.root, text='Load — required inputs and automatic detection', padding=(10, 6))
        self.load_panel.grid(row=2, column=0, sticky='ew', padx=16, pady=(8, 8))
        self.load_panel.columnconfigure(1, weight=1)
        self.load_open = True
        self.load_mode = self.tk.StringVar(value='Layout file')
        self.load_path = self.tk.StringVar()
        self.load_hint = self.tk.StringVar(value='JSON: open directly. GDS/OAS: select its layer mapping when automatic mapping is insufficient.')
        mode = self.ttk.Combobox(self.load_panel, textvariable=self.load_mode, state='readonly',
                                 values=('Layout file', 'OA library'), width=13)
        mode.grid(row=0, column=0, sticky='w')
        mode.bind('<<ComboboxSelected>>', lambda event: self._refresh_load_fields())
        self.ttk.Entry(self.load_panel, textvariable=self.load_path).grid(row=0, column=1, sticky='ew', padx=6)
        self.ttk.Button(self.load_panel, text='Browse', command=self._browse_source).grid(row=0, column=2)
        self.load_source_button = self.ttk.Button(self.load_panel, text='Load source', command=self._load_source)
        self.load_source_button.grid(row=0, column=3, padx=5)
        self.cancel_load_button = self.ttk.Button(self.load_panel, text='Cancel load', command=self._cancel_loading, state='disabled')
        self.cancel_load_button.grid(row=0, column=4)
        self.cell_row = self.ttk.Frame(self.load_panel)
        self.cell_row.grid(row=1, column=0, columnspan=5, sticky='ew', pady=4)
        self.ttk.Label(self.cell_row, text='Cell / view').pack(side='left')
        self.cell_value = self.tk.StringVar()
        self.cell_combo = self.ttk.Combobox(self.cell_row, textvariable=self.cell_value, width=28)
        self.cell_combo.pack(side='left', fill='x', expand=True, padx=6)
        self.open_button = self.ttk.Button(self.cell_row, text='Open cell', command=lambda: self.open_cell(False))
        self.open_button.pack(side='left')
        self.refresh_button = self.ttk.Button(self.cell_row, text='Refresh OA', command=lambda: self.open_cell(True))
        self.refresh_button.pack(side='left', padx=4)
        self.load_values = {}
        self.load_rows = {}
        self.load_explanations = {}
        fields = [
            ('cds_lib', 'cds.lib / lib.defs', 'Automatic from the source project; choose a file here if referenced libraries cannot be resolved.'),
            ('cadence_env', 'Cadence / PDK script', 'Automatic when available; otherwise select your existing environment script for OA export.'),
            ('pdk_profile', 'PDK profile JSON', 'Automatic or embedded layer rules. Select a profile here if the technology is not identified.'),
            ('stream_layer_map', 'Layer map JSON', 'GDS/OAS: supplies exact layer/datatype meanings. Unknown layers stay hidden until mapped.'),
            ('pin_annotations', 'Pin annotations JSON', 'Optional source-bound pin figures. Needed for pin tracing when the file has no pin metadata.'),
        ]
        for row, (key, label, explanation) in enumerate(fields, 2):
            frame = self.ttk.Frame(self.load_panel)
            frame.grid(row=row, column=0, columnspan=5, sticky='ew', pady=2)
            frame.columnconfigure(1, weight=1)
            self.load_rows[key] = frame
            self.load_values[key] = self.tk.StringVar(value=getattr(self.config.advanced, key, ''))
            self.ttk.Label(frame, text=label, width=21).grid(row=0, column=0, sticky='w')
            self.ttk.Entry(frame, textvariable=self.load_values[key], width=24).grid(row=0, column=1, sticky='ew', padx=(0, 5))
            self.ttk.Button(frame, text='Browse', width=7, command=lambda name=key: self._pick_load_input(name)).grid(row=0, column=2)
            hint = self.tk.StringVar(value=explanation)
            self.load_explanations[key] = hint
            self.ttk.Label(frame, textvariable=hint, style='Muted.TLabel', wraplength=370, width=45).grid(row=0, column=3, sticky='w', padx=(8, 0))
        self.ttk.Label(self.load_panel, textvariable=self.load_hint, style='Muted.TLabel', wraplength=900).grid(row=7, column=0, columnspan=5, sticky='w', pady=(4, 0))
        self.ttk.Button(self.load_panel, text='Pin annotation guide', command=self._annotation_guide).grid(row=8, column=0, columnspan=3, sticky='w', pady=(4, 0))
        self.ttk.Button(self.load_panel, text='Return to view', command=lambda: self._toggle_load_setup(False)).grid(row=8, column=3, columnspan=2, sticky='e', pady=(4, 0))
        self._refresh_load_fields()
        self.load_path.trace('w', lambda *args: self._refresh_load_fields())

    def _annotation_guide(self):
        path = os.path.join(self.project_root, 'docs', 'PIN_ANNOTATION.md')
        try:
            with open(path, 'r') as handle: content = handle.read()
        except IOError:
            content = 'Pin annotations use original terminal names, layer names, instance paths and world-coordinate polygons. Select source-bound annotation JSON in Load setup, then load the file. No terminal is guessed from text or geometry.'
        window = self.tk.Toplevel(self.root)
        window.title('Pin annotations — source identity and exact geometry')
        window.geometry('760x520')
        view = self.tk.Text(window, wrap='word', padx=12, pady=10)
        scroll = self.ttk.Scrollbar(window, command=view.yview)
        scroll.pack(side='right', fill='y')
        view.configure(yscrollcommand=scroll.set)
        view.pack(fill='both', expand=True)
        view.insert('1.0', content)
        view.configure(state='disabled')

    def _refresh_load_fields(self):
        oa = self.load_mode.get() == 'OA library'
        if oa and getattr(self, '_previous_load_mode', '') == 'Layout file' and self.session:
            self.load_path.set(self.config.library_path or (self.session.get('library') or {}).get('path') or '')
        self._previous_load_mode = self.load_mode.get()
        json_input = self.load_path.get().lower().endswith(('.json', '.json.gz')) and not oa
        if oa: self.cell_row.grid()
        else: self.cell_row.grid_remove()
        for key, row in self.load_rows.items():
            visible = key in ('cds_lib', 'cadence_env', 'pdk_profile') if oa else key == 'pin_annotations' if json_input else key in ('pdk_profile', 'stream_layer_map', 'pin_annotations')
            if visible: row.grid()
            else: row.grid_remove()
        self.load_hint.set('Choose the source directory (or paste cds.lib), load it, then select a cell. Empty paths use detection; missing requirements appear here.' if oa
                           else 'JSON uses its embedded layer rules. To change layer meanings, re-import the original GDS/OAS with its mapping; selecting a profile cannot relabel this JSON.' if json_input
                           else 'GDS/OAS needs a layer map/profile if unknown. Pin annotations add only your explicit original terminal figures.')

    def _toggle_load_setup(self, show=None):
        self.load_open = not self.load_open if show is None else bool(show)
        if self.load_open: self.load_panel.grid()
        else: self.load_panel.grid_remove()
        if hasattr(self, 'workspace'): self._arrange_panes()

    def _pick_load_input(self, key):
        value = self.filedialog.askopenfilename(parent=self.root, title='Select ' + key.replace('_', ' '))
        if value: self.load_values[key].set(value)

    def _browse_source(self):
        if self.load_mode.get() == 'OA library':
            value = self.filedialog.askdirectory(parent=self.root, title='Select OA library or project directory')
        else:
            value = self.filedialog.askopenfilename(parent=self.root, title='Select JSON, GDSII or OASIS',
                filetypes=(('Layout files', '*.json *.json.gz *.gds *.gdsii *.oas *.oasis'), ('All files', '*')))
        if value:
            self.load_path.set(value)
            self._refresh_load_fields()
            return True
        return False

    def _capture_load_inputs(self):
        for key in ('cds_lib', 'cadence_env', 'pdk_profile', 'stream_layer_map'):
            setattr(self.config.advanced, key, self.load_values[key].get().strip())
        self.config_dirty = True

    def _load_source(self):
        if self.busy: return
        path = self.load_path.get().strip()
        if not path:
            self.load_hint.set('Choose a source with Browse, or paste its absolute path, then Load source.')
            return
        self._capture_load_inputs()
        if self.load_mode.get() == 'OA library':
            self._pending_library_path = path
            self._pending_library_overrides = dict(self.config.advanced.library_overrides())
            self._start_library_session()
        else:
            self._pending_clear_library = True
            self._pending_input_path = path
            if path.lower().endswith(('.json', '.json.gz')) and not self.load_values['pin_annotations'].get().strip():
                self._compile_path(path)
            else:
                self._import_stream(path)

    def open_example(self):
        if self.busy: return
        self.load_mode.set('Layout file')
        self.load_path.set(os.path.join(self.project_root, 'examples', 'octagon-inductor.json'))
        self.load_values['pin_annotations'].set('')
        self._refresh_load_fields()
        self._pending_clear_library = True
        self._compile_path(self.load_path.get())

    def _toggle_dock(self, side):
        if self.root.winfo_width() < 1200 and self.load_open: self._toggle_load_setup(False)
        if self.root.winfo_width() < 1200:
            self.narrow_dock = '' if self.narrow_dock == side else side
        else:
            self.dock_visible[side] = not self.dock_visible[side]
        self._arrange_panes()

    def _show_dock(self, side):
        if self.root.winfo_width() < 1200 and self.load_open: self._toggle_load_setup(False)
        self.narrow_dock = side
        self.dock_visible[side] = True
        self._arrange_panes()

    def _window_resized(self, event):
        if event.widget is self.root and event.width != self._last_width:
            self._last_width = event.width
            self.root.after_idle(self._arrange_panes)

    def _arrange_panes(self):
        width = self.root.winfo_width()
        if width < 100: return
        narrow = width < 1200
        show_left = self.narrow_dock == 'left' if narrow else self.dock_visible['left']
        show_right = self.narrow_dock == 'right' if narrow else self.dock_visible['right']
        if narrow and self.load_open: show_left = show_right = False
        for panel, visible in ((self.left_panel, show_left), (self.right_panel, show_right)):
            if visible: panel.grid()
            else: panel.grid_remove()
        if hasattr(self, 'status_label'): self.status_label.configure(wraplength=max(300, width-30))

    def _view_action(self, name):
        method = getattr(self.view, name, None)
        if method and method() is False:
            self.status_value.set('Select a module or pin, then trace its routes before using this view action.')

    def _shortcut(self, event):
        if event.widget.winfo_class() in ('Entry', 'TEntry', 'TCombobox', 'Text', 'Spinbox'): return
        key = event.keysym.lower()
        actions = {'f': 'fit_layout', 'p': 'fit_pin', 't': 'fit_trace', 'm': 'fit_selected_modules'}
        if key in actions: self._view_action(actions[key]); return 'break'
        if key == 'escape': self._clear_module_selection(); return 'break'
        if key == 'left' and event.state & 8: self._view_action('previous_view'); return 'break'
        if key in ('plus', 'equal', 'minus'):
            method = getattr(self.view, 'zoom_by', None)
            if method: method(-1 if key == 'minus' else 1)
            return 'break'
        if key in ('left', 'right', 'up', 'down') and event.widget.winfo_class() != 'Treeview':
            dx, dy = {'left': (-20, 0), 'right': (20, 0), 'up': (0, -20), 'down': (0, 20)}[key]
            method = getattr(self.view, 'pan_by' if event.state & 1 else 'orbit_by', None)
            if method: method(dx, dy)
            return 'break'

    def _build_left(self, parent):
        tabs = self.ttk.Notebook(parent)
        tabs.pack(fill='both', expand=True)
        self.explorer_tabs = tabs
        hier_tab = self.ttk.Frame(tabs, style='Panel.TFrame', padding=(0, 12, 0, 0))
        layer_tab = self.ttk.Frame(tabs, style='Panel.TFrame', padding=(0, 12, 0, 0))
        tabs.add(hier_tab, text='Hierarchy')
        tabs.add(layer_tab, text='Layers')

        # Hierarchy tab
        clear_row = self.ttk.Frame(hier_tab, style='Panel.TFrame')
        clear_row.pack(fill='x', pady=(0, 8))
        self.ttk.Button(clear_row, text='Clear selection', command=self._clear_module_selection).pack(side='left')
        self.ttk.Label(hier_tab, text='Ctrl/Shift: select several.', style='Muted.TLabel').pack(anchor='w', pady=(0, 8))
        fw.section(hier_tab, 'Find module or master').pack(anchor='w')
        self.hierarchy_search = self.tk.StringVar()
        search = self.ttk.Entry(hier_tab, textvariable=self.hierarchy_search)
        search.pack(fill='x', pady=(4, 8))
        search.bind('<KeyRelease>', lambda event: self._render_hierarchy())
        depth_row = self.ttk.Frame(hier_tab, style='Panel.TFrame')
        depth_row.pack(fill='x')
        self.ttk.Label(depth_row, text='Depth', style='Panel.TLabel').pack(side='left')
        self.depth_value = self.tk.IntVar(value=3)
        self.depth_scale = self.ttk.Scale(depth_row, from_=0, to=8, variable=self.depth_value, command=lambda value: self._render_hierarchy())
        self.depth_scale.pack(side='left', fill='x', expand=True, padx=(8, 0))
        hierarchy_frame = self.ttk.Frame(hier_tab, style='Panel.TFrame')
        hierarchy_frame.pack(fill='both', expand=True, pady=(8, 0))
        self.hierarchy = self.ttk.Treeview(hierarchy_frame, show='tree', selectmode='extended')
        hierarchy_scroll = self.ttk.Scrollbar(hierarchy_frame, orient='vertical', command=self.hierarchy.yview)
        self.hierarchy.configure(yscrollcommand=hierarchy_scroll.set)
        self.hierarchy.pack(side='left', fill='both', expand=True)
        hierarchy_scroll.pack(side='right', fill='y')
        self.hierarchy.bind('<<TreeviewSelect>>', self._hierarchy_selected)

        # Layers tab: visibility switches first, then the per-layer list
        fw.section(layer_tab, 'Visibility').pack(anchor='w')
        visibility = self.ttk.Frame(layer_tab, style='Panel.TFrame')
        visibility.pack(fill='x', pady=(4, 8))
        self.instances_value = self.tk.BooleanVar(value=False)
        self.wires_value = self.tk.BooleanVar(value=True)
        self.ttk.Checkbutton(
            visibility, text='Instances', variable=self.instances_value, style='Panel.TCheckbutton',
            command=lambda: self.view.set_instances_visible(self.instances_value.get()),
        ).grid(row=0, column=0, sticky='w')
        self.ttk.Button(visibility, text='All', width=5, command=lambda: self._set_instances(True)).grid(row=0, column=1, padx=(8, 4))
        self.ttk.Button(visibility, text='None', width=5, command=lambda: self._set_instances(False)).grid(row=0, column=2)
        self.ttk.Checkbutton(
            visibility, text='Wires + vias', variable=self.wires_value, style='Panel.TCheckbutton',
            command=lambda: self.view.set_wires_visible(self.wires_value.get()),
        ).grid(row=1, column=0, sticky='w', pady=(4, 0))
        self.ttk.Button(visibility, text='All', width=5, command=lambda: self._set_wires(True)).grid(row=1, column=1, padx=(8, 4), pady=(4, 0))
        self.ttk.Button(visibility, text='None', width=5, command=lambda: self._set_wires(False)).grid(row=1, column=2, pady=(4, 0))
        fw.section(layer_tab, 'Layers').pack(anchor='w', pady=(8, 0))
        self.layer_filter = self.tk.StringVar(value='Routing layers')
        layer_filter = self.ttk.Combobox(layer_tab, textvariable=self.layer_filter, state='readonly', values=('Routing layers', 'Visible layers', 'All layers'), width=18)
        layer_filter.pack(fill='x', pady=(4, 8))
        layer_filter.bind('<<ComboboxSelected>>', lambda event: self._render_layers())
        layer_frame = self.ttk.Frame(layer_tab, style='Panel.TFrame')
        layer_frame.pack(fill='both', expand=True)
        self.layer_canvas = self.tk.Canvas(
            layer_frame, height=155, highlightthickness=0, background=fw.PANEL)
        layer_scroll = self.ttk.Scrollbar(layer_frame, orient='vertical', command=self.layer_canvas.yview)
        self.layer_inner = self.ttk.Frame(self.layer_canvas, style='Panel.TFrame')
        self.layer_canvas.create_window((0, 0), window=self.layer_inner, anchor='nw')
        self.layer_canvas.configure(yscrollcommand=layer_scroll.set)
        self.layer_inner.bind('<Configure>', lambda event: self.layer_canvas.configure(scrollregion=self.layer_canvas.bbox('all')))
        self.layer_canvas.pack(side='left', fill='both', expand=True)
        layer_scroll.pack(side='right', fill='y')

    def _build_right(self, parent):
        self.inspector_value = self.tk.StringVar(value='Open a layout, then select a module.')
        self.pin_note = self.tk.StringVar(value='Select a module in Explorer to reveal its own pins.')
        tabs = self.ttk.Notebook(parent)
        tabs.pack(fill='both', expand=True)
        self.inspector_tabs = tabs
        pins = self.ttk.Frame(tabs, padding=(0, 12, 0, 0), style='Panel.TFrame')
        details = self.ttk.Frame(tabs, padding=(0, 12, 0, 0), style='Panel.TFrame')
        tabs.add(pins, text='Pins & routes')
        tabs.add(details, text='Details & view')
        self.ttk.Label(pins, textvariable=self.pin_note, style='Muted.TLabel', wraplength=250).pack(fill='x', pady=(0, 5))
        search_row = self.ttk.Frame(pins, style='Panel.TFrame')
        search_row.pack(fill='x')
        self.ttk.Label(search_row, text='Find pin', style='Panel.TLabel').pack(side='left')
        self.pin_search = self.tk.StringVar()
        search = self.ttk.Entry(search_row, textvariable=self.pin_search, width=12)
        search.pack(side='left', fill='x', expand=True, padx=8)
        search.bind('<KeyRelease>', lambda event: self._render_pins())
        self.ttk.Button(search_row, text='×', width=2, command=self._clear_pin_filter).pack(side='right')
        pin_frame = self.ttk.Frame(pins, style='Panel.TFrame')
        pin_frame.pack(fill='both', expand=True, pady=(5, 6))
        pin_frame.columnconfigure(0, weight=1)
        pin_frame.rowconfigure(0, weight=1)
        self.pin_tree = self.ttk.Treeview(pin_frame, columns=('layer', 'figure', 'net'), height=1,
                                         show='tree headings', selectmode='browse')
        for key, title, width in [('#0', 'Original pin name', 120), ('layer', 'Layer', 52), ('figure', 'Figure', 56), ('net', 'Original net', 90)]:
            self.pin_tree.heading(key, text=title)
            self.pin_tree.column(key, width=width, minwidth=45, stretch=key == '#0')
        scroll = self.ttk.Scrollbar(pin_frame, orient='vertical', command=self.pin_tree.yview)
        horizontal = self.ttk.Scrollbar(pin_frame, orient='horizontal', command=self.pin_tree.xview)
        self.pin_tree.configure(yscrollcommand=scroll.set, xscrollcommand=horizontal.set)
        self.pin_tree.grid(row=0, column=0, sticky='nsew')
        scroll.grid(row=0, column=1, sticky='ns')
        horizontal.grid(row=1, column=0, sticky='ew')
        self.pin_tree.bind('<<TreeviewSelect>>', self._pin_selected)
        self.pin_tree.bind('<Double-1>', lambda event: self.inspector_tabs.select(1))
        actions = self.ttk.Frame(pins, style='Panel.TFrame')
        actions.pack(fill='x')
        self.ttk.Button(actions, text='Locate pin', command=lambda: self._view_action('fit_pin')).pack(side='left')
        self.ttk.Button(actions, text='Fit routes', command=lambda: self._view_action('fit_trace')).pack(side='left', padx=3)
        self.ttk.Button(actions, text='Details', command=lambda: self.inspector_tabs.select(1)).pack(side='right')
        controls = self.ttk.Frame(pins, style='Panel.TFrame')
        controls.pack(fill='x', pady=5)
        controls.columnconfigure(1, weight=1)
        self.trace_mode_value = self.tk.StringVar(value='Physical geometry')
        self.trace_scope_value = self.tk.StringVar(value='Whole layout')
        self.ttk.Label(controls, text='Trace by', style='Panel.TLabel').grid(row=0, column=0, sticky='w')
        mode = self.ttk.Combobox(controls, textvariable=self.trace_mode_value, state='readonly', values=('Named nets', 'Physical geometry'), width=17)
        mode.grid(row=0, column=1, sticky='ew', padx=(5, 0))
        mode.bind('<<ComboboxSelected>>', self._trace_mode_changed)
        self.ttk.Label(controls, text='Scope', style='Panel.TLabel').grid(row=1, column=0, sticky='w', pady=(4, 0))
        self.trace_scope_combo = self.ttk.Combobox(controls, textvariable=self.trace_scope_value, state='readonly', values=('Whole layout', 'Selected modules'), width=17)
        self.trace_scope_combo.grid(row=1, column=1, sticky='ew', padx=(5, 0), pady=(4, 0))
        self.trace_scope_combo.bind('<<ComboboxSelected>>', self._trace_mode_changed)
        buttons = self.ttk.Frame(pins, style='Panel.TFrame')
        buttons.pack(fill='x')
        self.ttk.Button(buttons, text='Trace module pins', style='Primary.TButton', command=self._clear_pin_selection).pack(side='left')
        self.trace_cancel_button = self.ttk.Button(buttons, text='Cancel', width=7, state='disabled', command=self._cancel_physical_trace)
        self.trace_cancel_button.pack(side='right')
        self.trace_status_value = self.tk.StringVar(value='Select a pin to highlight its connected routes.')
        self.ttk.Label(pins, textvariable=self.trace_status_value, wraplength=250, style='Muted.TLabel').pack(fill='x', pady=5)
        self.trace_details_button = self.ttk.Button(pins, text='Trace details / next step', state='disabled', command=self._show_trace_details)
        self.trace_details_button.pack(anchor='w')
        self.ttk.Label(pins, text='Pin: ring + original name  ·  Route: solid\nHidden route: dashed  ·  Module: fine outline', wraplength=250, style='Muted.TLabel').pack(fill='x', pady=(6, 0))
        self.pin_details = self.tk.Text(details, height=8, width=22, wrap='word', relief='flat', background=fw.RAISED, foreground=fw.TEXT, padx=8, pady=8, highlightthickness=0)
        detail_scroll = self.ttk.Scrollbar(details, orient='vertical', command=self.pin_details.yview)
        self.pin_details.configure(yscrollcommand=detail_scroll.set)
        detail_scroll.pack(side='right', fill='y')
        self.pin_details.pack(fill='both', expand=True)
        self.inspector_value.trace('w', lambda *args: self._sync_inspector_text())
        self._sync_inspector_text()
        appearance = self.ttk.Frame(details, style='Panel.TFrame')
        appearance.pack(fill='x', pady=5)
        initial = next((name for name, key in PALETTE_LABELS.items() if key == self.config.palette), 'Classic Dark Metal')
        self.palette_value = self.tk.StringVar(value=initial)
        palette = self.ttk.Combobox(appearance, textvariable=self.palette_value, state='readonly', values=tuple(PALETTE_LABELS), width=17)
        palette.pack(side='left', fill='x', expand=True)
        palette.bind('<<ComboboxSelected>>', self._palette_changed)
        self.theme_value = self.tk.StringVar(value=self.config.theme.title())
        theme = self.ttk.Combobox(appearance, textvariable=self.theme_value, state='readonly', values=('Dark', 'Light'), width=6)
        theme.pack(side='left', padx=4)
        theme.bind('<<ComboboxSelected>>', self._theme_changed)
        self.xray_value = self.tk.BooleanVar(value=True)
        self.ttk.Checkbutton(details, text='Show hidden highlights as dashed lines', variable=self.xray_value, style='Panel.TCheckbutton',
            command=lambda: getattr(self.view, 'set_xray_highlights', lambda value: None)(self.xray_value.get())).pack(anchor='w')
        self.attitude = self.tk.Canvas(details, height=85, background=fw.PLOT_BG, highlightthickness=0)
        self.attitude.pack(fill='x', pady=4)
        self.ttk.Label(details, text='F: all · P: pin · T: routes · M: module\nAlt+Left: back · +/-: zoom · arrows: orbit\nShift+arrows: pan · Esc: clear selection', style='Muted.TLabel', wraplength=250).pack(fill='x')
        self._draw_attitude(self.view.camera)

    def _sync_inspector_text(self):
        self.pin_details.configure(state='normal')
        self.pin_details.delete('1.0', 'end')
        self.pin_details.insert('1.0', self.inspector_value.get())
        self.pin_details.configure(state='disabled')

    def _clear_pin_filter(self):
        self.pin_search.set('')
        self._render_pins()

    def _select_pin_record(self, pin):
        if hasattr(self, 'pin_search') and self.pin_search.get().strip():
            self.pin_search.set('')
            self._render_pins()
        for item, record in self.pin_item_records.items():
            if record is pin:
                self.pin_tree.selection_set([item])
                self.pin_tree.see(item)
                self._pin_selected()
                self._show_dock('right')
                return
        self.pin_tree.selection_remove(self.pin_tree.selection())
        self._cancel_physical_trace(quiet=True)
        self.view.select_pin(pin)
        self._update_selection_inspector(pin)
        if self._physical_mode() and pin is not None: self._start_physical_trace(pin)
        self._show_dock('right')

    def _clear_module_selection(self):
        self._cancel_physical_trace(quiet=True)
        self.hierarchy.selection_remove(self.hierarchy.selection())
        self.view.select_hierarchy([])
        self._render_pins()

    def _check_backend(self):
        self._background('Checking backend', self.backend.health, self._backend_ready)

    def _backend_ready(self, payload):
        self.backend_status = payload
        self.status_value.set('Ready — open a file, choose an OA library, or try Example. No Cadence is needed for JSON/GDS/OAS.')
        if not payload.get('oaEnabled'):
            self.load_explanations['cadence_env'].set('OA export is disabled in this launch. Restart with OA enabled; files and the example still work.')

    def _status_changed(self):
        if not hasattr(self, 'status_chip') or self.closed:
            return
        if self.busy:
            self.status_chip.set('running', '')
        elif self._status_state in ('error', 'warn'):
            self.status_chip.set(self._status_state, '')
        elif self.compiled is not None:
            self.status_chip.set('done', '')
        else:
            self.status_chip.set('idle', '')

    def _set_busy(self, value, message=''):
        self.busy = bool(value)
        if hasattr(self, 'progress'):
            if self.busy:
                self._status_state = 'running'
                self.progress.pack(side='right', padx=(8, 16), pady=8)
                self.progress.configure(mode='indeterminate')
                self.progress.start(40)
            else:
                self.progress.stop()
                self.progress.pack_forget()
                if self._status_state == 'running':
                    self._status_state = 'idle'
        state = 'disabled' if self.busy else 'normal'
        for widget in (self.load_button, self.file_button, self.open_button, self.refresh_button, self.advanced_button, self.example_button, self.load_source_button):
            widget.configure(state=state)
        if hasattr(self, 'cancel_load_button'):
            self.cancel_load_button.configure(state='normal' if self.busy and (self.compile_job is not None or message.startswith('Importing stream')) else 'disabled')
        if message:
            self._status_state = 'idle' if not self.busy else 'running'
            self.status_value.set(message)
        else:
            self._status_changed()

    def _cancel_loading(self):
        self._load_generation = getattr(self, '_load_generation', 0) + 1
        self.cancel_event.set()
        if self.compile_job is not None:
            self.compile_job.cancel()
            self.compile_job = None
        self.active_operation = ''
        self._set_busy(False, 'Load canceled. The current layout is unchanged; choose a source to retry.')

    def _background(self, label, function, success):
        if self.busy and label != 'Checking backend':
            return
        self._set_busy(True, label + '…')
        results = queue.Queue()
        generation = getattr(self, '_load_generation', 0)

        def worker():
            try:
                results.put((True, function()))
            except Exception as error:
                results.put((False, error))

        thread = threading.Thread(target=worker, name='vl3d-native-worker')
        thread.daemon = True
        thread.start()

        def poll():
            if self.closed or generation != getattr(self, '_load_generation', 0):
                return
            try:
                ok, value = results.get_nowait()
            except queue.Empty:
                self.root.after(30, poll)
                return
            self._set_busy(False)
            if ok:
                success(value)
            else:
                self._show_error(value)
        self.root.after(30, poll)

    def _show_error(self, error):
        if isinstance(error, LibraryChoiceRequired):
            self._choose_library(error)
            return
        if isinstance(error, TopCellChoiceRequired):
            self._choose_stream_top(error)
            return
        details = getattr(error, 'details', {}) or {}
        candidates = details.get('candidates', []) if isinstance(details, dict) else []
        if getattr(error, 'code', '') == 'VL3D-E2008' and candidates and all(isinstance(value, str) for value in candidates):
            self._toggle_load_setup(True)
            self._choose_environment(candidates)
            return
        if not isinstance(error, Vl3dError):
            error = Vl3dError('E9001', str(error))
        if hasattr(self, 'load_panel'):
            self._toggle_load_setup(True)
            self.load_hint.set('Load needs attention: ' + str(error) + ' — correct the source/environment/mapping above, then retry.')
        self._status_state = 'error'
        self.status_value.set(str(error))
        self.messagebox.showerror('Layout 3D Viewer', str(error), parent=self.root)

    def load_library(self):
        if self.busy: return
        self.load_mode.set('OA library')
        self._refresh_load_fields()
        self._toggle_load_setup(True)
        if self._browse_source(): self._load_source()

    def _start_library_session(self):
        self._pending_clear_library = False
        self._background(
            'Discovering library and Cadence/PDK environment',
            lambda: self.backend.create_library_session(
                self._pending_library_path, self._pending_library_overrides),
            self._library_loaded)

    def _choose_library(self, error):
        window = self.tk.Toplevel(self.root)
        window.title('Choose layout library')
        window.transient(self.root)
        window.geometry('760x360')
        frame = self.ttk.Frame(window, padding=12)
        frame.pack(fill='both', expand=True)
        self.ttk.Label(frame, text='This project contains several libraries. Choose the one to browse.').pack(anchor='w', pady=(0, 8))
        tree = self.ttk.Treeview(frame, columns=('path',), show='tree headings', selectmode='browse')
        tree.heading('#0', text='Library')
        tree.heading('path', text='Directory')
        tree.column('#0', width=170, stretch=False)
        tree.column('path', width=530, stretch=True)
        scroll = self.ttk.Scrollbar(frame, orient='vertical', command=tree.yview)
        tree.configure(yscrollcommand=scroll.set)
        scroll.pack(side='right', fill='y')
        tree.pack(fill='both', expand=True)
        candidates = {}
        for candidate in error.candidates:
            item = tree.insert('', 'end', text=candidate['name'], values=(candidate['path'],))
            candidates[item] = candidate
        buttons = self.ttk.Frame(frame)
        buttons.pack(fill='x', pady=(10, 0))

        def choose(event=None):
            selection = tree.selection()
            if not selection:
                return
            candidate = candidates[selection[0]]
            # This choice applies to this load only; keep saved Advanced settings.
            self._pending_library_overrides = dict(self._pending_library_overrides)
            self._pending_library_overrides['libraryName'] = candidate['name']
            window.destroy()
            self._start_library_session()

        def cancel():
            window.destroy()
            self.status_value.set('Library selection canceled')

        self.ttk.Button(buttons, text='Open library', command=choose).pack(side='right')
        self.ttk.Button(buttons, text='Cancel', command=cancel).pack(side='right', padx=(0, 8))
        tree.bind('<Double-1>', choose)
        tree.bind('<Return>', choose)
        window.protocol('WM_DELETE_WINDOW', cancel)
        window.grab_set()
        tree.focus_set()

    def _library_loaded(self, session):
        self.session = session
        self.config.library_path = getattr(self, '_pending_library_path', '')
        self.config_dirty = True
        self._persist_config()
        self.records = list(session.get('layouts') or [])
        self.record_labels = {}
        labels = []
        for record in sorted(self.records, key=lambda item: (
                bool(item.get('isBackup')), str(item.get('cell')), str(item.get('view')))):
            label = str(record.get('cell') or '')
            if record.get('view') and record.get('view') != 'layout':
                label += '/' + str(record.get('view'))
            if record.get('isBackup'):
                label += ' · Backup'
            labels.append(label)
            self.record_labels[label.lower()] = record
            key = str(record.get('key') or '').lower()
            if key:
                self.record_labels[key] = record
            self.record_labels[str(record.get('cell') or '').lower()] = record
        self.cell_combo.configure(values=tuple(labels))
        self.cell_value.set('')
        library = session.get('library') or {}
        resolved = session.get('resolved') or {}
        self.source_value.set('OA: ' + str(library.get('name') or 'library'))
        for key, field in [('cds_lib', 'cdsLib'), ('cadence_env', 'cadenceEnv')]:
            found = resolved.get(field)
            self.load_explanations[key].set(('Detected/selected: ' + str(found) + ' (used when exporting)') if found else 'Not detected. Choose the required project/environment file here for fresh OA export.')
        profile = resolved.get('pdkProfile')
        directories = resolved.get('pdkProfileDirs') or []
        self.load_explanations['pdk_profile'].set(('Configured: ' + str(profile) if profile else 'Profile directories: ' + ', '.join(directories) if directories else 'Automatic technology matching during export') + '. Configuration does not prove complete trace rules.')
        self.load_hint.set('Library listed: choose a cell and Open cell. After changing paths, use Load source again. Refresh regenerates its export. ' + ' '.join(str(w.get('message') or w.get('detail') or '') for w in session.get('warnings') or []))
        self.status_value.set(
            '%s — %d cells — cds.lib: %s — env: %s' % (
                library.get('name') or os.path.basename(library.get('path') or ''), len(self.records),
                resolved.get('cdsLib') or 'auto/unavailable', resolved.get('cadenceEnv') or 'auto/unavailable'))

    def _selected_record(self):
        query = self.cell_value.get().strip().lower()
        if not query:
            return None
        if query in self.record_labels:
            return self.record_labels[query]
        library = str((self.session or {}).get('library', {}).get('name') or '').lower()
        if library and query.startswith(library + '/'):
            return self.record_labels.get(query[len(library) + 1:])
        return None

    def open_cell(self, refresh=False):
        if self.busy: return
        self._pending_clear_library = False
        record = self._selected_record()
        if record is None:
            self._show_error(Vl3dError('E2015', 'Choose a cell from the loaded library or type its exact name'))
            return
        session_id = str((self.session or {}).get('sessionId') or '')
        source_directory = os.path.join(os.path.dirname(self.cache.root), 'sources')

        def prepare_and_download():
            entry = record.get('entry')
            if refresh or not entry or record.get('cacheState') != 'ready':
                entry = self.backend.prepare_layout(session_id, record, refresh)
            return self.backend.download_entry(entry, source_directory)

        self._background(
            'Refreshing layout' if refresh else 'Preparing layout',
            prepare_and_download,
            self._compile_path)

    def open_file(self):
        if self.busy: return
        self.load_mode.set('Layout file')
        self._refresh_load_fields()
        self._toggle_load_setup(True)
        if self._browse_source(): self._load_source()

    def _import_stream(self, path, top_cell=''):
        cancel_event = threading.Event()
        self.cancel_event = cancel_event
        self.active_operation = ''

        def remember_operation(operation_id):
            if self.cancel_event is cancel_event and not cancel_event.is_set():
                self.active_operation = str(operation_id)

        source_directory = os.path.join(os.path.dirname(self.cache.root), 'sources')

        overrides = dict(self.config.advanced.stream_overrides())
        annotation_path = self.load_values['pin_annotations'].get().strip()
        if annotation_path: overrides['pinAnnotationsPath'] = annotation_path

        def import_and_download():
            entry = self.backend.import_stream(
                path,
                overrides=overrides,
                top_cell=top_cell,
                operation_callback=remember_operation,
                cancel_event=cancel_event)
            if cancel_event.is_set(): raise Vl3dError('E7004', 'Layout import was canceled')
            return self.backend.download_entry(entry, source_directory)

        self._pending_stream_path = path
        self._background('Importing stream layout', import_and_download, self._stream_ready)

    def _stream_ready(self, source):
        self.active_operation = ''
        self._compile_path(source)

    def _choose_source_option(self, title, explanation, candidates, accept):
        window = self.tk.Toplevel(self.root)
        window.title(title)
        window.transient(self.root)
        frame = self.ttk.Frame(window, padding=14)
        frame.pack(fill='both', expand=True)
        self.ttk.Label(frame, text=explanation, wraplength=540).pack(fill='x', pady=(0, 8))
        value = self.tk.StringVar(value=candidates[0] if candidates else '')
        combo = self.ttk.Combobox(frame, textvariable=value, state='readonly', values=tuple(candidates), width=65)
        combo.pack(fill='x')
        def choose():
            chosen = value.get()
            if chosen not in candidates: return
            window.destroy()
            accept(chosen)
        buttons = self.ttk.Frame(frame)
        buttons.pack(fill='x', pady=(10, 0))
        self.ttk.Button(buttons, text='Use selection', command=choose).pack(side='right')
        self.ttk.Button(buttons, text='Cancel', command=window.destroy).pack(side='right', padx=6)
        window.grab_set()
        combo.focus_set()

    def _choose_environment(self, candidates):
        def accept(value):
            self.load_values['cadence_env'].set(value)
            self._capture_load_inputs()
            self._pending_library_overrides = dict(getattr(self, '_pending_library_overrides', {}), cadenceEnv=value)
            self._start_library_session()
        self._choose_source_option('Choose Cadence environment',
            'Several environment scripts were found. Choose the one for this OA project; its path remains visible in Load setup.', candidates, accept)

    def _choose_stream_top(self, error):
        candidates = [str(value.get('name') if isinstance(value, dict) else value) for value in error.candidates]
        self._toggle_load_setup(True)
        self._choose_source_option('Choose top cell', 'This file has several top cells. Choose the design to load; cell names are shown unchanged.',
            candidates, lambda value: self._import_stream(self._pending_stream_path, value))


    def _compile_path(self, path):
        try:
            self.compile_job = self.cache.start_compile(path)
        except Exception as error:
            self._show_error(error)
            return
        self._set_busy(True, 'Compiling native scene cache…')
        self.root.after(20, self._poll_compile)

    def _poll_compile(self):
        if self.closed or self.compile_job is None:
            return
        if self.compile_job.poll() is None:
            self.root.after(30, self._poll_compile)
            return
        try:
            compiled = self.cache.finish_compile(self.compile_job)
        except Exception as error:
            self.compile_job = None
            self._set_busy(False)
            self._show_error(error)
            return
        self.compile_job = None
        self._set_busy(False)
        self._activate_layout(compiled)

    def _activate_layout(self, compiled):
        self._cancel_physical_trace(quiet=True)
        if getattr(self, '_pending_clear_library', False):
            self.session = None
            self.records = []
            self.record_labels = {}
            self.cell_value.set('')
            self.cell_combo.configure(values=())
            self._pending_clear_library = False
        self.compiled = compiled
        self._status_state = 'idle'
        self.view.load_layout(compiled)
        self.view.set_physical_trace([] if self._physical_mode() else None)
        import numpy
        unnamed_ids = [index for index, key in enumerate(compiled.metadata.get('netKeys') or []) if not key]
        self.untraced_shape_count = 0
        for array_name in ('rect_nets', 'outline_nets'):
            values = compiled.arrays.get(array_name)
            if values is not None and unnamed_ids:
                self.untraced_shape_count += int(numpy.count_nonzero(numpy.isin(values, unnamed_ids)))
        all_paths = list(compiled.metadata.get('hierarchyPaths') or [])
        all_paths.extend(str(item.get('hierPath') or '') for item in compiled.metadata.get('instances') or [])
        max_depth = max([path.count('/') for path in all_paths] or [0])
        self.depth_scale.configure(to=max(1, max_depth))
        self.depth_value.set(min(max_depth, 3))
        self._render_hierarchy()
        self._render_layers()
        self._hierarchy_selected()
        metadata = compiled.metadata
        self.status_value.set(
            '%s/%s/%s — %s routes — %s instances — cache ready' % (
                metadata.get('library') or 'local', metadata.get('cell') or 'layout',
                metadata.get('view') or 'layout', metadata.get('shapeCount') or len(compiled.arrays.get('rects', [])),
                metadata.get('instanceCount') or len(compiled.arrays.get('instances', []))))
        self.cache.clean_lru(protected=[compiled.path])
        if hasattr(self, 'welcome'): self.welcome.place_forget()
        self.source_value.set('%s / %s' % (metadata.get('library') or 'local', metadata.get('cell') or 'layout'))
        self.root.title('Layout 3D Viewer — %s / %s' % (metadata.get('library') or 'local', metadata.get('cell') or 'layout'))
        self._toggle_load_setup(False)
        self._show_dock('left')
        if not any(layer.get('routing') for layer in metadata.get('layers') or []):
            self._toggle_load_setup(True)
            self.load_hint.set('No confirmed routing layers. JSON keeps its embedded rules: re-import the original GDS/OAS with a verified mapping, or obtain a corrected OA export.' if self.load_path.get().lower().endswith(('.json', '.json.gz')) else 'No confirmed routing layers. Data is retained; select a PDK profile or layer map above, then Load source again.')
        self.root.after(30, lambda: self._scene_ready(compiled))

    def _render_hierarchy(self):
        selected_paths = set(getattr(self.view, 'selected_paths', []))
        open_paths = set(self.hierarchy_item_paths[item] for item in self.hierarchy_item_paths
                         if self.hierarchy.item(item, 'open'))
        for item in self.hierarchy.get_children(''):
            self.hierarchy.delete(item)
        self.hierarchy_item_paths = {}
        if not self.compiled:
            return
        metadata = self.compiled.metadata
        root_path = str(metadata.get('cell') or 'layout')
        query = self.hierarchy_search.get().strip().lower()
        maximum_depth = int(round(float(self.depth_value.get())))
        rows = hierarchy_tree_rows(metadata, query, maximum_depth, selected_paths)
        items_by_path = {}
        restore = []
        for path, instance in rows:
            parent_path = path.rpartition('/')[0]
            parent_item = items_by_path.get(parent_path, '')
            master = instance.get('master') or {}
            label = path if path == root_path else path.rsplit('/', 1)[-1]
            if master.get('cell'):
                label += '  /  ' + str(master['cell'])
            item = self.hierarchy.insert(
                parent_item, 'end', text=label,
                open=bool(query) or path == root_path or path in open_paths)
            items_by_path[path] = item
            self.hierarchy_item_paths[item] = path
            if path in selected_paths:
                restore.append(item)
        if restore:
            self.hierarchy.selection_set(restore)

    def _hierarchy_selected(self, event=None):
        selected = [self.hierarchy_item_paths.get(item, '') for item in self.hierarchy.selection()]
        selected = [path for path in selected if path]
        if event is not None and set(selected) == set(self.view.selected_paths): return
        self._cancel_physical_trace(quiet=True)
        self.view.select_hierarchy(selected)
        self._render_pins()
        if selected and event is not None and hasattr(self, 'workspace'):
            self._show_dock('right')

    def _render_pins(self):
        self._pin_list_generation += 1
        generation = self._pin_list_generation
        self.pin_item_records = {}
        for item in self.pin_tree.get_children(''): self.pin_tree.delete(item)
        pins = self.view.selected_pins()
        query = getattr(self, 'pin_search', None)
        query = query.get().strip().casefold() if query else ''
        counts = {}
        numbered = []
        for pin in pins:
            key = (pin.get('hierPath'), pin.get('terminal') or pin.get('name'))
            counts[key] = counts.get(key, 0) + 1
            numbered.append((pin, counts[key]))
        visible = [(pin, figure) for pin, figure in numbered if not query or query in ' '.join(str(pin.get(key) or '') for key in ('terminal', 'name', 'hierPath', 'layer', 'net')).casefold()]
        groups = {}
        active = getattr(self.view, 'selected_pin', None)
        self._update_selection_inspector(active)
        if query: self.pin_note.set('%d / %d figures match. Search does not change module scope.' % (len(visible), len(pins)))
        def append_rows(start=0):
            if self.closed or generation != self._pin_list_generation: return
            for pin, figure in visible[start:start+200]:
                path = str(pin.get('hierPath') or '')
                if path not in groups: groups[path] = self.pin_tree.insert('', 'end', text=path, open=True)
                name = pin.get('terminal') or pin.get('name') or ''
                key = (pin.get('hierPath'), pin.get('terminal') or pin.get('name'))
                item = self.pin_tree.insert(groups[path], 'end', text=name,
                    values=(pin.get('layer') or '', '%d/%d' % (figure, counts[key]), pin.get('net') or 'No net name'))
                self.pin_item_records[item] = pin
                if pin is getattr(self.view, 'selected_pin', None):
                    self.pin_tree.selection_set([item])
                    if hasattr(self.pin_tree, 'see'): self.pin_tree.see(item)
            if start+200 < len(visible): self.root.after(1, lambda: append_rows(start+200))
        append_rows()

    def _pin_selected(self, event=None):
        selection = self.pin_tree.selection()
        if not selection:
            return
        pin = self.pin_item_records.get(selection[0])
        if event is not None and pin is getattr(self.view, 'selected_pin', None): return
        self._cancel_physical_trace(quiet=True)
        self.view.select_pin(pin)
        self._update_selection_inspector(pin)
        if self._physical_mode() and pin is not None:
            self._start_physical_trace(pin)

    def _clear_pin_selection(self):
        self._cancel_physical_trace(quiet=True)
        self.pin_tree.selection_remove(self.pin_tree.selection())
        self.view.select_pin(None)
        self._update_selection_inspector()
        if self._physical_mode():
            self._start_physical_trace(None)

    def _physical_mode(self):
        variable = getattr(self, 'trace_mode_value', None)
        return variable is not None and variable.get() == 'Physical geometry'

    def _set_trace_status(self, text, running=False):
        if hasattr(self, 'trace_status_value'):
            self.trace_status_value.set(text)
        if hasattr(self, 'trace_cancel_button'):
            self.trace_cancel_button.configure(state='normal' if running else 'disabled')
        if hasattr(self, 'trace_details_button'):
            self.trace_details_button.configure(state='normal' if getattr(self, 'trace_result', None) else 'disabled')

    def _show_trace_details(self):
        result = getattr(self, 'trace_result', None)
        if not result:
            return
        details = [physical_trace_summary(result), 'Scope: ' + self.trace_scope_value.get()]
        for warning in result.get('warnings') or []:
            details.append(trace_warning_text(warning))
        if result.get('reason'):
            details.append(TRACE_REASONS.get(str(result['reason']), str(result['reason'])))
        self.messagebox.showinfo('Physical trace details', '\n\n'.join(details), parent=self.root)

    def _cancel_physical_trace(self, quiet=False):
        self.trace_generation = getattr(self, 'trace_generation', 0) + 1
        cancel = getattr(self, 'trace_cancel_event', None)
        if cancel is not None:
            cancel.set()
        operation = getattr(self, 'trace_operation', None)
        if operation and operation.get('id') and not operation.get('finished'):
            def cancel_remote():
                try:
                    self.backend.cancel_operation(operation['id'])
                except Exception:
                    pass
            thread = threading.Thread(target=cancel_remote, name='vl3d-trace-cancel')
            thread.daemon = True
            thread.start()
        self.trace_cancel_event = None
        self.trace_operation = None
        self.trace_result = None
        if getattr(self, 'compiled', None) and getattr(self.view, 'physical_shape_indices', None) is not None:
            self.view.set_physical_trace([] if self._physical_mode() else None)
        if not quiet:
            self._set_trace_status('Trace canceled. Select a pin to start again.')
        else:
            self._set_trace_status('Select a pin to trace connected geometry.' if self._physical_mode()
                                   else 'Named nets follow exported electrical metadata.')

    def _trace_mode_changed(self, event=None):
        self._cancel_physical_trace(quiet=True)
        self.trace_scope_combo.configure(state='readonly' if self._physical_mode() else 'disabled')
        pin = getattr(self.view, 'selected_pin', None)
        if self.compiled:
            self.view.set_physical_trace([] if self._physical_mode() else None)
        self._update_selection_inspector(pin)
        if self._physical_mode() and pin is not None:
            self._start_physical_trace(pin)

    def _start_physical_trace(self, pin=None):
        if not self.compiled:
            return
        self._cancel_physical_trace(quiet=True)
        source = self.compiled.metadata.get('source')
        if not source or not isinstance(source, str):
            self._set_trace_status('Reload the layout to make its source available for tracing.')
            return
        if pin is None:
            pins = self.view.selected_pins()
        else:
            terminal = pin.get('terminal') or pin.get('name')
            pins = [item for item in self.compiled.metadata.get('pins') or []
                    if item.get('hierPath') == pin.get('hierPath')
                    and (item.get('terminal') or item.get('name')) == terminal] or [pin]
        if not pins:
            self._set_trace_status('This module has no pin figures. Select a module that has pins.')
            return
        if len(pins) > 256:
            self._set_trace_status('More than 256 pin figures are selected. Choose one pin or a smaller module for geometry tracing.')
            return
        scope_paths = list(self.view.selected_paths) if self.trace_scope_value.get() == 'Selected modules' else None
        cancel = threading.Event()
        self.trace_cancel_event = cancel
        generation = self.trace_generation
        compiled = self.compiled
        operation = {'id': '', 'finished': False}
        self.trace_operation = operation
        results = queue.Queue()
        self.view.set_physical_trace([])
        self._set_trace_status('Building conductor index and tracing geometry...', running=True)

        def worker():
            try:
                result = self.backend.trace_layout(source, pins, scope_paths=scope_paths,
                    operation_callback=lambda identity: operation.update(id=identity), cancel_event=cancel,
                    progress_callback=lambda progress: results.put(('progress', progress)))
                results.put(('result', result))
            except Exception as error:
                results.put(('error', error))
            finally:
                operation['finished'] = True

        thread = threading.Thread(target=worker, name='vl3d-physical-trace')
        thread.daemon = True
        thread.start()

        def poll():
            if self.closed or generation != self.trace_generation or compiled is not self.compiled:
                return
            try:
                kind, value = results.get_nowait()
            except queue.Empty:
                self.root.after(30, poll)
                return
            if kind == 'progress':
                stage = value.get('message') or value.get('phase') or value.get('stage') or 'Tracing geometry'
                if value.get('total'):
                    stage = '%s (%s/%s)' % (stage, value.get('done', 0), value['total'])
                self._set_trace_status(str(stage), running=True)
                self.root.after(30, poll)
                return
            self.trace_cancel_event = None
            self.trace_operation = None
            if kind == 'error':
                self._set_trace_status('Physical trace failed: %s' % value)
                return
            expected = compiled.metadata.get('sourceDigest')
            if expected and value.get('sourceDigest') != expected:
                self._set_trace_status('Layout source changed. Reload the layout before tracing.')
                return
            self.trace_result = value
            self.view.set_physical_trace(value.get('shapeIndices') or [])
            self._set_trace_status(physical_trace_summary(value))
            self._update_selection_inspector(pin)
        self.root.after(30, poll)

    def _update_selection_inspector(self, pin=None):
        selected = self.view.selected_paths
        pins = self.view.selected_pins()
        if not selected:
            details = 'Layout ready. Select a module in Explorer to reveal its own pins.' if self.compiled else 'Open a layout, or try the public Example.'
            note = approximate_stack_note(self.compiled.metadata if self.compiled else {})
            self.inspector_value.set(details + ('\n\n' + note if note else ''))
            self.pin_note.set('Select a module in Explorer. Each level keeps its own pins.')
            return
        details = '%d selected module%s\n%s' % (len(selected), '' if len(selected)==1 else 's', '\n'.join(selected))
        if pin is not None:
            details += '\n\nOriginal terminal: %s\nInstance: %s\nLayer: %s\nNet: %s' % (
                pin.get('terminal') or pin.get('name') or '', pin.get('hierPath') or '', pin.get('layer') or '', pin.get('net') or 'No net name')
            box = pin.get('worldBBox') or pin.get('bbox')
            if isinstance(box, dict) and len(box.get('min', []))>=2 and len(box.get('max', []))>=2:
                lower, upper = box['min'], box['max']
                unit = str(self.compiled.metadata.get('units') or 'um')
                details += '\nWorld bounds (%s, source units):\nX: %s … %s\nY: %s … %s\nBounding size: %s × %s %s' % (unit, lower[0], upper[0], lower[1], upper[1], format(upper[0]-lower[0], '.12g'), format(upper[1]-lower[1], '.12g'), unit)
            points = pin.get('worldPoints') or pin.get('points')
            if points: details += '\nOriginal figure points:\n' + json.dumps(points, ensure_ascii=False)
            for field in ('width', 'pathStyle', 'beginExt', 'endExt'):
                if field in pin: details += '\nOriginal %s: %s' % (field, pin[field])
            details += '\n\nThe ring/name are display labels; the pin footprint stays at its original coordinates and size.'
        else:
            details += '\n\nChoose a pin to trace its routes. Ctrl/Shift selects multiple modules; searching does not change the trace scope.'
        if not self._physical_mode():
            nets = self.view.selected_external_net_keys
            available = set((self.compiled.metadata if self.compiled else {}).get('netKeys') or [])
            traceable = [key for key in nets if key in available]
            details += '\n\nNamed route scopes: %d.' % len(traceable)
            if not traceable: details += ' No named routes. Switch Trace by to Physical geometry when pin figures are present.'
        note = approximate_stack_note(self.compiled.metadata if self.compiled else {})
        self.inspector_value.set(details + ('\n\n' + note if note else ''))
        if pins:
            self.pin_note.set('%d module%s · %d original pin figures' % (len(selected), '' if len(selected)==1 else 's', len(pins)))
        else:
            self.pin_note.set('No pin figures here. Choose another hierarchy level, or add source-bound pin annotations in Load setup.')

    def _render_layers(self):
        for child in self.layer_inner.winfo_children(): child.destroy()
        self.layer_variables = []
        if not self.compiled: return
        layers = self.compiled.metadata.get('layers') or []
        self.layer_variables = [self.tk.BooleanVar(value=self.view.layer_visibility.get(i, True)) for i in range(len(layers))]
        filter_value = getattr(self, 'layer_filter', None)
        mode = filter_value.get() if filter_value else 'Routing layers'
        def routing(layer): return layer.get('routing') is not False and (layer.get('routing') is True or layer.get('nativeSemantic') in ('metal', 'via', 'contact', 'poly'))
        order = sorted(range(len(layers)), key=lambda i: (not routing(layers[i]), float(layers[i].get('zBottomUm') or layers[i].get('stackIndex') or 0), str(layers[i].get('name') or '')))
        for index in order:
            layer = layers[index]
            if mode == 'Routing layers' and not routing(layer): continue
            if mode == 'Visible layers' and not self.view.layer_visibility.get(index, False): continue
            value = self.layer_variables[index]
            row = self.ttk.Frame(self.layer_inner, style='Panel.TFrame')
            row.pack(fill='x', anchor='w', pady=1)
            color = getattr(self.view, 'layer_color_hex', lambda identity: '#aaaaaa')(index)
            self.tk.Label(row, text=' ', width=2, background=color).pack(side='left', padx=(0, 4))
            self.ttk.Checkbutton(row, text=str(layer.get('name') or '?'), variable=value, style='Panel.TCheckbutton',
                command=lambda i=index, var=value: self.view.set_layer_visibility(i, var.get())).pack(side='left')
            self.ttk.Label(row, text=' · '+str(layer.get('nativeSemantic') or layer.get('kind') or ''), style='Muted.TLabel').pack(side='left')

    def _set_instances(self, visible):
        self.instances_value.set(bool(visible))
        self.view.set_instances_visible(visible)

    def _set_wires(self, visible):
        self.wires_value.set(bool(visible))
        self.view.set_wires_visible(visible)
        self.view.set_all_layers(visible)
        for layer_id, variable in enumerate(self.layer_variables):
            variable.set(bool(self.view.layer_visibility.get(layer_id, False)))

    def _z_changed(self, value):
        numeric = max(0.1, min(4.0, float(value)))
        self.z_label.configure(text='Z %.1f×' % (10.0 * numeric))
        self.view.set_z_scale(numeric)
        self.config.z_scale = numeric
        self.config_dirty = True

    def _physical_z_scale(self):
        self.z_value.set(0.1)
        self._z_changed(0.1)
        self.view.fit_layout()

    def _palette_changed(self, event=None):
        self.config.palette = PALETTE_LABELS[self.palette_value.get()]
        self.config_dirty = True
        self.view.set_palette(self.config.palette)
        self._render_layers()

    def _theme_changed(self, event=None):
        self.config.theme = self.theme_value.get().lower()
        self.config_dirty = True
        self.view.set_theme(self.config.theme)

    def open_advanced(self):
        dialog = AdvancedDialog(
            self.root, self.config.advanced, self.tk, self.ttk, self.filedialog)
        updated = dialog.show()
        if updated:
            self.config.advanced = updated
            self.view.set_resource_mode(updated.resource_mode)
            self.config_dirty = True
            if self._persist_config():
                self.status_value.set('Optional settings saved. Use Load setup to reload the source when applying discovery or resource changes.')

    def _persist_config(self):
        if not self.config_dirty:
            return True
        try:
            save_config(self.config)
        except Exception as error:
            self._show_error(error)
            return False
        self.config_dirty = False
        return True

    def _upload_progress(self, phase, completed, total):
        if total:
            percent = int(completed * 100 / total)
            if percent < 100:
                self.progress.stop()
                self.progress.configure(mode='determinate', maximum=100, value=percent)
                self.progress.pack(side='right', padx=(8, 16), pady=8)
                self.status_chip.set('running', '')
            else:
                self.progress.pack_forget()
            self.status_value.set('Preparing 3D view — %d%%' % percent)

    def _scene_ready(self, compiled):
        if self.closed or self.compiled is not compiled: return
        if getattr(self.view, '_upload_callback', None) is not None:
            self.root.after(30, lambda: self._scene_ready(compiled))
            return
        metadata = compiled.metadata
        ready = 'Ready — %s · select a module, then a pin; use Locate pin / Fit routes.' % (metadata.get('cell') or 'layout')
        note = approximate_stack_note(metadata)
        self.status_value.set(ready + (' · ' + note.replace('\n', ' ') if note else ''))

    def _capture_png(self):
        if self.compiled is None:
            self.status_value.set('Open a layout before taking a screenshot.')
            self._status_state = 'warn'
            self._status_changed()
            return None
        self.root.update_idletasks()
        width, height, rgb = self.view.capture_rgb()
        return encode_png(width, height, rgb)

    def save_screenshot(self):
        png = self._capture_png()
        if png is None:
            return
        path = self.filedialog.asksaveasfilename(
            parent=self.root, title='Save screenshot', defaultextension='.png',
            filetypes=[('PNG image', '*.png')], initialfile='layout-3d-view.png')
        if not path:
            return
        try:
            with open(path, 'wb') as handle:
                handle.write(png)
        except (IOError, OSError) as error:
            self._status_state = 'error'
            self.status_value.set('Screenshot not saved: %s. Choose a writable folder.' % error)
            return
        self._status_state = 'idle'
        self.status_value.set('Saved screenshot to %s' % os.path.basename(path))

    def copy_screenshot(self):
        png = self._capture_png()
        if png is None:
            return
        for name, command in CLIPBOARD_COMMANDS:
            executable = shutil.which(name)
            if not executable:
                continue
            try:
                process = subprocess.Popen([executable] + command[1:], stdin=subprocess.PIPE,
                                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                process.stdin.write(png)
                process.stdin.close()
            except (IOError, OSError):
                continue
            self._status_state = 'idle'
            self.status_value.set('Copied the 3D view to the clipboard (%s)' % name)
            return
        self._status_state = 'warn'
        self.status_value.set('No clipboard helper found. Install wl-clipboard or xclip, or use Save screenshot.')
        self._status_changed()

    def _draw_attitude(self, camera):
        canvas = self.attitude
        canvas.delete('all')
        width = max(10, canvas.winfo_width())
        height = max(10, canvas.winfo_height())
        center_x = width * 0.5
        center_y = height * 0.56
        eye = camera.eye()
        forward = [camera.target[index] - eye[index] for index in range(3)]
        length = math.sqrt(sum(value * value for value in forward)) or 1.0
        forward = [value / length for value in forward]
        right = [-forward[2], 0.0, forward[0]]
        right_length = math.sqrt(sum(value * value for value in right)) or 1.0
        right = [value / right_length for value in right]
        upward = [
            right[1] * forward[2] - right[2] * forward[1],
            right[2] * forward[0] - right[0] * forward[2],
            right[0] * forward[1] - right[1] * forward[0],
        ]
        axes = dict(
            (name.upper(), LAYOUT_AXIS_VECTORS[name] + (AXIS_COLORS[name],))
            for name in ('x', 'y', 'z')
        )
        canvas.create_line(12, center_y, width - 12, center_y, fill=fw.LINE, dash=(3, 4))
        for label, values in axes.items():
            vector = values[:3]
            color = '#%02x%02x%02x' % tuple(int(component * 255) for component in values[3])
            horizontal = sum(vector[index] * right[index] for index in range(3))
            vertical = sum(vector[index] * upward[index] for index in range(3))
            ending_x = center_x + horizontal * 48
            ending_y = center_y - vertical * 48
            canvas.create_line(center_x, center_y, ending_x, ending_y, fill=color, width=3, arrow='last')
            canvas.create_text(ending_x, ending_y, text=label, fill=color, anchor='sw')
        canvas.create_oval(center_x - 3, center_y - 3, center_x + 3, center_y + 3, fill=fw.DIM, outline='')

    def close(self):
        self._cancel_physical_trace(quiet=True)
        self._persist_config()
        self.closed = True
        self.cancel_event.set()
        if self.compile_job is not None:
            self.compile_job.cancel()
        if self.active_operation:
            operation_id = self.active_operation
            thread = threading.Thread(target=lambda: self.backend.cancel_operation(operation_id))
            thread.daemon = True
            thread.start()
        if self.session and self.session.get('sessionId'):
            session_id = self.session['sessionId']
            thread = threading.Thread(target=lambda: self.backend.delete_library_session(session_id))
            thread.daemon = True
            thread.start()
        self.root.destroy()


def _install_callback_exception_handler(root, application):
    state = {'error': None, 'handling': False}

    def report(exception_type, value, traceback_value):
        if state['handling'] or state['error'] is not None:
            return
        error = value if isinstance(value, Vl3dError) else Vl3dError('E9001', str(value))
        state['handling'] = True
        state['error'] = error
        try:
            application._show_error(error)
        except Exception:
            pass
        finally:
            state['handling'] = False
            try:
                root.after_idle(application.close)
            except Exception:
                try:
                    root.destroy()
                except Exception:
                    pass

    root.report_callback_exception = report
    return state


def run(options, input_stream=None):
    bootstrap = read_bootstrap(options, input_stream=input_stream)
    config = load_config(bootstrap.get('configFile') or options.config or None)
    apply_advanced_settings(config, bootstrap.get('advancedSettings'))
    error = dependency_error()
    if error:
        raise error
    try:
        import tkinter
        from tkinter import filedialog, messagebox, simpledialog, ttk
    except ImportError as error:
        raise Vl3dError('E8008', 'Tkinter is unavailable: %s' % error)
    backend = BackendClient(bootstrap['backendUrl'], bootstrap['token'])
    root = tkinter.Tk()
    application = NativeApplication(
        root, os.path.realpath(options.root), backend, config, tkinter, ttk,
        filedialog, messagebox, simpledialog)
    callback_state = _install_callback_exception_handler(root, application)
    root.mainloop()
    if callback_state['error'] is not None:
        raise callback_state['error']
    return 0


def main(argv=None, input_stream=None):
    options = argument_parser().parse_args(argv)
    try:
        return run(options, input_stream=input_stream)
    except Vl3dError as error:
        sys.stderr.write(str(error) + '\n')
        return 2
    except Exception as error:
        sys.stderr.write('VL3D-E9001 %s\n' % error)
        return 3


if __name__ == '__main__':
    sys.exit(main())
