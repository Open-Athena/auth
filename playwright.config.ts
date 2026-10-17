import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './test-browser',
  outputDir: './tmp/browser-results',
  use: { baseURL: 'http://localhost:4190', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], colorScheme: 'dark' } },
    { name: 'desktop-light', use: { ...devices['Desktop Chrome'], colorScheme: 'light' } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: {
    command: 'pnpm --filter @open-athena/auth-demo exec vite preview --host 127.0.0.1 --port 4190 --strictPort',
    url: 'http://localhost:4190',
    reuseExistingServer: false,
  },
})
