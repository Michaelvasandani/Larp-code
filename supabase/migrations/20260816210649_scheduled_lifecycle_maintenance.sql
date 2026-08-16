-- Run the lifecycle and retention repair seam inside Postgres so the private
-- beta does not depend on an externally stored scheduler secret.

create extension if not exists pg_cron;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;

create or replace function private.run_lifecycle_maintenance_v1()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  -- The public maintenance seam is deliberately service-role-only. This
  -- private, postgres-owned wrapper supplies that request context only for
  -- the duration of the Cron transaction and is not executable by API roles.
  perform set_config('request.jwt.claim.role', 'service_role', true);
  select public.reconcile_scheduled_work_at_v1(statement_timestamp(), 100)
    into result;
  return result;
end;
$$;

revoke all on function private.run_lifecycle_maintenance_v1()
  from public, anon, authenticated, service_role;

select cron.unschedule(jobid)
from cron.job
where jobname = 'larp-code-lifecycle-maintenance-v1';

select cron.schedule(
  'larp-code-lifecycle-maintenance-v1',
  '*/5 * * * *',
  'select private.run_lifecycle_maintenance_v1();'
);
