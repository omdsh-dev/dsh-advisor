/**
 * CI coverage for scripts/prepare-release.mjs (plan dsh-advisor-ci-release,
 * QC1 F-004). The script resolves REPO_ROOT from its own file location
 * (import.meta.url), NOT cwd, so each case runs a COPY of the script inside
 * a temp fixture: the fixture's package.json is the file the script reads
 * and bumps, and a fake `git` shim on PATH stands in for `git rev-parse` so
 * tag existence is controlled without a real git repo or any network.
 * Deterministic and fast: real node subprocesses, no installs.
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
 * Minimal git stand-in: only `git rev-parse <tag>` is ever invoked. Tags
 * listed in ../existing-tags.txt "exist" (exit 0, prints a sha); all other
 * tags fail like an unknown revision (exit 128).
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
    const { status, stdout, stderr } = runScript([], [])
    expect(status).toBe(0)
    expect(stdout.trim()).toBe('VERSION=0.1.1')
    expect(stderr).toBe('')
    expect(fixtureVersion()).toBe('0.1.1')
  })

  it('explicit version 0.2.0 is accepted and written', () => {
    makeFixture('0.1.0')
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
})
