/**
 * HTTP server for the Factotem dashboard.
 *
 * Binds to a Tailscale-local port (default 3000). Serves the `/health`
 * snapshot endpoint and (later, T-1778236000000) the `/api/*` REST
 * routes the dashboard calls.
 *
 * Tailscale-trust is the only network boundary per Q1 of the dashboard
 * decisions — there's no app-level auth in v1.
 *
 * T-1778233000000 (Phase 0.1 of Factotem Dashboard v1 epic).
 */

import fs from 'fs';
import path from 'path';

import express, { type Express } from 'express';

import { NANOCLAW_HTTP_PORT, PROJECT_ROOT } from '../config.js';
import { logger } from '../logger.js';
import { mountApi, type ApiDeps } from './api.js';
import { getHealthSnapshot } from './health.js';

let app: Express | undefined;

export function startHttpServer(
  deps: ApiDeps,
  port: number = NANOCLAW_HTTP_PORT,
): void {
  if (app) {
    logger.warn('http server: already started, skipping');
    return;
  }

  app = express();

  app.get('/health', async (_req, res) => {
    try {
      const snapshot = await getHealthSnapshot();
      res.json(snapshot);
    } catch (err) {
      logger.error({ err }, 'http /health: snapshot failed');
      res.status(500).json({ error: 'health snapshot failed' });
    }
  });

  // Mount /api/* routes (T-1778236000000)
  mountApi(app, deps);

  // Mount the dashboard static export (T-1778239000000 / Wave 3).
  // The dashboard builds to `dashboard/out/` via `next build` with
  // `output: 'export'`. Mounting is conditional so the orchestrator still
  // starts cleanly when the dashboard hasn't been built yet (e.g. fresh
  // checkout, CI, or after `npm run clean`).
  const dashboardOut = path.join(PROJECT_ROOT, 'dashboard', 'out');
  if (fs.existsSync(dashboardOut)) {
    app.use(express.static(dashboardOut));
    logger.info({ dashboardOut }, 'dashboard static export mounted');
  } else {
    logger.warn(
      { dashboardOut },
      'dashboard/out not found — run `cd dashboard && npm run build`',
    );
  }

  // Graceful error handling — never crash NanoClaw because the dashboard
  // port is unavailable. WhatsApp + container orchestration must keep
  // running even if the dashboard port is held by another process
  // (lesson from the 2026-05-05 incident where EADDRINUSE during Baileys
  // mid-write corrupted creds.json to 0 bytes).
  const server = app.listen(port, '0.0.0.0');
  server.on('listening', () => {
    logger.info({ port }, 'HTTP server listening (Tailscale-reachable)');
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn(
        { port, err: err.message },
        'HTTP server port in use; dashboard endpoint will be unavailable but NanoClaw continues',
      );
    } else {
      logger.error({ err, port }, 'HTTP server failed; continuing without it');
    }
  });
}
