#!/usr/bin/env python3
"""Load and apply compact VL3D PDK profile v1 files."""

from __future__ import print_function

import hashlib
import json
import math
import os
import re


PROFILE_SCHEMA_VERSION = 1
MAX_PROFILE_BYTES = 1024 * 1024
MAX_PROFILE_FILES = 64
SAFE_ID = re.compile(r"^[A-Za-z0-9_.:+-]+$")
# Layer purpose is part of the identity: M1/dummy is not M1/drawing.
# Use a bounded deny-list; unfamiliar drawing purposes may be real masks.
NON_CONDUCTIVE_PURPOSES = frozenset((
    "label", "text", "textdisplay", "annotation", "annotate", "drawingtext",
    "dummy", "odummy", "dmy", "fill", "fillblock", "fillblockage", "slot", "slotting",
    "marker", "mark", "boundary", "border", "netboundary", "blockage",
    "keepout", "exclude", "exclusion", "density", "error", "warning", "flight",
))
NON_CONDUCTIVE_LAYER_NAMES = frozenset((
    "DIFF", "DIFFUSION", "OD", "ACTIVE", "ACT", "AA", "RX", "COMP",
    "SUBSTRATE", "SUB", "PW", "NW", "PWELL", "NWELL", "DNW", "DNWELL",
    "NWEL", "PWEL", "NPLUS", "PPLUS", "NIMP", "PIMP", "NSD", "PSD",
    "HRP", "MIM", "SAB", "SN", "SP", "RFDEV", "RFMOSD", "INSTANCE",
    "HRI", "RPO", "NTN", "PRBOUNDARY", "TEXT", "ANNOTATE",
))


def is_non_conductive_purpose(purpose):
    token = re.sub(r"[\s_-]+", "", str(purpose or "").strip().lower())
    return token in NON_CONDUCTIVE_PURPOSES or bool(re.match(
        r"^(?:dummy|odummy|dmy|fill|slot|marker|label|text)[0-9]+$", token))


# These names are markers in the generic profile, but some technologies use
# them for actual capacitor electrodes or resistive conductors. Only explicit
# conductor metadata may override their generic meaning.
AMBIGUOUS_AUXILIARY_LAYER_NAMES = frozenset(("HRP", "MIM", "SAB", "HRI", "RPO", "NTN"))


def is_hard_non_conductive_layer_name(layer):
    name = str(layer or "").strip().upper()
    return (name in NON_CONDUCTIVE_LAYER_NAMES - AMBIGUOUS_AUXILIARY_LAYER_NAMES
            or name.endswith((
                "WELL", "TXT", "TEXT", "DUMMY", "DUM", "DMY", "SLOT", "FILL", "MARK",
                "BOUND", "BOUNDARY", "BORDER", "_PIN", "_LABEL",
            )))


def is_non_conductive_layer_name(layer, explicit_conductor=False):
    name = str(layer or "").strip().upper()
    return (is_hard_non_conductive_layer_name(name)
            or (name in AMBIGUOUS_AUXILIARY_LAYER_NAMES and not explicit_conductor))


KINDS = set(("active", "poly", "contact", "metal", "via", "substrate", "auxiliary", "other"))
ROOT_KEYS = set((
    "schemaVersion", "id", "version", "extends", "match", "preferences",
    "defaults", "rules", "auxiliary", "streamLayers",
))
MATCH_KEYS = set((
    "technologyLibraries", "aliases", "designLibraries", "layerSignatures",
))
PREFERENCE_KEYS = set(("metalPrefixes", "viaPrefixes", "contactLayers"))
PROPERTY_KEYS = set((
    "kind", "semantic", "routing", "defaultVisible", "metal", "lowerMetal",
    "upperMetal", "lowerLayer", "upperLayer", "lowerLayers", "stackIndex",
    "thicknessUm", "thicknessSource", "zBottomUm", "zTopUm", "approximate",
))
STREAM_LAYER_KEYS = PROPERTY_KEYS | set(("name", "purpose", "color"))
STREAM_LAYER_KEY = re.compile(r"^[0-9]+(?:[/:][0-9]+)?$")


class ProfileError(RuntimeError):
    pass


def _fail(code, message):
    raise ProfileError("%s %s" % (code, message))


def _normalized_name(value):
    return str(value or "").strip().upper()


def _normalized_purpose(value):
    return str(value or "drawing").strip().lower()


def _string_list(value, label, maximum=256):
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > maximum:
        _fail("E5005", "%s must be a list with at most %d entries" % (label, maximum))
    result = []
    for item in value:
        if not isinstance(item, str) or not item.strip() or len(item) > 256:
            _fail("E5005", "%s contains an invalid string" % label)
        result.append(item.strip())
    return result


def _number(value, label, positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail("E5005", "%s must be a finite number" % label)
    number = float(value)
    if not math.isfinite(number) or (positive and number <= 0.0):
        _fail("E5005", "%s must be %sfinite" % (label, "positive and " if positive else ""))
    return number


def _validate_properties(properties, label):
    if not isinstance(properties, dict):
        _fail("E5005", "%s properties must be an object" % label)
    unknown = sorted(set(properties.keys()) - PROPERTY_KEYS)
    if unknown:
        _fail("E5005", "%s has unsupported properties: %s" % (label, ", ".join(unknown)))
    if "kind" in properties and properties["kind"] not in KINDS:
        _fail("E5005", "%s kind is invalid" % label)
    if "semantic" in properties:
        if not isinstance(properties["semantic"], str) or not properties["semantic"].strip():
            _fail("E5005", "%s semantic must be a non-empty string" % label)
    for key in ("routing", "defaultVisible", "approximate"):
        if key in properties and not isinstance(properties[key], bool):
            _fail("E5005", "%s %s must be boolean" % (label, key))
    for key in ("metal", "lowerMetal", "upperMetal"):
        if key in properties:
            value = properties[key]
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                _fail("E5005", "%s %s must be a non-negative integer" % (label, key))
    for key in ("stackIndex", "zBottomUm", "zTopUm"):
        if key in properties:
            _number(properties[key], "%s %s" % (label, key))
    if "thicknessUm" in properties:
        _number(properties["thicknessUm"], "%s thicknessUm" % label, positive=True)
    for key in ("lowerLayer", "upperLayer", "thicknessSource"):
        if key in properties:
            if not isinstance(properties[key], str) or not properties[key].strip():
                _fail("E5005", "%s %s must be a non-empty string" % (label, key))
    if "lowerLayers" in properties:
        _string_list(properties["lowerLayers"], "%s lowerLayers" % label)
    if "zBottomUm" in properties and "zTopUm" in properties:
        if float(properties["zTopUm"]) <= float(properties["zBottomUm"]):
            _fail("E5005", "%s zTopUm must be greater than zBottomUm" % label)
    if all(key in properties for key in ("zBottomUm", "zTopUm", "thicknessUm")):
        span = float(properties["zTopUm"]) - float(properties["zBottomUm"])
        if abs(span - float(properties["thicknessUm"])) > 1e-9:
            _fail("E5005", "%s z span and thicknessUm disagree" % label)


def _validate_stream_layers(value, profile_id):
    if value is None:
        return
    if not isinstance(value, dict) or len(value) > 512:
        _fail("E5005", "%s streamLayers must be an object with at most 512 entries" % profile_id)
    for key, entry in value.items():
        label = "%s streamLayers.%s" % (profile_id, key)
        if not isinstance(key, str) or not STREAM_LAYER_KEY.match(key):
            _fail("E5005", "%s has an invalid layer/datatype key" % label)
        if entry is None:
            continue
        if isinstance(entry, str):
            if not entry.strip():
                _fail("E5005", "%s must not be empty" % label)
            continue
        if not isinstance(entry, dict):
            _fail("E5005", "%s must be a string, object, or null" % label)
        unknown = sorted(set(entry.keys()) - STREAM_LAYER_KEYS)
        if unknown:
            _fail("E5005", "%s has unsupported properties: %s" % (label, ", ".join(unknown)))
        for field in ("name", "purpose", "color"):
            if field in entry and (not isinstance(entry[field], str) or not entry[field].strip()):
                _fail("E5005", "%s %s must be a non-empty string" % (label, field))
        properties = dict((key, item) for key, item in entry.items() if key in PROPERTY_KEYS)
        _validate_properties(properties, label)


def _validate_profile(data, path):
    if not isinstance(data, dict):
        _fail("E5005", "Profile must contain a JSON object: %s" % path)
    unknown = sorted(set(data.keys()) - ROOT_KEYS)
    if unknown:
        _fail("E5005", "Profile has unsupported keys %s: %s" % (", ".join(unknown), path))
    if data.get("schemaVersion") != PROFILE_SCHEMA_VERSION:
        _fail("E5005", "Unsupported profile schemaVersion in %s" % path)
    profile_id = data.get("id")
    if not isinstance(profile_id, str) or not SAFE_ID.match(profile_id):
        _fail("E5005", "Profile id is invalid in %s" % path)
    version = data.get("version")
    if isinstance(version, bool) or not isinstance(version, int) or version <= 0:
        _fail("E5005", "Profile version must be a positive integer in %s" % path)
    extends = data.get("extends")
    if extends not in (None, "generic"):
        _fail("E5005", "Profile extends must be generic or omitted in %s" % path)
    match = data.get("match", {})
    if not isinstance(match, dict):
        _fail("E5005", "Profile match must be an object in %s" % path)
    unknown_match = sorted(set(match.keys()) - MATCH_KEYS)
    if unknown_match:
        _fail("E5005", "Profile match has unsupported keys in %s" % path)
    for key in ("technologyLibraries", "aliases", "designLibraries"):
        _string_list(match.get(key), "%s match.%s" % (profile_id, key))
    signatures = match.get("layerSignatures", [])
    if not isinstance(signatures, list) or len(signatures) > 32:
        _fail("E5005", "%s match.layerSignatures is invalid" % profile_id)
    for index, signature in enumerate(signatures):
        if not isinstance(signature, dict):
            _fail("E5005", "%s layer signature %d must be an object" % (profile_id, index))
        if set(signature.keys()) - set(("allLayers", "anyLayers", "anyLayerGroups")):
            _fail("E5005", "%s layer signature %d has unsupported keys" % (profile_id, index))
        _string_list(signature.get("allLayers"), "%s signature allLayers" % profile_id)
        _string_list(signature.get("anyLayers"), "%s signature anyLayers" % profile_id)
        groups = signature.get("anyLayerGroups", [])
        if not isinstance(groups, list) or len(groups) > 32:
            _fail("E5005", "%s signature anyLayerGroups is invalid" % profile_id)
        for group in groups:
            _string_list(group, "%s signature anyLayerGroups entry" % profile_id)
    preferences = data.get("preferences", {})
    if not isinstance(preferences, dict) or set(preferences.keys()) - PREFERENCE_KEYS:
        _fail("E5005", "%s preferences are invalid" % profile_id)
    for key in PREFERENCE_KEYS:
        _string_list(preferences.get(key), "%s preferences.%s" % (profile_id, key))
    _validate_stream_layers(data.get("streamLayers"), profile_id)
    _validate_properties(data.get("defaults", {}), "%s defaults" % profile_id)
    rules = data.get("rules", [])
    if not isinstance(rules, list) or len(rules) > 512:
        _fail("E5005", "%s rules must be a list with at most 512 entries" % profile_id)
    for index, rule in enumerate(rules):
        label = "%s rule %d" % (profile_id, index)
        if not isinstance(rule, dict) or set(rule.keys()) - set(
                ("layers", "prefixes", "suffixes", "purposes", "properties")):
            _fail("E5005", "%s selector is invalid" % label)
        layers = _string_list(rule.get("layers"), "%s layers" % label)
        prefixes = _string_list(rule.get("prefixes"), "%s prefixes" % label)
        suffixes = _string_list(rule.get("suffixes"), "%s suffixes" % label)
        if not layers and not prefixes and not suffixes:
            _fail("E5005", "%s must select at least one layer" % label)
        _string_list(rule.get("purposes"), "%s purposes" % label)
        _validate_properties(rule.get("properties", {}), label)
    auxiliary = data.get("auxiliary", {})
    if not isinstance(auxiliary, dict) or set(auxiliary.keys()) - set(("layers", "suffixes")):
        _fail("E5005", "%s auxiliary rules are invalid" % profile_id)
    _string_list(auxiliary.get("layers"), "%s auxiliary.layers" % profile_id)
    _string_list(auxiliary.get("suffixes"), "%s auxiliary.suffixes" % profile_id)


def _load_profile(path, source_label, precedence):
    try:
        metadata = os.stat(path)
    except OSError as error:
        _fail("E5008", "Cannot read profile %s: %s" % (path, error))
    if not os.path.isfile(path) or metadata.st_size > MAX_PROFILE_BYTES:
        _fail("E5008", "Profile must be a regular file no larger than %d bytes: %s" %
              (MAX_PROFILE_BYTES, path))
    try:
        with open(path, "r") as handle:
            data = json.load(handle)
    except (IOError, OSError, ValueError) as error:
        _fail("E5005", "Cannot parse profile %s: %s" % (path, error))
    _validate_profile(data, path)
    canonical = json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    data["_profileHash"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    data["_profileSource"] = source_label
    data["_precedence"] = precedence
    return data


def _profile_files(directory):
    if not os.path.isdir(directory):
        _fail("E5008", "Profile directory does not exist: %s" % directory)
    names = sorted(name for name in os.listdir(directory) if name.endswith(".json"))
    if len(names) > MAX_PROFILE_FILES:
        _fail("E5008", "Profile directory has more than %d JSON files: %s" %
              (MAX_PROFILE_FILES, directory))
    return [os.path.join(directory, name) for name in names]


def load_registry(profile_dirs=None, explicit_profile=None, builtin_dir=None):
    if builtin_dir is None:
        builtin_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "profiles")
    profiles = {}
    precedence = 0
    for path in _profile_files(builtin_dir):
        profile = _load_profile(path, "builtin:%s" % os.path.basename(path), precedence)
        profiles[profile["id"]] = profile
        precedence += 1
    if "generic" not in profiles:
        _fail("E9002", "Built-in generic profile is missing")
    for directory in profile_dirs or []:
        absolute = os.path.abspath(os.path.expanduser(directory))
        for path in _profile_files(absolute):
            profile = _load_profile(path, "user-dir:%s" % os.path.abspath(path), precedence)
            profiles[profile["id"]] = profile
            precedence += 1
    forced_profile_id = None
    if explicit_profile:
        absolute = os.path.abspath(os.path.expanduser(explicit_profile))
        profile = _load_profile(absolute, "manual:%s" % absolute, precedence)
        profiles[profile["id"]] = profile
        forced_profile_id = profile["id"]
    return {"profiles": profiles, "forcedProfileId": forced_profile_id}


def _exact_values(profile, key):
    match = profile.get("match", {})
    return set(str(item).strip().lower() for item in match.get(key, []))


def _signature_score(profile, layer_names):
    names = set(_normalized_name(name) for name in layer_names)
    best = 0
    for signature in profile.get("match", {}).get("layerSignatures", []):
        all_layers = set(_normalized_name(name) for name in signature.get("allLayers", []))
        any_layers = set(_normalized_name(name) for name in signature.get("anyLayers", []))
        groups = [set(_normalized_name(name) for name in group)
                  for group in signature.get("anyLayerGroups", [])]
        if not all_layers.issubset(names):
            continue
        if any_layers and not any_layers.intersection(names):
            continue
        if any(group and not group.intersection(names) for group in groups):
            continue
        score = len(all_layers) * 4 + len(groups) * 2 + (1 if any_layers else 0)
        best = max(best, score)
    return best


def select_profile(registry, technology_library, design_library, layer_names):
    profiles = registry["profiles"]
    forced = registry.get("forcedProfileId")
    diagnostics = []
    if forced:
        return profiles[forced], "manual", diagnostics
    technology = str(technology_library or "").strip().lower()
    candidates = []
    if technology:
        for profile in profiles.values():
            names = _exact_values(profile, "technologyLibraries") | _exact_values(profile, "aliases")
            if technology in names:
                candidates.append(profile)
        if candidates:
            selected = sorted(candidates, key=lambda item: item["_precedence"])[-1]
            if len(candidates) > 1:
                diagnostics.append({
                    "code": "E5009", "severity": "warning",
                    "message": "Multiple exact technology matchers found; highest-precedence profile selected",
                })
            return selected, "technology", diagnostics
        diagnostics.append({
            "code": "E5001", "severity": "warning",
            "message": "No exact PDK profile matched technology library %s; generic profile selected" %
                       technology_library,
        })
        return profiles["generic"], "generic", diagnostics
    design = str(design_library or "").strip().lower()
    if design:
        candidates = [profile for profile in profiles.values()
                      if design in _exact_values(profile, "designLibraries")]
        if candidates:
            selected = sorted(candidates, key=lambda item: item["_precedence"])[-1]
            diagnostics.append({
                "code": "E5007", "severity": "warning",
                "message": "PDK profile inferred from an exact design-library matcher",
            })
            return selected, "design-library", diagnostics
    scored = []
    for profile in profiles.values():
        if profile["id"] == "generic":
            continue
        score = _signature_score(profile, layer_names)
        if score:
            scored.append((score, profile["_precedence"], profile))
    if scored:
        scored.sort(key=lambda item: (item[0], item[1]))
        diagnostics.append({
            "code": "E5007", "severity": "warning",
            "message": "PDK profile inferred from the observed layer signature",
        })
        return scored[-1][2], "layer-signature", diagnostics
    diagnostics.append({
        "code": "E5001", "severity": "warning",
        "message": "No PDK identity or layer signature matched; generic profile selected",
    })
    return profiles["generic"], "generic", diagnostics


def metal_number_from_name(layer):
    match = re.match(r"^(?:METAL|MET|M)[_-]?([0-9]+)$", _normalized_name(layer))
    return int(match.group(1)) if match else None


def via_pair_from_name(layer):
    name = _normalized_name(layer)
    match = re.match(r"^(?:VIA|V)[_-]?([0-9]+)[_-]([0-9]+)$", name)
    if match:
        return (int(match.group(1)), int(match.group(2)))
    match = re.match(r"^VIA[_-]?([0-9]+)$", name)
    if match:
        digits = match.group(1)
        adjacent = []
        for index in range(1, len(digits)):
            lower = int(digits[:index])
            upper = int(digits[index:])
            if upper == lower + 1:
                adjacent.append((lower, upper))
        if len(adjacent) == 1:
            return adjacent[0]
        lower = int(digits)
        return (lower, lower + 1) if len(digits) <= 2 else None
    match = re.match(r"^V[_-]?([0-9]+)$", name)
    if match:
        lower = int(match.group(1))
        return (lower, lower + 1)
    return None


def _apply_auxiliary(profile, info, name):
    auxiliary = profile.get("auxiliary", {})
    layers = set(_normalized_name(item) for item in auxiliary.get("layers", []))
    suffixes = tuple(_normalized_name(item) for item in auxiliary.get("suffixes", []))
    if name in layers or (suffixes and name.endswith(suffixes)):
        info.update({
            "kind": "auxiliary", "semantic": "auxiliary", "routing": False,
            "defaultVisible": False, "stackIndex": -3.0, "approximate": False,
        })


def _apply_rules(profile, info, name, purpose):
    for rule in profile.get("rules", []):
        layers = set(_normalized_name(item) for item in rule.get("layers", []))
        prefixes = tuple(_normalized_name(item) for item in rule.get("prefixes", []))
        suffixes = tuple(_normalized_name(item) for item in rule.get("suffixes", []))
        if name not in layers and not (prefixes and name.startswith(prefixes)) and not (
                suffixes and name.endswith(suffixes)):
            continue
        purposes = set(_normalized_purpose(item) for item in rule.get("purposes", []))
        if purposes and purpose not in purposes:
            continue
        info.update(rule.get("properties", {}))


def _apply_technology_layer(info, evidence):
    """Apply one observed OA layer, without interpreting layer IDs as heights.

    Unknown material is absence of evidence, not a non-conductor declaration.
    Callers may supply a verified display order / metal ordinal derived from
    actual technology data. Those fields never prove electrical connectivity.
    """
    if evidence is None:
        return
    if not isinstance(evidence, dict):
        _fail("E5005", "Observed technology layer must be an object")
    material = str(evidence.get("material") or "unknown").strip().lower()
    source = str(evidence.get("source") or "oa-tech-layer")
    info["technologyMaterial"] = material
    if material == "conflict":
        for field in ("metal", "lowerMetal", "upperMetal", "lowerLayer", "upperLayer", "lowerLayers", "upperLayers"):
            info.pop(field, None)
        info.update(kind="other", semantic="conflicting-technology", routing=False,
                    defaultVisible=False, stackIndex=-4.0, classificationSource=source)
        return
    conductive = {"metal": "metal", "poly": "poly", "cut": "via"}
    excluded = {
        "ndiff": "active", "pdiff": "active", "diff": "active", "diffusion": "active",
        "active": "active", "nwell": "substrate", "pwell": "substrate", "well": "substrate",
        "substrate": "substrate", "implant": "auxiliary", "nimplant": "auxiliary",
        "pimplant": "auxiliary", "nplus": "auxiliary", "pplus": "auxiliary",
        "recognition": "auxiliary", "drill": "auxiliary", "wirebond": "auxiliary",
        "dielectric": "auxiliary", "oxide": "auxiliary",
    }
    kind = conductive.get(material) or excluded.get(material)
    if kind:
        previous_kind = info.get("kind")
        if material == "cut" and previous_kind == "contact":
            kind = "contact"
        routing = material in conductive
        visible = info.get("defaultVisible", routing) if previous_kind == kind and info.get("routing") == routing else routing
        if previous_kind != kind:
            for field in ("metal", "lowerMetal", "upperMetal", "lowerLayer", "upperLayer", "lowerLayers", "upperLayers"):
                info.pop(field, None)
        semantic = info.get("semantic") if previous_kind == kind and info.get("semantic") not in (None, "unknown") else kind
        info.update(kind=kind, semantic=semantic, routing=routing, defaultVisible=visible,
                    classificationSource=source)
    if info.get("routing"):
        index = evidence.get("stackIndex")
        if isinstance(index, (int, float)) and not isinstance(index, bool) and math.isfinite(index):
            info["stackIndex"] = float(index)
            info["stackIndexSource"] = str(evidence.get("stackSource") or source)
            if evidence.get("stackSource"):
                info["stackSource"] = str(evidence["stackSource"])
        ordinal = evidence.get("metal")
        if info.get("kind") == "metal" and isinstance(ordinal, int) and not isinstance(ordinal, bool) and ordinal >= 0:
            info["metal"] = ordinal


def classify_layer(registry, selected_profile, layer, purpose=None, technology_layer=None):
    name = _normalized_name(layer)
    normalized_purpose = _normalized_purpose(purpose)
    generic = registry["profiles"]["generic"]
    info = dict(generic.get("defaults", {}))
    _apply_auxiliary(generic, info, name)
    _apply_rules(generic, info, name, normalized_purpose)
    metal = metal_number_from_name(name)
    pair = via_pair_from_name(name)
    if metal is not None and info.get("semantic") == "unknown":
        info.update({
            "kind": "metal", "semantic": "metal-%d" % metal, "routing": True,
            "defaultVisible": True, "stackIndex": 2.0 * metal + 1.0,
            "metal": metal, "approximate": True,
        })
    elif pair is not None and info.get("semantic") == "unknown":
        lower, upper = pair
        info.update({
            "kind": "via", "semantic": "via-%d-%d" % (lower, upper),
            "routing": True, "defaultVisible": True,
            "stackIndex": 2.0 * lower + 2.0, "lowerMetal": lower,
            "upperMetal": upper, "thicknessUm": 0.1,
            "thicknessSource": "generic-fallback", "approximate": True,
        })
    if selected_profile["id"] != "generic":
        info.update(selected_profile.get("defaults", {}))
        _apply_auxiliary(selected_profile, info, name)
        _apply_rules(selected_profile, info, name, normalized_purpose)
    _apply_technology_layer(info, technology_layer)
    if is_hard_non_conductive_layer_name(name):
        if info.get("kind") in ("metal", "poly", "via", "contact"):
            info.update(kind="auxiliary", semantic="non-conductive-layer")
        info.update(routing=False, defaultVisible=False)
    if is_non_conductive_purpose(normalized_purpose):
        info.update({
            "kind": "auxiliary", "semantic": "non-conductive-purpose",
            "routing": False, "defaultVisible": False,
        })
    return info


def profile_preferences(registry, selected_profile):
    generic = registry["profiles"]["generic"].get("preferences", {})
    result = dict((key, list(value)) for key, value in generic.items())
    result.update(dict((key, list(value))
                       for key, value in selected_profile.get("preferences", {}).items()))
    return result
