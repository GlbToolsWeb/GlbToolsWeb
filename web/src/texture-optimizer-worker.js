import { WebIO } from '@gltf-transform/core';
import { KHRTextureTransform } from '@gltf-transform/extensions';

self.onmessage = async (event) => {
  const { file, opts = {} } = event.data || {};
  if (!file) {
    postError('No file provided');
    return;
  }
  try {
    const buffer = new Uint8Array(await file.arrayBuffer());
    const io = new WebIO().registerExtensions([KHRTextureTransform]);
    const doc = await io.readBinary(buffer);

    await optimizeTextures(doc, opts);

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

async function optimizeTextures(doc, opts) {
  const format = (opts.format || 'webp').toLowerCase();
  const quality = Number(opts.quality ?? 85);
  const maxSize = Number(opts.maxSize || 4096);

  const mime =
    format === 'png' ? 'image/png' :
    format === 'jpeg' || format === 'jpg' ? 'image/jpeg' :
    'image/webp';

  const textures = doc.getRoot().listTextures();
  for (const tex of textures) {
    const img = tex.getImage();
    if (!img) continue;
    const resized = await resizeAndEncode(img, maxSize, mime, quality);
    tex.setImage(resized);
    tex.setMimeType(mime);
  }
}

async function resizeAndEncode(img, maxSize, mime, quality) {
  const src = img instanceof Blob ? img : new Blob([img]);
  const bmp = await createImageBitmap(src);
  let { width, height } = bmp;
  const scale = Math.min(1, maxSize / Math.max(width, height));
  const targetW = Math.max(1, Math.floor(width * scale));
  const targetH = Math.max(1, Math.floor(height * scale));

  const canvas = new OffscreenCanvas(targetW, targetH);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, targetW, targetH);
  ctx.drawImage(bmp, 0, 0, targetW, targetH);

  const isLossy = mime === 'image/jpeg' || mime === 'image/webp';
  const blob = await canvas.convertToBlob({
    type: mime,
    quality: isLossy ? clamp01(quality / 100) : undefined,
  });
  bmp.close();
  const arr = await blob.arrayBuffer();
  return new Uint8Array(arr);
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

