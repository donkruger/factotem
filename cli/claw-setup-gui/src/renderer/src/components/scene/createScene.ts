import {
  ACESFilmicToneMapping,
  Color,
  PCFSoftShadowMap,
  PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { attachEnvironment, type EnvironmentHandle } from './environment';
import { createBlades, type BladesHandle } from './blades';
import { createOrb, type OrbHandle } from './orb';
import {
  ANIMATION_DEFAULTS,
  HERO_DEFAULTS,
  MOBILE_BREAKPOINT_PX,
  ORB_DEFAULTS,
  PALETTE,
  PROGRESS_TARGETS,
  RENDER_DEFAULTS,
  RING_DEFAULTS,
  SCENE_BACKGROUND,
} from './tokens';

// Three.js scene factory — ported from the Factotem marketing site
// (`src/components/scene/createScene.ts`). The marketing site uses this
// same module to drive its hero brand-mark; we reuse it verbatim so the
// installer's intro disk renders identically and any future tuning lands
// in one place.
//
// What was dropped from the port: the marketing `HeroScene.tsx` React
// wrapper (scroll-dock GSAP timeline + reduced-motion poster swap). The
// installer doesn't scroll, so `setProgress` is kept on the handle but
// never driven below 1 by the wrapper — see `HeroDisk.tsx`.

export type SceneParams = {
  count: number;
  radius: number;
  influence: number;
  speed: number;
  rotationStrength: number;
  displacement: number;
  palette: { base: string; active: string; tip: string };
  exposure: number;
  environmentIntensity: number;
  /** `null` = transparent canvas (orb + blades only, everything else see-through). */
  background: string | null;
  orb: {
    emissive: number;
    emissiveIntensity: number;
    lightColor: number;
    lightIntensity: number;
    lightDistance: number;
  };
  cameraPosition: readonly [number, number, number];
};

export type SceneHandle = {
  /** Per-frame tick. Pass the rAF delta in seconds. */
  update: (dt: number) => void;
  /** 1 = full hero pose, 0 = top-down "logo" pose. */
  setProgress: (p: number) => void;
  /** Live tweaks. */
  setParams: (patch: Partial<SceneParams>) => void;
  /** Tear down GL context, listeners, materials, geometries. */
  dispose: () => void;
};

function resolveDefaults(_container: HTMLElement, initial?: Partial<SceneParams>): SceneParams {
  const isMobile =
    typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT_PX;
  const device = isMobile ? HERO_DEFAULTS.mobile : HERO_DEFAULTS.desktop;

  const base: SceneParams = {
    count: device.count,
    radius: RING_DEFAULTS.radius,
    influence: RING_DEFAULTS.influence,
    speed: ANIMATION_DEFAULTS.speed,
    rotationStrength: RING_DEFAULTS.rotationStrength,
    displacement: RING_DEFAULTS.displacement,
    palette: { ...PALETTE },
    exposure: RENDER_DEFAULTS.exposure,
    environmentIntensity: RENDER_DEFAULTS.environmentIntensity,
    background: SCENE_BACKGROUND,
    orb: {
      emissive: ORB_DEFAULTS.emissive,
      emissiveIntensity: ORB_DEFAULTS.emissiveIntensity,
      lightColor: ORB_DEFAULTS.lightColor,
      lightIntensity: ORB_DEFAULTS.lightIntensity,
      lightDistance: ORB_DEFAULTS.lightDistance,
    },
    cameraPosition: device.cameraPosition,
  };

  if (!initial) return base;

  return {
    ...base,
    ...initial,
    palette: { ...base.palette, ...(initial.palette ?? {}) },
    orb: { ...base.orb, ...(initial.orb ?? {}) },
  };
}

export function createScene(
  container: HTMLElement,
  initial?: Partial<SceneParams>,
): SceneHandle {
  const params = resolveDefaults(container, initial);

  const width = container.clientWidth || window.innerWidth;
  const height = container.clientHeight || window.innerHeight;

  const useAlpha = params.background === null;

  const scene = new Scene();
  if (params.background !== null) {
    scene.background = new Color(params.background);
  }

  const camera = new PerspectiveCamera(45, width / height, 0.1, 100);
  camera.position.set(...params.cameraPosition);
  camera.lookAt(0, 0, 0);

  const renderer = new WebGLRenderer({ antialias: true, alpha: useAlpha });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = params.exposure;
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  if (useAlpha) {
    renderer.setClearColor(0x000000, 0);
  }
  container.appendChild(renderer.domElement);

  const environment: EnvironmentHandle = attachEnvironment(
    scene,
    renderer,
    params.environmentIntensity,
  );

  const orb: OrbHandle = createOrb(scene, params.orb);
  const blades: BladesHandle = createBlades(scene, {
    count: params.count,
    palette: params.palette,
  });

  let elapsed = 0;
  const orbPosition = new Vector3();

  const computeFrame = (advanceTime: number) => {
    if (advanceTime > 0) elapsed += advanceTime;
    const angle = elapsed * params.speed;

    orbPosition.set(
      Math.cos(angle) * params.radius,
      Math.sin(angle) * params.radius,
      params.displacement + ORB_DEFAULTS.displacementOffset,
    );
    orb.setPosition(orbPosition.x, orbPosition.y, orbPosition.z);

    blades.update(
      orbPosition,
      params.radius,
      params.influence,
      params.rotationStrength,
      params.displacement,
    );

    renderer.render(scene, camera);
  };

  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

  const onResize = () => {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    computeFrame(0);
  };

  window.addEventListener('resize', onResize);

  const handle: SceneHandle = {
    update: (dt) => {
      computeFrame(dt);
    },

    setProgress: (p) => {
      const clamped = Math.min(1, Math.max(0, p));

      renderer.toneMappingExposure = lerp(
        PROGRESS_TARGETS.exposureDocked,
        PROGRESS_TARGETS.exposureHero,
        clamped,
      );

      const [hx, hy, hz] = params.cameraPosition;
      const [dx, dy, dz] = PROGRESS_TARGETS.cameraPositionDocked;
      camera.position.set(
        lerp(dx, hx, clamped),
        lerp(dy, hy, clamped),
        lerp(dz, hz, clamped),
      );
      camera.lookAt(0, 0, 0);

      params.displacement = lerp(
        PROGRESS_TARGETS.displacementDocked,
        PROGRESS_TARGETS.displacementHero,
        clamped,
      );

      computeFrame(0);
    },

    setParams: (patch) => {
      Object.assign(params, patch);
      if (patch.background !== undefined) {
        scene.background = patch.background === null ? null : new Color(patch.background);
      }
      if (patch.exposure !== undefined) {
        renderer.toneMappingExposure = patch.exposure;
      }
      if (patch.environmentIntensity !== undefined) {
        scene.environmentIntensity = patch.environmentIntensity;
      }
      if (patch.orb?.lightDistance !== undefined) {
        orb.setLightDistance(patch.orb.lightDistance);
      }
    },

    dispose: () => {
      window.removeEventListener('resize', onResize);
      blades.dispose();
      orb.dispose();
      environment.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
    },
  };

  // Precompile materials and render the initial frame so the canvas
  // doesn't show the InstancedMesh stacked-at-origin default for one
  // frame after mount (same rationale as the marketing site).
  renderer.compile(scene, camera);
  computeFrame(0);

  return handle;
}
