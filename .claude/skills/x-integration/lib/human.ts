/**
 * Human-like browser interaction primitives
 *
 * Replaces Playwright's instant .click()/.fill() with naturalistic mouse
 * movement, keystroke timing, and randomised delays to reduce bot-detection
 * risk on X (Twitter).
 */

import { Page, Locator } from 'playwright';
import { config } from './config.js';

const h = config.humanisation;

// ---------------------------------------------------------------------------
// Random helpers
// ---------------------------------------------------------------------------

/** Random integer in [min, max] inclusive */
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Random float in [min, max) */
function randFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

/**
 * Sleep for a random duration between min and max ms.
 * Uses a slight right-skew (square-root distribution) to mimic human
 * reaction times — most pauses are short, occasional ones are longer.
 */
export function randomDelay(min: number, max: number): Promise<void> {
  const t = Math.sqrt(Math.random()); // skew toward lower end
  const ms = Math.round(min + t * (max - min));
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Replace fixed waitForTimeout with +/- variance.
 * e.g. humanWait(1000) with 0.3 variance → 700-1300ms
 */
export async function humanWait(baseMs: number): Promise<void> {
  const variance = h.delayVariance;
  const min = Math.round(baseMs * (1 - variance));
  const max = Math.round(baseMs * (1 + variance));
  await randomDelay(min, max);
}

// ---------------------------------------------------------------------------
// Mouse movement
// ---------------------------------------------------------------------------

/** Pick a random point inside an element's bounding box (not dead centre) */
async function randomPointInElement(
  locator: Locator,
): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Element has no bounding box');
  // Stay within the inner 70% to avoid edges
  const padX = box.width * 0.15;
  const padY = box.height * 0.15;
  return {
    x: box.x + padX + Math.random() * (box.width - 2 * padX),
    y: box.y + padY + Math.random() * (box.height - 2 * padY),
  };
}

/**
 * Move mouse to a target element with a natural curved path.
 * Uses quadratic Bezier interpolation with a randomised control point.
 */
export async function humanMove(
  page: Page,
  target: Locator,
): Promise<{ x: number; y: number }> {
  const dest = await randomPointInElement(target);

  // Current mouse position (default to a random-ish starting point if unknown)
  const viewport = page.viewportSize() || { width: 1280, height: 800 };
  const start = {
    x: randFloat(viewport.width * 0.3, viewport.width * 0.7),
    y: randFloat(viewport.height * 0.3, viewport.height * 0.7),
  };

  // Quadratic Bezier control point — offset from midpoint for curvature
  const ctrl = {
    x: (start.x + dest.x) / 2 + randFloat(-80, 80),
    y: (start.y + dest.y) / 2 + randFloat(-60, 60),
  };

  const steps = randInt(h.mouse.steps[0], h.mouse.steps[1]);

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // Quadratic Bezier: B(t) = (1-t)^2*P0 + 2(1-t)t*P1 + t^2*P2
    const x = (1 - t) ** 2 * start.x + 2 * (1 - t) * t * ctrl.x + t ** 2 * dest.x;
    const y = (1 - t) ** 2 * start.y + 2 * (1 - t) * t * ctrl.y + t ** 2 * dest.y;
    await page.mouse.move(x, y);
    await randomDelay(h.mouse.stepDelay[0], h.mouse.stepDelay[1]);
  }

  // Occasional overshoot-and-correct (~30% of moves)
  if (Math.random() < h.mouse.overshootChance) {
    const overshoot = {
      x: dest.x + randFloat(-12, 12),
      y: dest.y + randFloat(-8, 8),
    };
    await page.mouse.move(overshoot.x, overshoot.y);
    await randomDelay(40, 90);
    await page.mouse.move(dest.x, dest.y);
    await randomDelay(20, 50);
  }

  return dest;
}

// ---------------------------------------------------------------------------
// Click
// ---------------------------------------------------------------------------

/**
 * Human-like click: move to element, pause, mousedown, hold, mouseup.
 */
export async function humanClick(
  page: Page,
  target: Locator,
): Promise<void> {
  // Scroll into view first if needed
  await humanScroll(page, target);

  const pos = await humanMove(page, target);

  // Pre-click pause (finger approaching)
  await randomDelay(h.click.preDelay[0], h.click.preDelay[1]);

  // Physical click: down → hold → up
  await page.mouse.down({ button: 'left' });
  await randomDelay(h.click.holdDuration[0], h.click.holdDuration[1]);
  await page.mouse.up({ button: 'left' });

  // Post-click settle
  await randomDelay(h.click.postDelay[0], h.click.postDelay[1]);
}

// ---------------------------------------------------------------------------
// Typing
// ---------------------------------------------------------------------------

/**
 * Human-like typing: click into element, then type character by character
 * with variable inter-key delays and occasional word-boundary pauses.
 */
export async function humanType(
  page: Page,
  target: Locator,
  text: string,
): Promise<void> {
  // Focus the input
  await humanClick(page, target);

  const pauseEvery = randInt(h.typing.pauseEvery[0], h.typing.pauseEvery[1]);
  let charsSincePause = 0;

  for (const char of text) {
    if (char === '\n') {
      await page.keyboard.press('Enter');
    } else {
      await page.keyboard.type(char);
    }
    await randomDelay(h.typing.minDelay, h.typing.maxDelay);

    charsSincePause++;
    // Word-boundary pause
    if (charsSincePause >= pauseEvery || char === ' ' && charsSincePause > pauseEvery * 0.6) {
      if (Math.random() < 0.4) {
        await randomDelay(h.typing.pauseDuration[0], h.typing.pauseDuration[1]);
        charsSincePause = 0;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Scrolling
// ---------------------------------------------------------------------------

/**
 * Scroll an element into view with incremental, natural-looking scroll steps.
 * No-op if the element is already visible in the viewport.
 */
export async function humanScroll(
  page: Page,
  target: Locator,
): Promise<void> {
  const box = await target.boundingBox().catch(() => null);
  if (!box) return; // Element not yet in DOM — let waitFor handle it

  const viewport = page.viewportSize() || { width: 1280, height: 800 };

  // Check if already in viewport (with some margin)
  const margin = 50;
  const inView =
    box.y >= -margin &&
    box.y + box.height <= viewport.height + margin;

  if (inView) return;

  // Calculate how far we need to scroll
  const targetY = box.y - viewport.height / 2 + box.height / 2;
  const steps = randInt(h.scroll.steps[0], h.scroll.steps[1]);
  const perStep = targetY / steps;

  for (let i = 0; i < steps; i++) {
    // Slight horizontal jitter on ~20% of scrolls
    const deltaX = Math.random() < 0.2 ? randFloat(-15, 15) : 0;
    await page.mouse.wheel(deltaX, perStep);
    await randomDelay(h.scroll.stepDelay[0], h.scroll.stepDelay[1]);
  }

  // Brief settle after scrolling
  await randomDelay(150, 350);
}
