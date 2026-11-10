from __future__ import absolute_import

import unittest

import numpy

from native.selection import connected_net_keys, hierarchy_ids, hierarchy_tree_rows, net_ids, outline_indices, physical_shape_rows, selected_pins
from native.gl_view import LayoutGLView


class SelectionTests(unittest.TestCase):
    def setUp(self):
        self.metadata = {
            'hierarchyPaths': ['TOP', 'TOP/U1', 'TOP/U1/M0', 'TOP/U2'],
            'netKeys': ['TOP::CLK', 'TOP/U1::A', 'TOP/U1::Y', 'TOP/U2::A'],
            'pins': [
                {'hierPath': 'TOP/U1', 'terminal': 'A', 'net': 'A', 'layer': 'M2'},
                {'hierPath': 'TOP/U1', 'terminal': 'Y', 'net': 'Y', 'layer': 'M3'},
                {'hierPath': 'TOP/U2', 'terminal': 'A', 'net': 'A', 'layer': 'M2'},
            ],
            'connections': [
                {
                    'occurrencePath': 'TOP/U1', 'parentPath': 'TOP',
                    'parentNet': 'CLK', 'childFormalNet': 'A', 'terminal': 'A',
                },
            ],
        }

    def test_module_selection_includes_descendant_geometry(self):
        self.assertEqual(hierarchy_ids(self.metadata, ['TOP/U1']), set([1, 2]))

    def test_nested_selection_roots_do_not_change_descendant_set(self):
        self.assertEqual(
            hierarchy_ids(self.metadata, ['TOP/U1', 'TOP/U1/M0', 'TOP/U1']),
            set([1, 2]))

    def test_module_selection_exposes_all_exact_pins_only(self):
        pins = selected_pins(self.metadata, ['TOP/U1'])
        self.assertEqual([pin['terminal'] for pin in pins], ['A', 'Y'])

    def test_external_parent_routes_are_connected(self):
        keys = connected_net_keys(self.metadata, ['TOP/U1'])
        self.assertIn('TOP::CLK', keys)
        self.assertIn('TOP/U1::A', keys)
        self.assertIn('TOP/U1::Y', keys)
        self.assertEqual(net_ids(self.metadata, ['TOP/U1']), set([0, 1, 2]))

    def test_one_pin_follows_all_levels_without_selecting_other_pins_or_namesakes(self):
        self.metadata['connections'].extend([
            {'occurrencePath': 'TOP/U1/M0', 'parentPath': 'TOP/U1', 'parentNet': 'A', 'childFormalNet': 'G'},
            {'occurrencePath': 'TOP/U2', 'parentPath': 'TOP', 'parentNet': 'OTHER', 'childFormalNet': 'A'},
        ])
        pin = self.metadata['pins'][0]
        self.assertEqual(set(connected_net_keys(self.metadata, ['TOP/U1'], [pin])),
                         set(['TOP/U1::A', 'TOP::CLK', 'TOP/U1/M0::G']))
        self.assertEqual(net_ids(self.metadata, ['TOP/U1'], [pin]), set([0, 1]))

    def test_trace_from_leaf_climbs_through_parent_and_reaches_explicit_sibling(self):
        self.metadata['connections'].extend([
            {'occurrencePath': 'TOP/U1/M0', 'parentPath': 'TOP/U1', 'parentNet': 'A', 'childFormalNet': 'G'},
            {'occurrencePath': 'TOP/U2', 'parentPath': 'TOP', 'parentNet': 'CLK', 'childFormalNet': 'A'},
        ])
        leaf = {'hierPath': 'TOP/U1/M0', 'terminal': 'G', 'net': 'G'}
        self.assertEqual(set(connected_net_keys(self.metadata, ['TOP/U1/M0'], [leaf])),
                         set(['TOP/U1/M0::G', 'TOP/U1::A', 'TOP::CLK', 'TOP/U2::A']))

    def test_geometric_mapping_never_short_circuits_occurrences(self):
        self.metadata['connections'].append({
            'occurrencePath': 'TOP/U2', 'parentPath': 'TOP', 'parentNet': 'CLK',
            'childFormalNet': 'A', 'source': 'geometric-inference'})
        self.assertNotIn('TOP/U2::A', connected_net_keys(self.metadata, ['TOP/U1']))

    def test_search_retains_ancestors_and_finds_beyond_depth_limit(self):
        self.metadata['cell'] = 'TOP'
        self.metadata['instances'] = [
            {'hierPath': 'TOP/U1'}, {'hierPath': 'TOP/U1/M0'}, {'hierPath': 'TOP/U2'}]
        rows = hierarchy_tree_rows(self.metadata, 'M0', 0)
        self.assertEqual([path for path, unused in rows], ['TOP', 'TOP/U1', 'TOP/U1/M0'])

    def test_hierarchy_includes_pin_only_scope_and_preserves_selected_path(self):
        self.metadata['cell'] = 'TOP'
        self.metadata['pins'].append({'hierPath': 'TOP/U3/PINONLY', 'terminal': 'P'})
        rows = hierarchy_tree_rows(self.metadata, 'missing', 0, ['TOP/U3/PINONLY'])
        self.assertEqual([path for path, unused in rows], ['TOP', 'TOP/U3', 'TOP/U3/PINONLY'])

    def test_filtered_via_primitives_do_not_reappear_as_modules(self):
        self.metadata['cell'] = 'TOP'
        self.metadata['instances'] = [{'hierPath': 'TOP/U1'}]
        self.metadata['hierarchyPaths'].append('TOP/U1/VIA_ARRAY_1')
        rows = hierarchy_tree_rows(self.metadata, '', 8)
        self.assertNotIn('TOP/U1/VIA_ARRAY_1', [path for path, unused in rows])

    def test_physical_trace_maps_source_ordinals_after_sorting_and_fragmentation(self):
        arrays = {'rect_shape_indices': numpy.asarray([5, 0, 8, 5], dtype=numpy.uint32),
                  'outline_shape_indices': numpy.asarray([2, 8, 8, 9], dtype=numpy.uint32)}
        rects, outlines = physical_shape_rows(arrays, [0, 8], numpy)
        self.assertEqual(rects.tolist(), [1, 2])
        self.assertEqual(outlines.tolist(), [1, 2])
        rects, outlines = physical_shape_rows(arrays, [], numpy)
        self.assertEqual(rects.tolist(), [])
        self.assertEqual(outlines.tolist(), [])

    def test_polygon_outline_selection_uses_vectorized_hierarchy_and_net_ids(self):
        arrays = {
            'outline_hierarchy': numpy.asarray([0, 1, 2, 3, 1], dtype=numpy.uint32),
            'outline_nets': numpy.asarray([3, 0, 2, 3, 1], dtype=numpy.uint32),
        }
        selected, connected = outline_indices(arrays, set([1, 2]), set([0, 1, 2]), numpy)
        self.assertEqual(selected.tolist(), [1, 2, 4])
        self.assertEqual(connected.tolist(), [1, 2, 4])

    def test_layer_ranges_use_contiguous_vector_boundaries(self):
        layers = numpy.asarray([1, 1, 1, 4, 4, 7], dtype=numpy.uint16)
        self.assertEqual(
            LayoutGLView._ranges_for_layers(object(), layers),
            {1: (0, 3), 4: (3, 2), 7: (5, 1)})


if __name__ == '__main__':
    unittest.main()
