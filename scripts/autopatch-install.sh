#!/usr/bin/env bash
#
# autopatch-install.sh — apply the dsh host exposure patch automatically at plugin
# install time (idempotent; failures warn only).
#
# Background: the dsh host's apiproxy must expose the `advisor` settings namespace
# for the web Settings page round-trip to work (see apply-dsh-patch.sh / C-1).
# This script runs from the plugin install lifecycle (postinstall / prepare),
# detects the target dsh source tree and idempotently applies the patch, then
# best-effort rebuilds the affected package; every failure only warns and never
# fails the plugin install (global constraint: never break the install).
#
# Switch: DSH_ADVISOR_AUTOPATCH (default 1; set to "0" to skip entirely, exit 0).
#
# Target resolution (at runtime; the script itself contains no local absolute paths):
#   $DSH_SOURCE_DIR (if set) → default ${DSH_HOME}/source/current
#   missing target or non-git tree → info skip (exit 0).
#
# Flow (per patch, same three-state check as apply-dsh-patch.sh):
#   git apply --check passes       → not yet applied → git apply;
#   git apply --reverse --check passes → already applied → skip (idempotent);
#   both fail → recorded as conflict; after all patches are handled, if the verify
#   probes pass (marker already in place — the host already supports it or an
#   equivalent change was applied) → info skip; otherwise → warn with manual steps
#   (never interrupts the install).
# After applying, best-effort rebuild: tsc -b packages/host/apiproxy
#   + tsdown --env.DSH_BUILD_FACE host (missing pnpm / missing node_modules /
#   failure → warn, don't stop). Finally run the verify probes and report
#   (on failure, print the manual commands).
#
# Options:
#   --check         only report each patch's state; modifies nothing, builds nothing, verifies nothing.
#   -h|--help       show this help.
#
# Exit codes:
#   0  completed normally (including all-skipped / conflict-warn / build-warn —
#      the install never fails because of this script)
#   1  usage error (unknown option)
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
  sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

CHECK_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK_ONLY=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "ERROR: unknown option: $1" >&2; usage 1 ;;
  esac
done

# Output carries the plugin prefix so it is recognizable in pnpm install logs
log()  { printf '[dsh-advisor:autopatch] %s\n' "$*"; }
warn() { printf '[dsh-advisor:autopatch] WARN: %s\n' "$*" >&2; }

# 1) Environment switch: DSH_ADVISOR_AUTOPATCH=0 → skip entirely (including the
#    autopatch segment of the prepare chain)
if [[ "${DSH_ADVISOR_AUTOPATCH:-1}" == "0" ]]; then
  log "DSH_ADVISOR_AUTOPATCH=0 — automatic patch application skipped"
  exit 0
fi

# 2) Target resolution: $DSH_SOURCE_DIR first, default ${DSH_HOME}/source/current
TARGET="${DSH_SOURCE_DIR:-${DSH_HOME:-}/source/current}"
# Accept both regular checkouts (.git dir) and git worktrees (.git file — the
# layout of ${DSH_HOME}/source/current staging trees).
if [[ ! -e "$TARGET/.git" ]]; then
  log "no dsh source tree found ($TARGET missing or not a git tree); automatic patch application skipped (apply manually with scripts/apply-dsh-patch.sh after install)"
  exit 0
fi
log "target dsh source tree: $TARGET"

# Report a single patch's state: needs-apply / applied / conflict (same shape as apply-dsh-patch.sh)
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

# Rebuild the affected package (tsc -b incremental → tsdown host bundle).
# best-effort: any failure only warns and returns 0.
build_affected() {
  local manual="cd \"$TARGET\" && pnpm install && pnpm exec tsc -b packages/host/apiproxy && pnpm exec tsdown --env.DSH_BUILD_FACE host"
  if ! command -v pnpm >/dev/null 2>&1; then
    warn "pnpm not found in PATH; patch applied but build skipped. Rebuild manually: ${manual}"
    return 0
  fi
  if [[ ! -d "$TARGET/node_modules" ]]; then
    warn "target tree has no node_modules (not a pnpm workspace install); patch applied but build skipped. Rebuild manually: ${manual}"
    return 0
  fi
  log "rebuilding the affected package (tsc -b incremental + tsdown host bundle)"
  if ! ( cd "$TARGET" && pnpm exec tsc -b packages/host/apiproxy ); then
    warn "tsc incremental build failed (see output above); build skipped. Rebuild manually: ${manual}"
    return 0
  fi
  if ! ( cd "$TARGET" && pnpm exec tsdown --env.DSH_BUILD_FACE host ); then
    warn "tsdown bundling failed (see output above); build skipped. Rebuild manually: ${manual}"
    return 0
  fi
  log "build complete"
}

# Report the verify-probe outcome (the probes already ran once before the conflict
# verdict; here we only print per VERIFY_OK, without probing again)
run_verify() {
  if [[ "$VERIFY_OK" -eq 1 ]]; then
    log "verify probes passed: host exposure marker in place (source/build artifacts)"
  else
    warn "verify probes failed: host exposure marker not in place. Apply and verify manually: bash \"${SCRIPT_DIR}/apply-dsh-patch.sh\" && bash \"${SCRIPT_DIR}/verify-dsh-patch.sh\""
  fi
}

HAD_CONFLICT=0
APPLIED_ANY=0
CONFLICTED_PATCHES=()

for patch in "${PATCH_FILES[@]}"; do
  if [[ ! -f "${PATCHES_DIR}/${patch}" ]]; then
    warn "patch file not found: ${PATCHES_DIR}/${patch} (plugin package may be incomplete) — skipping this patch"
    continue
  fi
  status="$(patch_status "$patch")"
  case "$status" in
    needs-apply)
      if [[ "$CHECK_ONLY" -eq 1 ]]; then
        log "[check] ${patch}: applicable (not yet applied to target)"
      else
        log "applying ${patch}"
        if ! git -C "$TARGET" apply "${PATCHES_DIR}/${patch}"; then
          warn "${patch}: git apply failed (see output above); skipped (install continues)"
          continue
        fi
        APPLIED_ANY=1
      fi
      ;;
    applied)
      log "[skip]  ${patch}: already applied (idempotent skip)"
      ;;
    conflict)
      if [[ "$CHECK_ONLY" -eq 1 ]]; then
        log "[check] ${patch}: conflict (neither forward- nor reverse-apply succeeds)"
      else
        CONFLICTED_PATCHES+=("$patch")
        HAD_CONFLICT=1
      fi
      ;;
  esac
done

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  log "check complete (no files modified)"
  exit 0
fi

if [[ "$APPLIED_ANY" -eq 1 ]]; then
  build_affected
fi

# Verify probes (read-only, idempotent): run exactly once, store VERIFY_OK; both
# the conflict downgrade check and the final report share it
VERIFY_OK=0
if "${SCRIPT_DIR}/verify-dsh-patch.sh" -d "$TARGET" -q >/dev/null 2>&1; then
  VERIFY_OK=1
fi

# Conflict verdict: verify probes passing → the host already supports it (or an
# equivalent change is in place) → downgrade to info
if [[ "$HAD_CONFLICT" -eq 1 ]] && [[ "$VERIFY_OK" -eq 1 ]]; then
  log "conflicting patch, but verify probes pass (host already supports / equivalently patched); treated as done"
  HAD_CONFLICT=0
fi

if [[ "$HAD_CONFLICT" -eq 1 ]]; then
  warn "the following patch conflicts with the target tree (possibly hand-edited or a dsh upgrade drifted): ${CONFLICTED_PATCHES[*]}"
  warn "handle manually: bash \"${SCRIPT_DIR}/apply-dsh-patch.sh\""
  log "conflicting patch present; skipping verify probes (run scripts/apply-dsh-patch.sh after resolving the conflict)"
else
  run_verify
fi

log "done (install unaffected)"
exit 0
