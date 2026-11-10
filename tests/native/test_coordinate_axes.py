from __future__ import absolute_import

import unittest

from native.gl_view import AXIS_COLORS, LAYOUT_AXIS_VECTORS, pin_number


class CoordinateAxisTests(unittest.TestCase):
    def test_pin_numbers_match_inspector_labels(self):
        self.assertEqual(pin_number(0), '#1')
        self.assertEqual(pin_number(47), '#48')

    def test_layout_axes_match_renderer_coordinate_mapping(self):
        self.assertEqual(LAYOUT_AXIS_VECTORS['x'], (1.0, 0.0, 0.0))
        self.assertEqual(LAYOUT_AXIS_VECTORS['y'], (0.0, 0.0, -1.0))
        self.assertEqual(LAYOUT_AXIS_VECTORS['z'], (0.0, 1.0, 0.0))

    def test_each_layout_axis_has_its_own_low_saturation_color(self):
        self.assertEqual(set(AXIS_COLORS), set(LAYOUT_AXIS_VECTORS))
        self.assertEqual(len(set(AXIS_COLORS.values())), 3)
        for color in AXIS_COLORS.values():
            self.assertTrue(all(0.0 <= component <= 0.7 for component in color))


if __name__ == '__main__':
    unittest.main()
