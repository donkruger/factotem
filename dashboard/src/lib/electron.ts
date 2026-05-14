'use client';

import { useEffect, useState } from 'react';

/*
 * Bridge from the dashboard to the Electron wizard shell.
 *
 * The dashboard's bundle is served by the orchestrator at :7842, but
 * when the user opens it via the NanoClaw Setup wizard's BrowserWindow
 * (cli/claw-setup-gui), our preload script attaches `window.electronAPI`
 * to this same page. That gives the dashboard a programmatic path back
 * to the wizard for things like "WhatsApp says not paired, open the
 * pairing step" — no extra IPC infrastructure, no separate window.
 *
 * Plain browser visits (Tailscale or localhost from Chrome) see
 * `window.electronAPI === undefined` and the wizard affordances simply
 * don't render. Same dashboard code, two surfaces.
 */

interface WizardBridge {
  open: (stepHint?: WizardStep) => Promise<{ success: boolean }>;
}

interface ElectronBridge {
  wizard?: WizardBridge;
}

declare global {
  interface Window {
    electronAPI?: ElectronBridge;
  }
}

// Mirrors cli/claw-setup-gui's StepId so callers get IDE completions.
// Update both files in lockstep when adding wizard steps.
export type WizardStep =
  | 'welcome'
  | 'profile'
  | 'envCheck'
  | 'install'
  | 'onecli'
  | 'mounts'
  | 'container'
  | 'whatsapp'
  | 'service'
  | 'register'
  | 'openmode'
  | 'smoke'
  | 'ready';

export function useElectronWizard(): WizardBridge | null {
  const [bridge, setBridge] = useState<WizardBridge | null>(null);

  useEffect(() => {
    // The preload may attach after the first React mount, so poll
    // briefly. Same pattern the wizard's useElectronAPI hook uses for
    // its own preload-race window.
    if (typeof window === 'undefined') return;
    if (window.electronAPI?.wizard) {
      setBridge(window.electronAPI.wizard);
      return;
    }
    const started = Date.now();
    const id = setInterval(() => {
      if (window.electronAPI?.wizard) {
        setBridge(window.electronAPI.wizard);
        clearInterval(id);
      } else if (Date.now() - started > 2000) {
        clearInterval(id);
      }
    }, 100);
    return () => clearInterval(id);
  }, []);

  return bridge;
}
