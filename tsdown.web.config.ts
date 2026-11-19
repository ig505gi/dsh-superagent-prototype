import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'tsdown'

// `?raw` imports a file as its text, as Vite and vitest do; tsdown refuses `.css` ids without @tsdown/css, so this loads them.
const raw = {
  name: 'raw',
  resolveId: (source: string, importer?: string) => source.endsWith('?raw') && importer ? resolve(dirname(importer), source) : undefined,
  load: (id: string) => id.endsWith('?raw')
    ? { code: `export default ${JSON.stringify(readFileSync(id.slice(0, -4), 'utf8'))}`, moduleType: 'js' as const }
    : undefined,
}

export default defineConfig({
  entry: { client: 'src/client/index.tsx' },
  outDir: 'web/assets',
  format: 'esm',
  fixedExtension: false,
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  deps: { alwaysBundle: [/^react($|\/)/, /^react-dom($|\/)/], onlyBundle: false },
  plugins: [raw],
  outputOptions: { entryFileNames: 'client.js' },
})
