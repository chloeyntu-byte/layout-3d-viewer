#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_HOME="${XDG_CACHE_HOME:-${HOME:-/tmp}/.cache}"
STATE_HOME="${XDG_STATE_HOME:-${HOME:-/tmp}/.local/state}"
VL3D_CACHE_ROOT="${VL3D_CACHE_DIR:-$CACHE_HOME/vl3d}"
VL3D_STATE_ROOT="${VL3D_STATE_DIR:-$STATE_HOME/vl3d}"

LIB="${VL3D_LIB:-}"
CELLS="${VL3D_CELLS:-}"
VIEW="${VL3D_VIEW:-layout}"
RESOURCE_MODE="${VL3D_RESOURCE_MODE:-balanced}"
case "$RESOURCE_MODE" in
  low) PRESET_VALUES=(6 100000 100000 100000 200000 500000) ;;
  balanced) PRESET_VALUES=(8 200000 200000 200000 400000 1000000) ;;
  large) PRESET_VALUES=(16 1000000 1000000 1000000 2000000 4000000) ;;
  *) echo "VL3D_RESOURCE_MODE must be low, balanced, or large" >&2; exit 2 ;;
esac
MAX_DEPTH="${VL3D_MAX_DEPTH:-${PRESET_VALUES[0]}}"
SHAPE_LIMIT="${VL3D_SHAPE_LIMIT:-${PRESET_VALUES[1]}}"
INSTANCE_LIMIT="${VL3D_INSTANCE_LIMIT:-${PRESET_VALUES[2]}}"
PIN_LIMIT="${VL3D_PIN_LIMIT:-${PRESET_VALUES[3]}}"
CONNECTION_LIMIT="${VL3D_CONNECTION_LIMIT:-${PRESET_VALUES[4]}}"
RECORD_LIMIT="${VL3D_RECORD_LIMIT:-${PRESET_VALUES[5]}}"
CADENCE_ENV="${VL3D_CADENCE_ENV:-}"
CDS_LIB="${VL3D_CDS_LIB:-}"
MANIFEST_MODE="merge"
RAW_DIR=""
RUNTIME_DIR=""
DATA_DIR="${VL3D_DATA_DIR:-$VL3D_CACHE_ROOT/data}"
MANIFEST="${VL3D_MANIFEST:-$DATA_DIR/manifest.json}"
LOG=""
CONVERT=1
PYTHON_BIN="${VL3D_PYTHON_BIN:-}"

if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
  echo "Refusing to run Virtuoso as root; run this command as the layout owner" >&2
  exit 2
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lib)
      LIB="$2"
      shift 2
      ;;
    --cells)
      CELLS="$2"
      shift 2
      ;;
    --view)
      VIEW="$2"
      shift 2
      ;;
    --max-depth)
      MAX_DEPTH="$2"
      shift 2
      ;;
    --shape-limit)
      SHAPE_LIMIT="$2"
      shift 2
      ;;
    --instance-limit)
      INSTANCE_LIMIT="$2"
      shift 2
      ;;
    --pin-limit)
      PIN_LIMIT="$2"
      shift 2
      ;;
    --connection-limit)
      CONNECTION_LIMIT="$2"
      shift 2
      ;;
    --record-limit)
      RECORD_LIMIT="$2"
      shift 2
      ;;
    --cadence-env)
      CADENCE_ENV="$2"
      shift 2
      ;;
    --cds-lib)
      CDS_LIB="$2"
      shift 2
      ;;
    --manifest-mode)
      MANIFEST_MODE="$2"
      shift 2
      ;;
    --raw-dir)
      RAW_DIR="$2"
      shift 2
      ;;
    --runtime-dir)
      RUNTIME_DIR="$2"
      shift 2
      ;;
    --data-dir)
      DATA_DIR="$2"
      shift 2
      ;;
    --manifest)
      MANIFEST="$2"
      shift 2
      ;;
    --log)
      LOG="$2"
      shift 2
      ;;
    --raw-only)
      CONVERT=0
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

TS="$(date +%Y%m%d-%H%M%S)"
RAW_DIR="${RAW_DIR:-$VL3D_STATE_ROOT/exports/raw-$TS}"
LOG="${LOG:-$VL3D_STATE_ROOT/logs/virtuoso-export-$TS.log}"
RUNTIME_DIR="${RUNTIME_DIR:-$RAW_DIR/runtime}"

OA_NAME_RE='^[A-Za-z0-9_.$:+-]+$'
if [[ -z "$LIB" || -z "$CELLS" ]]; then
  echo "VL3D-E2015: --lib and --cells (or VL3D_LIB/VL3D_CELLS) are required" >&2
  exit 2
fi
if [[ -z "$CDS_LIB" ]]; then
  echo "VL3D-E2003: --cds-lib or VL3D_CDS_LIB is required" >&2
  exit 2
fi
if [[ ! "$LIB" =~ $OA_NAME_RE || ! "$VIEW" =~ $OA_NAME_RE ]]; then
  echo "Unsafe OA library or view name" >&2
  exit 2
fi
IFS=',' read -r -a CELL_NAMES <<< "$CELLS"
if [[ ${#CELL_NAMES[@]} -eq 0 ]]; then
  echo "At least one OA cell is required" >&2
  exit 2
fi
for CELL_NAME in "${CELL_NAMES[@]}"; do
  if [[ ! "$CELL_NAME" =~ $OA_NAME_RE ]]; then
    echo "Unsafe OA cell name: $CELL_NAME" >&2
    exit 2
  fi
done
if [[ ! "$MAX_DEPTH" =~ ^[0-9]+$ ]] || (( 10#$MAX_DEPTH > 64 )); then
  echo "--max-depth must be an integer from 0 through 64" >&2
  exit 2
fi
for LIMIT_SPEC in \
  "$SHAPE_LIMIT:2000000:shape" \
  "$INSTANCE_LIMIT:2000000:instance" \
  "$PIN_LIMIT:2000000:pin" \
  "$CONNECTION_LIMIT:4000000:connection" \
  "$RECORD_LIMIT:8000000:record"; do
  IFS=':' read -r LIMIT MAXIMUM LABEL <<< "$LIMIT_SPEC"
  if [[ ! "$LIMIT" =~ ^[1-9][0-9]*$ ]] || (( 10#$LIMIT > 10#$MAXIMUM )); then
    echo "$LABEL limit must be an integer from 1 through $MAXIMUM" >&2
    exit 2
  fi
done

for PATH_VALUE in "$RAW_DIR" "$RUNTIME_DIR" "$LOG" "$CDS_LIB"; do
  if [[ "$PATH_VALUE" == *$'\n'* || "$PATH_VALUE" == *$'\r'* ]]; then
    echo "A configured path contains a newline" >&2
    exit 2
  fi
done

mkdir -p "$RAW_DIR" "$RUNTIME_DIR" "$(dirname "$LOG")"
chmod 700 "$RAW_DIR" "$RUNTIME_DIR" "$(dirname "$LOG")"
if [[ "$CONVERT" == 1 ]]; then
  mkdir -p "$DATA_DIR" "$(dirname "$MANIFEST")"
  chmod 700 "$DATA_DIR" "$(dirname "$MANIFEST")"
fi

if [[ -n "$CADENCE_ENV" && ! -r "$CADENCE_ENV" ]]; then
  echo "Cadence environment file is not readable: $CADENCE_ENV" >&2
  exit 1
fi
if [[ ! -r "$CDS_LIB" ]]; then
  echo "cds.lib is not readable: $CDS_LIB" >&2
  exit 1
fi
printf 'INCLUDE %s\n' "$CDS_LIB" > "$RUNTIME_DIR/cds.lib"

(
  cd "$RUNTIME_DIR"
  if [[ -n "$CADENCE_ENV" ]]; then
    source "$CADENCE_ENV"
  fi
  if ! command -v virtuoso >/dev/null 2>&1; then
    echo "virtuoso executable not found after loading the configured environment" >&2
    exit 1
  fi
  export VL3D_LIB="$LIB"
  export VL3D_CELLS="$CELLS"
  export VL3D_VIEW="$VIEW"
  export VL3D_OUT_DIR="$RAW_DIR"
  export VL3D_MAX_DEPTH="$MAX_DEPTH"
  export VL3D_SHAPE_LIMIT="$SHAPE_LIMIT"
  export VL3D_INSTANCE_LIMIT="$INSTANCE_LIMIT"
  export VL3D_PIN_LIMIT="$PIN_LIMIT"
  export VL3D_CONNECTION_LIMIT="$CONNECTION_LIMIT"
  export VL3D_RECORD_LIMIT="$RECORD_LIMIT"
  virtuoso -nograph -nocdsinit -restore "$ROOT/tools/oa_dump.il" -log "$LOG"
)

if [[ "$CONVERT" == 1 ]]; then
  if [[ -z "$PYTHON_BIN" ]]; then
    PYTHON_BIN="$(command -v python3 || true)"
  fi
  if [[ -z "$PYTHON_BIN" || ! -x "$PYTHON_BIN" ]]; then
    echo "Python 3 executable not found; set VL3D_PYTHON_BIN" >&2
    exit 1
  fi
  (
    unset LD_LIBRARY_PATH LD_PRELOAD LD_AUDIT PYTHONHOME PYTHONPATH
    "$PYTHON_BIN" "$ROOT/tools/convert_layout_tsv.py" \
      --input-dir "$RAW_DIR" \
      --output-dir "$DATA_DIR" \
      --manifest "$MANIFEST" \
      --manifest-mode "$MANIFEST_MODE"
  )
fi

echo "Raw TSV: $RAW_DIR"
if [[ "$CONVERT" == 1 ]]; then
  echo "JSON:    $DATA_DIR"
fi
echo "Log:     $LOG"
