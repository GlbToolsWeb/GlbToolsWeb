import { NodeIO } from '@gltf-transform/core';

async function main() {
  const io = new NodeIO();
  const doc = await io.read(process.argv[2] || 'sample_glb/Mask Pack.atlas.glb');
  const mesh = doc.getRoot().listMeshes()[0];
  mesh.listPrimitives().forEach((p, i) => {
    const uv = p.getAttribute('TEXCOORD_0')?.getArray();
    if (!uv) {
      console.log('prim', i, 'no uv');
      return;
    }
    let uMin = Infinity,
      uMax = -Infinity,
      vMin = Infinity,
      vMax = -Infinity;
    for (let k = 0; k < uv.length; k += 2) {
      uMin = Math.min(uMin, uv[k]);
      uMax = Math.max(uMax, uv[k]);
      vMin = Math.min(vMin, uv[k + 1]);
      vMax = Math.max(vMax, uv[k + 1]);
    }
    console.log('prim', i, 'u', [uMin, uMax], 'v', [vMin, vMax]);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

