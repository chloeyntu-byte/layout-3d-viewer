from __future__ import absolute_import

import copy
import gzip
import hashlib
import json
import os
import shutil
import tempfile
import unittest

import numpy

from native.cache import CacheManager, cache_fingerprint
from native.compiler import COMPILER_VERSION, compile_layout
from native.errors import Vl3dError
from native.physical_trace import PhysicalTraceIndex
from tools.import_stream_layout import StreamImportError, read_json_input, validate_schema_v2
from tools.layout_units import validate_viewer_units


def fixture():
    return {
        'schemaVersion': 2, 'library': 'SYNTHETIC', 'cell': 'TOP', 'view': 'layout',
        'units': 'um', 'dbuPerMicron': 1000,
        'bbox': {'min': [0, 0], 'max': [3, 2]},
        'layers': [{'name': 'M1', 'kind': 'metal', 'routing': True, 'thickness': 0.2}],
        'shapes': [{'type': 'rect', 'layer': 'M1', 'hierPath': 'TOP/A',
                    'bbox': {'min': [0, 0], 'max': [1, 2]}},
                   {'type': 'polygon', 'layer': 'M1', 'hierPath': 'TOP/A',
                    'bbox': {'min': [1, 0], 'max': [3, 2]},
                    'points': [[1, 0], [3, 0], [1, 2]]}],
        'instances': [{'hierPath': 'TOP/A', 'bbox': {'min': [0, 0], 'max': [3, 2]}}],
        'pins': [{'terminal': ' data<3> ', 'hierPath': 'TOP/A', 'layer': 'M1',
                  'type': 'rect', 'bbox': {'min': [0, 0], 'max': [0.5, 1]}}],
        'connections': [], 'deviceScopes': {}, 'deviceMetadataComplete': True,
        'deviceBoundaryComplete': True,
    }


class ViewerUnitTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp(prefix='vl3d-unit-contract-')
        self.source = os.path.join(self.directory, 'layout.json')

    def tearDown(self):
        shutil.rmtree(self.directory)

    def write_source(self, data, compressed=False):
        path = self.source + ('.gz' if compressed else '')
        encoded = json.dumps(data, ensure_ascii=True).encode('ascii')
        opener = gzip.open if compressed else open
        with opener(path, 'wb') as handle:
            handle.write(encoded)
        return path

    def test_micrometre_aliases_and_legacy_missing_units_do_not_mutate_source(self):
        for units in ('um', '\u00b5m', '\u03bcm', ' UM ', None):
            data = fixture()
            if units is None:
                del data['units']
            else:
                data['units'] = units
            original = copy.deepcopy(data)
            raw_pin = data['pins'][0]
            validate_viewer_units(data)
            validate_schema_v2(data)
            self.assertEqual(data, original)
            self.assertIs(data['pins'][0], raw_pin)

    def test_explicit_invalid_units_rejected_by_both_readers(self):
        for units in ('nm', 'dbu', 'mm', '', None, False, 1, [], {'name': 'um'}):
            with self.subTest(units=units):
                data = fixture()
                data['units'] = units
                original = copy.deepcopy(data)
                with self.assertRaises(StreamImportError) as context:
                    validate_schema_v2(data)
                self.assertEqual(context.exception.code, 'E4003')
                self.assertIn('do not only change its units field', str(context.exception))
                source = self.write_source(data)
                target = os.path.join(self.directory, 'must-not-exist')
                with self.assertRaises(Vl3dError) as context:
                    compile_layout(source, target, 'invalid-units')
                self.assertEqual(context.exception.code, 'VL3D-E4003')
                self.assertFalse(os.path.exists(target))
                self.assertEqual(data, original)
                with open(source, 'r') as handle:
                    self.assertEqual(json.load(handle), original)

    def test_json_and_gzip_import_refuse_nm_before_returning_geometry(self):
        data = fixture()
        data['units'] = 'nm'
        for compressed in (False, True):
            source = self.write_source(data, compressed)
            with self.assertRaises(StreamImportError) as context:
                read_json_input(source, compressed, 1024 * 1024)
            self.assertEqual(context.exception.code, 'E4003')
            with self.assertRaises(Vl3dError) as context:
                compile_layout(source, os.path.join(self.directory, 'no-output'), 'bad-gzip')
            self.assertEqual(context.exception.code, 'VL3D-E4003')

    def test_accepted_units_preserve_pin_figure_dimensions_ordinals_and_layer_height(self):
        for index, units in enumerate(('um', '\u00b5m', '\u03bcm', None)):
            data = fixture()
            if units is None:
                del data['units']
            else:
                data['units'] = units
            source = self.write_source(data)
            with open(source, 'rb') as handle:
                digest = hashlib.sha256(handle.read()).hexdigest()
            target = os.path.join(self.directory, 'accepted-%d' % index)
            compile_layout(source, target, 'accepted-units-%d' % index)
            with open(os.path.join(target, 'meta.json')) as handle:
                metadata = json.load(handle)
            self.assertEqual(metadata.get('units'), units)
            self.assertEqual(metadata['pins'], data['pins'])
            self.assertEqual(metadata['instances'], data['instances'])
            self.assertEqual(metadata['bbox'], data['bbox'])
            self.assertEqual(metadata['sourceDigest'], digest)
            self.assertEqual(metadata['compilerVersion'], COMPILER_VERSION)
            numpy.testing.assert_allclose(numpy.load(os.path.join(target, 'rects.npy')),
                                          [[0, 0, 1, 2, 0, 0.2]])
            self.assertEqual(numpy.load(os.path.join(target, 'rect_shape_indices.npy')).tolist(), [0])
            self.assertEqual(numpy.load(os.path.join(target, 'outline_shape_indices.npy')).tolist(), [1])
            numpy.testing.assert_allclose(numpy.load(os.path.join(target, 'instances.npy')), [[0, 0, 3, 2]])
            with open(source, 'rb') as handle:
                self.assertEqual(hashlib.sha256(handle.read()).hexdigest(), digest)

    def test_old_cache_cannot_bypass_new_non_micrometre_validation(self):
        data = fixture()
        data['units'] = 'nm'
        self.write_source(data)
        manager = CacheManager(root=os.path.join(self.directory, 'cache'))
        old_fingerprint = cache_fingerprint(self.source, compiler_version='native-cache-v1.8')
        old_target = manager.directory(old_fingerprint)
        os.makedirs(old_target)
        with open(os.path.join(old_target, '.complete'), 'w') as handle:
            handle.write(old_fingerprint + '\n')
        with open(os.path.join(old_target, 'meta.json'), 'w') as handle:
            json.dump({'arrays': {}, 'compilerVersion': 'native-cache-v1.8', 'units': 'nm'}, handle)
        self.assertTrue(manager.complete(old_fingerprint))
        job = manager.start_compile(self.source)
        self.assertNotEqual(job.fingerprint, old_fingerprint)
        self.assertIsNotNone(job.process)
        stdout, stderr = job.process.communicate(timeout=20)
        self.assertNotEqual(job.process.returncode, 0, stdout)
        self.assertIn(b'VL3D-E4003', stderr)
        self.assertFalse(manager.complete(job.fingerprint))
        self.assertTrue(manager.complete(old_fingerprint))

    def test_physical_reader_accepts_micrometre_aliases_and_keeps_nm_dbu_capability(self):
        for units, scale in (('um', 1), ('\u00b5m', 1), ('\u03bcm', 1), ('nm', 1000), ('dbu', 1000)):
            data = fixture()
            data['units'] = units
            for shape in data['shapes'] + data['pins']:
                for point in shape.get('points', []):
                    point[:] = [value * scale for value in point]
                for point in shape['bbox'].values():
                    point[:] = [value * scale for value in point]
            result = PhysicalTraceIndex.from_layout(data).trace(data['pins'])
            self.assertEqual(result['shapeIndices'], [0, 1], units)
            self.assertEqual(result['status'], 'complete', units)


if __name__ == '__main__':
    unittest.main()
