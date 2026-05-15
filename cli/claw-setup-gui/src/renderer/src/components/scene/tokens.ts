/**
 * Scene tokens for the NanoClaw intro disk — ported verbatim from the
 * Factotem marketing site (`src/components/scene/tokens.ts`). These values
 * are not arbitrary: they come from a visual-match pass on the marketing
 * scene and shouldn't be re-tuned without a documented reason. See
 * Factotem `docs/hero-scene.md` for the tuning rationale.
 *
 * For the installer the canvas is small (≈180 px) and renders against the
 * panel background. We keep `SCENE_BACKGROUND = null` so the WelcomeStep's
 * cream/white panel shows through; only the orb + blades paint pixels.
 */
export const SCENE_BACKGROUND: string | null = null;

export const HERO_DEFAULTS = {
  desktop: {
    count: 50,
    cameraPosition: [-0.62, -7.74, 8.54] as const,
  },
  mobile: {
    count: 40,
    cameraPosition: [-0.62, -9.5, 10.5] as const,
  },
} as const;

export const PALETTE = {
  base: '#FFFFFF',
  active: '#6A00FF',
  tip: '#FF8800',
} as const;

export const ORB_DEFAULTS = {
  emissive: 0xff7a3a,
  emissiveIntensity: 1.4,
  metalness: 0.6,
  roughness: 0.15,
  lightColor: 0xff8a5c,
  lightIntensity: 4.5,
  lightDistance: 4,
  radius: 0.1,
  displacementOffset: 0.18,
} as const;

export const RENDER_DEFAULTS = {
  exposure: 1.15,
  environmentIntensity: 1.4,
} as const;

export const RING_DEFAULTS = {
  radius: 2.5,
  influence: 2,
  rotationStrength: 0.5,
  displacement: 0.5,
} as const;

export const ANIMATION_DEFAULTS = {
  speed: 0.45,
} as const;

export const PROGRESS_TARGETS = {
  exposureHero: RENDER_DEFAULTS.exposure,
  exposureDocked: 1.35,
  /** Top-down view from +Z axis (logo rendition). */
  cameraPositionDocked: [0, 0, 12] as const,
  displacementHero: RING_DEFAULTS.displacement,
  displacementDocked: 0,
} as const;

export const MOBILE_BREAKPOINT_PX = 768;
