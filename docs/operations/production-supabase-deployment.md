# Production Supabase deployment record

Recorded: 2026-08-16

## Project

- Project: `larp-code-prod`
- Project reference: `nbdisurpcxicqiojuyhe`
- Region: `us-west-1`
- API origin: `https://nbdisurpcxicqiojuyhe.supabase.co`
- Connector-reported state after creation: `ACTIVE_HEALTHY`
- Dashboard-reported plan: Free

The Free plan does not satisfy the launch checklist's paid, non-pausable
requirement. The current dashboard session also reports insufficient permission
to update database and Auth configuration, so SSL enforcement, backups, Auth
limits, SMTP, and owner MFA remain unverified.

## Deployed state

- All repository migrations through
  `20260816201938_function_least_privilege.sql` are recorded in production.
- The reviewed catalog has one version and exactly 150 pinned records.
- `dispatch-transactional-notice`, `reconcile-scheduled-work`, and
  `send-invitation-notice` are active at version 1.
- The production health RPC returned schema version 14, command contract 2,
  snapshot contract 2, and recovery phase `open`.

The mail and scheduled-work functions still require production secrets and
schedules before they are operational. No Resend or scheduler secret was
available during this deployment.

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
