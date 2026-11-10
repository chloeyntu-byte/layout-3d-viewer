from __future__ import absolute_import

import unittest
import threading
import time
from types import SimpleNamespace

from native.app import NativeApplication
from native.gl_view import LayoutGLView
from native.selection import connected_net_keys, selected_pins


class Value(object):
    def __init__(self, value=''):
        self.value = value

    def get(self):
        return self.value

    def set(self, value):
        self.value = value


class Tree(object):
    def __init__(self):
        self.rows = {}
        self.selected = []
        self.next_id = 0

    def insert(self, parent, position, **options):
        self.next_id += 1
        key = str(self.next_id)
        self.rows[key] = dict(options, parent=parent)
        return key

    def get_children(self, parent):
        return [key for key, value in self.rows.items() if value['parent'] == parent]

    def delete(self, key):
        for child in list(self.get_children(key)):
            self.delete(child)
        self.rows.pop(key, None)
        self.selected = [item for item in self.selected if item != key]

    def item(self, key, option):
        return self.rows[key].get(option, False)

    def selection(self):
        return tuple(self.selected)

    def selection_set(self, values):
        self.selected = list(values)

    def see(self, item):
        self.seen = item

    def selection_remove(self, values):
        self.selected = [item for item in self.selected if item not in values]


class View(object):
    def __init__(self, metadata):
        self.metadata = metadata
        self.selected_paths = []
        self.selected_external_net_keys = []
        self.pin = None
        self.selected_pin = None
        self.physical_shape_indices = None

    def select_hierarchy(self, paths):
        self.selected_paths = list(paths)
        self.select_pin(None)

    def selected_pins(self):
        return selected_pins(self.metadata, self.selected_paths)

    def set_physical_trace(self, indices=None):
        self.physical_shape_indices = indices

    def select_pin(self, pin):
        self.selected_pin = pin
        self.physical_shape_indices = None
        self.pin = pin
        self.selected_external_net_keys = connected_net_keys(
            self.metadata, self.selected_paths, None if pin is None else [pin])


class AppSelectionTests(unittest.TestCase):
    def setUp(self):
        pins = [{'hierPath': 'TOP/U1', 'terminal': 'P%d' % number, 'net': 'N%d' % number, 'layer': 'M1'}
                for number in range(250)]
        self.metadata = {'cell': 'TOP', 'pins': pins, 'hierarchyPaths': ['TOP', 'TOP/U1'],
                         'netKeys': ['TOP/U1::N%d' % number for number in range(250)]}
        app = NativeApplication.__new__(NativeApplication)
        app.compiled = SimpleNamespace(metadata=self.metadata)
        app.view = View(self.metadata)
        app.hierarchy = Tree()
        item = app.hierarchy.insert('', 'end', text='U1')
        app.hierarchy_item_paths = {item: 'TOP/U1'}
        app.hierarchy.selection_set([item])
        app.hierarchy_search = Value('')
        app.depth_value = Value(3)
        app.pin_tree = Tree()
        app.pin_item_records = {}
        app._pin_list_generation = 0
        app.inspector_value = Value()
        app.pin_note = Value()
        app.closed = False
        self.pending = []
        app.root = SimpleNamespace(after=lambda delay, callback: self.pending.append(callback))
        self.app = app

    def drain(self):
        while self.pending:
            self.pending.pop(0)()

    def test_all_pins_accessible_and_selectable_after_first_120(self):
        self.app._hierarchy_selected()
        self.drain()
        self.assertEqual(len(self.app.pin_item_records), 250)
        item = next(key for key, pin in self.app.pin_item_records.items() if pin['terminal'] == 'P249')
        self.app.pin_tree.selection_set([item])
        self.app._pin_selected()
        self.assertEqual(self.app.view.selected_external_net_keys, ['TOP/U1::N249'])
        self.assertEqual(len(self.app.view.selected_pins()), 250)
        self.assertIn('P249', self.app.inspector_value.get())
        self.app._clear_pin_selection()
        self.assertEqual(len(self.app.view.selected_external_net_keys), 250)

    def test_stale_batched_pin_rows_do_not_survive_new_selection(self):
        self.app._hierarchy_selected()
        self.app.hierarchy.selection_remove(self.app.hierarchy.selection())
        self.app._hierarchy_selected()
        self.drain()
        self.assertEqual(self.app.pin_item_records, {})
        self.assertEqual(self.app.pin_tree.rows, {})

    def test_search_rebuild_keeps_selected_module_and_active_pin(self):
        self.app._hierarchy_selected()
        self.drain()
        pin = self.metadata['pins'][0]
        self.app.view.select_pin(pin)
        self.app.hierarchy_search.set('nothing')
        self.app._render_hierarchy()
        self.app._hierarchy_selected(event=object())
        self.assertIs(self.app.view.pin, pin)
        self.assertEqual(self.app.view.selected_paths, ['TOP/U1'])


    def test_pin_names_figures_and_source_geometry_are_preserved(self):
        import copy
        original = {'hierPath': 'TOP/U1', 'terminal': ' A<3>/α ', 'layer': 'M1',
                    'worldBBox': {'min': [1.125, -2.5], 'max': [1.625, -1.75]}}
        self.metadata['pins'] = [original, dict(original, layer='M2')]
        snapshot = copy.deepcopy(self.metadata['pins'])
        self.app._hierarchy_selected()
        self.drain()
        rows = [self.app.pin_tree.rows[item] for item in self.app.pin_item_records]
        self.assertEqual([row['text'] for row in rows], [' A<3>/α ', ' A<3>/α '])
        self.assertEqual([row['values'][1] for row in rows], ['1/2', '2/2'])
        self.app._update_selection_inspector(original)
        self.assertIn('1.125', self.app.inspector_value.get())
        self.assertIn('0.5 × 0.75 um', self.app.inspector_value.get())
        self.assertEqual(self.metadata['pins'], snapshot)

    def test_label_click_restores_filtered_late_batch_pin_without_duplicate_trace(self):
        self.app.pin_search = Value('P0')
        self.app._show_dock = lambda side: None
        self.app.trace_mode_value = Value('Physical geometry')
        requests = []
        self.app._start_physical_trace = requests.append
        self.app._hierarchy_selected()
        original = self.metadata['pins'][249]
        self.app._select_pin_record(original)
        self.drain()
        selected = self.app.pin_tree.selection()[0]
        self.assertIs(self.app.pin_item_records[selected], original)
        self.assertEqual(self.app.pin_search.get(), '')
        self.app._pin_selected(event=object())
        self.assertEqual(requests, [original])
        self.assertEqual(self.app.view.selected_paths, ['TOP/U1'])

    def test_cancel_file_picker_does_not_load_previous_source(self):
        self.app.busy = False
        self.app.load_mode = Value()
        self.app._refresh_load_fields = lambda: None
        self.app._toggle_load_setup = lambda value: None
        self.app._browse_source = lambda: False
        calls = []
        self.app._load_source = lambda: calls.append(True)
        self.app.open_file()
        self.assertEqual(calls, [])

    def test_canceled_background_result_cannot_replace_current_layout(self):
        self.app.busy = False
        self.app._load_generation = 0
        self.app.cancel_event = threading.Event()
        self.app.compile_job = None
        self.app.active_operation = ''
        self.app._set_busy = lambda value, message='': setattr(self.app, 'busy', value)
        started, release, finished = threading.Event(), threading.Event(), threading.Event()
        accepted = []
        def work():
            started.set()
            release.wait(2)
            finished.set()
            return 'old result'
        self.app._background('Importing stream layout', work, accepted.append)
        self.assertTrue(started.wait(1))
        self.app._cancel_loading()
        self.assertFalse(self.app.busy)
        release.set()
        self.assertTrue(finished.wait(1))
        self.drain()
        self.assertEqual(accepted, [])
        self.assertTrue(self.app.cancel_event.is_set())


    def test_new_file_dispatch_keeps_existing_oa_context_until_success(self):
        app = self.app
        app.busy = False
        app.load_mode, app.load_path = Value('Layout file'), Value('/tmp/new.json')
        app.load_values = {'pin_annotations': Value('')}
        app._capture_load_inputs = lambda: None
        app.session = {'sessionId': 'previous-oa'}
        app.records = [{'cell': 'OLD'}]
        app.cell_value = Value('OLD')
        requests = []
        app._compile_path = requests.append
        app._load_source()
        self.assertEqual(requests, ['/tmp/new.json'])
        self.assertEqual(app.session['sessionId'], 'previous-oa')
        self.assertEqual(app.records, [{'cell': 'OLD'}])
        self.assertEqual(app.cell_value.get(), 'OLD')
        self.assertTrue(app._pending_clear_library)

    def test_json_loading_does_not_offer_ineffective_layer_remapping(self):
        app = self.app
        class Row(object):
            visible = False
            def grid(self): self.visible = True
            def grid_remove(self): self.visible = False
        app.session = None
        app.load_mode, app.load_path = Value('Layout file'), Value('/tmp/chip.json')
        app.cell_row = Row()
        app.load_rows = {name: Row() for name in ('cds_lib', 'cadence_env', 'pdk_profile', 'stream_layer_map', 'pin_annotations')}
        app.load_hint = Value()
        app._refresh_load_fields()
        self.assertTrue(app.load_rows['pin_annotations'].visible)
        self.assertFalse(app.load_rows['pdk_profile'].visible)
        self.assertFalse(app.load_rows['stream_layer_map'].visible)
        self.assertIn('embedded layer rules', app.load_hint.get())
        app.load_path.set('/tmp/chip.gds')
        app._refresh_load_fields()
        self.assertTrue(app.load_rows['pdk_profile'].visible)
        self.assertTrue(app.load_rows['stream_layer_map'].visible)


class TraceBackend(object):
    def __init__(self, result):
        self.result = result
        self.started = threading.Event()
        self.release = threading.Event()
        self.finished = threading.Event()
        self.pins = None
        self.canceled = []

    def trace_layout(self, path, pins, **options):
        self.pins = pins
        options['operation_callback']('op-physical')
        self.started.set()
        self.release.wait(2)
        self.finished.set()
        return self.result

    def cancel_operation(self, identity):
        self.canceled.append(identity)


class PhysicalTraceUITests(unittest.TestCase):
    drain = AppSelectionTests.drain
    def setUp(self):
        AppSelectionTests.setUp(self)
        self.metadata.update(source='/tmp/source-layout.json', sourceDigest='source-hash')
        self.app.trace_mode_value = Value('Physical geometry')
        self.app.trace_scope_value = Value('Whole layout')
        self.app.trace_status_value = Value()
        self.app.backend = TraceBackend({'status': 'complete', 'complete': True,
            'sourceDigest': 'source-hash', 'shapeIndices': [0, 5]})
        self.app.view.select_hierarchy(['TOP/U1'])

    def finish_callbacks(self, predicate):
        deadline = time.monotonic() + 2
        while not predicate() and time.monotonic() < deadline:
            if self.pending:
                self.pending.pop(0)()
            time.sleep(0.001)
        self.assertTrue(predicate())

    def tearDown(self):
        self.app.backend.release.set()

    def test_geometry_result_highlights_shape_ordinals_without_replacing_pins(self):
        self.app._start_physical_trace(self.metadata['pins'][0])
        self.assertTrue(self.app.backend.started.wait(1))
        self.app.backend.release.set()
        self.finish_callbacks(lambda: self.app.trace_result is not None)
        self.assertEqual(self.app.view.physical_shape_indices, [0, 5])
        self.assertEqual(len(self.app.view.selected_pins()), 250)
        self.assertIn('Complete within', self.app.trace_status_value.get())

    def test_canceled_result_never_replaces_current_highlight(self):
        self.app._start_physical_trace(self.metadata['pins'][0])
        self.assertTrue(self.app.backend.started.wait(1))
        self.app._cancel_physical_trace()
        self.app.backend.release.set()
        self.assertTrue(self.app.backend.finished.wait(1))
        self.drain()
        self.assertIsNone(self.app.trace_result)
        self.assertEqual(self.app.view.physical_shape_indices, [])
        self.assertIn('canceled', self.app.trace_status_value.get())

    def test_source_digest_mismatch_does_not_apply_shape_indices(self):
        self.app.backend.result['sourceDigest'] = 'different-source'
        self.app._start_physical_trace(self.metadata['pins'][0])
        self.assertTrue(self.app.backend.started.wait(1))
        self.app.backend.release.set()
        self.finish_callbacks(lambda: self.app.trace_operation is None)
        self.assertIsNone(self.app.trace_result)
        self.assertEqual(self.app.view.physical_shape_indices, [])
        self.assertIn('Reload', self.app.trace_status_value.get())

    def test_limited_trace_is_usable_but_labeled_incomplete(self):
        self.app.backend.result.update(status='limited', complete=False, reason='Shape limit reached')
        self.app._start_physical_trace(self.metadata['pins'][0])
        self.assertTrue(self.app.backend.started.wait(1))
        self.app.backend.release.set()
        self.finish_callbacks(lambda: self.app.trace_result is not None)
        self.assertEqual(self.app.view.physical_shape_indices, [0, 5])
        self.assertIn('Incomplete', self.app.trace_status_value.get())


class ZScaleControlTests(unittest.TestCase):
    def test_effective_scale_label_and_physical_button(self):
        app = NativeApplication.__new__(NativeApplication)
        app.config = SimpleNamespace(z_scale=1.0)
        app.config_dirty = False
        app.z_value = Value(1.0)
        labels = {}
        changes = []
        fits = []
        app.z_label = SimpleNamespace(configure=lambda **options: labels.update(options))
        app.view = SimpleNamespace(set_z_scale=changes.append, fit_layout=lambda: fits.append(True))
        app._z_changed(1.0)
        self.assertEqual(labels['text'], 'Z 10.0\u00d7')
        self.assertEqual(app.config.z_scale, 1.0)
        app._physical_z_scale()
        self.assertEqual(app.z_value.get(), 0.1)
        self.assertEqual(app.config.z_scale, 0.1)
        self.assertEqual(changes[-1], 0.1)
        self.assertEqual(labels['text'], 'Z 1.0\u00d7')
        self.assertTrue(fits)
        self.assertTrue(app.config_dirty)


class LayerVisibilityControlTests(unittest.TestCase):
    def test_wire_all_enables_conductors_and_checkboxes_match_the_view(self):
        app = NativeApplication.__new__(NativeApplication)
        app.wires_value = Value(True)
        app.layer_variables = [Value(True), Value(False), Value(False)]
        view = SimpleNamespace(
            layer_visibility={0: True, 1: False, 2: False},
            metadata={'layers': [
                {'name': 'M1', 'nativeSemantic': 'metal', 'routing': True},
                {'name': 'AA', 'nativeSemantic': 'active', 'routing': False},
                {'name': 'NW', 'nativeSemantic': 'auxiliary', 'routing': False},
            ]},
            request_redraw=lambda: None)
        view.set_wires_visible = lambda visible: LayoutGLView.set_wires_visible(view, visible)
        view.set_all_layers = lambda visible: LayoutGLView.set_all_layers(view, visible)
        app.view = view
        app._set_wires(False)
        self.assertEqual([value.get() for value in app.layer_variables], [False, False, False])
        app._set_wires(True)
        self.assertTrue(app.wires_value.get())
        self.assertEqual([value.get() for value in app.layer_variables], [True, False, False])
        self.assertEqual(view.layer_visibility, {0: True, 1: False, 2: False})
        # A deliberate per-layer inspection remains available.
        LayoutGLView.set_layer_visibility(view, 1, True)
        self.assertTrue(view.layer_visibility[1])


if __name__ == '__main__':
    unittest.main()
