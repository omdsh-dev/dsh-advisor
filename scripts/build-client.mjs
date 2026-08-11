#!/usr/bin/env node
/**
 * Client bundle build (plan dsh-advisor-settings-n2, task 2 — KD-S5): emits
 * the closure-factory CJS artifact the dsh web loader consumes —
 * `window.__ModuleLoader__.load({ id: 'dsh-advisor', factory: (require) => {
 * … return module.exports; } })`. Externals resolve through the loader module
 * table — the frozen `CLIENT_EXTERNALS` (platform seed entries + the
 * documented `@deepseek-ai/dsh-client-runtime/client` exemption); everything
 * else inlines. The web shell's ClientModuleHostService serves the artifact at
 * `/plugins/dsh-advisor/client.js` and executes it as a CLASSIC <script>, so
 * the emitted text must contain NO `import.meta` and no top-level ESM
 * statements (either is a parse-time SyntaxError).
 *
 * A purity gate (esbuild onResolve) rejects any non-external, non-inline-safe
 * `@deepseek-ai/*` VALUE import — type-only imports are erased by esbuild's
 * TS loader before resolution and never reach the gate; cross-plugin
 * collaboration goes through cordis services. The in-script contract
 * assertions then re-check the artifact (requires ⊆ CLIENT_EXTERNALS, no
 * `import.meta`, no ESM statements).
 *
 * Build tool: esbuild (explicit devDependency — the repo is pnpm/node; this
 * is the node-port of mstar's bun `build-client-bundle.ts`). CSS Modules are
 * now inlined (mirror of the dsh tsdown preset's dsh-css-modules-inline):
 * `*.module.css` side-effect imports compile through lightningcss
 * ([hash]_[local], minified) and emit a guarded `<style data-plugin>`
 * injection stub into the bundle — the deferred-styling extension point is
 * closed (plan Review Gate Summary, qc1 S-2).
 *
 * Declarations: runs `tsc -p tsconfig.client.json` (emitDeclarationOnly) into
 * `lib/client/`, then writes the flat re-export `lib/client.d.ts`
 * (`export * from './client/index.js'`) that `exports["./client"].types`
 * points at — same shape as the mstar client bundle.
 */

import { build } from 'esbuild'
import { transform } from 'lightningcss'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const require = createRequire(import.meta.url)

const ID = 'dsh-advisor'
const ENTRY = 'src/client/index.ts'
const OUT_FILE = 'lib/client.js'

/** Loader module table (KD-S5): platform seed entries plus the documented runtime/client exemption. */
export const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

/** Virtual-id wrapper keeping module CSS away from esbuild's own css pipeline (mirror of dsh tsdown.client.ts dsh-css-modules-inline). */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
/** Namespace esbuild requires on non-file paths returned from onResolve. */
const CSS_NAMESPACE = 'dsh-css-modules'

/** Wire/type layers with no shared runtime identity that may inline (tsdown.client.ts mirror). */
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|session|llm|tools|brand)(\/|$)/
/** Generated descriptor/codec contribution with no shared runtime identity. */
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

const result = await build({
  entryPoints: [ENTRY],
  outfile: OUT_FILE,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  // Automatic JSX runtime (T2 review Critical-1): the CLASSIC transform emits
  // a free `React.createElement` global that the loader module table does not
  // provide -> ReferenceError on first render. The automatic runtime emits
  // `require("react/jsx-runtime")` instead, which IS a frozen CLIENT_EXTERNALS
  // entry (below) and the loader answers it — same as dsh-private's bundles.
  jsx: 'automatic',
  // Externals resolve through the loader module table (the injected require);
  // a require() the table cannot answer is a guaranteed runtime throw, so the
  // rule is the table list itself: no opinion for table entries, bundle
  // everything else (no peer auto-externalization).
  external: [...CLIENT_EXTERNALS],
  // zustand-style deps read process.env.NODE_ENV and probe
  // import.meta.env.MODE; the loader executes the bundle as a classic script
  // where a literal `import.meta` is a SyntaxError. Defining the full
  // `import.meta.env` object erases every reference. Both keys honor the
  // build's NODE_ENV so a dev build keeps dev-branch semantics; artifacts
  // default to production.
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  // Closure-factory handoff (KD-S5): `module`/`exports` are declared inside
  // the factory body; the factory returns that surface to the loader.
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
  },
  footer: {
    js: 'return module.exports; } });',
  },
  plugins: [{
    // Bundle purity gate (build-time mirror of the value-import boundary):
    // platform seed entries stay external, inline-safe wire layers inline,
    // and every other @deepseek-ai value import is a build error — a
    // cross-plugin value import either inlines a duplicate runtime instance
    // or requires a specifier the frozen module table cannot answer.
    name: 'dsh-client-bundle-purity',
    setup(build) {
      build.onResolve({ filter: /^@deepseek-ai\// }, (args) => {
        if (CLIENT_EXTERNALS.includes(args.path)) return undefined // platform module: external wins
        if (INLINE_SAFE.test(args.path) || GENERATED_REMOTE.test(args.path)) return undefined // wire contribution: inline is the point
        throw new Error(
          `client bundle purity: "${args.path}" is not a platform module (CLIENT_EXTERNALS), an inline-safe wire layer, or a generated /remote contribution — `
          + 'cross-plugin value imports are forbidden; collaborate through cordis services (type-only imports are erased and never reach this gate)',
        )
      })
    },
  }, {
    // CSS Modules inline injection (dsh tsdown.client.ts dsh-css-modules-inline
    // mirror): side-effect `*.module.css` imports compile through lightningcss
    // ([hash]_[local], minified) and the module exports the hashed class map.
    // The emitted stub injects one guarded `<style data-plugin>` per module
    // file at factory execution; the web shell's loader cleans up plugin-owned
    // tags by `style[data-plugin=<id>]` + per-module `data-plugin-css`.
    name: 'dsh-css-modules-inline',
    setup(build) {
      build.onResolve({ filter: /\.module\.css$/ }, (args) => {
        // Absolute physical path, wrapped in the virtual id (suffix keeps esbuild off its own CSS pipeline).
        return { path: CSS_VIRTUAL_PREFIX + join(args.resolveDir, args.path) + CSS_VIRTUAL_SUFFIX, namespace: CSS_NAMESPACE }
      })
      build.onLoad({ filter: /^\0dsh-css:/, namespace: CSS_NAMESPACE }, (args) => {
        const fileId = args.path.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        const source = readFileSync(fileId)
        const { code, exports: cssExports } = transform({
          filename: fileId,
          code: source,
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classMap = {}
        for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
        // One <style data-plugin> per module file; idempotent under re-evaluation.
        // The emitted stub is the EXACT mirror of the dsh tsdown preset's
        // dsh-css-modules-inline load() output: the guard is only the
        // `typeof document` + `data-plugin-css` presence check, and the class
        // map rides the default export as a JSON literal. The advisor section
        // imports that default binding and consumes its classes in JSX, so
        // the export — and the whole stub — survives bundling unchanged.
        //
        // tagId selector-safety (F-5, QC consolidated): the guard builds
        // `style[data-plugin-css=<JSON.stringify(tagId)>]` via JS escaping,
        // NOT CSS escaping — so tagId (`dsh-advisor/<basename>`) must stay
        // CSS-attribute-selector-safe: no `"`, no `\`, no `]`. CSS-module
        // basenames satisfy this by construction (plain [A-Za-z0-9_.-] file
        // names), which is why the virtual id is allowed to carry one.
        const contents = [
          `const css = ${JSON.stringify(code.toString())};`,
          `const tagId = ${JSON.stringify(`${ID}/${basename(fileId)}`)};`,
          `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
          `  const tag = document.createElement('style');`,
          `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
          `  tag.dataset.pluginCss = tagId;`,
          `  tag.textContent = css;`,
          `  document.head.appendChild(tag);`,
          `}`,
          `export default ${JSON.stringify(classMap)};`,
        ].join('\n')
        // F-3 (QC consolidated): declare the physical css file as a watch
        // dependency (mirror of the dsh tsdown preset's addWatchFile(fileId)),
        // so a watch-mode build rebuilds when the module css changes.
        return { loader: 'js', contents, watchFiles: [fileId] }
      })
    },
  }],
})

if (result.errors.length > 0) {
  throw new Error(`client bundle build failed:\n${result.errors.map((e) => e.text).join('\n')}`)
}

// Inline bundle-contract assertions (KD-S5): the emitted text must carry the
// closure-factory load handoff, must not VALUE-import `@deepseek-ai/*` outside
// the frozen externals table, and must contain NO `import.meta` / ESM
// statements — the web loader executes this file as a classic <script>.
//
// F-1 (QC consolidated): esbuild stamps the virtual CSS-module id — including
// a raw NUL byte and the builder's absolute path — into an output comment
// (`// dsh-css-modules:\0dsh-css:<abs path>.mjs`). Strip those comment lines
// so the shipped/served artifact carries neither the NUL byte nor a local
// machine path (the regex matches the observed esbuild 0.28 comment form;
// the \x00 is the raw byte, [^\n]* the rest of the line, gm spans all of them).
const bundleText = readFileSync(OUT_FILE, 'utf8')
  .replace(/^\/\/ dsh-css-modules:\x00[^\n]*\n/gm, '')
// The strip must land in the artifact itself, not just the in-memory text.
writeFileSync(OUT_FILE, bundleText)
if (!bundleText.includes('window.__ModuleLoader__.load(') || !bundleText.includes(JSON.stringify(ID))) {
  throw new Error('client bundle contract: the closure-factory load handoff with the plugin id is missing')
}
for (const match of bundleText.matchAll(/require\(\s*["'](@deepseek-ai\/[^"']+)["']\s*\)/g)) {
  const specifier = match[1]
  if (!CLIENT_EXTERNALS.includes(specifier)) {
    throw new Error(`client bundle contract: "${specifier}" VALUE import survived the purity gate`)
  }
}
if (bundleText.includes('import.meta') || /(^|\n)\s*(import|export)\s/.test(bundleText)) {
  throw new Error('client bundle contract: emitted bundle contains import.meta / ESM statements — the classic-script loader would fail to parse it')
}
// F-1 regression (QC consolidated): the artifact must never ship a raw NUL
// byte or the builder's absolute machine path — both leaked through esbuild's
// virtual-module comment (`// dsh-css-modules:\0…`) and stripped above.
if (bundleText.includes('\u0000')) {
  throw new Error('client bundle contract: emitted bundle contains a NUL byte — esbuild virtual-module comment not stripped')
}
if (bundleText.includes('/Users/')) {
  throw new Error('client bundle contract: emitted bundle leaks a builder machine path ("/Users/")')
}
// CSS-modules inline wiring: the bundle must carry the guarded <style
// data-plugin> injection stub and the tagId of the advisor section module
// (the loader cleans up plugin-owned tags by `style[data-plugin=<id>]` +
// `data-plugin-css`; without this wiring the section renders unstyled).
for (const fragment of [
  'data-plugin',
  'document.head.appendChild',
  'dsh-advisor/advisor-section.module.css',
]) {
  if (!bundleText.includes(fragment)) {
    throw new Error(`client bundle contract: CSS-modules inline wiring missing — "${fragment}" not in the emitted bundle`)
  }
}
// Quote-agnostic: esbuild's printer normalizes string quotes, so accept both.
if (!/document\.createElement\(['"]style['"]\)/.test(bundleText)) {
  throw new Error('client bundle contract: CSS-modules inline wiring missing — document.createElement("style") not in the emitted bundle')
}
// F-2 (QC consolidated): pin the attribution the loader cleanup keys on —
// the web shell removes plugin-owned tags by `style[data-plugin=<id>]`, so the
// stub must actually assign tag.dataset.plugin (not just carry the literal
// "data-plugin" string). Quote/whitespace-normalized: match the assignment.
if (!/tag\.dataset\.plugin\s*=/.test(bundleText)) {
  throw new Error('client bundle contract: CSS-modules inline wiring missing — tag.dataset.plugin attribution (loader cleanup key) not in the emitted bundle')
}

// Declarations for `exports["./client"].types`: tsc emits the client .d.ts
// tree into lib/client/ (emitDeclarationOnly), then we write the flat
// re-export so the locked export path stays stable regardless of the internal
// layout (same shape as the mstar client bundle).
const tscBin = require.resolve('typescript/bin/tsc')
rmSync('lib/client', { recursive: true, force: true })
const tsc = spawnSync(process.execPath, [tscBin, '-p', 'tsconfig.client.json'], { stdio: 'inherit' })
if (tsc.status !== 0) {
  throw new Error(`client bundle declarations failed (tsc -p tsconfig.client.json, exit ${String(tsc.status)})`)
}
const clientDts = join('lib', 'client.d.ts')
writeFileSync(clientDts, `export * from './client/index.js'\n`)

console.log(`build-client: ${ENTRY} -> ${OUT_FILE} (closure-factory CJS) + ${clientDts}`)
