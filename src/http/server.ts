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

// W.1 (2026-05-08) — added per-checkpoint diagnostic logging so the
// fresh-install case (Don's iMac: orchestrator alive, no /health bound,
// nothing in logs explaining why) becomes debuggable from the launchd
// stdout/stderr files. Each checkpoint logs at info level so a single
// `tail -f logs/nanoclaw.log` shows how far startup progressed.
//
// Also wrapped the entire body in a try/catch so a synchronous failure
// in `mountApi` or `express.static` is surfaced rather than swallowed —
// previously a thrown error would propagate up to `main().catch()` and
// kill NanoClaw, but the launchd KeepAlive=true would silently restart
// it forever, with `runs=N` ticking up but no visible binding.
export function startHttpServer(
  deps: ApiDeps,
  port: number = NANOCLAW_HTTP_PORT,
): void {
  logger.info({ port }, 'startHttpServer: entered');

  if (app) {
    logger.warn('startHttpServer: already started, skipping');
    return;
  }

  try {
    app = express();
    logger.info('startHttpServer: express app created');

    app.get('/health', async (_req, res) => {
      try {
        const snapshot = await getHealthSnapshot();
        res.json(snapshot);
      } catch (err) {
        logger.error({ err }, 'http /health: snapshot failed');
        res.status(500).json({ error: 'health snapshot failed' });
      }
    });
    logger.info('startHttpServer: /health route mounted');

    // Mount /api/* routes (T-1778236000000)
    mountApi(app, deps);
    logger.info('startHttpServer: /api/* routes mounted');

    // Mount the dashboard static export (T-1778239000000 / Wave 3).
    // The dashboard builds to `dashboard/out/` via `next build` with
    // `output: 'export'`. Mounting is conditional so the orchestrator
    // still starts cleanly when the dashboard hasn't been built yet
    // (fresh checkout, CI, after `npm run clean`, or operators who
    // never run `npm --prefix dashboard run build`). API-only mode is
    // fine — the Doctor's multi-instance probe and the wizard's step 07
    // health-poll only need /health + /api/*.
    const dashboardOut = path.join(PROJECT_ROOT, 'dashboard', 'out');
    if (fs.existsSync(dashboardOut)) {
      app.use(express.static(dashboardOut));
      logger.info({ dashboardOut }, 'startHttpServer: dashboard static export mounted');

      // Static-export friendly fallback for dynamic routes. Next.js with
      // `output: 'export'` only generates one HTML file per dynamic-route
      // entry in `generateStaticParams()`. The dashboard ships a single
      // placeholder at `/groups/_/index.html`; any direct navigation to
      // `/groups/<real-jid>/` (shared link, refresh, link click) needs to
      // serve the same file so the client-side React app can read the JID
      // from `window.location.pathname` and fetch the right group.
      //
      // express.static runs first (above) and falls through via next() when
      // it can't find a file. This handler picks up the residue.
      const groupPlaceholder = path.join(
        dashboardOut,
        'groups',
        '_',
        'index.html',
      );
      app.get(/^\/groups\/[^/]+\/?$/, (_req, res, next) => {
        if (fs.existsSync(groupPlaceholder)) {
          res.sendFile(groupPlaceholder);
        } else {
          next();
        }
      });
    } else {
      logger.info(
        { dashboardOut },
        'startHttpServer: dashboard/out absent — API-only mode (Doctor + wizard /health still work)',
      );
    }

    // Graceful error handling — never crash NanoClaw because the dashboard
    // port is unavailable. WhatsApp + container orchestration must keep
    // running even if the dashboard port is held by another process
    // (lesson from the 2026-05-05 incident where EADDRINUSE during Baileys
    // mid-write corrupted creds.json to 0 bytes).
    const server = app.listen(port, '0.0.0.0');
    logger.info({ port }, 'startHttpServer: app.listen() called, waiting for listening event');
    server.on('listening', () => {
      const addr = server.address();
      logger.info(
        { port, address: addr },
        'startHttpServer: HTTP server listening (Tailscale-reachable)',
      );
    });
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        logger.warn(
          { port, err: err.message },
          'startHttpServer: port in use; /health + /api unavailable but NanoClaw continues. Find holder: lsof -iTCP:' + port,
        );
      } else {
        logger.error(
          { err, port, code: err.code },
          'startHttpServer: app.listen failed; continuing without HTTP server',
        );
      }
    });
  } catch (err) {
    // Defense-in-depth: if anything in the setup above throws synchronously
    // (mountApi, express.static, route registration), log it at error level
    // and KEEP NanoClaw alive — message processing + WhatsApp + containers
    // do not depend on the HTTP server. This also makes "orchestrator alive
    // but /health unreachable" debuggable from logs alone.
    logger.error(
      { err },
      'startHttpServer: setup failed before listen; HTTP server unavailable but NanoClaw continues',
    );
  }
}
