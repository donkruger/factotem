import { PMREMGenerator, type Scene, type WebGLRenderer } from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export type EnvironmentHandle = {
  dispose: () => void;
};

// PMREM + RoomEnvironment — same setup the Factotem marketing site uses.
// Without this the metallic orb and clearcoat blades read as flat-shaded
// plastic; the room env supplies the IBL that makes them look polished.
export function attachEnvironment(
  scene: Scene,
  renderer: WebGLRenderer,
  environmentIntensity: number,
): EnvironmentHandle {
  const pmrem = new PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04);

  scene.environment = environment.texture;
  scene.environmentIntensity = environmentIntensity;

  return {
    dispose: () => {
      environment.texture.dispose();
      pmrem.dispose();
      scene.environment = null;
    },
  };
}
