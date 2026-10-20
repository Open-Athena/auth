import { defineConfig } from '@playwright/test'
import base from './playwright.config.js'

// Start `pnpm --filter @open-athena/auth-demo dev` first. Local only: these
// tests mint real demo links and exercise real session cookies/D1 rows.
export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: '**/live/**/*.spec.ts',
  outputDir: './tmp/browser-live-results',
  use: { ...base.use, baseURL: 'http://localhost:4187' },
  webServer: undefined,
})
