from __future__ import absolute_import

import json
import os
import tempfile
import time
try:
    from urllib.error import HTTPError, URLError
    from urllib.parse import quote, urljoin, urlparse
    from urllib.request import Request, urlopen
except ImportError:
    from urllib2 import HTTPError, URLError, Request, urlopen
    from urlparse import urljoin, urlparse
    from urllib import quote

from .errors import Vl3dError, error_from_payload


class TopCellChoiceRequired(Vl3dError):
    def __init__(self, message, candidates, details=None):
        self.candidates = list(candidates or [])
        Vl3dError.__init__(self, 'E6002', message, details)


class LibraryChoiceRequired(Vl3dError):
    def __init__(self, message, candidates, details=None):
        self.candidates = list(candidates or [])
        Vl3dError.__init__(self, 'E2008', message, details)


class BackendClient(object):
    def __init__(self, base_url, token='', timeout=120.0):
        self.base_url = str(base_url or '').rstrip('/') + '/'
        parsed = urlparse(self.base_url)
        if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1'):
            raise Vl3dError('E8009', 'Native backend URL must use loopback HTTP')
        self._token = str(token or '')
        self.timeout = float(timeout)

    def _url(self, path):
        return urljoin(self.base_url, str(path or '').lstrip('/'))

    def _headers(self, extra=None):
        headers = {'accept': 'application/json'}
        if self._token:
            headers['authorization'] = 'Bearer ' + self._token
        headers.update(extra or {})
        return headers

    def _request(self, method, path, payload=None, timeout=None, accept_json=True,
                 extra_headers=None):
        body = None
        headers = self._headers(extra_headers)
        if payload is not None:
            body = json.dumps(payload, separators=(',', ':')).encode('utf-8')
            headers['content-type'] = 'application/json'
        request = Request(self._url(path), data=body, headers=headers)
        request.get_method = lambda: method
        try:
            response = urlopen(request, timeout=timeout or self.timeout)
            content = response.read()
            status = getattr(response, 'status', response.getcode())
        except HTTPError as error:
            content = error.read()
            try:
                payload = json.loads(content.decode('utf-8', 'replace'))
            except ValueError:
                payload = {'message': content.decode('utf-8', 'replace') or str(error)}
            raise error_from_payload(payload, 'E8009', 'Native backend request failed (%s)' % error.code)
        except URLError as error:
            raise Vl3dError('E8009', 'Native backend is unavailable: %s' % error)
        if not accept_json:
            return status, content
        try:
            return json.loads(content.decode('utf-8')) if content else {}
        except ValueError as error:
            raise Vl3dError('E9003', 'Native backend returned invalid JSON: %s' % error)

    def health(self):
        return self._request('GET', '/api/health', timeout=5.0)

    def create_library_session(self, path, overrides=None):
        try:
            return self._request('POST', '/api/library-sessions', {
                'path': os.path.realpath(path),
                'overrides': overrides or {},
            })
        except Vl3dError as error:
            details = error.details if isinstance(error.details, dict) else {}
            candidates = details.get('candidates') or []
            if error.code == 'VL3D-E2008' and candidates and all(
                    isinstance(item, dict) and item.get('name') and item.get('path')
                    for item in candidates):
                raise LibraryChoiceRequired(error.message, candidates, details)
            raise

    def describe_library_session(self, session_id):
        return self._request('GET', '/api/library-sessions/%s' % quote(str(session_id)))

    def delete_library_session(self, session_id):
        return self._request('DELETE', '/api/library-sessions/%s' % quote(str(session_id)))

    def prepare_layout(self, session_id, record, refresh=False):
        payload = {
            'sessionId': session_id,
            'library': record.get('library'),
            'cell': record.get('cell'),
            'view': record.get('view') or 'layout',
            'refresh': bool(refresh),
        }
        result = self._request('POST', '/api/layouts/prepare', payload, timeout=600.0)
        return result.get('entry') or result

    def import_stream(self, path, overrides=None, top_cell='', operation_callback=None,
                      cancel_event=None):
        payload = {'path': os.path.realpath(path)}
        payload.update(overrides or {})
        if top_cell:
            payload['topCell'] = top_cell
        try:
            result = self._request(
                'POST', '/api/streams/import', payload, timeout=600.0,
                extra_headers={'prefer': 'respond-async'})
        except Vl3dError as error:
            details = error.details if isinstance(error.details, dict) else {}
            candidates = details.get('topCells') or details.get('candidates') or []
            if error.code == 'VL3D-E6002' and candidates:
                raise TopCellChoiceRequired(error.message, candidates, details)
            raise
        if result.get('operationId'):
            if operation_callback:
                operation_callback(result['operationId'])
            try:
                result = self.wait_operation(result['operationId'], cancel_event=cancel_event)
            except Vl3dError as error:
                details = error.details if isinstance(error.details, dict) else {}
                candidates = details.get('topCells') or details.get('candidates') or []
                if error.code == 'VL3D-E6002' and candidates:
                    raise TopCellChoiceRequired(error.message, candidates, details)
                raise
        candidates = result.get('topCells') or result.get('candidates') or []
        if not result.get('entry') and candidates:
            raise TopCellChoiceRequired('Choose a top cell for this stream layout', candidates, result)
        return result.get('entry') or result

    def trace_layout(self, path, pins, scope_paths=None, limits=None,
                     operation_callback=None, cancel_event=None, progress_callback=None):
        if cancel_event is not None and cancel_event.is_set():
            raise Vl3dError('E7004', 'Physical trace was canceled')
        payload = {'path': os.path.realpath(path), 'pins': list(pins), 'scopePaths': scope_paths}
        if limits:
            payload['limits'] = dict(limits)
        result = self._request('POST', '/api/traces', payload, timeout=30.0,
                               extra_headers={'prefer': 'respond-async'})
        if not result.get('operationId'):
            raise Vl3dError('E9003', 'Physical trace did not return an operation identifier')
        if operation_callback:
            operation_callback(result['operationId'])
        return self.wait_operation(result['operationId'], cancel_event=cancel_event,
                                   progress_callback=progress_callback)

    def wait_operation(self, operation_id, timeout=600.0, interval=0.2,
                       cancel_event=None, progress_callback=None):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if cancel_event is not None and cancel_event.is_set():
                self.cancel_operation(operation_id)
                raise Vl3dError('E7004', 'Backend operation was canceled')
            result = self._request('GET', '/api/operations/%s' % quote(str(operation_id)))
            if progress_callback and result.get('progress'):
                progress_callback(result['progress'])
            state = result.get('state') or result.get('status')
            if state in ('complete', 'completed', 'succeeded'):
                return result.get('result') or result
            if state in ('failed', 'canceled', 'cancelled'):
                raise error_from_payload(result.get('error') or result, 'E6004', 'Backend operation failed')
            if cancel_event is not None:
                cancel_event.wait(interval)
            else:
                time.sleep(interval)
        try:
            self.cancel_operation(operation_id)
        except Vl3dError:
            pass
        raise Vl3dError('E7004', 'Backend operation timed out and was canceled')

    def cancel_operation(self, operation_id):
        return self._request('DELETE', '/api/operations/%s' % quote(str(operation_id)))

    def download_entry(self, entry, directory=None):
        path = str(entry.get('path') or '')
        if not path or path.startswith('/') or '..' in path.split('/'):
            raise Vl3dError('E9003', 'Backend layout entry contains an unsafe path')
        directory = directory or tempfile.mkdtemp(prefix='vl3d-layout-')
        directory = os.path.abspath(os.path.expanduser(directory))
        if os.path.lexists(directory):
            if os.path.islink(directory) or not os.path.isdir(directory):
                raise Vl3dError('E9003', 'Layout download directory is unsafe: %s' % directory)
        else:
            try:
                os.makedirs(directory, 0o700)
            except OSError:
                if not os.path.isdir(directory) or os.path.islink(directory):
                    raise
        os.chmod(directory, 0o700)
        identity = '%s@%s@%s.json' % (
            entry.get('library') or 'local', entry.get('cell') or 'layout', entry.get('view') or 'layout')
        safe_name = ''.join(character if character.isalnum() or character in '._-@' else '_' for character in identity)
        target = os.path.join(directory, safe_name)
        if os.path.islink(target):
            raise Vl3dError('E9003', 'Layout download target is an unsafe symlink')
        descriptor, temporary = tempfile.mkstemp(prefix='.' + safe_name + '.tmp-', dir=directory)
        os.fchmod(descriptor, 0o600)
        request = Request(self._url('/public/' + path), headers=self._headers({'accept': 'application/json, application/gzip'}))
        response = None
        try:
            response = urlopen(request, timeout=300.0)
            try:
                handle = os.fdopen(descriptor, 'wb')
                descriptor = -1
            except Exception:
                os.close(descriptor)
                descriptor = -1
                raise
            with handle:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    handle.write(chunk)
                handle.flush()
                os.fsync(handle.fileno())
            os.rename(temporary, target)
            os.chmod(target, 0o600)
        except HTTPError as error:
            try:
                payload = json.loads(error.read().decode('utf-8', 'replace'))
            except ValueError:
                payload = {'message': str(error)}
            raise error_from_payload(payload, 'E8009', 'Layout download failed (%s)' % error.code)
        except URLError as error:
            raise Vl3dError('E8009', 'Layout download failed: %s' % error)
        finally:
            if response is not None:
                try:
                    response.close()
                except Exception:
                    pass
            if descriptor >= 0:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
            if os.path.isfile(temporary):
                try:
                    os.unlink(temporary)
                except OSError:
                    pass
        return target
