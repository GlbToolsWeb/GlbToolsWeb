import { WebIO } from '@gltf-transform/core';
import { KHRTextureTransform } from '@gltf-transform/extensions';
import { unpartition, prune } from '@gltf-transform/functions';

self.onmessage = async (event) => {
  const { file } = event.data || {};
  if (!file) {
    postError('No file provided');
    return;
  }
  try {
    const buffer = new Uint8Array(await file.arrayBuffer());
    const io = new WebIO().registerExtensions([KHRTextureTransform]);
    const doc = await io.readBinary(buffer);

    await mergeAllMeshes(doc);
    await doc.transform(unpartition());
    await doc.transform(prune());

    const out = await io.writeBinary(doc);
    const base64 = arrayBufferToBase64(out);
    self.postMessage({ glb: base64 });
  } catch (err) {
    postError(formatErr(err));
  }
};

function postError(msg) {
  self.postMessage({ error: msg });
}

function formatErr(err) {
  if (!err) return 'Unknown error';
  if (err instanceof Error) {
    const ctor = err.constructor?.name || 'Error';
    const stack = err.stack ? ` | stack: ${err.stack}` : '';
    return `[${ctor}] ${err.message}${stack}`;
  }
  return String(err);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function mergeAllMeshes(doc) {
  const root = doc.getRoot();
  const scenes = root.listScenes();
  const scene = scenes[0] || root.createScene('Scene');

  const mergedMesh = doc.createMesh('MergedMesh');
  const mergedNode = doc.createNode('MergedNode').setMesh(mergedMesh);

  for (const sc of scenes) {
    const children = sc.listChildren().slice();
    for (const child of children) {
      bakeNodeRecursive(child, mergedMesh, doc, null);
      sc.removeChild(child);
    }
  }

  scene.addChild(mergedNode);

  // Drop old meshes/nodes; prune will clean references later.
  for (const mesh of root.listMeshes()) {
    if (mesh !== mergedMesh) mesh.dispose();
  }
  for (const node of root.listNodes()) {
    if (node !== mergedNode) node.dispose();
  }
  scenes.forEach((sc, idx) => {
    if (idx === 0) return;
    sc.dispose();
  });
}

function bakeNodeRecursive(node, mergedMesh, doc, parentMatrix) {
  const local = node.getMatrix ? node.getMatrix() : null;
  const world = parentMatrix ? multiplyMat4(parentMatrix, local || identityMat4()) : local || identityMat4();

  const mesh = node.getMesh ? node.getMesh() : null;
  if (mesh) {
    for (const prim of mesh.listPrimitives()) {
      const bakedPrim = bakePrimitiveTransform(prim, world, doc);
      mergedMesh.addPrimitive(bakedPrim);
    }
  }

  for (const child of node.listChildren ? node.listChildren() : []) {
    bakeNodeRecursive(child, mergedMesh, doc, world);
  }
}

function bakePrimitiveTransform(prim, matrix, doc) {
  const out = doc.createPrimitive();
  const idx = prim.getIndices();
  if (idx) out.setIndices(idx.clone());

  const attrNames = ['POSITION', 'NORMAL', 'TANGENT', 'TEXCOORD_0', 'TEXCOORD_1', 'COLOR_0'];
  attrNames.forEach((name) => {
    const accessor = prim.getAttribute(name);
    if (!accessor) return;
    let baked = accessor;
    if (name === 'POSITION') baked = transformVec3Accessor(accessor, matrix, doc);
    else if (name === 'NORMAL') baked = transformNormalAccessor(accessor, matrix, doc);
    else if (name === 'TANGENT') baked = transformTangentAccessor(accessor, matrix, doc);
    else baked = accessor.clone();
    out.setAttribute(name, baked);
  });

  const material = prim.getMaterial();
  if (material) out.setMaterial(material);
  return out;
}

function transformVec3Accessor(accessor, matrix, doc) {
  const arr = accessor.getArray();
  const outArr = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i += 3) {
    const v = transformPoint([arr[i], arr[i + 1], arr[i + 2]], matrix);
    outArr[i] = v[0];
    outArr[i + 1] = v[1];
    outArr[i + 2] = v[2];
  }
  return doc.createAccessor().setType('VEC3').setArray(outArr);
}

function transformNormalAccessor(accessor, matrix, doc) {
  const arr = accessor.getArray();
  const normalMat = computeNormalMatrix(matrix);
  const outArr = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i += 3) {
    const v = transformVector([arr[i], arr[i + 1], arr[i + 2]], normalMat);
    normalizeInPlace(v);
    outArr[i] = v[0];
    outArr[i + 1] = v[1];
    outArr[i + 2] = v[2];
  }
  return doc.createAccessor().setType('VEC3').setArray(outArr);
}

function transformTangentAccessor(accessor, matrix, doc) {
  const arr = accessor.getArray();
  const normalMat = computeNormalMatrix(matrix);
  const outArr = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i += 4) {
    const v = transformVector([arr[i], arr[i + 1], arr[i + 2]], normalMat);
    normalizeInPlace(v);
    outArr[i] = v[0];
    outArr[i + 1] = v[1];
    outArr[i + 2] = v[2];
    outArr[i + 3] = arr[i + 3];
  }
  return doc.createAccessor().setType('VEC4').setArray(outArr);
}

function transformPoint(v, m) {
  const x = v[0], y = v[1], z = v[2];
  const w = 1 / (m[3] * x + m[7] * y + m[11] * z + m[15]);
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) * w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) * w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) * w,
  ];
}

function transformVector(v, m) {
  const x = v[0], y = v[1], z = v[2];
  return [
    m[0] * x + m[4] * y + m[8] * z,
    m[1] * x + m[5] * y + m[9] * z,
    m[2] * x + m[6] * y + m[10] * z,
  ];
}

function computeNormalMatrix(m) {
  const a00 = m[0], a01 = m[1], a02 = m[2];
  const a10 = m[4], a11 = m[5], a12 = m[6];
  const a20 = m[8], a21 = m[9], a22 = m[10];

  const b01 = a22 * a11 - a12 * a21;
  const b11 = -a22 * a10 + a12 * a20;
  const b21 = a21 * a10 - a11 * a20;

  let det = a00 * b01 + a01 * b11 + a02 * b21;
  if (!det) return identityMat4();
  det = 1.0 / det;

  const out = new Float32Array(16);
  out[0] = b01 * det;
  out[1] = (-a22 * a01 + a02 * a21) * det;
  out[2] = (a12 * a01 - a02 * a11) * det;
  out[3] = 0;
  out[4] = b11 * det;
  out[5] = (a22 * a00 - a02 * a20) * det;
  out[6] = (-a12 * a00 + a02 * a10) * det;
  out[7] = 0;
  out[8] = b21 * det;
  out[9] = (-a21 * a00 + a01 * a20) * det;
  out[10] = (a11 * a00 - a01 * a10) * det;
  out[11] = 0;
  out[12] = 0;
  out[13] = 0;
  out[14] = 0;
  out[15] = 1;
  return out;
}

function multiplyMat4(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function normalizeInPlace(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  v[0] /= len;
  v[1] /= len;
  v[2] /= len;
}

function identityMat4() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

