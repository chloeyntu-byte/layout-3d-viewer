from __future__ import absolute_import

import unittest

from native.palettes import PALETTES, palette_color, rgb


class PaletteTests(unittest.TestCase):
    def test_classic_is_default_compatible_and_m6_is_unified(self):
        self.assertIn('classic-dark-metal', PALETTES)
        self.assertEqual(palette_color('classic-dark-metal', 'METAL6'), '#38d9a9')
        self.assertEqual(palette_color('classic-dark-metal', 'M6'), '#38d9a9')

    def test_four_distinct_optional_palettes_remain(self):
        colors = [palette_color(name, 'METAL6') for name in ('cyberpunk', 'aurora', 'plasma', 'titanium')]
        self.assertEqual(len(set(colors)), 4)

    def test_invalid_custom_color_falls_back_without_crashing(self):
        self.assertEqual(rgb('#GGGGGG'), rgb('#8ecae6'))


if __name__ == '__main__':
    unittest.main()
