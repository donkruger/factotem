/**
 * KP Integration - Configuration
 *
 * All environment-specific settings in one place.
 * Override via environment variables or modify defaults here.
 */

import path from 'path';

// Project root - can be overridden for different deployments
const PROJECT_ROOT = process.env.NANOCLAW_ROOT || process.cwd();

/**
 * Configuration object with all settings
 */
export const config = {
  // Path to the BUILT Electron main.js (what Playwright's electron.launch() needs)
  // Run `npm run electron:build` in the KP project to produce this file.
  electronMainJs: process.env.KP_ELECTRON_MAIN || '',

  // The .app binary path for Mode B (CDP attach)
  // Use the direct-download .dmg build — Mac App Store build strips debug flags.
  electronAppPath: process.env.KP_APP_PATH
    || '/Applications/Kanban Pro.app/Contents/MacOS/Kanban Pro',

  // Default project folder to open (the demo project)
  defaultProjectPath: process.env.KP_PROJECT_PATH || '',

  // Browser viewport settings
  viewport: {
    width: 1440,
    height: 900,
  },

  // Timeouts (in milliseconds)
  timeouts: {
    appLaunch: 15000,       // Electron app startup
    navigation: 30000,      // View transitions (project open needs ~20s after reload)
    elementWait: 5000,      // Wait for element to appear
    afterClick: 500,        // Settle time after click
    afterType: 300,         // Settle time after typing
    afterDrag: 1000,        // Settle time after drag-drop
    animationSettle: 600,   // KP glass animations are ~300ms
    modalOpen: 350,         // modal-scale-in is 300ms + buffer
    debounceSave: 1200,     // KP auto-saves on 1000ms debounce — wait 1200ms to be safe
  },

  // Recording (Playwright built-in video capture)
  recording: {
    enabled: process.env.KP_RECORD === '1',
    dir: path.join(PROJECT_ROOT, 'data', 'kp-recordings'),
    size: { width: 1440, height: 900 },
  },
};
