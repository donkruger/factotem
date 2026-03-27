/**
 * X Integration - Configuration
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
  // Chrome executable path
  // Default: standard macOS Chrome location
  // Override: CHROME_PATH environment variable
  chromePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',

  // Browser profile directory for persistent login sessions
  browserDataDir: path.join(PROJECT_ROOT, 'data', 'x-browser-profile'),

  // Auth state marker file
  authPath: path.join(PROJECT_ROOT, 'data', 'x-auth.json'),

  // Browser viewport settings
  viewport: {
    width: 1280,
    height: 800,
  },

  // Timeouts (in milliseconds)
  timeouts: {
    navigation: 30000,
    elementWait: 5000,
    afterClick: 1000,
    afterFill: 1000,
    afterSubmit: 3000,
    pageLoad: 3000,
  },

  // X character limits
  limits: {
    tweetMaxLength: 280,
  },

  // Human-like interaction parameters (used by lib/human.ts)
  humanisation: {
    enabled: true,
    typing: { minDelay: 40, maxDelay: 120, pauseEvery: [8, 15] as [number, number], pauseDuration: [200, 400] as [number, number] },
    mouse: { steps: [3, 6] as [number, number], stepDelay: [15, 40] as [number, number], overshootChance: 0.3 },
    click: { preDelay: [50, 150] as [number, number], holdDuration: [80, 200] as [number, number], postDelay: [200, 600] as [number, number] },
    scroll: { steps: [2, 4] as [number, number], stepDelay: [100, 300] as [number, number] },
    delayVariance: 0.3, // +/- 30% on all fixed timeouts
  },

  // Chrome launch arguments
  chromeArgs: [
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
  ],

  // Args to ignore when launching Chrome
  chromeIgnoreDefaultArgs: ['--enable-automation'],
};

