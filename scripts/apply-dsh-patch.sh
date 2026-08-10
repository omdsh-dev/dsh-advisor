#!/usr/bin/env bash
#
# apply-dsh-patch.sh — apply the dsh host exposure patch to a target dsh source tree.
#
# Background: the dsh host's apiproxy only exposes model-provider namespaces plus
# `permission` / `ui-onboarding` to web configuration clients, so the plugin's
# `advisor` settings namespace is refused (`settings-not-exposed`). The minimal
# host change (C-1):
#   - @deepseek-ai/dsh-host-apiproxy: PRODUCT_SETTINGS_NAMESPACES gains 'advisor'
#     (packages/host/apiproxy/src/api-proxy.ts)
# This script applies that change as a git patch to the dsh source tree (this
# repo does not ship the dsh source).
#
# Runtime shape: in the standard staged install ($DSH_HOME/source/current) the
# dsh launcher runs the CLI from TypeScript source via tsx (the snapshot's
# tsconfig paths map @deepseek-ai/dsh-host-apiproxy → packages/host/apiproxy/src),
# so `git apply` alone is effective at runtime; the build step below only keeps
# the lib artifacts consistent for non-tsx consumers, and a restart of dsh web
# is required for the change to load.
#
# Target resolution (at runtime; the script itself contains no local absolute paths):
#   $DSH_SOURCE_DIR (if set) → default ${DSH_HOME}/source/current
#
# Flow (per patch):
#   git apply --check passes → not yet applied → git apply;
#   git apply --reverse --check passes → already applied → skip (idempotent);
#   both fail → conflict/corruption → error exit.
# After applying, rebuild the affected package (tsc -b incremental + tsdown host bundle).
#
# Options:
#   --check         only check whether each patch is applicable; modifies nothing, builds nothing.
#   --skip-build    skip the build step after applying (exit 0; for environments without pnpm).
#   -d|--target DIR   target dsh source tree (overrides env resolution).
#   -h|--help       show this help.
#
# Exit codes:
#   0  all patches applied (or already applied / skipped) / --check all ready
#   1  any patch conflicts, the target directory is unusable, or the build fails /
#      build skipped because pnpm is missing
#
# Security note: the build step executes install-time code (tsc/tsdown) in the
# target tree — run it only against a trusted dsh source tree; the target is
# chosen explicitly via $DSH_SOURCE_DIR / $DSH_HOME.
set -euo pipefail

# Locate this script and the repo root (derived at runtime, no hardcoded absolute paths)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PATCHES_DIR="${REPO_ROOT}/patches"

# The single pnpm-format patch delivered by this repo (filename follows the
# pnpm convention @scope+pkg@version.patch).
PATCH_FILES=(
  "@deepseek-ai+dsh-host-apiproxy@0.0.1.patch"
)

usage() {
  sed -n '2,43p' "$0" | sed 's/^# \{0,1\}//'
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

# Report a single patch's state: needs-apply / applied / conflict
patch_status() {
  local patch="$1"
  if git -C "$TARGET" apply --check "${PATCHES_DIR}/${patch}" 2>/dev/null; then
    echo "needs-apply"
  elif git -C "$TARGET" apply --reverse --check "${PATCHES_DIR}/${patch}" 2>/dev/null; then
    echo "applied"
  else
    echo "conflict"
  fi
}

# Rebuild the affected package: tsc -b incremental (apiproxy + its references)
# → tsdown host bundle (the dsh monorepo has no per-package build script; this
# is the repo-consistent build entry).
build_affected() {
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "WARN: pnpm not found in PATH; patch applied but build skipped." >&2
    echo "      rebuild manually: cd \"\$DSH_SOURCE_DIR\" && pnpm install && pnpm exec tsc -b packages/host/apiproxy && pnpm exec tsdown --env.DSH_BUILD_FACE host" >&2
    return 1
  fi
  if [[ ! -d "$TARGET/node_modules" ]]; then
    echo "WARN: target tree has no node_modules (not a pnpm workspace install); patch applied but build skipped." >&2
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
APPLIED_ANY=0

for patch in "${PATCH_FILES[@]}"; do
  if [[ ! -f "${PATCHES_DIR}/${patch}" ]]; then
    echo "ERROR: patch file not found: ${PATCHES_DIR}/${patch}" >&2
    exit 1
  fi
  status="$(patch_status "$patch")"
  case "$status" in
    needs-apply)
      if [[ "$CHECK_ONLY" -eq 1 ]]; then
        echo "  [check] ${patch}: applicable (not yet applied to target)"
      else
        echo "== applying ${patch}"
        git -C "$TARGET" apply "${PATCHES_DIR}/${patch}"
        APPLIED_ANY=1
      fi
      ;;
    applied)
      echo "  [skip]  ${patch}: already applied (idempotent skip)"
      ;;
    conflict)
      echo "ERROR: ${patch}: neither forward-apply nor reverse-apply succeeds — the target tree conflicts with this patch (possibly hand-edited)." >&2
      HAD_CONFLICT=1
      ;;
  esac
done

if [[ "$HAD_CONFLICT" -eq 1 ]]; then
  echo "ERROR: conflicting patch(es); not all patches applied." >&2
  exit 1
fi

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  echo "== check complete (no files modified)"
  exit 0
fi

if [[ "$APPLIED_ANY" -eq 1 && "$SKIP_BUILD" -eq 0 ]]; then
  build_affected || exit 1
elif [[ "$APPLIED_ANY" -eq 0 ]]; then
  echo "== all patches already applied, no build needed"
fi

echo "== done"
