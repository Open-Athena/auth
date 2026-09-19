import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Subagent worktrees live under `.claude/worktrees/`; without this vitest's
    // default glob descends into each one and re-runs its whole suite, so a
    // parallel build inflates the count and slows every run. Keep the built-in
    // excludes (node_modules, dist, …) and add the worktree root.
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
})
