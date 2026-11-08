import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  // `broker/`'s tests run from source, before CI's build makes `dist/`.
  resolve: {
    alias: [
      { find: /^@open-athena\/auth\/provider$/, replacement: fileURLToPath(new URL('./src/provider/index.ts', import.meta.url)) },
      { find: /^@open-athena\/auth\/provider\/d1$/, replacement: fileURLToPath(new URL('./src/adapters/d1-provider.ts', import.meta.url)) },
    ],
  },
  test: {
    // Subagent worktrees live under `.claude/worktrees/`; without this vitest's
    // default glob descends into each one and re-runs its whole suite, so a
    // parallel build inflates the count and slows every run. Keep the built-in
    // excludes (node_modules, dist, …) and add both worktree roots (`wt/` is
    // where hand-made worktrees live).
    exclude: [...configDefaults.exclude, '.claude/**', 'wt/**', 'test-browser/**'],
  },
})
