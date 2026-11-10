#!/usr/bin/env python3
"""Conductor classification and process-local numeric map regressions."""
from __future__ import print_function

import os
import json
import tempfile
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import pdk_profile
import import_stream_layout as stream


class LayerRecognitionTests(unittest.TestCase):
    def setUp(self):
        self.registry = pdk_profile.load_registry()

    def classify(self, name, purpose='drawing', profile='generic'):
        return pdk_profile.classify_layer(self.registry, self.registry['profiles'][profile], name, purpose)

    def test_non_conductors_stay_hidden_across_profiles(self):
        for profile in ('generic', 'example-process'):
            for name in ('AA', 'DIFF', 'OD', 'RX', 'ACTIVE', 'NW', 'DNW', 'NWELL',
                         'NPLUS', 'PIMP', 'M1_DUMMY', 'VIA1FILL', 'PRBOUNDARY',
                         'METAL1_PIN', 'M1_LABEL', 'NOT_A_METAL', 'L61_D0'):
                with self.subTest(profile=profile, layer=name):
                    result = self.classify(name, profile=profile)
                    self.assertFalse(result['routing'])
                    self.assertFalse(result['defaultVisible'])

    def test_explicit_conductor_can_override_only_ambiguous_marker_names(self):
        for name in ('MIM', 'RPO', 'HRP'):
            self.assertTrue(pdk_profile.is_non_conductive_layer_name(name))
            self.assertFalse(pdk_profile.is_non_conductive_layer_name(name, explicit_conductor=True))
            self.assertFalse(pdk_profile.is_hard_non_conductive_layer_name(name))
            self.assertFalse(self.classify(name)['routing'])
        for name in ('AA', 'DIFF', 'NW', 'SUBSTRATE', 'NIMP', 'PPLUS', 'SN', 'SP',
                     'M1_DUMMY', 'M1FILL', 'VIA1SLOT', 'M1_LABEL', 'PRBOUNDARY'):
            self.assertTrue(pdk_profile.is_non_conductive_layer_name(name, explicit_conductor=True))
            self.assertTrue(pdk_profile.is_hard_non_conductive_layer_name(name))
        custom = {'id': 'custom-mim', 'rules': [{'layers': ['MIM'], 'properties': {
            'kind': 'metal', 'routing': True, 'defaultVisible': True, 'semantic': 'electrode',
        }}]}
        selected = pdk_profile.classify_layer(self.registry, custom, 'MIM', 'drawing')
        self.assertTrue(selected['routing'])
        self.assertFalse(pdk_profile.is_non_conductive_layer_name(
            'MIM', explicit_conductor=selected['kind'] == 'metal' and selected['routing'] is True))
        self.assertFalse(pdk_profile.classify_layer(self.registry, custom, 'MIM', 'dummy')['routing'])

    def test_named_conductors_keep_common_aliases(self):
        for name in ('M1', 'M_1', 'MET-2', 'Metal_3', 'V1', 'V_1', 'VIA1',
                     'VIA1_2', 'VIA_2_3', 'VIA12', 'VIA1011', 'PO', 'POLY1',
                     'POLY2', 'PO2', 'GT', 'CT', 'CONT', 'CO', 'LI', 'RDL'):
            for purpose in ('drawing', 'drawing1', 'drawing2', 'pin', 'net'):
                with self.subTest(layer=name, purpose=purpose):
                    self.assertTrue(self.classify(name, purpose)['routing'])
        self.assertEqual(self.classify('VIA1011')['upperMetal'], 11)

    def test_auxiliary_purpose_does_not_inherit_metal_visibility(self):
        for name, profile in (('M1', 'generic'), ('M6', 'example-process')):
            for purpose in ('dummy', 'dummy1', 'fill', 'Fill_Blockage', 'slot', 'label',
                            'annotation', 'marker', 'keep-out', 'boundary'):
                with self.subTest(layer=name, purpose=purpose):
                    info = self.classify(name, purpose, profile)
                    self.assertFalse(info['routing'])
                    self.assertFalse(info['defaultVisible'])

    def test_name_only_and_explicit_kind_maps_are_consistent(self):
        result = stream.normalized_stream_mapping({
            '61/0': 'M1', '70/0': 'VIA12', '62/0': {'name': 'M2'},
            '90/0': {'name': 'CUSTOM', 'kind': 'metal'},
            '91/0': {'name': 'MIM', 'kind': 'metal'},
            '10/0': {'name': 'AA', 'kind': 'active', 'routing': True, 'defaultVisible': True},
            '61/1': {'name': 'M1', 'purpose': 'dummy'}, '99/0': 'UNKNOWN',
            '61/2': None, '10/1': {'name': 'AA', 'kind': 'metal', 'routing': True},
        })
        for key in ('61/0', '70/0', '62/0', '90/0', '91/0'):
            self.assertTrue(result[key]['routing'])
            self.assertTrue(result[key]['defaultVisible'])
        for key in ('10/0', '61/1', '99/0', '61/2', '10/1'):
            self.assertFalse(result[key]['routing'])
            self.assertFalse(result[key]['defaultVisible'])
        self.assertEqual(result['70/0']['lowerLayer'], 'M1')
        self.assertEqual(result['70/0']['upperLayer'], 'M2')

    def test_numeric_coincidence_cannot_select_pdk(self):
        pairs = [(11, 0), (12, 0), (13, 0), (31, 0)]
        mapped, detection = stream.infer_stream_profile_pairs(pairs, '/tmp/unknown-process/design.gds')
        self.assertIsNone(mapped)
        self.assertEqual(detection['status'], 'unconfirmed')
        self.assertIn('example-process', detection['candidates'])
        mapped, detection = stream.infer_stream_profile_pairs(pairs, '/tmp/example_process/design.gds')
        self.assertIsNotNone(mapped)
        self.assertEqual(detection['profile'], 'example-process')

    def test_oa_lpp_metadata_preserves_pin_when_dummy_sorts_first(self):
        with tempfile.TemporaryDirectory(prefix='vl3d-lpp-') as directory:
            raw = os.path.join(directory, 'raw')
            os.mkdir(raw)
            source = os.path.join(raw, 'fixture.tsv')
            records = ['SCHEMA\t3', 'CELL\tTEST\tTOP\tlayout\t1000\t0,0,2,2',
                       'TECH\tunknown-test-tech', 'SOURCE\tTEST\tTOP\tlayout']
            for purpose in ('dummy', 'pin', 'drawing1'):
                records.append('\t'.join(['SHAPE', 'TOP', 'TOP', 'rect', 'M1', purpose,
                                           '0', '0,0,1,1', '0,0;1,0;1,1;0,1', 'P', '']))
            records.append('ENDCELL\tTEST\tTOP\tlayout\t3')
            with open(source, 'w') as handle:
                handle.write('\n'.join(records) + '\n')
            output = os.path.join(directory, 'data')
            subprocess.check_call([sys.executable, os.path.join(ROOT, 'tools', 'convert_layout_tsv.py'),
                                   '--input-dir', raw, '--output-dir', output,
                                   '--manifest', os.path.join(directory, 'manifest.json')],
                                  stdout=subprocess.DEVNULL)
            with open(os.path.join(output, 'TEST@TOP@layout.json')) as handle:
                payload = json.load(handle)
            layer = next(item for item in payload['layers'] if item['name'] == 'M1')
            self.assertTrue(layer['routing'])
            purposes = dict((shape['purpose'], shape) for shape in payload['shapes'])
            self.assertFalse(purposes['dummy']['routing'])
            self.assertFalse(purposes['dummy']['defaultVisible'])
            self.assertTrue(purposes['pin']['routing'])
            self.assertTrue(purposes['drawing1']['defaultVisible'])

    def test_exact_datatype_exclusion_beats_layer_fallback(self):
        self.assertIsNone(stream.mapping_for({'61': 'M1', '61/7': None}, 61, 7))
        normalized = stream.normalized_stream_mapping({'61': 'M1', '61/7': None})
        self.assertFalse(stream.mapping_for(normalized, 61, 7)['defaultVisible'])
        self.assertTrue(stream.mapping_for(normalized, 61, 0)['routing'])

    def test_unknown_geometry_is_preserved_but_not_a_conductor(self):
        layout = {'layers': [{'name': 'L7_D0', 'metadataSource': 'stream-default', 'routing': True}],
                  'shapes': [{'layer': 'L7_D0'}], 'technology': {}, 'warnings': []}
        stream.finalize_stream_payload(layout, 'balanced', 8, 200000)
        self.assertEqual(len(layout['shapes']), 1)
        self.assertFalse(layout['layers'][0]['routing'])
        self.assertFalse(layout['layers'][0]['defaultVisible'])
        self.assertEqual(layout['technology']['unclassifiedLayers'], ['L7_D0'])


if __name__ == '__main__':
    unittest.main()
