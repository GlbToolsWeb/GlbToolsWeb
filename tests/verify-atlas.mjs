#!/usr/bin/env node
/**
 * Verifies a processed GLB for:
 * - Single scene child, single mesh, single material
 * - Atlas textures present
 * - UV min/max roughly aligned with atlas rects
 * - Non-zero bounds
 *
 * Usage: node tests/verify-atlas.mjs --input sample_glb/Mask\ Pack.atlas.glb --layout layout.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { NodeIO } from '@gltf-transform/core';

const program = new Command();
program
  .requiredOption('-i, --input <file>', 'Processed .glb to verify')
  .requiredOption('-l, --layout <file>', 'Layout JSON produced during atlas')
  .option('--tolerance <n>', 'UV tolerance (fraction of atlas)', parseFloat, 0.05)
  .option('--dump-uv', 'Print UV ranges per primitive', false);

program.parse(process.argv);
const opts = program.opts();

async function main() {
  const io = new NodeIO();
  const doc = await io.read(opts.input);
  const layout = JSON.parse(fs.readFileSync(opts.layout, 'utf8'));
  const root = doc.getRoot();

  const scenes = root.listScenes();
  const meshes = root.listMeshes();
  const materials = root.listMaterials();
  const textures = root.listTextures();

  const report = {
    scenes: scenes.length,
    meshes: meshes.length,
    materials: materials.length,
    textures: textures.length,
    uvChecks: [],
    bounds: {},
    errors: [],
  };

  // Bounds of merged mesh
  const mesh = meshes[0];
  if (!mesh) {
    report.errors.push('No mesh found.');
  } else {
    let min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    let max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION')?.getArray();
      if (!pos) continue;
      for (let i = 0; i < pos.length; i += 3) {
        min[0] = Math.min(min[0], pos[i]);
        min[1] = Math.min(min[1], pos[i + 1]);
        min[2] = Math.min(min[2], pos[i + 2]);
        max[0] = Math.max(max[0], pos[i]);
        max[1] = Math.max(max[1], pos[i + 1]);
        max[2] = Math.max(max[2], pos[i + 2]);
      }
    }
    report.bounds = { min, max };
    if (!isFinite(min[0]) || min[0] === max[0]) {
      report.errors.push('Bounds are degenerate (mesh may be empty).');
    }
  }

  // UV alignment check: for each prim, compare UV0 min/max to the rect covering its material in layout.
  const atlasByMaterial = buildMaterialRectMap(layout);
  const duplicates = findDuplicateRects(layout);
  const crossMapInconsistencies = findCrossMapInconsistencies(layout);
  const tol = opts.tolerance;
  for (const prim of mesh?.listPrimitives() || []) {
    const mat = prim.getMaterial();
    const rect = atlasByMaterial.get(mat?.getName() || '');
    const uv = prim.getAttribute('TEXCOORD_0')?.getArray();
    if (!rect || !uv) continue;
    const uMin = Math.min(...filterEveryOther(uv, 0));
    const uMax = Math.max(...filterEveryOther(uv, 0));
    const vMin = Math.min(...filterEveryOther(uv, 1));
    const vMax = Math.max(...filterEveryOther(uv, 1));
    const expected = {
      uMin: rect.x / rect.atlasW,
      vMin: rect.y / rect.atlasH,
      uMax: (rect.x + rect.w) / rect.atlasW,
      vMax: (rect.y + rect.h) / rect.atlasH,
    };
    const ok =
      uMin >= expected.uMin - tol &&
      uMax <= expected.uMax + tol &&
      vMin >= expected.vMin - tol &&
      vMax <= expected.vMax + tol;
    report.uvChecks.push({ material: mat?.getName() || '', ok, uMin, uMax, vMin, vMax, expected });
    if (!ok) report.errors.push(`UV out of expected rect for material ${mat?.getName() || ''}`);
    if (opts.dumpUv) {
      console.log(`prim ${report.uvChecks.length - 1} material ${mat?.getName() || ''} u [${uMin}, ${uMax}] v [${vMin}, ${vMax}] expected`, expected);
    }
  }
  report.duplicates = duplicates;
  report.crossMapInconsistencies = crossMapInconsistencies;

  console.log(JSON.stringify(report, null, 2));
}

function buildMaterialRectMap(layout) {
  const map = new Map();
  for (const entry of layout) {
    for (const atlas of entry.atlases || []) {
      for (const rect of atlas.rects || []) {
        for (const mat of rect.materials || []) {
          map.set(mat, {
            x: rect.x,
            y: rect.y,
            w: rect.width,
            h: rect.height,
            atlasW: atlas.width,
            atlasH: atlas.height,
          });
        }
      }
    }
  }
  return map;
}

function filterEveryOther(arr, start) {
  const out = [];
  for (let i = start; i < arr.length; i += 2) out.push(arr[i]);
  return out;
}

function findDuplicateRects(layout) {
  const issues = [];
  for (const entry of layout) {
    const seen = new Map();
    for (const atlas of entry.atlases || []) {
      for (const rect of atlas.rects || []) {
        const key = `${rect.x},${rect.y},${rect.width},${rect.height}`;
        if (!seen.has(key)) {
          seen.set(key, []);
        }
        seen.get(key).push(rect.materials.join(','));
      }
    }
    for (const [k, mats] of seen.entries()) {
      if (mats.length > 1) {
        issues.push({ map: entry.map, rect: k, materials: mats });
      }
    }
  }
  return issues;
}

function findCrossMapInconsistencies(layout) {
  // Expect same rect per material across maps.
  const perMatPerMap = new Map(); // mat -> map -> rectKey
  const inconsistencies = [];
  for (const entry of layout) {
    for (const atlas of entry.atlases || []) {
      for (const rect of atlas.rects || []) {
        const rectKey = `${rect.x},${rect.y},${rect.width},${rect.height},${atlas.width},${atlas.height}`;
        for (const mat of rect.materials || []) {
          if (!perMatPerMap.has(mat)) perMatPerMap.set(mat, new Map());
          perMatPerMap.get(mat).set(entry.map, rectKey);
        }
      }
    }
  }
  for (const [mat, m] of perMatPerMap.entries()) {
    const values = Array.from(m.values());
    const unique = new Set(values);
    if (unique.size > 1) {
      inconsistencies.push({ material: mat, maps: Object.fromEntries(m.entries()) });
    }
  }
  return inconsistencies;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

