"""TSV schema compatibility and conservative electrical-evidence regressions."""
import json
import os
import sys
import tempfile
import subprocess
import unittest
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
from trace_rules import build_trace_rules, apply_connectivity_metadata, source_device_scopes


class TraceMetadataTests(unittest.TestCase):
    def convert(self, schema, extra=None):
        with tempfile.TemporaryDirectory() as directory:
            raw = os.path.join(directory, 'raw')
            os.mkdir(raw)
            records = ['SCHEMA\t%d' % schema, 'CELL\tTEST\tTOP\tlayout\t1000\t0,0,2,2',
                       'SOURCE\tTEST\tTOP\tlayout' + ('\tmodule\toa-cellview\tnil\t2' if schema == 4 else '')]
            records += extra or []
            records += ['SHAPE\tTOP\tTOP\trect\tM1\tdrawing\t0\t0,0,1,1\t0,0;1,0;1,1;0,1\tP\t',
                        'ENDCELL\tTEST\tTOP\tlayout\t%d' % (1 + sum(1 for row in (extra or []) if row.startswith('SHAPE\t')))]
            with open(os.path.join(raw, 'fixture.tsv'), 'w') as handle:
                handle.write('\n'.join(records)+'\n')
            output = os.path.join(directory, 'data')
            process = subprocess.Popen([sys.executable, os.path.join(ROOT, 'tools', 'convert_layout_tsv.py'),
                '--input-dir', raw, '--output-dir', output, '--manifest', os.path.join(directory, 'manifest.json')],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            stdout, stderr = process.communicate()
            if process.returncode:
                raise RuntimeError(stderr.decode('utf-8'))
            with open(os.path.join(output, 'TEST@TOP@layout.json')) as handle:
                return json.load(handle)

    def test_schema_2_and_3_remain_readable_without_invented_device_evidence(self):
        for schema in (2, 3):
            result = self.convert(schema)
            self.assertEqual(result['schemaVersion'], 2)
            self.assertFalse(result['deviceMetadataComplete'])
            self.assertFalse(build_trace_rules(result)['complete'])

    def test_schema_4_carries_source_and_via_evidence(self):
        result = self.convert(4, ['VIADEF\tV1\tM1\tM2\tTEST\tVIA_DEF'])
        self.assertEqual(result['sourceSchemaVersion'], 4)
        self.assertTrue(result['deviceMetadataComplete'])
        self.assertEqual(result['deviceScopes']['TOP']['kind'], 'module')
        self.assertEqual(result['sourceViews'][0]['deviceSource'], 'oa-cellview')
        self.assertEqual(result['technology']['viaDefinitions'][0]['upperLayer'], 'M2')
        self.assertFalse(result['deviceBoundaryComplete'])
        self.assertFalse(build_trace_rules(result)['complete'])

    def test_schema4_exact_pathseg_footprint_retains_source_cap_metadata(self):
        record = 'SHAPE\tTOP\tTOP\tpolygon\tM2\tdrawing\t0\t0,0,2,2\t0,0;2,0;2,2;0,2\tP\t\tpathSeg\t2.0\ttruncate\tcustom\textend\t0.25\t1.0'
        result = self.convert(4, [record])
        shape = next(s for s in result['shapes'] if s['layer'] == 'M2')
        self.assertEqual(shape['type'], 'polygon')
        self.assertEqual(shape['width'], 0)
        self.assertEqual(shape['sourceType'], 'pathSeg')
        self.assertEqual(shape['beginExt'], 0.25)
        self.assertEqual(shape['endExt'], 1.0)
        self.assertEqual(shape['endStyle'], 'extend')

    def test_round_path_metadata_does_not_override_its_cap_style(self):
        record = 'SHAPE\tTOP\tTOP\tpath\tM2\tdrawing\t2\t-1,-1,3,1\t0,0;2,0\tP\t\tpath\t2.0\tround\tround\tround\t0\t0'
        result = self.convert(4, [record])
        shape = next(s for s in result['shapes'] if s['layer'] == 'M2')
        self.assertEqual(shape['pathStyle'], 'round')
        self.assertNotIn('beginExt', shape)
        self.assertNotIn('endExt', shape)
        self.assertEqual(shape['sourceBeginExt'], 0)

    def test_viadef_requires_schema_4(self):
        with self.assertRaises(RuntimeError):
            self.convert(3, ['VIADEF\tV1\tM1\tM2\tTEST\tVIA_DEF'])

    def test_missing_or_unread_device_source_stays_unknown(self):
        top = {'library': 'TEST', 'cell': 'TOP', 'view': 'layout'}
        src = dict(top, deviceKind='module', deviceSource='oa-cellview')
        scopes, complete = source_device_scopes(top, [{'hierPath':'TOP/R', 'master':dict(top, cell='R')}], [src])
        self.assertFalse(complete)
        self.assertEqual(scopes['TOP/R']['kind'], 'unknown-device')

    def test_conflicting_via_definitions_cannot_bridge_two_capacitor_plates(self):
        layers = [{'name':'VIA56', 'kind':'via', 'routing':True, 'lowerLayer':'METAL5','upperLayer':'METAL6'}]
        defs = [dict(cutLayer='VIA56', lowerLayer=lower, upperLayer='METAL6') for lower in ('METAL5','CTM5')]
        apply_connectivity_metadata(layers, defs, {})
        self.assertNotIn('lowerLayer', layers[0])
        self.assertEqual(layers[0]['connectivitySource'], 'ambiguous-via-definitions')

    def test_contact_can_declare_active_and_poly_without_retaining_active(self):
        layers = [{'name':'CT', 'kind':'contact', 'routing':True},
                  {'name':'GT', 'kind':'poly', 'routing':True}, {'name':'M1','kind':'metal','routing':True}]
        defs = [dict(cutLayer='CT', lowerLayer=lower, upperLayer='M1') for lower in ('GT','AA')]
        apply_connectivity_metadata(layers, defs, {})
        rules = build_trace_rules({'layers':layers,'deviceScopes':{},'deviceMetadataComplete':True})
        self.assertEqual(rules['connectors']['CT']['lowerLayers'], ['GT'])
        self.assertEqual(rules['connectors']['CT']['deviceBoundaryLayers'], ['AA'])

    def test_conflicting_profile_declarations_are_not_chosen_by_order(self):
        layer = {'name':'CUT','kind':'via','lowerLayer':'A','upperLayer':'B'}
        profile = {'streamLayers': {'1/0': dict(layer), '1/1': dict(layer, lowerLayer='C')}}
        apply_connectivity_metadata([layer], [], profile)
        self.assertNotIn('lowerLayer', layer)
        self.assertEqual(layer['connectivitySource'], 'ambiguous-profile-declarations')


if __name__ == '__main__': unittest.main()
