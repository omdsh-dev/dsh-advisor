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
#                                   lib/index.js                → expect PRODUCT_SETTINGS_NAMESPACES … advisor
#                                   (tsdown bundle — the package `main`, the runtime
#                                    entry when dsh packages are consumed outside the
#                                    tsx-from-source install; two line probes: the
#                                    constant declaration (fixed-string grep -F —
#                                    shape-agnostic) and the advisor allowlist
#                                    entry line (quote-agnostic regex))
#
# By default the marker must be present (patch applied and rebuilt); --absent
# inverts the assertion (after revert). In --absent mode the bundle
# constant-declaration probe (present in the unpatched bundle too) is skipped —
# the advisor allowlist entry is the only discriminator of the reverted state.
# Verdict: any existing probe that violates the assertion → exit 1; if no probe
# file exists at all, the tree is not a dsh tree → exit 1.
#
# With --runtime [URL] the script skips the file probes and instead queries a
# running dsh web server: POST {url}/api/settings.describe and assert the
# response namespaces include `advisor` (with --absent, that they exclude it).
# Both modes only trust a settings.describe SUCCESS envelope; an HTTP error
# page, error envelope, or garbage fails (server not restarted / wrong endpoint).
# The probe is read-only, sends no credentials, and bypasses proxies
# (--noproxy). URL defaults to http://127.0.0.1:3080.
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
  sed -n '2,47p' "$0" | sed 's/^# \{0,1\}//'
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
  local body="" curl_status=0 exposed=0 envelope_ok=0

  # Normalize the URL: strip ALL trailing slashes so {url}/api/settings.describe
  # never becomes {url}//api/settings.describe.
  while [[ "$url" == */ ]]; do
    url="${url%/}"
  done

  if ! command -v curl >/dev/null 2>&1; then
    echo "ERROR: runtime probe failed: curl is not available in PATH (required for --runtime)." >&2
    exit 1
  fi

  # `--noproxy '*'`: never route the probe through a proxy (localhost dsh web).
  # `|| curl_status=$?` (not `if ! ...; then $?`) — inside an `if !` branch $?
  # is the NEGATED status (0), which would mask curl failures.
  body="$(curl --noproxy '*' --silent --show-error --max-time 10 \
      --request POST \
      --header 'Content-Type: application/json' \
      --data '{"type":"client-request","rpcId":"verify","method":"settings.describe","payload":{}}' \
      "${url}/api/settings.describe" 2>&1)" || curl_status=$?

  if [[ "$curl_status" -ne 0 ]]; then
    [[ "$QUIET" -eq 0 ]] && printf '  [FAIL] runtime probe %-36s server unreachable\n' "(${url})" >&2
    echo "ERROR: runtime probe failed: cannot reach dsh web at ${url} (server not running, or not restarted after applying the patch): ${body}" >&2
    exit 1
  fi

  # Envelope guard (space-tolerant markers): only trust the body when it is a
  # settings.describe SUCCESS envelope — "ok":true with a namespaces result.
  # An HTTP error page, an error envelope (ok:false), or garbage must FAIL
  # instead of being read as "no advisor" / "advisor present".
  if grep -qE '"ok"[[:space:]]*:[[:space:]]*true' <<< "$body" && grep -qF '"namespaces"' <<< "$body"; then
    envelope_ok=1
  fi

  if grep -qE '"ns"[[:space:]]*:[[:space:]]*"advisor"' <<< "$body"; then
    exposed=1
  fi

  if [[ "$ABSENT" -eq 1 ]]; then
    if [[ "$exposed" -eq 1 ]]; then
      [[ "$QUIET" -eq 0 ]] && printf '  [FAIL] runtime probe %-36s unexpected namespace\n' "(${url})" >&2
      echo "ERROR: runtime probe failed: ${url} exposes the advisor namespace (expected absent)." >&2
      exit 1
    fi
    if [[ "$envelope_ok" -eq 0 ]]; then
      [[ "$QUIET" -eq 0 ]] && printf '  [FAIL] runtime probe %-36s unexpected response\n' "(${url})" >&2
      echo "ERROR: runtime probe failed: unexpected response from ${url} (not a settings.describe success envelope) — cannot assert namespace absence." >&2
      exit 1
    fi
    [[ "$QUIET" -eq 0 ]] && printf '  [PASS] runtime probe %-36s advisor namespace absent\n' "(${url})"
    echo "== verify passed: runtime namespace 'advisor' absent at ${url}"
    exit 0
  fi

  # present mode: require a success envelope before interpreting exposure —
  # a non-settings.describe response gets its own distinct failure message.
  if [[ "$envelope_ok" -eq 0 ]]; then
    [[ "$QUIET" -eq 0 ]] && printf '  [FAIL] runtime probe %-36s unexpected response\n' "(${url})" >&2
    echo "ERROR: runtime probe failed: ${url} returned an unexpected response (not a settings.describe success response) — cannot assert namespace exposure." >&2
    exit 1
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

# Probes: (relative path|match string|label) with optional mode fields:
#   F = fixed string (grep -F, default); E = extended regex (grep -E).
#   P = present-only: the probe is SKIPPED when --absent is active.
# The src / tsc-emit probes keep the literal single-quoted source marker. The
# tsdown bundle (lib/index.js) probe is split into TWO line-based probes
# because the new tsdown (rolldown) emits the Set multi-line:
#   const PRODUCT_SETTINGS_NAMESPACES = new Set([
#     "ui-onboarding",
#     "advisor",
#     ...
#   ]);
# grep is line-based, so a single [^;]* context probe cannot span the
# newlines. The two probes check the constant declaration line and the advisor
# allowlist entry line separately. The constant probe is a fixed-string
# (grep -F) probe — SHAPE-agnostic: it matches the declaration regardless of
# the Set body's ordering or whitespace (its marker contains no regex
# metacharacters, so no ERE is needed). The advisor entry probe is an
# ENTRY-LINE-based quote-agnostic regex: anchored at the start of the line and
# accepting either quote character (the tsdown printer's quote choice is not
# contractual). In --absent mode (after revert) only the advisor ENTRY line
# discriminates: the constant declaration exists in the unpatched bundle too,
# so that probe is marked present-only (P) — absent mode keys on the advisor
# entry probe alone.
PROBES=(
  "packages/host/apiproxy/src/api-proxy.ts|'ui-onboarding', 'advisor'|host-apiproxy source (src/api-proxy.ts)"
  "packages/host/apiproxy/lib/types/api-proxy.js|'ui-onboarding', 'advisor'|host-apiproxy build (lib/types/api-proxy.js)"
  "packages/host/apiproxy/lib/index.js|PRODUCT_SETTINGS_NAMESPACES = new Set(|host-apiproxy bundle (lib/index.js — allowlist constant)|F|P"
  "packages/host/apiproxy/lib/index.js|^[[:space:]]*[\"']advisor[\"']|host-apiproxy bundle (lib/index.js — advisor allowlist entry)|E"
)

EXPECT_LABEL="present"
[[ "$ABSENT" -eq 1 ]] && EXPECT_LABEL="absent"

FAIL=0
CHECKED=0

for probe in "${PROBES[@]}"; do
  IFS='|' read -r rel marker label mode scope <<< "$probe"
  mode="${mode:-F}"
  file="${TARGET}/${rel}"
  # Present-only probes (e.g. the bundle constant declaration — present in the
  # unpatched bundle too) are skipped in --absent mode: they cannot
  # discriminate the reverted state; absent mode keys on the advisor entry.
  if [[ "$ABSENT" -eq 1 && "$scope" == "P" ]]; then
    [[ "$QUIET" -eq 0 ]] && printf '  [SKIP] %-52s present-mode probe (skipped with --absent)\n' "$label"
    continue
  fi
  if [[ ! -f "$file" ]]; then
    [[ "$QUIET" -eq 0 ]] && printf '  [SKIP] %-52s file missing\n' "$label"
    continue
  fi
  CHECKED=1
  if [[ "$mode" == "E" ]]; then
    if grep -qE -- "$marker" "$file"; then
      present=1
    else
      present=0
    fi
  else
    if grep -qF -- "$marker" "$file"; then
      present=1
    else
      present=0
    fi
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
