from __future__ import absolute_import

import json
import os
import shutil
import stat
import tempfile
import unittest

import numpy

from native.compiler import _compile_arrays, _layer_stack, _secure_publish_tree


class FakeIjson(object):
    @staticmethod
    def items(handle, prefix, use_float=True):
        return iter(json.load(handle).get('shapes') or [])


class CompilerStackTests(unittest.TestCase):
    def test_parallel_ctm5_does_not_shift_m6(self):
        names = (
            ('DIFF', 'active', 0.2), ('POLY1', 'poly', 0.2), ('CONT', 'contact', 0.1),
            ('METAL1', 'metal', 0.2), ('VIA12', 'via', 0.1), ('METAL2', 'metal', 0.2),
            ('VIA23', 'via', 0.1), ('METAL3', 'metal', 0.2), ('VIA34', 'via', 0.1),
            ('METAL4', 'metal', 0.2), ('VIA45', 'via', 0.1), ('METAL5', 'metal', 1.0),
            ('CTM5', 'capacitor-top-metal-5', 0.2), ('VIA56', 'via', 0.1),
            ('METAL6', 'metal', 4.0),
        )
        layers = _layer_stack([
            {
                'name': name,
                'semantic': semantic,
                'kind': 'metal' if 'metal' in semantic else semantic,
                'routing': True,
                'thickness': thickness,
            }
            for name, semantic, thickness in names
        ])
        by_name = dict((layer['name'], layer) for layer in layers)
        self.assertAlmostEqual(by_name['METAL5']['nativeBottomUm'], 1.7)
        self.assertAlmostEqual(by_name['METAL5']['nativeTopUm'], 2.7)
        self.assertAlmostEqual(by_name['CTM5']['nativeBottomUm'], 2.5)
        self.assertAlmostEqual(by_name['CTM5']['nativeTopUm'], 2.7)
        self.assertAlmostEqual(by_name['VIA56']['nativeBottomUm'], 2.7)
        self.assertAlmostEqual(by_name['VIA56']['nativeTopUm'], 2.8)
        self.assertAlmostEqual(by_name['METAL6']['nativeBottomUm'], 2.8)
        self.assertAlmostEqual(by_name['METAL6']['nativeTopUm'], 6.8)
        self.assertTrue(by_name['CTM5']['nativeParallelStack'])

    def test_explicit_calibrated_stack_is_preserved(self):
        layers = _layer_stack([
            {'name': 'M1', 'kind': 'metal', 'routing': True, 'thickness': 0.2,
             'zBottomUm': 1.0, 'zTopUm': 1.25},
            {'name': 'V1', 'kind': 'via', 'routing': True, 'thickness': 0.1,
             'zBottomUm': 1.25, 'zTopUm': 1.8},
            {'name': 'M2', 'kind': 'metal', 'routing': True, 'thickness': 0.2,
             'zBottomUm': 1.8, 'zTopUm': 2.1},
        ])
        self.assertEqual((layers[0]['nativeBottomUm'], layers[0]['nativeTopUm']), (1.0, 1.25))
        self.assertEqual((layers[1]['nativeBottomUm'], layers[1]['nativeTopUm']), (1.25, 1.8))
        self.assertEqual((layers[2]['nativeBottomUm'], layers[2]['nativeTopUm']), (1.8, 2.1))

    def test_unannotated_ctm_name_is_not_assumed_parallel(self):
        layers = _layer_stack([
            {'name': 'M1', 'kind': 'metal', 'semantic': 'metal', 'routing': True, 'thickness': 1.0},
            {'name': 'CTM_CUSTOM', 'kind': 'metal', 'semantic': 'metal', 'routing': True, 'thickness': 0.2},
            {'name': 'M2', 'kind': 'metal', 'semantic': 'metal', 'routing': True, 'thickness': 0.4},
        ])
        self.assertFalse(layers[1]['nativeParallelStack'])
        self.assertEqual((layers[1]['nativeBottomUm'], layers[1]['nativeTopUm']), (1.0, 1.2))
        self.assertEqual((layers[2]['nativeBottomUm'], layers[2]['nativeTopUm']), (1.2, 1.6))

    def test_unresolved_conductors_do_not_displace_known_stack(self):
        from native.compiler import COMPILER_VERSION
        from native.gl_view import LayoutGLView
        from types import SimpleNamespace
        source = [
            {'name': 'CTM', 'kind': 'metal', 'routing': True, 'stackIndex': -4,
             'stackSource': 'unresolved', 'thickness': 4.0, 'defaultVisible': False},
            {'name': 'CBM', 'kind': 'metal', 'routing': True, 'stackIndex': -4,
             'stackSource': 'unresolved', 'thickness': 4.0, 'defaultVisible': False},
            {'name': 'M1', 'kind': 'metal', 'routing': True, 'thickness': 0.2},
            {'name': 'M2', 'kind': 'metal', 'routing': True, 'thickness': 0.3},
        ]
        before = json.dumps(source, sort_keys=True)
        layers = _layer_stack(source)
        self.assertEqual((layers[2]['nativeBottomUm'], layers[2]['nativeTopUm']), (0.0, 0.2))
        self.assertEqual((layers[3]['nativeBottomUm'], layers[3]['nativeTopUm']), (0.2, 0.5))
        self.assertTrue(layers[0]['routing'])
        self.assertFalse(layers[0]['defaultVisible'])
        view = SimpleNamespace(metadata={'layers': layers}, layer_visibility=dict(enumerate([False]*4)), request_redraw=lambda: None)
        LayoutGLView.set_all_layers(view, True)
        self.assertEqual(view.layer_visibility, {0: False, 1: False, 2: True, 3: True})
        LayoutGLView.set_layer_visibility(view, 0, True)
        self.assertTrue(view.layer_visibility[0])
        self.assertEqual(json.dumps(source, sort_keys=True), before)
        self.assertNotEqual(COMPILER_VERSION, 'native-cache-v1.9')

    def test_path_outline_retains_hierarchy_and_net_ids(self):
        directory = tempfile.mkdtemp(prefix='vl3d-outline-net-')
        try:
            source = os.path.join(directory, 'layout.json')
            with open(source, 'w') as handle:
                json.dump({'shapes': [{
                    'type': 'path', 'layer': 'M6', 'hierPath': 'TOP/U1', 'net': 'OUT',
                    'bbox': {'min': [0, 0], 'max': [4, 3]},
                    'points': [[0, 0], [4, 3]], 'width': 0.8,
                }]}, handle)
            layers = _layer_stack([{
                'name': 'M6', 'kind': 'metal', 'semantic': 'metal',
                'routing': True, 'thickness': 4.0,
            }])
            arrays, hierarchy_paths, net_keys, unused_lod = _compile_arrays(
                source, {'instances': []}, layers, FakeIjson, numpy)
            self.assertEqual(len(arrays['outline_offsets']), 2)
            self.assertEqual(hierarchy_paths[int(arrays['outline_hierarchy'][0])], 'TOP/U1')
            self.assertEqual(net_keys[int(arrays['outline_nets'][0])], 'TOP/U1::OUT')
            heights = set(float(value) for value in arrays['triangle_vertices'][:, 2])
            self.assertEqual(heights, set([0.0, 4.0]))
        finally:
            shutil.rmtree(directory)

    def test_published_cache_tree_is_forced_private(self):
        directory = tempfile.mkdtemp(prefix='vl3d-publish-mode-')
        try:
            os.chmod(directory, 0o755)
            for name in ('meta.json', '.complete', 'rects.npy'):
                path = os.path.join(directory, name)
                with open(path, 'w') as handle:
                    handle.write('x')
                os.chmod(path, 0o644)
            _secure_publish_tree(directory, ['rects'])
            self.assertEqual(stat.S_IMODE(os.stat(directory).st_mode), 0o700)
            for name in ('meta.json', '.complete', 'rects.npy'):
                self.assertEqual(stat.S_IMODE(os.stat(os.path.join(directory, name)).st_mode), 0o600)
        finally:
            shutil.rmtree(directory)


if __name__ == '__main__':
    unittest.main()
