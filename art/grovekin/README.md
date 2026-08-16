# Grovekin production art

Grovekin production art is original, project-authored pixel art. `source.mjs`
is the canonical deterministic palette, pose, and drawing source, while
`clip-registry.json` is the canonical clip/timing/variant registry shared by
generation and the popup; the extension does not draw the Pet at runtime.

Generate the checked-in review inventory with:

```sh
node art/grovekin/generate.mjs --output-dir art/grovekin/generated
```

The generator emits 16 transparent straight-alpha `48 × 48` stills in
stage-major order. The four rows of `contact-sheet.png` are Evolution Stages 1
through 4; its four columns are Healthy, Hungry, Sad, and Deteriorated. The
`spritesheet/grovekin-stills.png` uses the same order in a `4 × 4` grid.
It also emits the complete animation inventory: four two-frame Stage idle
loops, condition accents, an authoritative Solve reaction, one adjacent-Stage
evolution transition, and the Stage-4 farewell. Animation frames are packed in
`spritesheet/grovekin-animations.png`; timing and event semantics are recorded
in `manifest.json` and its separate `animation-checksums.sha256` inventory.

`manifest.json` records the source, clip-registry, and generator SHA-256-pinned revision,
palette, pose semantics, layout, and per-file SHA-256 values.
`checksums.sha256` covers the still PNGs and static sheets, while
`animation-checksums.sha256` covers every animation frame and the animation
sheet. The generator uses integer pixel operations, straight RGBA, and PNG
filter type 0 so no interpolation or antialiasing is introduced.
