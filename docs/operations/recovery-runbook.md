# Managed database recovery runbook

This runbook is the Gate 4 evidence path for `OPS-023`–`OPS-026`. It is
written for the production-shaped local rehearsal as well as the managed
production project. The recovery report contains timestamps, check names,
durations, failures, and corrective actions only. It must never contain Member
Data, a complete Snapshot, an email address, an OTP, a token, a password, or a
provider credential.

## Required production configuration (`OPS-023`)

The production database provider must have all of the following configured and
recorded in the release evidence (the provider dashboard is authoritative for
the setting; the database table records the required envelope):

- Managed point-in-time recovery is enabled with a seven-day recovery window.
- Encrypted managed backups are enabled, with a retention ceiling of 30 days.
- The recovery project and backup access use least-privilege operator access;
  credentials remain in the provider secret manager and never in this repo or
  a report.
- The service does not promise zero data loss. A restore can lose acknowledged
  transactions after the selected safe restore point.

The local rehearsal uses the repository's local managed-Postgres-shaped
Supabase environment and Mailpit-compatible transport. It does not connect to
production and does not copy production rows.

## Suspected destructive incident (`OPS-024`)

1. Declare an incident reference that contains no Member Data. Record the fault
   time from the provider audit trail.
2. Freeze application writes with `begin_recovery_freeze_v1`. The service-role
   seam records the incident, fault time, and selected point; the database write
   guard rejects authenticated application writes while the phase is `frozen`
   or `restoring`.
3. Select the latest managed restore point strictly before the fault and no
   older than seven days with `select_latest_safe_recovery_point_v1`. Never
   choose a point after the suspected fault. Preserve the original database
   until the isolated restore has passed validation.
4. Start restore with `begin_recovery_restore_v1`. Packaged clients receive
   `recoveryPhase: "restoring"` in safe foundation metadata and render the
   ordinary **Current state is unavailable** surface. They do not queue a new
   domain mutation; an already-sent idempotency envelope remains the only
   recoverable pending command.

## Restore validation (`OPS-025`)

Restore into the isolated managed project/branch, apply the currently shipped
migrations, and run `validate_recovery_v1` with the Mailpit/Resend check. The
validation must pass every check before reopening:

| Check | Evidence |
| --- | --- |
| Schema version | Foundation health reports schema version 14. |
| Grants and RLS | Domain tables retain RLS and only intended service-role grants. |
| Auth access | Auth schema and verified-session path are reachable. |
| Current/previous AppSnapshot contracts | Contract metadata is exactly `[1, 2]`. |
| Current/previous command contracts | Command compatibility metadata is exactly `[1, 2]`. |
| Idempotency records | Keys, intents, and stored results remain durable and unique. |
| Member commitments | No Member has two commitments; committed Challenges have two. |
| Lifecycle invariants | Challenges have two Members; terminal records have no commitment. |
| Realtime publication | `challenges`, `solves`, and `solve_corrections` remain published. |
| Scheduled jobs | Reconciliation and retention functions remain installed. |
| Retention cutoffs | Retention ledger/function and all required cutoffs remain present. |
| Mail integration | A safe test message is accepted by the configured transport. |

The operator then retries any client-held command with its original
idempotency key and confirms the stored result is returned exactly once. The
exercise must not log the key, Member identity, or command payload.

## Reopen and evidence

Call `reopen_after_recovery_v1` only with a successful validation ID and a
privacy-safe report containing the scenario, selected restore point, measured
freeze/restore/retry behavior, failures, and corrective actions. The function
opens the write gate atomically with report insertion. Capture the dated report
identifier in the release evidence, not Member rows.

## Durability language (`OPS-026`)

The ordinary interruption statement is: “If a popup, worker, or network
request is interrupted, larp-code retries the same idempotency key until the
stored result or a known non-success is obtained.”

The catastrophic restore statement is: “A restore recovers the latest safe
managed point. Acknowledged transactions after that point may be lost.”

Do not say “zero data loss,” “all acknowledged writes are guaranteed,” or any
equivalent absolute promise in product, support, incident, or operational
language.

## Local rehearsal command

With local Supabase running, execute `pnpm recovery:rehearse`. It freezes the
isolated database, starts a restore phase, validates all checks, records a
dated report without Member Data or secrets, reopens the write gate, and
asserts the health phase is open. The command exits non-zero on any failed
check and leaves no production state behind.
