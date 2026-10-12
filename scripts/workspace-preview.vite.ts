import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { runtimeMiddleware } from './runtime-middleware'

export default defineConfig({
  root: path.resolve('src/renderer'),
  plugins: [runtimeMiddleware(), react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve('src/renderer/src'), '@shared': path.resolve('src/shared') }
  },
  server: {
    host: '127.0.0.1',
    port: 5187,
    strictPort: true,
    watch: { ignored: ['**/out/**', '**/release/**'] }
  }
})
