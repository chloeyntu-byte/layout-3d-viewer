(function () {
  'use strict';

  var fallbackScriptUrl = document.currentScript && document.currentScript.src
    ? document.currentScript.src
    : window.location.href;

  function publicAssetUrl(path) {
    return new URL('../' + String(path || '').replace(/^\/+/, ''), fallbackScriptUrl).toString();
  }

  function $(selector) {
    return document.querySelector(selector);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function layerThickness(layer, fallback) {
    var raw = layer && layer.thickness;
    var thickness = raw === null || raw === '' || raw === undefined ? NaN : Number(raw);
    return isFinite(thickness) && thickness >= 0 ? thickness : (fallback == null ? 0.2 : fallback);
  }

  function fmt(value) {
    if (!isFinite(value)) return '0';
    if (Math.abs(value) >= 100) return value.toFixed(1);
    if (Math.abs(value) >= 10) return value.toFixed(2);
    return value.toFixed(3);
  }

  function stableHash(text) {
    var hash = 2166136261;
    var str = String(text || '');
    var i;
    for (i = 0; i < str.length; i += 1) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function visualTone(seed, partIndex) {
    var bucket = (stableHash(String(seed || '') + '|' + String(partIndex || 0)) % 9) - 4;
    return 1 + bucket * 0.018;
  }

  function niceStep(target) {
    var safe = Math.max(0.001, Math.abs(target));
    var base = Math.pow(10, Math.floor(Math.log(safe) / Math.LN10));
    var n = safe / base;
    var mult = n < 1.5 ? 1 : (n < 3 ? 2 : (n < 7 ? 5 : 10));
    return mult * base;
  }

  function layerStackValue(layer) {
    var semantic = layerSemantic(layer);
    var stack = Number(layer && layer.stackIndex);
    var metal;
    var pair;
    if (semantic && isFinite(stack) && stack >= 0) return stack;
    metal = metalNumber(layer);
    pair = viaPair(layer);
    if (metal != null) return metal * 2 + 1;
    if (pair) return pair[0] * 2 + 2;
    if (semantic === 'poly') return 1;
    if (semantic === 'active') return 0;
    if (isFinite(stack)) return stack;
    return -1000;
  }

  function auxiliaryLayer(layer) {
    var kind;
    if (!layer) return false;
    if (layer.routing === true) return false;
    if (layer.routing === false || layer.defaultVisible === false) return true;
    kind = String(layer.kind || '').toLowerCase();
    return kind === 'other' || kind === 'substrate' || kind === 'auxiliary';
  }

  function entryKey(entry) {
    return String(entry && entry.library || '') + '/' + String(entry && entry.cell || '') + '/' + String(entry && entry.view || 'layout');
  }

  function displayLayerName(layer) {
    var name = String(layer && layer.name || '');
    var match = name.match(/^METAL([0-9]+)$/i);
    if (match) return 'M' + match[1];
    if (/^VIA/i.test(name) || /^V[0-9]+$/i.test(name)) return name.toLowerCase();
    if (/^POLY/i.test(name)) return name.toLowerCase();
    return name;
  }

  var LAYER_COLORS = {
    DIFF: '#4cc9a7',
    OD: '#4cc9a7',
    ACTIVE: '#4cc9a7',
    POLY1: '#f97316',
    POLY: '#f97316',
    CONT: '#f8f0d8',
    CO: '#f8f0d8',
    METAL1: '#4dabf7',
    METAL2: '#51cf66',
    METAL3: '#ffd43b',
    METAL4: '#f06595',
    METAL5: '#b197fc',
    METAL6: '#38d9a9',
    VIA12: '#ffd166',
    VIA23: '#80ed99',
    VIA34: '#56cfe1',
    VIA45: '#c77dff',
    VIA56: '#ff8fab'
  };

  var DEFAULT_PALETTE = 'classic';
  var PALETTE_SETTINGS_KEY = 'vl3d.palette.v2';
  var NAVIGATION_SETTINGS_KEY = 'vl3d.navigation.v2';
  var NAVIGATION_PRESETS = {
    natural: { mode: 'natural', invertOrbitX: true, invertOrbitY: true, invertPan: false, invertWheel: false },
    cad: { mode: 'cad', invertOrbitX: false, invertOrbitY: false, invertPan: false, invertWheel: false }
  };
  var LAYER_PALETTES = {
    classic: {
      DIFF: '#4cc9a7', ACTIVE: '#4cc9a7', OD: '#4cc9a7',
      POLY: '#f97316', POLY1: '#f97316', CONT: '#f8f0d8', CO: '#f8f0d8',
      METAL1: '#4dabf7', METAL2: '#51cf66', METAL3: '#ffd43b',
      METAL4: '#f06595', METAL5: '#b197fc', METAL6: '#38d9a9',
      VIA12: '#ffd166', VIA23: '#80ed99', VIA34: '#56cfe1',
      VIA45: '#c77dff', VIA56: '#ff8fab'
    },
    cyberpunk: {
      DIFF: '#00b8d9', ACTIVE: '#00b8d9', OD: '#00b8d9',
      POLY: '#ff3d81', POLY1: '#ff3d81', CONT: '#f5e6b8', CO: '#f5e6b8',
      METAL1: '#247bff', METAL2: '#00f5d4', METAL3: '#ffe66d',
      METAL4: '#ff3cac', METAL5: '#9d4edd', METAL6: '#00e5ff',
      VIA12: '#59d8ff', VIA23: '#4dffd2', VIA34: '#fff19a',
      VIA45: '#e879f9', VIA56: '#7df9ff'
    },
    aurora: {
      DIFF: '#2dd4bf', ACTIVE: '#2dd4bf', OD: '#2dd4bf',
      POLY: '#fb7185', POLY1: '#fb7185', CONT: '#ecfccb', CO: '#ecfccb',
      METAL1: '#22c55e', METAL2: '#84cc16', METAL3: '#facc15',
      METAL4: '#fb923c', METAL5: '#f472b6', METAL6: '#b8ff3d',
      VIA12: '#5eead4', VIA23: '#bef264', VIA34: '#fde047',
      VIA45: '#fdba74', VIA56: '#f9a8d4'
    },
    plasma: {
      DIFF: '#7c3aed', ACTIVE: '#7c3aed', OD: '#7c3aed',
      POLY: '#ff006e', POLY1: '#ff006e', CONT: '#ffe4f3', CO: '#ffe4f3',
      METAL1: '#5b21b6', METAL2: '#7c3aed', METAL3: '#a855f7',
      METAL4: '#e11d48', METAL5: '#ff2f92', METAL6: '#ff4fd8',
      VIA12: '#8b5cf6', VIA23: '#c084fc', VIA34: '#f0abfc',
      VIA45: '#fb7185', VIA56: '#ff8ad8'
    },
    titanium: {
      DIFF: '#38bdf8', ACTIVE: '#38bdf8', OD: '#38bdf8',
      POLY: '#f97316', POLY1: '#f97316', CONT: '#e2e8f0', CO: '#e2e8f0',
      METAL1: '#64748b', METAL2: '#0ea5e9', METAL3: '#94a3b8',
      METAL4: '#f97316', METAL5: '#cbd5e1', METAL6: '#ffb020',
      VIA12: '#7dd3fc', VIA23: '#bae6fd', VIA34: '#cbd5e1',
      VIA45: '#fdba74', VIA56: '#fde68a'
    }
  };

  function readNavigationSettings() {
    var saved;
    var mode;
    var preset;
    try {
      saved = JSON.parse(localStorage.getItem(NAVIGATION_SETTINGS_KEY) || 'null') || {};
    } catch (error) {
      saved = {};
    }
    mode = saved.mode === 'cad' ? 'cad' : 'natural';
    preset = NAVIGATION_PRESETS[mode];
    return {
      mode: mode,
      invertOrbitX: typeof saved.invertOrbitX === 'boolean' ? saved.invertOrbitX : preset.invertOrbitX,
      invertOrbitY: typeof saved.invertOrbitY === 'boolean' ? saved.invertOrbitY : preset.invertOrbitY,
      invertPan: typeof saved.invertPan === 'boolean' ? saved.invertPan : preset.invertPan,
      invertWheel: typeof saved.invertWheel === 'boolean' ? saved.invertWheel : preset.invertWheel
    };
  }

  function errorDetails(value, fallback) {
    var nested = value && value.error && typeof value.error === 'object' ? value.error : null;
    var message = String(nested && nested.message
      || value && typeof value.error === 'string' && value.error
      || value && value.message
      || typeof value === 'string' && value
      || fallback
      || 'Operation failed');
    var explicitCode = nested && nested.code
      || value && (value.code || value.errorCode || value.error_code)
      || '';
    var embeddedCode = message.match(/\b(?:VL3D-)?E[0-9]{3,5}\b/i);
    var code = String(explicitCode || embeddedCode && embeddedCode[0] || '').replace(/^\s+|\s+$/g, '').toUpperCase();
    if (/^E[0-9]{3,5}$/.test(code)) code = 'VL3D-' + code;
    return { message: message, code: /^VL3D-E[0-9]{3,5}$/.test(code) ? code : '' };
  }

  function codedError(code, message) {
    var error = new Error(message);
    error.code = /^VL3D-E/.test(code) ? code : 'VL3D-' + code;
    return error;
  }

  function renderErrorMessage(element, value) {
    var details;
    var link;
    if (!element) return;
    details = errorDetails(value);
    element.textContent = details.message;
    if (!details.code) return;
    link = document.createElement('a');
    link.className = 'error-help-link';
    link.href = '/public/errors.html#' + encodeURIComponent(details.code);
    link.textContent = details.code + ' help';
    link.target = '_blank';
    link.rel = 'noopener';
    element.appendChild(document.createTextNode(' '));
    element.appendChild(link);
  }

  function normalizedLayerName(name) {
    return String(name || '').replace(/^\s+|\s+$/g, '').toUpperCase();
  }

  function explicitLayerSemantic(layer) {
    var candidates;
    var i;
    var value;
    if (!layer || typeof layer !== 'object') return '';
    candidates = [layer.semantic, layer.kind];
    for (i = 0; i < candidates.length; i += 1) {
      value = String(candidates[i] || '').replace(/^\s+|\s+$/g, '').toLowerCase().replace(/[\s_-]+/g, '');
      if (value === 'active' || value === 'diff' || value === 'diffusion') return 'active';
      if (value === 'poly' || value === 'polysilicon' || value === 'gate') return 'poly';
      if (value === 'contact' || value === 'cut') return 'contact';
      if (value === 'metal' || value === 'routingmetal' || value === 'interconnect'
          || /^(metal|topmetal|capacitortopmetal)[0-9]+$/.test(value)) return 'metal';
      if (value === 'via' || value === 'routingvia' || /^(via|topvia)[0-9]+$/.test(value)) return 'via';
    }
    return '';
  }

  function declaredLayerSemantic(layer) {
    var semantic = String(layer && layer.semantic || '').replace(/^\s+|\s+$/g, '');
    var normalized = semantic.toLowerCase().replace(/[\s_-]+/g, '');
    return semantic && normalized !== 'unknown' && normalized !== 'other'
      && normalized !== 'substrate' && normalized !== 'auxiliary' ? semantic : '';
  }

  function layerSemantic(layer) {
    var explicit = explicitLayerSemantic(layer);
    var name;
    if (explicit) return explicit;
    name = normalizedLayerName(typeof layer === 'object' ? layer && layer.name : layer);
    if (name === 'DIFF' || name === 'OD' || name === 'ACTIVE' || name === 'AA') return 'active';
    if (name.indexOf('POLY') === 0 || name === 'PO' || name === 'GT') return 'poly';
    if (name === 'CONT' || name === 'CONTACT' || name === 'CO' || name === 'CT') return 'contact';
    if (/^(METAL|M)[0-9]+$/.test(name)) return 'metal';
    if (/^VIA[0-9]+$/.test(name) || /^V[0-9]+$/.test(name)) return 'via';
    return '';
  }

  function metalNumber(layer) {
    var explicit;
    var normalized;
    var match;
    if (layer && typeof layer === 'object') {
      explicit = Number(layer.metal);
      if (isFinite(explicit) && explicit > 0) return explicit;
    }
    normalized = normalizedLayerName(typeof layer === 'object' ? layer && layer.name : layer);
    match = normalized.match(/^METAL([0-9]+)$/) || normalized.match(/^M([0-9]+)$/);
    return match ? Number(match[1]) : null;
  }

  function viaPair(layer) {
    var normalized;
    var pair;
    var single;
    var shortVia;
    var lower;
    var upper;
    if (layer && typeof layer === 'object') {
      lower = Number(layer.lowerMetal);
      upper = Number(layer.upperMetal);
      if (isFinite(lower) && isFinite(upper)) return [lower, upper];
      lower = metalNumber(layer.lowerLayer);
      upper = metalNumber(layer.upperLayer);
      if (lower != null && upper != null) return [lower, upper];
      if (explicitLayerSemantic(layer) === 'contact' && upper != null) return [0, upper];
    }
    normalized = normalizedLayerName(typeof layer === 'object' ? layer && layer.name : layer);
    if (normalized === 'CONT' || normalized === 'CONTACT' || normalized === 'CO' || normalized === 'CT') return [0, 1];
    pair = normalized.match(/^VIA([0-9])([0-9])$/);
    if (pair) return [Number(pair[1]), Number(pair[2])];
    single = normalized.match(/^VIA([0-9]+)$/);
    shortVia = normalized.match(/^V([0-9]+)$/);
    if (!single && !shortVia) return null;
    lower = Number((single || shortVia)[1]);
    return [lower, lower + 1];
  }

  function layerFromLookup(lookup, name) {
    var normalized = normalizedLayerName(name);
    if (!normalized || !lookup) return null;
    return lookup[normalized] || null;
  }

  function connectorPair(layer, lookup) {
    var lower;
    var upper;
    if (layer && typeof layer === 'object' && layer.lowerLayer && layer.upperLayer) {
      lower = metalNumber(layerFromLookup(lookup, layer.lowerLayer));
      if (lower == null) lower = metalNumber(layer.lowerLayer);
      upper = metalNumber(layerFromLookup(lookup, layer.upperLayer));
      if (upper == null) upper = metalNumber(layer.upperLayer);
      if (lower != null && upper != null) return [lower, upper];
    }
    return viaPair(layer);
  }

  function syntheticLayer(name, index, relationships) {
    var normalized = normalizedLayerName(name);
    var refs = relationships || {};
    var pair = Array.isArray(refs.pair) ? refs.pair : viaPair({ name: normalized, lowerLayer: refs.lowerLayer, upperLayer: refs.upperLayer });
    var metal = metalNumber(normalized);
    var layer = {
      name: normalized,
      index: index || 0,
      color: LAYER_COLORS[normalized] || '#8ecae6',
      shapeCount: 0,
      connectorCount: 0,
      kind: 'other',
      routing: true,
      stackIndex: layerStackValue({ name: normalized }),
      thickness: 0.2,
      inferred: true
    };
    if (pair && pair[0] === 0) {
      layer.kind = 'contact';
      layer.semantic = 'contact';
      layer.thickness = 0.1;
      layer.lowerLayers = ['DIFF', 'OD', 'ACTIVE', 'AA', 'POLY1', 'POLY', 'PO', 'GT'];
      layer.upperLayer = normalizedLayerName(refs.upperLayer);
    } else if (pair) {
      layer.kind = 'via';
      layer.semantic = /^TV[12]$/.test(normalized) ? 'top-via-' + normalized.slice(-1) : 'via';
      layer.stackIndex = pair[0] * 2 + 2;
      layer.thickness = 0.1;
      layer.lowerLayer = normalizedLayerName(refs.lowerLayer);
      layer.upperLayer = normalizedLayerName(refs.upperLayer);
      layer.lowerMetal = pair[0];
      layer.upperMetal = pair[1];
    } else if (metal != null) {
      layer.kind = 'metal';
      layer.semantic = 'metal';
      layer.metal = metal;
    } else if (layerSemantic({ name: normalized }) === 'poly') {
      layer.kind = 'poly';
      layer.semantic = 'poly';
    } else if (layerSemantic({ name: normalized }) === 'active') {
      layer.kind = 'active';
      layer.semantic = 'active';
    }
    return layer;
  }

  // A layer may opt in to a parallel (non-stacking) position with an explicit `parallelStack: true`.
  function parallelStackLayer(layer) {
    return !!layer && layer.parallelStack === true;
  }

  function normalizeLayerMetadata(layer) {
    var copy = {};
    var semantic;
    var metal;
    var specialMetal;
    var knownAuxiliary;
    Object.keys(layer || {}).forEach(function (key) { copy[key] = layer[key]; });
    copy.name = normalizedLayerName(layer && layer.name);
    specialMetal = parallelStackLayer(copy);
    knownAuxiliary = copy.name === 'HRI' || copy.name === 'RPO' || copy.name === 'NTN';
    semantic = layerSemantic(copy);
    if (specialMetal) {
      copy.parallelStack = true;
      if (!declaredLayerSemantic(copy)) copy.semantic = 'metal';
      copy.kind = 'metal';
      copy.routing = true;
      copy.defaultVisible = true;
      if (!isFinite(Number(copy.stackIndex)) || Number(copy.stackIndex) < 0) copy.stackIndex = 11.5;
    } else if (semantic) {
      if (!declaredLayerSemantic(copy)) copy.semantic = semantic;
      copy.kind = semantic;
      copy.routing = true;
      if (!isFinite(Number(copy.stackIndex)) || Number(copy.stackIndex) < 0) {
        copy.stackIndex = layerStackValue({ name: copy.name, semantic: semantic, metal: copy.metal });
      }
    }
    if (knownAuxiliary && copy.routing !== true) {
      copy.kind = 'auxiliary';
      copy.routing = false;
      copy.defaultVisible = false;
    }
    metal = metalNumber(copy);
    if (metal != null) copy.metal = metal;
    if (copy.lowerLayer) copy.lowerLayer = normalizedLayerName(copy.lowerLayer);
    if (copy.upperLayer) copy.upperLayer = normalizedLayerName(copy.upperLayer);
    if (Array.isArray(copy.lowerLayers)) copy.lowerLayers = copy.lowerLayers.map(normalizedLayerName);
    return copy;
  }

  function preferredMetalLayer(metalsByNumber, number) {
    return metalsByNumber[number] && metalsByNumber[number][0] || '';
  }

  function inferredConnectorName(lowerLayer, upperLayer, lowerMetal, upperMetal) {
    if (/^M[0-9]+$/.test(lowerLayer) && /^M[0-9]+$/.test(upperLayer)) return 'V' + lowerMetal;
    return 'VIA' + lowerMetal + upperMetal;
  }

  function unclassifiedLayerWarning(data, layers) {
    var technology = data && data.technology;
    var declared = technology && Array.isArray(technology.unclassifiedLayers)
      ? technology.unclassifiedLayers
      : null;
    var requestedNames = declared
      ? declared.map(function (entry) { return normalizedLayerName(typeof entry === 'object' ? entry && entry.name : entry); })
      : layers.filter(function (layer) {
        var semantic = String(layer && layer.semantic || '').replace(/^\s+|\s+$/g, '').toLowerCase();
        return semantic === 'unknown' || (!declaredLayerSemantic(layer) && !layerSemantic(layer) && auxiliaryLayer(layer));
      }).map(function (layer) { return layer.name; });
    var seen = {};
    var byName = {};
    layers.forEach(function (layer) { byName[normalizedLayerName(layer.name)] = layer; });
    var names = requestedNames.filter(function (name) {
      if (!name || seen[name] || !auxiliaryLayer(byName[name])) return false;
      seen[name] = true;
      return true;
    });
    var shapeCounts = Array.isArray(data && data.shapes) ? {} : null;
    if (!names.length) return '';
    if (shapeCounts) {
      names.forEach(function (name) { shapeCounts[name] = 0; });
      data.shapes.forEach(function (shape) {
        var layerName = normalizedLayerName(shape && shape.layer);
        if (Object.prototype.hasOwnProperty.call(shapeCounts, layerName)) shapeCounts[layerName] += 1;
      });
    }
    function countFor(name) {
      if (shapeCounts) return shapeCounts[name] || 0;
      var count = Number(byName[name] && byName[name].shapeCount);
      return isFinite(count) && count >= 0 ? count : 0;
    }
    return 'Unclassified layers hidden: ' + names.map(function (name) {
      return name + ' (' + countFor(name) + ')';
    }).join(', ');
  }

  function approximateStackWarning(data, layers) {
    var technology = data && data.technology;
    var profile = String(technology && typeof technology === 'object' && technology.profile
      || typeof technology === 'string' && technology
      || data && data.technologyProfile
      || '').replace(/^\s+|\s+$/g, '');
    var normalizedProfile = profile.toLowerCase();
    var genericProfile = !normalizedProfile || normalizedProfile === 'generic'
      || normalizedProfile === 'unknown' || normalizedProfile === 'geometry-only'
      || normalizedProfile.indexOf('generic-stream') >= 0;
    var genericThickness = (layers || []).some(function (layer) {
      return layer && layer.routing !== false
        && /(?:generic|default|inferred)-fallback/i.test(String(layer.thicknessSource || ''));
    });
    var label;
    if (!genericProfile && !genericThickness) return '';
    label = profile || technology && technology.library || data && data.techLibrary || 'unidentified PDK';
    return 'Approximate PDK stack (' + label + '): layer order and thickness are inferred for visualization only; choose a calibrated PDK profile before physical interpretation.';
  }

  function payloadWarningText(data) {
    if (!Array.isArray(data && data.warnings)) return '';
    return data.warnings.map(function (warning) {
      if (typeof warning === 'string') return warning;
      return warning && (warning.message || warning.code) || '';
    }).map(function (warning) {
      return String(warning).replace(/^\s+|\s+$/g, '');
    }).filter(Boolean).join('; ');
  }

  function completeRoutingStack(data) {
    var byName = {};
    var names = [];
    var metalsByNumber = {};
    var metalNumbers = [];
    var i;
    (data.layers || []).forEach(function (layer) {
      var copy = normalizeLayerMetadata(layer);
      byName[copy.name] = copy;
    });
    Object.keys(byName).forEach(function (name) {
      var metal = metalNumber(byName[name]);
      if (metal == null) return;
      if (!metalsByNumber[metal]) metalsByNumber[metal] = [];
      metalsByNumber[metal].push(name);
    });
    Object.keys(byName).forEach(function (name) {
      var layer = byName[name];
      var semantic = layerSemantic(layer);
      var pair = connectorPair(layer, byName);
      if (semantic === 'contact') {
        var upperMetal = pair && pair[1] || 1;
        if (!byName[layer.upperLayer]) layer.upperLayer = preferredMetalLayer(metalsByNumber, upperMetal);
        if (!layer.lowerLayers || !layer.lowerLayers.length) layer.lowerLayers = ['DIFF', 'OD', 'ACTIVE', 'AA', 'POLY1', 'POLY', 'PO', 'GT'];
      } else if (semantic === 'via' && pair) {
        if (!byName[layer.lowerLayer]) layer.lowerLayer = preferredMetalLayer(metalsByNumber, pair[0]);
        if (!byName[layer.upperLayer]) layer.upperLayer = preferredMetalLayer(metalsByNumber, pair[1]);
        layer.lowerMetal = pair[0];
        layer.upperMetal = pair[1];
        if (!isFinite(Number(layer.stackIndex)) || Number(layer.stackIndex) < 0) layer.stackIndex = pair[0] * 2 + 2;
      }
    });
    metalNumbers = Object.keys(metalsByNumber).map(Number).sort(function (a, b) { return a - b; });
    if (metalNumbers.length) {
      for (i = metalNumbers[0]; i < metalNumbers[metalNumbers.length - 1]; i += 1) {
        var lowerLayer = preferredMetalLayer(metalsByNumber, i);
        var upperLayer = preferredMetalLayer(metalsByNumber, i + 1);
        var alreadyPresent;
        var viaName;
        if (!lowerLayer || !upperLayer) continue;
        alreadyPresent = Object.keys(byName).some(function (name) {
          var layer = byName[name];
          var pair = connectorPair(layer, byName);
          return layerSemantic(layer) === 'via' && pair && pair[0] === i && pair[1] === i + 1;
        });
        if (alreadyPresent) continue;
        viaName = inferredConnectorName(lowerLayer, upperLayer, i, i + 1);
        if (!byName[viaName]) {
          byName[viaName] = syntheticLayer(viaName, Object.keys(byName).length, {
            lowerLayer: lowerLayer,
            upperLayer: upperLayer,
            pair: [i, i + 1]
          });
        }
      }
    }
    names = Object.keys(byName).sort(function (a, b) {
      var delta = layerStackValue(byName[a]) - layerStackValue(byName[b]);
      return delta || a.localeCompare(b);
    });
    data.layers = names.map(function (name, index) {
      byName[name].index = index;
      return byName[name];
    });
    data.inferredLayerCount = data.layers.filter(function (layer) { return layer.inferred; }).length;
    data.unclassifiedLayerWarning = unclassifiedLayerWarning(data, data.layers);
    data.approximateStackWarning = approximateStackWarning(data, data.layers);
    return data;
  }

  function shade(hex, factor) {
    var value = String(hex || '#888888').replace('#', '');
    var r = parseInt(value.slice(0, 2), 16) || 128;
    var g = parseInt(value.slice(2, 4), 16) || 128;
    var b = parseInt(value.slice(4, 6), 16) || 128;
    r = clamp(Math.round(r * factor), 0, 255);
    g = clamp(Math.round(g * factor), 0, 255);
    b = clamp(Math.round(b * factor), 0, 255);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function rgba(hex, alpha) {
    var value = String(hex || '#888888').replace('#', '');
    var r = parseInt(value.slice(0, 2), 16) || 128;
    var g = parseInt(value.slice(2, 4), 16) || 128;
    var b = parseInt(value.slice(4, 6), 16) || 128;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function layerIsConnector(name, meta) {
    return layerSemantic(meta || { name: name }) === 'via' || layerSemantic(meta || { name: name }) === 'contact';
  }

  function firstMetadataLayer(metadata, names) {
    var i;
    var normalized;
    for (i = 0; i < (names || []).length; i += 1) {
      normalized = normalizedLayerName(names[i]);
      if (metadata && metadata[normalized]) return normalized;
    }
    return '';
  }

  function existingMetalMetadataLayer(metadata, number) {
    var names = Object.keys(metadata || {});
    var i;
    for (i = 0; i < names.length; i += 1) {
      if (layerSemantic(metadata[names[i]]) === 'metal' && metalNumber(metadata[names[i]]) === number) return names[i];
    }
    return '';
  }

  function existingConnectorMetadataLayer(metadata, lower, upper) {
    var names = Object.keys(metadata || {});
    var i;
    var pair;
    var lowerLayer;
    var upperLayer;
    var inferred;
    for (i = 0; i < names.length; i += 1) {
      pair = connectorPair(metadata[names[i]], metadata);
      if (layerSemantic(metadata[names[i]]) === 'via' && pair && pair[0] === lower && pair[1] === upper) return names[i];
    }
    lowerLayer = existingMetalMetadataLayer(metadata, lower);
    upperLayer = existingMetalMetadataLayer(metadata, upper);
    if (!lowerLayer || !upperLayer) return '';
    inferred = inferredConnectorName(lowerLayer, upperLayer, lower, upper);
    return metadata[inferred] ? inferred : '';
  }

  function inferConnectorLayer(inst, metadata) {
    var cell = String(inst && inst.master && inst.master.cell || '').toLowerCase();
    var match;
    var first;
    var second;
    if (/(^|[_-])(cont|contact|ct)($|[_-])/.test(cell) || /^co($|[_-])/.test(cell)) {
      return firstMetadataLayer(metadata, ['CONT', 'CONTACT', 'CO', 'CT']);
    }
    match = cell.match(/m([0-9]+)[_-]m([0-9]+)/);
    if (match) {
      first = Number(match[1]);
      second = Number(match[2]);
      return existingConnectorMetadataLayer(metadata, Math.min(first, second), Math.max(first, second));
    }
    match = cell.match(/(?:^|[_-])tv([12])(?:$|[_-])/);
    if (match) {
      first = Number(match[1]);
      return existingConnectorMetadataLayer(metadata, 5 + first, 6 + first);
    }
    match = cell.match(/via([0-9])([0-9])/);
    if (match) return existingConnectorMetadataLayer(metadata, Number(match[1]), Number(match[2]));
    match = cell.match(/via([0-9]+)/);
    if (!match) match = cell.match(/(?:^|[_-])v([0-9]+)(?:$|[_-])/);
    if (!match) return '';
    first = Number(match[1]);
    return existingConnectorMetadataLayer(metadata, first, first + 1);
  }

  function startFallback() {
    if (window.__VL3D_STATE) return;
    if (window.__VL3D_MODULE_LOAD_PENDING && !window.__VL3D_MODULE_FAILED) return;
    if (window.__VL3D_MODULE_STARTED && !window.__VL3D_MODULE_FAILED) return;
    if (window.__VL3D_FALLBACK_STARTED) return;
    window.__VL3D_FALLBACK_STARTED = true;
    window.__VL3D_APP_BOOTING = false;
    document.body.classList.add('renderer-unavailable');
    var failureCode = /^VL3D-E[0-9]{3,5}$/.test(String(window.__VL3D_FAILURE_CODE || ''))
      ? String(window.__VL3D_FAILURE_CODE)
      : 'VL3D-E8006';
    var webglUnavailable = failureCode === 'VL3D-E8001';
    var failure = String(window.__VL3D_FAILURE_MESSAGE || (webglUnavailable
      ? 'WebGL 2 is unavailable in this browser.'
      : 'The browser viewer failed during startup.'));
    var notice = document.getElementById('browserCompatibilityNotice');
    var code = document.getElementById('browserCompatibilityCode');
    var title = document.getElementById('browserCompatibilityTitle');
    var detail = document.getElementById('browserCompatibilityDetail');
    var help = document.getElementById('browserCompatibilityHelp');
    if (code) code.textContent = failureCode;
    if (title) title.textContent = webglUnavailable
      ? 'Browser 3D rendering is unavailable'
      : 'Browser viewer startup failed';
    if (detail) detail.textContent = failure;
    if (help) help.href = './errors.html#' + encodeURIComponent(failureCode);
    if (notice) notice.hidden = false;
    document.querySelectorAll('.topbar button, .topbar select, .topbar input, .workspace-panel button, .workspace-panel select, .workspace-panel input').forEach(function (element) {
      element.disabled = true;
      element.title = 'Unavailable because the browser viewer failed (' + failureCode + ')';
    });
    document.querySelectorAll('.workspace-drawer').forEach(function (drawer) {
      drawer.open = true;
      if (drawer.closest('.workspace-panel')) drawer.closest('.workspace-panel').classList.remove('is-collapsed');
    });
    var libraryLabel = document.getElementById('libraryLabel');
    var cellStats = document.getElementById('cellStats');
    var pickInfo = document.getElementById('pickInfo');
    var performanceInfo = document.getElementById('performanceInfo');
    if (libraryLabel) {
      libraryLabel.textContent = webglUnavailable ? 'Browser compatibility' : 'Browser startup failure';
      libraryLabel.title = 'Use the native VL3D client to load a design library';
    }
    if (cellStats) cellStats.textContent = failureCode + (webglUnavailable
      ? ' · WebGL 2 renderer unavailable'
      : ' · browser viewer startup failed');
    if (pickInfo) renderErrorMessage(pickInfo, codedError(failureCode.replace(/^VL3D-/, ''), failure));
    if (performanceInfo) performanceInfo.textContent = webglUnavailable
      ? 'Renderer unavailable · use vl3d'
      : 'Browser startup failed · see diagnostics';
    window.__VL3D_STATE = {
      mode: webglUnavailable ? 'unsupported-browser' : 'browser-startup-error',
      fullApp: false,
      errorCode: failureCode,
      errorMessage: failure,
      fastMode: false
    };
  }

  function startupFailureCode(reason) {
    var message = String(reason && reason.message || reason || '');
    var embedded = message.match(/\b(?:VL3D-)?E[0-9]{3,5}\b/i);
    var raw = String(reason && reason.code || embedded && embedded[0] || '').replace(/^\s+|\s+$/g, '').toUpperCase();
    if (/^VL3D-E[0-9]{3,5}$/.test(raw)) return raw;
    if (/^E[0-9]{3,5}$/.test(raw)) return 'VL3D-' + raw;
    return /(?:module|import|three|model|fetch)/i.test(message) ? 'VL3D-E8006' : 'VL3D-E9001';
  }

  function recordModuleLoadFailure(reason) {
    var message = String(reason && reason.message || reason || 'The browser viewer module failed to load');
    window.__VL3D_MODULE_FAILED = true;
    window.__VL3D_FAILURE_CODE = startupFailureCode(reason);
    window.__VL3D_FAILURE_MESSAGE = message;
    window.dispatchEvent(new CustomEvent('vl3d-module-failed', {
      detail: { code: window.__VL3D_FAILURE_CODE, message: message }
    }));
  }

  function startLegacyCanvasFallback() {
    if (window.__VL3D_STATE) return;
    if (window.__VL3D_MODULE_STARTED && !window.__VL3D_MODULE_FAILED) return;
    if (window.__VL3D_FALLBACK_STARTED) return;
    window.__VL3D_FALLBACK_STARTED = true;
    document.body.classList.add('fallback-mode');

    var canvas = $('#scene');
    var axisOverlay = $('#axisOverlay');
    var attitudeCanvas = $('#attitudeCanvas');
    var cellSelect = $('#cellSelect');
    var libraryLabel = $('#libraryLabel');
    var openFileBtn = $('#openFileBtn');
    var fileInput = $('#fileInput');
    var highlightSelect = $('#highlightSelect');
    var layerList = $('#layerList');
    var legendList = $('#legendList');
    var legendAllBtn = $('#legendAllBtn');
    var legendNoneBtn = $('#legendNoneBtn');
    var fitBtn = $('#fitBtn');
    var resetBtn = $('#resetBtn');
    var instancesToggle = $('#instancesToggle');
    var wireToggle = $('#wireToggle');
    var pinsToggle = $('#pinToggle');
    var paletteSelect = $('#paletteSelect');
    var themeSelect = $('#themeSelect');
    var zScale = $('#zScale');
    var zScaleValue = $('#zScaleValue');
    var alphaScale = $('#alphaScale');
    var viaMerge = $('#viaMerge');
    var viaMergeValue = $('#viaMergeValue');
    var technologyNotice = $('#technologyNotice');
    var navigationModeSelect = $('#navigationModeSelect');
    var navigationSummary = $('#navigationSummary');
    var invertOrbitXToggle = $('#invertOrbitXToggle');
    var invertOrbitYToggle = $('#invertOrbitYToggle');
    var invertPanToggle = $('#invertPanToggle');
    var invertWheelToggle = $('#invertWheelToggle');
    var cellStats = $('#cellStats');
    var rulerInfo = $('#rulerInfo');
    var pickInfo = $('#pickInfo');
    var startupFailure = String(window.__VL3D_FAILURE_MESSAGE || '');
    var ctx = canvas.getContext('2d');
    if (!ctx) {
      var replacementCanvas = canvas.cloneNode(false);
      canvas.parentNode.replaceChild(replacementCanvas, canvas);
      canvas = replacementCanvas;
      ctx = canvas.getContext('2d');
    }
    var axisCtx = axisOverlay.getContext('2d');
    var attitudeCtx = attitudeCanvas && attitudeCanvas.getContext('2d');
    var params = new URLSearchParams(window.location.search);
    var demoMode = params.get('demo') === '1';
    var navigationSettings = readNavigationSettings();

    function persistNavigationSettings() {
      try {
        localStorage.setItem(NAVIGATION_SETTINGS_KEY, JSON.stringify(navigationSettings));
      } catch (error) {}
      if (window.__VL3D_STATE) window.__VL3D_STATE.navigation = navigationSettings;
    }

    function syncNavigationControls() {
      if (navigationModeSelect) navigationModeSelect.value = navigationSettings.mode;
      if (invertOrbitXToggle) invertOrbitXToggle.checked = navigationSettings.invertOrbitX;
      if (invertOrbitYToggle) invertOrbitYToggle.checked = navigationSettings.invertOrbitY;
      if (invertPanToggle) invertPanToggle.checked = navigationSettings.invertPan;
      if (invertWheelToggle) invertWheelToggle.checked = navigationSettings.invertWheel;
      if (navigationSummary) navigationSummary.textContent = navigationSettings.mode === 'cad' ? 'CAD' : 'Natural';
    }

    function applyNavigationPreset() {
      var mode = navigationModeSelect && navigationModeSelect.value === 'cad' ? 'cad' : 'natural';
      var preset = NAVIGATION_PRESETS[mode];
      navigationSettings = {
        mode: preset.mode,
        invertOrbitX: preset.invertOrbitX,
        invertOrbitY: preset.invertOrbitY,
        invertPan: preset.invertPan,
        invertWheel: preset.invertWheel
      };
      syncNavigationControls();
      persistNavigationSettings();
    }

    function applyNavigationOverrides() {
      navigationSettings = {
        mode: navigationModeSelect && navigationModeSelect.value === 'cad' ? 'cad' : 'natural',
        invertOrbitX: invertOrbitXToggle && invertOrbitXToggle.checked === true,
        invertOrbitY: invertOrbitYToggle && invertOrbitYToggle.checked === true,
        invertPan: invertPanToggle && invertPanToggle.checked === true,
        invertWheel: invertWheelToggle && invertWheelToggle.checked === true
      };
      syncNavigationControls();
      persistNavigationSettings();
    }

    function knownPalette(name) {
      return Object.prototype.hasOwnProperty.call(LAYER_PALETTES, name);
    }

    function rememberedPaletteName() {
      try {
        var saved = localStorage.getItem(PALETTE_SETTINGS_KEY) || '';
        return knownPalette(saved) ? saved : '';
      } catch (error) {
        return '';
      }
    }

    function selectedPaletteName() {
      var name = paletteSelect && paletteSelect.value || DEFAULT_PALETTE;
      return knownPalette(name) ? name : DEFAULT_PALETTE;
    }

    function paletteLayerKey(layerName, layer) {
      var normalized = normalizedLayerName(layerName);
      var descriptor = layer || { name: normalized };
      var semantic = layerSemantic(descriptor);
      var metal = metalNumber(descriptor);
      var pair;
      if (metal != null) return 'METAL' + metal;
      pair = viaPair(descriptor);
      if (pair && pair[0] === 0) return 'CONT';
      if (pair) return 'VIA' + pair[0] + pair[1];
      if (semantic === 'poly') return 'POLY';
      if (semantic === 'active') return 'ACTIVE';
      return normalized;
    }

    function resolvedFillColor(layerName, sourceColor, layer) {
      var normalized = normalizedLayerName(layerName);
      var palette = LAYER_PALETTES[selectedPaletteName()];
      var key = paletteLayerKey(normalized, layer);
      var metal = metalNumber(key);
      var pair;
      var lower;
      if (metal != null) {
        return palette[key] || palette['METAL' + (((metal - 1) % 6) + 1)] || sourceColor || LAYER_COLORS[key] || '#8ecae6';
      }
      pair = viaPair(key);
      if (pair && pair[0] > 0) {
        lower = ((pair[0] - 1) % 5) + 1;
        return palette[key] || palette['VIA' + lower + (lower + 1)] || sourceColor || LAYER_COLORS[key] || '#8ecae6';
      }
      return palette[key] || palette[normalized] || sourceColor || LAYER_COLORS[key] || '#8ecae6';
    }

    if (demoMode) document.body.classList.add('demo-mode');
    themeSelect.value = params.get('theme') === 'light' ? 'light' : 'dark';
    if (paletteSelect) {
      var requestedPalette = params.get('palette') || rememberedPaletteName() || DEFAULT_PALETTE;
      paletteSelect.value = knownPalette(requestedPalette) ? requestedPalette : DEFAULT_PALETTE;
    }

    var THEMES = {
      dark: {
        background: '#10110f',
        grid: '#4a4539',
        axisText: '#f3f0e8',
        tick: '#d8d2c4',
        shadow: 'rgba(0,0,0,0.58)',
        axisX: '#b77d76',
        axisY: '#748fa6',
        axisZ: '#77a08c'
      },
      light: {
        background: '#f6f4ee',
        grid: '#c5beb0',
        axisText: '#20221e',
        tick: '#454940',
        shadow: 'rgba(255,255,255,0.78)',
        axisX: '#8d5752',
        axisY: '#55738c',
        axisZ: '#567b69'
      }
    };

    function currentTheme() {
      return THEMES[themeSelect.value === 'light' ? 'light' : 'dark'];
    }

    function applyTheme() {
      document.body.classList.toggle('light-theme', themeSelect.value === 'light');
    }
    applyTheme();
    syncNavigationControls();

    var manifest = null;
    var currentData = null;
    var bounds = null;
    var layerVisible = {};
    var layerMeta = {};
    var angle = -0.72;
    var pitch = 0.62;
    var zoom = 1;
    var panX = 0;
    var panY = 0;
    var viewOffset = { x: 0, y: 0, z: 0 };
    var drag = null;
    var autoRotate = demoMode;
    var drawItems = [];
    var fastDrawItems = [];
    var connectorCount = 0;
    var displayedConnectorCount = 0;
    var shapeDrawItemCount = 0;
    var highlightedCell = '';
    var highlightRoots = [];
    var lastRulerStep = 1;
    var drawPending = false;
    var fastMode = false;
    var fullDrawTimer = null;
    var lastFastInputAt = 0;
    var lastDrawMs = 0;
    var lastVisibleItems = 0;
    var drawCos = 1;
    var drawSin = 0;
    var drawScale = 1;
    var drawPitchSin = 1;
    var drawPitchCos = 0;
    var pointerHeld = false;
    var loadGeneration = 0;
    var loadController = null;
    var transformCommitTimer = null;

    if (instancesToggle) instancesToggle.checked = false;
    if (pinsToggle) pinsToggle.checked = false;

    function resize() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
      axisOverlay.width = Math.floor(window.innerWidth * dpr);
      axisOverlay.height = Math.floor(window.innerHeight * dpr);
      canvas.style.width = window.innerWidth + 'px';
      canvas.style.height = window.innerHeight + 'px';
      axisOverlay.style.width = window.innerWidth + 'px';
      axisOverlay.style.height = window.innerHeight + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      axisCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (attitudeCanvas && attitudeCtx) {
        var attitudeSize = Math.round(attitudeCanvas.getBoundingClientRect().width || 156);
        attitudeCanvas.width = Math.floor(attitudeSize * dpr);
        attitudeCanvas.height = Math.floor(attitudeSize * dpr);
        attitudeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      requestDraw(false);
    }

    function computeBounds(data) {
      var b = data.bbox || { min: [0, 0], max: [1, 1] };
      var sizeX = Math.max(1, b.max[0] - b.min[0]);
      var sizeY = Math.max(1, b.max[1] - b.min[1]);
      return {
        minX: b.min[0],
        minY: b.min[1],
        maxX: b.max[0],
        maxY: b.max[1],
        sizeX: sizeX,
        sizeY: sizeY,
        centerX: (b.min[0] + b.max[0]) / 2,
        centerY: (b.min[1] + b.max[1]) / 2,
        radius: Math.max(sizeX, sizeY, 2)
      };
    }

    function verticalUnit() {
      return 10;
    }

    function stackScale() {
      return Number(zScale.value || 1) * verticalUnit();
    }

    function layerY(name) {
      var meta = layerMeta[name] || { base: 0 };
      return (meta.base || 0) * stackScale();
    }

    function layerHeight(name) {
      var meta = layerMeta[name] || { thickness: 0.2 };
      return Math.max(0.01, layerThickness(meta) * stackScale());
    }

    function viaMergeSize() {
      return clamp(Number(viaMerge && viaMerge.value || 0), 0, 5);
    }

    function updateViaMergeLabel(rendered, source) {
      if (!viaMergeValue) return;
      var size = viaMergeSize();
      var label = size <= 0 ? 'Off' : fmt(size) + ' um grid';
      viaMergeValue.textContent = rendered != null && source != null && rendered !== source
        ? label + ', ' + rendered + '/' + source + ' vias'
        : label;
    }

    function squareBBoxInsideBounds(minX, minY, maxX, maxY, maxSide) {
      var centerX = (minX + maxX) / 2;
      var centerY = (minY + maxY) / 2;
      var side = Math.min(Math.max(Math.min(maxX - minX, maxY - minY), 0.001), maxSide || Infinity);
      return {
        min: [centerX - side / 2, centerY - side / 2],
        max: [centerX + side / 2, centerY + side / 2]
      };
    }

    function gridSquareBBox(ix, iy, side) {
      return {
        min: [ix * side, iy * side],
        max: [(ix + 1) * side, (iy + 1) * side]
      };
    }

    function isTextShape(shape) {
      return String(shape && shape.type || '').toLowerCase() === 'textdisplay';
    }

    function pointsAlmostEqual(a, b) {
      return Math.abs(((a && a[0]) || 0) - ((b && b[0]) || 0)) < 0.0005
        && Math.abs(((a && a[1]) || 0) - ((b && b[1]) || 0)) < 0.0005;
    }

    function cleanedPoints(points) {
      var out = [];
      var i;
      for (i = 0; i < (points || []).length; i += 1) {
        var pt = points[i];
        if (pt && isFinite(pt[0]) && isFinite(pt[1])) out.push([pt[0], pt[1]]);
      }
      while (out.length > 1 && pointsAlmostEqual(out[0], out[out.length - 1])) out.pop();
      return out;
    }

    function bboxFootprint(bbox) {
      return [
        [bbox.min[0], bbox.min[1]],
        [bbox.max[0], bbox.min[1]],
        [bbox.max[0], bbox.max[1]],
        [bbox.min[0], bbox.max[1]]
      ];
    }

    function bboxFromPoints(points) {
      var xs = [];
      var ys = [];
      var i;
      for (i = 0; i < points.length; i += 1) {
        xs.push(points[i][0]);
        ys.push(points[i][1]);
      }
      return {
        min: [Math.min.apply(Math, xs), Math.min.apply(Math, ys)],
        max: [Math.max.apply(Math, xs), Math.max.apply(Math, ys)]
      };
    }

    function pathFootprints(points, width) {
      var pts = cleanedPoints(points);
      var half = Math.max(Number(width) || 0, 0.001) / 2;
      var footprints = [];
      var i;
      for (i = 0; i < pts.length - 1; i += 1) {
        var a = pts[i];
        var b = pts[i + 1];
        var dx = b[0] - a[0];
        var dy = b[1] - a[1];
        var len = Math.sqrt(dx * dx + dy * dy);
        var nx;
        var ny;
        if (len < 0.0005) continue;
        nx = -dy / len * half;
        ny = dx / len * half;
        footprints.push([
          [a[0] + nx, a[1] + ny],
          [b[0] + nx, b[1] + ny],
          [b[0] - nx, b[1] - ny],
          [a[0] - nx, a[1] - ny]
        ]);
      }
      for (i = 0; i < pts.length; i += 1) {
        footprints.push([
          [pts[i][0] - half, pts[i][1] - half],
          [pts[i][0] + half, pts[i][1] - half],
          [pts[i][0] + half, pts[i][1] + half],
          [pts[i][0] - half, pts[i][1] + half]
        ]);
      }
      return footprints;
    }

    function shapeFootprints(shape) {
      var pts;
      if (isTextShape(shape)) return [];
      pts = cleanedPoints(shape.points);
      if (String(shape.type || '').toLowerCase() === 'path' && pts.length >= 2 && Number(shape.width) > 0) {
        return pathFootprints(pts, shape.width);
      }
      if (pts.length >= 3) return [pts];
      return shape.bbox ? [bboxFootprint(shape.bbox)] : [];
    }

    function mergeableSquareGroup(group) {
      var width = group.bbox.max[0] - group.bbox.min[0];
      var height = group.bbox.max[1] - group.bbox.min[1];
      var ratio = width / Math.max(height, 0.001);
      return (group.mergedCount || 0) >= 2 && ratio >= 0.72 && ratio <= 1.38;
    }

    function firstExistingLayer(names) {
      var i;
      var normalized;
      for (i = 0; i < (names || []).length; i += 1) {
        normalized = normalizedLayerName(names[i]);
        if (layerMeta[normalized]) return normalized;
      }
      return '';
    }

    function connectorSpan(layerName) {
      var meta = layerMeta[layerName] || {};
      var h = layerHeight(layerName);
      var overlap = Math.max(h * 0.08, 0.01);
      var bottom = layerY(layerName);
      var top = bottom + h;
      var lower;
      var upper;
      if (meta.kind === 'contact') {
        lower = firstExistingLayer(meta.lowerLayers || ['DIFF', 'OD', 'ACTIVE', 'AA', 'POLY1', 'POLY', 'PO', 'GT']);
        upper = meta.upperLayer && layerMeta[normalizedLayerName(meta.upperLayer)]
          ? normalizedLayerName(meta.upperLayer)
          : existingMetalMetadataLayer(layerMeta, 1);
        if (lower) bottom = layerY(lower) + layerHeight(lower) - overlap;
        if (upper) top = layerY(upper) + overlap;
      } else if (meta.kind === 'via') {
        lower = meta.lowerLayer && layerMeta[meta.lowerLayer] ? meta.lowerLayer : '';
        upper = meta.upperLayer && layerMeta[meta.upperLayer] ? meta.upperLayer : '';
        if (lower) bottom = layerY(lower) + layerHeight(lower) - overlap;
        if (upper) top = layerY(upper) + overlap;
      }
      return {
        bottom: Math.min(bottom, top),
        top: Math.max(Math.min(bottom, top) + h * 0.65, Math.max(bottom, top))
      };
    }

    function fitScale() {
      var stack = stackHeight();
      var extentY = bounds.sizeY + stack * 0.55;
      return Math.min(window.innerWidth * 0.72 / bounds.sizeX, window.innerHeight * 0.72 / extentY);
    }

    function prepareProjection() {
      drawCos = Math.cos(angle);
      drawSin = Math.sin(angle);
      drawPitchSin = Math.sin(pitch);
      drawPitchCos = Math.cos(pitch);
      drawScale = fitScale() * zoom;
    }

    function project(x, y, z) {
      var wx = x - bounds.centerX - viewOffset.x;
      var wy = z - viewOffset.y;
      var wz = -(y - bounds.centerY) - viewOffset.z;
      var rx = wx * drawCos - wz * drawSin;
      var rz = wx * drawSin + wz * drawCos;
      return {
        x: window.innerWidth / 2 + panX + rx * drawScale,
        y: window.innerHeight / 2 + panY + (rz * drawPitchSin - wy * drawPitchCos) * drawScale
      };
    }

    function requestDraw(fast) {
      if (fast) {
        lastFastInputAt = performance.now ? performance.now() : Date.now();
        fastMode = true;
        if (fullDrawTimer) window.clearTimeout(fullDrawTimer);
        fullDrawTimer = window.setTimeout(function () {
          if (pointerHeld) {
            fullDrawTimer = null;
            return;
          }
          var now = performance.now ? performance.now() : Date.now();
          var remaining = 180 - (now - lastFastInputAt);
          if (remaining > 0) {
            fullDrawTimer = window.setTimeout(function () { requestDraw(false); }, remaining);
            return;
          }
          fastMode = false;
          requestDraw(false);
        }, 180);
      } else {
        fastMode = false;
        if (fullDrawTimer) {
          window.clearTimeout(fullDrawTimer);
          fullDrawTimer = null;
        }
      }
      if (drawPending) return;
      drawPending = true;
      window.requestAnimationFrame(function () {
        drawPending = false;
        draw();
      });
    }

    function poly(points, fill, stroke, alpha, width) {
      if (!points.length) return;
      ctx.globalAlpha = alpha == null ? 1 : alpha;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (var i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
      ctx.closePath();
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = width || 0.7;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    function pathUnderRoot(path, rootPath) {
      return path === rootPath || String(path || '').indexOf(rootPath + '/') === 0;
    }

    function matchesHighlight(ownerCell, masterCell, hierPath) {
      var i;
      if (!highlightedCell) return true;
      if (ownerCell === highlightedCell || masterCell === highlightedCell) return true;
      for (i = 0; i < highlightRoots.length; i += 1) {
        if (pathUnderRoot(hierPath, highlightRoots[i])) return true;
      }
      return false;
    }

    function shapeCorners(bbox, z, h) {
      var x1 = bbox.min[0], y1 = bbox.min[1], x2 = bbox.max[0], y2 = bbox.max[1];
      return {
        top: [
          project(x1, y1, z + h),
          project(x2, y1, z + h),
          project(x2, y2, z + h),
          project(x1, y2, z + h)
        ],
        front: [
          project(x1, y2, z),
          project(x2, y2, z),
          project(x2, y2, z + h),
          project(x1, y2, z + h)
        ],
        side: [
          project(x2, y1, z),
          project(x2, y2, z),
          project(x2, y2, z + h),
          project(x2, y1, z + h)
        ]
      };
    }

    function pointDepth(x, y, z) {
      var wx = x - bounds.centerX - viewOffset.x;
      var wy = z - viewOffset.y;
      var wz = -(y - bounds.centerY) - viewOffset.z;
      var rz = wx * drawSin + wz * drawCos;
      return rz * drawPitchCos + wy * drawPitchSin;
    }

    function projectFootprintPoint(pt, z) {
      var p = project(pt[0], pt[1], z);
      p.depth = pointDepth(pt[0], pt[1], z);
      return p;
    }

    function averageDepth(points) {
      var sum = 0;
      var i;
      for (i = 0; i < points.length; i += 1) sum += points[i].depth || 0;
      return sum / Math.max(1, points.length);
    }

    function faceSortDepth(points) {
      var maxDepth = -Infinity;
      var sum = 0;
      var i;
      for (i = 0; i < points.length; i += 1) {
        maxDepth = Math.max(maxDepth, points[i].depth || 0);
        sum += points[i].depth || 0;
      }
      return maxDepth + (sum / Math.max(1, points.length)) * 0.0001;
    }

    function itemAlpha(item) {
      var alpha = Number(alphaScale.value || 0.88);
      if (item.kind === 'connector') alpha = Math.min(0.96, alpha * 1.1);
      if (item.muted) alpha *= 0.14;
      else if (alpha >= 0.82) alpha = 1;
      return alpha;
    }

    function surfaceStroke(alpha) {
      return themeSelect.value === 'light' ? rgba('#11130f', alpha) : rgba('#fff6d8', alpha);
    }

    function sideShade(item, a, b, edgeIndex) {
      var dx = b[0] - a[0];
      var dy = b[1] - a[1];
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var nx = -dy / len;
      var ny = dx / len;
      var lit = Math.max(0, nx * -0.48 + ny * 0.62);
      var view = Math.abs(nx * drawCos + ny * drawSin);
      var factor = 0.42 + lit * 0.28 + view * 0.16 + (edgeIndex % 2) * 0.04;
      if (item.kind === 'connector') factor += 0.08;
      return shade(item.baseColor || item.color, clamp(factor * (item.tone || 1), 0.36, 0.9));
    }

    function prismFaces(item, fast) {
      var footprint = item.footprint || bboxFootprint(item.bbox);
      var top = [];
      var bottom = [];
      var faces = [];
      var alpha = itemAlpha(item) * (fast ? 0.78 : 1);
      var stroke = wireToggle.checked ? '#f8f0d8' : surfaceStroke(item.kind === 'connector' ? 0.28 : 0.22);
      var strokeAlpha = item.muted ? 0.08 : (item.matched ? 0.82 : (item.kind === 'connector' ? 0.42 : 0.34));
      var i;
      if (!footprint || footprint.length < 3) return faces;
      for (i = 0; i < footprint.length; i += 1) {
        bottom.push(projectFootprintPoint(footprint[i], item.z));
        top.push(projectFootprintPoint(footprint[i], item.z + item.h));
      }
      for (i = 0; i < footprint.length; i += 1) {
        var j = (i + 1) % footprint.length;
        var side = [bottom[i], bottom[j], top[j], top[i]];
        faces.push({
          points: side,
          fill: sideShade(item, footprint[i], footprint[j], i),
          stroke: stroke,
          alpha: alpha * (fast ? 0.5 : 0.72),
          strokeAlpha: strokeAlpha * 0.9,
          width: item.matched ? 1.15 : 0.55,
          depth: faceSortDepth(side),
          order: 1
        });
      }
      if (!fast && pitch < -0.08) {
        faces.push({
          points: bottom.slice().reverse(),
          fill: item.frontColor,
          stroke: stroke,
          alpha: alpha * 0.46,
          strokeAlpha: strokeAlpha * 0.75,
          width: item.matched ? 1.15 : 0.55,
          depth: faceSortDepth(bottom),
          order: 0
        });
      }
      faces.push({
        points: top,
        fill: shade(item.baseColor || item.color, (item.kind === 'connector' ? 1.04 : 0.98) * (item.tone || 1)),
        stroke: stroke,
        alpha: alpha,
        strokeAlpha: strokeAlpha,
        width: item.matched ? 1.2 : (item.kind === 'connector' ? 0.95 : 0.65),
        depth: faceSortDepth(top),
        order: 2
      });
      if (item.matched) {
        faces.push({
          points: top,
          fill: null,
          stroke: '#fff2bf',
          alpha: 0.78,
          strokeAlpha: 0.86,
          width: 1.3,
          depth: faceSortDepth(top) + 0.0001,
          order: 3
        });
      }
      return faces;
    }

    function drawFace(face) {
      if (face.fill) poly(face.points, face.fill, null, face.alpha, face.width);
      if (face.stroke) poly(face.points, null, face.stroke, face.strokeAlpha == null ? face.alpha : face.strokeAlpha, face.width);
    }

    function connectorRecordFromShape(shape) {
      return {
        bbox: shape.bbox,
        layer: shape.layer,
        ownerCell: shape.ownerCell,
        masterCell: '',
        hierPath: shape.hierPath
      };
    }

    function connectorRecordFromInstance(inst) {
      var layer = inferConnectorLayer(inst, layerMeta);
      if (!layer) return null;
      return {
        bbox: inst.bbox,
        layer: layer,
        ownerCell: '',
        masterCell: inst.master.cell,
        hierPath: inst.hierPath
      };
    }

    function refreshHighlightRoots() {
      highlightRoots = [];
      if (!currentData || !highlightedCell) return;
      currentData.instances.forEach(function (inst) {
        if (inst.master && inst.master.cell === highlightedCell) {
          highlightRoots.push(inst.hierPath);
        }
      });
    }

    function collectConnectorRecords() {
      var records = [];
      var shapePaths = {};
      currentData.shapes.forEach(function (shape) {
        var meta = layerMeta[shape.layer];
        shapePaths[shape.hierPath] = true;
        if (meta && layerVisible[shape.layer] !== false && layerIsConnector(shape.layer, meta)) {
          records.push(connectorRecordFromShape(shape));
        }
      });
      currentData.instances.forEach(function (inst) {
        if (shapePaths[inst.hierPath]) return;
        var record = connectorRecordFromInstance(inst);
        if (record && layerMeta[record.layer] && layerVisible[record.layer] !== false) {
          records.push(record);
        }
      });
      return records;
    }

    function aggregateConnectorRecords(records) {
      var grid = viaMergeSize();
      var groups = {};
      var keys = [];
      var i;
      if (grid <= 0) return records;
      for (i = 0; i < records.length; i += 1) {
        var record = records[i];
        var center = {
          x: (record.bbox.min[0] + record.bbox.max[0]) / 2,
          y: (record.bbox.min[1] + record.bbox.max[1]) / 2
        };
        var ix = Math.floor(center.x / grid);
        var iy = Math.floor(center.y / grid);
        var hit = matchesHighlight(record.ownerCell, record.masterCell, record.hierPath);
        var key = [record.layer, hit ? 'hit' : 'dim', ix, iy].join('|');
        var group = groups[key];
        if (!group) {
          group = {
            bbox: gridSquareBBox(ix, iy, grid),
            sourceBBox: {
              min: [record.bbox.min[0], record.bbox.min[1]],
              max: [record.bbox.max[0], record.bbox.max[1]]
            },
            layer: record.layer,
            ownerCell: record.ownerCell,
            masterCell: record.masterCell,
            hierPath: record.hierPath,
            simplified: true,
            mergedCount: 0,
            records: []
          };
          groups[key] = group;
          keys.push(key);
        } else {
          group.sourceBBox.min[0] = Math.min(group.sourceBBox.min[0], record.bbox.min[0]);
          group.sourceBBox.min[1] = Math.min(group.sourceBBox.min[1], record.bbox.min[1]);
          group.sourceBBox.max[0] = Math.max(group.sourceBBox.max[0], record.bbox.max[0]);
          group.sourceBBox.max[1] = Math.max(group.sourceBBox.max[1], record.bbox.max[1]);
        }
        group.mergedCount += 1;
        group.records.push(record);
      }
      return keys.map(function (key) { return groups[key]; });
    }

    function buildDrawItems() {
      var limit = 24000;
      var drawableShapes = [];
      var shapeStride;
      var connectorStride;
      var connectors;
      var i;
      drawItems = [];
      connectorCount = 0;
      displayedConnectorCount = 0;
      shapeDrawItemCount = 0;
      if (!currentData) return;
      refreshHighlightRoots();
      for (i = 0; i < currentData.shapes.length; i += 1) {
        var shape = currentData.shapes[i];
        var meta = layerMeta[shape.layer] || { color: '#888888' };
        if (layerVisible[shape.layer] === false || layerIsConnector(shape.layer, meta) || isTextShape(shape)) continue;
        drawableShapes.push(shape);
      }
      shapeStride = Math.max(1, Math.ceil(drawableShapes.length / 7000));
      for (i = 0; i < drawableShapes.length; i += shapeStride) {
        var shape = drawableShapes[i];
        var meta = layerMeta[shape.layer] || { color: '#888888' };
        var matched = matchesHighlight(shape.ownerCell, '', shape.hierPath);
        shapeFootprints(shape).forEach(function (footprint, partIndex) {
          var tone = visualTone(String(shape.hierPath || '') + '|' + shape.layer + '|' + shape.type, partIndex);
          drawItems.push({
            kind: 'shape',
            bbox: bboxFromPoints(footprint),
            footprint: footprint,
            z: layerY(shape.layer),
            h: layerHeight(shape.layer),
            baseColor: meta.color || '#888888',
            color: shade(meta.color || '#888888', tone),
            frontColor: shade(meta.color || '#888888', 0.46 * tone),
            sideColor: shade(meta.color || '#888888', 0.62 * tone),
            tone: tone,
            strokeColor: rgba('#ffffff', 0.16),
            muted: Boolean(highlightedCell && !matched),
            matched: Boolean(highlightedCell && matched),
            sort: 0
          });
        });
      }
      shapeDrawItemCount = drawItems.length;
      connectors = collectConnectorRecords();
      connectorCount = connectors.length;
      connectors = aggregateConnectorRecords(connectors);
      displayedConnectorCount = connectors.length;
      connectorStride = Math.max(1, Math.ceil(connectors.length / Math.max(1, limit - drawItems.length)));
      for (i = 0; i < connectors.length; i += connectorStride) {
        var record = connectors[i];
        var layer = layerMeta[record.layer] || { color: '#f8f0d8' };
        var span = connectorSpan(record.layer);
        var hit = matchesHighlight(record.ownerCell, record.masterCell, record.hierPath);
        drawItems.push({
          kind: 'connector',
          bbox: record.bbox,
          footprint: bboxFootprint(record.bbox),
          z: span.bottom,
          h: span.top - span.bottom,
          baseColor: layer.color || '#f8f0d8',
          color: layer.color || '#f8f0d8',
          frontColor: shade(layer.color || '#f8f0d8', 0.58),
          sideColor: shade(layer.color || '#f8f0d8', 0.72),
          tone: 1,
          strokeColor: rgba('#ffffff', 0.22),
          muted: Boolean(highlightedCell && !hit),
          matched: Boolean(highlightedCell && hit),
          sort: 0
        });
      }
      var connectorDrawItemCount = Math.max(0, drawItems.length - shapeDrawItemCount);
      var fastShapeStride = Math.max(1, Math.ceil(shapeDrawItemCount / 1200));
      var fastConnectorStride = Math.max(1, Math.ceil(connectorDrawItemCount / 1800));
      var fastShapeSeen = 0;
      var fastConnectorSeen = 0;
      fastDrawItems = drawItems.filter(function (item) {
        if (item.matched) return true;
        if (item.kind === 'connector') {
          fastConnectorSeen += 1;
          return fastConnectorSeen % fastConnectorStride === 1 || fastConnectorStride === 1;
        }
        fastShapeSeen += 1;
        return fastShapeSeen % fastShapeStride === 1 || fastShapeStride === 1;
      });
      window.__VL3D_STATE = {
        mode: 'canvas-fallback',
        library: currentData.library,
        cell: currentData.cell,
        view: currentData.view,
        selectedLayoutKey: entryKey(currentData),
        shapeMeshes: drawItems.length,
        connectorMeshes: displayedConnectorCount,
        connectorSourceCount: connectorCount,
        totalShapes: currentData.shapeCount,
        sourceShapeCount: currentData.sourceShapeCount || currentData.shapeCount,
        layers: currentData.layers.length,
        highlight: highlightedCell,
        instanceOverlays: 0,
        rulerStep: lastRulerStep,
        lastDrawMs: lastDrawMs,
        visibleItems: lastVisibleItems,
        fastMode: fastMode,
        viaMerge: viaMergeSize(),
        palette: selectedPaletteName(),
        theme: themeSelect.value === 'light' ? 'light' : 'dark',
        navigation: navigationSettings
      };
      updateViaMergeLabel(displayedConnectorCount, connectorCount);
    }

    function line3d(a, b, color, alpha, width) {
      var p1 = project(a[0], a[1], a[2]);
      var p2 = project(b[0], b[1], b[2]);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = width || 1;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      ctx.restore();
    }

    function text3d(text, x, y, z, color) {
      var p = project(x, y, z);
      ctx.save();
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = color;
      ctx.font = '600 12px sans-serif';
      ctx.fillText(text, p.x + 4, p.y - 4);
      ctx.restore();
    }

    function drawAxesAndRuler() {
      if (!bounds) return;
      var top = stackHeight();
      var tick = niceStep(Math.max(bounds.sizeX, bounds.sizeY) / 8);
      var tickSize = Math.max(tick * 0.12, bounds.radius * 0.01);
      var x;
      var y;
      lastRulerStep = tick;
      line3d([bounds.minX, bounds.maxY, 0], [bounds.maxX, bounds.maxY, 0], '#ff8787', 0.34, 1);
      line3d([bounds.minX, bounds.maxY, 0], [bounds.minX, bounds.maxY, top], '#8ce99a', 0.34, 1);
      line3d([bounds.minX, bounds.maxY, 0], [bounds.minX, bounds.minY, 0], '#91a7ff', 0.34, 1);
      for (x = Math.ceil(bounds.minX / tick) * tick; x <= bounds.maxX + tick * 0.2; x += tick) {
        line3d([x, bounds.maxY - tickSize, 0], [x, bounds.maxY + tickSize, 0], '#ffd8a8', 0.22, 1);
      }
      for (y = Math.ceil(bounds.minY / tick) * tick; y <= bounds.maxY + tick * 0.2; y += tick) {
        line3d([bounds.minX - tickSize, y, 0], [bounds.minX + tickSize, y, 0], '#d0ebff', 0.22, 1);
      }
      text3d('X', bounds.maxX + tickSize * 1.4, bounds.maxY, 0, '#ff8787');
      text3d('Y', bounds.minX, bounds.maxY, top + Math.max(0.2 * stackScale(), 1), '#8ce99a');
      text3d('Z', bounds.minX, bounds.minY - tickSize * 1.4, 0, '#91a7ff');
      rulerInfo.textContent = 'X ' + fmt(bounds.sizeX) + ' um | Z ' + fmt(bounds.sizeY) + ' um | tick ' + fmt(tick) + ' um | Y ' + currentData.layers.length + ' layers';
    }

    function projectedAxisDirection(dx, dy, dz) {
      var p0 = project(bounds.centerX, bounds.centerY, 0);
      var p1 = project(bounds.centerX + dx, bounds.centerY + dy, dz);
      var vx = p1.x - p0.x;
      var vy = p1.y - p0.y;
      var len = Math.sqrt(vx * vx + vy * vy);
      if (!isFinite(len) || len < 6) return null;
      return { x: vx / len, y: vy / len };
    }

    function edgeDistance(origin, dir, padding) {
      var candidates = [];
      var pad = padding || 18;
      if (Math.abs(dir.x) > 0.0001) {
        candidates.push(((dir.x > 0 ? window.innerWidth - pad : pad) - origin.x) / dir.x);
      }
      if (Math.abs(dir.y) > 0.0001) {
        candidates.push(((dir.y > 0 ? window.innerHeight - pad : pad) - origin.y) / dir.y);
      }
      candidates = candidates.filter(function (value) { return value > 0 && isFinite(value); });
      return Math.max(24, Math.min.apply(Math, candidates));
    }

    function drawAxisLine(origin, dir, color, label, tickLabel, tickSpacing) {
      if (!dir) return;
      var posLen = edgeDistance(origin, dir);
      var negLen = edgeDistance(origin, { x: -dir.x, y: -dir.y });
      var start = { x: origin.x - dir.x * negLen, y: origin.y - dir.y * negLen };
      var end = { x: origin.x + dir.x * posLen, y: origin.y + dir.y * posLen };
      axisCtx.save();
      axisCtx.strokeStyle = color;
      axisCtx.fillStyle = color;
      axisCtx.lineWidth = 2.1;
      axisCtx.lineCap = 'round';
      axisCtx.beginPath();
      axisCtx.moveTo(start.x, start.y);
      axisCtx.lineTo(end.x, end.y);
      axisCtx.stroke();
      axisCtx.beginPath();
      axisCtx.moveTo(end.x, end.y);
      axisCtx.lineTo(end.x - dir.x * 12 - dir.y * 5.5, end.y - dir.y * 12 + dir.x * 5.5);
      axisCtx.lineTo(end.x - dir.x * 12 + dir.y * 5.5, end.y - dir.y * 12 - dir.x * 5.5);
      axisCtx.closePath();
      axisCtx.fill();
      axisCtx.font = '600 10px sans-serif';
      for (var distance = -Math.floor(negLen / tickSpacing) * tickSpacing; distance < posLen - 10; distance += tickSpacing) {
        if (Math.abs(distance) < 2) continue;
        var x = origin.x + dir.x * distance;
        var y = origin.y + dir.y * distance;
        axisCtx.beginPath();
        axisCtx.moveTo(x - dir.y * 5, y + dir.x * 5);
        axisCtx.lineTo(x + dir.y * 5, y - dir.x * 5);
        axisCtx.stroke();
        var value = Math.round(distance / tickSpacing) * Number(String(tickLabel).replace('um', ''));
        axisCtx.fillText(fmt(value || 0), x + dir.y * 7 + 2, y - dir.x * 7 - 2);
      }
      axisCtx.font = '700 13px sans-serif';
      axisCtx.fillText(label, end.x - dir.x * 18 - 5, end.y - dir.y * 18 + 4);
      axisCtx.restore();
    }

    function drawCenterAxisOverlay() {
      if (!bounds) return;
      var theme = currentTheme();
      var origin = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      var tick = niceStep(Math.max(0.001, bounds.radius / (zoom * 8)));
      var tickSpacing = clamp(Math.round(60 / Math.max(1, window.devicePixelRatio || 1)), 26, 48);
      lastRulerStep = tick;
      axisCtx.save();
      axisCtx.globalAlpha = 0.9;
      axisCtx.shadowColor = theme.shadow;
      axisCtx.shadowBlur = 4;
      axisCtx.fillStyle = theme.axisText;
      axisCtx.strokeStyle = theme.tick;
      axisCtx.font = '600 12px sans-serif';
      axisCtx.beginPath();
      axisCtx.arc(origin.x, origin.y, 4.2, 0, Math.PI * 2);
      axisCtx.fill();
      axisCtx.fillText('0', origin.x + 8, origin.y - 8);
      axisCtx.restore();
      drawAxisLine(origin, projectedAxisDirection(tick, 0, 0), theme.axisX, 'X', fmt(tick) + 'um', tickSpacing);
      drawAxisLine(origin, projectedAxisDirection(0, tick, 0), theme.axisY, 'Y', fmt(tick) + 'um', tickSpacing);
      drawAxisLine(origin, projectedAxisDirection(0, 0, Math.max(1, tick * stackScale())), theme.axisZ, 'Z', fmt(tick) + 'um', tickSpacing);
      rulerInfo.textContent = 'X ' + fmt(bounds.sizeX) + ' um | Y ' + fmt(bounds.sizeY) + ' um | tick ' + fmt(tick) + ' um | via merge ' + (viaMergeSize() <= 0 ? 'off' : fmt(viaMergeSize()) + ' um');
    }

    function drawAttitudeArrow(ctx2, from, dir, color, label, radius) {
      var to;
      var ux;
      var uy;
      if (!dir) {
        ctx2.save();
        ctx2.fillStyle = color;
        ctx2.globalAlpha = 0.82;
        ctx2.beginPath();
        ctx2.arc(from.x, from.y, 4.5, 0, Math.PI * 2);
        ctx2.fill();
        ctx2.font = '700 12px sans-serif';
        ctx2.fillText(label, from.x + 8, from.y - 6);
        ctx2.restore();
        return;
      }
      to = { x: from.x + dir.x * radius, y: from.y + dir.y * radius };
      ux = dir.x;
      uy = dir.y;
      ctx2.save();
      ctx2.strokeStyle = color;
      ctx2.fillStyle = color;
      ctx2.lineWidth = 2;
      ctx2.lineCap = 'round';
      ctx2.beginPath();
      ctx2.moveTo(from.x, from.y);
      ctx2.lineTo(to.x, to.y);
      ctx2.stroke();
      ctx2.beginPath();
      ctx2.moveTo(to.x, to.y);
      ctx2.lineTo(to.x - ux * 9 - uy * 4.5, to.y - uy * 9 + ux * 4.5);
      ctx2.lineTo(to.x - ux * 9 + uy * 4.5, to.y - uy * 9 - ux * 4.5);
      ctx2.closePath();
      ctx2.fill();
      ctx2.font = '700 12px sans-serif';
      ctx2.fillText(label, to.x + ux * 7 + 2, to.y + uy * 7 + 4);
      ctx2.restore();
    }

    function drawAttitudeOverlay() {
      if (!attitudeCanvas || !attitudeCtx || !bounds) return;
      var rect = attitudeCanvas.getBoundingClientRect();
      var width = rect.width || 156;
      var height = rect.height || 156;
      var center = { x: width / 2, y: height / 2 };
      var radius = Math.min(width, height) * 0.38;
      var theme = currentTheme();
      var tick = niceStep(Math.max(0.001, bounds.radius / 10));
      var i;
      attitudeCtx.clearRect(0, 0, width, height);
      attitudeCtx.save();
      attitudeCtx.strokeStyle = theme.tick;
      attitudeCtx.globalAlpha = 0.72;
      attitudeCtx.lineWidth = 1;
      attitudeCtx.beginPath();
      attitudeCtx.arc(center.x, center.y, radius, 0, Math.PI * 2);
      attitudeCtx.stroke();
      for (i = -2; i <= 2; i += 1) {
        if (i === 0) continue;
        attitudeCtx.globalAlpha = 0.22;
        attitudeCtx.beginPath();
        attitudeCtx.ellipse(center.x, center.y + (i * radius) / 4, radius * Math.sqrt(1 - (i * i) / 16), radius * 0.12, 0, 0, Math.PI * 2);
        attitudeCtx.stroke();
        attitudeCtx.beginPath();
        attitudeCtx.ellipse(center.x, center.y, radius * 0.25, radius, (i * Math.PI) / 8, 0, Math.PI * 2);
        attitudeCtx.stroke();
      }
      attitudeCtx.globalAlpha = 0.36;
      attitudeCtx.beginPath();
      attitudeCtx.ellipse(center.x, center.y, radius, radius * 0.28, 0, 0, Math.PI * 2);
      attitudeCtx.stroke();
      attitudeCtx.restore();
      drawAttitudeArrow(attitudeCtx, center, projectedAxisDirection(tick, 0, 0), theme.axisX, 'X', radius * 0.92);
      drawAttitudeArrow(attitudeCtx, center, projectedAxisDirection(0, tick, 0), theme.axisY, 'Y', radius * 0.92);
      drawAttitudeArrow(attitudeCtx, center, projectedAxisDirection(0, 0, Math.max(1, tick * stackScale())), theme.axisZ, 'Z', radius * 0.92);
    }

    function drawGrid(fast) {
      if (!bounds) return;
      var theme = currentTheme();
      ctx.save();
      ctx.globalAlpha = fast ? 0.18 : 0.28;
      ctx.strokeStyle = theme.grid;
      ctx.lineWidth = 0.6;
      var step = niceStep(bounds.radius / (fast ? 9 : 18));
      var x, y, p1, p2;
      for (x = Math.floor(bounds.minX / step) * step; x <= bounds.maxX; x += step) {
        p1 = project(x, bounds.minY, 0);
        p2 = project(x, bounds.maxY, 0);
        ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
      }
      for (y = Math.floor(bounds.minY / step) * step; y <= bounds.maxY; y += step) {
        p1 = project(bounds.minX, y, 0);
        p2 = project(bounds.maxX, y, 0);
        ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
      }
      ctx.restore();
    }

    function drawInstances() {
      return;
      if (!instancesToggle.checked || !hasVisibleLayers() || !currentData.instances) return;
      ctx.save();
      var topZ = stackHeight();
      for (var i = 0; i < currentData.instances.length; i += 1) {
        var inst = currentData.instances[i];
        var depth = (inst.hierPath.match(/\//g) || []).length;
        if (depth > 1) continue;
        var matched = matchesHighlight('', inst.master.cell, inst.hierPath);
        ctx.globalAlpha = highlightedCell && !matched ? 0.08 : 0.32;
        ctx.strokeStyle = highlightedCell && matched ? '#f8f0d8' : '#d8d2c4';
        ctx.lineWidth = 0.8;
        var b = inst.bbox;
        var top = [
          project(b.min[0], b.min[1], topZ),
          project(b.max[0], b.min[1], topZ),
          project(b.max[0], b.max[1], topZ),
          project(b.min[0], b.max[1], topZ)
        ];
        var bottom = [
          project(b.min[0], b.min[1], 0),
          project(b.max[0], b.min[1], 0),
          project(b.max[0], b.max[1], 0),
          project(b.min[0], b.max[1], 0)
        ];
        ctx.beginPath();
        for (var j = 0; j < 4; j += 1) {
          ctx.moveTo(bottom[j].x, bottom[j].y);
          ctx.lineTo(top[j].x, top[j].y);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    function drawConnectorFast(item) {
      var c = shapeCorners(item.bbox, item.z, item.h);
      var alpha = item.muted ? 0.05 : (item.matched ? 0.72 : 0.42);
      poly(c.front, item.frontColor, null, alpha * 0.52);
      poly(c.side, item.sideColor, null, alpha * 0.56);
      poly(c.top, item.color, item.matched ? '#fff2bf' : rgba('#ffffff', 0.22), alpha * 0.7, item.matched ? 1.2 : 0.65);
      if (item.matched) drawFastFrame(c, '#fff2bf', Math.min(0.82, alpha + 0.18), 1.15);
    }

    function drawShapeFast(item) {
      var c = shapeCorners(item.bbox, item.z, item.h);
      var alpha = Number(alphaScale.value || 0.88) * (item.muted ? 0.12 : 0.46);
      poly(c.front, item.frontColor, null, alpha * 0.52);
      poly(c.side, item.sideColor, null, alpha * 0.56);
      poly(c.top, item.color, item.matched ? '#fff2bf' : null, alpha * 0.68, item.matched ? 1.2 : 0.55);
      if (item.matched) drawFastFrame(c, '#fff2bf', Math.min(0.78, alpha + 0.18), 1.15);
    }

    function drawFastFrame(c, color, alpha, width) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = width || 0.75;
      ctx.beginPath();
      ctx.moveTo(c.top[0].x, c.top[0].y);
      for (var i = 1; i < c.top.length; i += 1) ctx.lineTo(c.top[i].x, c.top[i].y);
      ctx.closePath();
      ctx.moveTo(c.front[0].x, c.front[0].y);
      ctx.lineTo(c.front[1].x, c.front[1].y);
      ctx.moveTo(c.side[0].x, c.side[0].y);
      ctx.lineTo(c.side[1].x, c.side[1].y);
      ctx.moveTo(c.front[0].x, c.front[0].y);
      ctx.lineTo(c.front[3].x, c.front[3].y);
      ctx.moveTo(c.front[1].x, c.front[1].y);
      ctx.lineTo(c.front[2].x, c.front[2].y);
      ctx.moveTo(c.side[0].x, c.side[0].y);
      ctx.lineTo(c.side[3].x, c.side[3].y);
      ctx.stroke();
      ctx.restore();
    }

    function drawPrism(item, fast) {
      if (item.kind === 'connector' && fast) {
        drawConnectorFast(item);
        return;
      }
      if (fast) {
        drawShapeFast(item);
        return;
      }
      var faces = prismFaces(item, fast);
      faces.sort(function (a, b) { return a.depth - b.depth || (a.order || 0) - (b.order || 0); });
      faces.forEach(drawFace);
    }

    function draw() {
      var started = performance.now ? performance.now() : Date.now();
      var fast = fastMode;
      var theme = currentTheme();
      var drawn = 0;
      var faces = [];
      var items = fast ? fastDrawItems : drawItems;
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      ctx.fillStyle = theme.background;
      ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
      axisCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      if (!currentData || !bounds) return;
      prepareProjection();
      drawGrid(fast);
      for (var i = 0; i < items.length; i += 1) {
        var item = items[i];
        if (fast) {
          drawPrism(item, true);
        } else {
          var itemFaces = prismFaces(item, false);
          for (var faceIndex = 0; faceIndex < itemFaces.length; faceIndex += 1) {
            faces.push(itemFaces[faceIndex]);
          }
        }
        drawn += 1;
      }
      if (!fast) {
        faces.sort(function (a, b) { return a.depth - b.depth || (a.order || 0) - (b.order || 0); });
        faces.forEach(drawFace);
      }
      if (!fast) drawInstances();
      drawCenterAxisOverlay();
      drawAttitudeOverlay();
      ctx.fillStyle = theme.axisText;
      ctx.font = '12px sans-serif';
      ctx.fillText('Canvas fallback: ' + currentData.library + '/' + currentData.cell + '/' + currentData.view, 24, window.innerHeight - 28);
      lastDrawMs = (performance.now ? performance.now() : Date.now()) - started;
      lastVisibleItems = drawn;
      if (window.__VL3D_STATE) {
        window.__VL3D_STATE.lastDrawMs = lastDrawMs;
        window.__VL3D_STATE.visibleItems = lastVisibleItems;
        window.__VL3D_STATE.fastMode = fast;
        window.__VL3D_STATE.palette = selectedPaletteName();
        window.__VL3D_STATE.theme = themeSelect.value === 'light' ? 'light' : 'dark';
      }
    }

    function layerCountText(layer) {
      var shapes = layer.shapeCount || 0;
      var connectors = layer.connectorCount || 0;
      var kind = layer.kind === 'contact' ? 'via' : (layer.kind || 'layer');
      var count = connectors ? String(shapes) + '+' + String(connectors) : String(shapes);
      return kind + ' ' + count + (layer.inferred ? ' inferred' : '');
    }

    function layersTopDown() {
      return (currentData.layers || []).slice().sort(function (a, b) {
        var delta = layerStackValue(b) - layerStackValue(a);
        return delta || String(b.name).localeCompare(String(a.name));
      });
    }

    function updateLayerPanel() {
      layerList.textContent = '';
      layersTopDown().forEach(function (layer) {
        var row = document.createElement('label');
        row.className = 'layer-row';
        var input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = layerVisible[layer.name] !== false;
        input.addEventListener('change', function () {
          layerVisible[layer.name] = input.checked;
          buildDrawItems();
          setCellStats();
          updateLegendPanel();
          requestDraw(false);
        });
        var swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = layerMeta[layer.name] && layerMeta[layer.name].color || layer.color;
        var name = document.createElement('span');
        name.className = 'layer-name';
        name.textContent = displayLayerName(layer);
        name.title = layer.name;
        var count = document.createElement('span');
        count.className = 'layer-count';
        count.textContent = layerCountText(layer);
        row.append(input, swatch, name, count);
        layerList.append(row);
      });
    }

    function updateLegendPanel() {
      if (!legendList) return;
      legendList.textContent = '';
      layersTopDown().forEach(function (layer) {
        var row = document.createElement('label');
        row.className = 'legend-row';
        var input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = layerVisible[layer.name] !== false;
        input.addEventListener('change', function () {
          layerVisible[layer.name] = input.checked;
          buildDrawItems();
          setCellStats();
          updateLayerPanel();
          requestDraw(false);
        });
        var swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = layerMeta[layer.name] && layerMeta[layer.name].color || layer.color;
        var name = document.createElement('span');
        name.className = 'layer-name';
        name.textContent = displayLayerName(layer);
        name.title = layer.name;
        var count = document.createElement('span');
        count.className = 'layer-count';
        count.textContent = ((layer.kind === 'via' || layer.kind === 'contact') ? 'via' : layer.kind) + ' ' + layerCountText(layer);
        row.append(input, swatch, name, count);
        legendList.append(row);
      });
    }

    function updateHighlightOptions() {
      var counts = {};
      highlightSelect.textContent = '';
      var all = document.createElement('option');
      all.value = '';
      all.textContent = 'All';
      highlightSelect.append(all);
      function add(cell) {
        if (!cell || cell === currentData.cell) return;
        counts[cell] = (counts[cell] || 0) + 1;
      }
      currentData.shapes.forEach(function (shape) { add(shape.ownerCell); });
      currentData.instances.forEach(function (inst) { add(inst.master && inst.master.cell); });
      Object.keys(counts).sort(function (a, b) {
        return counts[b] - counts[a] || a.localeCompare(b);
      }).forEach(function (cell) {
        var option = document.createElement('option');
        option.value = cell;
        option.textContent = cell + ' (' + counts[cell] + ')';
        highlightSelect.append(option);
      });
      if (!counts[highlightedCell]) highlightedCell = '';
      highlightSelect.value = highlightedCell;
    }

    function setCellStats() {
      var viaText = displayedConnectorCount !== connectorCount
        ? displayedConnectorCount + '/' + connectorCount + ' vias displayed'
        : connectorCount + ' vias';
      var source = currentData.sourceShapeCount && currentData.sourceShapeCount !== currentData.shapeCount
        ? '/' + currentData.sourceShapeCount + ' source'
        : '';
      var warnings = [
        currentData.approximateStackWarning,
        currentData.unclassifiedLayerWarning,
        payloadWarningText(currentData)
      ].filter(Boolean);
      cellStats.textContent = currentData.library + '/' + currentData.cell + '/' + currentData.view + ': ' +
        currentData.shapeCount + source + ' routing shapes, ' + viaText + ', ' +
        currentData.instanceCount + ' instances, ' + currentData.layers.length + ' layers' +
        (warnings.length ? ' · ⚠ ' + warnings.join(' · ') : '');
      cellStats.title = warnings.join('\n');
      if (technologyNotice) {
        technologyNotice.hidden = !currentData.approximateStackWarning;
        technologyNotice.textContent = currentData.approximateStackWarning || '';
      }
      rulerInfo.textContent = 'X ' + fmt(bounds.sizeX) + ' um | Y ' + fmt(bounds.sizeY) + ' um | tick ' + fmt(lastRulerStep) + ' um';
      pickInfo.textContent = highlightedCell ? 'Highlight: ' + highlightedCell : 'No selection';
    }

    function hasVisibleLayers() {
      if (!currentData || !currentData.layers) return false;
      return currentData.layers.some(function (layer) {
        return layerVisible[layer.name] !== false;
      });
    }

    function totalPhysicalStackHeight() {
      if (!currentData || !currentData.layers) return 1;
      return currentData.layers.reduce(function (total, layer) {
        var parallelSpecialMetal = parallelStackLayer(layer);
        return total + (auxiliaryLayer(layer) || parallelSpecialMetal ? 0 : layerThickness(layer));
      }, 0);
    }

    function stackHeight() {
      return Math.max(1, totalPhysicalStackHeight() * stackScale());
    }

    function setAllLayersVisible(visible) {
      if (!currentData) return;
      currentData.layers.forEach(function (layer) {
        layerVisible[layer.name] = visible;
      });
      buildDrawItems();
      setCellStats();
      updateLayerPanel();
      updateLegendPanel();
      requestDraw(false);
    }

    function rebuildLayerMeta() {
      layerMeta = {};
      var base = 0;
      var auxiliaryDepth = 0;
      currentData.layers.forEach(function (layer, index) {
        var copy = {};
        Object.keys(layer).forEach(function (key) { copy[key] = layer[key]; });
        var sourceColor = copy.sourceColor || copy.color || LAYER_COLORS[normalizedLayerName(layer.name)] || '#8ecae6';
        copy.index = index;
        copy.thickness = layerThickness(copy);
        copy.sourceColor = sourceColor;
        copy.color = resolvedFillColor(layer.name, sourceColor, copy);
        var parallelSpecialMetal = parallelStackLayer(copy);
        if (auxiliaryLayer(copy)) {
          copy.base = -(auxiliaryDepth + copy.thickness);
          auxiliaryDepth += copy.thickness * 0.14;
        } else if (parallelSpecialMetal) {
          copy.base = Math.max(0, base - copy.thickness);
        } else {
          copy.base = base;
          base += copy.thickness;
        }
        layerMeta[layer.name] = copy;
      });
    }

    function activateData(data, entry, updateUrl) {
      currentData = completeRoutingStack(data);
      highlightedCell = '';
      bounds = computeBounds(currentData);
      layerVisible = {};
      currentData.layers.forEach(function (layer) {
        layerVisible[layer.name] = !auxiliaryLayer(layer);
      });
      if (updateUrl) {
        var url = new URL(window.location.href);
        url.searchParams.set('library', currentData.library || entry.library || '');
        url.searchParams.set('cell', currentData.cell || entry.cell || '');
        url.searchParams.set('view', currentData.view || entry.view || 'layout');
        window.history.replaceState(null, '', url);
      }
      rebuildLayerMeta();
      updateHighlightOptions();
      updateLayerPanel();
      updateLegendPanel();
      fit();
      buildDrawItems();
      setCellStats();
      requestDraw(false);
      return true;
    }

    function loadCell(identity) {
      var entry = manifest.cells.filter(function (item) { return entryKey(item) === identity; })[0] || manifest.cells[0];
      if (!entry) throw codedError('E7002', 'No exported cells');
      var generation = ++loadGeneration;
      if (loadController) loadController.abort();
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      loadController = controller;
      return fetch(publicAssetUrl(entry.path), {
        cache: 'no-store',
        signal: controller ? controller.signal : undefined
      }).catch(function (error) {
        if (error && error.name === 'AbortError') throw error;
        throw codedError('E8006', 'Layout fetch failed for ' + entry.path + ': ' + error.message);
      }).then(function (res) {
        if (!res.ok) throw codedError('E8006', 'Layout fetch failed for ' + entry.path + ' (' + res.status + ')');
        return res.json().catch(function (error) {
          throw codedError('E8006', 'Layout JSON decode failed for ' + entry.path + ': ' + error.message);
        });
      }).then(function (data) {
        if (generation !== loadGeneration || (controller && controller.signal.aborted)) return false;
        return activateData(data, entry, true);
      }, function (error) {
        if (generation !== loadGeneration || (error && error.name === 'AbortError')) return false;
        throw error;
      }).then(function (result) {
        if (loadController === controller) loadController = null;
        return result;
      }, function (error) {
        if (loadController === controller) loadController = null;
        throw error;
      });
    }

    function loadLocalFile(file) {
      if (!file) return Promise.resolve(false);
      var generation = ++loadGeneration;
      cellStats.textContent = 'Opening ' + file.name;
      return file.arrayBuffer().then(function (buffer) {
        if (!/\.gz$/i.test(file.name)) return buffer;
        if (typeof DecompressionStream !== 'function') throw codedError('E8006', 'This browser cannot open gzip files directly');
        return new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      }).then(function (buffer) {
        if (generation !== loadGeneration) return false;
        var text = new TextDecoder().decode(new Uint8Array(buffer));
        var data;
        if (!/^\s*[\[{]/.test(text)) throw codedError('E8006', 'Expected VL3D JSON or JSON.GZ');
        try {
          data = JSON.parse(text);
        } catch (error) {
          throw codedError('E8006', 'Selected file is not valid JSON: ' + error.message);
        }
        return activateData(data, { library: '', cell: file.name, view: 'layout' }, false);
      }).catch(function (error) {
        if (errorDetails(error).code) throw error;
        throw codedError('E8006', 'Selected file could not be decoded: ' + error.message);
      });
    }

    function commitFallbackTransforms() {
      if (transformCommitTimer !== null) window.clearTimeout(transformCommitTimer);
      transformCommitTimer = null;
      rebuildLayerMeta();
      buildDrawItems();
      setCellStats();
      requestDraw(false);
    }

    function scheduleFallbackTransforms() {
      if (transformCommitTimer !== null) window.clearTimeout(transformCommitTimer);
      transformCommitTimer = window.setTimeout(commitFallbackTransforms, 200);
    }

    function fit() {
      zoom = demoMode ? 1.25 : 1;
      panX = 0;
      panY = demoMode ? -10 : 0;
      viewOffset = { x: 0, y: 0, z: 0 };
      angle = -0.72;
      pitch = 0.62;
    }

    function panAlongAxis(axis, sign, fast) {
      if (!bounds) return;
      var step = niceStep(bounds.radius / 24) * (fast ? 4 : 1);
      if (axis === 'x') viewOffset.x += sign * step;
      if (axis === 'y') viewOffset.y += sign * Math.max(0.2 * stackScale(), verticalUnit());
      if (axis === 'z') viewOffset.z += sign * step;
      autoRotate = false;
      requestDraw(true);
    }

    function showError(error) {
      if (!errorDetails(error).code) error = codedError('E9001', errorDetails(error).message);
      cellStats.textContent = 'Fallback load failed';
      renderErrorMessage(pickInfo, error);
      ctx.fillStyle = currentTheme().background;
      ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
      ctx.fillStyle = '#ef6351';
      ctx.font = '16px sans-serif';
      ctx.fillText(errorDetails(error).message, 32, 96);
    }

    function bind() {
      window.addEventListener('resize', resize);
      fitBtn.addEventListener('click', function () { fit(); buildDrawItems(); setCellStats(); requestDraw(false); });
      resetBtn.addEventListener('click', function () { fit(); buildDrawItems(); setCellStats(); requestDraw(false); });
      legendAllBtn.addEventListener('click', function () { setAllLayersVisible(true); });
      legendNoneBtn.addEventListener('click', function () { setAllLayersVisible(false); });
      [instancesToggle, wireToggle, alphaScale].forEach(function (el) {
        el.addEventListener('input', function () {
          rebuildLayerMeta();
          buildDrawItems();
          setCellStats();
          requestDraw(false);
        });
        el.addEventListener('change', function () {
          rebuildLayerMeta();
          buildDrawItems();
          setCellStats();
          requestDraw(false);
        });
      });
      [zScale].forEach(function (el) {
        el.addEventListener('input', function () {
          if (zScaleValue) zScaleValue.textContent = String(Number(zScale.value || 1)) + '×';
          scheduleFallbackTransforms();
        });
        el.addEventListener('change', commitFallbackTransforms);
      });
      themeSelect.addEventListener('change', function () {
        applyTheme();
        requestDraw(false);
      });
      if (paletteSelect) paletteSelect.addEventListener('change', function () {
        var name = selectedPaletteName();
        paletteSelect.value = name;
        try {
          localStorage.setItem(PALETTE_SETTINGS_KEY, name);
        } catch (error) {}
        var url = new URL(window.location.href);
        url.searchParams.set('palette', name);
        window.history.replaceState(null, '', url);
        if (!currentData) return;
        rebuildLayerMeta();
        buildDrawItems();
        updateLayerPanel();
        updateLegendPanel();
        setCellStats();
        requestDraw(false);
      });
      viaMerge.addEventListener('input', function () {
        updateViaMergeLabel(displayedConnectorCount, connectorCount);
      });
      viaMerge.addEventListener('change', function () {
        buildDrawItems();
        setCellStats();
        requestDraw(false);
      });
      openFileBtn.addEventListener('click', function () { fileInput.click(); });
      fileInput.addEventListener('change', function () { loadLocalFile(fileInput.files && fileInput.files[0]).catch(showError); });
      if (navigationModeSelect) navigationModeSelect.addEventListener('change', applyNavigationPreset);
      [invertOrbitXToggle, invertOrbitYToggle, invertPanToggle, invertWheelToggle].forEach(function (toggle) {
        if (toggle) toggle.addEventListener('change', applyNavigationOverrides);
      });
      window.addEventListener('dragover', function (event) { event.preventDefault(); });
      window.addEventListener('drop', function (event) {
        event.preventDefault();
        loadLocalFile(event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0]).catch(showError);
      });
      highlightSelect.addEventListener('change', function () {
        highlightedCell = highlightSelect.value;
        buildDrawItems();
        setCellStats();
        requestDraw(false);
      });
      canvas.addEventListener('contextmenu', function (event) { event.preventDefault(); });
      canvas.addEventListener('pointerdown', function (event) {
        if (event.button !== 0 && event.button !== 2) return;
        if (drag) return;
        event.preventDefault();
        autoRotate = false;
        pointerHeld = true;
        drag = {
          x: event.clientX,
          y: event.clientY,
          startX: event.clientX,
          startY: event.clientY,
          moved: false,
          pan: event.button === 2 || event.shiftKey,
          pointerId: event.pointerId
        };
        canvas.setPointerCapture && canvas.setPointerCapture(event.pointerId);
      });
      window.addEventListener('pointermove', function (event) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (!drag.moved) {
          var movedX = event.clientX - drag.startX;
          var movedY = event.clientY - drag.startY;
          var dragThreshold = event.pointerType === 'touch' ? 6 : 2;
          if (movedX * movedX + movedY * movedY <= dragThreshold * dragThreshold) return;
          drag.moved = true;
        }
        var dx = event.clientX - drag.x;
        var dy = event.clientY - drag.y;
        drag.x = event.clientX;
        drag.y = event.clientY;
        if (drag.pan) {
          var panDirection = navigationSettings.invertPan ? -1 : 1;
          panX += dx * panDirection;
          panY += dy * panDirection;
        } else {
          angle += dx * 0.006 * (navigationSettings.invertOrbitX ? -1 : 1);
          pitch = clamp(pitch + dy * 0.006 * (navigationSettings.invertOrbitY ? 1 : -1), -1.55, 1.55);
        }
        requestDraw(true);
      });
      window.addEventListener('pointerup', function (event) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        var moved = drag.moved;
        canvas.releasePointerCapture && canvas.releasePointerCapture(drag.pointerId);
        drag = null;
        pointerHeld = false;
        if (moved) requestDraw(true);
      });
      window.addEventListener('pointercancel', function (event) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        var moved = drag.moved;
        canvas.releasePointerCapture && canvas.releasePointerCapture(drag.pointerId);
        drag = null;
        pointerHeld = false;
        if (moved) requestDraw(true);
      });
      canvas.addEventListener('wheel', function (event) {
        event.preventDefault();
        autoRotate = false;
        var wheelUnit = event.deltaMode === 1 ? 16 : (event.deltaMode === 2 ? window.innerHeight : 1);
        var wheelDirection = navigationSettings.invertWheel ? -1 : 1;
        var wheelDelta = clamp(event.deltaY * wheelUnit, -240, 240);
        zoom = clamp(zoom * Math.exp(-wheelDelta * 0.001 * wheelDirection), 0.18, 12);
        requestDraw(true);
      }, { passive: false });
      window.addEventListener('keydown', function (event) {
        var tag = document.activeElement && document.activeElement.tagName || '';
        var sign = event.shiftKey ? -1 : 1;
        if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag)) return;
        if (event.code === 'KeyX') panAlongAxis('x', sign, event.altKey);
        else if (event.code === 'KeyY') panAlongAxis('y', sign, event.altKey);
        else if (event.code === 'KeyZ') panAlongAxis('z', sign, event.altKey);
        else if (event.code === 'ArrowLeft') panAlongAxis('x', -1, event.shiftKey);
        else if (event.code === 'ArrowRight') panAlongAxis('x', 1, event.shiftKey);
        else if (event.code === 'ArrowUp') panAlongAxis('z', 1, event.shiftKey);
        else if (event.code === 'ArrowDown') panAlongAxis('z', -1, event.shiftKey);
        else if (event.code === 'PageUp') panAlongAxis('y', 1, event.shiftKey);
        else if (event.code === 'PageDown') panAlongAxis('y', -1, event.shiftKey);
        else return;
        event.preventDefault();
      });
    }

    bind();
    resize();
    fetch(publicAssetUrl('data/manifest.json'), { cache: 'no-store' }).catch(function (error) {
      throw codedError('E8006', 'Layout manifest fetch failed: ' + error.message);
    }).then(function (res) {
      if (!res.ok) throw codedError('E8006', 'Layout manifest fetch failed (' + res.status + ')');
      return res.json().catch(function (error) {
        throw codedError('E7002', 'Layout manifest is not valid JSON: ' + error.message);
      });
    }).then(function (data) {
      if (!data || data.schemaVersion !== 2 || !Array.isArray(data.cells)) {
        throw codedError('E7002', 'Layout manifest must be a schema-v2 object with a cells array');
      }
      manifest = data;
      cellSelect.textContent = '';
      var placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Load a library or open JSON';
      cellSelect.append(placeholder);
      cellSelect.disabled = true;
      var requestedLibrary = params.get('library') || params.get('lib') || '';
      var requestedCell = params.get('cell') || '';
      var requestedView = params.get('view') || 'layout';
      var requested = requestedLibrary && requestedCell
        ? requestedLibrary + '/' + requestedCell + '/' + requestedView
        : '';
      var entry = manifest.cells.filter(function (candidate) { return entryKey(candidate) === requested; })[0];
      if (!entry) {
        cellStats.textContent = startupFailure
          ? '3D WebGL unavailable in this browser; open VL3D in Chromium'
          : 'Load a library or open layout JSON';
        pickInfo.textContent = startupFailure
          ? 'Compatibility mode · ' + startupFailure
          : 'Fallback renderer · no cached URL layout selected';
        return false;
      }
      (function () {
        var option = document.createElement('option');
        option.value = entryKey(entry);
        option.textContent = entry.cell + (entry.view !== 'layout' ? '/' + entry.view : '') + ' · cached';
        option.dataset.cell = entry.cell;
        cellSelect.append(option);
      }());
      cellSelect.value = requested;
      if (libraryLabel) {
        libraryLabel.textContent = requestedLibrary + ' · cached';
        libraryLabel.title = 'Cached layout selected from the URL';
        libraryLabel.classList.add('is-loaded');
      }
      return loadCell(requested);
    }).catch(showError);

    function tick() {
      if (!autoRotate) return;
      angle -= 0.0025;
      requestDraw(true);
      requestAnimationFrame(tick);
    }
    tick();
  }

  window.addEventListener('DOMContentLoaded', function () {
    window.setTimeout(startFallback, 3500);
  });
  window.addEventListener('vl3d-module-failed', startFallback);
  window.addEventListener('error', function () {
    window.setTimeout(startFallback, 0);
  }, true);
  window.addEventListener('unhandledrejection', function () {
    window.setTimeout(startFallback, 0);
  });
  window.__VL3D_MODULE_LOAD_PENDING = true;
  import(new URL('./viewer-next.js', fallbackScriptUrl).toString()).catch(recordModuleLoadFailure).then(function () {
    window.__VL3D_MODULE_LOAD_PENDING = false;
  });
})();
