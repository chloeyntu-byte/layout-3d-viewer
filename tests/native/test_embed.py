from __future__ import absolute_import

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from native import embed  # noqa: E402
from native.palettes import STYLES, palette_color, palette_key, style_for_palette  # noqa: E402


FLUX_LIKE_RESULT = {
    'geometry': {
        'polygons': [
            {'layer': 'M9', 'points': [[-10, -10], [10, -10], [10, -5], [-10, -5]], 'net': 'L'},
            {'layer': 'M1', 'points': [[0, 0], [8, 1], [8, 2], [0, 1]]},
        ],
        'vias': [{'via_def': 'M9_M8', 'cut_layer': 'VIA8', 'bbox': [[-1, -1], [1, 1]], 'lower': 'M8', 'upper': 'M9'}],
        'ports': [{'name': 'L1', 'layer': 'M9', 'bbox': [[-10, -10], [-6, -8]]},
                  {'name': 'CTAP', 'layer': 'M7', 'bbox': [[-1, 4], [1, 6]]}],
    },
}
FLUX_LIKE_TECHNOLOGY = {
    'layers': [{'name': 'M%d' % n} for n in range(1, 10)] + [{'name': 'AP'}],
    'vias': [{'lower': 'M%d' % n, 'upper': 'M%d' % (n + 1), 'cut_layer': 'VIA%d' % n} for n in range(1, 9)]
            + [{'lower': 'M9', 'upper': 'AP', 'cut_layer': 'RV'}],
}


class LayerStackTest(unittest.TestCase):
    def test_cuts_sit_between_their_metals(self):
        stack = embed.layer_stack(['M1', 'M2', 'M3'], vias=[('M2', 'M3', 'VIA2'), {'lower': 'M1', 'upper': 'M2', 'cut_layer': 'VIA1'}])
        self.assertEqual([layer['name'] for layer in stack], ['M1', 'VIA1', 'M2', 'VIA2', 'M3'])
        self.assertEqual([layer['kind'] for layer in stack], ['metal', 'via', 'metal', 'via', 'metal'])
        self.assertEqual([layer.get('metal') for layer in stack if layer['kind'] == 'metal'], [1, 2, 3])

    def test_thickness_override_and_defaults(self):
        stack = dict((layer['name'], layer['thickness']) for layer in embed.layer_stack(['M1', 'M2'], [('M1', 'M2', 'V1')], {'m2': 3.4}))
        self.assertEqual(stack, {'M1': embed.DEFAULT_THICKNESS['metal'], 'V1': embed.DEFAULT_THICKNESS['via'], 'M2': 3.4})


class SceneTest(unittest.TestCase):
    def test_flux_scene_maps_polygons_vias_and_ports(self):
        scene = embed.flux_scene(FLUX_LIKE_RESULT, FLUX_LIKE_TECHNOLOGY)
        self.assertEqual(scene['units'], 'um')
        self.assertEqual([layer['name'] for layer in scene['layers']][-3:], ['M9', 'RV', 'AP'])
        self.assertEqual(sorted(shape['layer'] for shape in scene['shapes']), ['M1', 'M9', 'VIA8'])
        self.assertEqual([pin['name'] for pin in scene['pins']], ['L1', 'CTAP'])
        self.assertTrue(all(pin['hierPath'] == scene['cell'] for pin in scene['pins']))
        self.assertEqual(scene['bbox'], {'min': [-10.0, -10.0], 'max': [10.0, 6.0]})

    def test_geometry_vias_place_cut_layers_without_technology_vias(self):
        technology = {'layers': FLUX_LIKE_TECHNOLOGY['layers']}
        names = [layer['name'] for layer in embed.flux_scene(FLUX_LIKE_RESULT, technology)['layers']]
        self.assertEqual(names.index('VIA8'), names.index('M8') + 1)
        self.assertEqual(names.index('M9'), names.index('VIA8') + 1)

    def test_unknown_layers_are_appended_not_dropped(self):
        scene = embed.scene_from_geometry([{'layer': 'XYZ', 'bbox': [[0, 0], [1, 1]]}], layers=embed.layer_stack(['M1']))
        self.assertEqual([layer['name'] for layer in scene['layers']], ['M1', 'XYZ'])

    def test_degenerate_items_are_skipped(self):
        scene = embed.scene_from_geometry([{'layer': 'M1', 'points': [[0, 0], [1, 1]]}], pins=[{'layer': 'M1', 'bbox': [[0, 0], [1, 1]]}])
        self.assertEqual(scene['shapes'], [])
        self.assertEqual(scene['pins'], [])


class CompileSceneTest(unittest.TestCase):
    def test_compiles_in_memory(self):
        try:
            import numpy  # noqa: F401
        except ImportError:
            self.skipTest('numpy is not installed')
        from native.compiler import compile_scene
        compiled = compile_scene(embed.flux_scene(FLUX_LIKE_RESULT, FLUX_LIKE_TECHNOLOGY))
        self.assertIsNone(compiled.path)
        self.assertEqual(len(compiled.arrays['rects']), 2)  # the M9 rectangle and the via block
        self.assertEqual(len(compiled.arrays['outline_layers']), 1)  # the slanted M1 polygon
        names = [layer['name'] for layer in compiled.metadata['layers']]
        tops = dict((layer['name'], layer['nativeTopUm']) for layer in compiled.metadata['layers'])
        self.assertLess(tops['M8'], tops['VIA8'])
        self.assertLess(tops['VIA8'], tops['M9'])
        self.assertIn('AP', names)
        self.assertEqual(len(compiled.metadata['pins']), 2)


class StyleTest(unittest.TestCase):
    def test_styles_and_palette_keys(self):
        self.assertEqual(style_for_palette('studio'), 'studio')
        self.assertEqual(style_for_palette('aurora'), 'metal')
        self.assertEqual(set(STYLES), set(embed.STYLES))
        self.assertEqual(palette_key('VIA7'), 'VIA78')
        self.assertEqual(palette_key('V2'), 'VIA23')
        self.assertEqual(palette_color('studio', 'M9'), '#f5c518')
        self.assertEqual(palette_color('studio', 'VIA8'), '#d9b25a')
        # metal colours repeat every six layers instead of falling back to one grey
        self.assertEqual(palette_color('classic-dark-metal', 'M7'), palette_color('classic-dark-metal', 'M1'))


class RuntimeTest(unittest.TestCase):
    def test_prepare_runtime_reports_status(self):
        note = embed.prepare_runtime()
        self.assertIsInstance(note, str)
        self.assertEqual(embed.prepare_runtime(), note)  # idempotent


if __name__ == '__main__':
    unittest.main()
