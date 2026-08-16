# Permission and network contract

## Manifest inventory

| Key | Candidate value | Reason |
| --- | --- | --- |
| `manifest_version` | `3` | Required event-driven extension model |
| `permissions` | `storage` only | Device-local session, recovery, and draft storage |
| `host_permissions` | `${SUPABASE_URL}/*` for one exact HTTPS origin | Authenticated larp-code API and Realtime backend |
| `action.default_popup` | `popup.html` | Popup-only product surface |
| `background.service_worker` | `service-worker.js`, module | Packaged worker owns network and storage |
| `web_accessible_resources` | omitted | No ordinary webpage needs extension resources |

The manifest must not contain broad host patterns or these unused capabilities:
`tabs`, `activeTab`, `cookies`, `webRequest`, `scripting`, `debugger`,
`notifications`, `alarms`, `identity`, `offscreen`, content scripts, or
`web_accessible_resources`.

## Allowed network

The only allowed HTTP origin is the exact `SUPABASE_URL` origin supplied at
build time. The only allowed realtime origin is the matching `ws:`/`wss:` host
derived from it. Production uses HTTPS/WSS; HTTP/WS is accepted only by local
development tooling and is rejected by the publication checker.

The extension does not call `leetcode.com`, `neetcode.io`,
`github.com/neetcode-gh/leetcode`, a CDN, an analytics endpoint, a remote code
loader, or a tracking pixel. Catalog links are ordinary member-clicked public
links rendered from the pinned import; they are not fetched by extension code.

## Automated assertions

`scripts/check-publication-package.mjs` inspects a directory or ZIP, validates
the manifest and CSP, scans executable code for undeclared origins and dynamic
code, checks the public legal/privacy links and notices, verifies all generated
Grovekin checksums, and fails on secret/development material. The checker is a
release gate, not evidence that a production deployment or human disclosure
review has occurred.

`scripts/network-trace.mjs capture` records runtime HTTP(S)/WSS requests from
the popup and service worker. The committed trace is controlled local evidence
with `productionEvidence: false`; strict release qualification requires a
separate production-controlled trace with the exact HTTPS/WSS origin.
