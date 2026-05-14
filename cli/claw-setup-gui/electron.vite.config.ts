import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Explicit entry points + externalizeDepsPlugin.
//
// electron-vite v5's auto-discovery sometimes fails to pick up
// `src/main/index.ts` / `src/preload/index.ts` from a bare `main: {}`
// config; spelling the entries out is the safe form. externalizeDepsPlugin
// keeps Node built-ins + electron itself out of the main/preload bundles
// (they're resolved at runtime by Electron, not bundled).
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: resolve('src/main/index.ts')
      }
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: resolve('src/preload/index.ts')
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: resolve('src/renderer/index.html')
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
