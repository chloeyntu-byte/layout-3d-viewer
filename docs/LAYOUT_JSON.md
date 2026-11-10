# Layout JSON units

The viewer consumes schema-v2 geometry already normalized to **micrometres**.
Both OA export and GDSII/OASIS import produce `"units": "um"`. The source stream's
database precision may still be recorded in `dbuPerMicron`; it does **not** mean
that the JSON coordinates are database-unit integers.

An explicit `units` field must be a string equal to `um`, `µm` (micro sign), or
`μm` (Greek mu), ignoring surrounding whitespace and case. For compatibility,
older files with no `units` field retain the original micrometre interpretation.
An explicit null, empty string, non-string value, `nm`, `dbu`, or another unit is
rejected with **VL3D-E4003** before that geometry is rendered.

This applies to direct `.json` and `.json.gz` opening, the JSON import command,
and browser loading. There is no automatic unit conversion in those readers.
Validation preserves the original units text, pin names, individual pin figures,
coordinates and shape ordinals. Native caches created before this validation are
invalidated by compiler version `native-cache-v1.9` or later. Version
`native-cache-v1.10` also isolates unresolved layer positions from the known stack.

## Preparing a non-micrometre JSON input

Convert the geometry consistently before opening it. **Do not fix the error by
only replacing the `units` label.** For coordinates in nanometres, multiply all
geometric distances by `0.001`; for database-unit integers, multiply by
`1 / dbuPerMicron` using the source's valid database precision.

The conversion must include shape points and holes, path widths and end
extensions, bounding boxes, pin/world geometry, instance origins and transform
translations. Keep names, paths, layer identifiers and shape ordering unchanged.
Dimensionless rotation/mirror matrices must not be scaled. Layer-stack fields
such as `zBottomUm` and `zTopUm`, and layer thicknesses already expressed in
micrometres, must remain in micrometres. A mixed-unit input cannot be corrected by
a uniform numeric search-and-replace; use its documented source geometry contract
or re-import the original GDSII/OASIS / re-export OA.

The independent physical-trace engine additionally understands `nm` and `dbu`
inputs for its geometry API. That support is separate from the viewer input
contract; it does not make a non-micrometre JSON suitable for display.

## OA technology evidence

Schema-4 TSV may include `TECHLAYER <name> <material> <technologyLibrary>`
(tab-separated). Older schema-4 exports remain readable without these records.
The JSON `technology.layerDefinitions` retains this local evidence. Known material
roles override name guesses; unknown materials do not establish conductivity.
Layer `classificationSource`, `technologyMaterial`, and `stackSource` explain the
classification and approximate display order. `VIADEF` still provides electrical
endpoint evidence independently; a display stack index never establishes a net.
Conflicting materials stay hidden and produce `VL3D-E5010`.
