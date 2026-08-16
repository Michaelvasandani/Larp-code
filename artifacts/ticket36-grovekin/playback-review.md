# Grovekin playback review checklist

- [x] Four Stage-specific two-frame idle/blink loops are generated with timing.
- [x] Hungry, Sad, and Deteriorated accents keep their authoritative static
  Stage/Condition still beneath the animation layer, with four stage-aware
  variants each.
- [x] Solve reaction frames are stage-aware and preserve all four current
  Stages.
- [x] Solve and each adjacent 1→2, 2→3, and 3→4 evolution playback are
  selected only from committed Snapshot revision changes.
- [x] Completion selects the Stage-4 farewell event in a transient overlay;
  the committed terminal view does not retain a Pet.
- [x] Reduced motion disables loop and event playback while retaining the
  static Stage/Condition image and text.
- [x] Setup, Scheduled, unavailable, and terminal views do not render the Pet
  presentation component.
- [x] Runtime assets are copied into the extension-page-only `assets/grovekin`
  package path and have generated SHA-256 inventory entries.

The generated contact sheet and animation spritesheet are the deterministic
pixel-art review surfaces; no outside or image-generation-model assets are
used.
