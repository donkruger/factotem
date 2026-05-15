import {
  CapsuleGeometry,
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  MathUtils,
  MeshPhysicalMaterial,
  Object3D,
  Scene,
  Vector3,
  type WebGLProgramParametersWithUniforms,
} from 'three';

export type BladesConfig = {
  count: number;
  palette: { base: string; active: string; tip: string };
};

export type BladesHandle = {
  mesh: InstancedMesh<CapsuleGeometry, MeshPhysicalMaterial>;
  /** Update per-blade matrices + proximity buffer based on the orb's world position. */
  update: (
    orbPosition: Vector3,
    ringRadius: number,
    influence: number,
    rotationStrength: number,
    displacement: number,
  ) => void;
  dispose: () => void;
};

// Ring of capsule "blades" rendered as a single InstancedMesh. Each blade
// gets a per-instance `aProximity` value (0–1, how close it is to the
// orb) which the patched fragment shader uses to blend from a near-white
// base gradient into a purple→orange active gradient. The vertex shader
// also exposes the local Y position so the gradient runs along the
// blade's length.
export function createBlades(scene: Scene, config: BladesConfig): BladesHandle {
  const cBase = new Color(config.palette.base).convertSRGBToLinear();
  const cActive = new Color(config.palette.active).convertSRGBToLinear();
  const cTip = new Color(config.palette.tip).convertSRGBToLinear();

  const material = new MeshPhysicalMaterial({
    roughness: 1,
    metalness: 1,
    color: cBase,
    clearcoat: 0.2,
    clearcoatRoughness: 0.4,
  });

  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uColorBase = { value: cBase };
    shader.uniforms.uColorActive = { value: cActive };
    shader.uniforms.uColorTip = { value: cTip };

    shader.vertexShader = `
      attribute float aProximity;
      varying   float vProximity;
      varying   float vY;
      ${shader.vertexShader}
    `.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vProximity = aProximity;
       vY = position.y;`,
    );

    shader.fragmentShader = `
      uniform vec3 uColorBase;
      uniform vec3 uColorActive;
      uniform vec3 uColorTip;
      varying float vProximity;
      varying float vY;
      ${shader.fragmentShader}
    `.replace(
      'vec4 diffuseColor = vec4( diffuse, opacity );',
      `
      float h          = smoothstep(-0.6, 0.6, vY);
      vec3  activeGrad = mix(uColorActive, uColorTip, h);
      vec3  baseGrad   = mix(uColorBase * 0.8, uColorBase, h);
      vec3  finalRGB   = mix(baseGrad, activeGrad, vProximity);
      vec4  diffuseColor = vec4(finalRGB, opacity);
      `,
    );
  };

  const geometry = new CapsuleGeometry(0.32, 1.6, 4, 16);
  geometry.scale(1, 1, 0.12);

  const mesh = new InstancedMesh(geometry, material, config.count);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const proximity = new Float32Array(config.count);
  const proxAttr = new InstancedBufferAttribute(proximity, 1);
  mesh.geometry.setAttribute('aProximity', proxAttr);
  scene.add(mesh);

  const dummy = new Object3D();

  return {
    mesh,
    update: (orbPosition, ringRadius, influence, rotationStrength, displacement) => {
      for (let i = 0; i < config.count; i++) {
        const angle = (i / config.count) * Math.PI * 2;
        dummy.position.set(
          Math.cos(angle) * ringRadius,
          Math.sin(angle) * ringRadius,
          0,
        );
        dummy.rotation.set(0, 0, angle + Math.PI / 2);
        dummy.rotateY(0.4);

        const dist = dummy.position.distanceTo(orbPosition);
        const k = 1 - MathUtils.smoothstep(dist, 0, influence);

        dummy.position.z = k * displacement;
        dummy.rotation.x = k * rotationStrength;
        dummy.rotateY(Math.PI / 6);
        dummy.updateMatrix();

        mesh.setMatrixAt(i, dummy.matrix);
        proxAttr.array[i] = k;
      }
      mesh.instanceMatrix.needsUpdate = true;
      proxAttr.needsUpdate = true;
    },
    dispose: () => {
      scene.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };
}
