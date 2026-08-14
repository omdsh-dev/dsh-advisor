#!/usr/bin/env node
/**
 * Release-prep version helper (plan dsh-advisor-ci-release, task 2 + 4):
 * resolves the target version — explicit `X.Y.Z` / `X.Y.Z-prerelease`
 * argument (e.g. 0.1.1-alpha.1) or an auto patch bump from package.json —
 * refuses already-released versions (existing `v<version>` git tag), aborts
 * when there are no commits since the previous release tag (nothing to
 * release), bumps package.json, inserts the `## [<version>]` section into
 * CHANGELOG.md (from the same git-log notes the workflows use; keeps
 * existing sections, no-op when already present), and prints
 * `VERSION=<version>` for the workflow to capture. Node built-ins only, no
 * new dependencies.
 *
 * Usage:
 *   node scripts/prepare-release.mjs            # auto patch bump
 *   node scripts/prepare-release.mjs 0.2.0      # explicit version
 *   node scripts/prepare-release.mjs 0.1.1-alpha.1  # explicit prerelease
 *
 * Exit codes: 0 = bumped and printed VERSION; 1 = rejected (unparseable
 * version, existing tag, no commits since the previous release tag,
 * unparseable current package.json version, or CHANGELOG.md write error).
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_PATH = join(REPO_ROOT, 'package.json')
const CHANGELOG_PATH = join(REPO_ROOT, 'CHANGELOG.md')
const CHANGELOG_HEADER =
  '# Changelog\n\nAll notable changes to dsh-advisor are documented here. Generated from git log by the release-prep workflow.\n'

/**
 * Parse X.Y.Z or X.Y.Z[-prerelease] (numeric parts; optional prerelease
 * suffix); null when not parseable. The suffix character set matches the
 * workflows' guard regex `[0-9A-Za-z.-]+` (keep-simple: no leading-zero or
 * empty-identifier rules), with one tightening: the suffix MUST contain at
 * least one digit, so `0.1.1-alpha.1` / `0.1.1-rc.2` parse but `0.1.1-alpha`
 * (no numeric identifier) and `0.1.1-` (empty suffix) are rejected. Returns
 * { major, minor, patch, prerelease? } — prerelease is the raw suffix text
 * (e.g. 'alpha.1') when present, undefined for formal versions.
 */
function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]*[0-9][0-9A-Za-z.-]*))?$/.exec(value)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? undefined : match[4],
  }
}

const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'))

let target
if (process.argv[2] !== undefined) {
  target = parseVersion(process.argv[2])
  if (target === null) {
    console.error(`Error: invalid version "${process.argv[2]}". Expected X.Y.Z or X.Y.Z-prerelease (e.g. 0.2.0, 0.1.1-alpha.1).`)
    process.exit(1)
  }
} else {
  const current = parseVersion(pkg.version)
  if (current === null) {
    console.error(`Error: cannot parse current package.json version "${pkg.version}".`)
    process.exit(1)
  }
  // Auto patch bump: bump the numeric patch part and DROP any prerelease
  // suffix (a prerelease base 0.1.1-alpha.1 with no explicit arg -> 0.1.2,
  // i.e. the next formal patch after the 0.1.1 line). An explicit prerelease
  // argument is the way to prepare another prerelease (e.g. 0.1.1-alpha.2).
  target = { major: current.major, minor: current.minor, patch: current.patch + 1 }
}

const version =
  target.prerelease === undefined
    ? `${target.major}.${target.minor}.${target.patch}`
    : `${target.major}.${target.minor}.${target.patch}-${target.prerelease}`

// Reject already-released versions: `git rev-parse v<version>` succeeds iff
// the tag exists. Works unchanged for prerelease tags (v0.1.1-alpha.1 is a
// plain tag name). Run from REPO_ROOT so the check is cwd-independent.
try {
  execFileSync('git', ['rev-parse', `v${version}`], { cwd: REPO_ROOT, stdio: 'ignore' })
  console.error(`Error: tag v${version} already exists — this version is already released.`)
  process.exit(1)
} catch {
  // Tag absent → OK to prepare.
}

// Fail fast on a no-change release: an empty notes range means no commits
// since the previous release tag — prepare-release must not bump the version
// or touch CHANGELOG.md for an empty release (no empty release PR). First-
// ever releases (no ancestor tag yet) span the full first-parent history,
// which is non-empty by construction, so they still pass.
const { prevTag, notes } = resolveReleaseNotes()
if (notes === '') {
  console.error(
    `Error: no commits since previous release tag ${prevTag === '' ? '<first commit>' : prevTag} — nothing to release. Aborting.`,
  )
  process.exit(1)
}

pkg.version = version
// Preserve repo formatting: 2-space indent + trailing newline. The version
// line must be the only diff (verified by `git diff package.json` in the
// dry-run validation).
writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

/**
 * Resolve the previous release tag (nearest ancestor tag of HEAD; empty
 * when none exists yet) and the first-parent commit subjects since that
 * tag (full first-parent history when no tag exists). Same git-log snippet
 * the workflows use for the PR body — the CHANGELOG section and the PR body
 * stay consistent. Do NOT use "v$VERSION^": the version string is not a
 * git ref — the bump commit is not tagged yet.
 */
function resolveReleaseNotes() {
  let prevTag = ''
  try {
    prevTag = execFileSync('git', ['describe', '--tags', '--abbrev=0', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    // No ancestor tag yet → full history.
  }
  const range = prevTag === '' ? 'HEAD' : `${prevTag}..HEAD`
  const notes = execFileSync('git', ['log', '--oneline', '--first-parent', range], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
  return { prevTag, notes }
}

/**
 * Insert a `## [<version>] - <YYYY-MM-DD>` section under the `# Changelog`
 * header, above the existing sections, from the pre-collected git-log notes
 * (guaranteed non-empty by the no-change guard, so no fallback text is ever
 * written). Preserves all existing sections; no-op when the section for this
 * version already exists (idempotent re-runs must not duplicate it); write
 * failures exit 1.
 */
function updateChangelog(version, notes) {
  let content
  try {
    content = readFileSync(CHANGELOG_PATH, 'utf8')
  } catch {
    content = CHANGELOG_HEADER
  }
  // A 0-byte or whitespace-only CHANGELOG.md (e.g. manual truncation) is
  // treated as missing: such a file must still bootstrap with the standard
  // header, otherwise the new section would land at the top with leading
  // blank lines and no `# Changelog` header.
  if (content.trim() === '') {
    content = CHANGELOG_HEADER
  }

  if (content.includes(`## [${version}]`)) {
    return
  }

  const sectionHeader = `## [${version}] - ${new Date().toISOString().slice(0, 10)}`
  const sectionBody = notes
    .split('\n')
    .map((line) => `- ${line}`)
    .join('\n')
  // The section's own trailing `\n` plus the inserted `\n` below form the
  // blank-line separator between the new section and the existing sections.
  const section = `${sectionHeader}\n\n${sectionBody}\n`

  // Insert on the first `## [` section header via string slice: everything
  // at and below the insertion point — including the file's exact trailing
  // newline — is preserved byte-for-byte. (A split('\n')/splice/join('\n')
  // round-trip would re-normalize line breaks and could alter the tail, e.g.
  // appending a trailing newline that was not in the source file.)
  const firstSectionMatch = /^## \[/m.exec(content)
  const firstSectionIdx = firstSectionMatch === null ? -1 : firstSectionMatch.index
  let next
  if (firstSectionIdx === -1) {
    // No sections yet — append the new section after the header block,
    // keeping the file's own trailing-newline state.
    next = content.endsWith('\n') ? `${content}\n${section}` : `${content}\n\n${section}`
  } else {
    next = `${content.slice(0, firstSectionIdx)}${section}\n${content.slice(firstSectionIdx)}`
  }

  try {
    writeFileSync(CHANGELOG_PATH, next, 'utf8')
  } catch (error) {
    console.error(`Error: cannot write ${CHANGELOG_PATH}: ${error.message}`)
    process.exit(1)
  }
}

updateChangelog(version, notes)

console.log(`VERSION=${version}`)
