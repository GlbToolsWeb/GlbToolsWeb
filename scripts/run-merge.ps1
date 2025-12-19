param(
  [string]$Folder = "merge_glb",
  [string]$Output = ""
)

if (-not $Output) {
  $Output = Join-Path $Folder "merged.atlas.glb"
}

node scripts/atlas-cli.mjs --folder "$Folder" --output "$Output" --dump-layout layout.json --maps baseColor,normal,orm,emissive

