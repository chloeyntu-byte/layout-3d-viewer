from __future__ import absolute_import

import json
import os
import shutil
import tempfile
import unittest
import glob
import stat

from native.config import DEFAULT_VIEWS, apply_advanced_settings, load_config, save_config
from native.errors import Vl3dError


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp(prefix='vl3d-native-config-')

    def tearDown(self):
        shutil.rmtree(self.directory)

    def write(self, value):
        path = os.path.join(self.directory, 'config.json')
        with open(path, 'w') as handle:
            json.dump(value, handle)
        return path

    def test_legacy_config_is_migrated_in_memory(self):
        path = self.write({
            'schemaVersion': 1,
            'cdsLib': '/tmp/project/cds.lib',
            'cadenceEnv': '/tmp/cadence.sh',
            'views': ['layout'],
            'resourceMode': 'lean',
            'native': {'palette': 'plasma', 'zScale': 3.5, 'cacheMiB': 128},
        })
        config = load_config(path)
        self.assertEqual(config.advanced.cds_lib, '/tmp/project/cds.lib')
        self.assertEqual(config.advanced.cadence_env, '/tmp/cadence.sh')
        self.assertEqual(config.advanced.views, ['layout'])
        self.assertEqual(config.palette, 'plasma')
        self.assertEqual(config.z_scale, 3.5)
        self.assertEqual(config.cache_mib, 128)
        self.assertEqual(config.advanced.resource_mode, 'low')
        self.assertEqual(config.advanced.library_overrides()['resourceMode'], 'low')

    def test_defaults_preserve_portable_views(self):
        config = load_config(os.path.join(self.directory, 'missing.json'))
        self.assertEqual(config.advanced.views, DEFAULT_VIEWS)
        self.assertEqual(DEFAULT_VIEWS, ['layout', 'maskLayout', 'chip', 'cLayout', 'dLayout', 'ivpcell'])
        self.assertEqual(config.palette, 'classic-dark-metal')
        self.assertEqual(config.z_scale, 1.0)

    def test_stream_overrides_include_profiles_and_resource_mode(self):
        settings = load_config(os.path.join(self.directory, 'missing.json')).advanced
        settings.pdk_profile_dirs = ['/opt/site/vl3d-profiles']
        settings.resource_mode = 'low'
        self.assertEqual(settings.stream_overrides(), {
            'pdkProfileDirs': ['/opt/site/vl3d-profiles'],
            'resourceMode': 'low',
        })
        settings.pdk_profile = '/opt/site/explicit.json'
        self.assertEqual(settings.stream_overrides(), {
            'pdkProfilePath': '/opt/site/explicit.json',
            'resourceMode': 'low',
        })

    def test_bootstrap_advanced_settings_override_xdg_values(self):
        path = self.write({
            'views': ['layout'],
            'resourceMode': 'balanced',
            'pdkProfileDirs': ['/old/profiles'],
        })
        config = load_config(path)
        apply_advanced_settings(config, {
            'views': ['chip', 'cLayout'],
            'resourceMode': 'low',
            'pdkProfileDirs': ['/effective/profiles'],
            'strictSymlinks': False,
        })
        self.assertEqual(config.advanced.views, ['chip', 'cLayout'])
        self.assertEqual(config.advanced.resource_mode, 'low')
        self.assertEqual(config.advanced.pdk_profile_dirs, ['/effective/profiles'])
        self.assertFalse(config.advanced.strict_symlinks)

    def test_physical_z_scale_and_existing_values_round_trip(self):
        for value in (0.1, 0.5, 1.0, 3.5, 4.0):
            path = self.write({'native': {'zScale': value}})
            config = load_config(path)
            self.assertEqual(config.z_scale, value)
            save_config(config)
            self.assertEqual(load_config(path).z_scale, value)

    def test_z_scale_bounds_include_physical_one_times(self):
        for raw, expected in ((0, 0.1), (-5, 0.1), (100, 4.0)):
            config = load_config(self.write({'native': {'zScale': raw}}))
            self.assertEqual(config.z_scale, expected)

    def test_invalid_json_has_stable_error(self):
        path = os.path.join(self.directory, 'broken.json')
        with open(path, 'w') as handle:
            handle.write('{')
        with self.assertRaises(Vl3dError) as context:
            load_config(path)
        self.assertEqual(context.exception.code, 'VL3D-E2002')

    def test_save_is_atomic_private_and_preserves_unknown_fields(self):
        original = {
            'schemaVersion': 1,
            'host': '127.0.0.1',
            'tools': {'python': '/usr/bin/python3.6'},
            'futureField': {'keep': True},
        }
        path = self.write(original)
        config = load_config(path)
        config.library_path = '/tmp/OA_LIB'
        config.palette = 'aurora'
        config.advanced.cds_lib = '/tmp/cds.lib'
        config.advanced.pdk_profile_dirs = ['/tmp/profiles']
        save_config(config)
        with open(path, 'r') as handle:
            saved = json.load(handle)
        self.assertEqual(saved['tools'], original['tools'])
        self.assertEqual(saved['futureField'], original['futureField'])
        self.assertEqual(saved['libraryPath'], '/tmp/OA_LIB')
        self.assertEqual(saved['native']['palette'], 'aurora')
        self.assertEqual(saved['pdkProfileDirs'], ['/tmp/profiles'])
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        backups = glob.glob(path + '.bak-*')
        self.assertEqual(len(backups), 1)
        with open(backups[0], 'r') as handle:
            self.assertEqual(json.load(handle), original)


if __name__ == '__main__':
    unittest.main()
