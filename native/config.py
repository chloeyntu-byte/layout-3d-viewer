from __future__ import absolute_import

import json
import os
import shutil
import tempfile
import time

from .errors import Vl3dError


DEFAULT_VIEWS = ['layout', 'maskLayout', 'chip', 'cLayout', 'dLayout', 'ivpcell']
DEFAULT_CACHE_MIB = 512


def _text(value):
    return str(value or '').strip()


def _string_list(value, fallback=None):
    if not isinstance(value, list):
        return list(fallback or [])
    return [_text(item) for item in value if _text(item)]


class AdvancedSettings(object):
    def __init__(self, library_name='', cds_lib='', cadence_env='', views=None,
                 pdk_profile='', pdk_profile_dirs=None, stream_layer_map='',
                 strict_symlinks=True, resource_mode='balanced'):
        self.library_name = _text(library_name)
        self.cds_lib = _text(cds_lib)
        self.cadence_env = _text(cadence_env)
        self.views = _string_list(views, DEFAULT_VIEWS) or list(DEFAULT_VIEWS)
        self.pdk_profile = _text(pdk_profile)
        self.pdk_profile_dirs = _string_list(pdk_profile_dirs)
        self.stream_layer_map = _text(stream_layer_map)
        self.strict_symlinks = bool(strict_symlinks)
        normalized_mode = _text(resource_mode) or 'balanced'
        self.resource_mode = {'lean': 'low', 'quality': 'large'}.get(normalized_mode, normalized_mode)
        if self.resource_mode not in ('low', 'balanced', 'large'):
            self.resource_mode = 'balanced'

    def library_overrides(self):
        result = {
            'views': list(self.views),
            'strictSymlinks': self.strict_symlinks,
            'resourceMode': self.resource_mode,
        }
        if self.library_name:
            result['libraryName'] = self.library_name
        if self.cds_lib:
            result['cdsLib'] = self.cds_lib
        if self.cadence_env:
            result['cadenceEnv'] = self.cadence_env
        if self.pdk_profile:
            result['pdkProfile'] = self.pdk_profile
        if self.pdk_profile_dirs:
            result['pdkProfileDirs'] = list(self.pdk_profile_dirs)
        return result

    def stream_overrides(self):
        result = {'resourceMode': self.resource_mode}
        if self.stream_layer_map:
            result['layerMapPath'] = self.stream_layer_map
        if self.pdk_profile:
            result['pdkProfilePath'] = self.pdk_profile
        if self.pdk_profile_dirs and not self.pdk_profile and not self.stream_layer_map:
            result['pdkProfileDirs'] = list(self.pdk_profile_dirs)
        return result


class NativeConfig(object):
    def __init__(self, source_path='', advanced=None, palette='classic-dark-metal',
                 theme='dark', z_scale=1.0, cache_mib=DEFAULT_CACHE_MIB,
                 library_path=''):
        self.source_path = source_path
        self.advanced = advanced or AdvancedSettings()
        self.palette = _text(palette) or 'classic-dark-metal'
        self.theme = 'light' if theme == 'light' else 'dark'
        self.z_scale = max(0.1, min(4.0, float(z_scale)))
        self.cache_mib = max(64, min(4096, int(cache_mib)))
        self.library_path = _text(library_path)


def apply_advanced_settings(config, values):
    if not isinstance(values, dict):
        return config
    current = config.advanced
    config.advanced = AdvancedSettings(
        library_name=values.get('libraryName', current.library_name),
        cds_lib=values.get('cdsLib', current.cds_lib),
        cadence_env=values.get('cadenceEnv', current.cadence_env),
        views=values.get('views', current.views),
        pdk_profile=values.get('pdkProfile', current.pdk_profile),
        pdk_profile_dirs=values.get('pdkProfileDirs', current.pdk_profile_dirs),
        stream_layer_map=values.get('streamLayerMap', current.stream_layer_map),
        strict_symlinks=values.get('strictSymlinks', current.strict_symlinks),
        resource_mode=values.get('resourceMode', current.resource_mode),
    )
    return config


def default_config_path(environment=None):
    environment = environment or os.environ
    base = environment.get('XDG_CONFIG_HOME') or os.path.join(
        environment.get('HOME') or os.path.expanduser('~'), '.config')
    return os.path.join(base, 'vl3d', 'config.json')


def load_config(path=None):
    selected = path or default_config_path()
    if not selected or not os.path.isfile(selected):
        return NativeConfig(source_path=selected or '')
    try:
        with open(selected, 'r') as handle:
            raw = json.load(handle)
    except IOError as error:
        raise Vl3dError('E2001', 'Cannot read VL3D configuration: %s' % error)
    except ValueError as error:
        raise Vl3dError('E2002', 'Cannot decode VL3D configuration: %s' % error)
    if not isinstance(raw, dict):
        raise Vl3dError('E2002', 'VL3D configuration must be a JSON object')
    native = raw.get('native') if isinstance(raw.get('native'), dict) else {}
    advanced = AdvancedSettings(
        library_name=raw.get('libraryName', native.get('libraryName', '')),
        cds_lib=raw.get('cdsLib', native.get('cdsLib', '')),
        cadence_env=raw.get('cadenceEnv', native.get('cadenceEnv', '')),
        views=raw.get('views', native.get('views', DEFAULT_VIEWS)),
        pdk_profile=raw.get('pdkProfile', native.get('pdkProfile', '')),
        pdk_profile_dirs=raw.get('pdkProfileDirs', native.get('pdkProfileDirs', [])),
        stream_layer_map=raw.get('streamLayerMap', native.get('streamLayerMap', '')),
        strict_symlinks=raw.get('strictSymlinks', native.get('strictSymlinks', True)),
        resource_mode=raw.get('resourceMode', native.get('resourceMode', 'balanced')),
    )
    return NativeConfig(
        source_path=selected,
        advanced=advanced,
        palette=native.get('palette', 'classic-dark-metal'),
        theme=native.get('theme', 'dark'),
        z_scale=native.get('zScale', 1.0),
        cache_mib=native.get('cacheMiB', DEFAULT_CACHE_MIB),
        library_path=raw.get('libraryPath', native.get('libraryPath', '')),
    )


def _set_or_remove(mapping, key, value):
    if value in ('', None, []) or value == ():
        mapping.pop(key, None)
    else:
        mapping[key] = value


def _backup_path(path):
    timestamp = int(time.time())
    while True:
        candidate = '%s.bak-%s' % (path, time.strftime('%Y%m%d-%H%M%S', time.localtime(timestamp)))
        if not os.path.exists(candidate):
            return candidate
        timestamp += 1


def save_config(config):
    path = config.source_path or default_config_path()
    directory = os.path.dirname(os.path.realpath(path))
    temporary = ''
    try:
        if os.path.isfile(path):
            with open(path, 'r') as handle:
                raw = json.load(handle)
            if not isinstance(raw, dict):
                raise ValueError('configuration root is not an object')
        else:
            raw = {'schemaVersion': 1}
        native = raw.get('native') if isinstance(raw.get('native'), dict) else {}
        native = dict(native)
        native.update({
            'palette': config.palette,
            'theme': config.theme,
            'zScale': config.z_scale,
            'cacheMiB': config.cache_mib,
        })
        raw['native'] = native
        raw['schemaVersion'] = int(raw.get('schemaVersion') or 1)
        _set_or_remove(raw, 'libraryPath', config.library_path)
        _set_or_remove(raw, 'libraryName', config.advanced.library_name)
        _set_or_remove(raw, 'cdsLib', config.advanced.cds_lib)
        _set_or_remove(raw, 'cadenceEnv', config.advanced.cadence_env)
        _set_or_remove(raw, 'views', list(config.advanced.views))
        _set_or_remove(raw, 'pdkProfile', config.advanced.pdk_profile)
        _set_or_remove(raw, 'pdkProfileDirs', list(config.advanced.pdk_profile_dirs))
        _set_or_remove(raw, 'streamLayerMap', config.advanced.stream_layer_map)
        raw['strictSymlinks'] = bool(config.advanced.strict_symlinks)
        raw['resourceMode'] = config.advanced.resource_mode

        if not os.path.isdir(directory):
            os.makedirs(directory, 0o700)
        if os.path.isfile(path):
            backup = _backup_path(path)
            shutil.copy2(path, backup)
        descriptor, temporary = tempfile.mkstemp(prefix='.config-', suffix='.tmp', dir=directory)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, 'w') as handle:
                json.dump(raw, handle, indent=2, sort_keys=True)
                handle.write('\n')
                handle.flush()
                os.fsync(handle.fileno())
            descriptor = -1
        finally:
            if descriptor >= 0:
                os.close(descriptor)
        os.rename(temporary, path)
        temporary = ''
        os.chmod(path, 0o600)
        config.source_path = path
        return path
    except (IOError, OSError, ValueError, TypeError) as error:
        raise Vl3dError('E2014', 'Cannot persist VL3D configuration: %s' % error)
    finally:
        if temporary and os.path.exists(temporary):
            try:
                os.unlink(temporary)
            except OSError:
                pass
