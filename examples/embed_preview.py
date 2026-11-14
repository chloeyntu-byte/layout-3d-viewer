#!/usr/bin/env python3
"""Minimal host program for the embeddable 3D preview (native/embed.py).

Builds a synthetic octagonal inductor with a patterned ground shield, shows it in a Tk
window with pin labels, and lets you switch Metal/Studio, Dark/Light and the coil width.
No PDK, Cadence or layout file is needed.

    python3 examples/embed_preview.py          # from the repository root
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from native import embed

# Must run before tkinter is imported (matters for conda/miniforge Pythons).
embed.prepare_runtime()

import tkinter as tk  # noqa: E402


def octagon(radius):
    return [(radius * math.cos(math.pi / 8 + k * math.pi / 4), radius * math.sin(math.pi / 8 + k * math.pi / 4))
            for k in range(8)]


def coil(width, radius=60.0, gap=14.0):
    """Single-turn octagon on M3 opened at the bottom, two leads going down."""
    outer, inner = octagon(radius + width / 2), octagon(radius - width / 2)
    polygons = []
    for k in range(8):
        a, b = k, (k + 1) % 8
        polygons.append({'layer': 'M3', 'points': [outer[a], outer[b], inner[b], inner[a]]})
    # split the bottom segment (vertices 5-6, horizontal) to leave a gap for the two leads
    o5, o6, i5, i6 = outer[5], outer[6], inner[5], inner[6]
    polygons[5] = {'layer': 'M3', 'points': [o5, (-gap / 2, o5[1]), (-gap / 2, i5[1]), i5]}
    polygons.append({'layer': 'M3', 'points': [(gap / 2, o6[1]), o6, i6, (gap / 2, i6[1])]})
    lead_top = inner[5][1]
    for sign in (-1, 1):
        x = sign * (gap / 2 + width / 2)
        polygons.append({'layer': 'M3', 'bbox': [[x - width / 2, lead_top - 30], [x + width / 2, outer[5][1]]]})
    shield = []
    for k in range(16):
        angle = k * math.pi / 8
        c, s = math.cos(angle), math.sin(angle)
        shield.append({'layer': 'M1', 'points': [(2 * -s, 2 * c), (radius * c - 2 * s, radius * s + 2 * c),
                                                  (radius * c + 2 * s, radius * s - 2 * c), (2 * s, -2 * c)]})
    pins = [{'name': 'P', 'layer': 'M3', 'bbox': [[-(gap / 2 + width), lead_top - 30], [-gap / 2, lead_top - 26]]},
            {'name': 'N', 'layer': 'M3', 'bbox': [[gap / 2, lead_top - 30], [gap / 2 + width, lead_top - 26]]},
            {'name': 'GND', 'layer': 'M1', 'bbox': [[-2, -2], [2, 2]]}]
    vias = [{'cut_layer': 'VIA1', 'bbox': [[-3, -3], [3, 3]]}]
    return polygons + shield, pins, vias


def main():
    layers = embed.layer_stack(['M1', 'M2', 'M3'], vias=[('M1', 'M2', 'VIA1'), ('M2', 'M3', 'VIA2')],
                               thickness={'M3': 0.9})
    root = tk.Tk()
    root.title('Embedded 3D preview')
    root.geometry('980x700')
    bar = tk.Frame(root)
    bar.pack(fill='x')
    preview = embed.Preview3D(root, style='studio', theme='dark',
                              on_pin_click=lambda name: status.set('Pin clicked: %s' % name))
    preview.pack(fill='both', expand=True)
    status = tk.StringVar(value=preview.reason or 'Drag to orbit, right-drag to pan, wheel to zoom')
    tk.Label(root, textvariable=status, anchor='w').pack(fill='x')
    width = tk.DoubleVar(value=8.0)

    def rebuild(*_):
        polygons, pins, vias = coil(width.get())
        preview.set_scene(embed.scene_from_geometry(polygons, pins=pins, vias=vias, layers=layers))

    for text, command in (('Metal', lambda: preview.set_style('metal')), ('Studio', lambda: preview.set_style('studio')),
                          ('Dark', lambda: preview.set_theme('dark')), ('Light', lambda: preview.set_theme('light')),
                          ('Fit', preview.fit), ('Highlight P', lambda: preview.highlight_pin('P', focus=True))):
        tk.Button(bar, text=text, command=command).pack(side='left', padx=2, pady=2)
    tk.Scale(bar, from_=3, to=20, resolution=0.5, orient='horizontal', label='Coil width (um)',
             variable=width, command=rebuild, length=220).pack(side='right', padx=6)
    rebuild()
    root.mainloop()


if __name__ == '__main__':
    main()
