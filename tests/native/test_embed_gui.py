"""Lifecycle checks for the embedded preview that need an X display (skipped otherwise)."""
from __future__ import absolute_import

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from native import embed  # noqa: E402


@unittest.skipUnless(os.environ.get('DISPLAY') and embed.available()[0], 'needs an X display with OpenGL')
class PreviewLifecycleTest(unittest.TestCase):
    def setUp(self):
        import tkinter
        self.root = tkinter.Tk()
        self.errors = []
        self.root.report_callback_exception = lambda kind, value, trace: self.errors.append(value)

    def tearDown(self):
        try:
            self.root.destroy()
        except Exception:
            pass

    def _pump(self, milliseconds):
        done = []
        self.root.after(milliseconds, lambda: done.append(True))
        while not done:
            self.root.update()

    def test_context_failure_degrades_without_tk_errors(self):
        from native import gl_view

        def broken(view):
            raise RuntimeError('injected context failure')
        saved = gl_view.LayoutGLView.tkCreateContext
        gl_view.LayoutGLView.tkCreateContext = broken
        try:
            holder = __import__('tkinter').Frame(self.root)
            holder.pack(fill='both', expand=True)
            preview = embed.Preview3D(holder)
            preview.pack(fill='both', expand=True)
            preview.set_scene(embed.scene_from_geometry([{'layer': 'M1', 'bbox': [[0, 0], [1, 1]]}]))
            self._pump(400)
            self.assertFalse(preview.ok)
            self.assertIn('injected', preview.reason)
            self.assertIsNone(preview.view)
            holder.destroy()
            self._pump(300)
        finally:
            gl_view.LayoutGLView.tkCreateContext = saved
        self.assertEqual(self.errors, [])

    def test_parent_destroy_cancels_pending_update(self):
        import tkinter
        holder = tkinter.Frame(self.root)
        holder.pack(fill='both', expand=True)
        preview = embed.Preview3D(holder)
        preview.pack(fill='both', expand=True)
        self._pump(300)
        preview.set_scene(embed.scene_from_geometry([{'layer': 'M1', 'bbox': [[0, 0], [1, 1]]}]))
        holder.destroy()
        self._pump(400)
        self.assertEqual(self.errors, [])


if __name__ == '__main__':
    unittest.main()
