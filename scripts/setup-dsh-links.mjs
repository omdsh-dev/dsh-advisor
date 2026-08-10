#!/usr/bin/env node
/**
 * Dev-time link farm for the private `@deepseek-ai/dsh-*` packages.
 *
 * The package declares those packages as peerDependencies only (the dsh host
 * provides them at runtime). For dev-time typecheck / tests / build this repo
 * links the REAL packages from a local dsh source tree into
 * `node_modules/@deepseek-ai/`, so no `peer-stubs/` copies are needed and
 * every developer resolves against the same tree.
 *
 * Source-tree resolution (same convention as `patches/README.md`):
 *   1. `$DSH_SOURCE_DIR` (explicit override)
 *   2. `${DSH_HOME}/source/current`
 *   3. `${HOME}/.dsh/source/current` (the standard DSH_HOME location)
 *
 * The farm is idempotent: every `@deepseek-ai/*` package declared under the
 * two-level `packages` tree (and `vendor`) of the source tree is symlinked by
 * its declared name — except packages that declare a `bin` (tool CLIs such as
 * the scaffold commands: linking them into node_modules makes pnpm try to
 * link their bins into `.bin`, i.e. write into the shared dsh tree; the
 * advisor never imports them). The in-box `cordis` framework is provided as a
 * generated shim package (no bin) whose entry files point at the vendored
 * cordis, so `import 'cordis'` resolves to the same module the real packages
 * type against. Every peerDependency of this package must resolve from the
 * tree or the script fails with guidance. It is wired into the `prepare`
 * lifecycle (before `pnpm build`) and available standalone as `pnpm dsh:link`
 * (re-run after changing `$DSH_HOME`/`$DSH_SOURCE_DIR`) and
 * `pnpm dsh:link:check`.
 *
 * Modes:
 *   (no args)   ensure — create/recreate the farm, fail with guidance when
 *               the source tree is missing or a peer is not linkable.
 *   --check     verify only — no writes; exit non-zero when the farm is
 *               missing, stale, or a peer is unlinkable.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const CHECK = process.argv.includes('--check')

/** Resolve the dsh source tree root ($DSH_SOURCE_DIR first, then $DSH_HOME/source/current, then the default home location). */
function resolveSourceRoot() {
  const candidates = [
    process.env.DSH_SOURCE_DIR,
    process.env.DSH_HOME ? join(process.env.DSH_HOME, 'source', 'current') : undefined,
    join(process.env.HOME ?? '', '.dsh', 'source', 'current'),
  ].filter((candidate) => candidate !== undefined)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    `no dsh source tree found — set DSH_SOURCE_DIR (or DSH_HOME pointing at a dsh home with source/current) so every developer resolves the same tree.\n`
    + `  tried: ${candidates.map((candidate) => `\n    ${candidate}`).join('')}`,
  )
}

/** Collect every linkable package under the tree: declared name starts with `@deepseek-ai/` and the package declares no `bin` (bin-declaring packages would make pnpm link their bins into `.bin`, writing into the shared dsh tree). */
function collectDeepseekPackages(sourceRoot) {
  const found = new Map()
  for (const area of ['packages', 'vendor']) {
    for (const entry of readdirSafe(join(sourceRoot, area))) {
      // Two shapes occur: a package dir directly under the area
      // (area/<name>/package.json) or grouped (area/<group>/<name>/package.json).
      const candidates = []
      if (existsSync(join(sourceRoot, area, entry, 'package.json'))) {
        candidates.push(join(sourceRoot, area, entry))
      }
      for (const leaf of readdirSafe(join(sourceRoot, area, entry))) {
        if (existsSync(join(sourceRoot, area, entry, leaf, 'package.json'))) {
          candidates.push(join(sourceRoot, area, entry, leaf))
        }
      }
      for (const dir of candidates) {
        let manifest
        try {
          manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        } catch {
          continue
        }
        const { name, bin } = manifest
        if (typeof name === 'string' && name.startsWith('@deepseek-ai/') && bin === undefined) {
          found.set(name, dir)
        }
      }
    }
  }
  return found
}

/**
 * The source tree's own react / react-dom copies, resolved through the tree's
 * packages (each package's node_modules links the shared virtual store copy
 * the whole tree uses). node-level identity: see the header note.
 */
function resolveTreeReact(sourceRoot) {
  const requireFrom = createRequire(join(sourceRoot, 'packages', 'client', 'web-react', 'package.json'))
  const requireDomFrom = createRequire(join(sourceRoot, 'packages', 'client', 'ui-primitives', 'package.json'))
  const reactDir = dirname(requireFrom.resolve('react/package.json'))
  const reactDomDir = dirname(requireDomFrom.resolve('react-dom/package.json'))
  return { react: reactDir, 'react-dom': reactDomDir }
}

/** The peerDependencies of this package that must be linkable from the tree. */
function requiredPeers() {
  const root = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
  return Object.keys(root.peerDependencies ?? {})
    .filter((name) => name.startsWith('@deepseek-ai/'))
    .sort()
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir).filter((entry) => !entry.startsWith('.')).sort()
  } catch {
    return []
  }
}

const linkDir = join(repo, 'node_modules', '@deepseek-ai')
const cordisShimDir = join(repo, 'node_modules', 'cordis')

function linkKind() {
  return process.platform === 'win32' ? 'junction' : 'dir'
}

function ensure(linkPath, target) {
  rmSync(linkPath, { recursive: true, force: true })
  symlinkSync(target, linkPath, linkKind())
}

/**
 * The in-box cordis framework: the real packages type and run against the
 * tree's vendored cordis, so dev-time `import 'cordis'` must resolve to the
 * SAME files (module identity drives both the Context augmentations the
 * packages declare and runtime behavior). The vendored package declares a
 * `bin`, and symlinking it into node_modules makes pnpm link its bin into
 * `.bin` (a chmod write into the shared dsh tree), so instead of a package
 * symlink this writes a small private shim: a directory with a bin-less
 * package.json whose entry files are symlinks to the vendored files — the
 * same resolved files (node and tsc follow symlinks to the realpath), no
 * bin.
 */
function writeCordisShim(sourceRoot) {
  const vendorCordis = join(sourceRoot, 'vendor', 'cordis')
  const manifestPath = join(vendorCordis, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`vendored cordis not found at ${vendorCordis} — the source tree must provide the in-box cordis framework`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.name !== 'cordis') {
    throw new Error(`vendored cordis at ${vendorCordis} declares name "${manifest.name}" — expected "cordis"`)
  }
  rmSync(cordisShimDir, { recursive: true, force: true })
  mkdirSync(cordisShimDir, { recursive: true })
  ensure(join(cordisShimDir, 'index.js'), join(vendorCordis, 'lib', 'index.js'))
  ensure(join(cordisShimDir, 'index.d.ts'), join(vendorCordis, 'lib', 'types', 'index.d.ts'))
  if (existsSync(join(vendorCordis, 'src'))) {
    ensure(join(cordisShimDir, 'src'), join(vendorCordis, 'src'))
  }
  const exportsMap = { '.': { types: './index.d.ts', default: './index.js' }, './package.json': './package.json' }
  if (manifest.exports?.['./src/*'] !== undefined) {
    exportsMap['./src/*'] = './src/*'
  }
  writeFileSync(
    join(cordisShimDir, 'package.json'),
    JSON.stringify(
      {
        name: 'cordis',
        version: manifest.version,
        private: true,
        type: 'module',
        main: './index.js',
        types: './index.d.ts',
        exports: exportsMap,
      },
      null,
      2,
    ) + '\n',
  )
  return vendorCordis
}

/** Verify the cordis shim resolves to the vendored entry files. */
function checkCordisShim(sourceRoot) {
  const vendorCordis = join(sourceRoot, 'vendor', 'cordis')
  const problems = []
  const probe = (file, expected) => {
    const linkPath = join(cordisShimDir, file)
    if (!existsSync(linkPath)) {
      problems.push(`cordis shim: ${file} missing (run \`pnpm dsh:link\`)`)
      return
    }
    let current
    try {
      current = resolve(linkPath, readlinkSync(linkPath))
    } catch {
      problems.push(`cordis shim: ${file} not a symlink (re-run \`pnpm dsh:link\`)`)
      return
    }
    if (current !== expected) {
      problems.push(`cordis shim: ${file} points at ${current} (expected ${expected}) — re-run \`pnpm dsh:link\``)
    }
  }
  probe('index.d.ts', join(vendorCordis, 'lib', 'types', 'index.d.ts'))
  probe('index.js', join(vendorCordis, 'lib', 'index.js'))
  return problems.length > 0 ? problems.join('; ') : undefined
}

/**
 * Remove farm entries that no longer map to a tree package. Only symlinks
 * whose target resolves OUTSIDE this repo are ours (pnpm-managed entries
 * point into this repo's own node_modules/.pnpm and are never touched) — a
 * stale farm entry such as a bin-declaring package makes pnpm try to link
 * its bin into `.bin`, i.e. write into the shared dsh tree.
 * @param dryRun - report without removing (used by --check).
 * @returns list of stale entry names.
 */
function pruneStale(managed, dryRun) {
  const stale = []
  const scan = (linkPath) => {
    // Managed keys are package names ('@deepseek-ai/x', 'react'); the scanned
    // paths are node_modules-relative ('node_modules/@deepseek-ai/x').
    const entry = linkPath.slice(repo.length + 1).replace(/^node_modules\//, '')
    if (managed.has(entry)) return
    let target
    try {
      target = resolve(linkPath, readlinkSync(linkPath))
    } catch {
      return // not a symlink — never ours, never touched
    }
    if (target.startsWith(repo + sep)) return // pnpm-managed entry inside this repo
    if (!dryRun) rmSync(linkPath, { recursive: true, force: true })
    stale.push(entry)
  }
  for (const entry of readdirSafe(linkDir)) scan(join(linkDir, entry))
  scan(join(repo, 'node_modules', 'react'))
  scan(join(repo, 'node_modules', 'react-dom'))
  return stale
}

/** Verify one link: exists, is a symlink, and resolves to the expected target. */
function checkLink(name, linkPath, target) {
  if (!existsSync(linkPath)) return `${name}: missing (run \`pnpm dsh:link\`)`
  let current
  try {
    current = resolve(linkPath, readlinkSync(linkPath))
  } catch {
    return `${name}: not a symlink (re-run \`pnpm dsh:link\`)`
  }
  if (current !== target) {
    return `${name}: points at ${current} (expected ${target}) — re-run \`pnpm dsh:link\``
  }
  return undefined
}

function main() {
  const sourceRoot = resolveSourceRoot()
  const tree = collectDeepseekPackages(sourceRoot)
  const peers = requiredPeers()
  const missingPeers = peers.filter((name) => !tree.has(name))
  if (missingPeers.length > 0) {
    throw new Error(
      `source tree ${sourceRoot} does not provide the peer packages: ${missingPeers.join(', ')}\n`
      + 'point DSH_SOURCE_DIR at a dsh source tree containing these packages (e.g. the same tree the host runs from).',
    )
  }

  // Managed node_modules entries: every @deepseek-ai package (by declared
  // name), plus the tree's react / react-dom identity links.
  const managed = new Map([...tree].map(([name, target]) => [name, target]))
  const identity = resolveTreeReact(sourceRoot)
  for (const [name, target] of Object.entries(identity)) managed.set(name, target)

  const problems = []
  if (CHECK) {
    for (const [name, target] of managed) {
      const linkPath = join(repo, 'node_modules', name)
      const problem = checkLink(name, linkPath, target)
      if (problem !== undefined) problems.push(problem)
    }
    const cordisProblem = checkCordisShim(sourceRoot)
    if (cordisProblem !== undefined) problems.push(cordisProblem)
    for (const stale of pruneStale(managed, true)) {
      problems.push(`${stale}: stale farm entry (re-run \`pnpm dsh:link\` to prune)`)
    }
    if (problems.length > 0) {
      process.stderr.write(`dsh link farm check failed (source ${sourceRoot}):\n  ${problems.join('\n  ')}\n`)
      process.exit(1)
    }
    console.log(`dsh link farm ok: ${managed.size} entries linked from ${sourceRoot}`)
    return
  }

  mkdirSync(linkDir, { recursive: true })
  for (const [name, target] of managed) {
    ensure(join(repo, 'node_modules', name), target)
  }
  writeCordisShim(sourceRoot)
  const removed = pruneStale(managed, false)
  console.log(
    `dsh link farm: ${managed.size} entries linked from ${sourceRoot}`
    + (removed.length > 0 ? ` (pruned stale: ${removed.join(', ')})` : ''),
  )
}

try {
  main()
} catch (error) {
  process.stderr.write(`dsh link farm: ${error.message}\n`)
  process.exit(1)
}
