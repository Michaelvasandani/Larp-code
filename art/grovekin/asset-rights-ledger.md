# Grovekin asset-rights ledger

## Source decision

- **Asset family:** Grovekin production still and animation inventory.
- **Authorship:** project-authored, original in-house procedural pixel art.
- **Contributor/right status:** larp-code project contributors retain the
  project rights needed to modify, build, package, and distribute these files.
  No outside contributor, commissioned artist, marketplace pack, or stock
  source supplied production pixels or drawing code.
- **External-art declaration:** the production files contain no third-party,
  commissioned, marketplace, copied, traced, or image-generation-model output.
  There is no image-generation-model output in the accepted production set.
  Generic botanical or pixel-art references do not appear as embedded assets.

## Reproducible source record

- **Generator revision:** `grovekin-stills-v1+source-ce2d31749af5b225517ca9b196e1fa5725435497e0786dd833ff88cc8c610e33+generator-1226757e8372848e8c53c764322d093fccdbb04158630ae169c203e09b69cc16`
- **Source SHA-256:** `ce2d31749af5b225517ca9b196e1fa5725435497e0786dd833ff88cc8c610e33`
- **Clip registry SHA-256:** `69b2c2ad7236361900f896d2fb744d19cc12f44ffc5cb6a05d0b6cd22f00cb1b`
- **Generator SHA-256:** `1226757e8372848e8c53c764322d093fccdbb04158630ae169c203e09b69cc16`
- **Generator:** `art/grovekin/generate.mjs`
- **Canonical drawing source:** `art/grovekin/source.mjs`
- **Canonical clip registry:** `art/grovekin/clip-registry.json`
- **Generation command:** `node art/grovekin/generate.mjs --output-dir art/grovekin/generated`
- **Output manifest:** `art/grovekin/generated/manifest.json`
- **Output checksums:** `art/grovekin/generated/checksums.sha256`
- **Review matrix:** `art/grovekin/generated/contact-sheet.png`
- **Packed stills:** `art/grovekin/generated/spritesheet/grovekin-stills.png`
- **Animation manifest:** `art/grovekin/generated/manifest.json` (`clips`, `frames`, and timing)
- **Animation checksums:** `art/grovekin/generated/animation-checksums.sha256`
- **Packed animations:** `art/grovekin/generated/spritesheet/grovekin-animations.png`

The manifest records the palette, all 16 Stage/Condition stills, the complete
clip/frame/timing inventory, semantic flags, dimensions, layout,
source/generator digests, and per-file SHA-256 values. The two checksum files
cover every generated PNG. Re-running the command from the same revision
produces byte-identical outputs.

## Release boundary

Only the generated PNG outputs listed by the manifest may be packaged by the
extension. The source and review ledger are development evidence, not runtime
assets. If any acceptance criterion fails, release remains blocked while the
generator or definitions are revised; the inventory must not be reduced and no
outside asset may be introduced without a new source and rights decision.
