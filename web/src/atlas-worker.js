import { WebIO } from '@gltf-transform/core';
import { mergeDocuments, prune, unpartition } from '@gltf-transform/functions';
import { KHRTextureTransform } from '@gltf-transform/extensions';
import { MaxRectsPacker } from 'maxrects-packer';

self.onmessage = async (event) => {
  const { files = [], opts = {} } = event.data || {};
  if (!files.length) {
    postError('No files provided');
    return;
  }
  try {
    const glbBuffers = await Promise.all(
      files.map(async (f) => new Uint8Array(await f.arrayBuffer()))
    );
    const io = new WebIO().registerExtensions([KHRTextureTransform]);
    const docs = [];
    for (let i = 0; i < glbBuffers.length; i++) {
      try {
        const doc = await io.readBinary(glbBuffers[i]);
        if (doc) docs.push(doc);
      } catch (e) {
        throw new Error(`Failed to read GLB at index ${i}: ${e.message || e}`);
      }
    }
    if (!docs.length) throw new Error('No GLB documents could be read.');
    const invalidIdx = docs.findIndex((d) => !d || typeof d.getRoot !== 'function');
    if (invalidIdx !== -1) {
      throw new Error(`Document at index ${invalidIdx} is invalid (missing getRoot)`);
    }
    const merged = docs[0];
    try {
      for (let i = 1; i < docs.length; i++) {
        mergeDocuments(merged, docs[i]);
      }
    } catch (e) {
      throw new Error(`Failed to merge documents: ${e.message || e}`);
    }

    const { layoutInfo, atlasTextures } = await atlasAllMaps(merged, opts);
    await collapseToSingleMeshAndMaterial(merged, atlasTextures);
    pruneUnusedTextures(merged);
    // Ensure a single buffer for GLB.
    await merged.transform(unpartition());
    await sanitizeTextureImages(merged);
    await merged.transform(prune());
    const out = await io.writeBinary(merged);
    const base64 = arrayBufferToBase64(out);
    self.postMessage({ glb: base64, layout: layoutInfo });
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

async function atlasAllMaps(doc, opts) {
  const maps = ['basecolor', 'normal', 'orm', 'emissive'];
  const layout = [];
  const atlasTextures = {};
  let canonical = null;

  for (const map of maps) {
    const result = await atlasMap(doc, map, opts, canonical);
    if (!result) continue;
    layout.push(result.layoutInfo);
    atlasTextures[map] = result.atlasTexRefs[result.atlasTexRefs.length - 1];
    if (!canonical) canonical = { rects: result.rects, size: result.size };
  }
  return { layoutInfo: layout, atlasTextures };
}

function getMapFns(map) {
  const getter = {
    basecolor: (mat) => mat.getBaseColorTexture(),
    normal: (mat) => mat.getNormalTexture(),
    orm: (mat) => mat.getMetallicRoughnessTexture() || mat.getOcclusionTexture(),
    emissive: (mat) => mat.getEmissiveTexture(),
  }[map];
  const setter = {
    basecolor: (mat, tex) => mat.setBaseColorTexture(tex),
    normal: (mat, tex) => mat.setNormalTexture(tex),
    orm: (mat, tex) => {
      mat.setMetallicRoughnessTexture(tex);
      mat.setOcclusionTexture(tex);
    },
    emissive: (mat, tex) => mat.setEmissiveTexture(tex),
  }[map];
  const texInfoSetter = {
    basecolor: (mat) => mat.getBaseColorTextureInfo(),
    normal: (mat) => mat.getNormalTextureInfo(),
    orm: (mat) =>
      mat.getMetallicRoughnessTextureInfo() || mat.getOcclusionTextureInfo(),
    emissive: (mat) => mat.getEmissiveTextureInfo(),
  }[map];
  return { getter, setter, texInfoSetter };
}

async function atlasMap(doc, map, opts, canonicalReuse) {
  const { getter, setter, texInfoSetter } = getMapFns(map);
  if (!getter || !setter) return null;

  const maxSize = Number(opts.maxSize) || 4096;
  const padding = Number(opts.padding ?? 0);
  const quality = Number(opts.quality ?? 85);
  const format = (opts[`format${map === 'basecolor' ? 'Basecolor' : map[0].toUpperCase() + map.slice(1)}`] || 'webp').toLowerCase();
  const texcoord = Number(opts.texcoord ?? 0);
  const materials = doc.getRoot().listMaterials();

  const entries = [];
  const entryByMatName = new Map();
  for (const mat of materials) {
    const tex = getter(mat);
    let buffer = tex && tex.getImage ? tex.getImage() : null;
    let width = 0;
    let height = 0;
    if (buffer) {
      const dim = await getImageSize(buffer);
      width = dim.width;
      height = dim.height;
    } else {
      buffer = await createFallbackBuffer(map, 256, 256);
      width = 256;
      height = 256;
    }
    const entry = { texture: tex, buffer, width, height, materials: [mat] };
    entries.push(entry);
    const name = mat.getName ? mat.getName() : null;
    if (name) entryByMatName.set(name, entry);
  }
  if (!entries.length && !canonicalReuse) return null;

  let packInput;
  if (canonicalReuse) {
    packInput = canonicalReuse.rects.map((r, idx) => {
      const mats = r.data?.materials || r.materials || [];
      const matched =
        findEntryForMaterials(mats, entries) ||
        findEntryForNames(mats, entryByMatName);
      const data =
        matched ||
        entryByMatName.values().next().value ||
        entries[idx % Math.max(entries.length, 1)] || {
          buffer: null,
          width: r.width,
          height: r.height,
          materials: mats,
        };
      return {
        id: idx,
        width: r.width,
        height: r.height,
        data,
        x: r.x,
        y: r.y,
      };
    });
  } else {
    packInput = entries.map((entry, idx) => ({
      id: idx,
      width: entry.width,
      height: entry.height,
      data: entry,
    }));
  }

  let bins;
  let atlasSize;
  if (canonicalReuse) {
    const sizeGuess = canonicalReuse.size || {};
    atlasSize = Math.max(sizeGuess.width || 0, sizeGuess.height || 0) || maxSize;
    bins = [
      {
        width: atlasSize,
        height: atlasSize,
        rects: packInput.map((p) => ({
          x: p.x ?? 0,
          y: p.y ?? 0,
          width: p.width,
          height: p.height,
          data: p.data,
          materials: p.data.materials || [],
        })),
      },
    ];
  } else {
    const packResult = packIntoSingleAtlasWithDownscale(packInput, maxSize, padding);
    atlasSize = packResult.size;
    bins = packResult.bins;
  }

  const materialMap = new Map();
  const layoutInfo = { map, atlases: [], uvDiagnostics: [] };
  const atlasTexRefs = [];

  for (let binIndex = 0; binIndex < bins.length; binIndex++) {
    const bin = bins[binIndex];
    const composites = [];
    for (const rect of bin.rects) {
      let buffer = rect.data.buffer;
      if (!buffer) {
        buffer = await createFallbackBuffer(map, rect.width, rect.height);
      }
      const resized = await resizeTo(rect.width, rect.height, buffer);
      composites.push({ input: resized, left: rect.x, top: rect.y, width: rect.width, height: rect.height });
    }
    const { image: atlasBuffer, mime } = await composeAtlas(bin.width, bin.height, composites, format, quality, map);
    const imgData = await ensureUint8(atlasBuffer);
    const atlasTex = doc.createTexture(`Atlas_${map}_${binIndex}`);
    try {
      atlasTex.setImage(imgData).setMimeType(mime);
    } catch (e) {
      const ctor = imgData?.constructor?.name ?? typeof imgData;
      throw new Error(`Failed to set atlas image (${ctor}, map=${map}): ${e.message || e}`);
    }
    atlasTexRefs.push(atlasTex);

    bin.rects.forEach((rect) => {
      const mats = rect.data.materials || rect.materials || [];
      mats.forEach((mat) => {
        const infoGetter = texInfoSetter;
        const info = infoGetter ? infoGetter(mat) : null;
        const texCoordIndex = info?.getTexCoord() ?? 0;
        materialMap.set(mat, {
          rect,
          binIndex,
          texCoordIndex,
          tex: atlasTex,
        });
      });
    });

    layoutInfo.atlases.push({
      width: bin.width,
      height: bin.height,
      rects: bin.rects.map((r) => ({
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        materials: (r.data.materials || r.materials || []).map((m) => m.getName?.() || 'mat'),
      })),
      count: bin.rects.length,
      entries: entries.length,
      packInputCount: packInput.length,
    });
  }

  if (!canonicalReuse) {
    const root = doc.getRoot();
    const meshes = root.listMeshes();
    for (const mesh of meshes) {
      mesh.listPrimitives().forEach((prim) => {
        const mat = prim.getMaterial();
        if (!mat) return;
        const mapInfo = materialMap.get(mat);
        if (!mapInfo) return;
        const texCoordIndex = texcoord || mapInfo.texCoordIndex || 0;
        const uv = prim.getAttribute(`TEXCOORD_${texCoordIndex}`);
        if (!uv) return;
        const cloned = uv.clone();
        remapUVsInPlace(cloned, mapInfo.rect, atlasSize);
        prim.setAttribute('TEXCOORD_0', cloned);
        ['TEXCOORD_1', 'TEXCOORD_2', 'TEXCOORD_3'].forEach((k) => prim.setAttribute(k, null));
      });
    }
  }

  materialMap.forEach((info, mat) => {
    setter(mat, info.tex);
    const ti = texInfoSetter(mat);
    if (ti) ti.setTexCoord(0);
  });

  return {
    layoutInfo,
    atlasTexRefs,
    rects: bins[0]?.rects || [],
    size: { width: bins[0]?.width || atlasSize, height: bins[0]?.height || atlasSize },
    debug: { entries: entries.length, packInput: packInput.length },
  };
}

function remapUVsInPlace(accessor, rect, atlasSize) {
  const arr = accessor.getArray();
  const invSize = atlasSize ? 1 / atlasSize : 1;
  for (let i = 0; i < arr.length; i += 2) {
    const u = arr[i];
    const v = arr[i + 1];
    arr[i] = (rect.x + u * rect.width) * invSize;
    arr[i + 1] = (rect.y + v * rect.height) * invSize;
  }
  return accessor;
}

async function getImageSize(buffer) {
  const blob = buffer instanceof Blob ? buffer : new Blob([buffer]);
  const bmp = await createImageBitmap(blob);
  const { width, height } = bmp;
  bmp.close();
  return { width, height };
}

async function resizeTo(width, height, buffer) {
  const blob = buffer instanceof Blob ? buffer : new Blob([buffer]);
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(bmp, 0, 0, width, height);
  const out = await canvas.convertToBlob({ type: 'image/png' });
  bmp.close();
  return out;
}

async function composeAtlas(width, height, composites, format, quality) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  for (const c of composites) {
    const bmp = await createImageBitmap(c.input);
    ctx.drawImage(bmp, c.left, c.top, c.width ?? bmp.width, c.height ?? bmp.height);
    bmp.close();
  }
  let type = 'image/png';
  if (format === 'webp') type = 'image/webp';
  else if (format === 'jpeg' || format === 'jpg') type = 'image/jpeg';
  const blob = await canvas.convertToBlob({ type, quality: Math.min(Math.max(quality / 100, 0), 1) });
  const arrayBuf = await blob.arrayBuffer();
  return { image: new Uint8Array(arrayBuf), mime: type };
}

function packIntoSingleAtlasWithDownscale(items, maxSize, padding) {
  const scales = [1, 0.85, 0.75, 0.65, 0.5, 0.35, 0.25, 0.2, 0.15, 0.1];
  for (const scale of scales) {
    const scaled = items.map((i) => ({
      ...i,
      width: Math.max(1, Math.floor(i.width * scale)),
      height: Math.max(1, Math.floor(i.height * scale)),
    }));
    let size = nextPow2(Math.max(...scaled.map((i) => Math.max(i.width, i.height))));
    size = Math.min(size, maxSize);
    while (true) {
      const packer = new MaxRectsPacker(size, size, padding, { smart: true, pot: true, square: true });
      packer.addArray(scaled);
      if (packer.bins.length === 1 && packer.bins[0].rects.length === scaled.length) {
        const bin = packer.bins[0];
        return {
          size,
          bins: [
            {
              width: size,
              height: size,
              rects: bin.rects.map((r) => ({
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                data: r.data,
                materials: r.data.materials || [],
              })),
            },
          ],
        };
      }
      if (size >= maxSize) break;
      size = Math.min(maxSize, size * 2);
    }
  }
  throw new Error(`Could not pack all textures into a single atlas <= ${maxSize}px even after downscaling.`);
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

async function collapseToSingleMeshAndMaterial(doc, atlasTextures = {}) {
  const root = doc.getRoot();
  const scenes = root.listScenes();
  const scene = scenes[0] || root.createScene('Scene');

  const mat = doc.createMaterial('Atlas_Merged');
  if (atlasTextures.basecolor) mat.setBaseColorTexture(atlasTextures.basecolor);
  if (atlasTextures.normal) mat.setNormalTexture(atlasTextures.normal);
  if (atlasTextures.orm) {
    mat.setMetallicRoughnessTexture(atlasTextures.orm);
    mat.setOcclusionTexture(atlasTextures.orm);
  }
  if (atlasTextures.emissive) mat.setEmissiveTexture(atlasTextures.emissive);

  const mergedMesh = doc.createMesh('Merged');
  const newNode = doc.createNode('MergedNode').setMesh(mergedMesh);

  for (const sc of scenes) {
    const sceneChildren = sc.listChildren().slice();
    for (const child of sceneChildren) {
      bakeNodeRecursive(child, mergedMesh, mat, doc);
      sc.removeChild(child);
    }
  }

  scene.addChild(newNode);

  for (const mesh of root.listMeshes()) {
    if (mesh === mergedMesh) continue;
    mesh.dispose();
  }
  for (const m of root.listMaterials()) {
    if (m === mat) continue;
    m.dispose();
  }
  for (const node of root.listNodes()) {
    if (node === newNode) continue;
    node.dispose();
  }
  scenes.forEach((sc, idx) => {
    if (idx === 0) return;
    sc.dispose();
  });
  const firstScene = scenes[0] || scene;
  if (!firstScene.listChildren().includes(newNode)) {
    firstScene.addChild(newNode);
  }

  mergePrimitivesIntoOne(mergedMesh, doc);
}

function mergePrimitivesIntoOne(mesh, doc) {
  const prims = mesh.listPrimitives();
  if (prims.length <= 1) return;

  const newPrim = doc.createPrimitive();
  let indexBase = 0;
  const positions = [];
  const normals = [];
  const tangents = [];
  const uvs = [];
  const indices = [];

  for (const prim of prims) {
    const pos = prim.getAttribute('POSITION');
    if (!pos) continue;
    const norm = prim.getAttribute('NORMAL');
    const tan = prim.getAttribute('TANGENT');
    const uv = prim.getAttribute('TEXCOORD_0');
    const idx = prim.getIndices();

    addVecN(pos, positions, 3);
    if (norm) addVecN(norm, normals, 3);
    if (tan) addVecN(tan, tangents, 4);
    if (uv) addVecN(uv, uvs, 2);

    if (idx) {
      const idxArray = idx.getArray();
      for (let i = 0; i < idxArray.length; i++) indices.push(idxArray[i] + indexBase);
      indexBase += pos.getCount();
    } else {
      const vertCount = pos.getCount();
      for (let i = 0; i < vertCount; i++) indices.push(i + indexBase);
      indexBase += vertCount;
    }
  }

  if (!positions.length || !indices.length) return;

  const createAccessor = (arr, type) =>
    doc.createAccessor().setType(type).setArray(new Float32Array(arr));

  newPrim.setAttribute('POSITION', createAccessor(positions, 'VEC3'));
  if (normals.length === positions.length) newPrim.setAttribute('NORMAL', createAccessor(normals, 'VEC3'));
  if (tangents.length === (positions.length / 3) * 4) newPrim.setAttribute('TANGENT', createAccessor(tangents, 'VEC4'));
  if (uvs.length === (positions.length / 3) * 2) newPrim.setAttribute('TEXCOORD_0', createAccessor(uvs, 'VEC2'));

  const indexComponent = indices.length > 65535 ? Uint32Array : Uint16Array;
  const idxArray = new indexComponent(indices);
  const indexAccessor = doc.createAccessor().setType('SCALAR').setArray(idxArray);
  newPrim.setIndices(indexAccessor);

  const firstMat = prims[0].getMaterial();
  if (firstMat) newPrim.setMaterial(firstMat);

  mesh.listPrimitives().forEach((p) => mesh.removePrimitive(p));
  mesh.addPrimitive(newPrim);
}

function addVecN(attr, out, n) {
  const array = attr.getArray();
  for (let i = 0; i < array.length; i += n) {
    for (let k = 0; k < n; k++) out.push(array[i + k]);
  }
}

function bakeNodeRecursive(node, mergedMesh, material, doc, parentMatrix) {
  const local = node.getMatrix ? node.getMatrix() : null;
  const world = parentMatrix ? multiplyMat4(parentMatrix, local || identityMat4()) : local || identityMat4();

  const mesh = node.getMesh ? node.getMesh() : null;
  if (mesh) {
    for (const prim of mesh.listPrimitives()) {
      const bakedPrim = bakePrimitiveTransform(prim, world, doc);
      bakedPrim.setMaterial(material);
      mergedMesh.addPrimitive(bakedPrim);
    }
  }

  for (const child of node.listChildren ? node.listChildren() : []) {
    bakeNodeRecursive(child, mergedMesh, material, doc, world);
  }
}

function bakePrimitiveTransform(prim, matrix, doc) {
  const out = doc.createPrimitive();
  const idx = prim.getIndices();
  if (idx) out.setIndices(idx.clone());

  const attrNames = ['POSITION', 'NORMAL', 'TANGENT', 'TEXCOORD_0'];
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

// mergeAllBuffers is unnecessary with WebIO; buffers are packed on write.
function mergeAllBuffers(doc) {
  return;
}

async function createFallbackBuffer(map, width, height) {
  let color = [0, 0, 0, 255];
  if (map === 'basecolor') color = [255, 255, 255, 255];
  else if (map === 'normal') color = [128, 128, 255, 255];
  else if (map === 'orm') color = [255, 255, 255, 255];
  else if (map === 'emissive') color = [0, 0, 0, 255];
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${color[3] / 255})`;
  ctx.fillRect(0, 0, width, height);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

async function ensureUint8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (typeof data?.arrayBuffer === 'function') {
    const buf = await data.arrayBuffer();
    return new Uint8Array(buf);
  }
  if (isImageBitmap(data)) {
    const canvas = new OffscreenCanvas(data.width, data.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(data, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  }
  if (data && data.buffer && data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer);
  const ctor = data && data.constructor ? data.constructor.name : typeof data;
  throw new Error(`Method requires Uint8Array parameter; received ${ctor}`);
}

async function sanitizeTextureImages(doc) {
  const textures = doc.getRoot().listTextures();
  for (const tex of textures) {
    const img = tex.getImage();
    if (!img) continue;
    if (img instanceof Uint8Array) continue;
    try {
      const buf = await ensureUint8(img);
      tex.setImage(buf);
    } catch (err) {
      const name = tex.getName ? tex.getName() : '(unnamed)';
      const ctor = img && img.constructor ? img.constructor.name : typeof img;
      throw new Error(`Texture "${name}" image type ${ctor} failed to coerce: ${err.message}`);
    }
  }
}

function isImageBitmap(obj) {
  return obj && typeof obj === 'object' && 'close' in obj && 'width' in obj && 'height' in obj;
}

function pruneUnusedTextures(doc) {
  const keep = new Set();
  for (const mat of doc.getRoot().listMaterials()) {
    const t0 = mat.getBaseColorTexture();
    const t1 = mat.getNormalTexture();
    const t2 = mat.getMetallicRoughnessTexture();
    const t3 = mat.getOcclusionTexture();
    const t4 = mat.getEmissiveTexture();
    [t0, t1, t2, t3, t4].forEach((t) => t && keep.add(t));
  }
  const textures = doc.getRoot().listTextures();
  textures.forEach((t) => {
    if (!keep.has(t)) t.dispose();
  });
}

function findEntryForMaterials(materials, entries) {
  if (!materials || !entries) return null;
  for (const m of materials) {
    const name =
      typeof m === 'string'
        ? m
        : typeof m?.getName === 'function'
        ? m.getName()
        : null;
    for (const e of entries) {
      if (
        e.materials &&
        e.materials.some((mm) => {
          if (mm === m) return true;
          const mmName =
            typeof mm === 'string'
              ? mm
              : typeof mm?.getName === 'function'
              ? mm.getName()
              : null;
          return name && mmName && mmName === name;
        })
      ) {
        return e;
      }
    }
  }
  return null;
}

function findEntryForNames(materials, mapByName) {
  if (!materials || !mapByName) return null;
  for (const m of materials) {
    const name =
      typeof m === 'string'
        ? m
        : typeof m?.getName === 'function'
        ? m.getName()
        : null;
    if (name && mapByName.has(name)) return mapByName.get(name);
  }
  return null;
}

