from __future__ import absolute_import

import hashlib
import json
import os
import shutil
import tempfile
import unittest

import numpy

from native.compiler import _compile_arrays, _layer_stack, compile_layout
from native.physical_trace import PhysicalTraceIndex


def rules(connectors=None, complete=True):
    return {'schemaVersion': 1, 'conductors': {'M1': 'metal', 'M2': 'metal', 'POLY': 'poly', 'CTM5': 'metal'},
            'connectors': connectors or {}, 'complete': complete, 'warnings': []}


def rect(x0, y0, x1, y1, layer='M1', path='TOP/A', **extra):
    shape = {'type': 'rect', 'layer': layer, 'hierPath': path,
             'bbox': {'min': [x0, y0], 'max': [x1, y1]}, 'purpose': 'drawing'}
    shape.update(extra)
    return shape


def pin(x0=0.1, y0=0.1, x1=0.5, y1=0.5, layer='M1', path='TOP/A'):
    value = rect(x0, y0, x1, y1, layer, path)
    value['terminal'] = 'P'
    value['purpose'] = 'pin'
    return value


def layout(shapes, **metadata):
    result = {'schemaVersion': 2, 'cell': 'TOP', 'units': 'um', 'dbuPerMicron': 1000,
              'shapes': shapes, 'shapeCount': len(shapes), 'layers': [], 'instances': []}
    result.update(metadata)
    return result


def trace(shapes, seeds=None, trace_rules=None, **kwargs):
    return PhysicalTraceIndex.from_layout(layout(shapes), rules=trace_rules or rules()).trace(
        seeds or pin(), **kwargs)


class PhysicalTraceTests(unittest.TestCase):
    def test_same_layer_edge_contact_but_positive_gap_not_joined(self):
        result = trace([rect(0, 0, 1, 1), rect(1, 0, 2, 1), rect(2.001, 0, 3, 1)])
        self.assertTrue(result['complete'])
        self.assertEqual(result['shapeIndices'], [0, 1])

    def test_box_alias_and_bbox_only_rect_pins(self):
        shapes = [rect(0, 0, 1, 1, type='box'), rect(1, 0, 2, 1, type='rectangle')]
        result = trace(shapes)
        self.assertEqual(result['shapeIndices'], [0, 1])
        self.assertTrue(result['complete'])

    def test_polygon_bbox_is_not_used_as_fake_geometry(self):
        result = trace([rect(0, 0, 1, 1), rect(1, 0, 2, 1, type='polygon')])
        self.assertEqual(result['shapeIndices'], [0])
        self.assertFalse(result['complete'])
        self.assertEqual(result['stats']['unsupportedShapes'], 1)

    def test_nonzero_area_self_crossing_and_invalid_holes_are_rejected(self):
        crossed = {'type': 'polygon', 'layer': 'M1',
                   'points': [[0, 0], [4, 4], [0, 4], [3, 0]]}
        bad_hole = {'type': 'polygon', 'layer': 'M1',
                    'points': [[0, 0], [2, 0], [2, 2], [0, 2]],
                    'holes': [[[1, 1], [3, 1], [3, 3], [1, 3]]]}
        result = trace([rect(-1, -1, .5, .5), crossed, bad_hole])
        self.assertEqual(result['shapeIndices'], [0])
        self.assertEqual(result['stats']['unsupportedShapes'], 2)
        self.assertFalse(result['complete'])

    def test_multiple_seed_components_cannot_bypass_result_limit(self):
        shapes = [rect(i * 2, 0, i * 2 + 1, 1) for i in range(10)]
        seeds = [pin(i * 2 + .1, .1, i * 2 + .5, .5) for i in range(10)]
        result = trace(shapes, seeds, limits={'maxResults': 3})
        self.assertEqual(result['reason'], 'maxResults')
        self.assertEqual(len(result['shapeIndices']), 3)

    def test_bbox_overlap_does_not_fill_concave_notch(self):
        polygon = {'type': 'polygon', 'layer': 'M1', 'hierPath': 'TOP/A',
                   'points': [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]]}
        result = trace([polygon, rect(2, 2, 3, 3)])
        self.assertTrue(result['complete'])
        self.assertEqual(result['shapeIndices'], [0])

    def test_hole_does_not_connect_enclosed_shape(self):
        ring = {'type': 'polygon', 'layer': 'M1', 'hierPath': 'TOP/A',
                'points': [[0, 0], [10, 0], [10, 10], [0, 10]],
                'holes': [[[3, 3], [7, 3], [7, 7], [3, 7]]]}
        result = trace([ring, rect(4, 4, 6, 6)])
        self.assertEqual(result['shapeIndices'], [0])
        self.assertTrue(result['complete'])
        empty_seed = trace([ring], pin(4, 4, 6, 6))
        self.assertEqual(empty_seed['status'], 'no_seed')

    def test_hole_touching_outer_edge_does_not_leave_false_wire(self):
        notch = {'type': 'polygon', 'layer': 'M1', 'hierPath': 'TOP/A',
                 'points': [[0, 0], [10, 0], [10, 10], [0, 10]],
                 'holes': [[[3, 0], [7, 0], [7, 7], [3, 7]]]}
        result = trace([notch, rect(4, -1, 6, 0)], pin(4.2, -.8, 5, -.2))
        self.assertEqual(result['shapeIndices'], [1])
        self.assertTrue(result['complete'])
        empty = dict(notch)
        empty['holes'] = [empty['points']]
        result = trace([empty, rect(0, 0, 1, 1)])
        self.assertEqual(result['shapeIndices'], [1])
        self.assertFalse(result['complete'])

    def test_overlapping_holes_are_subtracted_as_union(self):
        shape = {'type': 'polygon', 'layer': 'M1', 'hierPath': 'TOP/A',
                 'points': [[0, 0], [10, 0], [10, 10], [0, 10]],
                 'holes': [[[2, 2], [6, 2], [6, 6], [2, 6]],
                           [[4, 4], [8, 4], [8, 8], [4, 8]]]}
        result = trace([shape, rect(5, 5, 5.5, 5.5)], pin(5.1, 5.1, 5.4, 5.4))
        self.assertEqual(result['shapeIndices'], [1])
        self.assertTrue(result['complete'])

    def test_diagonal_path_bbox_is_only_candidate_filter(self):
        path = {'type': 'path', 'layer': 'M1', 'hierPath': 'TOP/A',
                'points': [[0, 0], [4, 4]], 'width': 0.3}
        result = trace([path, rect(0, 3, 1, 4)], pin(0, 0, 0.1, 0.1))
        self.assertEqual(result['shapeIndices'], [0])

    def test_legacy_pathseg_bbox_is_preview_only_and_never_physical_evidence(self):
        old = rect(0, 0, 4, 1, type='pathSeg', width=1,
                   points=[[0, 0], [4, 0], [4, 1], [0, 1]])
        result = trace([rect(-1, 0, 0, 1), old, rect(4, 0, 5, 1)], pin(-.9, .1, -.1, .9))
        self.assertEqual(result['shapeIndices'], [0])
        self.assertEqual(result['reason'], 'legacy_pathseg_bbox')
        self.assertFalse(result['complete'])
        directory = tempfile.mkdtemp(prefix='vl3d-legacy-pathseg-')
        try:
            source = os.path.join(directory, 'source.json')
            with open(source, 'w') as handle:
                json.dump(layout([old], layers=[{'name': 'M1', 'kind': 'metal'}]), handle)
            target = os.path.join(directory, 'compiled')
            compile_layout(source, target, 'legacy-pathseg-fixture')
            rects = numpy.load(os.path.join(target, 'rects.npy'))
            self.assertEqual(rects[0, :4].tolist(), [0, 0, 4, 1])
            self.assertEqual(numpy.load(os.path.join(target, 'rect_shape_indices.npy')).tolist(), [0])
        finally:
            shutil.rmtree(directory)

    def test_real_pathseg_centerline_and_four_point_path_remain_paths(self):
        segment = {'type': 'pathSeg', 'layer': 'M1', 'points': [[0, 0], [4, 0]], 'width': 1}
        path = {'type': 'path', 'layer': 'M1', 'points': [[4, 0], [6, 0], [6, 2], [8, 2]], 'width': 1}
        result = trace([segment, path, rect(4.5, 1.2, 5, 1.8)], pin(0, -.2, .2, .2))
        self.assertEqual(result['shapeIndices'], [0, 1])
        self.assertTrue(result['complete'])

    def test_different_layers_cross_without_via_stay_separate(self):
        result = trace([rect(0, 0, 4, 1), rect(1, -1, 2, 2, 'M2')])
        self.assertEqual(result['shapeIndices'], [0])
        self.assertTrue(result['complete'])

    def test_via_requires_named_endpoints_and_positive_area_overlap(self):
        mapping = rules({'V1': {'lowerLayers': ['M1'], 'upperLayers': ['M2']}})
        result = trace([rect(0, 0, 4, 1), rect(1, -1, 2, 2, 'M2'),
                        rect(1.2, 0.2, 1.8, 0.8, 'V1'), rect(1, -1, 2, 2, 'CTM5')], trace_rules=mapping)
        self.assertEqual(result['shapeIndices'], [0, 1, 2])
        edge_only = trace([rect(0, 0, 1, 1), rect(1, 0, 2, 1, 'V1'), rect(1, 0, 2, 1, 'M2')], trace_rules=mapping)
        self.assertEqual(edge_only['shapeIndices'], [0])

    def test_poly_contact_is_not_diffusion_extraction(self):
        mapping = rules({'CT': {'lowerLayers': ['POLY'], 'upperLayers': ['M1']}})
        result = trace([rect(0, 0, 1, 1, 'POLY'), rect(.2, .2, .8, .8, 'CT'),
                        rect(0, 0, 2, 1, 'M1'), rect(0, 0, 3, 1, 'DIFF')],
                       pin(layer='POLY'), mapping)
        self.assertEqual(result['shapeIndices'], [0, 1, 2])

    def test_point_only_touch_is_reported_not_shortened(self):
        result = trace([rect(0, 0, 1, 1), rect(1, 1, 2, 2)])
        self.assertEqual(result['shapeIndices'], [0])
        self.assertFalse(result['complete'])
        self.assertEqual(result['reason'], 'point_only_contacts')

    def test_same_net_and_master_names_do_not_join_separate_occurrences(self):
        result = trace([rect(0, 0, 1, 1, net='VDD', ownerCell='SAME'),
                        rect(5, 0, 6, 1, path='TOP/B', net='VDD', ownerCell='SAME')])
        self.assertEqual(result['shapeIndices'], [0])

    def test_explicit_local_rotation_and_mirror_are_transformed(self):
        transformed = rect(0, 0, 2, 1, coordinateSpace='local', transform=[0, 1, 1, 0, 10, 0])
        result = trace([transformed, rect(10, 2, 11, 3)], pin(10.2, .2, 10.8, .8))
        self.assertEqual(result['shapeIndices'], [0, 1])

    def test_scope_boundary_is_explicitly_partial(self):
        result = trace([rect(0, 0, 1, 1), rect(1, 0, 2, 1, path='TOP/B')], scope_paths=['TOP/A'])
        self.assertEqual(result['shapeIndices'], [0])
        self.assertFalse(result['complete'])
        self.assertEqual(result['reason'], 'scope_boundary')

    def test_reused_index_does_not_keep_previous_scope_warning(self):
        index = PhysicalTraceIndex.from_layout(layout([
            rect(0, 0, 1, 1, path='TOP/A'), rect(1, 0, 2, 1, path='TOP/B')]), rules())
        limited = index.trace(pin(), scope_paths=['TOP/A'])
        self.assertEqual(limited['reason'], 'scope_boundary')
        complete = index.trace(pin())
        self.assertTrue(complete['complete'])
        self.assertEqual(complete['shapeIndices'], [0, 1])
        self.assertFalse(any(w['code'] == 'scope_boundary' for w in complete['warnings']))

    def test_disconnected_pin_figures_have_separate_components(self):
        result = trace([rect(0, 0, 1, 1), rect(5, 0, 6, 1)],
                       [pin(), pin(5.1, .1, 5.5, .5)])
        self.assertEqual(result['shapeIndices'], [0, 1])
        self.assertEqual(result['seedComponentCount'], 2)
        self.assertEqual(result['status'], 'ambiguous_seed')
        self.assertEqual([c['shapeIndices'] for c in result['components']], [[0], [1]])

    def test_source_shape_ordinals_survive_exclusions(self):
        result = trace([rect(10, 10, 11, 11, purpose='dummy'), rect(0, 0, 1, 1),
                        rect(1, 0, 2, 1, traceRole='barrier'), rect(2, 0, 3, 1)])
        self.assertEqual(result['shapeIndices'], [1])

    def test_device_scope_barrier_cannot_be_traversed(self):
        mapping = rules()
        mapping['deviceScopes'] = {'TOP/R': {'traceRole': 'barrier', 'source': 'test'}}
        result = trace([rect(0, 0, 1, 1), rect(1, 0, 2, 1, path='TOP/R'), rect(2, 0, 3, 1)], trace_rules=mapping)
        self.assertEqual(result['shapeIndices'], [0])

    def test_opaque_device_keeps_exact_ports_without_joining_through_body(self):
        for kind in ('capacitor', 'resistor', 'inductor', 'mos'):
            mapping = rules()
            mapping['deviceScopes'] = {'TOP/DEV': {'kind': kind, 'opaque': True}}
            shapes = [rect(-1, 0, 0, 1),
                      rect(0, 0, 1, 1, path='TOP/DEV', traceRole='terminal'),
                      rect(0, 0, 3, 1, path='TOP/DEV'),
                      rect(2, 0, 3, 1, path='TOP/DEV', traceRole='terminal'),
                      rect(3, 0, 4, 1),
                      rect(0, 0, 3, 1, path='TOP/DEV/internal', traceRole='terminal')]
            left = trace(shapes, pin(-.9, .1, -.1, .9), mapping)
            right = trace(shapes, pin(3.1, .1, 3.9, .9), mapping)
            self.assertEqual(left['shapeIndices'], [0, 1], kind)
            self.assertEqual(right['shapeIndices'], [3, 4], kind)
            self.assertTrue(left['complete'])
            self.assertTrue(right['complete'])

    def test_cancelled_index_is_not_complete(self):
        index = PhysicalTraceIndex.from_layout(layout([rect(0, 0, 1, 1)]), rules(), cancelled=lambda: True)
        result = index.trace(pin(), cancelled=lambda: True)
        self.assertEqual(result['status'], 'cancelled')
        self.assertFalse(result['complete'])

    def test_cancel_during_trace_retains_only_confirmed_shapes(self):
        index = PhysicalTraceIndex.from_layout(layout([rect(i, 0, i + 1, 1) for i in range(200)]), rules())
        calls = [0]
        def cancelled():
            calls[0] += 1
            return calls[0] > 8
        result = index.trace(pin(), cancelled=cancelled)
        self.assertEqual(result['status'], 'cancelled')
        self.assertGreater(len(result['shapeIndices']), 0)
        self.assertLess(len(result['shapeIndices']), 200)

    def test_result_limit_is_obeyed_and_reported(self):
        result = trace([rect(i, 0, i + 1, 1) for i in range(20)], limits={'maxResults': 5})
        self.assertEqual(result['status'], 'limited')
        self.assertEqual(result['reason'], 'maxResults')
        self.assertLessEqual(len(result['shapeIndices']), 5)

    def test_index_limit_is_never_reported_as_complete(self):
        index = PhysicalTraceIndex.from_layout(layout([rect(i, 0, i + 1, 1) for i in range(20)]),
                                               rules(), limits={'maxShapes': 5})
        result = index.trace(pin())
        self.assertEqual(result['status'], 'limited')
        self.assertEqual(result['reason'], 'maxShapes')
        self.assertLessEqual(len(result['shapeIndices']), 5)

    def test_candidate_limit_and_incomplete_rules_are_reported(self):
        result = trace([rect(i, 0, i + 1, 1) for i in range(20)], limits={'maxCandidates': 3})
        self.assertEqual(result['reason'], 'maxCandidates')
        result = trace([rect(0, 0, 1, 1)], trace_rules=rules(complete=False))
        self.assertFalse(result['complete'])
        self.assertEqual(result['reason'], 'incomplete_rules')

    def test_invalid_geometry_cannot_silently_look_complete(self):
        invalid = {'type': 'polygon', 'layer': 'M1', 'points': [[0, 0], [2, 2], [0, 2], [2, 0]]}
        result = trace([rect(0, 0, 1, 1), invalid])
        self.assertFalse(result['complete'])
        self.assertEqual(result['stats']['unsupportedShapes'], 1)

    def test_large_origin_keeps_real_sub_float32_gap(self):
        origin = 10000000.0
        result = trace([rect(origin, 0, origin + 1, 1), rect(origin + 1.001, 0, origin + 2, 1)],
                       pin(origin + .1, .1, origin + .2, .2))
        self.assertEqual(result['shapeIndices'], [0])

    def test_nm_units_and_repeated_trace_on_index(self):
        index = PhysicalTraceIndex.from_layout(layout([rect(0, 0, 1000, 1000), rect(1000, 0, 2000, 1000)], units='nm'), rules())
        for unused in range(2):
            result = index.trace(pin(100, 100, 500, 500))
            self.assertEqual(result['shapeIndices'], [0, 1])
            self.assertTrue(result['complete'])

    def test_additional_resource_limits_and_index_cancellation(self):
        shapes = [rect(i, 0, i + 1, 1) for i in range(1000)]
        for limit in ({'maxVertices': 4}, {'maxMemoryMiB': 1}, {'maxSeconds': 1e-9}, {'maxIndexCells': 1}):
            index = PhysicalTraceIndex.from_layout(layout(shapes), rules(), limits=limit)
            result = index.trace(pin())
            self.assertFalse(result['complete'])
            self.assertEqual(result['status'], 'limited')
            self.assertEqual(result['reason'], next(iter(limit)))
        calls = [0]
        def cancelled():
            calls[0] += 1
            return calls[0] > 6
        index = PhysicalTraceIndex.from_layout(layout(shapes), rules(), cancelled=cancelled)
        self.assertEqual(index.build_status, 'cancelled')
        self.assertGreater(index.stats['indexedShapes'], 0)
        self.assertLess(index.stats['indexedShapes'], len(shapes))

    def test_path_end_extensions_follow_source_units(self):
        path = {'type': 'path', 'layer': 'M1', 'points': [[0, 0], [1000, 0]],
                'width': 200, 'beginExt': 100, 'endExt': 200}
        index = PhysicalTraceIndex.from_layout(layout([path, rect(1250, -100, 1400, 100)], units='nm'), rules())
        result = index.trace(pin(0, -50, 50, 50))
        self.assertEqual(result['shapeIndices'], [0])

    def test_rotated_rect_display_uses_true_polygon_and_source_ordinal(self):
        directory = tempfile.mkdtemp(prefix='vl3d-rotated-rect-')
        try:
            source = os.path.join(directory, 'source.json')
            shapes = [rect(9, 9, 10, 10, purpose='dummy'),
                      rect(0, 0, 2, 2, points=[[0, 1], [1, 0], [2, 1], [1, 2]])]
            with open(source, 'w') as handle:
                json.dump(layout(shapes, layers=[{'name': 'M1', 'kind': 'metal'}]), handle)
            target = os.path.join(directory, 'compiled')
            compile_layout(source, target, 'rotated-fixture')
            self.assertEqual(len(numpy.load(os.path.join(target, 'rects.npy'))), 0)
            self.assertEqual(numpy.load(os.path.join(target, 'outline_shape_indices.npy')).tolist(), [1])
            outlines = numpy.load(os.path.join(target, 'outline_vertices.npy'))
            self.assertEqual(set(map(tuple, outlines[:, :2])), set([(0, 1), (1, 0), (2, 1), (1, 2)]))
            result = trace(shapes, pin(0, 0, .1, .1))
            self.assertEqual(result['status'], 'no_seed')
        finally:
            shutil.rmtree(directory)

    def test_file_digest_and_compiler_shape_mapping_match(self):
        directory = tempfile.mkdtemp(prefix='vl3d-physical-test-')
        try:
            source = os.path.join(directory, 'source.json')
            data = layout([rect(0, 0, 1, 1, 'M2'), rect(9, 9, 10, 10, purpose='dummy'),
                           rect(1, 0, 2, 1), {'type': 'polygon', 'layer': 'M1', 'hierPath': 'TOP/A',
                                             'bbox': {'min': [2, 0], 'max': [4, 2]},
                                             'points': [[2, 0], [4, 0], [2, 2]]}],
                          layers=[{'name': 'M1', 'kind': 'metal'}, {'name': 'M2', 'kind': 'metal'}],
                          deviceScopes={}, deviceMetadataComplete=True, deviceBoundaryComplete=False,
                          deviceBoundarySource='oa-category-cdf-conservative')
            with open(source, 'w') as handle:
                json.dump(data, handle)
            with open(source, 'rb') as handle:
                expected = hashlib.sha256(handle.read()).hexdigest()
            index = PhysicalTraceIndex.from_layout(source, rules())
            self.assertEqual(index.source_digest, expected)
            self.assertTrue(index.metadata['deviceMetadataComplete'])
            self.assertFalse(index.metadata['deviceBoundaryComplete'])
            self.assertEqual(index.metadata['deviceBoundarySource'], 'oa-category-cdf-conservative')
            target = os.path.join(directory, 'compiled')
            compile_layout(source, target, 'synthetic-fingerprint')
            with open(os.path.join(target, 'meta.json')) as handle:
                metadata = json.load(handle)
            self.assertEqual(metadata['sourceDigest'], expected)
            self.assertEqual(numpy.load(os.path.join(target, 'rect_shape_indices.npy')).tolist(), [2, 0])
            self.assertEqual(numpy.load(os.path.join(target, 'outline_shape_indices.npy')).tolist(), [3])
        finally:
            shutil.rmtree(directory)


if __name__ == '__main__':
    unittest.main()
