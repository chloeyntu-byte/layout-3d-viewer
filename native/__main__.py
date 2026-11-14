from __future__ import absolute_import

import sys

from .embed import prepare_runtime

# Before anything imports tkinter: share one X11/GL stack on Pythons that bundle libX11 (conda).
prepare_runtime()

from .app import main  # noqa: E402


sys.exit(main())
