import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve('src/renderer/src'), '@shared': path.resolve('src/shared') } },
  server: {
    host: '127.0.0.1', port: 5184, strictPort: true,
    watch: { ignored: ['**/out/**', '**/release/**'] }
  }
})
