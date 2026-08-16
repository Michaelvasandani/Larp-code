# Production release qualification workflow

Ticket 41 qualification is a fail-closed, evidence-only Gate 6 workflow. The
record at [`release-qualification.json`](../../artifacts/ticket41-qualification/release-qualification.json)
binds one candidate archive to its package version, source commit, SHA-256,
backend compatibility envelope, catalog revision, and generated-art checksums.
It also records the evidence state for production infrastructure, mail,
monitoring, recovery, the packaged two-account journey, primary-source
rechecks, cumulative Gates 0–6, publisher controls, and owner residual risk.

Run `pnpm release:check` after supplying a real release origin and publishable
client key through the environment. It performs package/archive/trace checks
and audits the qualification record. A record is eligible only when every
required check is positively evidenced. `pnpm release:check` exits non-zero
for a missing or stale record, a draft/local candidate, incomplete evidence,
missing primary-source rechecks, an unconfirmed publisher control, or an
unaccepted residual-risk record.

## Evidence rules

“Code complete” is a useful local status, but it is not production evidence.
Every external check must identify a dated, privacy-safe evidence reference
and an explicit environment. Provider dashboards and controlled production
reports are authoritative for Supabase, Resend, monitoring, recovery, and
deliverability settings. The two-account suite must be run against production
or an equivalently controlled release environment and must record outcomes,
not credentials, email addresses, OTPs, tokens, or Member Data.

The record cites only first-party sources for Chrome, NeetCode, LeetCode,
Supabase, and Resend. Each URL is rechecked immediately before release and
records the exact constraint and result. A changed, unavailable, stale, or
unrechecked source blocks qualification until its impact is reconciled.

Gates are cumulative: the first failed gate is the earliest reopened gate,
and every later gate must be marked blocked or reopened. Passing local tests
does not override an external blocker. The owner may accept only the bounded
catalog/brand/copyright/terms/Store-enforcement risk for this exact candidate;
the record must not claim rights-holder authorization or provide legal advice.

The workflow records `submissionPerformed: false` and never submits to the
Chrome Web Store. Submission, if later authorized, remains a separate human-
controlled action after the record passes and the final digest is independently
verified.

