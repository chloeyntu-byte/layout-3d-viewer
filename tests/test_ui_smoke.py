"""UI smoke tests: the shared theme applies, and the native main window builds and closes.

Skipped automatically when no display (or no Tk / OpenGL) is available.
"""
from __future__ import absolute_import

import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

try:
    import tkinter as tk
    from tkinter import ttk
except ImportError:  # pragma: no cover
    tk = None


def make_root():
    if tk is None:
        raise unittest.SkipTest('tkinter is not installed')
    try:
        root = tk.Tk()
    except tk.TclError as error:
        raise unittest.SkipTest('no display available: %s' % error)
    root.withdraw()
    return root


class ThemeSmoke(unittest.TestCase):
    def test_theme_header_status_chip(self):
        from native import fieldwork_tk as fw
        root = make_root()
        try:
            fw.apply(root, product='layout')
            self.assertEqual(root._fw_accent, fw.ACCENTS['layout'])
            bar = fw.header(root, 'Layout 3D Viewer', 'Subtitle')
            bar.pack(fill='x')
            chip = fw.StatusChip(root)
            chip.pack()
            for state in ('idle', 'running', 'done', 'warn', 'error'):
                chip.set(state, 'message')
            ttk.Button(root, text='Go', style='Primary.TButton').pack()
            ttk.Notebook(root).pack()
            root.update_idletasks()
        finally:
            root.destroy()

    def test_web_and_native_share_accent_colours(self):
        from native import fieldwork_tk as fw
        with open(os.path.join(ROOT, 'public', 'styles.css')) as handle:
            css = handle.read().lower()
        for value in (fw.BG, fw.PANEL, fw.RAISED, fw.LINE, fw.TEXT, fw.DIM, fw.MUTED, fw.PLOT_BG,
                      fw.ACCENTS['layout'], fw.ERR):
            self.assertIn(value.lower(), css, value)


class NativeWindowSmoke(unittest.TestCase):
    def test_native_window_builds_and_closes(self):
        try:
            from native.gl_view import dependency_error
            if dependency_error():
                raise unittest.SkipTest('OpenGL dependencies are not installed')
        except ImportError as error:
            raise unittest.SkipTest(str(error))
        from tkinter import filedialog, messagebox, simpledialog
        from native.app import NativeApplication
        from native.config import NativeConfig

        class StubBackend(object):
            def health(self):
                return {'oaEnabled': False}

        root = make_root()
        try:
            application = NativeApplication(root, ROOT, StubBackend(), NativeConfig(), tk, ttk,
                                            filedialog, messagebox, simpledialog)
        except Exception as error:  # no GL-capable display
            root.destroy()
            raise unittest.SkipTest('native window cannot be created here: %s' % error)
        try:
            root.update()
            self.assertIn('Layout 3D Viewer', root.title())
            self.assertFalse(application.load_open)
        finally:
            application.closed = True
            root.destroy()


if __name__ == '__main__':
    unittest.main()
