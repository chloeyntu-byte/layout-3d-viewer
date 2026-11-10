#!/usr/bin/env python3
"""Public synthetic regressions for exact identities and runtime layer evidence.

No private PDK stack, layer-number table, or device geometry is distributed here.
"""
from __future__ import print_function
import copy
import json
import math
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import pdk_profile as profiles


class ProfileRegistry(unittest.TestCase):
    def setUp(self):
        self.registry = profiles.load_registry()

    def classify(self, name, tech='generic', purpose='drawing', evidence=None):
        return profiles.classify_layer(self.registry, self.registry['profiles'][tech], name,
                                       purpose, technology_layer=evidence)

    def test_exact_technology_identity(self):
        identity = 'example-process'
        for spelling in ('example_process', 'EXAMPLE_PROCESS', ' example_process '):
            selected, source, warnings = profiles.select_profile(
                self.registry, spelling, 'SYNTHETIC', ['AA', 'GT', 'CT', 'M1', 'V1'])
            self.assertEqual(selected['id'], identity)
            self.assertEqual(source, 'technology')
            self.assertEqual(warnings, [])

    def test_missing_or_foreign_technology_does_not_guess_a_node(self):
        for names in (['AA', 'GT', 'CT', 'M1', 'V1'], ['AA', 'GT', 'CT', 'M1', 'M8', 'TM1', 'TV1'],
                      ['METAL1', 'POLY1', 'CONT']):
            for technology in ('', 'unregistered-example-variant', 'unregistered-other-variant'):
                selected, source, diagnostics = profiles.select_profile(
                    self.registry, technology, 'SYNTHETIC_WRAPPER', names)
                self.assertEqual(selected['id'], 'generic')
                self.assertEqual(source, 'generic')
                self.assertTrue(diagnostics)

    def test_authoritative_material_overrides_name_fallback_without_changing_inputs(self):
        profile_before=copy.deepcopy(self.registry['profiles']['generic'])
        for material,kind in (('metal','metal'),('poly','poly'),('cut','via')):
            evidence={'material':material,'source':'oa-tech-layer'};before=copy.deepcopy(evidence)
            info=self.classify('L999_D0',evidence=evidence)
            self.assertEqual(info['kind'],kind)
            self.assertTrue(info['routing'])
            self.assertEqual(info['technologyMaterial'],material)
            self.assertEqual(info['classificationSource'],'oa-tech-layer')
            self.assertEqual(evidence,before)
        self.assertEqual(self.registry['profiles']['generic'],profile_before)
        self.assertTrue(self.classify('MIM',evidence={'material':'metal'})['routing'])
        self.assertEqual(self.classify('CO',evidence={'material':'cut'})['kind'],'contact')
        self.assertFalse(self.classify('L999_D0',evidence={'material':'unknown'})['routing'])
        self.assertTrue(self.classify('M1',evidence={'material':'unknown'})['routing'])

    def test_non_conductive_material_wins_over_metal_spelling(self):
        for material in ('ndiff','pdiff','diffusion','nwell','pwell','implant','nimplant','pimplant',
                         'nplus','pplus','recognition','drill','wirebond','oxide'):
            info=self.classify('M1',evidence={'material':material})
            self.assertFalse(info['routing'],material)
            self.assertFalse(info['defaultVisible'],material)
            self.assertNotIn('metal',info)
            self.assertNotIn('lowerMetal',info)

    def test_conflicts_are_hidden_and_do_not_keep_inferred_connectivity(self):
        for name in ('M2','VIA12','CT','M6'):
            info=self.classify(name,'example-process',evidence={'material':'conflict','source':'oa-tech-conflict','stackIndex':15,'metal':7})
            self.assertFalse(info['routing'])
            self.assertFalse(info['defaultVisible'])
            self.assertEqual(info['classificationSource'],'oa-tech-conflict')
            self.assertFalse(set(info) & set(('metal','lowerMetal','upperMetal','lowerLayer','upperLayer','lowerLayers','upperLayers')))

    def test_observed_order_has_provenance_and_does_not_invent_endpoints(self):
        evidence={'material':'metal','source':'oa-tech-layer','stackIndex':19.0,
                  'stackSource':'oa-via-order-approximate','metal':9}
        info=self.classify('L999_D0','generic',evidence=evidence)
        self.assertEqual(info['stackIndex'],19.0)
        self.assertEqual(info['metal'],9)
        self.assertEqual(info['stackSource'],'oa-via-order-approximate')
        self.assertEqual(info['stackIndexSource'],'oa-via-order-approximate')
        self.assertTrue(info['approximate'])
        self.assertNotIn('lowerLayer',info)
        for value in (True,float('nan'),float('inf'),'19'):
            invalid=self.classify('L999_D0','generic',evidence={'material':'metal','stackIndex':value,'metal':value})
            self.assertLess(invalid['stackIndex'],0)
            self.assertNotIn('metal',invalid)

    def test_auxiliary_lpps_cannot_be_reenabled_by_actual_metal_material(self):
        for purpose in ('odummy','ODUMMY','o_dummy','odummy2','dummy','dummy1','fill','slot','boundary','text'):
            info=self.classify('M1',purpose=purpose,evidence={'material':'metal'})
            self.assertFalse(info['routing'],purpose)
            self.assertFalse(info['defaultVisible'],purpose)
        for name in ('AA','NW','NIMP','M6DUM'):
            info=self.classify(name,evidence={'material':'metal'})
            self.assertFalse(info['routing'],name)
        for purpose in ('drawing','drawing1','drawing2','pin','net'):
            self.assertTrue(self.classify('M1',purpose=purpose,evidence={'material':'metal'})['routing'])

    def test_stream_numeric_coincidences_do_not_identify_a_process(self):
        import import_stream_layout as stream
        pairs={(11,0),(12,0),(13,0),(31,0)}
        for path in ('/tmp/unknown/chip.gds','/tmp/other-process/chip.gds'):
            selected, detection=stream.infer_stream_profile_pairs(pairs,path)
            self.assertIsNone(selected)
            self.assertEqual(detection['status'],'unconfirmed')
        for path in ('/tmp/example_process/chip.gds','/tmp/generic-input/example_process/chip.gds'):
            selected, detection=stream.infer_stream_profile_pairs(pairs,path)
            self.assertEqual(selected[1]['id'],'example-process')
            self.assertEqual(detection['status'],'matched')

    def test_stream_migration_path_cannot_hide_a_second_process_identity(self):
        import import_stream_layout as stream
        pairs={(11,0),(12,0),(13,0),(31,0)}
        with tempfile.TemporaryDirectory(prefix='vl3d-second-profile-') as directory:
            with open(os.path.join(ROOT,'profiles','example-process.json')) as handle:
                second=json.load(handle)
            second['id']='another-process'
            second['match']['technologyLibraries']=['another_process']
            second.pop('streamLayers')
            with open(os.path.join(directory,'another-process.json'),'w') as handle:
                json.dump(second,handle)
            selected, detection=stream.infer_stream_profile_pairs(
                pairs,'/tmp/migration-example_process-to-another_process/chip.gds',[directory])
        self.assertIsNone(selected)
        self.assertEqual(detection['status'],'ambiguous')
        self.assertEqual(set(detection['candidates']),{'example-process','another-process'})

    def test_generic_via_spelling_is_approximate_and_unambiguous(self):
        cases={'VIA12':(1,2),'VIA10':(10,11),'VIA910':(9,10),'VIA1011':(10,11),
               'VIA_9_10':(9,10),'VIA-10-11':(10,11),'V10':(10,11),'V_9':(9,10),
               'VIA123':None,'VIA1DUMMY':None,'TV1':None}
        for name,pair in cases.items():
            self.assertEqual(profiles.via_pair_from_name(name),pair,name)


if __name__=='__main__':unittest.main()
