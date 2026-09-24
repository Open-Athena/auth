import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// `wrangler pages dev` fronts this on 4187 and serves the Functions; Vite runs
// behind it on 4188. Hit 4187 — 4188 alone has no API.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 4188,
    host: true,
    allowedHosts: true,  // trusted-tailnet dev server, reached by bare MagicDNS name (e.g. `m3:4187`)
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
