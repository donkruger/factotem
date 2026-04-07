/**
 * KP Integration - Visual Demo Cursor
 *
 * Injects a fake cursor element into the page that appears in Playwright's
 * recordVideo output. Smoothly animates between positions and shows click
 * ripple effects to make demo recordings look human-driven.
 *
 * When recording is disabled, all methods delegate directly to Playwright's
 * native page.mouse / locator.click() with no overhead.
 */

import { Page, Locator } from 'playwright';
import { config } from './config.js';

const CURSOR_ID = 'kp-demo-cursor';
const RING_ID = 'kp-demo-click-ring';

// Duration of the cursor move animation (ms). Tuned for smooth 30fps video.
const MOVE_DURATION = 400;
// Extra wait after move to let CSS transition finish before next action
const MOVE_SETTLE = 80;

export class DemoCursor {
  private page: Page;
  private enabled: boolean;
  private lastX = 0;
  private lastY = 0;

  constructor(page: Page, forceEnable?: boolean) {
    this.page = page;
    this.enabled = forceEnable ?? config.recording.enabled;
  }

  /** Inject the cursor and click-ring elements. Call once after page is ready. */
  async init(): Promise<void> {
    if (!this.enabled) return;

    await this.page.evaluate(({ cursorId, ringId }) => {
      // Remove any existing cursor (e.g. after reload)
      document.getElementById(cursorId)?.remove();
      document.getElementById(ringId)?.remove();

      // --- Cursor: classic pointer arrow ---
      const cursor = document.createElement('div');
      cursor.id = cursorId;
      cursor.innerHTML = `<svg width="20" height="24" viewBox="0 0 20 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M2 1L18 10.5L10 12.5L7.5 20.5L2 1Z" fill="white" stroke="black" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>`;
      Object.assign(cursor.style, {
        position: 'fixed',
        left: '0px',
        top: '0px',
        zIndex: '2147483647',
        pointerEvents: 'none',
        filter: 'drop-shadow(1px 2px 3px rgba(0,0,0,0.35))',
        willChange: 'transform',
        transform: 'translate(0px, 0px)',
        transition: `transform ${MOVE_DURATION}ms cubic-bezier(0.25, 0.1, 0.25, 1)`,
      });
      document.body.appendChild(cursor);

      // --- Click ring ---
      const ring = document.createElement('div');
      ring.id = ringId;
      Object.assign(ring.style, {
        position: 'fixed',
        left: '0px',
        top: '0px',
        width: '28px',
        height: '28px',
        borderRadius: '50%',
        border: '2.5px solid rgba(59, 130, 246, 0.8)',
        backgroundColor: 'rgba(59, 130, 246, 0.12)',
        pointerEvents: 'none',
        zIndex: '2147483646',
        opacity: '0',
        willChange: 'transform, opacity',
        transform: 'translate(-50%, -50%) scale(0.4)',
        transition: 'none',
      });
      document.body.appendChild(ring);
    }, { cursorId: CURSOR_ID, ringId: RING_ID });
  }

  /** Smoothly move the visual cursor to (x, y), then sync the real mouse. */
  async move(x: number, y: number, opts?: { steps?: number }): Promise<void> {
    if (this.enabled) {
      await this.animateTo(x, y);
    }
    await this.page.mouse.move(x, y, opts);
    this.lastX = x;
    this.lastY = y;
  }

  /** Move cursor to a locator's center. Does NOT click. */
  async moveToLocator(locator: Locator): Promise<{ x: number; y: number }> {
    const box = await locator.boundingBox();
    if (!box) throw new Error('Element not visible — cannot move cursor to it');
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await this.move(x, y);
    return { x, y };
  }

  /** Move cursor to element, show click effect, then click. */
  async click(locator: Locator, opts?: { clickCount?: number }): Promise<void> {
    if (this.enabled) {
      const box = await locator.boundingBox();
      if (box) {
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        await this.animateTo(x, y);
        await this.showClickRing(x, y);
        this.lastX = x;
        this.lastY = y;
      }
    }
    await locator.click(opts);
  }

  /** Press mouse down at current position with visual feedback. */
  async down(): Promise<void> {
    if (this.enabled) {
      await this.showClickRing(this.lastX, this.lastY);
    }
    await this.page.mouse.down();
  }

  /** Release mouse. */
  async up(): Promise<void> {
    await this.page.mouse.up();
  }

  /** Type text using keyboard. No cursor movement needed. */
  async type(text: string): Promise<void> {
    await this.page.keyboard.type(text);
  }

  /** Press a key combo. */
  async press(key: string): Promise<void> {
    await this.page.keyboard.press(key);
  }

  // ─── Internal helpers ──────────────────────────────────

  private async animateTo(x: number, y: number): Promise<void> {
    await this.page.evaluate(({ cursorId, x, y }) => {
      const el = document.getElementById(cursorId);
      if (el) {
        el.style.transform = `translate(${x}px, ${y}px)`;
      }
    }, { cursorId: CURSOR_ID, x, y });
    await this.page.waitForTimeout(MOVE_DURATION + MOVE_SETTLE);
  }

  private async showClickRing(x: number, y: number): Promise<void> {
    await this.page.evaluate(({ ringId, x, y }) => {
      const ring = document.getElementById(ringId);
      if (!ring) return;
      // Reset instantly
      ring.style.transition = 'none';
      ring.style.opacity = '0';
      ring.style.transform = `translate(calc(${x}px - 50%), calc(${y}px - 50%)) scale(0.4)`;
      // Force reflow so reset takes effect
      void ring.offsetHeight;
      // Animate in
      ring.style.transition = 'opacity 0.12s ease-out, transform 0.12s ease-out';
      ring.style.opacity = '1';
      ring.style.transform = `translate(calc(${x}px - 50%), calc(${y}px - 50%)) scale(1)`;
      // Animate out
      setTimeout(() => {
        ring.style.transition = 'opacity 0.25s ease-in, transform 0.25s ease-in';
        ring.style.opacity = '0';
        ring.style.transform = `translate(calc(${x}px - 50%), calc(${y}px - 50%)) scale(1.6)`;
      }, 180);
    }, { ringId: RING_ID, x, y });
    // Wait for the click animation to peak (not the full fade-out)
    await this.page.waitForTimeout(150);
  }
}
