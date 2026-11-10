"""Bounded subprocess entry point shared by the native and browser trace clients."""
from __future__ import absolute_import

import argparse
import json
import os
import signal
import sys
import time


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args(argv)
    with open(args.request, 'r') as handle:
        request = json.load(handle)
    limits = request.get('limits') or {}
    cancelled = [False]
    signal.signal(signal.SIGTERM, lambda signum, frame: cancelled.__setitem__(0, True))
    last_progress = [0.0]

    def progress(value):
        now = time.monotonic()
        if now - last_progress[0] >= 0.1 or value.get('phase') in ('complete', 'cancelled', 'limited'):
            print('VL3D_TRACE_PROGRESS ' + json.dumps(value, separators=(',', ':')), flush=True)
            last_progress[0] = now

    # The algorithm also accounts for its own geometry/index allocations. This
    # process ceiling includes interpreter/shared-library overhead and protects
    # the UI if a malformed input expands before indexing.
    try:
        import resource
        ceiling = (int(limits.get('maxMemoryMiB', 256)) + 512) * 1024 * 1024
        soft, hard = resource.getrlimit(resource.RLIMIT_AS)
        if hard != resource.RLIM_INFINITY:
            ceiling = min(ceiling, hard)
        resource.setrlimit(resource.RLIMIT_AS, (ceiling, hard))
    except (ImportError, AttributeError, ValueError, OSError):
        pass
    try:
        from .physical_trace import PhysicalTraceIndex
        index = PhysicalTraceIndex.from_layout(request['source'], limits=limits,
            cancelled=lambda: cancelled[0], progress=progress)
        result = index.trace(request.get('pins') or [], scope_paths=request.get('scopePaths'),
            cancelled=lambda: cancelled[0], limits=limits)
        descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as handle:
            json.dump(result, handle, separators=(',', ':'), allow_nan=False)
            handle.write('\n')
        return 0
    except Exception as error:
        code = getattr(error, 'code', 'E4004')
        if isinstance(error, ImportError):
            code = 'E1013'
        print('VL3D_TRACE_ERROR %s: %s' % (code, error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
