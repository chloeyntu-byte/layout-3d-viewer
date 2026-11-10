"""The viewer accepts geometry already normalized to micrometres.

This is separate from the physical trace engine's coordinate reader.  Never
change a source units label to hide geometry that still needs conversion.
"""
from __future__ import absolute_import


MICROMETRE_UNITS = frozenset(('um', '\u00b5m', '\u03bcm'))


def validate_viewer_units(metadata):
    """Validate without changing the units label or any source geometry.

    Legacy files with no units field use the viewer's original um contract.
    An explicit invalid value must not be mistaken for that legacy default.
    """
    if 'units' not in metadata:
        return
    value = metadata['units']
    if isinstance(value, str) and value.strip().lower() in MICROMETRE_UNITS:
        return
    raise ValueError(
        "Viewer geometry requires micrometre units ('um', micro-sign m, or Greek-mu m). "
        "Convert all coordinates, bounding boxes, path widths/extensions, pin and "
        "instance geometry consistently to micrometres before opening this JSON; "
        "do not only change its units field. OA and stream imports already produce um.")
