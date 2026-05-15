import { useEffect, useRef, useState } from 'react'
import type { SceneHandle } from './scene/createScene'

interface Props {
  /** Square render size in CSS pixels. The Factotem marketing site uses
   *  `clamp(360px, 65vh, 720px)`; the installer wants a fixed slot
   *  (≈33 % larger than the original 180 px disk). */
  size?: number
  /** Caller-controlled className for layout / margins. */
  className?: string
}

/**
 * Animated brand-mark disk for the NanoClaw intro screen. The scene
 * machinery (Three.js orb + ring of blade instances + shader-patched
 * gradient) is ported verbatim from the Factotem marketing site —
 * see `components/scene/*` and Factotem `docs/hero-scene.md`. This
 * component is just the installer-side React glue: mount a fixed-size
 * container, start an rAF loop, dispose on unmount.
 *
 * What's deliberately *not* here: the scroll-dock GSAP timeline and the
 * SVG poster swap from `HeroScene.tsx`. The installer doesn't scroll
 * and the canvas mounts inside a static layout, so we go straight to
 * the hero pose and stay there.
 *
 * Reduced-motion handling: matches the marketing site — render the
 * docked top-down "logo" pose once via `setProgress(0)` and hold (no
 * rAF, no animation). The blade ring still reads as a flat disk.
 */
export function HeroDisk({ size = 240, className }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const handleRef = useRef<SceneHandle | null>(null)
  const [reduced, setReduced] = useState<boolean | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      setReduced(true)
      return
    }
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mq.matches)
    const handler = (event: MediaQueryListEvent) => setReduced(event.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  useEffect(() => {
    if (reduced === null) return

    const container = containerRef.current
    if (!container) return

    let raf = 0
    let last = performance.now()
    let cancelled = false

    // Dynamic import so the Three.js bundle is split out of the initial
    // renderer chunk — the installer first paint never needs WebGL.
    void import('./scene/createScene').then(({ createScene }) => {
      if (cancelled) return
      const handle = createScene(container)
      handleRef.current = handle

      if (reduced) {
        // Static "logo" rendition for users who asked for less motion.
        handle.setProgress(0)
        return
      }

      const tick = (now: number) => {
        const dt = Math.min(0.05, (now - last) / 1000)
        last = now
        handle.update(dt)
        raf = requestAnimationFrame(tick)
      }
      last = performance.now()
      raf = requestAnimationFrame(tick)
    })

    return () => {
      cancelled = true
      if (raf) cancelAnimationFrame(raf)
      handleRef.current?.dispose()
      handleRef.current = null
    }
  }, [reduced])

  // `hero-disk` class is defined in `assets/main.css` — it carries the
  // hover-scale transition (kept out of inline styles so the `:hover`
  // pseudo-class works). The Tailwind `hover:scale-[1.05]` arbitrary
  // class would work too, but a named class keeps the easing curve and
  // duration explicit and lets us tune them in one place.
  const classes = ['hero-disk', className].filter(Boolean).join(' ')

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label="NanoClaw"
      className={classes}
      style={{
        width: size,
        height: size,
        // Pre-mount the slot at full size so the layout doesn't reflow
        // when the canvas appends — matches the old Mascot's footprint.
        display: 'inline-block',
      }}
    />
  )
}
