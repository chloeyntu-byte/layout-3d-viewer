"""Synthetic technology names: private PDK tables are never test fixtures."""
import os
import sys
import unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'tools'))
from pdk_profile import load_registry
from convert_layout_tsv import build_layer_context, layer_class
import test_trace_metadata as fixtures


class TechnologyLayerTests(unittest.TestCase):
    def context(self, records, vias=(), tech='future_node'):
        return build_layer_context([r['name'] for r in records], tech,
            technology_layers=[dict(r, technologyLibrary=tech) for r in records],
            via_definitions=list(vias))

    def test_actual_material_resolves_unfamiliar_names_and_rejects_false_metal(self):
        context = self.context([{'name': 'RDLX', 'material': 'metal'},
                                {'name': 'M2', 'material': 'nwell'},
                                {'name': 'GATE_X', 'material': 'poly'}])
        self.assertEqual(layer_class('RDLX', context)['kind'], 'metal')
        self.assertFalse(layer_class('M2', context)['routing'])
        self.assertEqual(layer_class('GATE_X', context)['kind'], 'poly')
        self.assertFalse(layer_class('RDLX', context, 'odummy')['routing'])

    def test_special_top_order_comes_from_actual_vias_beyond_eight_metals(self):
        records = [{'name': n, 'material': 'metal'} for n in ['M8', 'CAPX', 'RDLX']]
        records += [{'name': n, 'material': 'cut'} for n in ['CUTX', 'CUTY']]
        vias = [dict(cutLayer='CUTX', lowerLayer='M8', upperLayer='CAPX'),
                dict(cutLayer='CUTY', lowerLayer='CAPX', upperLayer='RDLX')]
        context = self.context(records, reversed(vias))
        self.assertEqual(layer_class('CAPX', context)['stackIndex'], 19)
        self.assertEqual(layer_class('RDLX', context)['stackIndex'], 21)
        self.assertEqual(layer_class('CUTX', context)['stackIndex'], 18)
        self.assertEqual(layer_class('CUTY', context)['stackIndex'], 20)
        self.assertNotEqual(layer_class('CUTX', context).get('connectivitySource'), 'oa-via-definition')

    def test_branch_is_not_a_license_to_guess_a_level(self):
        context = self.context([{'name': n, 'material': 'metal'} for n in ['M1', 'M8', 'CAPX']],
            [dict(cutLayer='CUT', lowerLayer=n, upperLayer='CAPX') for n in ['M1', 'M8']])
        self.assertNotEqual(layer_class('CAPX', context).get('stackSource'), 'oa-via-order-approximate')

    def test_conflicting_materials_do_not_become_a_conductor(self):
        context = self.context([{'name': 'M1', 'material': 'metal'}, {'name': 'M1', 'material': 'nwell'}])
        self.assertFalse(layer_class('M1', context)['routing'])
        self.assertTrue(any(d['code'] == 'E5010' for d in context['profileDiagnostics']))


    def test_actual_cut_name_wins_and_reserved_empty_cut_is_not_invented(self):
        from convert_layout_tsv import actual_via_layer, complete_routing_layer_names
        records = [dict(name=n, material=m) for n, m in
                   [('M1', 'metal'), ('M2', 'metal'), ('VIA1', 'cut'), ('VIA12', 'unknown')]]
        context = self.context(records, [dict(cutLayer='VIA1', lowerLayer='M1', upperLayer='M2')])
        self.assertEqual(actual_via_layer(1, 2, context), 'VIA1')
        self.assertEqual(complete_routing_layer_names({'M1', 'M2'}, context), ['M1', 'M2'])

    def test_cycle_cannot_borrow_a_numbered_metal_as_a_stack_anchor(self):
        context = self.context([{'name': n, 'material': 'metal'} for n in ('M8', 'RDLX')],
            [dict(cutLayer='A', lowerLayer='M8', upperLayer='RDLX'),
             dict(cutLayer='B', lowerLayer='RDLX', upperLayer='M8')])
        self.assertEqual(layer_class('RDLX', context)['stackSource'], 'unresolved')

    def test_foreign_technology_cannot_activate_layers_or_supply_endpoints(self):
        from technology_layers import scoped_via_definitions
        records = [dict(name='RDLX', material='metal', technologyLibrary='foreign')]
        context = build_layer_context(['RDLX'], 'current', technology_layers=records)
        self.assertFalse(layer_class('RDLX', context)['routing'])
        definitions = [dict(cutLayer='V1', lowerLayer='M1', upperLayer='M2', technologyLibrary='foreign')]
        self.assertEqual(scoped_via_definitions(definitions, 'current'), [])



class TechnologyRecordTests(unittest.TestCase):
    convert = fixtures.TraceMetadataTests.convert

    def test_techlayer_roundtrip_keeps_geometry_and_material(self):
        result = self.convert(4, ['TECHLAYER\tM1\tmetal\tTEST'])
        self.assertEqual(result['technology']['layerDefinitions'][0]['material'], 'metal')
        layer = next(l for l in result['layers'] if l['name'] == 'M1')
        self.assertEqual(layer['technologyMaterial'], 'metal')
        self.assertEqual(result['shapes'][0]['points'], [[0, 0], [1, 0], [1, 1], [0, 1]])

    def test_techlayer_rejects_older_schema(self):
        with self.assertRaises(RuntimeError):
            self.convert(3, ['TECHLAYER\tM1\tmetal\tTEST'])


if __name__ == '__main__':
    unittest.main()
