#!/usr/bin/env bash
#
# revert-dsh-patch.sh — revert the host exposure patch applied by apply-dsh-patch.sh.
#
# For each patch, run git apply --reverse (after a --reverse --check confirms it
# is applied); already-reverted patches are skipped idempotently; then rebuild the
# affected package (same build step as apply).
#
# Target resolution (at runtime; the script itself contains no local absolute paths):
#   $DSH_SOURCE_DIR (if set) → default ${DSH_HOME}/source/current
#
# Options:
#   --check         only check whether each patch is in the applied (revertible) state; modifies nothing.
#   --skip-build    skip the build step after reverting (exit 0).
#   -d|--target DIR   target dsh source tree (overrides env resolution).
#   -h|--help       show this help.
#
# Exit codes:
#   0  all patches reverted (or already reverted / skipped) / --check all revertible
#   1  any patch cannot be reverted, the target directory is unusable, or the build fails /
#      build skipped because pnpm is missing
set -euo pipefail

# Locate this script and the repo root (derived at runtime, no hardcoded absolute paths)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PATCHES_DIR="${REPO_ROOT}/patches"

# Same single pnpm-format patch as apply-dsh-patch.sh
PATCH_FILES=(
  "@deepseek-ai+dsh-host-apiproxy@0.0.1.patch"
)

usage() {
  sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

CHECK_ONLY=0
SKIP_BUILD=0
TARGET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK_ONLY=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
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
# Accept both regular checkouts (.git dir) and git worktrees (.git file — the
# layout of ${DSH_HOME}/source/current staging trees).
if [[ ! -e "$TARGET/.git" ]]; then
  echo "ERROR: target directory is not a git repository: $TARGET" >&2
  echo "       set DSH_SOURCE_DIR (or DSH_HOME), or use --target." >&2
  exit 1
fi
echo "== target dsh source tree: $TARGET"

# Report a single patch's applied state: applied / reverted / conflict
patch_status() {
  local patch="$1"
  if git -C "$TARGET" apply --reverse --check "${PATCHES_DIR}/${patch}" 2>/dev/null; then
    echo "applied"
  elif git -C "$TARGET" apply --check "${PATCHES_DIR}/${patch}" 2>/dev/null; then
    echo "reverted"
  else
    echo "conflict"
  fi
}

# Same rebuild step as apply-dsh-patch.sh (tsc -b incremental + tsdown host bundle)
build_affected() {
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "WARN: pnpm not found in PATH; patch reverted but build skipped." >&2
    echo "      rebuild manually: cd \"\$DSH_SOURCE_DIR\" && pnpm install && pnpm exec tsc -b packages/host/apiproxy && pnpm exec tsdown --env.DSH_BUILD_FACE host" >&2
    return 1
  fi
  if [[ ! -d "$TARGET/node_modules" ]]; then
    echo "WARN: target tree has no node_modules (not a pnpm workspace install); patch reverted but build skipped." >&2
    echo "      rebuild manually: cd \"\$DSH_SOURCE_DIR\" && pnpm install && pnpm exec tsc -b packages/host/apiproxy && pnpm exec tsdown --env.DSH_BUILD_FACE host" >&2
    return 1
  fi
  echo "== rebuilding the affected package (tsc -b incremental + tsdown host bundle)"
  if ! ( cd "$TARGET" && pnpm exec tsc -b packages/host/apiproxy ); then
    echo "ERROR: tsc incremental build failed (see output above)." >&2
    return 1
  fi
  if ! ( cd "$TARGET" && pnpm exec tsdown --env.DSH_BUILD_FACE host ); then
    echo "ERROR: tsdown bundling failed (see output above)." >&2
    return 1
  fi
  echo "== build complete"
}

HAD_CONFLICT=0
REVERTED_ANY=0

for patch in "${PATCH_FILES[@]}"; do
  if [[ ! -f "${PATCHES_DIR}/${patch}" ]]; then
    echo "ERROR: patch file not found: ${PATCHES_DIR}/${patch}" >&2
    exit 1
  fi
  status="$(patch_status "$patch")"
  case "$status" in
    applied)
      if [[ "$CHECK_ONLY" -eq 1 ]]; then
        echo "  [check] ${patch}: applied (revertible)"
      else
        echo "== reverting ${patch}"
        git -C "$TARGET" apply --reverse "${PATCHES_DIR}/${patch}"
        REVERTED_ANY=1
      fi
      ;;
    reverted)
      echo "  [skip]  ${patch}: already reverted (idempotent skip)"
      ;;
    conflict)
      echo "ERROR: ${patch}: neither reverse-apply nor forward-apply succeeds — the target tree conflicts with this patch (possibly hand-edited)." >&2
      HAD_CONFLICT=1
      ;;
  esac
done

if [[ "$HAD_CONFLICT" -eq 1 ]]; then
  echo "ERROR: conflicting patch(es); not all patches reverted." >&2
  exit 1
fi

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  echo "== check complete (no files modified)"
  exit 0
fi

if [[ "$REVERTED_ANY" -eq 1 && "$SKIP_BUILD" -eq 0 ]]; then
  build_affected || exit 1
elif [[ "$REVERTED_ANY" -eq 0 ]]; then
  echo "== all patches already reverted, no build needed"
fi

echo "== done"
