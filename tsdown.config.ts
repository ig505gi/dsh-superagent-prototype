import { defineConfig } from 'tsdown'

// Per-session tool scripts and detached job runners reference stable sibling paths.
export default defineConfig({
  entry: ['src/index.ts', 'src/server/main.ts', 'src/runtime/tool-cli.ts', 'src/runtime/job-runner.ts',
    'src/sources/github.ts', 'src/sources/gitlab.ts', 'src/sources/feishu.ts', 'src/sources/dingtalk.ts', 'src/sources/paseo.ts'],
  root: 'src',
  unbundle: true,
  outDir: 'lib',
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  deps: { neverBundle: [/^@getpaseo\//, 'zod', 'proper-lockfile', 'dingtalk-stream'] },
})
