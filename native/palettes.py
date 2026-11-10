from __future__ import absolute_import


PALETTES = {
    'classic-dark-metal': {
        'DIFF': '#4cc9a7', 'ACTIVE': '#4cc9a7', 'OD': '#4cc9a7',
        'POLY': '#f97316', 'POLY1': '#f97316', 'CONT': '#e8e0c4', 'CO': '#e8e0c4',
        'METAL1': '#4dabf7', 'METAL2': '#51cf66', 'METAL3': '#ffd43b',
        'METAL4': '#f06595', 'METAL5': '#b197fc', 'METAL6': '#38d9a9',
        'VIA12': '#82c7e8', 'VIA23': '#88d8a0', 'VIA34': '#d9c879',
        'VIA45': '#c18eb3', 'VIA56': '#8acdb8',
    },
    'cyberpunk': {
        'DIFF': '#00b8d9', 'ACTIVE': '#00b8d9', 'OD': '#00b8d9',
        'POLY': '#ff3d81', 'POLY1': '#ff3d81', 'CONT': '#f5e6b8', 'CO': '#f5e6b8',
        'METAL1': '#247bff', 'METAL2': '#00f5d4', 'METAL3': '#ffe66d',
        'METAL4': '#ff3cac', 'METAL5': '#9d4edd', 'METAL6': '#00e5ff',
        'VIA12': '#59d8ff', 'VIA23': '#4dffd2', 'VIA34': '#fff19a',
        'VIA45': '#e879f9', 'VIA56': '#7df9ff',
    },
    'aurora': {
        'DIFF': '#2dd4bf', 'ACTIVE': '#2dd4bf', 'OD': '#2dd4bf',
        'POLY': '#fb7185', 'POLY1': '#fb7185', 'CONT': '#ecfccb', 'CO': '#ecfccb',
        'METAL1': '#22c55e', 'METAL2': '#84cc16', 'METAL3': '#facc15',
        'METAL4': '#fb923c', 'METAL5': '#f472b6', 'METAL6': '#b8ff3d',
        'VIA12': '#5eead4', 'VIA23': '#bef264', 'VIA34': '#fde047',
        'VIA45': '#fdba74', 'VIA56': '#f9a8d4',
    },
    'plasma': {
        'DIFF': '#7c3aed', 'ACTIVE': '#7c3aed', 'OD': '#7c3aed',
        'POLY': '#ff006e', 'POLY1': '#ff006e', 'CONT': '#ffe4f3', 'CO': '#ffe4f3',
        'METAL1': '#5b21b6', 'METAL2': '#7c3aed', 'METAL3': '#a855f7',
        'METAL4': '#e11d48', 'METAL5': '#ff2f92', 'METAL6': '#ff4fd8',
        'VIA12': '#8b5cf6', 'VIA23': '#c084fc', 'VIA34': '#f0abfc',
        'VIA45': '#fb7185', 'VIA56': '#ff8ad8',
    },
    'titanium': {
        'DIFF': '#38bdf8', 'ACTIVE': '#38bdf8', 'OD': '#38bdf8',
        'POLY': '#f97316', 'POLY1': '#f97316', 'CONT': '#e2e8f0', 'CO': '#e2e8f0',
        'METAL1': '#64748b', 'METAL2': '#0ea5e9', 'METAL3': '#94a3b8',
        'METAL4': '#f97316', 'METAL5': '#cbd5e1', 'METAL6': '#ffb020',
        'VIA12': '#7dd3fc', 'VIA23': '#bae6fd', 'VIA34': '#cbd5e1',
        'VIA45': '#fdba74', 'VIA56': '#fde68a',
    },
}


def normalized_layer(value):
    return str(value or '').strip().upper()


def palette_color(palette_name, layer, fallback='#8ecae6'):
    palette = PALETTES.get(palette_name) or PALETTES['classic-dark-metal']
    name = normalized_layer(layer)
    if name in palette:
        return palette[name]
    if name.startswith('M') and name[1:].isdigit():
        return palette.get('METAL' + name[1:], fallback)
    return fallback


def rgb(value):
    text = str(value or '#8ecae6').lstrip('#')
    if len(text) != 6:
        text = '8ecae6'
    try:
        return tuple(int(text[index:index + 2], 16) / 255.0 for index in (0, 2, 4))
    except ValueError:
        return tuple(int('8ecae6'[index:index + 2], 16) / 255.0 for index in (0, 2, 4))
