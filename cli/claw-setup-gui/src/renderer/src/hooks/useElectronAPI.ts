import { useEffect, useState } from 'react'

// Single chokepoint for `window.electronAPI` access.
//
// Why this exists: on cold start (no `out/` directory yet), electron-vite's
// dev server can render the React tree before the preload bundle finishes
// compiling. The renderer briefly sees `window.electronAPI === undefined`,
// and any unguarded access crashes the component tree. This hook polls for
// the API every 100ms (up to 5s) and re-renders when it appears.
//
// Returns `null` while waiting. Components should render a quiet loading
// state in that branch; never assume the API is ready synchronously.
export function useElectronAPI(): Window['electronAPI'] | null {
  const [api, setApi] = useState<Window['electronAPI'] | null>(
    typeof window !== 'undefined' && window.electronAPI ? window.electronAPI : null
  )

  useEffect(() => {
    if (api) return
    const startedAt = Date.now()
    const timeoutMs = 5000
    const id = setInterval(() => {
      if (typeof window !== 'undefined' && window.electronAPI) {
        setApi(window.electronAPI)
        clearInterval(id)
      } else if (Date.now() - startedAt > timeoutMs) {
        // Stop polling — preload almost certainly failed to load. The UI
        // can decide how to surface this; we just stop spinning the CPU.
        clearInterval(id)
        console.error(
          'electronAPI did not attach within 5s — preload script likely failed to load. ' +
            'Check the main process console for module-resolution errors.'
        )
      }
    }, 100)
    return () => clearInterval(id)
  }, [api])

  return api
}
