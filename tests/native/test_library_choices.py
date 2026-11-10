import unittest
from types import SimpleNamespace

from native.app import NativeApplication


class Value(object):
    def __init__(self, value=''):
        self.value = value

    def get(self):
        return self.value

    def set(self, value):
        self.value = value


class LibraryChoiceTests(unittest.TestCase):
    def test_backups_are_labeled_last_but_keep_exact_load_identity(self):
        app = NativeApplication.__new__(NativeApplication)
        app.config = SimpleNamespace(library_path='')
        app._persist_config = lambda: None
        app._pending_library_path = '/project/LIB'
        options = {}
        app.cell_combo = SimpleNamespace(configure=lambda **kwargs: options.update(kwargs))
        app.cell_value = Value()
        app.source_value = Value()
        app.load_explanations = {key: Value() for key in ('cds_lib', 'cadence_env', 'pdk_profile')}
        app.load_hint = Value()
        app.status_value = Value()
        backup = {'cell': 'A.bak-20261003-145044', 'view': 'layout',
                  'key': 'LIB/A.bak-20261003-145044/layout', 'isBackup': True}
        normal = {'cell': 'Z', 'view': 'layout', 'key': 'LIB/Z/layout', 'isBackup': False}
        similar = {'cell': 'A.bak-not-a-date', 'view': 'layout', 'isBackup': False}
        app._library_loaded({'library': {'name': 'LIB'}, 'layouts': [backup, normal, similar]})
        self.assertEqual(options['values'], ('A.bak-not-a-date', 'Z', 'A.bak-20261003-145044 · Backup'))
        for query in (options['values'][-1], backup['cell'], backup['key']):
            app.cell_value.set(query)
            self.assertIs(app._selected_record(), backup)
        self.assertEqual(backup['cell'], 'A.bak-20261003-145044')


if __name__ == '__main__':
    unittest.main()
