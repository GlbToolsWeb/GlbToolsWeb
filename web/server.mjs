import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { mergeDocuments, unpartition } from '@gltf-transform/functions';
import {
  processAtlas,
  pruneUnusedTextures,
  collapseToSingleMeshAndMaterial,
  mergeAllBuffers,
} from '../scripts/atlas-lib.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 400 * 1024 * 1024 }, // 400 MB cap for now
});

app.use(express.static(publicDir));

app.post('/api/atlas', upload.any(), async (req, res) => {
  try {
    const files = (req.files || []).filter((f) => f.fieldname === 'models' || f.fieldname === 'model');
    if (!files.length) {
      res.status(400).send('Missing file field "models"');
      return;
    }

    const maps =
      (req.body.maps || 'baseColor,normal,orm,emissive')
        .split(',')
        .map((m) => m.trim().toLowerCase())
        .filter(Boolean) || ['basecolor', 'normal', 'orm', 'emissive'];

    const maxSize = parseInt(req.body.maxSize || '4096', 10);
    const padding = parseInt(req.body.padding || '2', 10);
    const texcoord = parseInt(req.body.texcoord || '0', 10);
    const quality = parseInt(req.body.quality || '90', 10);
    const maxBins = parseInt(req.body.maxBins || '1', 10);
    const resizeMode = (req.body.resizeMode || 'downscale').toLowerCase();
    const resizeCeil = parseInt(req.body.resizeCeil || '4096', 10);

    const formats = {
      basecolor: (req.body.formatBasecolor || 'png').toLowerCase(),
      normal: (req.body.formatNormal || 'png').toLowerCase(),
      orm: (req.body.formatOrm || 'png').toLowerCase(),
      emissive: (req.body.formatEmissive || 'png').toLowerCase(),
    };

    const io = new NodeIO();
    const first = await io.readBinary(files[0].buffer);
    for (let i = 1; i < files.length; i++) {
      const next = await io.readBinary(files[i].buffer);
      mergeDocuments(first, next);
    }
    const doc = first;

    const { layout, atlasTextures } = await processAtlas(doc, {
      maps,
      maxSize,
      padding,
      texcoord,
      formats,
      quality,
      maxBins,
      resizeMode,
      resizeCeil,
    });

    // Collapse to single mesh/material with atlas textures.
    collapseToSingleMeshAndMaterial(doc, atlasTextures);

    await doc.transform(unpartition());
    mergeAllBuffers(doc);
    pruneUnusedTextures(doc);

    const outBinary = await io.writeBinary(doc);
    res.setHeader('Content-Type', 'application/json');
    res.send({
      layout,
      glb: Buffer.from(outBinary).toString('base64'),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send(err?.message || 'Processing failed');
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`[atlasgen] Server listening on http://localhost:${port}`);
  console.log(`[atlasgen] Serving static UI from ${publicDir}`);
});

