from __future__ import absolute_import

import io
import unittest
from contextlib import redirect_stderr

from native.app import _install_callback_exception_handler, argument_parser, read_bootstrap
from native.errors import Vl3dError


class BootstrapTests(unittest.TestCase):
    def test_bootstrap_reads_one_json_line(self):
        options = argument_parser().parse_args(['--backend-stdin', '--root', '/tmp/project'])
        stream = io.StringIO(
            '{"backendUrl":"http://127.0.0.1:43121","token":"secret","configFile":"/tmp/c.json",'
            '"advancedSettings":{"resourceMode":"low","views":["chip"]}}\nignored')
        result = read_bootstrap(options, input_stream=stream)
        self.assertEqual(result['backendUrl'], 'http://127.0.0.1:43121')
        self.assertEqual(result['token'], 'secret')
        self.assertEqual(result['configFile'], '/tmp/c.json')
        self.assertEqual(result['advancedSettings']['resourceMode'], 'low')
        self.assertEqual(result['advancedSettings']['views'], ['chip'])
        self.assertTrue(stream.closed)

    def test_bootstrap_rejects_non_object_advanced_settings(self):
        options = argument_parser().parse_args(['--backend-stdin'])
        with self.assertRaises(Vl3dError) as context:
            read_bootstrap(options, input_stream=io.StringIO(
                '{"backendUrl":"http://127.0.0.1:43121","advancedSettings":[]}\n'))
        self.assertEqual(context.exception.code, 'VL3D-E8009')

    def test_missing_backend_is_e8009(self):
        options = argument_parser().parse_args([])
        with self.assertRaises(Vl3dError) as context:
            read_bootstrap(options)
        self.assertEqual(context.exception.code, 'VL3D-E8009')

    def test_tk_callback_exception_is_numbered_and_closes_after_display(self):
        class Root(object):
            def __init__(self):
                self.callback = None

            def after_idle(self, callback):
                self.callback = callback

        class Application(object):
            def __init__(self):
                self.shown = None
                self.closed = False

            def _show_error(self, error):
                self.shown = error

            def close(self):
                self.closed = True

        root = Root()
        application = Application()
        state = _install_callback_exception_handler(root, application)
        with redirect_stderr(io.StringIO()):
            root.report_callback_exception(RuntimeError, RuntimeError('OpenGL callback failed'), None)
        self.assertEqual(state['error'].code, 'VL3D-E9001')
        self.assertEqual(application.shown.code, 'VL3D-E9001')
        self.assertFalse(application.closed)
        root.callback()
        self.assertTrue(application.closed)


if __name__ == '__main__':
    unittest.main()
