# Scratchpad

## Background and Motivation
Explore whether we can generate a texture atlas and remap UVs for `.glb` models without Blender, providing a web-accessible workflow for users to upload, process, and download an updated asset.

## Key Challenges and Analysis
- Selecting a tooling stack (likely Node with `@gltf-transform` or similar) that can both pack textures and adjust UV buffers reliably.
- Handling multiple map types (baseColor, normal, ORM, emissive) with differing resolutions; may need per-map atlases or resampling.
- Preserving PBR correctness (sRGB/linear handling, tangents when normal maps exist).
- Managing shared materials/textures across primitives; avoid breaking references during atlasing.
- Providing a browser-friendly flow (worker-based) for uploads and downloads without blocking the UI.

## High-level Task Breakdown
1) Choose atlas pipeline/library and sample assets; define success criteria for first pass.  
2) Prototype Node/CLI that loads a `.glb`, packs selected maps into an atlas, rewrites UVs, and emits a new `.glb`.  
3) Add automated checks (small samples + golden outputs) to validate atlas layout, UV correctness, and channel handling.  
4) Build a web UI (worker-backed) for upload → process → download, with basic preview and debug info.  
5) Optimize/extend for edge cases (multiple materials, varying texture sizes, normals/ORM, mipmap regen, tangents).  
6) Document usage, known limitations, and update guides.

## Project Status Board
- [x] Pipeline/library decision and sample asset selection (pipeline chosen: Node + @gltf-transform; samples in `sample_glb/`)
- [ ] CLI prototype: load `.glb`, atlas maps, rewrite UVs, emit output (baseColor atlas implemented; extend to more maps/tests)
- [ ] Automated checks for atlas/UV correctness
- [ ] Web UI (upload/process/download + debug info)
- [ ] Edge cases handled (multi-material, normals/ORM, mipmaps/tangents)
- [ ] Documentation updates
- [ ] Web UI modernization (product-style page; Planner plan drafted)
- [ ] Browser-only port (worker, canvas/WebIO; no backend)

## Current Status / Progress Tracking
- Pipeline selected: Node + @gltf-transform for GLB IO and texture/UV manipulation.
- Project scaffolded with npm, directories (`scripts/`, `samples/`, `tests/`, `web/`); sample GLBs available under `sample_glb/`.
- Shared atlas core (`scripts/atlas-lib.mjs`) and CLI (`scripts/atlas-cli.mjs`) support per-map atlases (baseColor, normal, ORM, emissive) with padding, format/quality options, UV set selection, per-map formats/quality, and dump-layout. Multi-file merge via `--folder` supported; merges all meshes/materials into one object/material, bakes transforms, and prunes unused textures. Single-buffer output enforced via `unpartition` + `mergeAllBuffers`.
- Atlas packing: square power-of-two atlases (256–4096), per-map atlases with canonical rect reuse, fallback fills for missing map slots (e.g., emissive black, normal/ORM neutral), density-aware sizing with new `best-fill` mode to better utilize space, automatic downscale to fit single atlas, power-of-two rect sizes, and map-specific lossless WebP for normal/ORM by default.
- UV handling: remap once on canonical map and reuse layout, clone UV accessors to avoid shared overwrite, bake KHR_texture_transform into UVs, force remapped UVs into TEXCOORD_0, apply texcoord selection option, and bake node transforms into geometry (positions/normals/tangents).
- Web server/UI: Express + multer memory upload, multi-file upload/merge, uses shared atlas core, returns layout JSON + base64 GLB; debug log printed server-side. Frontend offers all atlas options (maps, max size, padding, texcoord, per-map formats/quality, resize mode/ceil, max bins), shows status and downloadable GLB.
- Browser-only port in progress: Vite config added, UI now uses a module Worker instead of backend fetch, with placeholder worker echoing first GLB for flow continuity. Next: port atlas pipeline into worker (WebIO + canvas/Squoosh).
- Tests: `tests/verify-atlas.mjs` validates basic stats, UV ranges vs rects, detects duplicates and cross-map inconsistencies, and can dump UVs.

## Executor's Feedback or Assistance Requests
- (none yet)

## Lessons
- Include info useful for debugging in program output.
- Read the file before editing it.
- If vulnerabilities appear in the terminal, run `npm audit` before proceeding.
- Refer to the appropriate documentation file when implementing features.
- When creating images with `sharp`, use `background: { r, g, b, alpha }` for transparency.
- Use map-specific formats: avoid lossy for normals/ORM; JPEG/WebP-lossy acceptable for baseColor/emissive when alpha is not required.

## UI Modernization Plan (Planner)
- Goals: present a modern, product-like single-page UI with clearer hierarchy, responsive layout, and easy debugging/download flow while keeping all existing atlas options.
- Layout: top hero with title/cta, two-column main (left: upload + options grouped in cards; right: status/debug/download panel), collapsible advanced settings, sticky action bar for Start/Cancel.
- Visual style: neutral background, accent color for primary buttons, card surfaces with shadow, consistent spacing/typography, modern file-drop zone with multi-file hint.
- Interaction: drag/drop and click upload, show selected file names, progress/status states, layout JSON viewer, download button with size/format note, error panel.
- Responsiveness: single-column stack on mobile; controls remain usable; sticky actions adapt.
- Success criteria: page loads without JS errors, options preserved, upload/process/download flow works as before, debug log visible and copyable, layout fits 1280px+ and mobile widths gracefully.
- Next executor steps: implement HTML/CSS refactor in `web/public/index.html` (and related static assets), keep form field names consistent, ensure API calls unchanged, verify in browser.***

