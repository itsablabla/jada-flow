import { defineConfig } from 'vite'
import { frontendConfig } from './vite.config.ts'

export default defineConfig({
  ...frontendConfig(),
  base: './',
  build: { outDir: 'dist/preview', rollupOptions: { input: 'preview.html' } },
})
