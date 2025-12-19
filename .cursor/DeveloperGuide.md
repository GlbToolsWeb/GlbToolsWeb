# Developer Guide

## Atlas Generation & UV Remap Pattern
- Load `.glb` via a GLTF library (e.g., `@gltf-transform/core` in Node).
- Gather material textures (baseColor, normal, ORM, emissive); decide which to atlas together versus per-map atlases if resolutions differ.
- Pack source textures into an atlas (rectangle bin-packing, e.g., `maxrects-packer`). Preserve sRGB/linear handling per map type.
- Composite atlas images with an image pipeline (e.g., `sharp`), keeping channel spaces correct (baseColor/emissive sRGB; normals/ORM linear).
- For each primitive, remap UVs into the atlas region: `uv' = rectMin + uv * rectSize`; apply V-flip if needed by the pipeline; allow selecting texcoord set.
- Write atlas images and update GLTF image/texture/material references; prune unused assets.
- Regenerate mipmaps; recompute tangents if normal maps are present and geometry changed.
- Share atlas logic as a module (`scripts/atlas-lib.mjs`) so CLI and web server reuse the same pipeline.

## Testing Approach (TDD-friendly)
- Use small sample `.glb` files and expected atlas outputs (golden images + UV buffers).
- Compare atlas layout metadata (rects) and ensure meshes render without seams.
- Validate channel correctness per map type (sRGB for baseColor/emissive, linear for normals/ORM).
- Include debug logs with rect placements and any rescaling to aid troubleshooting.
- Prefer lossless formats for normals/ORM; lossy acceptable for opaque baseColor/emissive if size is critical.

## Web UI Pattern
- Provide upload for `.glb` (with embedded or referenced textures).
- Run processing in a web worker to keep UI responsive.
- Offer download of the re-atlased `.glb` and atlas images; display before/after previews if feasible.
- Surface debugging info (atlas layout, map types included) in the UI for user feedback.

Add new patterns or decisions here as the implementation evolves.

