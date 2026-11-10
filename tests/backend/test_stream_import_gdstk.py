#!/usr/bin/env python3
"""Regression coverage for the gdstk-first VL3D importer."""

from __future__ import print_function

import gzip
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile


def load_importer(path):
    specification = importlib.util.spec_from_file_location("vl3d_stream_importer", path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def run(command, expected=0):
    completed = subprocess.run(
        command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True,
    )
    if completed.returncode != expected:
        raise AssertionError(
            "Expected exit %d, got %d\nstdout:\n%s\nstderr:\n%s"
            % (expected, completed.returncode, completed.stdout, completed.stderr)
        )
    return completed


def payload(path):
    with open(path, "r") as handle:
        plain = json.load(handle)
    with gzip.open(path + ".gz", "rt") as handle:
        compressed = json.load(handle)
    assert plain == compressed
    return plain


def shape_union(layout):
    boxes = [shape["bbox"] for shape in layout["shapes"]]
    return {
        "min": [min(box["min"][0] for box in boxes), min(box["min"][1] for box in boxes)],
        "max": [max(box["max"][0] for box in boxes), max(box["max"][1] for box in boxes)],
    }


def main():
    try:
        import gdstk
    except Exception as error:
        if os.environ.get("VL3D_REQUIRE_GDSTK") == "1":
            raise
        print("SKIP: gdstk is not installed (%s)" % error)
        return

    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    importer_path = os.path.join(root, "tools", "import_stream_layout.py")
    importer = load_importer(importer_path)
    temporary = tempfile.mkdtemp(prefix="vl3d-gdstk-regression-")
    try:
        library = gdstk.Library("FIXTURE", unit=1e-6, precision=1e-9)
        grand = library.new_cell("GRAND")
        grand.add(gdstk.Polygon([(0, 0), (2, 0), (1, 1)], layer=3, datatype=4))
        child = library.new_cell("CHILD")
        child.add(gdstk.rectangle((0, 0), (4, 2), layer=2, datatype=7))
        child.add(gdstk.Reference(grand, origin=(1, 3), rotation=0.25))
        top_a = library.new_cell("TOP_A")
        top_a.add(gdstk.rectangle((-1, -1), (1, 1), layer=1, datatype=0))
        top_a.add(gdstk.Reference(child, origin=(10, 20)))
        top_a.add(gdstk.Reference(child, origin=(30, 5), columns=2, rows=1, spacing=(8, 0)))
        top_b = library.new_cell("TOP_B")
        top_b.add(gdstk.rectangle((100, 100), (105, 107), layer=9, datatype=1))

        gds = os.path.join(temporary, "fixture.gds")
        oas = os.path.join(temporary, "fixture.oas")
        library.write_gds(gds)
        library.write_oas(oas)

        ambiguous = run([
            sys.executable, importer_path, gds,
            "--output", os.path.join(temporary, "ambiguous.json"), "--parser", "gdstk",
        ], expected=2)
        marker_line = next(
            line for line in ambiguous.stderr.splitlines() if line.startswith("VL3D_IMPORT_ERROR ")
        )
        marker = json.loads(marker_line.split(" ", 1)[1])
        assert marker["code"] == "VL3D-E6002"
        assert marker["details"]["topCells"] == ["TOP_A", "TOP_B"]

        layer_map_path = os.path.join(temporary, "layers.json")
        with open(layer_map_path, "w") as handle:
            json.dump({
                "1/0": {"name": "M1", "kind": "metal", "stackIndex": 3},
                "2/7": {"name": "M2", "kind": "metal", "stackIndex": 5},
                "3/4": {
                    "name": "VIA12", "kind": "via", "stackIndex": 4,
                    "lowerLayer": "M1", "upperLayer": "M2",
                },
            }, handle)

        for source in (gds, oas):
            output = os.path.join(temporary, os.path.basename(source) + ".json")
            result = run([
                sys.executable, importer_path, source, "--output", output,
                "--library", "REGRESSION", "--top", "TOP_A", "--parser", "gdstk",
                "--layer-map", layer_map_path,
            ])
            assert "VL3D_IMPORT_OK" in result.stdout
            layout = payload(output)
            assert layout["shapeCount"] == 7
            assert layout["instanceCount"] == 6
            assert layout["maxShapeDepth"] == 2
            assert layout["maxInstanceDepth"] == 2
            assert layout["pins"] == [] and layout["connections"] == []
            assert layout["netlistStatus"]["available"] is False
            assert layout["exportStatus"]["parser"] == "gdstk"
            assert layout["technology"]["mappedLayerCount"] == 3
            assert all(layer["routing"] is True for layer in layout["layers"])
            assert all(layer["defaultVisible"] is True for layer in layout["layers"])
            assert shape_union(layout) == layout["bbox"]
            assert any(instance["master"]["cell"] == "CHILD" for instance in layout["instances"])
            assert any(instance["master"]["cell"] == "GRAND" for instance in layout["instances"])

        assert importer.RESOURCE_PRESETS == {
            "low": {"maxDepth": 6, "maxShapes": 100000},
            "balanced": {"maxDepth": 8, "maxShapes": 200000},
            "large": {"maxDepth": 16, "maxShapes": 1000000},
        }
        portable_library = gdstk.Library("PORTABLE", unit=1e-6, precision=1e-9)
        portable_top = portable_library.new_cell("PORTABLE_TOP")
        portable_pairs = [(101, 1), (205, 2), (333, 3), (444, 4)]
        for index, (layer_number, datatype) in enumerate(portable_pairs):
            portable_top.add(gdstk.rectangle(
                (index * 2, 0), (index * 2 + 1, 1), layer=layer_number, datatype=datatype,
            ))
        portable_gds = os.path.join(temporary, "portable-unknown-pdk.gds")
        portable_library.write_gds(portable_gds)

        generic_output = os.path.join(temporary, "portable-generic.json")
        run([
            sys.executable, importer_path, portable_gds, "--output", generic_output,
            "--parser", "gdstk", "--resource-mode", "low",
        ])
        generic = payload(generic_output)
        assert generic["shapeCount"] == 4
        assert generic["technology"]["profile"] == "generic-stream"
        assert generic["technology"]["stackAccuracy"] == "approximate"
        assert generic["technology"]["signoffSuitable"] is False
        assert all(layer["defaultVisible"] is False for layer in generic["layers"])
        assert all(layer["approximate"] is True for layer in generic["layers"])
        assert [layer["stackIndex"] for layer in generic["layers"]] == [0, 1, 2, 3]
        assert [layer["zBottomUm"] for layer in generic["layers"]] == [0.0, 0.25, 0.5, 0.75]
        assert "non-signoff" in generic["warnings"][0]["message"]
        assert generic["exportStatus"]["resourceMode"] == "low"
        assert generic["exportStatus"]["maxDepthRequested"] == 6
        assert generic["exportStatus"]["maxShapesRequested"] == 100000
        assert generic["exportStatus"]["complete"] is True

        limited_output = os.path.join(temporary, "portable-limited.json")
        run([
            sys.executable, importer_path, portable_gds, "--output", limited_output,
            "--parser", "gdstk", "--resource-mode", "balanced", "--max-shapes", "2",
        ])
        limited = payload(limited_output)
        assert limited["shapeCount"] == 2
        assert limited["exportStatus"]["truncated"] is True
        assert limited["exportStatus"]["complete"] is False
        assert limited["exportStatus"]["truncationReasons"] == ["shape-limit"]
        assert any(warning["code"] == "stream-shape-limit" for warning in limited["warnings"])

        depth_output = os.path.join(temporary, "portable-depth.json")
        run([
            sys.executable, importer_path, gds, "--output", depth_output,
            "--top", "TOP_A", "--parser", "gdstk", "--max-depth", "0",
        ])
        depth_limited = payload(depth_output)
        assert depth_limited["exportStatus"]["depthLimited"] is True
        assert "hierarchy-depth-limit" in depth_limited["exportStatus"]["truncationReasons"]
        assert any(warning["code"] == "stream-depth-limit" for warning in depth_limited["warnings"])

        profile_directory = os.path.join(temporary, "external-profiles")
        os.mkdir(profile_directory)
        external_profile_path = os.path.join(profile_directory, "portable.json")
        with open(external_profile_path, "w") as handle:
            json.dump({
                "schemaVersion": 1,
                "id": "portable-external",
                "match": {"aliases": ["portable_unknown"]},
                "streamLayers": {
                    "101/1": {"name": "PX_M1", "kind": "metal", "routing": True, "stackIndex": 1},
                    "205/2": {"name": "PX_V12", "kind": "via", "routing": True, "stackIndex": 2},
                    "333/3": {"name": "PX_M2", "kind": "metal", "routing": True, "stackIndex": 3},
                    "444/4": {"name": "PX_M3", "kind": "metal", "routing": True, "stackIndex": 4},
                },
            }, handle)
        external_output = os.path.join(temporary, "portable-external.json")
        run([
            sys.executable, importer_path, portable_gds, "--output", external_output,
            "--parser", "gdstk", "--pdk-profile-dir", profile_directory,
        ])
        external = payload(external_output)
        assert external["technology"]["profile"] == "portable-external"
        assert external["technology"]["profileMatch"] == "external-stream-auto"
        assert external["technology"]["streamProfileDetection"]["source"] == "external"
        assert external["technology"]["pdkProfile"]["sourceKind"] == "external"
        assert {layer["name"] for layer in external["layers"]} == {
            "PX_M1", "PX_V12", "PX_M2", "PX_M3",
        }

        ambiguous_profile_directory = os.path.join(temporary, "ambiguous-external-profiles")
        os.mkdir(ambiguous_profile_directory)
        with open(external_profile_path, "r") as handle:
            ambiguous_profile = json.load(handle)
        for identifier in ("portable-external-a", "portable-external-b"):
            candidate = dict(ambiguous_profile)
            candidate["id"] = identifier
            with open(os.path.join(ambiguous_profile_directory, identifier + ".json"), "w") as handle:
                json.dump(candidate, handle)
        ambiguous_external_output = os.path.join(temporary, "portable-external-ambiguous.json")
        run([
            sys.executable, importer_path, portable_gds, "--output", ambiguous_external_output,
            "--parser", "gdstk", "--pdk-profile-dir", ambiguous_profile_directory,
        ])
        ambiguous_external = payload(ambiguous_external_output)
        assert ambiguous_external["technology"]["profile"] == "generic-stream"
        assert ambiguous_external["technology"]["streamProfileDetection"]["status"] == "ambiguous"
        assert ambiguous_external["technology"]["streamProfileDetection"]["source"] == "external"
        assert any(
            warning["code"] == "stream-profile-ambiguous"
            for warning in ambiguous_external["warnings"]
        )

        explicit_profile_path = os.path.join(temporary, "explicit-profile.json")
        with open(explicit_profile_path, "w") as handle:
            json.dump({
                "schemaVersion": 1, "id": "portable-explicit",
                "streamLayers": {
                    "101/1": {"name": "EXPLICIT_M1", "kind": "metal", "routing": True},
                },
            }, handle)
        explicit_output = os.path.join(temporary, "portable-explicit.json")
        run([
            sys.executable, importer_path, portable_gds, "--output", explicit_output,
            "--parser", "gdstk", "--pdk-profile", explicit_profile_path,
            "--pdk-profile-dir", profile_directory,
        ])
        explicit = payload(explicit_output)
        assert explicit["technology"]["profile"] == "portable-explicit"
        assert explicit["technology"]["pdkProfile"]["selection"] == "explicit"
        assert "EXPLICIT_M1" in {layer["name"] for layer in explicit["layers"]}

        linked_directory = os.path.join(temporary, "linked-profiles")
        os.symlink(profile_directory, linked_directory)
        unsafe = run([
            sys.executable, importer_path, portable_gds,
            "--output", os.path.join(temporary, "unsafe-directory.json"),
            "--parser", "gdstk", "--pdk-profile-dir", linked_directory,
        ], expected=2)
        unsafe_marker = json.loads(next(
            line.split(" ", 1)[1] for line in unsafe.stderr.splitlines()
            if line.startswith("VL3D_IMPORT_ERROR ")
        ))
        assert unsafe_marker["code"] == "VL3D-E5008"

        unsafe_profile_directory = os.path.join(temporary, "unsafe-profile-files")
        os.mkdir(unsafe_profile_directory)
        os.symlink(external_profile_path, os.path.join(unsafe_profile_directory, "linked.json"))
        unsafe_file = run([
            sys.executable, importer_path, portable_gds,
            "--output", os.path.join(temporary, "unsafe-file.json"),
            "--parser", "gdstk", "--pdk-profile-dir", unsafe_profile_directory,
        ], expected=2)
        unsafe_file_marker = json.loads(next(
            line.split(" ", 1)[1] for line in unsafe_file.stderr.splitlines()
            if line.startswith("VL3D_IMPORT_ERROR ")
        ))
        assert unsafe_file_marker["code"] == "VL3D-E5008"

        source_json = payload(gds + ".json")
        source_json["pins"] = [{
            "id": 0, "name": "EXACT_PIN", "terminal": "EXACT_PIN", "net": "EXACT_NET",
            "ownerCell": "TOP_A", "hierPath": "TOP_A", "layer": "M1",
            "purpose": "pin", "points": [[0, 0], [1, 0], [1, 1], [0, 1]],
            "worldBBox": {"min": [0, 0], "max": [1, 1]},
        }]
        source_json["connections"] = [{
            "id": 0, "parentPath": "TOP_A", "parentNet": "EXACT_NET",
            "occurrencePath": "TOP_A/I1_CHILD", "childFormalNet": "P", "terminal": "P",
        }]
        source_json["pinCount"] = 1
        source_json["connectionCount"] = 1
        exact_source = os.path.join(temporary, "exact.json.gz")
        with gzip.open(exact_source, "wt") as handle:
            json.dump(source_json, handle)
        exact_output = os.path.join(temporary, "exact-output.json")
        run([sys.executable, importer_path, exact_source, "--output", exact_output])
        exact = payload(exact_output)
        assert exact["pins"][0]["name"] == "EXACT_PIN"
        assert exact["connections"][0]["parentNet"] == "EXACT_NET"
        assert exact["sourceFormat"] == "GDSII"
        assert exact["exportStatus"]["parser"] == "vl3d-json"

        changed = os.path.join(temporary, "changed.gds")
        shutil.copyfile(gds, changed)
        snapshot = importer.source_snapshot(changed)
        with open(changed, "ab") as handle:
            handle.write(b"changed")
        try:
            importer.assert_source_unchanged(changed, snapshot)
        except importer.StreamImportError as error:
            assert error.code == "E6008"
        else:
            raise AssertionError("Changed source was not detected")

        print("PASS: gdstk hierarchy, portable profiles, bounded resources, GDS/OAS, exact JSON, and source guard")
    finally:
        shutil.rmtree(temporary)


if __name__ == "__main__":
    main()
