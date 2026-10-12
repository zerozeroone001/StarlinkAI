import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
export default defineConfig({
  root: path.resolve('scripts'),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve('src/renderer/src'), '@shared': path.resolve('src/shared') } },
  server: { host: '127.0.0.1', port: 5191, strictPort: true, fs: { allow: [path.resolve('.')] } }
})
