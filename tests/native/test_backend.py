from __future__ import absolute_import

import json
import os
import shutil
import tempfile
import threading
import unittest
import stat
try:
    from http.server import BaseHTTPRequestHandler, HTTPServer
except ImportError:
    from BaseHTTPServer import BaseHTTPRequestHandler, HTTPServer

from native.backend import BackendClient, LibraryChoiceRequired, TopCellChoiceRequired
from native.config import AdvancedSettings
from native.errors import Vl3dError


class Handler(BaseHTTPRequestHandler):
    authorization = ''
    preference = ''
    request_body = None
    operation_error = None
    post_error = None
    download_payload = b''
    operation_result = None
    delete_count = 0

    def log_message(self, format_string, *arguments):
        return

    def _json(self, status, payload):
        content = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_POST(self):
        length = int(self.headers.get('content-length') or 0)
        Handler.request_body = json.loads(self.rfile.read(length).decode('utf-8'))
        Handler.authorization = self.headers.get('authorization')
        Handler.preference = self.headers.get('prefer')
        if Handler.post_error:
            self._json(409, Handler.post_error)
            return
        self._json(202, {'operationId': 'op-1'})

    def do_GET(self):
        if self.path.startswith('/public/'):
            content = Handler.download_payload
            self.send_response(200)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)
            return
        if Handler.operation_error:
            self._json(200, {'state': 'failed', 'error': Handler.operation_error})
            return
        self._json(200, {
            'state': 'completed',
            'result': Handler.operation_result or {'entry': {'path': 'data/result.json', 'cell': 'TOP'}},
        })

    def do_DELETE(self):
        Handler.delete_count += 1
        self._json(200, {'state': 'cancelled'})


class BackendTests(unittest.TestCase):
    def setUp(self):
        Handler.operation_error = None
        Handler.post_error = None
        Handler.download_payload = b''
        Handler.operation_result = None
        Handler.delete_count = 0
        Handler.request_body = None
        self.server = HTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.daemon = True
        self.thread.start()
        self.client = BackendClient('http://127.0.0.1:%d' % self.server.server_port, 'private-token')
        self.directory = tempfile.mkdtemp(prefix='vl3d-backend-test-')

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        shutil.rmtree(self.directory)

    def test_stream_request_is_flat_async_and_authenticated(self):
        settings = AdvancedSettings(
            pdk_profile='/tmp/pdk.json', stream_layer_map='/tmp/layers.json',
            pdk_profile_dirs=['/tmp/unsupported'])
        entry = self.client.import_stream('/tmp/layout.gds', settings.stream_overrides())
        self.assertEqual(entry['cell'], 'TOP')
        self.assertEqual(Handler.authorization, 'Bearer private-token')
        self.assertEqual(Handler.preference, 'respond-async')
        self.assertEqual(Handler.request_body['layerMapPath'], '/tmp/layers.json')
        self.assertEqual(Handler.request_body['pdkProfilePath'], '/tmp/pdk.json')
        self.assertEqual(Handler.request_body['resourceMode'], 'balanced')
        self.assertNotIn('overrides', Handler.request_body)
        self.assertNotIn('pdkProfileDirs', Handler.request_body)

        directory_settings = AdvancedSettings(
            pdk_profile_dirs=['/tmp/profiles'], resource_mode='low')
        self.client.import_stream('/tmp/layout.gds', directory_settings.stream_overrides())
        self.assertEqual(Handler.request_body['pdkProfileDirs'], ['/tmp/profiles'])
        self.assertEqual(Handler.request_body['resourceMode'], 'low')

    def test_async_multiple_top_error_keeps_candidates(self):
        Handler.operation_error = {
            'code': 'VL3D-E6002',
            'message': 'Multiple top cells found',
            'details': {'topCells': ['A', 'B']},
        }
        with self.assertRaises(TopCellChoiceRequired) as context:
            self.client.import_stream('/tmp/layout.gds')
        self.assertEqual(context.exception.candidates, ['A', 'B'])

    def test_multiple_libraries_preserve_candidate_names_and_paths(self):
        candidates = [{'name': 'analog', 'path': '/project/analog'}, {'name': 'digital', 'path': '/project/digital'}]
        Handler.post_error = {'error': {'code': 'E2008', 'message': 'Choose library', 'details': {'candidates': candidates}}}
        with self.assertRaises(LibraryChoiceRequired) as context:
            self.client.create_library_session('/project')
        self.assertEqual(context.exception.candidates, candidates)
        self.assertEqual(context.exception.details['candidates'], candidates)

    def test_environment_ambiguity_does_not_open_library_picker(self):
        Handler.post_error = {'code': 'E2008', 'message': 'Choose environment', 'details': {'candidates': ['/env/a', '/env/b']}}
        with self.assertRaises(Vl3dError) as context:
            self.client.create_library_session('/project')
        self.assertNotIsInstance(context.exception, LibraryChoiceRequired)

    def test_physical_trace_reuses_async_operation_and_explicit_scope(self):
        Handler.operation_result = {'status': 'complete', 'complete': True, 'shapeIndices': [0, 8], 'sourceDigest': 'abc'}
        operations = []
        pin = {'hierPath': 'TOP/U1', 'terminal': 'A', 'layer': 'M1'}
        result = self.client.trace_layout('/tmp/layout.json', [pin], ['TOP/U1'], operation_callback=operations.append)
        self.assertEqual(result['shapeIndices'], [0, 8])
        self.assertEqual(operations, ['op-1'])
        self.assertEqual(Handler.request_body, {'path': '/tmp/layout.json', 'pins': [pin], 'scopePaths': ['TOP/U1']})
        self.assertEqual(Handler.authorization, 'Bearer private-token')

    def test_physical_trace_cancel_after_submit_cancels_backend_child(self):
        cancel = threading.Event()
        with self.assertRaises(Vl3dError) as context:
            self.client.trace_layout('/tmp/layout.json', [{}], cancel_event=cancel,
                                     operation_callback=lambda unused: cancel.set())
        self.assertEqual(context.exception.code, 'VL3D-E7004')
        self.assertEqual(Handler.delete_count, 1)

    def test_physical_trace_canceled_before_submit_never_sends_layout(self):
        cancel = threading.Event()
        cancel.set()
        with self.assertRaises(Vl3dError):
            self.client.trace_layout('/tmp/layout.json', [{}], cancel_event=cancel)
        self.assertIsNone(Handler.request_body)

    def test_layout_download_writes_atomic_file(self):
        Handler.download_payload = b'{"cell":"TOP"}\n' * 180000
        target = self.client.download_entry(
            {'path': 'data/result.json', 'library': 'L', 'cell': 'TOP', 'view': 'layout'},
            self.directory)
        self.assertTrue(os.path.isfile(target))
        self.assertEqual(os.path.getsize(target), len(Handler.download_payload))
        self.assertFalse(any(name.startswith('.tmp-') for name in os.listdir(self.directory)))
        self.assertEqual(stat.S_IMODE(os.stat(self.directory).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(target).st_mode), 0o600)

    def test_layout_download_rejects_symlink_directory(self):
        real_directory = os.path.join(self.directory, 'real')
        link = os.path.join(self.directory, 'link')
        os.mkdir(real_directory)
        os.symlink(real_directory, link)
        with self.assertRaises(Vl3dError) as context:
            self.client.download_entry({'path': 'data/result.json'}, link)
        self.assertEqual(context.exception.code, 'VL3D-E9003')


if __name__ == '__main__':
    unittest.main()
