from __future__ import absolute_import

import copy
import json
import os
import shutil
import tempfile
import unittest

import numpy

from native.gl_view import LayoutGLView
from native.compiler import compile_layout
from native.physical_trace import PhysicalTraceIndex
from native.navigation import CameraState
from native.pin_presentation import pin_annotations, pin_bounds, pin_name, place_labels


def source_pin(name='A<3>', x=0, path='TOP/U1'):
    return {'terminal': name, 'name': name, 'hierPath': path, 'layer': 'M2',
            'points': [[x, 1], [x + 1, 0], [x + 2, 1], [x + 1, 2]],
            'worldBBox': {'min': [x, 0], 'max': [x + 2, 2]}}


class PresentationTests(unittest.TestCase):
    def test_source_names_and_rotated_footprints_are_never_changed(self):
        pins = [source_pin(' A<3> '), source_pin(u'\u8f93\u5165+', x=5)]
        original = copy.deepcopy(pins)
        annotations = pin_annotations(pins, pins[1])
        self.assertEqual(pins, original)
        self.assertEqual(annotations[0]['name'], ' A<3> ')
        self.assertEqual(annotations[1]['name'], u'\u8f93\u5165+')
        self.assertEqual(annotations[0]['rings'], [[(0., 1.), (1., 0.), (2., 1.), (1., 2.)]])
        self.assertIs(annotations[0]['source'], pins[0])
        self.assertIs(annotations[1]['source'], pins[1])
        self.assertTrue(annotations[1]['active'])
        self.assertFalse(annotations[0]['active'])

    def test_same_terminal_figures_keep_individual_identity_and_separate_number(self):
        pins = [source_pin('D'), source_pin('D', 8), source_pin('D', 8, 'TOP/U2')]
        annotations = pin_annotations(pins, pins[1])
        self.assertEqual([item['name'] for item in annotations], ['D', 'D', 'D'])
        self.assertEqual([item['figureNumber'] for item in annotations], [1, 2, 1])
        self.assertEqual([item['figureCount'] for item in annotations], [2, 2, 1])
        self.assertEqual([item['bounds'] for item in annotations], [(0, 0, 2, 2), (8, 0, 10, 2), (8, 0, 10, 2)])

    def test_path_pin_keeps_centerline_and_uses_width_and_explicit_end_extensions(self):
        pin = {'terminal': ' OUT<2> ', 'hierPath': 'TOP/A', 'layer': 'M1',
               'type': 'path', 'points': [[0, 0], [4, 0]], 'width': 2,
               'pathStyle': 'flush', 'beginExt': 0.5, 'endExt': 1.0}
        original = copy.deepcopy(pin)
        annotation = pin_annotations([pin], pin)[0]
        self.assertIs(annotation['source'], pin)
        self.assertEqual(annotation['name'], ' OUT<2> ')
        numpy.testing.assert_allclose(annotation['bounds'], [-0.5, -1, 5, 1])
        self.assertGreaterEqual(len(annotation['rings'][0]), 4)
        self.assertEqual(pin, original)
        view = HeadlessView()
        self.assertTrue(LayoutGLView.fit_pin(view, pin))
        self.assertAlmostEqual(view.camera.target[0], 2.25)
        self.assertAlmostEqual(view.camera.target[2], 0)
        self.assertEqual(pin, original)

    def test_bent_path_pin_uses_real_extended_caps_instead_of_closing_centerline(self):
        for style in ('extend', 'extended', 'round'):
            pin = {'terminal': 'P', 'figType': 'path', 'width': 0.2,
                   'worldPoints': [[0, 0], [4, 0], [4, 4], [0, 4]], 'pathStyle': style}
            original = copy.deepcopy(pin)
            annotation = pin_annotations([pin])[0]
            self.assertGreater(len(annotation['rings'][0]), 4)
            numpy.testing.assert_allclose(annotation['bounds'], [-0.1, -0.1, 4.1, 4.1], atol=0.001)
            self.assertEqual(pin, original)

    def test_oa_pathseg_boundary_is_not_extruded_a_second_time(self):
        pin = {'terminal': 'P', 'type': 'polygon', 'sourceType': 'pathSeg',
               'points': [[0, 0], [4, 0], [3, 2], [1, 2]],
               'width': 0, 'sourceWidth': 3, 'beginExt': 2, 'endExt': 2}
        original = copy.deepcopy(pin)
        annotation = pin_annotations([pin])[0]
        self.assertEqual(annotation['rings'], [[(0., 0.), (4., 0.), (3., 2.), (1., 2.)]])
        self.assertEqual(annotation['bounds'], (0, 0, 4, 2))
        self.assertEqual(pin, original)

    def test_compiled_pin_roundtrip_preserves_extensions_used_by_physical_seed(self):
        pin = {'terminal': 'CAP_END', 'hierPath': 'TOP', 'layer': 'M1',
               'type': 'path', 'points': [[0, 0], [4, 0]], 'width': 2,
               'pathStyle': 'flush', 'beginExt': 0.5, 'endExt': 1.0,
               'bbox': {'min': [-0.5, -1], 'max': [5, 1]}}
        layout = {'schemaVersion': 2, 'cell': 'TOP', 'units': 'um',
                  'layers': [{'name': 'M1', 'kind': 'metal', 'routing': True}],
                  'pins': [pin], 'shapes': [{'type': 'rect', 'layer': 'M1', 'hierPath': 'TOP',
                                          'bbox': {'min': [4.5, -0.2], 'max': [4.9, 0.2]}}],
                  'deviceScopes': {}, 'deviceMetadataComplete': True, 'deviceBoundaryComplete': True}
        original = copy.deepcopy(layout)
        directory = tempfile.mkdtemp(prefix='vl3d-pin-path-')
        try:
            source = os.path.join(directory, 'source.json')
            with open(source, 'w') as handle:
                json.dump(layout, handle)
            target = os.path.join(directory, 'compiled')
            compile_layout(source, target, 'pin-cap-contract')
            with open(os.path.join(target, 'meta.json')) as handle:
                stored = json.load(handle)
            self.assertEqual(stored['pins'], layout['pins'])
            numpy.testing.assert_allclose(pin_bounds(stored['pins'][0]), [-0.5, -1, 5, 1])
            index = PhysicalTraceIndex.from_layout(source)
            result = index.trace(stored['pins'])
            self.assertEqual(result['shapeIndices'], [0])
            self.assertTrue(result['complete'])
            truncated = copy.deepcopy(stored['pins'])
            truncated[0]['endExt'] = 0
            self.assertEqual(index.trace(truncated)['status'], 'no_seed')
            self.assertEqual(layout, original)
            with open(source) as handle:
                self.assertEqual(json.load(handle), original)
        finally:
            shutil.rmtree(directory)

    def test_current_pin_beyond_label_limit_is_always_prioritized(self):
        candidates = [{'sourceIndex': i, 'active': i == 90, 'name': 'P%d' % i,
                       'anchor': (300, 200, 100), 'size': (100, 36)} for i in range(100)]
        original = copy.deepcopy(candidates)
        labels = place_labels(candidates, 640, 480, limit=8)
        self.assertEqual(labels[0]['sourceIndex'], 90)
        self.assertTrue(labels[0]['active'])
        self.assertEqual(candidates, original)
        self.assertLessEqual(len(labels), 8)
        for first_index, first in enumerate(labels):
            a = first['box']
            self.assertGreaterEqual(a[0], 8)
            self.assertLessEqual(a[2], 632)
            for second in labels[first_index + 1:]:
                b = second['box']
                self.assertFalse(a[0] < b[2] and a[2] > b[0] and a[1] < b[3] and a[3] > b[1])

    def test_offscreen_current_pin_has_edge_callout_without_changing_anchor(self):
        pin = source_pin()
        candidate = {'source': pin, 'sourceIndex': 0, 'active': True,
                     'anchor': (-200, 150, 10), 'size': (140, 38), 'name': pin_name(pin)}
        result = place_labels([candidate], 320, 240)[0]
        self.assertTrue(result['offscreen'])
        self.assertEqual(result['anchor'], (-200, 150, 10))
        self.assertEqual(result['screenAnchor'], (8, 150))
        self.assertIs(result['source'], pin)
        self.assertEqual(pin_bounds(pin), (0, 0, 2, 2))

    def test_projection_maps_target_and_respects_viewport_aspect(self):
        camera = CameraState(yaw=0, pitch=0.5, distance=50, target=[2, 3, 4])
        projected = camera.project(camera.target, 800, 600)
        self.assertAlmostEqual(projected[0], 400)
        self.assertAlmostEqual(projected[1], 300)
        right = camera.project([3, 3, 4], 800, 600)
        self.assertGreater(right[0], 400)
        narrow = camera.project([3, 3, 4], 400, 600)
        self.assertAlmostEqual(right[0] - 400, narrow[0] - 200)
        eye = camera.eye()
        behind = [eye[i] + (eye[i] - camera.target[i]) for i in range(3)]
        self.assertIsNone(camera.project(behind, 800, 600))

    def test_explicit_camera_history_restores_pose_and_does_not_alias_target(self):
        camera = CameraState()
        original = camera.snapshot()
        camera.remember_view()
        camera.fit_bounds((10, 20, 30, 40), 0, 5, aspect=.5)
        self.assertNotEqual(original, camera.snapshot())
        self.assertTrue(camera.previous_view())
        self.assertEqual(original, camera.snapshot())
        self.assertFalse(camera.previous_view())
        for value in range(30):
            camera.distance = value + 1
            camera.remember_view()
        self.assertEqual(len(camera.history), 16)


class HeadlessView(object):
    _focus_bounds = LayoutGLView._focus_bounds
    _selection_bounds = LayoutGLView._selection_bounds
    fit_layout = LayoutGLView.fit_layout
    def __init__(self):
        self.camera = CameraState()
        self.metadata = {'layers': [{'name': 'M2', 'nativeBottomUm': 2, 'nativeTopUm': 2.5}]}
        self.arrays = {}
        self.z_scale = .1
        self._stack_top = 3
        self._bounds = (0, 0, 100, 100)
        self.selected_pin = None
        self._net_rects = None
        self._net_outline_indices = None
        self._selected_rects = None
        self._selected_outline_indices = None
        self.selected_paths = []
        self.changes = 0
    def winfo_width(self): return 400
    def winfo_height(self): return 600
    def _camera_changed(self): self.changes += 1
    def request_redraw(self): pass


class FitTests(unittest.TestCase):
    def test_pin_fit_changes_camera_only_and_can_return_to_previous_view(self):
        view = HeadlessView()
        pin = source_pin()
        original_pin = copy.deepcopy(pin)
        original_camera = view.camera.snapshot()
        self.assertTrue(LayoutGLView.fit_pin(view, pin))
        self.assertEqual(pin, original_pin)
        self.assertEqual(view.camera.target, [1, 2.25, -1])
        self.assertTrue(LayoutGLView.previous_view(view))
        self.assertEqual(view.camera.snapshot(), original_camera)

    def test_trace_fit_contains_rectangles_and_polygon_fragments(self):
        view = HeadlessView()
        view._net_rects = numpy.asarray([[10, 20, 30, 40, 1, 2]], dtype=float)
        view.arrays = {'outline_vertices': numpy.asarray([[50, 60, 3], [55, 60, 3], [55, 62, 3]]),
                       'outline_offsets': numpy.asarray([0, 3])}
        view._net_outline_indices = numpy.asarray([0])
        self.assertTrue(LayoutGLView.fit_trace(view))
        self.assertEqual(view.camera.target, [32.5, 2, -41])
        for point in [(10, 1, -20), (30, 2, -40), (55, 3, -62)]:
            x, y, depth = view.camera.project(point, 400, 600)
            self.assertTrue(0 <= x <= 400 and 0 <= y <= 600)
            self.assertGreater(depth, 0)

    def test_polygon_only_trace_fit_preserves_full_layer_thickness(self):
        view = HeadlessView()
        view.metadata['layers'] = [{'nativeBottomUm': 0, 'nativeTopUm': 100}]
        view.arrays = {'outline_vertices': numpy.asarray([[0, 0, 100], [1, 0, 100], [1, 1, 100]]),
                       'outline_offsets': numpy.asarray([0, 3]), 'outline_layers': numpy.asarray([0])}
        view._net_outline_indices = numpy.asarray([0])
        self.assertTrue(LayoutGLView.fit_trace(view))
        self.assertEqual(view.camera.target[1], 50)
        for height in (0, 100):
            x, y, depth = view.camera.project((.5, height, -.5), 400, 600)
            self.assertTrue(0 <= x <= 400 and 0 <= y <= 600)

    def test_fitting_same_view_does_not_add_a_noop_to_back_history(self):
        view = HeadlessView()
        view.fit_layout(remember=False)
        view.fit_layout()
        self.assertFalse(view.camera.history)

    def test_single_pin_selection_preserves_camera_and_source(self):
        view = HeadlessView()
        view._update_selection = lambda: None
        pin = source_pin()
        original = copy.deepcopy(pin)
        before = view.camera.snapshot()
        LayoutGLView.select_pin(view, pin)
        self.assertIs(view.selected_pin, pin)
        self.assertEqual(pin, original)
        self.assertEqual(view.camera.snapshot(), before)
        self.assertFalse(view.camera.history)

    def test_missing_selection_does_not_change_camera(self):
        view = HeadlessView()
        before = view.camera.snapshot()
        self.assertFalse(LayoutGLView.fit_pin(view))
        self.assertFalse(LayoutGLView.fit_trace(view))
        self.assertFalse(LayoutGLView.fit_selected_modules(view))
        self.assertEqual(before, view.camera.snapshot())
        self.assertFalse(view.camera.history)


if __name__ == '__main__':
    unittest.main()
