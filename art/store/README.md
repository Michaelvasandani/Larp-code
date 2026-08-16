# Store listing assets

`generated/` contains the candidate's static toolbar icons, a small
promotional image, and three representative popup screenshots. Run:

```sh
node art/store/generate.mjs
```

The icons and promotional art are project-authored deterministic pixel art
drawn by the same palette family as Grovekin. The screenshots are copied from
the reviewed Ticket 36 packaged playback evidence; they are listing evidence,
not runtime resources. No listing asset is loaded from a remote origin.

The runtime package emits only `icon-16.png`, `icon-48.png`, and
`icon-128.png` under `icons/`. Popup art remains private to extension pages and
the manifest intentionally omits `web_accessible_resources`.
