import { copyFileSync, rmSync, writeFileSync } from 'node:fs'

import { defineConfig } from 'tsdown'

const deps = {
  dts: {
    neverBundle: [/^typescript(?:\/|$)/],
  },
  onlyBundle: false as const,
}

/**
 * Every output path, and every file the build:done hooks write, is specified in
 * docs/architecture.md, "Public surface".
 */
export default defineConfig([
  {
    cjsDefault: true,
    deps,
    dts: true,
    entry: { index: 'src/index.ts' },
    fixedExtension: true,
    format: 'cjs',
    hooks: {
      'build:done': () => {
        copyFileSync('lib/index.cjs', 'lib/index.js')
        rmSync('lib/index.cjs')
        copyFileSync('lib/index.d.cts', 'lib/index.d.ts')
        writeFileSync('lib/package.json', `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`)
      },
    },
    outDir: 'lib',
    platform: 'node',
    target: 'node14',
  },
  {
    deps,
    dts: true,
    entry: { 'esm/api': 'src/api.ts' },
    fixedExtension: true,
    format: ['esm', 'cjs'],
    hooks: {
      'build:done': () => {
        writeFileSync('lib/api.js', "module.exports = require('./esm/api.cjs')\n")
        writeFileSync('lib/api.d.ts', "export * from './esm/api.cjs'\n")
      },
    },
    outDir: 'lib',
    platform: 'node',
    target: 'node14',
  },
])
