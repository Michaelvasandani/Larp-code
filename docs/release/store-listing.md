# Chrome Web Store listing packet

This is proposed Store copy for the exact candidate. It is deliberately
single-purpose and does not claim LeetCode/NeetCode sponsorship or automated
verification.

## Name

larp-code

## Short description

Shared, self-attested NeetCode 150 accountability for two Members and their
Grovekin Pet.

## Detailed description

larp-code gives exactly two adults one shared, time-bounded Challenge: invite a
partner, agree on dates and the pinned 150-problem catalog, record your own
Solves, and see pace and the shared Grovekin Pet condition derived from the
authoritative Challenge Snapshot. Either Member can make an auditable
Correction to their own Solve. The extension never reads coding-site pages,
submissions, cookies, passwords, or source code, and it never claims that a
Solve was independently verified.

The popup remains useful when a connection is unavailable. Committed commands
are recoverable through the worker-owned idempotency boundary; an unfinished
form is only a local draft. Account deletion requires a fresh email code and
ends the shared Challenge according to the public privacy policy.

larp-code is independent and is not affiliated with, endorsed by, or sponsored
by NeetCode or LeetCode. The catalog attribution and complete MIT notice are
available from the packaged Legal and About page.

## Required catalog notice in the Store listing

larp-code is an independent product and is not affiliated with, endorsed by, or sponsored by NeetCode or LeetCode. NeetCode and LeetCode are referenced only to identify the third-party study list and problem destinations used by members.

```text
MIT License

Copyright (c) 2022 neetcode-gh

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Permission justifications

| Surface | Justification shown to the Store |
| --- | --- |
| `storage` | Persist the authenticated extension session, one recoverable command envelope, worker boot evidence, and permitted unfinished drafts in device-local storage. The extension does not use Chrome Sync for shared Challenge data. |
| One exact backend host pattern | Send authenticated Snapshot and command JSON to the configured larp-code Supabase origin and receive its Realtime invalidation signal. No page access or browsing observation is needed. |

No other permission is requested. In particular, the candidate does not request
`tabs`, `cookies`, `webRequest`, `scripting`, `debugger`, `notifications`,
`alarms`, `identity`, broad host access, content scripts, or web-accessible
resources.

## Data-category and Limited Use declarations

The proposed Store form selections are explicit; unchecked categories are not
collected:

- [x] Account information: verified email, non-unique display name, account
  and consent timestamps.
- [x] Authentication information: one-time-code exchange and a provider
  session retained only in the extension's local storage; tokens are never
  logged or shown to the popup.
- [x] Personal communications: Invitation and permitted lifecycle notices.
- [ ] Health/fitness.
- [ ] Financial/payment.
- [ ] Web browsing activity: the extension does not read pages or URLs.
- [x] User-authored content: structured self-attested Solve/Correction fields
  and Challenge terms, not source code or screenshots.
- [x] Identifiers: account and Challenge identifiers needed for authorization
  and idempotent recovery.

The product uses data only to provide its single purpose, secure the service,
and diagnose failures. It does not sell data, use it for advertising or credit
decisions, transfer it for unrelated purposes, or train models. A Member's
structured Challenge record is shared only with the paired Member because that
sharing is the explicit purpose of pairing. Supabase and its configured
transactional mail provider are disclosed service providers. The Limited Use
assertion is applicable to account and Challenge data and does not rely on a
Google API exception.

## Public privacy URL

`privacy.html` is packaged, linked in-product, and is publicly available
without authentication at <https://larp-code.vercel.app/privacy>. The deployed
page was verified byte-for-byte against the packaged source policy on August
16, 2026. The Store submission should use that HTTPS URL.
