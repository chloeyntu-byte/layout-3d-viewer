from __future__ import absolute_import

import unittest

from native.navigation import CameraState, PointerStateMachine
from native.gl_view import LayoutGLView


class FakeClock(object):
    def __init__(self):
        self.value = 10.0

    def __call__(self):
        return self.value


class NavigationTests(unittest.TestCase):
    def test_single_click_never_enters_fast_mode(self):
        clock = FakeClock()
        pointer = PointerStateMachine(clock=clock)
        pointer.press(10, 10)
        pointer.release()
        self.assertFalse(pointer.fast)
        clock.value += 1.0
        self.assertFalse(pointer.poll().left_fast)

    def test_single_click_does_not_schedule_restore_poll(self):
        class Widget(object):
            def __init__(self):
                self.pointer = PointerStateMachine()
                self.scheduled = False

            def _schedule_restore_poll(self):
                self.scheduled = True

        widget = Widget()
        widget.pointer.press(10, 10)
        LayoutGLView._button_release(widget, None)
        self.assertFalse(widget.pointer.fast)
        self.assertFalse(widget.scheduled)

    def test_drag_enters_fast_then_restores_after_180ms(self):
        clock = FakeClock()
        pointer = PointerStateMachine(clock=clock)
        pointer.press(0, 0)
        self.assertFalse(pointer.move(1, 1).entered_fast)
        update = pointer.move(3, 0)
        self.assertTrue(update.entered_fast)
        self.assertTrue(pointer.fast)
        pointer.release()
        clock.value += 0.179
        self.assertFalse(pointer.poll().left_fast)
        clock.value += 0.002
        self.assertTrue(pointer.poll().left_fast)
        self.assertFalse(pointer.fast)

    def test_natural_vertical_drag_uses_expected_direction(self):
        camera = CameraState(pitch=0.7, invert_orbit_x=True, invert_orbit_y=True)
        camera.orbit(0, 10)
        self.assertLess(camera.pitch, 0.7)
        camera = CameraState(yaw=0.7, invert_orbit_x=True, invert_orbit_y=True)
        camera.orbit(10, 0)
        self.assertLess(camera.yaw, 0.7)

    def test_threshold_update_keeps_full_first_delta(self):
        pointer = PointerStateMachine()
        pointer.press(12, 20)
        update = pointer.move(16, 25)
        self.assertEqual(update.delta_x, 4.0)
        self.assertEqual(update.delta_y, 5.0)


if __name__ == '__main__':
    unittest.main()
