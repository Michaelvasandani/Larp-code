# Production Supabase deployment record

Recorded: 2026-08-16

## Project

- Project: `larp-code-prod`
- Project reference: `nbdisurpcxicqiojuyhe`
- Region: `us-west-1`
- API origin: `https://nbdisurpcxicqiojuyhe.supabase.co`
- Connector-reported state after creation: `ACTIVE_HEALTHY`
- Dashboard-reported plan: Free

The publisher accepted the Free plan's pausing and backup limitations for the
private beta. A paid, non-pausable plan remains the default public-launch gate.
Dashboard sign-in is still required to verify or update SSL enforcement, Auth
limits, SMTP, and owner MFA.

## Deployed state

- All repository migrations through
  `20260816210649_scheduled_lifecycle_maintenance.sql` are recorded in production.
- The reviewed catalog has one version and exactly 150 pinned records.
- `dispatch-transactional-notice`, `reconcile-scheduled-work`, and
  `send-invitation-notice` are active at version 1.
- The production health RPC returned schema version 14, command contract 2,
  snapshot contract 2, and recovery phase `open`.

The Postgres Cron job `larp-code-lifecycle-maintenance-v1` runs every five
minutes as `postgres`. Its private entrypoint is not executable by `anon`,
`authenticated`, or `service_role`; a controlled production invocation returned
successful zero-work lifecycle and retention results. This removes the Edge
Function scheduler-secret dependency for private beta lifecycle maintenance.

Transactional mail still requires a beta-capable provider and deployment
secrets. No Resend credential was available during this deployment.

## Access-control verification

- Every public table has RLS enabled.
- Client roles have zero direct `INSERT`, `UPDATE`, or `DELETE` table grants.
- The `anon` and `authenticated` function surface matches the repository's
  explicit RPC allowlist with zero unexpected or missing functions.
- The production-configured extension package contains one exact backend host,
  the `storage` permission, and no secret key, database URL, or JWT credential.

Supabase's Security Advisor still reports informational `rls_enabled_no_policy`
notices for function-only tables and warnings for the intentionally exposed
`SECURITY DEFINER` RPC allowlist. The regression test
`tests/function-privileges-db.test.ts` prevents internal helpers and triggers
from re-entering that allowlist. Advisor remediation reference:
<https://supabase.com/docs/guides/database/database-linter>.

The Performance Advisor also reports unindexed foreign keys on the new, empty
project. These are follow-up tuning items; unused-index notices are not
meaningful until production traffic exists.
