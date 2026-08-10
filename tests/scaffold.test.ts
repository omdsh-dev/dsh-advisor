import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as entry from '../src/index'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')

describe('bundle manifest contract (T1 scaffold)', () => {
  it('declares the dsh bundle patch and the advisor row', () => {
    const manifest = JSON.parse(readFileSync(resolve(repo, 'package.json'), 'utf8'))
    // Packability: the manifest must not be private (the tarball is installed
    // into profiles).
    expect(manifest.private).toBeUndefined()
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const patch = readFileSync(resolve(repo, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('id: advisor')
    expect(patch).toContain('name: dsh-advisor')
  })

  it('entry exports the cordis plugin shape (name + apply)', () => {
    expect(entry.name).toBe('dsh-advisor')
    expect(typeof entry.apply).toBe('function')
  })
})
