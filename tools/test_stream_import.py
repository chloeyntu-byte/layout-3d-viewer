#!/usr/bin/env python3
"""Synthetic GDSII/OASIS regression test for import_stream_layout.py."""

from __future__ import print_function

import argparse
import gzip
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile


FIXTURE_PYTHON = r'''import gdstk
import sys

library = gdstk.Library("FIXTURE", unit=1e-6, precision=1e-9)
top = library.new_cell("TOP")
child = library.new_cell("CHILD")
grand = library.new_cell("GRAND")
unused = library.new_cell("UNUSED")
top.add(gdstk.rectangle((0, 0), (0.5, 0.4), layer=1, datatype=0))
child.add(gdstk.Polygon([
    (0, 0), (0.7, 0), (0.5, 0.6), (0, 0.5)
], layer=2, datatype=7))
grand.add(gdstk.FlexPath([
    (0, 0), (0.6, 0), (0.6, 0.4)
], 0.1, layer=3, datatype=4))
unused.add(gdstk.rectangle((10, 10), (11, 11), layer=9, datatype=0))
child.add(gdstk.Reference(grand, origin=(0.2, 0.8)))
top.add(gdstk.Reference(child, origin=(1, 2), columns=2, rows=1, spacing=(2, 0)))
library.write_gds(sys.argv[1])
library.write_oas(sys.argv[2])

def write_layers(path, cell_name, pairs):
    mapped = gdstk.Library("FIXTURE", unit=1e-6, precision=1e-9)
    cell = mapped.new_cell(cell_name)
    for index, pair in enumerate(pairs):
        x = float(index % 8) * 2.0
        y = float(index // 8) * 2.0
        cell.add(gdstk.rectangle((x, y), (x + 1.0, y + 1.0), layer=pair[0], datatype=pair[1]))
    mapped.write_gds(path)

EXAMPLE_PAIRS = [
    (1, 0), (2, 0), (3, 0), (11, 0), (12, 0), (13, 0), (14, 0), (15, 0), (16, 0),
    (31, 0), (32, 0), (33, 0), (34, 0), (35, 0),
]

if len(sys.argv) > 3:
    write_layers(sys.argv[3], "EXAMPLE_AUTO", EXAMPLE_PAIRS)
    write_layers(sys.argv[4], "NUMERIC_ONLY", EXAMPLE_PAIRS)
    write_layers(sys.argv[5], "BOTH_PATH", EXAMPLE_PAIRS)
    write_layers(sys.argv[6], "PATH_HINT", [(11, 0), (31, 0)])
print("FIXTURE_OK")
'''


def run(command):
    completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    if completed.returncode != 0:
        sys.stdout.write(completed.stdout)
        sys.stderr.write(completed.stderr)
        raise RuntimeError("Command failed: %s" % " ".join(command))
    return completed


def run_failure(command, expected_text):
    completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    assert completed.returncode != 0, "Command unexpectedly succeeded: %s" % " ".join(command)
    combined = completed.stdout + completed.stderr
    assert expected_text in combined, combined
    return completed


def load_with_gzip(path):
    with open(path, "r") as handle:
        plain = json.load(handle)
    with gzip.open(path + ".gz", "rt") as handle:
        compressed = json.load(handle)
    assert plain == compressed
    return plain


def load_importer(path):
    specification = importlib.util.spec_from_file_location("vl3d_stream_importer", path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def assert_failure(callback, expected_text):
    try:
        callback()
    except Exception as error:
        assert expected_text in str(error), str(error)
        return
    raise AssertionError("Operation unexpectedly succeeded")


def validate_preflight(importer, temporary):
    importer.validate_stream_path("layout.GDS.GZ")
    importer.validate_stream_path("layout.oasis")
    assert_failure(lambda: importer.validate_stream_path("layout.json"), "GDSII or OASIS")
    assert_failure(lambda: importer.rd("bad", "one\ntwo"), "cannot contain newlines")

    generic = importer.validate_layer_map(None)
    assert generic == {"provided": False, "sourceFile": "", "entryCount": 0, "sha256": ""}
    generic_technology = importer.stream_technology_metadata(generic)
    assert generic_technology["profile"] == "generic-stream"
    assert generic_technology["source"] == "stream-geometry"
    assert generic_technology["semantics"] == "geometry-only"

    layer_map_path = os.path.join(temporary, "preflight-layers.json")
    with open(layer_map_path, "w") as handle:
        json.dump({"1/0": "METAL1", "2/0": {"name": "METAL2", "kind": "metal"}}, handle)
    mapped = importer.validate_layer_map(layer_map_path)
    assert mapped["provided"] is True
    assert mapped["sourceFile"] == "preflight-layers.json"
    assert mapped["entryCount"] == 2
    assert len(mapped["sha256"]) == 64
    mapped_technology = importer.stream_technology_metadata(mapped)
    assert mapped_technology["profile"] == "stream-layer-map"
    assert mapped_technology["source"] == "layer-map"
    assert mapped_technology["semantics"] == "layer-map"

    invalid_map_path = os.path.join(temporary, "invalid-layers.json")
    with open(invalid_map_path, "w") as handle:
        json.dump(["not", "an", "object"], handle)
    assert_failure(lambda: importer.validate_layer_map(invalid_map_path), "JSON object")
    with open(invalid_map_path, "w") as handle:
        json.dump({"1/0": 7}, handle)
    assert_failure(lambda: importer.validate_layer_map(invalid_map_path), "string or JSON object")
    with open(invalid_map_path, "w") as handle:
        json.dump({"1/0": {"routing": "false"}}, handle)
    assert_failure(lambda: importer.validate_layer_map(invalid_map_path), "must be boolean")
    with open(invalid_map_path, "w") as handle:
        json.dump({"1/0": None}, handle)
    assert importer.validate_layer_map(invalid_map_path)["entryCount"] == 1


def validate_builtin_stream_profiles(importer):
    profiles = dict((item["id"], item) for item in importer._builtin_stream_profiles())
    assert "example-process" in profiles, sorted(profiles)

    example = profiles["example-process"]["mapping"]
    assert example["1/0"]["name"] == "ACT"
    assert example["11/0"]["name"] == "M1"
    assert example["16/0"]["name"] == "M6"
    assert example["16/0"]["thicknessUm"] == 2.0
    assert example["35/0"]["name"] == "V5"

    def physical_stack(mapping):
        base = 0.0
        result = {}
        entries = [entry for entry in mapping.values()
                   if isinstance(entry, dict) and (entry.get("routing") is True or entry.get("kind") == "active")]
        for entry in sorted(entries, key=lambda item: float(item["stackIndex"])):
            thickness = float(entry["thicknessUm"])
            bottom = base
            base += thickness
            result[entry["name"]] = (bottom, bottom + thickness)
        return result

    stack = physical_stack(example)
    expected_stack = {"M1": (0.5, 0.8), "M5": (2.5, 3.4), "V5": (3.4, 3.6), "M6": (3.6, 5.6)}
    for name, expected in expected_stack.items():
        assert all(abs(value - target) < 1e-9 for value, target in zip(stack[name], expected)), (name, stack)


def validate_layout(payload, source_format, mapped, expected_parser):
    assert payload["schemaVersion"] == 2
    assert payload["sourceFormat"] == source_format
    assert payload["cell"] == "TOP"
    assert payload["shapeCount"] == 5, payload["shapeCount"]
    assert payload["instanceCount"] == 4, payload["instanceCount"]
    assert payload["maxShapeDepth"] == 2
    assert payload["maxInstanceDepth"] == 2
    assert payload["pins"] == [] and payload["connections"] == []
    assert payload["pinCount"] == 0 and payload["connectionCount"] == 0
    assert payload["netlistStatus"]["available"] is False
    assert payload["units"] == "um"
    shape_types = {shape["type"] for shape in payload["shapes"]}
    if expected_parser == "gdstk":
        assert shape_types == {"box", "polygon"}, shape_types
    else:
        assert shape_types == {"box", "polygon", "path"}, shape_types
    assert payload["exportStatus"]["parser"] == expected_parser
    assert {(shape["layerNumber"], shape["datatype"]) for shape in payload["shapes"]} == {
        (1, 0), (2, 7), (3, 4)
    }
    assert len({instance["hierPath"] for instance in payload["instances"]}) == 4
    assert all(instance["hierPath"].startswith("TOP/") for instance in payload["instances"])
    assert all(shape["net"] == "" for shape in payload["shapes"])
    if mapped:
        assert payload["technology"]["profile"] == "stream-layer-map"
        assert payload["technology"]["source"] == "layer-map"
        assert payload["technology"]["layerMap"]["sourceFile"] == "layers.json"
        assert payload["technology"]["unclassifiedLayers"] == []
        assert payload["warnings"] == []
        assert {layer["name"] for layer in payload["layers"]} == {"METAL1", "METAL2", "VIA12"}
        assert all(layer["stackIndexSource"] == "layer-map" for layer in payload["layers"])
        via = next(layer for layer in payload["layers"] if layer["name"] == "VIA12")
        assert via["kind"] == "via" and via["lowerLayer"] == "METAL1"
    else:
        assert payload["technology"]["profile"] == "generic-stream"
        assert payload["technology"]["source"] == "stream-geometry"
        assert payload["technology"]["semantics"] == "geometry-only"
        assert set(payload["technology"]["unclassifiedLayers"]) == {"L1_D0", "L2_D7", "L3_D4"}
        assert payload["warnings"][0]["code"] == "stream-generic-geometry"
        assert {layer["name"] for layer in payload["layers"]} == {"L1_D0", "L2_D7", "L3_D4"}
        assert [layer["stackIndex"] for layer in payload["layers"]] == [0, 1, 2]
        assert all(layer["stackIndexSource"] == "stable-layer-datatype-order" for layer in payload["layers"])
        assert all(layer["defaultVisible"] is False for layer in payload["layers"])
        assert all(layer["approximate"] is True for layer in payload["layers"])
        assert payload["technology"]["stackAccuracy"] == "approximate"
        assert payload["technology"]["signoffSuitable"] is False


def runtime_python():
    data_home = os.environ.get("XDG_DATA_HOME") or os.path.join(
        os.path.expanduser("~"), ".local", "share",
    )
    candidates = [
        os.environ.get("VL3D_PYTHON"),
        os.environ.get("VL3D_NATIVE_PYTHON"),
        os.path.join(data_home, "vl3d", "native-venv", "bin", "python"),
        sys.executable,
    ]
    checked = set()
    for candidate in candidates:
        if not candidate or candidate in checked:
            continue
        checked.add(candidate)
        try:
            probe = subprocess.run(
                [candidate, "-c", "import gdstk"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True,
            )
        except OSError:
            continue
        if probe.returncode == 0:
            return candidate
    raise RuntimeError(
        "VL3D-E6007: gdstk is unavailable; run `npm run setup:native` "
        "or set VL3D_PYTHON/VL3D_NATIVE_PYTHON"
    )


def make_gdstk_fixture(python, temporary, gds, oas, extra_paths):
    fixture_script = os.path.join(temporary, "fixture.py")
    with open(fixture_script, "w") as handle:
        handle.write(FIXTURE_PYTHON)
    fixture = run([python, fixture_script, gds, oas] + list(extra_paths))
    assert "FIXTURE_OK" in fixture.stdout
    assert os.path.isfile(gds) and os.path.isfile(oas)


def validate_klayout_fallback(python, importer, klayout, gds, oas, temporary):
    if not klayout:
        print("SKIP: KLayout fallback was not explicitly requested")
        return
    if not os.path.isfile(klayout) or not os.access(klayout, os.X_OK):
        raise RuntimeError("KLayout not executable: %s" % klayout)
    for source in (gds, oas):
        output = os.path.join(temporary, "klayout-" + os.path.basename(source) + ".json")
        completed = subprocess.run([
            python, importer, source, "--output", output,
            "--library", "TEST_KLAYOUT", "--top", "TOP",
            "--parser", "klayout", "--klayout", klayout,
        ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        combined = completed.stdout + completed.stderr
        if completed.returncode != 0 and (
                "Unable to load plugin" in combined
                or "No reader available" in combined
                or "Cannot determine format" in combined):
            print("SKIP: KLayout stream plugins are incomplete: %s" % klayout)
            return
        if completed.returncode != 0:
            sys.stdout.write(completed.stdout)
            sys.stderr.write(completed.stderr)
            raise RuntimeError("KLayout fallback failed: %s" % source)
        validate_layout(
            load_with_gzip(output), "GDSII" if source == gds else "OASIS", False, "klayout",
        )
    print("PASS: explicit KLayout compatibility fallback")


def validate_automatic_profiles(python, importer, sources, temporary):
    auto_source, numeric_source, both_source, hint_source = sources
    output = os.path.join(temporary, "example-auto.json")
    run([python, importer, auto_source, "--output", output, "--top", "EXAMPLE_AUTO", "--parser", "gdstk"])
    layout = load_with_gzip(output)
    technology = layout["technology"]
    assert technology["profile"] == "example-process", technology
    assert technology["profileMatch"] == "builtin-stream-auto", technology
    assert technology["streamProfileDetection"]["source"] == "builtin", technology
    assert technology["mappedLayerCount"] == 14, technology
    assert technology["streamProfileDetection"]["confidence"] == "high", technology
    assert "pdk-profile-inferred" in [item["code"] for item in layout["warnings"]]
    layers = dict((layer["name"], layer) for layer in layout["layers"])
    assert layers["M6"]["layerNumber"] == 16
    assert layers["M6"]["datatype"] == 0
    assert layers["M6"]["stackIndex"] == 13.0
    assert layers["M6"]["thickness"] == 2.0
    assert layers["V5"]["lowerLayer"] == "M5"

    external_directory = os.path.join(temporary, "site-profiles")
    os.mkdir(external_directory)
    builtin_profile_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(importer))), "profiles", "example-process.json",
    )
    with open(builtin_profile_path, "r") as handle:
        external_profile = json.load(handle)
    external_profile["id"] = "site-example-process"
    with open(os.path.join(external_directory, "site-example-process.json"), "w") as handle:
        json.dump(external_profile, handle)
    external_output = os.path.join(temporary, "external-priority.json")
    run([
        python, importer, auto_source, "--output", external_output,
        "--top", "EXAMPLE_AUTO", "--parser", "gdstk",
        "--pdk-profile-dir", external_directory,
    ])
    external = load_with_gzip(external_output)
    assert external["technology"]["profile"] == "site-example-process", external["technology"]
    assert external["technology"]["profileMatch"] == "external-stream-auto", external["technology"]
    assert external["technology"]["streamProfileDetection"]["source"] == "external"

    # Numeric layer IDs alone never identify a process.
    unconfirmed_output = os.path.join(temporary, "unconfirmed-profile.json")
    run([
        python, importer, numeric_source, "--output", unconfirmed_output,
        "--top", "NUMERIC_ONLY", "--parser", "gdstk",
    ])
    unconfirmed = load_with_gzip(unconfirmed_output)
    detection = unconfirmed["technology"]["streamProfileDetection"]
    assert unconfirmed["technology"]["profile"] == "generic-stream", unconfirmed["technology"]
    assert detection["status"] == "unconfirmed", detection
    assert detection["candidates"] == ["example-process"], detection
    assert "stream-profile-unconfirmed" in [item["code"] for item in unconfirmed["warnings"]]

    # A path naming two different processes is ambiguous.
    second_directory = os.path.join(temporary, "second-profiles")
    os.mkdir(second_directory)
    second_profile = dict(external_profile)
    second_profile["id"] = "another-process"
    second_profile["match"] = dict(external_profile["match"], technologyLibraries=["another_process"])
    with open(os.path.join(second_directory, "another-process.json"), "w") as handle:
        json.dump(second_profile, handle)
    ambiguous_output = os.path.join(temporary, "ambiguous-profile.json")
    run([
        python, importer, both_source, "--output", ambiguous_output,
        "--top", "BOTH_PATH", "--parser", "gdstk",
        "--pdk-profile-dir", second_directory,
    ])
    ambiguous = load_with_gzip(ambiguous_output)
    detection = ambiguous["technology"]["streamProfileDetection"]
    assert ambiguous["technology"]["profile"] == "generic-stream", ambiguous["technology"]
    assert detection["status"] == "ambiguous", detection
    assert detection["candidates"] == ["another-process", "example-process"], detection
    assert "stream-profile-ambiguous" in [item["code"] for item in ambiguous["warnings"]]

    hint_output = os.path.join(temporary, "path-hint-profile.json")
    run([
        python, importer, hint_source, "--output", hint_output,
        "--top", "PATH_HINT", "--parser", "gdstk",
    ])
    hint = load_with_gzip(hint_output)
    assert hint["technology"]["profile"] == "example-process", hint["technology"]
    assert hint["technology"]["streamProfileDetection"]["evidence"]["pathAlias"] is True
    hint_layers = dict((layer["name"], layer) for layer in hint["layers"])
    assert hint_layers["M1"]["zBottomUm"] == 0.5, hint_layers
    assert hint_layers["M1"]["zTopUm"] == 0.8, hint_layers
    assert hint_layers["V1"]["zBottomUm"] == 0.8, hint_layers
    print("PASS: unique stream profile inference, physical metadata, path hint, and ambiguity guard")


def main():
    arguments = argparse.ArgumentParser()
    arguments.add_argument("--preflight-only", action="store_true")
    args = arguments.parse_args()
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    importer = os.path.join(repo, "tools", "import_stream_layout.py")
    temporary = tempfile.mkdtemp(prefix="vl3d-stream-test-")
    try:
        importer_module = load_importer(importer)
        validate_preflight(importer_module, temporary)
        validate_builtin_stream_profiles(importer_module)
        print("PASS: stream importer preflight metadata and guards")
        if args.preflight_only:
            return

        python = runtime_python()
        gds = os.path.join(temporary, "fixture.gds")
        oas = os.path.join(temporary, "fixture.oas")
        example_auto = os.path.join(temporary, "auto-example_process.gds")
        numeric_auto = os.path.join(temporary, "auto-numeric.gds")
        both_dir = os.path.join(temporary, "example_process_vs_another_process")
        os.makedirs(both_dir)
        both_auto = os.path.join(both_dir, "both.gds")
        hint_dir = os.path.join(temporary, "example_process")
        os.makedirs(hint_dir)
        path_hint = os.path.join(hint_dir, "small.gds")
        make_gdstk_fixture(
            python, temporary, gds, oas,
            (example_auto, numeric_auto, both_auto, path_hint),
        )

        layer_map_path = os.path.join(temporary, "layers.json")
        with open(layer_map_path, "w") as handle:
            json.dump({
                "1/0": {"name": "METAL1", "kind": "metal", "stackIndex": 3, "thickness": 0.2},
                "2/7": {"name": "METAL2", "kind": "metal", "stackIndex": 5, "thickness": 0.2},
                "3/4": {
                    "name": "VIA12", "kind": "via", "stackIndex": 4, "thickness": 0.1,
                    "lowerLayer": "METAL1", "upperLayer": "METAL2"
                },
            }, handle)

        manifest = os.path.join(temporary, "manifest.json")
        gds_json = os.path.join(temporary, "gds.json")
        oas_json = os.path.join(temporary, "oas.json")
        single_json = os.path.join(temporary, "single.json")
        conflict_json = os.path.join(temporary, "conflict.json")
        stale_json = os.path.join(temporary, "stale.json")
        run_failure([
            python, importer, gds, "--output", conflict_json, "--library", "TEST_CONFLICT",
            "--top", "TOP", "--manifest", conflict_json, "--parser", "gdstk"
        ], "must not refer to the same")
        run_failure([
            python, importer, gds, "--output", conflict_json, "--library", "TEST_BAD_BIN",
            "--top", "TOP", "--parser", "klayout",
            "--klayout", os.path.join(temporary, "missing-klayout")
        ], "--klayout executable not found")
        multi_top = run_failure([
            python, importer, gds, "--output", conflict_json, "--parser", "gdstk"
        ], "VL3D-E6002")
        marker_line = next(
            line for line in multi_top.stderr.splitlines() if line.startswith("VL3D_IMPORT_ERROR ")
        )
        marker = json.loads(marker_line.split(" ", 1)[1])
        assert marker["details"]["topCells"] == ["TOP", "UNUSED"]
        with open(stale_json + ".gz", "wb") as handle:
            handle.write(b"stale")
        run_failure([
            python, importer, gds, "--output", stale_json, "--library", "TEST_STALE",
            "--top", "TOP", "--parser", "gdstk"
        ], "Output already exists")
        run([
            python, importer, gds, "--output", gds_json, "--library", "TEST_GDS",
            "--top", "TOP", "--layer-map", layer_map_path, "--parser", "gdstk",
            "--manifest", manifest, "--manifest-prefix", "data"
        ])
        run([
            python, importer, oas, "--output", oas_json, "--library", "TEST_OAS",
            "--top", "TOP", "--parser", "gdstk",
            "--manifest", manifest, "--manifest-prefix", "data"
        ])
        run([
            python, importer, oas, "--output", single_json, "--library", "TEST_SINGLE",
            "--top", "TOP", "--parser", "gdstk"
        ])

        validate_layout(load_with_gzip(gds_json), "GDSII", True, "gdstk")
        validate_layout(load_with_gzip(oas_json), "OASIS", False, "gdstk")
        validate_layout(load_with_gzip(single_json), "OASIS", False, "gdstk")
        validate_automatic_profiles(
            python, importer, (example_auto, numeric_auto, both_auto, path_hint), temporary,
        )
        manifest_payload = load_with_gzip(manifest)
        assert [cell["library"] for cell in manifest_payload["cells"]] == ["TEST_GDS", "TEST_OAS"]
        assert manifest_payload["cells"][0]["path"] == "data/gds.json"
        assert any(name.startswith("manifest.json.bak-") for name in os.listdir(temporary))
        changed = os.path.join(temporary, "changed.gds")
        shutil.copyfile(gds, changed)
        snapshot = importer_module.source_snapshot(changed)
        with open(changed, "ab") as handle:
            handle.write(b"changed")
        try:
            importer_module.assert_source_unchanged(changed, snapshot)
        except importer_module.StreamImportError as error:
            assert error.code == "E6008"
        else:
            raise AssertionError("Changed source was not detected")
        validate_klayout_fallback(
            python, importer, os.environ.get("KLAYOUT_BIN"), gds, oas, temporary,
        )
        print("PASS: gdstk GDS/OAS, hierarchy, multi-top, gzip, mapping, manifest, and guards")
    finally:
        shutil.rmtree(temporary)


if __name__ == "__main__":
    main()
