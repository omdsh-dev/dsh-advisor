#!/usr/bin/env bash
#
# verify-dsh-patch.sh — verify the host exposure patch's effect (present / absent)
# in the target dsh source tree, or in a running dsh web server (--runtime).
#
# Three file probes are checked (existing files are checked; missing files are
# recorded as SKIP and never counted as pass or fail):
#   @deepseek-ai/dsh-host-apiproxy  src/api-proxy.ts            → expect `'ui-onboarding', 'advisor'`
#                                   lib/types/api-proxy.js      → expect `'ui-onboarding', 'advisor'`
#                                   (build artifact; tsc emits outDir lib/types — the
#                                    constant is module-private and never reaches the
#                                    .d.ts, so the compiled JS is the build probe)
#                                   lib/index.js                → expect `"ui-onboarding", "advisor"`
#                                   (tsdown bundle — the package `main`, the runtime
#                                    entry when dsh packages are consumed outside the
#                                    tsx-from-source install; tsdown emits double-quoted
#                                    string literals, hence the bundle-form marker)
#
# By default the marker must be present (patch applied and rebuilt); --absent
# inverts the assertion (after revert). Verdict: any existing probe that violates
# the assertion → exit 1; if no probe file exists at all, the tree is not a dsh
# tree → exit 1.
#
# With --runtime [URL] the script skips the file probes and instead queries a
# running dsh web server: POST {url}/api/settings.describe and assert the
# response namespaces include `advisor` (with --absent, that they exclude it).
# This proves the patch is effective in the RUNNING server — a dsh web restart
# is required after applying the patch, and file probes alone cannot prove it.
# URL defaults to http://127.0.0.1:3080.
#
# Target resolution (at runtime; the script itself contains no local absolute paths):
#   $DSH_SOURCE_DIR (if set) → default ${DSH_HOME}/source/current
#
# Options:
#   --absent         assert the marker / namespace is absent (post-revert verification).
#   --runtime [URL]  probe the running dsh web server instead of the tree files
#                    (URL defaults to http://127.0.0.1:3080; combines with --absent).
#   -d|--target DIR   target dsh source tree (overrides env resolution).
#   -q|--quiet       print only the final verdict.
#   -h|--help        show this help.
#
# Exit codes: 0 = verify passed; 1 = verify failed / server unavailable.
set -euo pipefail

usage() {
  sed -n '2,42p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

ABSENT=0
QUIET=0
TARGET=""
RUNTIME=0
RUNTIME_URL="http://127.0.0.1:3080"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --absent) ABSENT=1; shift ;;
    -q|--quiet) QUIET=1; shift ;;
    --runtime)
      RUNTIME=1
      shift
      # Optional URL argument (a non-option token only); a bare `--runtime`
      # keeps the default URL.
      if [[ $# -gt 0 && -n "$1" && "$1" != -* ]]; then
        RUNTIME_URL="$1"
        shift
      fi
      ;;
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

# --runtime mode: probe a running dsh web server instead of the tree files.
# The probe needs no target directory, so it runs before target resolution.
runtime_probe() {
  local url="$1"
  local body="" curl_status=0 exposed=0

  # `|| curl_status=$?` (not `if ! ...; then $?`) — inside an `if !` branch $?
  # is the NEGATED status (0), which would mask curl failures.
  body="$(curl --silent --show-error --max-time 10 \
      --request POST \
      --header 'Content-Type: application/json' \
      --data '{"type":"client-request","rpcId":"verify","method":"settings.describe","payload":{}}' \
      "${url}/api/settings.describe" 2>&1)" || curl_status=$?

  if [[ "$curl_status" -ne 0 ]]; then
    [[ "$QUIET" -eq 0 ]] && printf '  [FAIL] runtime probe %-36s server unreachable\n' "(${url})" >&2
    echo "ERROR: runtime probe failed: cannot reach dsh web at ${url} (server not running, or not restarted after applying the patch): ${body}" >&2
    exit 1
  fi

  if grep -qF '"ns":"advisor"' <<< "$body"; then
    exposed=1
  fi

  if [[ "$ABSENT" -eq 1 ]]; then
    if [[ "$exposed" -eq 1 ]]; then
      [[ "$QUIET" -eq 0 ]] && printf '  [FAIL] runtime probe %-36s unexpected namespace\n' "(${url})" >&2
      echo "ERROR: runtime probe failed: ${url} exposes the advisor namespace (expected absent)." >&2
      exit 1
    fi
    [[ "$QUIET" -eq 0 ]] && printf '  [PASS] runtime probe %-36s advisor namespace absent\n' "(${url})"
    echo "== verify passed: runtime namespace 'advisor' absent at ${url}"
    exit 0
  fi

  if [[ "$exposed" -eq 0 ]]; then
    [[ "$QUIET" -eq 0 ]] && printf '  [FAIL] runtime probe %-36s namespace not exposed\n' "(${url})" >&2
    echo "ERROR: runtime probe failed: ${url} does not expose the advisor namespace (settings.describe response lacks \"ns\":\"advisor\") — the patch is not effective at runtime (server not restarted, or not a dsh web endpoint)." >&2
    exit 1
  fi

  [[ "$QUIET" -eq 0 ]] && printf '  [PASS] runtime probe %-36s advisor namespace exposed\n' "(${url})"
  echo "== verify passed: runtime namespace 'advisor' exposed at ${url}"
  exit 0
}

if [[ "$RUNTIME" -eq 1 ]]; then
  runtime_probe "$RUNTIME_URL"
fi

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
# NOTE: the tsdown bundle (lib/index.js) is emitted with double-quoted string
# literals (rolldown/esbuild quote normalization), so its probe marker is the
# bundle form `"ui-onboarding", "advisor"` rather than the single-quoted source
# form that appears in src/ and the tsc emit (lib/types/api-proxy.js).
PROBES=(
  "packages/host/apiproxy/src/api-proxy.ts|'ui-onboarding', 'advisor'|host-apiproxy source (src/api-proxy.ts)"
  "packages/host/apiproxy/lib/types/api-proxy.js|'ui-onboarding', 'advisor'|host-apiproxy build (lib/types/api-proxy.js)"
  "packages/host/apiproxy/lib/index.js|\"ui-onboarding\", \"advisor\"|host-apiproxy bundle (lib/index.js)"
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
