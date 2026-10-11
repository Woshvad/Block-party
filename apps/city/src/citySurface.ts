import * as THREE from "three";

// World-space surface grain works on the merged scenery without UV seams.
// Coarse paving joints only affect upward-facing, pale stone surfaces.
export function citySurface() {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.02 });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vSurfacePosition;\nvarying vec3 vSurfaceNormal;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSurfacePosition = position;\nvSurfaceNormal = normal;");
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>
      varying vec3 vSurfacePosition;
      varying vec3 vSurfaceNormal;
      float surfaceNoise(vec3 p) { return fract(sin(dot(floor(p), vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
    `).replace("#include <color_fragment>", `#include <color_fragment>
      float grain = surfaceNoise(vSurfacePosition * 32.0);
      diffuseColor.rgb *= 0.965 + grain * 0.07;
      float pale = step(0.48, min(diffuseColor.r, min(diffuseColor.g, diffuseColor.b)));
      float ground = step(0.95, vSurfaceNormal.y) * (1.0 - step(0.3, vSurfacePosition.y));
      vec2 cell = abs(fract(vSurfacePosition.xz / 0.8) - 0.5);
      vec2 aa = max(fwidth(vSurfacePosition.xz / 0.8), vec2(0.001));
      vec2 joint = smoothstep(vec2(0.48) - aa, vec2(0.5), cell);
      diffuseColor.rgb *= 1.0 - max(joint.x, joint.y) * pale * ground * 0.13;
    `);
  };
  material.customProgramCacheKey = () => "city-surface-v1";
  return material;
}
