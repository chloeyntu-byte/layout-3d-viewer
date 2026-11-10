# Layer profiles (user-provided technology data)

A layout file only carries layer names or GDS layer/datatype numbers. What those layers
*mean* (metal, via, contact, poly, auxiliary) and how they stack is technology data that this
repository does not ship. VL3D reads it from **layer profiles that you provide**.

## What is included

| File | Purpose |
|---|---|
| `profiles/generic.json` | Name-based fallback (`M1..Mn`, `VIA..`, `CONT`, `POLY`, ...). Always loaded. Thicknesses are rough placeholders and are reported as approximate. |
| `profiles/example-process.json` | A **fictional** example (made-up layer numbers, names and thicknesses) that shows every supported field. Copy it and edit it for your own process. |

Neither file describes a real foundry process.

## How to provide your own profile

* One profile: `VL3D_PDK_PROFILE=/path/to/my-process.json`, or the **PDK profile JSON** field in
  *Load setup*, or `pdkProfile` in the config file.
* A directory of profiles: `VL3D_PDK_PROFILE_DIR` / `VL3D_PDK_PROFILE_DIRS` or `pdkProfileDirs`.
  The number of files and their total size are bounded; malformed profiles are rejected with
  `VL3D-E5005`.
* GDSII/OASIS numeric layers: put a `streamLayers` table in the profile, or pass a layer-map JSON
  (`--layer-map`, the *Layer map JSON* field, or `streamLayerMap` in the config file).
  Numeric layer numbers are not portable between technologies, so unmapped layers stay hidden.

An explicitly selected profile always wins over automatic matching. A profile may match a
technology library name (`match.technologyLibraries`), aliases, design libraries or layer-name
signatures; ambiguous matches fall back to `generic` and report a diagnostic.

## Profile format (schemaVersion 1)

```json
{
  "schemaVersion": 1,
  "id": "my-process",
  "version": 1,
  "extends": "generic",
  "match": { "technologyLibraries": ["my_tech_lib"], "aliases": [], "designLibraries": [], "layerSignatures": [] },
  "streamLayers": {
    "16/0": { "name": "M1", "kind": "metal", "semantic": "metal", "routing": true,
               "defaultVisible": true, "metal": 1, "stackIndex": 3, "thicknessUm": 0.3 }
  },
  "rules": [
    { "layers": ["M2", "MET2"], "properties": { "thicknessUm": 0.3, "approximate": true } }
  ]
}
```

See `profiles/example-process.json` for a complete file. Properties accepted for layers and rules:
`kind`, `semantic`, `routing`, `defaultVisible`, `metal`, `lowerMetal`, `upperMetal`, `lowerLayer`,
`upperLayer`, `lowerLayers`, `stackIndex`, `thicknessUm`, `thicknessSource`, `zBottomUm`, `zTopUm`,
`approximate`. Units are micrometres.

## Behaviour to know about

* OA exports (schema 4) may carry technology material and VIA endpoint evidence from your own
  Cadence environment. Known materials take precedence over name guesses.
* Layers that are not confirmed conductors (active, well, implant, dummy/fill, marker purposes)
  are hidden and never used for tracing.
* If no calibrated Z/thickness is available, the stack is drawn as an **approximation** and the UI
  says so. Stack order is not a thickness measurement and never establishes electrical connectivity.
* Physical tracing uses confirmed VIA endpoints and real planar contact. It does not replace LVS,
  parasitic extraction or any sign-off check.
* Display Z scaling does not change the physical data.
