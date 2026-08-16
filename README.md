# larp-code

Ticket 19 establishes the packaged foundation for the popup-only Manifest V3
extension. The popup is React/TypeScript/Vite, while the event-driven service
worker is the only owner of Supabase, extension storage, and popup messaging.

## Local development

Requirements: Node.js, pnpm, Docker Desktop, and Google Chrome.

```bash
pnpm install
pnpm backend:start
pnpm dev
```

The local Supabase API is `http://127.0.0.1:54321`; the local OTP mailbox is
available at `http://127.0.0.1:54324`. The build reads the local API URL and
publishable key from `supabase status`. A production-style build can instead
use `SUPABASE_URL` and `SUPABASE_ANON_KEY`; the generated manifest permits only
that exact backend origin and its matching Realtime origin.

## Verification

`pnpm verify` is the single baseline entrypoint. It starts and stops local
Supabase, then runs typechecking, linting, Vitest, the packaged build, manifest
and executable-code inspection, and the real-Chrome popup/service-worker smoke
journey. The smoke journey opens the packaged popup at `380 × 600`, closes and
reopens it, terminates the actual extension service worker through Chrome
DevTools Protocol, and confirms that the popup reconnects to a fresh worker.

For fast checks without Chrome, use:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm package:check
```

The foundation intentionally does not implement OTP, Member setup, Challenge
domain commands, or Pet behavior. Those later tickets consume the versioned
`src/shared/protocol.ts` discriminants and worker seam.
