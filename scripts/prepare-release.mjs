#!/usr/bin/env node
/**
 * Release-prep version helper (plan dsh-advisor-ci-release, task 2):
 * resolves the target version — explicit `X.Y.Z` argument or an auto patch
 * bump from package.json — refuses already-released versions (existing
 * `vX.Y.Z` git tag), bumps package.json, and prints `VERSION=<x.y.z>` for the
 * workflow to capture. Node built-ins only, no new dependencies.
 *
 * Usage:
 *   node scripts/prepare-release.mjs            # auto patch bump
 *   node scripts/prepare-release.mjs 0.2.0      # explicit version
 *
 * Exit codes: 0 = bumped and printed VERSION; 1 = rejected (unparseable
 * version, existing tag, or unparseable current package.json version).
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_PATH = join(REPO_ROOT, 'package.json')

/** Parse strict X.Y.Z (numeric parts only); null when not parseable. */
function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'))

let target
if (process.argv[2] !== undefined) {
  target = parseVersion(process.argv[2])
  if (target === null) {
    console.error(`Error: invalid version "${process.argv[2]}". Expected X.Y.Z (e.g. 0.2.0).`)
    process.exit(1)
  }
} else {
  const current = parseVersion(pkg.version)
  if (current === null) {
    console.error(`Error: cannot parse current package.json version "${pkg.version}".`)
    process.exit(1)
  }
  target = { major: current.major, minor: current.minor, patch: current.patch + 1 }
}

const version = `${target.major}.${target.minor}.${target.patch}`

// Reject already-released versions: `git rev-parse vX.Y.Z` succeeds iff the
// tag exists. Run from REPO_ROOT so the check is cwd-independent.
try {
  execFileSync('git', ['rev-parse', `v${version}`], { cwd: REPO_ROOT, stdio: 'ignore' })
  console.error(`Error: tag v${version} already exists — this version is already released.`)
  process.exit(1)
} catch {
  // Tag absent → OK to prepare.
}

pkg.version = version
// Preserve repo formatting: 2-space indent + trailing newline. The version
// line must be the only diff (verified by `git diff package.json` in the
// dry-run validation).
writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

console.log(`VERSION=${version}`)
