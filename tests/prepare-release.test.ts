/**
 * CI coverage for scripts/prepare-release.mjs (plan dsh-advisor-ci-release,
 * QC1 F-004, task 4 CHANGELOG). The script resolves REPO_ROOT from its own
 * file location (import.meta.url), NOT cwd, so each case runs a COPY of the
 * script inside a temp fixture: the fixture's package.json is the file the
 * script reads and bumps, its CHANGELOG.md is what the script updates, and a
 * fake `git` shim on PATH stands in for `git rev-parse` (tag existence),
 * `git describe` (nearest ancestor tag) and `git log` (commit subjects) so
 * tag resolution and release-note collection are controlled without a real
 * git repo or any network. Deterministic and fast: real node subprocesses,
 * no installs.
 *
 * Note: the script wraps its tag check in try/catch and calls process.exit
 * inside it, so in-process exit stubbing would be swallowed; spawning the
 * script as a subprocess exercises the real exit semantics instead.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const scriptPath = resolve(repo, 'scripts', 'prepare-release.mjs')

/**
 * Minimal git stand-in. Only three invocations are ever made:
 *  - `git rev-parse <tag>`      — tags listed in ../existing-tags.txt
 *    "exist" (exit 0, prints a sha); all other tags fail like an unknown
 *    revision (exit 128).
 *  - `git describe --tags --abbrev=0 HEAD` — echoes ../describe-tag.txt when
 *    non-empty (nearest ancestor tag); otherwise fails like "no tags" (exit
 *    128), so the script falls back to the full first-parent history.
 *  - `git log --oneline --first-parent <range>` — asserts the range is
 *    `<describe-tag>..HEAD` when a describe tag is set, else `HEAD`, then
 *    echoes ../log-lines.txt (the fixture's commit subjects).
 */
const GIT_SHIM = `#!/bin/sh
if [ "$1" = "rev-parse" ]; then
  tag="$2"
  if grep -qx "$tag" "$(dirname "$0")/../existing-tags.txt" 2>/dev/null; then
    echo "9f2c5d3e4a1b6c7d8e9f0a1b2c3d4e5f6a7b8c9d"
    exit 0
  fi
  echo "fatal: ambiguous argument '$tag': unknown revision or path not in the working tree." >&2
  exit 128
fi
if [ "$1" = "describe" ]; then
  desc_file="$(dirname "$0")/../describe-tag.txt"
  if [ -s "$desc_file" ]; then
    cat "$desc_file"
    exit 0
  fi
  echo "fatal: No names found, cannot describe anything." >&2
  exit 128
fi
if [ "$1" = "log" ]; then
  range="$4"
  desc_file="$(dirname "$0")/../describe-tag.txt"
  expected="HEAD"
  if [ -s "$desc_file" ]; then
    expected="$(cat "$desc_file")..HEAD"
  fi
  if [ "$range" != "$expected" ]; then
    echo "prepare-release.test: unexpected git log range '$range' (expected '$expected')" >&2
    exit 2
  fi
  cat "$(dirname "$0")/../log-lines.txt" 2>/dev/null
  exit 0
fi
echo "prepare-release.test: unexpected git invocation: $*" >&2
exit 2
`

let fixture = ''

function makeFixture(version: string): void {
  fixture = mkdtempSync(join(tmpdir(), 'prepare-release-'))
  mkdirSync(join(fixture, 'bin'))
  mkdirSync(join(fixture, 'scripts'))
  writeFileSync(
    join(fixture, 'package.json'),
    `${JSON.stringify({ name: 'dsh-advisor', version }, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(join(fixture, 'bin', 'git'), GIT_SHIM, { mode: 0o755 })
  copyFileSync(scriptPath, join(fixture, 'scripts', 'prepare-release.mjs'))
}

function fixtureVersion(): string {
  return JSON.parse(readFileSync(join(fixture, 'package.json'), 'utf8')).version as string
}

function runScript(args: string[], existingTags: string[]): { status: number; stdout: string; stderr: string } {
  writeFileSync(join(fixture, 'existing-tags.txt'), existingTags.length ? `${existingTags.join('\n')}\n` : '', 'utf8')
  const result = spawnSync(process.execPath, [join(fixture, 'scripts', 'prepare-release.mjs'), ...args], {
    cwd: fixture,
    env: { ...process.env, PATH: `${join(fixture, 'bin')}:${process.env.PATH ?? ''}` },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

describe('scripts/prepare-release.mjs', () => {
  it('auto patch bump: 0.1.0 -> 0.1.1, prints VERSION=0.1.1, exits 0', () => {
    makeFixture('0.1.0')
    // A real release has commits since the previous release: without a
    // describe tag the notes span the full first-parent history, which must
    // be non-empty (an empty range now fails the no-change guard).
    writeFileSync(join(fixture, 'log-lines.txt'), 'abc1234 some commit\n', 'utf8')
    const { status, stdout, stderr } = runScript([], [])
    expect(status).toBe(0)
    expect(stdout.trim()).toBe('VERSION=0.1.1')
    expect(stderr).toBe('')
    expect(fixtureVersion()).toBe('0.1.1')
  })

  it('explicit version 0.2.0 is accepted and written', () => {
    makeFixture('0.1.0')
    writeFileSync(join(fixture, 'log-lines.txt'), 'abc1234 some commit\n', 'utf8')
    const { status, stdout } = runScript(['0.2.0'], [])
    expect(status).toBe(0)
    expect(stdout.trim()).toBe('VERSION=0.2.0')
    expect(fixtureVersion()).toBe('0.2.0')
  })

  it('invalid explicit version is rejected: exit 1 + stderr message, package.json untouched', () => {
    makeFixture('0.1.0')
    const { status, stderr } = runScript(['0.2'], [])
    expect(status).toBe(1)
    expect(stderr).toContain('invalid version')
    expect(fixtureVersion()).toBe('0.1.0')
  })

  it('existing tag is rejected: exit 1 + stderr message, package.json untouched', () => {
    makeFixture('0.1.0')
    const { status, stderr } = runScript([], ['v0.1.1'])
    expect(status).toBe(1)
    expect(stderr).toContain('already exists')
    expect(fixtureVersion()).toBe('0.1.0')
  })

  it('empty notes range (no commits since the previous tag) is rejected: exit 1, no file mutations', () => {
    // (a) Realistic no-change run: a previous release tag exists but the
    // <tag>..HEAD range has no commits (log-lines.txt absent → the git shim
    // yields empty output). The script must fail BEFORE bumping package.json
    // or writing CHANGELOG.md — no empty release PR can be produced.
    makeFixture('0.1.0')
    writeFileSync(join(fixture, 'describe-tag.txt'), 'v0.1.0\n', 'utf8')
    const originalChangelog = [
      '# Changelog',
      '',
      'All notable changes to dsh-advisor are documented here. Generated from git log by the release-prep workflow.',
      '',
      '## [0.1.0] - 2026-08-13',
      '',
      '- 9d293c0 Merge pull request #16 from dsh-external/chore/release-0.1.0',
      '',
    ].join('\n')
    writeFileSync(join(fixture, 'CHANGELOG.md'), originalChangelog, 'utf8')
    const { status, stdout, stderr } = runScript([], [])
    expect(status).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('Error: no commits since previous release tag v0.1.0')
    expect(stderr).toContain('nothing to release')
    expect(fixtureVersion()).toBe('0.1.0')
    expect(readFileSync(join(fixture, 'CHANGELOG.md'), 'utf8')).toBe(originalChangelog)

    // (b) Degenerate no-tag case (empty full first-parent history): the
    // error names the first-commit placeholder; still no file mutations.
    makeFixture('0.1.0')
    const second = runScript([], [])
    expect(second.status).toBe(1)
    expect(second.stdout).toBe('')
    expect(second.stderr).toContain('Error: no commits since previous release tag <first commit>')
    expect(second.stderr).toContain('nothing to release')
    expect(fixtureVersion()).toBe('0.1.0')
  })

  it('writes CHANGELOG.md: inserts ## [<version>] section under the header and preserves prior sections', () => {
    makeFixture('0.1.0')
    // No ancestor tag (describe-tag.txt absent) → notes span the full main
    // line; the fixture supplies the first-parent commit subjects.
    writeFileSync(
      join(fixture, 'log-lines.txt'),
      '9d293c0 Merge pull request #16 from dsh-external/chore/release-0.1.0\naf86f22 Merge pull request #15 from dsh-external/chore/deps-bump-rc3\n',
      'utf8',
    )
    const originalChangelog = [
      '# Changelog',
      '',
      'All notable changes to dsh-advisor are documented here. Generated from git log by the release-prep workflow.',
      '',
      '## [0.1.0] - 2026-08-13',
      '',
      '- 9d293c0 Merge pull request #16 from dsh-external/chore/release-0.1.0',
      '',
    ].join('\n')
    writeFileSync(join(fixture, 'CHANGELOG.md'), originalChangelog, 'utf8')
    const { status, stdout } = runScript([], [])
    expect(status).toBe(0)
    expect(stdout.trim()).toBe('VERSION=0.1.1')
    const changelog = readFileSync(join(fixture, 'CHANGELOG.md'), 'utf8')
    // New section is present, sits above the pre-existing section, and
    // carries the git-log notes as bullet items.
    expect(changelog).toContain('## [0.1.1] - ')
    expect(changelog.indexOf('## [0.1.1]')).toBeLessThan(changelog.indexOf('## [0.1.0]'))
    expect(changelog).toContain(
      '- 9d293c0 Merge pull request #16 from dsh-external/chore/release-0.1.0\n- af86f22 Merge pull request #15 from dsh-external/chore/deps-bump-rc3',
    )
    // The pre-existing section survives byte-for-byte (F-003): everything at
    // and below the `## [0.1.0]` header of the pre-run file is present
    // verbatim, and the post-insert tail equals the pre-run tail exactly —
    // same byte offset into the file, including the trailing newline.
    const originalSectionText = originalChangelog.slice(originalChangelog.indexOf('## [0.1.0]'))
    expect(changelog).toContain(originalSectionText)
    expect(changelog.slice(changelog.indexOf('## [0.1.0]'))).toBe(originalSectionText)
  })

  it('CHANGELOG.md: byte-for-byte tail preservation when the file has no trailing newline', () => {
    makeFixture('0.1.0')
    writeFileSync(join(fixture, 'log-lines.txt'), 'abc1234 some commit\n', 'utf8')
    // The pre-run file deliberately has NO trailing newline — the pre-fix
    // split('\n')/splice/join('\n') path would append one after insertion
    // and change the tail bytes.
    const original = [
      '# Changelog',
      '',
      'All notable changes to dsh-advisor are documented here. Generated from git log by the release-prep workflow.',
      '',
      '## [0.1.0] - 2026-08-13',
      '',
      '- 9d293c0 Merge pull request #16 from dsh-external/chore/release-0.1.0',
    ].join('\n')
    writeFileSync(join(fixture, 'CHANGELOG.md'), original, 'utf8')
    const { status } = runScript(['0.1.1'], [])
    expect(status).toBe(0)
    const changelog = readFileSync(join(fixture, 'CHANGELOG.md'), 'utf8')
    const originalSectionText = original.slice(original.indexOf('## [0.1.0]'))
    expect(changelog).toContain(originalSectionText)
    expect(changelog.slice(changelog.indexOf('## [0.1.0]'))).toBe(originalSectionText)
  })

  it('CHANGELOG.md: re-run for the same version is a no-op — the section is not duplicated', () => {
    makeFixture('0.1.0')
    writeFileSync(join(fixture, 'log-lines.txt'), 'abc1234 some commit\n', 'utf8')
    const first = runScript(['0.1.1'], [])
    expect(first.status).toBe(0)
    const second = runScript(['0.1.1'], [])
    expect(second.status).toBe(0)
    const changelog = readFileSync(join(fixture, 'CHANGELOG.md'), 'utf8')
    expect(changelog.match(/^## \[0\.1\.1\] - /gm)).toHaveLength(1)
  })

  it('CHANGELOG.md: missing file is created with the standard header and the new section', () => {
    makeFixture('0.1.0')
    writeFileSync(join(fixture, 'log-lines.txt'), 'abc1234 some commit\n', 'utf8')
    // No CHANGELOG.md in the fixture — the script must bootstrap the file
    // with the standard header, then insert the section under it (no leading
    // blank lines, header first).
    const { status, stdout } = runScript(['0.1.1'], [])
    expect(status).toBe(0)
    expect(stdout.trim()).toBe('VERSION=0.1.1')
    const changelog = readFileSync(join(fixture, 'CHANGELOG.md'), 'utf8')
    expect(changelog.startsWith('# Changelog\n')).toBe(true)
    expect(changelog).toContain(
      'All notable changes to dsh-advisor are documented here. Generated from git log by the release-prep workflow.',
    )
    expect(changelog).toMatch(/^# Changelog\n\nAll notable changes[^\n]*\n\n## \[0\.1\.1\] - \d{4}-\d{2}-\d{2}\n\n- abc1234 some commit\n$/)
  })

  it('CHANGELOG.md: header-only file (trailing newline) gets the section appended after exactly one blank line', () => {
    makeFixture('0.1.0')
    writeFileSync(join(fixture, 'log-lines.txt'), 'abc1234 some commit\n', 'utf8')
    const headerOnly = [
      '# Changelog',
      '',
      'All notable changes to dsh-advisor are documented here. Generated from git log by the release-prep workflow.',
      '',
    ].join('\n')
    writeFileSync(join(fixture, 'CHANGELOG.md'), headerOnly, 'utf8')
    const { status } = runScript(['0.1.1'], [])
    expect(status).toBe(0)
    const changelog = readFileSync(join(fixture, 'CHANGELOG.md'), 'utf8')
    // One blank line separates the header block from the new section; the
    // section is the last content and the file keeps its trailing newline.
    expect(changelog).toMatch(/^# Changelog\n\nAll notable changes[^\n]*\n\n## \[0\.1\.1\] - \d{4}-\d{2}-\d{2}\n\n- abc1234 some commit\n$/)
  })

  it('CHANGELOG.md: header-only file (no trailing newline) gets the section appended with a blank-line separator', () => {
    makeFixture('0.1.0')
    writeFileSync(join(fixture, 'log-lines.txt'), 'abc1234 some commit\n', 'utf8')
    const headerOnly = [
      '# Changelog',
      '',
      'All notable changes to dsh-advisor are documented here. Generated from git log by the release-prep workflow.',
    ].join('\n')
    writeFileSync(join(fixture, 'CHANGELOG.md'), headerOnly, 'utf8')
    const { status } = runScript(['0.1.1'], [])
    expect(status).toBe(0)
    const changelog = readFileSync(join(fixture, 'CHANGELOG.md'), 'utf8')
    expect(changelog).toMatch(/^# Changelog\n\nAll notable changes[^\n]*\n\n## \[0\.1\.1\] - \d{4}-\d{2}-\d{2}\n\n- abc1234 some commit\n$/)
  })

  it('CHANGELOG.md: 0-byte file is bootstrapped like a missing file (header + section, no leading blank lines)', () => {
    makeFixture('0.1.0')
    writeFileSync(join(fixture, 'log-lines.txt'), 'abc1234 some commit\n', 'utf8')
    // An existing-but-empty CHANGELOG.md must take the missing-file path:
    // pre-fix, the append branch produced a headerless file that starts with
    // blank lines instead of `# Changelog`.
    writeFileSync(join(fixture, 'CHANGELOG.md'), '', 'utf8')
    const { status } = runScript(['0.1.1'], [])
    expect(status).toBe(0)
    const changelog = readFileSync(join(fixture, 'CHANGELOG.md'), 'utf8')
    expect(changelog.startsWith('# Changelog\n')).toBe(true)
    expect(changelog).toMatch(/^# Changelog\n\nAll notable changes[^\n]*\n\n## \[0\.1\.1\] - \d{4}-\d{2}-\d{2}\n\n- abc1234 some commit\n$/)
  })

  it('CHANGELOG.md: whitespace-only file is bootstrapped like a missing file (header + section, no leading blank lines)', () => {
    makeFixture('0.1.0')
    writeFileSync(join(fixture, 'log-lines.txt'), 'abc1234 some commit\n', 'utf8')
    // An existing-but-whitespace-only CHANGELOG.md must take the missing-file
    // path too: pre-fix, the append branch produced a headerless file that
    // starts with blank lines instead of `# Changelog`.
    writeFileSync(join(fixture, 'CHANGELOG.md'), '\n\n  \n', 'utf8')
    const { status } = runScript(['0.1.1'], [])
    expect(status).toBe(0)
    const changelog = readFileSync(join(fixture, 'CHANGELOG.md'), 'utf8')
    expect(changelog.startsWith('# Changelog\n')).toBe(true)
    expect(changelog).toMatch(/^# Changelog\n\nAll notable changes[^\n]*\n\n## \[0\.1\.1\] - \d{4}-\d{2}-\d{2}\n\n- abc1234 some commit\n$/)
  })

  it('CHANGELOG.md: nearest ancestor tag — notes use the <tag>..HEAD range and the section lists only post-tag commits', () => {
    makeFixture('0.1.0')
    // The fake git shim echoes `git describe` from describe-tag.txt and
    // asserts `git log` receives the `v0.1.0..HEAD` range (exit 2 otherwise),
    // so a regression to e.g. `v$VERSION^` fails the run.
    writeFileSync(join(fixture, 'describe-tag.txt'), 'v0.1.0\n', 'utf8')
    writeFileSync(
      join(fixture, 'log-lines.txt'),
      'b0b1c2d post-tag commit 2\na1a2b3c post-tag commit 1\n',
      'utf8',
    )
    // Realistic pre-existing file: the released 0.1.0 section is already
    // committed; preparing 0.1.1 lists only commits after the v0.1.0 tag.
    const original = [
      '# Changelog',
      '',
      'All notable changes to dsh-advisor are documented here. Generated from git log by the release-prep workflow.',
      '',
      '## [0.1.0] - 2026-08-13',
      '',
      '- 9d293c0 Merge pull request #16 from dsh-external/chore/release-0.1.0',
      '',
    ].join('\n')
    writeFileSync(join(fixture, 'CHANGELOG.md'), original, 'utf8')
    const { status, stdout } = runScript(['0.1.1'], [])
    expect(status).toBe(0)
    expect(stdout.trim()).toBe('VERSION=0.1.1')
    const changelog = readFileSync(join(fixture, 'CHANGELOG.md'), 'utf8')
    const newSection = changelog.slice(changelog.indexOf('## [0.1.1]'), changelog.indexOf('## [0.1.0]'))
    // Only post-tag commits (the v0.1.0..HEAD range) are listed as bullets,
    // in git-log order (newest first: log-lines.txt line 1 → first bullet).
    expect(newSection).toContain('- b0b1c2d post-tag commit 2\n- a1a2b3c post-tag commit 1')
    expect(newSection).not.toContain('9d293c0')
    // The pre-existing 0.1.0 section survives byte-for-byte below.
    const originalSectionText = original.slice(original.indexOf('## [0.1.0]'))
    expect(changelog.slice(changelog.indexOf('## [0.1.0]'))).toBe(originalSectionText)
  })

  it('explicit prerelease 0.1.1-alpha.1 is accepted: VERSION printed, package.json + CHANGELOG updated', () => {
    makeFixture('0.1.1')
    writeFileSync(join(fixture, 'log-lines.txt'), 'abc1234 some commit\n', 'utf8')
    const original = [
      '# Changelog',
      '',
      'All notable changes to dsh-advisor are documented here. Generated from git log by the release-prep workflow.',
      '',
      '## [0.1.0] - 2026-08-13',
      '',
      '- 9d293c0 Merge pull request #16 from dsh-external/chore/release-0.1.0',
      '',
    ].join('\n')
    writeFileSync(join(fixture, 'CHANGELOG.md'), original, 'utf8')
    const { status, stdout, stderr } = runScript(['0.1.1-alpha.1'], [])
    expect(status).toBe(0)
    expect(stdout.trim()).toBe('VERSION=0.1.1-alpha.1')
    expect(stderr).toBe('')
    expect(fixtureVersion()).toBe('0.1.1-alpha.1')
    const changelog = readFileSync(join(fixture, 'CHANGELOG.md'), 'utf8')
    // The prerelease header extracts with the same `## [<version>]` pattern
    // the workflows awk on; it sits above the pre-existing section.
    expect(changelog).toContain('## [0.1.1-alpha.1] - ')
    expect(changelog.indexOf('## [0.1.1-alpha.1]')).toBeLessThan(changelog.indexOf('## [0.1.0]'))
    expect(changelog).toContain('- abc1234 some commit')
    const originalSectionText = original.slice(original.indexOf('## [0.1.0]'))
    expect(changelog.slice(changelog.indexOf('## [0.1.0]'))).toBe(originalSectionText)
  })

  it('auto patch bump on a prerelease base drops the suffix: 0.1.1-alpha.1 -> 0.1.2', () => {
    makeFixture('0.1.1-alpha.1')
    writeFileSync(join(fixture, 'log-lines.txt'), 'abc1234 some commit\n', 'utf8')
    const { status, stdout, stderr } = runScript([], [])
    expect(status).toBe(0)
    expect(stdout.trim()).toBe('VERSION=0.1.2')
    expect(stderr).toBe('')
    expect(fixtureVersion()).toBe('0.1.2')
  })

  it('invalid prerelease versions are rejected: exit 1 + stderr message, package.json untouched', () => {
    // '0.1.1-alpha' has no numeric identifier and '0.1.1-' has an empty
    // suffix — both rejected by the parse (suffix must contain a digit).
    for (const bad of ['0.1.1-alpha', '0.1.1-']) {
      makeFixture('0.1.1')
      const { status, stderr } = runScript([bad], [])
      expect(status).toBe(1)
      expect(stderr).toContain('invalid version')
      expect(fixtureVersion()).toBe('0.1.1')
    }
  })
})
