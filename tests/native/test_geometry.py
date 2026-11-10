from __future__ import absolute_import

import json
import math
import os
import shutil
import tempfile
import unittest

import gdstk
import numpy

from native.compiler import (_axis_rectangle, _compile_arrays, _layer_stack,
                             _path_footprints, _polygon_area, _triangulate)
from native.errors import Vl3dError
from native.navigation import CameraState


class FakeIjson(object):
    @staticmethod
    def items(handle, prefix, use_float=True):
        return iter(json.load(handle).get('shapes') or [])


def triangle_area(vertices):
    return sum(abs(_polygon_area(vertices[i:i + 3])) for i in range(0, len(vertices), 3))


class GeometryTests(unittest.TestCase):
    def compile_shapes(self, shapes, layers=None):
        directory = tempfile.mkdtemp(prefix='vl3d-geometry-')
        try:
            source = os.path.join(directory, 'layout.json')
            with open(source, 'w') as handle:
                json.dump({'shapes': shapes}, handle)
            stack = _layer_stack(layers or [{'name': 'M1', 'kind': 'metal', 'thickness': 0.25}])
            arrays, unused_paths, unused_nets, unused_lod = _compile_arrays(
                source, {'instances': [], 'dbuPerMicron': 1000}, stack, FakeIjson, numpy)
            return arrays, stack
        finally:
            shutil.rmtree(directory)

    def test_concave_polygon_keeps_notch_and_large_origin(self):
        points = [(0, 0), (4, 0), (4, 1), (1, 1), (1, 4), (0, 4)]
        for offset in (0, 100000000):
            shifted = [(x + offset, y + offset) for x, y in points]
            for polygon in (shifted, list(reversed(shifted))):
                triangles = _triangulate(polygon)
                self.assertAlmostEqual(triangle_area(triangles), 7.0)
                for i in range(0, len(triangles), 3):
                    center = [sum(p[a] - offset for p in triangles[i:i + 3]) / 3 for a in (0, 1)]
                    self.assertFalse(center[0] > 1 and center[1] > 1)

    def test_crossed_boundary_is_not_a_rectangle_or_filled_fan(self):
        crossed = [[0, 0], [2, 2], [0, 2], [2, 0]]
        self.assertFalse(_axis_rectangle(crossed))
        with self.assertRaises(Vl3dError):
            _triangulate(crossed)

    def test_gds_bridged_hole_keeps_empty_interior(self):
        polygon = gdstk.boolean(gdstk.rectangle((0, 0), (5, 5)),
                               gdstk.rectangle((1, 1), (4, 4)), 'not')[0]
        triangles = _triangulate(polygon.points.tolist())
        self.assertAlmostEqual(triangle_area(triangles), 16.0)
        for i in range(0, len(triangles), 3):
            center = [sum(p[a] for p in triangles[i:i + 3]) / 3 for a in (0, 1)]
            self.assertFalse(1 < center[0] < 4 and 1 < center[1] < 4)

    def test_path_bend_has_continuous_miter_and_flush_ends(self):
        footprints = _path_footprints([(0, 0), (4, 0), (4, 4)], 2)
        self.assertEqual(len(footprints), 1)
        self.assertAlmostEqual(abs(_polygon_area(footprints[0])), 16.0)
        self.assertIn((5.0, -1.0), footprints[0])
        self.assertIn((3.0, 1.0), footprints[0])
        self.assertEqual(min(p[0] for p in footprints[0]), 0.0)

    def test_self_touching_path_keeps_ring_hole_without_roundoff_gap(self):
        # Synthetic almost-closed route: its end touches the first segment edge.
        x, y, length, rise, width = 100.1, 20.3, 6.7, 2.9, 0.3
        points = [(x, y), (x + length, y), (x + length, y + rise),
                  (x + width / 2, y + rise), (x + width / 2, y + width / 2)]
        footprints = _path_footprints(points, width)
        self.assertEqual(len(footprints), 1)
        triangles = _triangulate(footprints[0])
        self.assertAlmostEqual(triangle_area(triangles), width * (2 * length + 2 * rise - width), places=7)

    def test_path_explicit_end_extensions_are_preserved(self):
        points = _path_footprints([(0, 0), (4, 0)], 2, {'beginExt': 0.5, 'endExt': 1.0})[0]
        self.assertEqual(min(p[0] for p in points), -0.5)
        self.assertEqual(max(p[0] for p in points), 5.0)

    def test_four_point_path_is_not_replaced_by_its_bbox(self):
        arrays, unused_stack = self.compile_shapes([{
            'type': 'path', 'layer': 'M1', 'width': 0.2,
            'bbox': {'min': [-0.1, -0.1], 'max': [4.1, 4.1]},
            'points': [[0, 0], [4, 0], [4, 4], [0, 4]],
        }])
        self.assertEqual(len(arrays['rects']), 0)
        self.assertGreater(len(arrays['triangle_vertices']), 0)

    def test_explicit_hole_solid_has_both_caps(self):
        arrays, unused_stack = self.compile_shapes([{
            'type': 'polygon', 'layer': 'M1', 'bbox': {'min': [0, 0], 'max': [5, 5]},
            'points': [[0, 0], [5, 0], [5, 5], [0, 5]],
            'holes': [[[1, 1], [4, 1], [4, 4], [1, 4]]],
        }])
        self.assertEqual(len(arrays['rects']), 0)
        vertices = arrays['triangle_vertices'].reshape((-1, 3, 3))
        for height in (0.0, 0.25):
            caps = [triangle[:, :2].tolist() for triangle in vertices if all(triangle[:, 2] == height)]
            self.assertAlmostEqual(sum(triangle_area(cap) for cap in caps), 16.0)

    def test_legacy_active_hidden_and_dummy_shapes_excluded(self):
        layers = [
            {'name': 'DIFF', 'kind': 'active', 'routing': True, 'defaultVisible': True},
            {'name': 'NW', 'kind': 'substrate', 'routing': True, 'defaultVisible': True},
            {'name': 'M1', 'kind': 'metal', 'routing': True},
        ]
        arrays, stack = self.compile_shapes([
            {'type': 'rect', 'layer': 'M1', 'purpose': purpose,
             'bbox': {'min': [i, 0], 'max': [i + 0.5, 1]}}
            for i, purpose in enumerate(('drawing', 'dummy', 'fill', 'slot', 'label'))
        ], layers)
        self.assertFalse(stack[0]['defaultVisible'])
        self.assertFalse(stack[1]['defaultVisible'])
        self.assertTrue(stack[2]['defaultVisible'])
        self.assertEqual(len(arrays['rects']), 1)

    def test_explicit_custom_mim_conductor_overrides_auxiliary_name(self):
        generic = _layer_stack([{'name': 'MIM'}])[0]
        mapped = _layer_stack([{'name': 'MIM', 'kind': 'metal', 'semantic': 'metal',
                                'routing': True, 'defaultVisible': True}])[0]
        self.assertFalse(generic['routing'])
        self.assertFalse(generic['defaultVisible'])
        self.assertTrue(mapped['routing'])
        self.assertTrue(mapped['defaultVisible'])
        for name in ('NW', 'AA', 'NIMP', 'SUBSTRATE', 'M1_DUMMY'):
            hard = _layer_stack([{'name': name, 'kind': 'metal', 'routing': True,
                                  'defaultVisible': True}])[0]
            self.assertFalse(hard['routing'], name)
            self.assertFalse(hard['defaultVisible'], name)
        arrays, unused = self.compile_shapes([{
            'type': 'rect', 'layer': 'MIM', 'purpose': 'dummy',
            'bbox': {'min': [0, 0], 'max': [1, 1]},
        }], [{'name': 'MIM', 'kind': 'metal', 'routing': True}])
        self.assertEqual(len(arrays['rects']), 0)

    def test_explicit_layer_and_shape_disables_are_respected(self):
        stack = _layer_stack([{'name': 'M1', 'kind': 'auxiliary', 'routing': False}])
        self.assertFalse(stack[0]['routing'])
        arrays, unused_stack = self.compile_shapes([{
            'type': 'rect', 'layer': 'M1', 'purpose': 'custom', 'routing': False,
            'bbox': {'min': [0, 0], 'max': [1, 1]},
        }])
        self.assertEqual(len(arrays['rects']), 0)

    def test_unknown_stream_layer_defaults_hidden(self):
        unused_arrays, stack = self.compile_shapes([{
            'type': 'rect', 'layer': 'L999_D0', 'bbox': {'min': [0, 0], 'max': [1, 1]},
        }])
        self.assertFalse(stack[-1]['defaultVisible'])

    def test_fit_keeps_all_corners_in_narrow_viewport(self):
        camera = CameraState()
        bounds = (-10, -3, 10, 3)
        aspect = 0.3
        camera.fit_bounds(bounds, 0, 2, aspect)
        eye = numpy.asarray(camera.eye())
        forward = numpy.asarray(camera.target) - eye
        forward /= numpy.linalg.norm(forward)
        right = numpy.cross(forward, [0, 1, 0]); right /= numpy.linalg.norm(right)
        up = numpy.cross(right, forward)
        half_vertical = math.tan(math.radians(24))
        for x in (-10, 10):
            for y in (0, 2):
                for z in (-3, 3):
                    vector = numpy.asarray([x, y, z]) - eye
                    depth = numpy.dot(vector, forward)
                    self.assertLess(abs(numpy.dot(vector, right)), depth * half_vertical * aspect)
                    self.assertLess(abs(numpy.dot(vector, up)), depth * half_vertical)


if __name__ == '__main__':
    unittest.main()
