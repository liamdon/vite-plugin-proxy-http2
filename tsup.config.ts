import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  minify: false,
  target: 'node14',
  shims: true,
  splitting: false,
  treeshake: true,
  outExtension({ format }) {
    return {
      js: format === 'esm' ? '.mjs' : '.js'
    }
  }
})