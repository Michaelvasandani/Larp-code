# Grovekin production stills

Grovekin production art is original, project-authored pixel art. `source.mjs`
is the canonical deterministic palette, pose, and drawing source; the extension
does not draw the Pet at runtime.

Generate the checked-in review inventory with:

```sh
node art/grovekin/generate.mjs --output-dir art/grovekin/generated
```

The generator emits 16 transparent straight-alpha `48 × 48` stills in
stage-major order. The four rows of `contact-sheet.png` are Evolution Stages 1
through 4; its four columns are Healthy, Hungry, Sad, and Deteriorated. The
`spritesheet/grovekin-stills.png` uses the same order in a `4 × 4` grid.

`manifest.json` records the source and generator SHA-256-pinned revision,
palette, pose semantics, layout, and per-file SHA-256 values.
`checksums.sha256` covers every generated PNG. The generator uses integer pixel
operations, straight RGBA, and PNG filter type 0 so no interpolation or
antialiasing is introduced.

This ticket deliberately ships the static source inventory only. Animation
clips and runtime integration belong to the subsequent art integration ticket;
no incomplete clip metadata or nonexistent animation frames are represented in
this manifest. The generated files are the reviewed static source inventory and
its reproducibility evidence.
