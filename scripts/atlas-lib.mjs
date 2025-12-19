import { MaxRectsPacker } from 'maxrects-packer';
import sizeOf from 'image-size';
import sharp from 'sharp';
import { KHRTextureTransform } from '@gltf-transform/extensions';

const MAPS_SUPPORTED = ['basecolor', 'normal', 'orm', 'emissive'];

export async function processAtlas(doc, opts) {
  const {
    maps,
    maxSize = 4096,
    padding = 2,
    texcoord = 0,
    formats = {},
    quality = 85,
    verbose = false,
    maxBins = 1,
    resizeMode = 'downscale', // 'none' | 'downscale'
    resizeCeil = 4096,
    sizeMode = 'best-fill', // 'best-fill' | 'buckets'
  } = opts;

  const layout = [];
  const atlasTextures = {};
  const lowerMaps = (maps || ['basecolor']).map((m) => m.toLowerCase());
  const validMaps = lowerMaps.filter((m) => {
    const ok = MAPS_SUPPORTED.includes(m);
    if (!ok && verbose) console.warn(`[atlasgen] Skipping unknown map type "${m}"`);
    return ok;
  });

  if (validMaps.length === 0) return { layout, atlasTextures };

  // 1) Compute canonical packing using the first map (prefer basecolor).
  const canonicalMap = validMaps.includes('basecolor') ? 'basecolor' : validMaps[0];
  const canonicalResult = await atlasMap(doc, {
    map: canonicalMap,
    maxSize,
    padding,
    texcoord,
    format: formats[canonicalMap],
    quality,
    maxBins,
    resizeMode,
    resizeCeil,
    sizeMode,
    remapUVs: true,
    reuseRects: null,
  });
  layout.push(canonicalResult.layoutInfo);
  if (canonicalResult.atlasTexRefs?.length) {
    atlasTextures[canonicalMap] = canonicalResult.atlasTexRefs[canonicalResult.atlasTexRefs.length - 1];
  }

  const canonicalRects = canonicalResult.layoutInfo.atlases[0]?.rects || [];
  const canonicalSize = canonicalResult.layoutInfo.atlases[0]
    ? { width: canonicalResult.layoutInfo.atlases[0].width, height: canonicalResult.layoutInfo.atlases[0].height }
    : null;

  // 2) For remaining maps, reuse canonical rects; do NOT remap UVs again.
  for (const map of validMaps) {
    if (map === canonicalMap) continue;
    const { layoutInfo, atlasTexRefs } = await atlasMap(doc, {
      map,
      maxSize,
      padding,
      texcoord,
      format: formats[map],
      quality,
      maxBins,
      resizeMode,
      sizeMode,
      reuseRects: { rects: canonicalRects, size: canonicalSize },
      remapUVs: false,
      resizeCeil,
    });
    if (layoutInfo) layout.push(layoutInfo);
    if (atlasTexRefs?.length) {
      atlasTextures[map] = atlasTexRefs[atlasTexRefs.length - 1];
    }
  }

  return { layout, atlasTextures };
}

export function pruneUnusedTextures(doc) {
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

export function collapseToSingleMeshAndMaterial(doc, atlasTextures = {}) {
  const root = doc.getRoot();
  const scenes = root.listScenes();
  const scene = scenes[0] || root.createScene('Scene');

  // Create a single material wired to atlas textures.
  const mat = doc.createMaterial('Atlas_Merged');
  if (atlasTextures.basecolor) mat.setBaseColorTexture(atlasTextures.basecolor);
  if (atlasTextures.normal) mat.setNormalTexture(atlasTextures.normal);
  if (atlasTextures.orm) {
    mat.setMetallicRoughnessTexture(atlasTextures.orm);
    mat.setOcclusionTexture(atlasTextures.orm);
  }
  if (atlasTextures.emissive) mat.setEmissiveTexture(atlasTextures.emissive);

  // Bake node transforms into geometry and merge all primitives into one mesh.
  const mergedMesh = doc.createMesh('Merged');
  const newNode = doc.createNode('MergedNode').setMesh(mergedMesh);

  // Process children from all scenes, preserve transforms.
  for (const sc of scenes) {
    const sceneChildren = sc.listChildren().slice();
    for (const child of sceneChildren) {
      bakeNodeRecursive(child, mergedMesh, mat, doc);
      sc.removeChild(child);
    }
  }

  // Attach merged node.
  scene.addChild(newNode);

  // Dispose old meshes/materials/nodes not referenced.
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

  // Keep only the first scene; drop others.
  scenes.forEach((sc, idx) => {
    if (idx === 0) return;
    sc.dispose();
  });
  // Ensure first scene has the merged node.
  const firstScene = scenes[0] || scene;
  if (!firstScene.listChildren().includes(newNode)) {
    firstScene.addChild(newNode);
  }

  // Collapse all primitives on the merged mesh into a single primitive to minimize draw calls.
  mergePrimitivesIntoOne(mergedMesh, doc);
}

export function mergeAllBuffers(doc) {
  const root = doc.getRoot();
  const buffers = doc.listBuffers ? doc.listBuffers() : root.listBuffers();
  const bufferViews = doc.listBufferViews ? doc.listBufferViews() : root.listBufferViews ? root.listBufferViews() : [];
  if (buffers.length <= 1) return;

  // Rebuild all bufferViews into a brand new single buffer.
  const align = 4;
  let total = 0;
  const entries = bufferViews.map((bv) => {
    const buf = bv.getBuffer();
    const off = bv.getByteOffset() || 0;
    const len = bv.getByteLength();
    const padded = Math.ceil(total / align) * align;
    total = padded + len;
    return { bv, buf, off, len, padded };
  });

  const merged = doc.createBuffer('MergedBuffer');
  const mergedArray = new Uint8Array(total);
  entries.forEach(({ bv, buf, off, len, padded }) => {
    const src = new Uint8Array(buf.getArrayBuffer(), off, len);
    mergedArray.set(src, padded);
    bv.setBuffer(merged).setByteOffset(padded);
  });
  merged.setArrayBuffer(mergedArray.buffer);

  // Dispose all old buffers except merged.
  root.listBuffers().forEach((b) => {
    if (b !== merged) b.dispose();
  });
}

function bakeNodeRecursive(node, mergedMesh, material, doc, parentMatrix) {
  const local = node.getMatrix
    ? node.getMatrix()
    : null;
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

  // Indices
  const idx = prim.getIndices();
  if (idx) out.setIndices(idx);

  // Attributes
  for (const semantic of prim.listSemantics()) {
    const accessor = prim.getAttribute(semantic);
    if (!accessor) continue;
    if (semantic === 'POSITION') {
      const baked = transformVec3Accessor(accessor, matrix, doc);
      out.setAttribute(semantic, baked);
    } else if (semantic === 'NORMAL') {
      const baked = transformNormalAccessor(accessor, matrix, doc);
      out.setAttribute(semantic, baked);
    } else if (semantic === 'TANGENT') {
      const baked = transformTangentAccessor(accessor, matrix, doc);
      out.setAttribute(semantic, baked);
    } else {
      out.setAttribute(semantic, accessor);
    }
  }

  // Targets (morphs) are passed through without baking.
  prim.listTargets().forEach((target, idx) => {
    out.setTarget(idx, target);
  });

  return out;
}

function transformVec3Accessor(accessor, matrix, doc) {
  const src = accessor.getArray();
  const dst = new Float32Array(src.length);
  const tmp = [0, 0, 0];
  for (let i = 0; i < src.length; i += 3) {
    tmp[0] = src[i];
    tmp[1] = src[i + 1];
    tmp[2] = src[i + 2];
    const v = transformPoint(matrix, tmp);
    dst[i] = v[0];
    dst[i + 1] = v[1];
    dst[i + 2] = v[2];
  }
  return doc.createAccessor().setType('VEC3').setArray(dst);
}

function transformNormalAccessor(accessor, matrix, doc) {
  const src = accessor.getArray();
  const dst = new Float32Array(src.length);
  const normalMat = computeNormalMatrix(matrix);
  const tmp = [0, 0, 0];
  for (let i = 0; i < src.length; i += 3) {
    tmp[0] = src[i];
    tmp[1] = src[i + 1];
    tmp[2] = src[i + 2];
    const v = transformVector(normalMat, tmp);
    normalizeInPlace(v);
    dst[i] = v[0];
    dst[i + 1] = v[1];
    dst[i + 2] = v[2];
  }
  return doc.createAccessor().setType('VEC3').setArray(dst);
}

function transformTangentAccessor(accessor, matrix, doc) {
  const src = accessor.getArray();
  const dst = new Float32Array(src.length);
  const normalMat = computeNormalMatrix(matrix);
  const tmp = [0, 0, 0];
  for (let i = 0; i < src.length; i += 4) {
    tmp[0] = src[i];
    tmp[1] = src[i + 1];
    tmp[2] = src[i + 2];
    const v = transformVector(normalMat, tmp);
    normalizeInPlace(v);
    dst[i] = v[0];
    dst[i + 1] = v[1];
    dst[i + 2] = v[2];
    dst[i + 3] = src[i + 3]; // preserve handedness
  }
  return doc.createAccessor().setType('VEC4').setArray(dst);
}

function transformPoint(m, v) {
  const x = v[0], y = v[1], z = v[2];
  const rx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const ry = m[1] * x + m[5] * y + m[9] * z + m[13];
  const rz = m[2] * x + m[6] * y + m[10] * z + m[14];
  const rw = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (rw !== 0 && rw !== 1) {
    return [rx / rw, ry / rw, rz / rw];
  }
  return [rx, ry, rz];
}

function transformVector(m3, v) {
  const x = v[0], y = v[1], z = v[2];
  return [
    m3[0] * x + m3[3] * y + m3[6] * z,
    m3[1] * x + m3[4] * y + m3[7] * z,
    m3[2] * x + m3[5] * y + m3[8] * z,
  ];
}

function computeNormalMatrix(m) {
  // Extract upper-left 3x3
  const a00 = m[0], a01 = m[4], a02 = m[8];
  const a10 = m[1], a11 = m[5], a12 = m[9];
  const a20 = m[2], a21 = m[6], a22 = m[10];

  const b01 = a22 * a11 - a12 * a21;
  const b11 = -a22 * a10 + a12 * a20;
  const b21 = a21 * a10 - a11 * a20;

  let det = a00 * b01 + a01 * b11 + a02 * b21;
  if (!det) det = 1;
  const invDet = 1.0 / det;

  // Inverse
  const m00 = b01 * invDet;
  const m01 = (-a22 * a01 + a02 * a21) * invDet;
  const m02 = (a12 * a01 - a02 * a11) * invDet;
  const m10 = b11 * invDet;
  const m11 = (a22 * a00 - a02 * a20) * invDet;
  const m12 = (-a12 * a00 + a02 * a10) * invDet;
  const m20 = b21 * invDet;
  const m21 = (-a21 * a00 + a01 * a20) * invDet;
  const m22 = (a11 * a00 - a01 * a10) * invDet;

  // Transpose for normal matrix
  return [m00, m10, m20, m01, m11, m21, m02, m12, m22];
}

function multiplyMat4(a, b) {
  // column-major glTF: out = a * b
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

async function atlasMap(doc, opts) {
  const {
    map,
    maxSize,
    padding,
    texcoord,
    format,
    quality,
    maxBins,
    resizeMode,
    resizeCeil,
    remapUVs = true,
    reuseRects = null,
    densityAware = true,
    sizeMode = 'best-fill',
  } = opts;
  const materials = doc.getRoot().listMaterials();
  const entries = [];
  const textureToEntry = new Map();
  const hasTexTransformExt =
    doc
      .getRoot()
      .listExtensions()
      .some((ext) => ext instanceof KHRTextureTransform);

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

  if (!getter || !setter) {
    console.warn(`[atlasgen] Map type not supported: ${map}`);
    return;
  }

  // Density-aware sizing support.
  const materialAreas = densityAware ? computeMaterialAreas(doc) : new Map();
  const maxMatArea = Math.max(1e-6, ...materialAreas.values());

  for (const mat of materials) {
    const tex = getter(mat);
    if (!tex || !tex.getImage()) continue;
    let entry = textureToEntry.get(tex);
    if (!entry) {
      let buffer = Buffer.from(tex.getImage());
      let { width, height } = sizeOf(buffer);
      if (!width || !height) {
        throw new Error(`Cannot read dimensions for texture ${tex.getName()}`);
      }
      if (
        resizeMode === 'downscale' &&
        resizeCeil > 0 &&
        (width > resizeCeil || height > resizeCeil)
      ) {
        const scale = Math.min(resizeCeil / width, resizeCeil / height);
        const newW = Math.max(1, Math.floor(width * scale));
        const newH = Math.max(1, Math.floor(height * scale));
        buffer = await sharp(buffer).resize(newW, newH, { fit: 'inside' }).toBuffer();
        width = newW;
        height = newH;
      }

      // Target sizing
      let targetSize = nearestPow2(Math.min(width, maxSize));
      const matArea = materialAreas.get(mat.getName() || '') || 0;
      if (materialAreas.size > 0) {
        if (sizeMode === 'best-fill') {
          targetSize = suggestSizeBestFill(matArea, maxMatArea, maxSize, width, height);
        } else {
          // buckets mode (legacy density-aware)
          const norm = matArea / maxMatArea;
          if (norm >= 0.5) targetSize = 2048;
          else if (norm >= 0.25) targetSize = 1024;
          else if (norm >= 0.1) targetSize = 512;
          else targetSize = 256;
        }
      }
      targetSize = clampPow2(targetSize, 256, maxSize);
      // Do not upscale beyond original.
      targetSize = Math.min(targetSize, nearestPow2(Math.max(1, Math.min(width, height))));
      if (targetSize < Math.min(width, height)) {
        buffer = await sharp(buffer).resize(targetSize, targetSize, { fit: 'cover' }).toBuffer();
        width = targetSize;
        height = targetSize;
      } else {
        width = targetSize;
        height = targetSize;
      }

      entry = {
        texture: tex,
        buffer,
        width,
        height,
        materials: [],
      };
      textureToEntry.set(tex, entry);
      entries.push(entry);
    }
    entry.materials.push(mat);
  }

  if (entries.length === 0) {
    console.log(`[atlasgen] No ${map} textures found; skipping atlas.`);
    return;
  }

  console.log(`[atlasgen] Atlasing ${entries.length} ${map} texture(s).`);

  const packInput = entries.map((entry, idx) => ({
    id: idx,
    width: entry.width,
    height: entry.height,
    data: entry,
  }));

  const targetBins = maxBins < 1 ? 1 : maxBins;
  let scale = 1;
  let bins;
  let atlasSize;
  let binRects;

  if (reuseRects && reuseRects.rects && reuseRects.size) {
    // Reuse canonical rects; do not repack. Fill missing textures with map-specific fallback.
    const s = Math.max(reuseRects.size.width || 0, reuseRects.size.height || 0);
    atlasSize = nextPow2Ceil(Math.max(s, 256));
    const rects = [];
    const allMats = doc.getRoot().listMaterials();
    for (const r of reuseRects.rects) {
      const resolvedMats = (r.materials || [])
        .map((name) => findMaterialByName(name, allMats))
        .filter(Boolean);
      let entry = findEntryForMaterial(r.materials?.[0], entries);
      if (!entry) {
        const fallbackBuffer = await createFallbackBuffer(map, r.width, r.height);
        entry = {
          texture: null,
          buffer: fallbackBuffer,
          width: r.width,
          height: r.height,
          materials: resolvedMats,
        };
      } else {
        entry = { ...entry, materials: resolvedMats.length ? resolvedMats : entry.materials || [] };
      }
      rects.push({
        ...r,
        data: entry,
      });
    }
    bins = [
      {
        width: atlasSize,
        height: atlasSize,
        rects,
      },
    ];
    binRects = bins[0].rects;
  } else {
    if (targetBins === 1 && resizeMode === 'downscale') {
      scale = await findBestScaleForSingleBin(packInput, maxSize, padding);
    }

    const scaledInput =
      scale === 1 ? packInput : await resizePackInputToScale(packInput, scale);

    const packResult = packIntoAtlas(scaledInput, maxSize, padding, targetBins);
    atlasSize = packResult.size;
    bins = packResult.bins;
    binRects = bins[0].rects;
  }

  const fmt = (format || 'png').toLowerCase();
  const mime =
    fmt === 'png' ? 'image/png' : fmt === 'webp' ? 'image/webp' : 'image/jpeg';

  const materialMap = new Map(); // material -> mapping
  const layoutInfo = { map, atlases: [], uvDiagnostics: [] };
  const atlasTexRefs = [];

  for (let binIndex = 0; binIndex < bins.length; binIndex++) {
    const bin = bins[binIndex];
    // Force square, power-of-two atlas dimensions.
    const squareSize = nextPow2Ceil(Math.max(bin.width || atlasSize, bin.height || atlasSize, atlasSize));
    bin.width = squareSize;
    bin.height = squareSize;
    atlasSize = squareSize;
    const composites = [];
    for (const rect of bin.rects) {
      const entry = rect.data;
      let input = entry.buffer;
      if (entry.width !== rect.width || entry.height !== rect.height) {
        input = await sharp(entry.buffer)
          .resize(rect.width, rect.height, { fit: 'fill' })
          .toBuffer();
      }
      composites.push({ input, left: rect.x, top: rect.y });
    }

    let pipeline = sharp({
      create: {
        width: bin.width || atlasSize,
        height: bin.height || atlasSize,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    }).composite(composites);

    if (fmt === 'png') {
      pipeline = pipeline.png();
    } else if (fmt === 'jpeg' || fmt === 'jpg') {
      pipeline = pipeline.jpeg({
        quality: quality ?? 85,
        chromaSubsampling: '4:4:4',
      });
    } else if (fmt === 'webp') {
      const lossless = map === 'normal' || map === 'orm';
      pipeline = pipeline.webp({
        quality: quality ?? 85,
        lossless,
      });
    } else {
      console.warn(`[atlasgen] Unknown format "${fmt}", defaulting to png.`);
      pipeline = pipeline.png();
    }

    const atlasBuffer = await pipeline.toBuffer();

    const atlasTex = doc
      .createTexture(`Atlas_${map}_${binIndex}`)
      .setImage(atlasBuffer)
      .setMimeType(mime);
    atlasTexRefs.push(atlasTex);

    const allMats = doc.getRoot().listMaterials();
    bin.rects.forEach((rect) => {
      const matsRaw =
        (rect.data && rect.data.materials && rect.data.materials.length
          ? rect.data.materials
          : rect.materials) || [];
      const mats = matsRaw
        .map((matRef) =>
          matRef && typeof matRef.getName === 'function'
            ? matRef
            : findMaterialByName(matRef, allMats)
        )
        .filter(Boolean);
      if (!mats.length) return;
      mats.forEach((mat) => {
        const infoGetter =
          map === 'basecolor'
            ? mat.getBaseColorTextureInfo
            : map === 'normal'
            ? mat.getNormalTextureInfo
            : map === 'emissive'
            ? mat.getEmissiveTextureInfo
            : () => mat.getMetallicRoughnessTextureInfo() || mat.getOcclusionTextureInfo();
        const info = infoGetter ? infoGetter.call(mat) : null;
        const texCoordIndex = info?.getTexCoord() ?? 0;
        materialMap.set(mat, {
          rect,
          atlasTex,
          atlasIndex: binIndex,
          width: bin.width || atlasSize,
          height: bin.height || atlasSize,
          texCoordIndex,
          info,
          hasTransform:
            hasTexTransformExt &&
            !!info &&
            !!info.getExtension &&
            !!info.getExtension('KHR_texture_transform'),
        });
        layoutInfo.uvDiagnostics.push({
          material: mat.getName() || '(unnamed)',
          texCoordIndex,
          hasTransform: !!materialMap.get(mat)?.hasTransform,
          map,
          rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        });
      });
    });

    layoutInfo.atlases.push({
      index: binIndex,
      width: bin.width || atlasSize,
      height: bin.height || atlasSize,
      rects: bin.rects.map((r) => ({
        texture: r.data.texture?.getName?.() || '(unnamed)',
        materials: (r.data.materials || [])
          .map((m) => (m && typeof m.getName === 'function' ? m.getName() : null))
          .filter(Boolean),
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
      })),
    });
  }

  const meshes = doc.getRoot().listMeshes();
  let remappedPrims = 0;
  if (remapUVs) {
    for (const mesh of meshes) {
      for (const prim of mesh.listPrimitives()) {
        const mat = prim.getMaterial();
        const mapping = materialMap.get(mat);
        if (!mapping) continue;
        const {
          rect,
          atlasTex,
          width: aw,
          height: ah,
          texCoordIndex,
          info,
          hasTransform,
        } = mapping;
        let uvSet = texCoordIndex;
        let uvAcc = prim.getAttribute(`TEXCOORD_${uvSet}`);
        if (!uvAcc) continue;
        // Clone UV accessor to avoid mutating shared accessors across primitives.
        const clonedUV = new Float32Array(uvAcc.getArray());
        uvAcc = doc.createAccessor().setType('VEC2').setArray(clonedUV);
        prim.setAttribute(`TEXCOORD_${uvSet}`, uvAcc);
        let working = uvAcc.getArray();
        if (!working) continue;

        // Capture pre ranges for debugging.
        const preMin = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
        const preMax = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
        for (let i = 0; i < working.length; i += 2) {
          preMin[0] = Math.min(preMin[0], working[i]);
          preMin[1] = Math.min(preMin[1], working[i + 1]);
          preMax[0] = Math.max(preMax[0], working[i]);
          preMax[1] = Math.max(preMax[1], working[i + 1]);
        }

        // If there is a texture transform, clone/bake it into a new texcoord set to avoid disturbing other maps.
        if (hasTransform) {
          const t = info.getExtension('KHR_texture_transform');
          const newSet = nextTexcoordIndex(prim);
          const cloned = new Float32Array(working);
          bakeTextureTransformInPlace(cloned, t);
          const newAcc = doc.createAccessor().setType('VEC2').setArray(cloned);
          prim.setAttribute(`TEXCOORD_${newSet}`, newAcc);
          uvAcc = newAcc;
          working = cloned;
          uvSet = newSet;
          info.setTexCoord(newSet);
          info.setExtension('KHR_texture_transform', null);
        }

        const dst = new Float32Array(working.length);
        const scaleU = rect.width / aw;
        const scaleV = rect.height / ah;
        const offsetU = rect.x / aw;
        const offsetV = rect.y / ah;
        for (let i = 0; i < working.length; i += 2) {
          const u = working[i];
          const v = working[i + 1];
          dst[i] = u * scaleU + offsetU;
          dst[i + 1] = v * scaleV + offsetV;
        }
        uvAcc.setArray(dst);
        remappedPrims += 1;
        setter(mat, atlasTex);
        // Force material sampling to texcoord 0; copy remapped UVs into TEXCOORD_0.
        prim.setAttribute('TEXCOORD_0', uvAcc);
        if (info && info.setTexCoord) {
          info.setTexCoord(0);
        } else {
          texInfoSetter(mat)?.setTexCoord(0);
        }

        // Capture post ranges for debugging.
        const postMin = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
        const postMax = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
        for (let i = 0; i < dst.length; i += 2) {
          postMin[0] = Math.min(postMin[0], dst[i]);
          postMin[1] = Math.min(postMin[1], dst[i + 1]);
          postMax[0] = Math.max(postMax[0], dst[i]);
          postMax[1] = Math.max(postMax[1], dst[i + 1]);
        }

        layoutInfo.uvDiagnostics.push({
          material: mat.getName() || '(unnamed)',
          texCoordIndex: uvSet,
          map,
          preMin,
          preMax,
          postMin,
          postMax,
          rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height, atlasW: aw, atlasH: ah },
        });
      }
    }
  } else {
    // Only rewire materials to the atlas textures; UVs remain as-is from canonical remap.
    for (const mesh of meshes) {
      for (const prim of mesh.listPrimitives()) {
        setter(prim.getMaterial(), doc.getRoot().listTextures().find((t) => t.getName().startsWith(`Atlas_${map}`)));
      }
    }
  }

  console.log(
    `[atlasgen] Built ${map} atlas(es); bins=${bins.length}; remapped ${remappedPrims} primitive(s).`
  );

  return { layoutInfo, atlasTexRefs };
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function nextPow2Ceil(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function packIntoAtlas(rects, maxSize, padding, maxBins) {
  const maxDim = rects.reduce((m, r) => Math.max(m, r.width, r.height), 1);
  let size = nextPow2(Math.max(maxDim, 256));

  while (size <= maxSize) {
    const packer = new MaxRectsPacker(size, size, padding, {
      smart: true,
      pot: false,
      square: false,
      allowRotation: false,
    });
    packer.addArray(rects);
    if (packer.bins.length <= maxBins) {
      return { size, bins: packer.bins };
    }
    size = size * 2;
  }

  throw new Error(
    `Could not pack textures into <= ${maxBins} atlas bins within max size ${maxSize}.`
  );
}

function findEntryForMaterial(materialName, entries) {
  if (!materialName) return null;
  for (const e of entries) {
    if (
      e.materials.some(
        (m) => m && typeof m.getName === 'function' && (m.getName() || '(unnamed)') === materialName
      )
    )
      return e;
  }
  return null;
}

async function createFallbackBuffer(map, width, height) {
  let background = { r: 0, g: 0, b: 0, alpha: 255 };
  if (map === 'basecolor') background = { r: 255, g: 255, b: 255, alpha: 255 };
  else if (map === 'normal') background = { r: 128, g: 128, b: 255, alpha: 255 };
  else if (map === 'orm') background = { r: 255, g: 255, b: 255, alpha: 255 };
  else if (map === 'emissive') background = { r: 0, g: 0, b: 0, alpha: 255 };

  const buf = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background,
    },
  })
    .png()
    .toBuffer();
  return buf;
}

function findMaterialByName(name, materials) {
  if (!name) return null;
  for (const m of materials) {
    if (m && typeof m.getName === 'function' && (m.getName() || '(unnamed)') === name) return m;
  }
  return null;
}

function computeMaterialAreas(doc) {
  const areas = new Map();
  const meshes = doc.getRoot().listMeshes();
  for (const mesh of meshes) {
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      const name = mat?.getName() || '';
      const area = primitiveArea(prim);
      areas.set(name, (areas.get(name) || 0) + area);
    }
  }
  return areas;
}

function primitiveArea(prim) {
  const posAcc = prim.getAttribute('POSITION');
  if (!posAcc) return 0;
  const arr = posAcc.getArray();
  const idxAcc = prim.getIndices();
  let area = 0;
  const triCount = idxAcc ? idxAcc.getCount() / 3 : arr.length / 9;
  const indexArray = idxAcc ? idxAcc.getArray() : null;
  const getV = (i) => {
    const idx = idxAcc ? indexArray[i] * 3 : i * 3;
    return [arr[idx], arr[idx + 1], arr[idx + 2]];
  };
  for (let t = 0; t < triCount; t++) {
    const i0 = t * 3;
    const v0 = getV(i0);
    const v1 = getV(i0 + 1);
    const v2 = getV(i0 + 2);
    area += triangleArea(v0, v1, v2);
  }
  return area;
}

function triangleArea(a, b, c) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cross = [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ];
  const mag = Math.sqrt(cross[0] ** 2 + cross[1] ** 2 + cross[2] ** 2);
  return 0.5 * mag;
}

function nearestPow2(n) {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}

function clampPow2(n, min, max) {
  let p = nearestPow2(n);
  p = Math.max(min, Math.min(max, p));
  return p;
}

// Heuristic: promote larger materials into bigger pow2 buckets while respecting maxSize.
function suggestSizeBestFill(matArea, maxMatArea, maxSize, srcW, srcH) {
  const allowed = [256, 512, 1024, 2048, 4096].filter((n) => n <= maxSize);
  const base = nearestPow2(Math.min(srcW, srcH, maxSize));
  const rel = maxMatArea > 0 ? matArea / maxMatArea : 0;
  let target = base;
  if (rel >= 0.6) target = Math.max(target, 2048);
  else if (rel >= 0.35) target = Math.max(target, 1024);
  else if (rel >= 0.15) target = Math.max(target, 512);
  else target = Math.max(target, 256);
  // Snap to allowed not above target, at least smallest allowed.
  target = allowed.reduce((acc, v) => (v <= target ? v : acc), allowed[0]);
  return clampPow2(target, allowed[0], maxSize);
}

// Merge all primitives of a mesh into a single primitive to minimize draw calls.
function mergePrimitivesIntoOne(mesh, doc) {
  const prims = mesh.listPrimitives();
  if (prims.length <= 1) return;

  // Choose canonical attributes to keep.
  const keepAttrs = ['POSITION', 'NORMAL', 'TANGENT', 'TEXCOORD_0'];
  const newPrim = doc.createPrimitive();
  let indexBase = 0;
  const positions = [];
  const normals = [];
  const tangents = [];
  const uvs = [];
  const indices = [];

  // Collect and concatenate.
  for (const prim of prims) {
    const pos = prim.getAttribute('POSITION');
    if (!pos) continue;
    const norm = prim.getAttribute('NORMAL');
    const tan = prim.getAttribute('TANGENT');
    const uv = prim.getAttribute('TEXCOORD_0');
    const idx = prim.getIndices();

    const addVec3 = (attr, arr) => {
      if (!attr) return;
      const array = attr.getArray();
      for (let i = 0; i < array.length; i += 3) {
        arr.push(array[i], array[i + 1], array[i + 2]);
      }
    };
    const addVec4 = (attr, arr) => {
      if (!attr) return;
      const array = attr.getArray();
      for (let i = 0; i < array.length; i += 4) {
        arr.push(array[i], array[i + 1], array[i + 2], array[i + 3]);
      }
    };
    const addVec2 = (attr, arr) => {
      if (!attr) return;
      const array = attr.getArray();
      for (let i = 0; i < array.length; i += 2) {
        arr.push(array[i], array[i + 1]);
      }
    };

    addVec3(pos, positions);
    addVec3(norm, normals);
    addVec4(tan, tangents);
    addVec2(uv, uvs);

    if (idx) {
      const idxArray = idx.getArray();
      for (let i = 0; i < idxArray.length; i++) {
        indices.push(idxArray[i] + indexBase);
      }
      indexBase += pos.getCount();
    } else {
      const vertCount = pos.getCount();
      for (let i = 0; i < vertCount; i++) {
        indices.push(i + indexBase);
      }
      indexBase += vertCount;
    }
  }

  if (!positions.length || !indices.length) return;

  const createAccessor = (arr, type, componentType = 5126) => {
    // 5126 = FLOAT, 5123 = UNSIGNED_SHORT, 5125 = UNSIGNED_INT
    const accessor = doc.createAccessor().setType(type).setArray(new Float32Array(arr));
    return accessor;
  };

  newPrim.setAttribute('POSITION', createAccessor(positions, 'VEC3'));
  if (normals.length === positions.length) newPrim.setAttribute('NORMAL', createAccessor(normals, 'VEC3'));
  if (tangents.length === (positions.length / 3) * 4) newPrim.setAttribute('TANGENT', createAccessor(tangents, 'VEC4'));
  if (uvs.length === (positions.length / 3) * 2) newPrim.setAttribute('TEXCOORD_0', createAccessor(uvs, 'VEC2'));

  const indexComponent = indices.length > 65535 ? 5125 : 5123; // uint32 or uint16
  const idxArray = indexComponent === 5125 ? new Uint32Array(indices) : new Uint16Array(indices);
  const indexAccessor = doc.createAccessor().setType('SCALAR').setArray(idxArray);
  newPrim.setIndices(indexAccessor);

  // Use the material from the first primitive (they should already be unified).
  const firstMat = prims[0].getMaterial();
  if (firstMat) newPrim.setMaterial(firstMat);

  // Replace primitives.
  mesh.listPrimitives().forEach((p) => mesh.removePrimitive(p));
  mesh.addPrimitive(newPrim);
}

async function resizePackInputToScale(packInput, scale) {
  const result = [];
  for (const item of packInput) {
    const newW = Math.max(1, Math.floor(item.width * scale));
    const newH = Math.max(1, Math.floor(item.height * scale));
    const buffer = await sharp(item.data.buffer)
      .resize(newW, newH, { fit: 'inside' })
      .toBuffer();
    result.push({
      ...item,
      width: newW,
      height: newH,
      data: {
        ...item.data,
        buffer,
        width: newW,
        height: newH,
      },
    });
  }
  return result;
}

async function findBestScaleForSingleBin(rects, maxSize, padding) {
  // Fast check at full scale.
  if (canPack(rects, maxSize, padding, 1, 1)) return 1;

  // Find a fitting upper bound by shrinking from 1 until fit.
  let high = 1;
  while (high > 0.01 && !canPack(rects, maxSize, padding, 1, high)) {
    high *= 0.5;
  }
  if (high <= 0.01 && !canPack(rects, maxSize, padding, 1, high)) {
    throw new Error(`Could not fit into a single atlas even after aggressive downscale.`);
  }
  let low = 0;
  let best = high;
  for (let i = 0; i < 10; i++) {
    const mid = (low + high) / 2;
    if (canPack(rects, maxSize, padding, 1, mid)) {
      best = mid;
      low = mid;
    } else {
      high = mid;
    }
  }
  return best;
}

function canPack(rects, maxSize, padding, maxBins, scale) {
  const scaled = rects.map((r) => ({
    ...r,
    width: Math.max(1, Math.floor(r.width * scale)),
    height: Math.max(1, Math.floor(r.height * scale)),
  }));
  try {
    const { bins } = packIntoAtlas(scaled, maxSize, padding, maxBins);
    return bins.length <= maxBins;
  } catch (e) {
    return false;
  }
}

function bakeTextureTransformInPlace(arr, t) {
  if (!t) return;
  const offset = t.getOffset ? t.getOffset() : [0, 0];
  const scale = t.getScale ? t.getScale() : [1, 1];
  const rotation = t.getRotation ? t.getRotation() : 0;
  const cosR = Math.cos(rotation);
  const sinR = Math.sin(rotation);
  for (let i = 0; i < arr.length; i += 2) {
    let u = arr[i];
    let v = arr[i + 1];
    // scale
    u *= scale[0];
    v *= scale[1];
    // rotate about origin
    const ru = u * cosR - v * sinR;
    const rv = u * sinR + v * cosR;
    u = ru;
    v = rv;
    // offset
    u += offset[0];
    v += offset[1];
    arr[i] = u;
    arr[i + 1] = v;
  }
}

function nextTexcoordIndex(prim) {
  const attrs = prim.listAttributes();
  let max = -1;
  for (const attr of attrs) {
    const name = attr.getName?.() || '';
    const match = name.match(/^TEXCOORD_(\d+)$/);
    if (match) {
      const idx = parseInt(match[1], 10);
      if (!Number.isNaN(idx)) max = Math.max(max, idx);
    }
  }
  return max + 1;
}

