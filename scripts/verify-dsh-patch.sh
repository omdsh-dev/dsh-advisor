#!/usr/bin/env bash
#
# verify-dsh-patch.sh — verify the host exposure patch's effect (present / absent)
# in the target dsh source tree.
#
# Two probes are checked (existing files are checked; missing files are recorded
# as SKIP and never counted as pass or fail):
#   @deepseek-ai/dsh-host-apiproxy  src/api-proxy.ts            → expect `'ui-onboarding', 'advisor'`
#                                   lib/types/api-proxy.js      → expect `'ui-onboarding', 'advisor'`
#                                   (build artifact; tsc emits outDir lib/types — the
#                                    constant is module-private and never reaches the
#                                    .d.ts, so the compiled JS is the build probe)
#
# By default the marker must be present (patch applied and rebuilt); --absent
# inverts the assertion (after revert). Verdict: any existing probe that violates
# the assertion → exit 1; if no probe file exists at all, the tree is not a dsh
# tree → exit 1.
#
# Target resolution (at runtime; the script itself contains no local absolute paths):
#   $DSH_SOURCE_DIR (if set) → default ${DSH_HOME}/source/current
#
# Options:
#   --absent         assert the marker is absent (post-revert verification).
#   -d|--target DIR   target dsh source tree (overrides env resolution).
#   -q|--quiet       print only the final verdict.
#   -h|--help        show this help.
#
# Exit codes: 0 = verify passed; 1 = verify failed / target unavailable.
set -euo pipefail

usage() {
  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

ABSENT=0
QUIET=0
TARGET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --absent) ABSENT=1; shift ;;
    -q|--quiet) QUIET=1; shift ;;
    -d|--target)
      if [[ $# -lt 2 || -z "$2" || "$2" == -* ]]; then
        echo "ERROR: $1 requires a target directory argument" >&2
        usage 1
      fi
      TARGET="$2"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "unknown option: $1" >&2; usage 1 ;;
  esac
done

# Resolve the target directory
if [[ -z "$TARGET" ]]; then
  TARGET="${DSH_SOURCE_DIR:-${DSH_HOME:-}/source/current}"
fi
if [[ ! -d "$TARGET" ]]; then
  echo "ERROR: target directory does not exist: $TARGET" >&2
  echo "       set DSH_SOURCE_DIR (or DSH_HOME), or use --target." >&2
  exit 1
fi

# Probes: (relative path|fixed string|label)
PROBES=(
  "packages/host/apiproxy/src/api-proxy.ts|'ui-onboarding', 'advisor'|host-apiproxy source (src/api-proxy.ts)"
  "packages/host/apiproxy/lib/types/api-proxy.js|'ui-onboarding', 'advisor'|host-apiproxy build (lib/types/api-proxy.js)"
)

EXPECT_LABEL="present"
[[ "$ABSENT" -eq 1 ]] && EXPECT_LABEL="absent"

FAIL=0
CHECKED=0

for probe in "${PROBES[@]}"; do
  IFS='|' read -r rel marker label <<< "$probe"
  file="${TARGET}/${rel}"
  if [[ ! -f "$file" ]]; then
    [[ "$QUIET" -eq 0 ]] && printf '  [SKIP] %-52s file missing\n' "$label"
    continue
  fi
  CHECKED=1
  if grep -qF -- "$marker" "$file"; then
    present=1
  else
    present=0
  fi
  if [[ "$ABSENT" -eq 1 ]]; then
    # marker must be absent: presence is a failure
    if [[ "$present" -eq 1 ]]; then
      FAIL=1
      [[ "$QUIET" -eq 0 ]] && printf '  [FAIL] %-52s unexpected %s\n' "$label" "'$marker'"
    else
      [[ "$QUIET" -eq 0 ]] && printf '  [PASS] %-52s %s absent\n' "$label" "'$marker'"
    fi
  else
    # marker must be present: absence is a failure
    if [[ "$present" -eq 1 ]]; then
      [[ "$QUIET" -eq 0 ]] && printf '  [PASS] %-52s hit %s\n' "$label" "'$marker'"
    else
      FAIL=1
      [[ "$QUIET" -eq 0 ]] && printf '  [FAIL] %-52s missing %s\n' "$label" "'$marker'"
    fi
  fi
done

if [[ "$CHECKED" -eq 0 ]]; then
  echo "ERROR: no probe file found in the target directory; not a dsh source tree: $TARGET" >&2
  exit 1
fi

if [[ "$FAIL" -eq 1 ]]; then
  echo "== verify failed: host exposure marker (expected ${EXPECT_LABEL}) not satisfied" >&2
  exit 1
fi

echo "== verify passed: host exposure marker (expected ${EXPECT_LABEL}) satisfied"
