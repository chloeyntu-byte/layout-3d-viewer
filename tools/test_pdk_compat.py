#!/usr/bin/env python3
"""Cross-process layer semantics regression test for convert_layout_tsv.py."""

from __future__ import print_function

import copy
import gzip
import importlib.util
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile


def run(command):
    completed = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        universal_newlines=True,
    )
    if completed.returncode != 0:
        sys.stdout.write(completed.stdout)
        sys.stderr.write(completed.stderr)
        raise RuntimeError("Command failed: %s" % " ".join(command))
    return completed


def run_failure(command, expected_message):
    completed = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        universal_newlines=True,
    )
    assert completed.returncode != 0, "command unexpectedly succeeded: %s" % " ".join(command)
    output = completed.stdout + completed.stderr
    assert expected_message in output, output
    return completed


def shape_record(owner, layer, index, purpose="drawing"):
    x1 = float(index * 2)
    y1 = float(index * 3)
    x2 = x1 + 1.0
    y2 = y1 + 1.0
    bbox = "%g,%g,%g,%g" % (x1, y1, x2, y2)
    points = "%g,%g;%g,%g;%g,%g;%g,%g" % (
        x1, y1, x2, y1, x2, y2, x1, y2
    )
    return "\t".join([
        "SHAPE", owner, owner, "rect", layer, purpose, "0",
        bbox, points, "net%d" % index, "",
    ])


def write_fixture(path, library, cell, technology, layers, schema=3):
    records = [
        "# vl3d_layout_tsv_v%d" % schema,
        "SCHEMA\t%d" % schema,
        "CELL\t%s\t%s\tlayout\t1000\t0,0,100,100" % (library, cell),
    ]
    if technology is not None:
        records.append("TECH\t%s" % technology)
    records.append("SOURCE\t%s\t%s\tlayout" % (library, cell))
    for index, layer_spec in enumerate(layers):
        if isinstance(layer_spec, (tuple, list)):
            layer, purpose = layer_spec
        else:
            layer, purpose = layer_spec, "drawing"
        records.append(shape_record(cell, layer, index, purpose))
    records.append("ENDCELL\t%s\t%s\tlayout\t%d" % (library, cell, len(layers)))
    with open(path, "w") as handle:
        handle.write("\n".join(records) + "\n")


def load_layout(path):
    with open(path, "r") as handle:
        payload = json.load(handle)
    with gzip.open(path + ".gz", "rt") as handle:
        compressed = json.load(handle)
    assert payload == compressed, "plain and gzip layout payloads differ"
    return payload


def layers_named(payload, name):
    normalized = name.upper()
    return [
        layer for layer in payload["layers"]
        if str(layer.get("name") or "").upper() == normalized
    ]


def layer_named(payload, name):
    matches = layers_named(payload, name)
    assert len(matches) == 1, "expected one %s layer, got %r" % (name, matches)
    return matches[0]


def assert_close(actual, expected, label):
    assert math.isclose(float(actual), float(expected), rel_tol=1e-9, abs_tol=1e-9), (
        "%s: expected %r, got %r" % (label, expected, actual)
    )


def assert_semantic(layer, semantic, routing=True):
    assert layer.get("semantic") == semantic, layer
    assert layer.get("routing") is routing, layer
    if routing:
        assert layer.get("defaultVisible", True) is True, layer


def assert_connector(layer, semantic, lower, upper):
    assert_semantic(layer, semantic)
    assert layer.get("lowerLayer") == lower["name"], layer
    assert layer.get("upperLayer") == upper["name"], layer


def assert_technology(payload, library, profile, unknown_layer, source="oa", version=3):
    technology = payload.get("technology")
    assert isinstance(technology, dict), technology
    assert technology.get("library") == library, technology
    assert technology.get("profile") == profile, technology
    assert technology.get("source") == source, technology
    assert technology.get("profileVersion") == version, technology
    assert len(technology.get("profileHash", "")) == 64, technology
    assert technology.get("profileSource"), technology
    assert isinstance(technology.get("observedLpps"), list), technology
    assert isinstance(technology.get("diagnostics"), list), technology
    diagnostic_codes = [item.get("code") for item in technology["diagnostics"]]
    assert "E5002" in diagnostic_codes, technology
    assert "E5003" in diagnostic_codes, technology
    unclassified = technology.get("unclassifiedLayers")
    assert isinstance(unclassified, list), technology
    assert unknown_layer.upper() in {
        str(item).upper() for item in unclassified
    }, technology


def assert_counts(payload, expected_routing_shapes):
    normalized_names = [str(layer.get("name") or "").upper() for layer in payload["layers"]]
    assert len(normalized_names) == len(set(normalized_names)), normalized_names
    assert sum(int(layer.get("shapeCount", 0)) for layer in payload["layers"]) == payload["shapeCount"]
    assert payload["exportStatus"]["routingShapesRetained"] == expected_routing_shapes


def validate_example(payload):
    assert_technology(payload, "example_process", "example-process", "ZZ_EXAMPLE_UNKNOWN", version=1)
    active = layer_named(payload, "AA")
    poly = layer_named(payload, "GT")
    contact = layer_named(payload, "CT")
    metal1 = layer_named(payload, "M1")
    metal2 = layer_named(payload, "M2")
    metal5 = layer_named(payload, "M5")
    metal6 = layer_named(payload, "M6")
    via1 = layer_named(payload, "V1")
    via5 = layer_named(payload, "V5")
    assert_semantic(active, "active", routing=False)
    assert active["defaultVisible"] is False
    assert active["shapeCount"] == 2, active
    assert_semantic(poly, "poly")
    assert_semantic(contact, "contact")
    assert contact.get("upperLayer") == metal1["name"], contact
    assert_semantic(metal1, "metal-1")
    assert metal1.get("metal") == 1, metal1
    assert metal1["shapeCount"] == 2, metal1
    assert_connector(via1, "via-1-2", metal1, metal2)
    assert_connector(via5, "via-5-6", metal5, metal6)
    for name in ("HRI", "RPO"):
        auxiliary = layer_named(payload, name)
        assert auxiliary.get("semantic") == "auxiliary", auxiliary
        assert auxiliary.get("routing") is False, auxiliary
        assert auxiliary.get("defaultVisible") is False, auxiliary
    unknown = layer_named(payload, "ZZ_EXAMPLE_UNKNOWN")
    assert unknown.get("routing") is False, unknown
    assert unknown.get("defaultVisible") is False, unknown
    assert_counts(payload, 9)


def validate_generic(payload):
    assert_technology(payload, "Acme130", "generic", "ZZ_GENERIC_UNKNOWN")
    active = layer_named(payload, "RX")
    poly = layer_named(payload, "GATE")
    contact = layer_named(payload, "CA")
    metal1 = layer_named(payload, "MET1")
    metal2 = layer_named(payload, "MET2")
    via1 = layer_named(payload, "VIA1")
    assert_semantic(active, "active", routing=False)
    assert active["defaultVisible"] is False
    assert_semantic(poly, "poly")
    assert_semantic(contact, "contact")
    assert contact.get("upperLayer") == metal1["name"], contact
    assert_semantic(metal1, "metal-1")
    assert_semantic(metal2, "metal-2")
    assert_connector(via1, "via-1-2", metal1, metal2)
    unknown = layer_named(payload, "ZZ_GENERIC_UNKNOWN")
    assert unknown.get("routing") is False, unknown
    assert unknown.get("defaultVisible") is False, unknown
    assert_counts(payload, 5)


def validate_exact_match_guard(payload, technology, high_metal):
    profile = payload["technology"]
    assert profile["library"] == technology, profile
    assert profile["profile"] == "generic", profile
    assert profile["profileMatch"] == "generic", profile
    assert "E5001" in [item["code"] for item in profile["diagnostics"]], profile
    assert_close(layer_named(payload, high_metal)["thickness"], 0.2,
                 "%s must not inherit an example-process profile" % technology)


def validate_generic_extended(payload):
    assert payload["technology"]["profile"] == "generic", payload["technology"]
    assert_semantic(layer_named(payload, "LI"), "local-interconnect")
    assert_semantic(layer_named(payload, "RDL"), "redistribution-layer")
    metal10 = layer_named(payload, "M10")
    metal11 = layer_named(payload, "M11")
    assert_connector(layer_named(payload, "VIA1011"), "via-10-11", metal10, metal11)


def write_json(path, payload):
    with open(path, "w") as handle:
        json.dump(payload, handle, sort_keys=True, indent=2)
        handle.write("\n")


def purpose_profile(profile_id="acme-purpose", version=1):
    return {
        "schemaVersion": 1,
        "id": profile_id,
        "version": version,
        "extends": "generic",
        "match": {
            "technologyLibraries": ["acmePurpose"],
            "aliases": ["acmePurposeAlias"],
            "designLibraries": [],
            "layerSignatures": [],
        },
        "preferences": {
            "metalPrefixes": ["M"],
            "viaPrefixes": ["VIA"],
            "contactLayers": ["CA"],
        },
        "defaults": {},
        "rules": [
            {
                "layers": ["X1"],
                "properties": {
                    "kind": "metal", "semantic": "custom-metal-1", "routing": True,
                    "defaultVisible": True, "metal": 1, "stackIndex": 3.0,
                    "thicknessUm": 0.4, "thicknessSource": "profile-explicit",
                    "zBottomUm": 1.0, "zTopUm": 1.4, "approximate": False,
                },
            },
            {
                "layers": ["X1"],
                "purposes": ["pin"],
                "properties": {
                    "semantic": "custom-pin-metal-1", "defaultVisible": False,
                },
            },
            {
                "layers": ["X2"],
                "properties": {
                    "kind": "metal", "semantic": "custom-metal-2", "routing": True,
                    "defaultVisible": True, "metal": 2, "stackIndex": 5.0,
                    "thicknessUm": 0.5, "thicknessSource": "profile-explicit",
                    "zBottomUm": 2.0, "zTopUm": 2.5, "approximate": False,
                },
            },
            {
                "layers": ["VX"],
                "properties": {
                    "kind": "via", "semantic": "custom-via", "routing": True,
                    "defaultVisible": True, "stackIndex": 4.0,
                    "lowerLayer": "X1", "upperLayer": "X2", "thicknessUm": 0.6,
                    "thicknessSource": "profile-explicit", "zBottomUm": 1.4,
                    "zTopUm": 2.0, "approximate": False,
                },
            },
        ],
        "auxiliary": {"layers": [], "suffixes": []},
    }


def validate_manual_profile(payload, profile_path):
    technology = payload["technology"]
    assert technology["profile"] == "acme-purpose", technology
    assert technology["profileMatch"] == "manual", technology
    assert technology["profileSource"] == "manual:%s" % os.path.abspath(profile_path), technology
    assert len(technology["profileHash"]) == 64, technology
    first = layer_named(payload, "X1")
    assert_semantic(first, "custom-metal-1")
    assert_close(first["zBottomUm"], 1.0, "custom X1 z bottom")
    assert_close(first["zTopUm"], 1.4, "custom X1 z top")
    assert first["geometryApproximate"] is False, first
    assert_connector(layer_named(payload, "VX"), "custom-via",
                     layer_named(payload, "X1"), layer_named(payload, "X2"))
    observed = dict(
        ((item["layer"], item["purpose"]), item)
        for item in technology["observedLpps"]
    )
    pin_lpp = observed[("X1", "pin")]
    assert pin_lpp["semantic"] == "custom-pin-metal-1", pin_lpp
    assert pin_lpp["defaultVisible"] is False, pin_lpp
    assert technology["approximateLayers"] == [], technology


def validate_legacy(payload):
    assert payload.get("sourceSchemaVersion") == 2, payload
    assert_technology(
        payload, "", "generic", "ZZ_V2_UNKNOWN", source="inferred"
    )
    assert_semantic(layer_named(payload, "AA"), "active", routing=False)
    assert_semantic(layer_named(payload, "GT"), "poly")
    assert_semantic(layer_named(payload, "CT"), "contact")
    assert_connector(
        layer_named(payload, "V1"),
        "via-1-2",
        layer_named(payload, "M1"),
        layer_named(payload, "M2"),
    )
    assert_counts(payload, 5)


def assert_stress_preserves_source_schema(repo, source):
    path = os.path.join(repo, "tools", "build_stress_layout.py")
    spec = importlib.util.spec_from_file_location("vl3d_build_stress", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    stress = module.build_layout(source, "fixture.json", "0" * 64)
    assert stress.get("sourceSchemaVersion") == source.get("sourceSchemaVersion"), stress
    pinned_source = copy.deepcopy(source)
    for index, name in enumerate(module.INTERFACES):
        pinned_source["pins"].append({
            "ownerCell": source["cell"],
            "hierPath": source["cell"],
            "terminal": name,
            "name": name,
            "net": name,
            "layer": "M6",
            "worldBBox": {"min": [index, 0], "max": [index + 0.5, 0.5]},
        })
    pinned_source["pinCount"] = len(pinned_source["pins"])
    pinned_stress = module.build_layout(pinned_source, "fixture.json", "1" * 64)
    occurrence = pinned_stress["cell"] + "/U00"
    pins = [pin for pin in pinned_stress["pins"] if pin.get("hierPath") == occurrence]
    assert len(pins) == len(module.INTERFACES), pins
    assert pinned_stress["stressSource"]["interfaces"]["occurrencePinCount"] == 0
    original_argv = sys.argv
    try:
        sys.argv = [path, "--dry-run"]
        args, _, _ = module.parse_args()
        assert args.backup is False, args
        sys.argv = [path, "--dry-run", "--backup"]
        args, _, _ = module.parse_args()
        assert args.backup is True, args
        sys.argv = [path, "--dry-run", "--no-backup"]
        args, _, _ = module.parse_args()
        assert args.backup is False, args
    finally:
        sys.argv = original_argv


def main():
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    converter = os.path.join(repo, "tools", "convert_layout_tsv.py")
    temporary = tempfile.mkdtemp(prefix="vl3d-pdk-test-")
    try:
        input_dir = os.path.join(temporary, "raw")
        output_dir = os.path.join(temporary, "data")
        os.makedirs(input_dir)
        os.makedirs(output_dir)
        fixtures = [
            (
                "example.tsv", "EXAMPLE_LIB", "EXAMPLE_CASE", "example_process",
                ["aa", "AA", "GT", "CT", "M1", "m1", "M2", "V1", "M5", "M6", "V5",
                 "HRI", "RPO", "ZZ_EXAMPLE_UNKNOWN"],
            ),
            (
                "generic.tsv", "WRAPPER_LIB", "GENERIC_CASE", "Acme130",
                ["RX", "GATE", "CA", "met1", "MET2", "VIA1", "ZZ_GENERIC_UNKNOWN"],
            ),
            (
                "legacy-v2.tsv", "LEGACY_LIB", "LEGACY_CASE", None,
                ["AA", "GT", "CT", "M1", "M2", "V1", "ZZ_V2_UNKNOWN"], 2,
            ),
            (
                "other28.tsv", "OTHER28_DESIGN", "OTHER28_CASE", "other_process28",
                ["POLY", "CONT", "METAL1", "METAL5"],
            ),
            (
                "other14.tsv", "OTHER14_DESIGN", "OTHER14_CASE", "other_process14",
                ["AA", "GT", "CT", "M1", "M6", "V1"],
            ),
            (
                "generic-extended.tsv", "GENERIC_EXT", "GENERIC_EXT_CASE", "Acme90",
                ["LI", "RDL", "M10", "M11", "VIA1011"],
            ),
        ]
        for fixture in fixtures:
            filename, library, cell, technology, layers = fixture[:5]
            schema = fixture[5] if len(fixture) > 5 else 3
            write_fixture(
                os.path.join(input_dir, filename), library, cell, technology, layers,
                schema=schema,
            )

        manifest = os.path.join(temporary, "manifest.json")
        completed = run([
            sys.executable, converter,
            "--input-dir", input_dir,
            "--output-dir", output_dir,
            "--manifest", manifest,
        ])
        assert "Converted 6 layout JSON file(s)" in completed.stdout, completed.stdout

        example = load_layout(os.path.join(output_dir, "EXAMPLE_LIB@EXAMPLE_CASE@layout.json"))
        validate_example(example)
        assert example.get("sourceSchemaVersion") == 3, example
        assert_stress_preserves_source_schema(repo, example)
        validate_generic(load_layout(os.path.join(output_dir, "WRAPPER_LIB@GENERIC_CASE@layout.json")))
        legacy = load_layout(os.path.join(output_dir, "LEGACY_LIB@LEGACY_CASE@layout.json"))
        validate_legacy(legacy)
        validate_exact_match_guard(
            load_layout(os.path.join(output_dir, "OTHER28_DESIGN@OTHER28_CASE@layout.json")),
            "other_process28", "METAL5",
        )
        validate_exact_match_guard(
            load_layout(os.path.join(output_dir, "OTHER14_DESIGN@OTHER14_CASE@layout.json")),
            "other_process14", "M6",
        )
        validate_generic_extended(load_layout(
            os.path.join(output_dir, "GENERIC_EXT@GENERIC_EXT_CASE@layout.json")
        ))

        with open(manifest, "r") as handle:
            manifest_payload = json.load(handle)
        assert len(manifest_payload.get("cells", [])) == 6, manifest_payload
        manifest_entries = {
            (entry["library"], entry["cell"]): entry
            for entry in manifest_payload["cells"]
        }
        example_entry = manifest_entries[("EXAMPLE_LIB", "EXAMPLE_CASE")]
        assert example_entry["sourceSchemaVersion"] == 3, example_entry
        assert example_entry["units"] == "um", example_entry
        assert example_entry["technology"]["profile"] == "example-process", example_entry
        assert example_entry["technology"]["profileHash"] == example["technology"]["profileHash"]
        legacy_entry = manifest_entries[("LEGACY_LIB", "LEGACY_CASE")]
        assert legacy_entry["technology"]["source"] == "inferred", legacy_entry

        custom_profiles = os.path.join(temporary, "custom-profiles")
        manual_input = os.path.join(temporary, "manual-raw")
        manual_output = os.path.join(temporary, "manual-data")
        alias_input = os.path.join(temporary, "alias-raw")
        alias_output = os.path.join(temporary, "alias-data")
        os.makedirs(custom_profiles)
        os.makedirs(manual_input)
        os.makedirs(manual_output)
        os.makedirs(alias_input)
        os.makedirs(alias_output)
        custom_profile_path = os.path.join(custom_profiles, "acme-purpose.json")
        write_json(custom_profile_path, purpose_profile())
        custom_layers = [
            ("X1", "drawing"), ("X1", "pin"), ("X2", "drawing"),
            ("VX", "drawing"),
        ]
        write_fixture(
            os.path.join(manual_input, "manual.tsv"), "MANUAL_LIB", "MANUAL_CASE",
            "UnrelatedPDK", custom_layers,
        )
        run([
            sys.executable, converter,
            "--input-dir", manual_input,
            "--output-dir", manual_output,
            "--manifest", os.path.join(temporary, "manual-manifest.json"),
            "--pdk-profile", custom_profile_path,
        ])
        manual = load_layout(os.path.join(
            manual_output, "MANUAL_LIB@MANUAL_CASE@layout.json"
        ))
        validate_manual_profile(manual, custom_profile_path)

        write_fixture(
            os.path.join(alias_input, "alias.tsv"), "ALIAS_LIB", "ALIAS_CASE",
            "acmePurposeAlias", custom_layers,
        )
        run([
            sys.executable, converter,
            "--input-dir", alias_input,
            "--output-dir", alias_output,
            "--manifest", os.path.join(temporary, "alias-manifest.json"),
            "--pdk-profile-dir", custom_profiles,
        ])
        alias = load_layout(os.path.join(alias_output, "ALIAS_LIB@ALIAS_CASE@layout.json"))
        assert alias["technology"]["profile"] == "acme-purpose", alias["technology"]
        assert alias["technology"]["profileMatch"] == "technology", alias["technology"]
        assert alias["technology"]["profileSource"].startswith("user-dir:"), alias["technology"]
        assert alias["technology"]["profileHash"] == manual["technology"]["profileHash"]

        override_profiles = os.path.join(temporary, "override-profiles")
        override_input = os.path.join(temporary, "override-raw")
        override_output = os.path.join(temporary, "override-data")
        os.makedirs(override_profiles)
        os.makedirs(override_input)
        os.makedirs(override_output)
        with open(os.path.join(repo, "profiles", "example-process.json"), "r") as handle:
            override_profile = json.load(handle)
        override_profile["version"] = 2
        override_profile.setdefault("rules", []).append({
            "layers": ["M6"],
            "properties": {
                "thicknessUm": 3.25,
                "thicknessSource": "user-override",
            },
        })
        write_json(os.path.join(override_profiles, "example-process.json"), override_profile)
        write_fixture(
            os.path.join(override_input, "override.tsv"), "OVERRIDE_LIB", "OVERRIDE_CASE",
            "example_process", ["M6"],
        )
        run([
            sys.executable, converter,
            "--input-dir", override_input,
            "--output-dir", override_output,
            "--manifest", os.path.join(temporary, "override-manifest.json"),
            "--pdk-profile-dir", override_profiles,
        ])
        override = load_layout(os.path.join(
            override_output, "OVERRIDE_LIB@OVERRIDE_CASE@layout.json"
        ))
        assert override["technology"]["profileVersion"] == 2, override["technology"]
        assert override["technology"]["profileSource"].startswith("user-dir:"), override["technology"]
        assert override["technology"]["profileHash"] != example["technology"]["profileHash"]
        assert_close(layer_named(override, "M6")["thickness"], 3.25,
                     "profile directory override thickness")

        invalid_profile = purpose_profile("invalid-profile")
        invalid_profile["rules"][0]["properties"]["unsupportedField"] = 1
        invalid_profile_path = os.path.join(temporary, "invalid-profile.json")
        write_json(invalid_profile_path, invalid_profile)
        run_failure([
            sys.executable, converter,
            "--input-dir", manual_input,
            "--output-dir", manual_output,
            "--manifest", os.path.join(temporary, "invalid-profile-manifest.json"),
            "--pdk-profile", invalid_profile_path,
        ], "E5005")

        invalid_dir = os.path.join(temporary, "invalid")
        invalid_output = os.path.join(temporary, "invalid-data")
        os.makedirs(invalid_dir)
        os.makedirs(invalid_output)
        write_fixture(
            os.path.join(invalid_dir, "unsupported.tsv"),
            "TEST_LIB", "SCHEMA99", None, ["M1"], schema=99,
        )
        run_failure([
            sys.executable, converter,
            "--input-dir", invalid_dir,
            "--output-dir", invalid_output,
            "--manifest", os.path.join(temporary, "invalid-manifest.json"),
        ], "Unsupported source schema version 99")

        os.remove(os.path.join(invalid_dir, "unsupported.tsv"))
        write_fixture(
            os.path.join(invalid_dir, "v2-tech.tsv"),
            "TEST_LIB", "V2_TECH", "example-process", ["M1"], schema=2,
        )
        run_failure([
            sys.executable, converter,
            "--input-dir", invalid_dir,
            "--output-dir", invalid_output,
            "--manifest", os.path.join(temporary, "invalid-manifest.json"),
        ], "TECH requires source schema version 3")
        print("PASS: schema 2/3 contract and cross-process layer semantics")
    finally:
        shutil.rmtree(temporary)


if __name__ == "__main__":
    main()
