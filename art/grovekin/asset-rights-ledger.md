# Grovekin asset-rights ledger

## Source decision

- **Asset family:** Grovekin production still inventory.
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

- **Generator revision:** `grovekin-stills-v1+source-2d38654e5acbd31b2be63afb5710d9fa5c57bc1148a099eebe0dd0b8e119f5df+generator-704c5d032951cafb9ad16ddccde859ad3529139a68b3feee849fbec190e992ed`
- **Source SHA-256:** `2d38654e5acbd31b2be63afb5710d9fa5c57bc1148a099eebe0dd0b8e119f5df`
- **Generator SHA-256:** `704c5d032951cafb9ad16ddccde859ad3529139a68b3feee849fbec190e992ed`
- **Generator:** `art/grovekin/generate.mjs`
- **Canonical drawing source:** `art/grovekin/source.mjs`
- **Generation command:** `node art/grovekin/generate.mjs --output-dir art/grovekin/generated`
- **Output manifest:** `art/grovekin/generated/manifest.json`
- **Output checksums:** `art/grovekin/generated/checksums.sha256`
- **Review matrix:** `art/grovekin/generated/contact-sheet.png`
- **Packed stills:** `art/grovekin/generated/spritesheet/grovekin-stills.png`

The manifest records the palette, all 16 Stage/Condition stills, semantic
flags, dimensions, layout, source/generator digests, and per-file SHA-256 values.
The checksum file covers every generated PNG. Re-running the command from the
same revision produces byte-identical outputs.

## Release boundary

Only the generated PNG outputs listed by the manifest may be packaged by the
extension. The source and review ledger are development evidence, not runtime
assets. If any acceptance criterion fails, release remains blocked while the
generator or definitions are revised; the inventory must not be reduced and no
outside asset may be introduced without a new source and rights decision.
