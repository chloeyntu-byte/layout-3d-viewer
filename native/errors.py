from __future__ import absolute_import

import re


_CODE_RE = re.compile(r'^(?:VL3D-)?(E[0-9]{3,5})$', re.IGNORECASE)


def normalized_code(value, fallback='E9001'):
    match = _CODE_RE.match(str(value or '').strip())
    if not match:
        match = _CODE_RE.match(str(fallback or 'E9001').strip())
    return 'VL3D-' + match.group(1).upper()


class Vl3dError(Exception):
    def __init__(self, code, message, details=None):
        self.code = normalized_code(code)
        self.message = str(message)
        self.details = details
        Exception.__init__(self, '%s %s' % (self.code, self.message))


def error_from_payload(payload, fallback_code='E9001', fallback_message='VL3D request failed'):
    if not isinstance(payload, dict):
        return Vl3dError(fallback_code, fallback_message)
    nested = payload.get('error') if isinstance(payload.get('error'), dict) else {}
    code = nested.get('code') or payload.get('code') or fallback_code
    message = nested.get('message') or payload.get('message') or fallback_message
    details = nested.get('details') or payload.get('details')
    return Vl3dError(code, message, details)

