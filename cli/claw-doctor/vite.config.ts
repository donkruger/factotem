import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite config for Tauri 2. The dev server runs on a fixed port so
// `tauri.conf.json`'s `devUrl` matches.
export default defineConfig(async () => ({
  plugins: [react()],
  // Tauri expects a fixed port; reject if it's busy rather than auto-pick.
  clearScreen: false,
  server: {
    port: 1422,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: 'es2022',
    minify: 'esbuild',
    sourcemap: false,
  },
}));
