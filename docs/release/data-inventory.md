# Publication data and disclosure inventory

| Data | Collected where | Purpose | Recipient/access | Retention/deletion |
| --- | --- | --- | --- | --- |
| Verified email and account identity | OTP auth and account setup | Sign-in, account binding, Invitation routing | The Member, paired Challenge where required, Supabase auth/database | Account lifetime; deletion replaces identity in retained terminal record |
| Invitation terms | Create/accept/revoke/decline commands | Pairing and lifecycle | The two affected Members, Supabase | Terminal Invitation details logically unavailable after 30 days |
| Challenge terms and membership | Invitation acceptance | Shared Challenge operation | The two Challenge Members, Supabase | Terminal records up to 12 months, then retention cleanup |
| Problem ID, Solve and Correction metadata | Explicit popup actions | Self-attested progress and auditable correction | Both Challenge Members, Supabase | With Challenge record; no source code, screenshots, or submission URL |
| Pace, totals, Pet condition/evolution | Derived backend Snapshot | Shared display only | Both Challenge Members, popup | Derived from Challenge record; no independent verification claim |
| Provider session and recoverable idempotency key | Device-local extension storage | Restore auth and safely finish an interrupted command | This browser/worker only | Cleared on sign-out, successful deletion, or uninstall |
| Unfinished form draft | Device-local extension storage | Restore a popup form after focus close | This browser/worker only; account drafts keyed to account | Cleared by user/account deletion; never authoritative |
| Diagnostic/security metadata | Backend operational boundary | Availability, abuse, and support diagnosis | Least-privileged operators only when an allowed support/security case exists | Diagnostics up to 30 days; security/audit metadata up to 90 days |

The backend and provider logs are not a second behavioral dataset: they omit
email, tokens, OTPs, Solve content, complete Snapshots, partner progress, and
Pet state unless a source record is required for the disclosed Challenge
operation. Human support is disabled by default, least privileged, and logged.

No analytics SDK, ad network, remote code, browser activity observer, or
LeetCode/NeetCode request exists in the candidate.
