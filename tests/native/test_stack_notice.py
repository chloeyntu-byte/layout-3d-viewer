from __future__ import absolute_import

import copy
import unittest
from types import SimpleNamespace

from native.app import NativeApplication, approximate_stack_note


class Value(object):
    def __init__(self): self.value = ''
    def set(self, value): self.value = value


class StackNoticeTests(unittest.TestCase):
    def test_known_process_still_exposes_approximate_z(self):
        metadata = {'technology': {'profile': 'example-process', 'approximateLayers': ['TM1', 'TM2']}}
        self.assertIn('Z heights/thicknesses are approximate', approximate_stack_note(metadata))
        self.assertIn('XY dimensions match', approximate_stack_note(metadata))
        self.assertIn('approximate', approximate_stack_note({'layers': [{'routing': True, 'geometryApproximate': True}]}))
        self.assertEqual('', approximate_stack_note({'technology': 'calibrated', 'layers': [{'routing': False, 'geometryApproximate': True}]}))

    def test_unresolved_stack_report_preserves_metadata(self):
        metadata = {'technology': {'profile': 'other-process', 'unresolvedStackLayers': ['CTM', 'CBM']},
                    'pins': [{'terminal': ' A<3> ', 'bbox': {'min': [1, 2], 'max': [3, 4]}}]}
        before = copy.deepcopy(metadata)
        self.assertIn('Layer position unconfirmed (hidden by default): CTM, CBM', approximate_stack_note(metadata))
        self.assertEqual(metadata, before)

    def test_notice_stays_present_without_selection_and_after_ready(self):
        metadata = {'cell': 'TEST', 'technology': {'approximateLayers': ['M1'], 'unresolvedStackLayers': ['CTM']}}
        compiled = SimpleNamespace(metadata=metadata)
        app = SimpleNamespace(compiled=compiled, closed=False, inspector_value=Value(), pin_note=Value(), status_value=Value(),
                              view=SimpleNamespace(selected_paths=[], selected_pins=lambda: [], _upload_callback=None))
        NativeApplication._update_selection_inspector(app)
        self.assertIn('approximate', app.inspector_value.value)
        self.assertIn('CTM', app.inspector_value.value)
        NativeApplication._scene_ready(app, compiled)
        self.assertIn('approximate', app.status_value.value)
        self.assertIn('CTM', app.status_value.value)

    def test_pin_details_keep_original_figure_with_notice(self):
        pin = {'terminal': ' A<3> ', 'layer': 'M1', 'hierPath': 'TEST/U1',
               'bbox': {'min': [1.25, 2.5], 'max': [3.75, 4.5]}, 'points': [[1.25, 2.5], [3.75, 4.5]]}
        original = copy.deepcopy(pin)
        app = SimpleNamespace(compiled=SimpleNamespace(metadata={'units': 'um', 'technology': {'approximateLayers': ['M1']}}),
                              inspector_value=Value(), pin_note=Value(), _physical_mode=lambda: True,
                              view=SimpleNamespace(selected_paths=['TEST/U1'], selected_pins=lambda: [pin]))
        NativeApplication._update_selection_inspector(app, pin)
        self.assertIn('Original terminal:  A<3> ', app.inspector_value.value)
        self.assertIn('Bounding size: 2.5', app.inspector_value.value)
        self.assertIn('approximate', app.inspector_value.value)
        self.assertEqual(pin, original)


if __name__ == '__main__': unittest.main()
