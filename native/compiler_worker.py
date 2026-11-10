from __future__ import absolute_import

import argparse
import json
import sys

from .compiler import compile_layout
from .errors import Vl3dError


def main(argv=None):
    parser = argparse.ArgumentParser(prog='python -m native.compiler_worker')
    parser.add_argument('--source', required=True)
    parser.add_argument('--target', required=True)
    parser.add_argument('--fingerprint', required=True)
    options = parser.parse_args(argv)
    try:
        compile_layout(options.source, options.target, options.fingerprint)
    except Vl3dError as error:
        sys.stderr.write(json.dumps({'code': error.code, 'message': error.message}) + '\n')
        return 2
    except Exception as error:
        sys.stderr.write(json.dumps({'code': 'VL3D-E4002', 'message': str(error)}) + '\n')
        return 3
    return 0


if __name__ == '__main__':
    sys.exit(main())

