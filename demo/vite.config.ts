import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const allowedHosts = process.env.VITE_ALLOWED_HOSTS?.split(',') ?? []

// `wrangler pages dev` fronts this on 4187 and serves the Functions; Vite runs
// behind it on 4188. Hit 4187 — 4188 alone has no API.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 4188,
    host: true,
    allowedHosts,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
