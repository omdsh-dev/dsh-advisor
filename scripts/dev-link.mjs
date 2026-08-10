// Generates the gitignored dev/ overlay: one shim package per private dsh
// dependency (KD-1). Committed file — contains NO local absolute paths; all
// absolute paths live only in the generated (gitignored) dev/ directory.
//
// Usage: DSH_SOURCE=<abs path to a dsh source tree> pnpm dev:link
// Default: sibling directory `dsh-private` next to this repo.
import { mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const source = resolve(process.env.DSH_SOURCE ?? join(repo, '..', 'dsh-private'))
const require = createRequire(import.meta.url)
const manifest = require(join(repo, 'package.json'))
const want = Object.keys(manifest.devDependencies).filter((n) => n.startsWith('@deepseek-ai/') || n === 'cordis')

const found = new Map()
async function scan(dir) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const pj = join(p, 'package.json')
      try {
        const pkg = require(pj)
        if (want.includes(pkg.name)) found.set(pkg.name, p)
      } catch { /* not a package dir */ }
      if (!['vendor'].includes(e.name)) await scan(p)
    }
  }
}
await scan(join(source, 'packages'))
await scan(join(source, 'vendor'))

const missing = want.filter((n) => !found.has(n))
if (missing.length) throw new Error(`packages not found under ${source}: ${missing.join(', ')}`)

const dev = join(repo, 'dev')
await rm(dev, { recursive: true, force: true })
await mkdir(dev, { recursive: true })
for (const name of want) {
  const real = found.get(name)
  const pkg = require(join(real, 'package.json'))
  const main = join(real, pkg.main ?? 'lib/index.js')
  const types = join(real, pkg.types ?? 'lib/types/index.d.ts')
  const dir = join(dev, name.replace('@deepseek-ai/', ''))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: pkg.name, version: pkg.version, type: 'module', private: true,
    main: './index.js', types,
  }, null, 2) + '\n')
  await writeFile(join(dir, 'index.js'), `export * from ${JSON.stringify(main)}\n`)
  console.log(`linked ${name} -> ${real}`)
}
console.log('overlay written to', dev)
