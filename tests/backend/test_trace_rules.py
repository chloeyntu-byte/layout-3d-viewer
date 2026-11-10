#!/usr/bin/env python3
from __future__ import print_function
import os
import sys
import unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'tools'))
from trace_rules import build_trace_rules, is_shape_allowed, connector_rules


def metal(name, **kwargs):
    return dict({'name': name, 'kind': 'metal', 'routing': True}, **kwargs)


def via(name, lower=None, upper=None, **kwargs):
    result = {'name': name, 'kind': 'via', 'routing': True}
    if lower is not None: result['lowerLayer'] = lower
    if upper is not None: result['upperLayer'] = upper
    result.update(kwargs)
    return result


def layout(layers, **kwargs):
    return dict({'layers': layers, 'deviceScopes': {}, 'deviceMetadataComplete': True}, **kwargs)


class TraceRuleTests(unittest.TestCase):
    def test_exact_connector_endpoints(self):
        rules = build_trace_rules(layout([metal('METAL5', metal=5), metal('CTM5', metal=5),
                                         metal('METAL6'), via('VIA56', 'METAL5', 'METAL6')]))
        self.assertTrue(rules['complete'])
        self.assertEqual(rules['connectors']['VIA56']['lowerLayers'], ['METAL5'])
        self.assertNotIn('CTM5', rules['connectors']['VIA56']['lowerLayers'])

    def test_top_layers_are_explicit(self):
        rules = connector_rules([metal('M6'), metal('TM1'), metal('TM2'),
                                 via('TV1', 'M6', 'TM1'), via('TV2', 'TM1', 'TM2')])
        self.assertEqual(rules['TV2']['lowerLayers'], ['TM1'])
        self.assertEqual(rules['TV1']['upperLayers'], ['TM1'])

    def test_no_z_or_numeric_guess(self):
        rules = build_trace_rules(layout([metal('M1', zTopUm=1), metal('M2', zBottomUm=1),
                                         via('V1', lowerMetal=1, upperMetal=2, zBottomUm=1)]))
        self.assertFalse(rules['complete'])
        self.assertNotIn('V1', rules['connectors'])
        self.assertEqual(len(rules['conductors']), 2)

    def test_name_inference_is_not_electrical_evidence(self):
        rules = build_trace_rules(layout([metal('M1'), metal('M2'),
            via('VIA12', 'M1', 'M2', connectivitySource='name-inference')]))
        self.assertFalse(rules['complete'])
        self.assertFalse(rules['connectors'])

    def test_contact_stops_at_active_but_reaches_poly(self):
        rules = build_trace_rules(layout([metal('M1'), {'name': 'GT', 'kind': 'poly', 'routing': True},
            {'name': 'AA', 'kind': 'active', 'routing': False},
            {'name': 'CT', 'kind': 'contact', 'routing': True, 'lowerLayers': ['AA', 'GT'], 'upperLayer': 'M1'}]))
        self.assertTrue(rules['complete'])
        self.assertEqual(rules['connectors']['CT']['lowerLayers'], ['GT'])
        self.assertEqual(rules['connectors']['CT']['deviceBoundaryLayers'], ['AA'])
        self.assertNotIn('AA', rules['conductors'])

    def test_resistor_and_inductor_interiors_are_opaque(self):
        rules = build_trace_rules(layout([metal('M1')], deviceScopes={
            'TOP/R0': {'kind': 'resistor', 'source': 'oa-cdf'},
            'TOP/L0': {'kind': 'inductor', 'source': 'oa-cdf'},
            'TOP/R0/CORE': {'kind': 'geometry', 'source': 'oa-cdf'},
        }))
        self.assertFalse(is_shape_allowed({'hierPath': 'TOP/R0/CORE', 'layer': 'M1'}, rules))
        self.assertFalse(is_shape_allowed({'hierPath': 'TOP/L0', 'layer': 'M1'}, rules))
        self.assertTrue(is_shape_allowed({'hierPath': 'TOP/R01', 'layer': 'M1'}, rules))
        self.assertTrue(is_shape_allowed({'hierPath': 'TOP', 'layer': 'M1'}, rules))

    def test_unknown_devices_are_opaque_and_partial(self):
        rules = build_trace_rules(layout([metal('M1')], deviceScopes={'TOP/U': {'kind': 'unknown-device'}}))
        self.assertFalse(rules['complete'])
        self.assertFalse(is_shape_allowed({'hierPath': 'TOP/U/child'}, rules))
        self.assertFalse(is_shape_allowed({'hierPath': 'TOP', 'purpose': 'dummy'}, rules))

    def test_missing_device_evidence_is_visible(self):
        rules = build_trace_rules({'layers': [metal('M1')]})
        self.assertFalse(rules['complete'])
        self.assertIn('trace-device-metadata-missing', [item['code'] for item in rules['warnings']])

    def test_explicit_mim_conductor_but_no_implicit_bridge(self):
        rules = build_trace_rules(layout([metal('MIM'), metal('M1'), metal('AA')]))
        self.assertIn('MIM', rules['conductors'])
        self.assertNotIn('AA', rules['conductors'])
        self.assertFalse(rules['connectors'])

    def test_nested_device_terminal_cannot_override_an_opaque_ancestor(self):
        rules = build_trace_rules(layout([metal('M1')], deviceScopes={
            'TOP/X': {'kind':'unknown-device'}, 'TOP/X/M': {'kind':'mos'}}))
        self.assertFalse(is_shape_allowed({'hierPath':'TOP/X/M','traceRole':'terminal'}, rules))


if __name__ == '__main__': unittest.main()

class DeviceTerminalBoundaryTests(unittest.TestCase):
    def test_capacitor_body_cannot_short_terminals(self):
        rules = build_trace_rules(layout([metal('M5'), metal('M6'), via('V5','M5','M6')],
            deviceScopes={'TOP/C1':{'kind':'capacitor','source':'oa-library-category'}}))
        self.assertFalse(is_shape_allowed({'hierPath':'TOP/C1','layer':'M5'}, rules))
        self.assertTrue(is_shape_allowed({'hierPath':'TOP/C1','layer':'M6','traceRole':'terminal'}, rules))
        self.assertFalse(is_shape_allowed({'hierPath':'TOP/C1/child','layer':'M6','traceRole':'terminal'}, rules))

    def test_unknown_device_terminal_claim_cannot_override_missing_evidence(self):
        rules = build_trace_rules(layout([metal('M1')], deviceScopes={'TOP/X':{'kind':'unknown-device'}}))
        self.assertFalse(is_shape_allowed({'hierPath':'TOP/X','traceRole':'terminal'}, rules))

    def test_singular_and_plural_endpoints_do_not_report_missing_layers(self):
        rules = build_trace_rules(layout([metal('M1'),metal('M2'),
            via('V1','M1','M2',lowerLayers=['M1','m1'],upperLayers=['M2','m2'])]))
        self.assertTrue(rules['complete'])
        self.assertEqual(rules['warnings'], [])

    def test_confirmed_devices_stop_at_their_own_terminal_figures(self):
        for kind in ('resistor', 'inductor', 'capacitor', 'mos', 'bipolar', 'diode'):
            rules = build_trace_rules(layout([metal('M1')], deviceScopes={'TOP/X':{'kind':kind}}))
            self.assertFalse(is_shape_allowed({'hierPath':'TOP/X','layer':'M1'}, rules))
            self.assertTrue(is_shape_allowed({'hierPath':'TOP/X','layer':'M1','traceRole':'terminal'}, rules))


if __name__ == '__main__': unittest.main()
