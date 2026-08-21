/**
 * Test-only immutable path writers mirroring the 0.1.1-rc.1
 * `@deepseek-ai/dsh-client-ui-settings` `SettingsSchemaService` semantics.
 *
 * The published ui-settings package exports `SettingsSchemaService` as a
 * TYPE only (`./client`), and its `./src/*` export is not shipped in the
 * tarball, so a spec cannot construct the real service. The store's tests
 * exercise patch/dirty semantics through these writers, so this fake is a
 * faithful copy of the 0.1.1-rc.1 implementation (packages/client/ui-settings
 * src/client/schema.ts): immutability, materialized missing containers on
 * set, array-index splice on delete, and the non-empty-path throw. The
 * `SettingsSchemaOperations` type keeps the signature pinned to the real
 * service; semantic drift is caught by the store tests' exact patch
 * assertions.
 */

import type { SettingsSchemaOperations } from '../../src/client/advisor-store'

function cloneContainer(container: unknown, key: string): Record<string, unknown> | unknown[] {
  if (Array.isArray(container)) return [...container as unknown[]]
  if (typeof container === 'object' && container !== null) return { ...container as Record<string, unknown> }
  return /^\d+$/.test(key) ? [] : {}
}

function cloneSpine(root: Record<string, unknown>, path: readonly string[]): {
  result: Record<string, unknown>
  parent: Record<string, unknown> | unknown[]
  leaf: string
} {
  const result = { ...root }
  let target: Record<string, unknown> | unknown[] = result
  for (let index = 0; index < path.length - 1; index++) {
    const key = path[index] as string
    const child = cloneContainer(
      Array.isArray(target) ? target[Number(key)] : target[key],
      path[index + 1] as string,
    )
    if (Array.isArray(target)) target[Number(key)] = child
    else target[key] = child
    target = child
  }
  return { result, parent: target, leaf: path[path.length - 1] as string }
}

/** A real-semantics schema operations face for unit tests. */
export function fakeSchema(): SettingsSchemaOperations {
  const hasPath = (value: unknown, path: readonly string[]): boolean => {
    if (path.length === 0) return value !== undefined
    const parent = getPath(value, path.slice(0, -1))
    const key = path[path.length - 1] as string
    if (Array.isArray(parent)) return Number(key) < parent.length
    if (typeof parent !== 'object' || parent === null) return false
    return key in parent
  }
  const getPath = (value: unknown, path: readonly string[]): unknown => {
    let current: unknown = value
    for (const key of path) {
      if (Array.isArray(current)) {
        current = current[Number(key)]
        continue
      }
      if (typeof current !== 'object' || current === null) return undefined
      current = (current as Record<string, unknown>)[key]
    }
    return current
  }
  return {
    getPath,
    setPath(root: Record<string, unknown>, path: readonly string[], value: unknown): Record<string, unknown> {
      if (path.length === 0) throw new Error('fake schema: setPath needs a non-empty path')
      const { result, parent, leaf } = cloneSpine(root, path)
      if (Array.isArray(parent)) parent[Number(leaf)] = value
      else parent[leaf] = value
      return result
    },
    deletePath(root: Record<string, unknown>, path: readonly string[]): Record<string, unknown> {
      if (path.length === 0) throw new Error('fake schema: deletePath needs a non-empty path')
      if (!hasPath(root, path)) return root
      const { result, parent, leaf } = cloneSpine(root, path)
      if (Array.isArray(parent)) parent.splice(Number(leaf), 1)
      else Reflect.deleteProperty(parent, leaf)
      return result
    },
  }
}
