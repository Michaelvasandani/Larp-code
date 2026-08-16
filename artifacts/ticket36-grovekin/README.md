# Ticket 36 Grovekin integration evidence

The production runtime package copies only the generated files under
`assets/grovekin/`. The packaged manifest and animation checksum inventory are
at `dist/assets/grovekin/manifest.json` and
`dist/assets/grovekin/animation-checksums.sha256` after `pnpm build`.

The reviewed source matrix is `art/grovekin/generated/contact-sheet.png`; the
reviewed packed animation matrix is
`art/grovekin/generated/spritesheet/grovekin-animations.png`. Both are
reproducible from the project-authored generator and are covered by the
provenance ledger. The popup playback seam is covered by
`tests/grovekin-motion.test.ts`: only a changed authoritative Snapshot revision
can trigger Solve, adjacent-Stage evolution, condition accents, or completion
farewell. The static Stage/Condition still remains in the DOM under every
animation frame, and reduced motion displays that still without playback.

For real-popup review, run `pnpm build && node scripts/grovekin-evidence.mjs`.
That harness serves the packaged `dist/` popup in Chrome at `380 × 600`, drives
authoritative Snapshot revisions, and records the full 4 × 4 Stage/Condition
matrix plus idle, Solve, evolution, transient farewell, and reduced-motion
screenshots under `screenshots/`. Setup, Scheduled, unavailable, and terminal
views must contain no persistent Grovekin animation; the completion overlay is
one-shot and disappears after the farewell clip.
