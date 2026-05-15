import {
  Mesh,
  MeshStandardMaterial,
  PointLight,
  Scene,
  SphereGeometry,
} from 'three';
import { ORB_DEFAULTS } from './tokens';

export type OrbConfig = {
  emissive: number;
  emissiveIntensity: number;
  lightColor: number;
  lightIntensity: number;
  lightDistance: number;
};

export type OrbHandle = {
  mesh: Mesh<SphereGeometry, MeshStandardMaterial>;
  light: PointLight;
  setPosition: (x: number, y: number, z: number) => void;
  setLightDistance: (distance: number) => void;
  dispose: () => void;
};

// Emissive sphere + child PointLight. The light is parented to the mesh so
// it always sits at the orb's centre — when the orb orbits, the light
// orbits with it, which is what drives the blade colour pulse via the
// proximity attribute set in `blades.ts`.
export function createOrb(scene: Scene, config: OrbConfig): OrbHandle {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    emissive: config.emissive,
    emissiveIntensity: config.emissiveIntensity,
    metalness: ORB_DEFAULTS.metalness,
    roughness: ORB_DEFAULTS.roughness,
  });
  material.color.convertSRGBToLinear();

  const geometry = new SphereGeometry(ORB_DEFAULTS.radius, 32, 32);
  const mesh = new Mesh(geometry, material);

  const light = new PointLight(
    config.lightColor,
    config.lightIntensity,
    config.lightDistance,
  );
  mesh.add(light);
  scene.add(mesh);

  return {
    mesh,
    light,
    setPosition: (x, y, z) => {
      mesh.position.set(x, y, z);
    },
    setLightDistance: (distance) => {
      light.distance = distance;
    },
    dispose: () => {
      scene.remove(mesh);
      geometry.dispose();
      material.dispose();
      light.dispose();
    },
  };
}
