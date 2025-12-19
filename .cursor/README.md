# AtlasGen Project Overview

## Purpose
Explore generating a texture atlas for `.glb` models and remapping UVs without DCC tools, with a web-accessible workflow for upload, processing, and download.

## Current State
- Fresh workspace with npm initialized.
- Dependencies: `@gltf-transform/core`, `@gltf-transform/functions`, `@gltf-transform/extensions`, `commander`, `sharp`, `maxrects-packer`, `image-size`.
- Documentation scaffold: index, README, Developer Guide, scratchpad.
- CLI at `scripts/atlas-cli.mjs`:
  - Reads GLB, reports textures/materials.
  - Per-map atlases (baseColor, normal, ORM, emissive) with padding and UV set selection.
  - Format controls (`--format-*`, `--quality`), map selection (`--maps`), padding, `--skip-atlas`, `--max-size`.
- Shared atlas core in `scripts/atlas-lib.mjs` (used by CLI and web server).
- Web server/UI: `web/server.mjs` serves `web/public/index.html` for upload → process → download.

## GitHub Pages deployment
- Vite is configured with `base: './'` and `outDir: '../docs'`, so `npm run build:web` emits a static site at repo-root `docs/` that works under the repo subpath.
- Manual deploy: `npm install` → `npm run build:web` → commit/push `docs/` to `main`, then enable GitHub Pages with source `Deploy from a branch` → `main` → `/docs`.
- CI: `.github/workflows/gh-pages.yml` builds on pushes to `main` (`npm ci` + `npm run build:web`) and deploys `docs/` via GitHub Pages. Ensure Pages is enabled for the repo; the workflow publishes automatically.

## Anticipated Structure (to refine as we build)
- `/scripts/` — tooling (e.g., Node CLI for atlas/UV remap).
- `/web/` — web UI for uploads and user interaction.
- `/web/public/` — static UI served by the dev server.
- `/samples/` — test assets and golden outputs.
- `/tests/` — automated checks for atlas output and UV correctness.
- `/sample_glb/` — user-provided large GLB samples for manual testing.

Update this file as new components or directories are added.

Update this file as new components or directories are added.

