# Physical connectivity tracing

VL3D 0.3 adds a separate physical-connectivity engine alongside named-net
tracing. Both frontends use the same local Python worker. It reads the original
layout geometry and returns source-array shape indices; the rendering mesh and
visual Z exaggeration are never used as connectivity evidence. Input OA, GDS
and JSON files are not changed.

## Using it

Select a module in the hierarchy, choose **Physical geometry** in the pin panel,
and select a pin. Every figure belonging to that terminal at that occurrence
is used as a seed. **Whole layout** follows routes across hierarchy boundaries;
**Selected modules** restricts the search to selected occurrences and their
children. A route touching that boundary is reported as incomplete. Canceling,
changing the selected pin, or opening another layout clears obsolete results.

The named-net mode remains available and follows explicit scoped net names and
parent/child pin mappings. It is useful for comparing electrical annotations
against visible geometry. A net name is not required by physical tracing.

Try `examples/physical-trace-demo.json`, an entirely synthetic example:

| Select module / pin | Expected physical result |
|---|---|
| `TRACE/ROUTE` / `IN` | 8 shapes through M1, V1, M2, V2 and M3 |
| `TRACE/CROSSING` / `CROSS` | Its M2 strip only; crossing M1 without a VIA does not connect |
| `TRACE/GAPS` / `GAP` | Its isolated M1 strip only; the real gap stays open |
| `TRACE/GAPS` / `IN_HOLE` | The island inside the polygon hole only |
| `TRACE/GAPS` / `FRAME` | The surrounding frame only |
| `TRACE/CONTACT` / `POLY_IN` | POLY, CT and the attached M1 strip |

## Electrical contract

The engine indexes declared metal, poly, contact and VIA geometry. A bounding
box only selects candidates. Actual polygon edges, interiors and holes decide
contact. Same-layer edges or overlapping area connect; an isolated corner-only
contact is conservatively excluded and reported. Cross-layer connections need
positive-area contact through a connector with explicitly declared endpoints.
Layer numbers, matching metal indices, neighboring Z values and net names do
not substitute for those endpoints.

A connector layer can declare `lowerLayer` / `upperLayer`, or plural
`lowerLayers` / `upperLayers`, with `connectivitySource` recording the evidence.
Native OA export supplies actual via-definition endpoints. Unconfirmed
name-only VIA inference is excluded. Contacts can terminate at active regions,
but active/well/implant are not merged as ordinary routing conductors.

Device-boundary evidence is kept separately in `deviceScopes`, with its
completeness flag. Declared MOS, capacitor, resistor, inductor and unclassified device interiors
are opaque: the tracer cannot silently walk from one device terminal to another
through its body. Exact exported terminal figures remain available as route
endpoints; other interior geometry is excluded. This differs from a raw Full
metal trace that can continue through an inductor winding. Purpose exclusions and explicit `traceRole` barriers are
respected. PDK-specific device extraction remains outside this viewer's scope.
A result with missing device or layer rules is explicitly incomplete and must
not be treated as a verified circuit net. Refresh older OA exports to obtain the
new boundary metadata. Plain GDS without pin annotations cannot supply a pin
seed; follow the [validated pin sidecar workflow](PIN_ANNOTATION.md) or use OA input.

A pin with multiple disconnected figures produces separate seed components and
an ambiguity report. Cancellation, geometry limits, malformed or unsupported
shapes, missing seeds, unknown connectivity and scope boundaries never become a
"complete" result. Complete means complete within the declared geometry/rule
contract; it is not LVS or manufacturing signoff.

## Precision and input

Geometry uses world coordinates from the normalized layout, including expanded
instance arrays, rotations and mirrors. Explicit local affine geometry is also
supported. Predicates use integer coordinates at 1e-9 micrometre resolution,
independently of the float32 display buffers. Paths use the same footprint
construction as the native renderer. Fresh OA path segments use their exact
shape boundary. Legacy pathSeg bounding rectangles are display fallbacks only;
they are excluded from physical tracing with a refresh/re-export message.
Invalid polygons or unavailable geometry
are reported rather than replaced with bounding-box solids.

## Resources, cancellation and cache

Work runs outside the UI/event loop. Each request is cancelable and has limits
on shapes, vertices, spatial-index cells, candidate tests, geometry operations,
result size, estimated memory and elapsed time. The local server admits at most
two concurrent traces; the worker also has a process memory ceiling and a hard
shutdown deadline. No new system services or dependencies are required beyond
the existing native Python requirements.

Browser JSON submissions are limited to 64 MiB. Use the desktop file workflow
for larger inputs; local source files are capped at 384 MiB for this feature.
The initial index still scans the loaded layout; narrowing the trace scope
limits traversal, not that initial input/index cost. Defaults are 200,000 shapes, 100,000 result shapes, 60 seconds and 256 MiB of
estimated index memory. Progress and limits are visible in trace diagnostics.
Only complete results are cached, separately from render caches, in the user's
private runtime state directory. Keys cover source content, query, rules and
engine code. Cache retention is bounded to 64 entries / 64 MiB / 30 minutes.
Source digests prevent stale results from highlighting the wrong mesh indices.

## Verification

Tests cover unnamed metal, real gaps, concave polygons, holes, explicit VIA/CT
endpoints, device boundaries, hierarchy scope, multiple pin figures, affine
transforms, unit conversion, invalid geometry, cancellation, resource ceilings,
source changes and both UI clients. Validation against real process data is
performed privately by users; no proprietary circuit data or screenshots are
distributed with the project.

## Interpreting incomplete rules

Read the specific diagnostics before reloading. `trace-connector-unconfirmed`,
`trace-connector-endpoints-missing` and missing endpoint layers require a verified
profile/layer map and a new import; Refresh cannot infer a process rule from Z
or numeric layer names. `trace-device-metadata-missing` and legacy pathSeg
geometry can be repaired by a fresh export with the current exporter.

`trace-stop-layer-semantics-unconfirmed` is a separate contract limitation.
Actual VIA definitions and complete device-category coverage do not prove that
all PDK-specific derived stop layers and extraction expressions are supported.
Repeated Refresh does not establish that evidence. Keep the result limited;
do not set a completeness flag merely to hide this warning. The current engine
stops at declared device terminals, and its confirmed routing subset is useful
without claiming raw Full-tracer or LVS equivalence. See the actionable table in
[Usage](USAGE.md#看到不完整后如何处理).
