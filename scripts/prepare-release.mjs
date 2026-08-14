#!/usr/bin/env node
/**
 * Release-prep version helper (plan dsh-advisor-ci-release, task 2 + 4):
 * resolves the target version — explicit `X.Y.Z` argument or an auto patch
 * bump from package.json — refuses already-released versions (existing
 * `vX.Y.Z` git tag), bumps package.json, inserts the `## [<version>]` section
 * into CHANGELOG.md (from the same git-log notes the workflows use; keeps
 * existing sections, no-op when already present), and prints
 * `VERSION=<x.y.z>` for the workflow to capture. Node built-ins only, no new
 * dependencies.
 *
 * Usage:
 *   node scripts/prepare-release.mjs            # auto patch bump
 *   node scripts/prepare-release.mjs 0.2.0      # explicit version
 *
 * Exit codes: 0 = bumped and printed VERSION; 1 = rejected (unparseable
 * version, existing tag, unparseable current package.json version, or
 * CHANGELOG.md write error).
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

/**
 * Release notes since the previous release: first-parent commit subjects
 * between the nearest ancestor tag of HEAD and HEAD. Same snippet the
 * workflows use for the PR body — the CHANGELOG section and the PR body
 * stay consistent. When no ancestor tag exists yet, the notes span the full
 * first-parent history. Do NOT use "v$VERSION^": the version string is not a
 * git ref — the bump commit is not tagged yet.
 */
function collectReleaseNotes() {
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
  return execFileSync('git', ['log', '--oneline', '--first-parent', range], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

/**
 * Insert a `## [<version>] - <YYYY-MM-DD>` section under the `# Changelog`
 * header, above the existing sections, from the same git-log notes the
 * workflows use. Preserves all existing sections; no-op when the section for
 * this version already exists (idempotent re-runs must not duplicate it);
 * write failures exit 1.
 */
function updateChangelog(version) {
  let content
  try {
    content = readFileSync(CHANGELOG_PATH, 'utf8')
  } catch {
    content = CHANGELOG_HEADER
  }
  // A 0-byte CHANGELOG.md (e.g. manual truncation) is treated as missing:
  // an empty file must still bootstrap with the standard header, otherwise
  // the new section would land at the top with leading blank lines and no
  // `# Changelog` header.
  if (content === '') {
    content = CHANGELOG_HEADER
  }

  if (content.includes(`## [${version}]`)) {
    return
  }

  const notes = collectReleaseNotes()
  const sectionHeader = `## [${version}] - ${new Date().toISOString().slice(0, 10)}`
  const sectionBody =
    notes === ''
      ? 'No commits between releases.'
      : notes
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

updateChangelog(version)

console.log(`VERSION=${version}`)
