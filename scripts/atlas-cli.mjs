#!/usr/bin/env node
/**
 * AtlasGen CLI (prototype)
 * - Loads a .glb/.gltf
 * - Reports texture/material usage
 * - Packs selected textures into per-map atlases and remaps UVs (prototype)
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { Command } from 'commander';
import { NodeIO } from '@gltf-transform/core';
import { listTextureSlots } from '@gltf-transform/functions';
import {
  processAtlas,
  pruneUnusedTextures,
  collapseToSingleMeshAndMaterial,
  mergeAllBuffers,
} from './atlas-lib.mjs';
import { mergeDocuments, unpartition } from '@gltf-transform/functions';

const program = new Command();

program
  .name('atlasgen')
  .description('Prototype: inspect + atlas GLB textures and remap UVs')
  .option('-i, --input <file>', 'Input .glb/.gltf file')
  .option('-o, --output <file>', 'Output .glb path (defaults to <name>.atlas.glb)')
  .option('--folder <dir>', 'Process and merge all .glb/.gltf in a folder')
  .option(
    '--maps <list>',
    'Comma list of map types to atlas (baseColor,normal,orm,emissive)',
    'baseColor,normal,orm,emissive'
  )
  .option('--padding <px>', 'Padding (pixels) between atlas rects', (v) => parseInt(v, 10), 2)
  .option('--max-size <n>', 'Atlas max dimension (power of two)', (v) => parseInt(v, 10), 4096)
  .option('--texcoord <n>', 'Texcoord set to remap (default 0)', (v) => parseInt(v, 10), 0)
  .option('--format-basecolor <fmt>', 'Atlas format for baseColor (png|jpeg|webp)', 'webp')
  .option('--format-normal <fmt>', 'Atlas format for normal (png|webp)', 'webp')
  .option('--format-orm <fmt>', 'Atlas format for ORM (png|webp)', 'webp')
  .option('--format-emissive <fmt>', 'Atlas format for emissive (png|jpeg|webp)', 'webp')
  .option('--quality <n>', 'Quality (0-100) for jpeg/webp', (v) => parseInt(v, 10), 85)
  .option('--max-bins <n>', 'Maximum atlas bins per map', (v) => parseInt(v, 10), 1)
  .option('--resize-mode <mode>', 'Resize mode: none | downscale', 'downscale')
  .option('--resize-ceil <px>', 'Resize ceil when downscaling inputs', (v) => parseInt(v, 10), 4096)
  .option('--dump-layout <file>', 'Write atlas layout JSON to file')
  .option('--skip-atlas', 'Skip atlasing (inspect only)', false)
  .option('--verbose', 'Print detailed texture slot usage', false);

program.parse(process.argv);
const options = program.opts();

const inputPath = options.input ? path.resolve(options.input) : null;
const outputPath = options.output
  ? path.resolve(options.output)
  : options.folder
  ? path.resolve(options.folder, 'merged.atlas.glb')
  : inputPath
  ? path.join(path.dirname(inputPath), `${path.parse(inputPath).name}.atlas.glb`)
  : null;

async function main() {
  const io = new NodeIO();

  let doc;
  let sourceFiles = [];
  if (options.folder) {
    const dir = path.resolve(options.folder);
    const entries = await fs.readdir(dir);
    sourceFiles = entries
      .filter((f) => f.toLowerCase().endsWith('.glb') || f.toLowerCase().endsWith('.gltf'))
      .map((f) => path.join(dir, f))
      .sort();
    if (!sourceFiles.length) {
      throw new Error(`No .glb/.gltf files found in folder ${dir}`);
    }
    console.log(`[atlasgen] Merging ${sourceFiles.length} files from ${dir}`);
    doc = await io.read(sourceFiles[0]);
    for (let i = 1; i < sourceFiles.length; i++) {
      const other = await io.read(sourceFiles[i]);
      mergeDocuments(doc, other);
    }
  } else {
    if (!inputPath) throw new Error('Input file is required when not using --folder.');
    sourceFiles = [inputPath];
    console.log(`[atlasgen] Reading ${inputPath}`);
    doc = await io.read(inputPath);
  }

  const slots = listTextureSlots(doc);
  const materialCount = doc.getRoot().listMaterials().length;
  const textureCount = doc.getRoot().listTextures().length;

  console.log(
    `[atlasgen] Detected ${materialCount} material(s), ${textureCount} texture(s).`
  );

  if (options.verbose) {
    slots.forEach((slot) => {
      console.log(
        `  texture #${slot.textureIndex ?? '-'} | slot=${slot.slot} | material=${slot.materialName}`
      );
    });
  }

  if (!options.skipAtlas) {
    const maps = options.maps
      .split(',')
      .map((m) => m.trim().toLowerCase())
      .filter(Boolean);

    const formats = {
      basecolor: options.formatBasecolor.toLowerCase(),
      normal: options.formatNormal.toLowerCase(),
      orm: options.formatOrm.toLowerCase(),
      emissive: options.formatEmissive.toLowerCase(),
    };

    const { layout, atlasTextures } = await processAtlas(doc, {
      maps,
      maxSize: options.maxSize,
      padding: options.padding,
      texcoord: options.texcoord,
      formats,
      quality: options.quality,
      verbose: options.verbose,
      maxBins: options.maxBins,
      resizeMode: options.resizeMode,
      resizeCeil: options.resizeCeil,
    });

    if (options.dumpLayout) {
      await fs.writeFile(options.dumpLayout, JSON.stringify(layout, null, 2), 'utf8');
      console.log(`[atlasgen] Wrote layout to ${options.dumpLayout}`);
    }

    // Collapse to single mesh/material with atlas textures.
    collapseToSingleMeshAndMaterial(doc, atlasTextures);

  await doc.transform(unpartition());
  mergeAllBuffers(doc);
    pruneUnusedTextures(doc);
  } else {
    console.log('[atlasgen] --skip-atlas set; skipping atlas/UV changes.');
  }

  console.log(`[atlasgen] Writing to ${outputPath}`);
  await io.write(outputPath, doc);
  console.log('[atlasgen] Done.');
}

main().catch((err) => {
  console.error('[atlasgen] Failed:', err);
  process.exitCode = 1;
});

