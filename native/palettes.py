from __future__ import absolute_import


# 'studio' is the flat, bright render style (see STYLES); the others are colour sets for the metal style.
PALETTES = {
    'studio': {
        'METAL9': '#f5c518', 'METAL8': '#e3a23f', 'METAL7': '#c98b4a',
        'METAL6': '#7f9fbd', 'METAL5': '#7091ad', 'METAL4': '#62819c', 'METAL3': '#58738b',
        'METAL2': '#50677b', 'METAL1': '#495c6c',
        'VIA12': '#9aa6ae', 'VIA23': '#9aa6ae', 'VIA34': '#9aa6ae', 'VIA45': '#9aa6ae', 'VIA56': '#9aa6ae',
        'VIA67': '#a9b2b8', 'VIA78': '#c3b08c', 'VIA89': '#d9b25a',
        'CONT': '#8d979d', 'CO': '#8d979d', 'POLY': '#d9775c', 'POLY1': '#d9775c',
        'ACTIVE': '#5aa58f', 'DIFF': '#5aa58f', 'OD': '#5aa58f',
        'PAD': '#b9874a', 'AP': '#b9874a', 'MIM_TOP': '#f1e2b0', 'MIM_BOT': '#d6be86',
    },
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
    key = palette_key(name)
    if key in palette:
        return palette[key]
    digits = name[5:] if name.startswith('METAL') else (name[1:] if name.startswith('M') else '')
    if digits.isdigit() and int(digits) > 0:
        # Six metal colours repeat for thicker stacks, as in the browser client.
        return palette.get('METAL' + digits) or palette.get('METAL%d' % ((int(digits) - 1) % 6 + 1), fallback)
    return fallback


def rgb(value):
    text = str(value or '#8ecae6').lstrip('#')
    if len(text) != 6:
        text = '8ecae6'
    try:
        return tuple(int(text[index:index + 2], 16) / 255.0 for index in (0, 2, 4))
    except ValueError:
        return tuple(int('8ecae6'[index:index + 2], 16) / 255.0 for index in (0, 2, 4))


# Shading per render style. 'metal' reproduces the original look; 'studio' is flat and bright,
# with faint outlines and no outlines on vias/contacts. Both use the same buffers and draw calls.
STYLES = {
    'metal': {
        'shadeBase': 0.36, 'shadeDiffuse': 0.55, 'fillGain': (0.38, 0.41, 0.40), 'fillBias': (0.018, 0.022, 0.022),
        'outlineGain': 1.0, 'connectorOutlines': True,
        'background': {'dark': (0.035, 0.043, 0.046), 'light': (0.92, 0.92, 0.89)},
        'pin': {'dark': (0.94, 0.81, 0.36), 'light': (0.46, 0.34, 0.08)},
    },
    'studio': {
        'shadeBase': 0.62, 'shadeDiffuse': 0.42, 'fillGain': (1.0, 1.0, 1.0), 'fillBias': (0.0, 0.0, 0.0),
        'outlineGain': 0.62, 'connectorOutlines': False,
        'background': {'dark': (0.055, 0.062, 0.066), 'light': (0.955, 0.950, 0.930)},
        'pin': {'dark': (1.0, 0.24, 0.55), 'light': (0.80, 0.09, 0.42)},
    },
}


def style_for_palette(palette_name):
    return 'studio' if palette_name == 'studio' else 'metal'


def palette_key(layer):
    """VIA layer names normalised so 'VIA7', 'V7' and 'VIA78' share palette keys."""
    name = normalized_layer(layer)
    for prefix in ('VIA', 'V'):
        digits = name[len(prefix):]
        if name.startswith(prefix) and digits.isdigit():
            if len(digits) == 1:
                lower = int(digits)
                return 'VIA%d%d' % (lower, lower + 1)
            return 'VIA' + digits
    return name
