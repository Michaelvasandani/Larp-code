-- Ticket 39: managed recovery configuration, write freeze, validation, and
-- privacy-safe rehearsal reports.
--
-- Provider PITR itself is configured outside Postgres. This migration records
-- the non-negotiable production envelope and supplies the controlled seam that
-- operators use before restoring an isolated managed database. No Member Data,
-- authentication secret, or provider credential is accepted by these tables.

create table if not exists public.managed_recovery_configuration (
  singleton boolean primary key default true check (singleton),
  provider text not null check (provider = 'managed-postgres'),
  pitr_enabled boolean not null check (pitr_enabled),
  pitr_window_days integer not null check (pitr_window_days = 7),
  backup_retention_days integer not null check (backup_retention_days between 7 and 30),
  encrypted_backups boolean not null check (encrypted_backups),
  zero_data_loss_guarantee boolean not null default false check (not zero_data_loss_guarantee),
  updated_at timestamptz not null default clock_timestamp()
);

insert into public.managed_recovery_configuration(
  singleton, provider, pitr_enabled, pitr_window_days, backup_retention_days,
  encrypted_backups, zero_data_loss_guarantee
) values (true, 'managed-postgres', true, 7, 30, true, false)
on conflict (singleton) do nothing;

alter table public.managed_recovery_configuration enable row level security;
revoke all on public.managed_recovery_configuration from public, anon, authenticated;
grant select on public.managed_recovery_configuration to service_role;

create table if not exists public.operational_recovery_state (
  singleton boolean primary key default true check (singleton),
  phase text not null check (phase in ('open', 'frozen', 'restoring')),
  incident_ref text,
  fault_at timestamptz,
  selected_restore_point timestamptz,
  frozen_at timestamptz,
  restoring_at timestamptz,
  reopened_at timestamptz,
  latest_validation_id uuid,
  updated_at timestamptz not null default clock_timestamp(),
  check ((phase = 'open') = (incident_ref is null and fault_at is null and selected_restore_point is null))
);

insert into public.operational_recovery_state(singleton, phase)
values (true, 'open')
on conflict (singleton) do nothing;

alter table public.operational_recovery_state enable row level security;
revoke all on public.operational_recovery_state from public, anon, authenticated;
grant select on public.operational_recovery_state to service_role;

create table if not exists public.recovery_validation_runs (
  id uuid primary key default gen_random_uuid(),
  incident_ref text not null,
  selected_restore_point timestamptz not null,
  checks jsonb not null,
  failed_checks jsonb not null default '[]'::jsonb,
  ready_to_reopen boolean not null,
  measured_restore_milliseconds integer check (measured_restore_milliseconds is null or measured_restore_milliseconds >= 0),
  created_at timestamptz not null default clock_timestamp(),
  unique (incident_ref, id)
);

alter table public.recovery_validation_runs enable row level security;
revoke all on public.recovery_validation_runs from public, anon, authenticated;
grant select, insert on public.recovery_validation_runs to service_role;

create table if not exists public.recovery_reports (
  id uuid primary key default gen_random_uuid(),
  incident_ref text not null unique,
  scenario text not null check (scenario in ('destructive-incident', 'ordinary-interruption')),
  selected_restore_point timestamptz not null,
  fault_at timestamptz not null,
  validation_id uuid not null references public.recovery_validation_runs(id),
  validation_checks jsonb not null,
  measured jsonb not null,
  failures jsonb not null default '[]'::jsonb,
  corrective_actions jsonb not null default '[]'::jsonb,
  member_data_included boolean not null default false check (not member_data_included),
  absolute_zero_data_loss_guarantee boolean not null default false check (not absolute_zero_data_loss_guarantee),
  created_at timestamptz not null default clock_timestamp()
);

alter table public.recovery_reports enable row level security;
revoke all on public.recovery_reports from public, anon, authenticated;
grant select, insert on public.recovery_reports to service_role;

comment on table public.managed_recovery_configuration is
  'Production envelope: managed seven-day PITR, encrypted backups, and a hard thirty-day backup ceiling. It deliberately makes no zero-data-loss promise.';
comment on table public.operational_recovery_state is
  'Singleton write gate used during a suspected destructive incident. Reopening requires a successful validation run.';
comment on table public.recovery_reports is
  'Dated, privacy-safe Gate 4 evidence. Reports contain scenario, timestamps, checks, measurements, failures, and corrective actions only.';

create or replace function public.select_latest_safe_recovery_point_v1(
  p_fault_at timestamptz,
  p_candidates timestamptz[]
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_point timestamptz;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'This recovery seam is restricted to the service role.' using errcode = '42501';
  end if;
  if p_fault_at is null then
    raise exception 'A fault time is required.' using errcode = '22023';
  end if;
  select max(candidate)
    into selected_point
    from unnest(coalesce(p_candidates, '{}'::timestamptz[])) candidate
   where candidate >= p_fault_at - interval '7 days'
     and candidate < p_fault_at;
  if selected_point is null then
    raise exception 'No safe recovery point exists before the fault in the managed seven-day window.' using errcode = '22023';
  end if;
  return selected_point;
end;
$$;

create or replace function public.begin_recovery_freeze_v1(
  p_incident_ref text,
  p_fault_at timestamptz,
  p_selected_restore_point timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  state_row public.operational_recovery_state;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'This recovery seam is restricted to the service role.' using errcode = '42501';
  end if;
  if p_incident_ref is null or p_incident_ref !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$' then
    raise exception 'Incident reference is invalid.' using errcode = '22023';
  end if;
  if p_fault_at is null or p_selected_restore_point is null
    or p_selected_restore_point >= p_fault_at
    or p_selected_restore_point < p_fault_at - interval '7 days' then
    raise exception 'The selected recovery point must be before the fault and within seven days.' using errcode = '22023';
  end if;
  select * into state_row from public.operational_recovery_state where singleton for update;
  if state_row.phase <> 'open' then
    raise exception 'A recovery exercise is already in progress.' using errcode = '55006';
  end if;
  update public.operational_recovery_state
     set phase = 'frozen', incident_ref = p_incident_ref, fault_at = p_fault_at,
         selected_restore_point = p_selected_restore_point,
         frozen_at = clock_timestamp(), restoring_at = null, reopened_at = null,
         latest_validation_id = null, updated_at = clock_timestamp()
   where singleton;
  return jsonb_build_object(
    'phase', 'frozen', 'incidentRef', p_incident_ref,
    'faultAt', p_fault_at, 'selectedRestorePoint', p_selected_restore_point,
    'writesBlocked', true
  );
end;
$$;

create or replace function public.begin_recovery_restore_v1()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  state_row public.operational_recovery_state;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'This recovery seam is restricted to the service role.' using errcode = '42501';
  end if;
  select * into state_row from public.operational_recovery_state where singleton for update;
  if state_row.phase <> 'frozen' then
    raise exception 'Recovery must be frozen before restore begins.' using errcode = '55006';
  end if;
  update public.operational_recovery_state
     set phase = 'restoring', restoring_at = clock_timestamp(), updated_at = clock_timestamp()
   where singleton;
  return jsonb_build_object('phase', 'restoring', 'writesBlocked', true);
end;
$$;

create or replace function public.validate_recovery_v1(
  p_evidence jsonb default '{}'::jsonb,
  p_measured_restore_milliseconds integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  state_row public.operational_recovery_state;
  validation_id uuid;
  schema_ok boolean;
  grants_rls_ok boolean;
  auth_ok boolean;
  snapshot_contracts_ok boolean;
  command_contracts_ok boolean;
  idempotency_ok boolean;
  commitments_ok boolean;
  lifecycle_ok boolean;
  realtime_ok boolean;
  jobs_ok boolean;
  retention_ok boolean;
  mail_ok boolean;
  all_ok boolean;
  failed text[] := '{}'::text[];
  checks jsonb;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'This recovery seam is restricted to the service role.' using errcode = '42501';
  end if;
  select * into state_row from public.operational_recovery_state where singleton for update;
  if state_row.phase <> 'restoring' then
    raise exception 'Recovery validation requires the restoring phase.' using errcode = '55006';
  end if;

  -- Schema version and the provider envelope are checked without including
  -- any row contents in evidence.
  schema_ok := to_regprocedure('public.foundation_health_v1()') is not null
    and (public.foundation_health_v1() ->> 'schemaVersion')::integer = 14
    and exists (select 1 from public.managed_recovery_configuration
                where singleton and pitr_enabled and pitr_window_days = 7
                  and backup_retention_days between 7 and 30
                  and encrypted_backups and not zero_data_loss_guarantee);
  grants_rls_ok := (
    select count(*) = 12
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where namespace.nspname = 'public'
       and relation.relname in (
         'member_accounts', 'member_command_idempotency', 'invitations',
         'invitation_rate_limits', 'challenges', 'challenge_members',
         'member_commitments', 'solves', 'solve_corrections',
         'transactional_notices', 'deleted_member_records',
         'member_retention_metadata'
       )
       and relation.relrowsecurity
  );
  auth_ok := to_regclass('auth.users') is not null
    and has_schema_privilege('auth', 'USAGE');
  snapshot_contracts_ok := public.contract_compatibility_json_v1() =
    '{"snapshotContractVersion":2,"commandContractVersion":2,"supportedSnapshotContractVersions":[1,2],"supportedCommandContractVersions":[1,2]}'::jsonb;
  command_contracts_ok := public.contract_compatibility_json_v1() =
    '{"snapshotContractVersion":2,"commandContractVersion":2,"supportedSnapshotContractVersions":[1,2],"supportedCommandContractVersions":[1,2]}'::jsonb;
  idempotency_ok := to_regclass('public.member_command_idempotency') is not null
    and exists (select 1 from pg_constraint
                 where conrelid = 'public.member_command_idempotency'::regclass and contype = 'p')
    and not exists (select 1 from public.member_command_idempotency where intent is null);
  commitments_ok := not exists (
    select 1 from public.member_commitments group by member_id having count(*) > 1
  ) and not exists (
    select 1 from public.challenges challenge_row
     where challenge_row.status in ('scheduled', 'active')
       and (select count(*) from public.member_commitments commitment
             where commitment.challenge_id = challenge_row.id) <> 2
  );
  lifecycle_ok := not exists (
    select 1 from public.challenges challenge_row
     where (select count(*) from public.challenge_members member_row
             where member_row.challenge_id = challenge_row.id) <> 2
  ) and not exists (
    select 1 from public.challenges challenge_row
     where challenge_row.status in ('canceled', 'abandoned', 'completed', 'incomplete')
       and exists (select 1 from public.member_commitments commitment where commitment.challenge_id = challenge_row.id)
  );
  realtime_ok := (
    select count(*) = 3
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename in ('challenges', 'solves', 'solve_corrections')
  );
  jobs_ok := to_regprocedure('public.reconcile_scheduled_work_at_v1(timestamp with time zone,integer)') is not null
    and to_regprocedure('public.run_retention_cleanup_at_v1(timestamp with time zone,integer)') is not null;
  retention_ok := to_regclass('public.deleted_member_records') is not null
    and to_regprocedure('public.retention_expires_at_v1(text,text,timestamp with time zone)') is not null
    and not exists (
      select 1 from public.deleted_member_records
       where invitation_retention_until is null
          or challenge_retention_until is null
          or diagnostic_retention_until is null
          or security_audit_retention_until is null
          or backup_retention_until is null
    );
  -- Resend is intentionally an operator-provided check. Local rehearsal uses
  -- the Mailpit-compatible transport and records only this boolean.
  mail_ok := coalesce((p_evidence ->> 'mailIntegration')::boolean, false);

  if not schema_ok then failed := array_append(failed, 'schemaVersion'); end if;
  if not grants_rls_ok then failed := array_append(failed, 'grantsAndRls'); end if;
  if not auth_ok then failed := array_append(failed, 'authAccess'); end if;
  if not snapshot_contracts_ok then failed := array_append(failed, 'snapshotContracts'); end if;
  if not command_contracts_ok then failed := array_append(failed, 'commandContracts'); end if;
  if not idempotency_ok then failed := array_append(failed, 'idempotencyRecords'); end if;
  if not commitments_ok then failed := array_append(failed, 'memberCommitments'); end if;
  if not lifecycle_ok then failed := array_append(failed, 'lifecycleInvariants'); end if;
  if not realtime_ok then failed := array_append(failed, 'realtimePublication'); end if;
  if not jobs_ok then failed := array_append(failed, 'scheduledJobs'); end if;
  if not retention_ok then failed := array_append(failed, 'retentionCutoffs'); end if;
  if not mail_ok then failed := array_append(failed, 'mailIntegration'); end if;
  all_ok := coalesce(array_length(failed, 1), 0) = 0;
  checks := jsonb_build_object(
    'schemaVersion', schema_ok, 'grantsAndRls', grants_rls_ok,
    'authAccess', auth_ok, 'snapshotContracts', snapshot_contracts_ok,
    'commandContracts', command_contracts_ok, 'idempotencyRecords', idempotency_ok,
    'memberCommitments', commitments_ok, 'lifecycleInvariants', lifecycle_ok,
    'realtimePublication', realtime_ok, 'scheduledJobs', jobs_ok,
    'retentionCutoffs', retention_ok, 'mailIntegration', mail_ok
  );
  insert into public.recovery_validation_runs(
    incident_ref, selected_restore_point, checks, failed_checks,
    ready_to_reopen, measured_restore_milliseconds
  ) values (
    state_row.incident_ref, state_row.selected_restore_point, checks,
    to_jsonb(failed), all_ok, p_measured_restore_milliseconds
  ) returning id into validation_id;
  update public.operational_recovery_state
     set latest_validation_id = validation_id, updated_at = clock_timestamp()
   where singleton;
  return jsonb_build_object(
    'validationId', validation_id, 'readyToReopen', all_ok,
    'checks', checks, 'failedChecks', to_jsonb(failed)
  );
end;
$$;

create or replace function public.reopen_after_recovery_v1(
  p_validation_id uuid,
  p_report jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  state_row public.operational_recovery_state;
  validation_row public.recovery_validation_runs;
  report_id uuid;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'This recovery seam is restricted to the service role.' using errcode = '42501';
  end if;
  select * into state_row from public.operational_recovery_state where singleton for update;
  if state_row.phase <> 'restoring' then
    raise exception 'Recovery is not ready to reopen.' using errcode = '55006';
  end if;
  select * into validation_row from public.recovery_validation_runs
   where id = p_validation_id and incident_ref = state_row.incident_ref;
  if not found or not validation_row.ready_to_reopen then
    raise exception 'Every restore validation check must pass before reopening.' using errcode = '55006';
  end if;
  if p_report is null or p_report->>'scenario' is null
    or p_report->>'selectedRestorePoint' is null
    or (p_report->>'selectedRestorePoint')::timestamptz is distinct from state_row.selected_restore_point
    or p_report->'measured' is null
    or p_report->'failures' is null
    or p_report->'correctiveActions' is null
    or jsonb_typeof(p_report->'measured') <> 'object'
    or jsonb_typeof(p_report->'failures') <> 'array'
    or jsonb_typeof(p_report->'correctiveActions') <> 'array'
    or coalesce((p_report->>'memberDataIncluded')::boolean, true)
    or coalesce((p_report->>'absoluteZeroDataLossGuarantee')::boolean, true)
    or p_report::text ~* '"(email|otp|accessToken|refreshToken|secret|password)"[[:space:]]*:' then
    raise exception 'Recovery report must contain dated privacy-safe evidence and no secrets or Member Data.' using errcode = '22023';
  end if;
  insert into public.recovery_reports(
    incident_ref, scenario, selected_restore_point, fault_at, validation_id,
    validation_checks,
    measured, failures, corrective_actions, member_data_included,
    absolute_zero_data_loss_guarantee
  ) values (
    state_row.incident_ref,
    p_report->>'scenario',
    (p_report->>'selectedRestorePoint')::timestamptz,
    state_row.fault_at,
    p_validation_id,
    validation_row.checks,
    p_report->'measured', p_report->'failures', p_report->'correctiveActions', false, false
  ) returning id into report_id;
  update public.operational_recovery_state
     set phase = 'open', incident_ref = null, fault_at = null,
         selected_restore_point = null, frozen_at = null, restoring_at = null,
         reopened_at = clock_timestamp(), latest_validation_id = p_validation_id,
         updated_at = clock_timestamp()
   where singleton;
  return jsonb_build_object('phase', 'open', 'reportId', report_id, 'writesBlocked', false);
end;
$$;

create or replace function public.recovery_write_guard_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce((select phase from public.operational_recovery_state where singleton), 'open') <> 'open'
    and coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'The larp-code connection is unavailable during managed recovery.' using errcode = '57P01';
  end if;
  return case when TG_OP = 'DELETE' then OLD else NEW end;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'member_accounts', 'member_command_idempotency', 'invitations',
    'invitation_rate_limits', 'challenges', 'challenge_members',
    'member_commitments', 'solves', 'solve_corrections',
    'transactional_notices', 'deleted_member_records', 'member_retention_metadata'
  ] loop
    execute format('drop trigger if exists recovery_write_guard on public.%I', table_name);
    execute format('create trigger recovery_write_guard before insert or update or delete on public.%I for each row execute function public.recovery_write_guard_v1()', table_name);
  end loop;
end;
$$;

revoke all on function public.select_latest_safe_recovery_point_v1(timestamptz, timestamptz[]) from public, anon, authenticated;
revoke all on function public.begin_recovery_freeze_v1(text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.begin_recovery_restore_v1() from public, anon, authenticated;
revoke all on function public.validate_recovery_v1(jsonb, integer) from public, anon, authenticated;
revoke all on function public.reopen_after_recovery_v1(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.select_latest_safe_recovery_point_v1(timestamptz, timestamptz[]) to service_role;
grant execute on function public.begin_recovery_freeze_v1(text, timestamptz, timestamptz) to service_role;
grant execute on function public.begin_recovery_restore_v1() to service_role;
grant execute on function public.validate_recovery_v1(jsonb, integer) to service_role;
grant execute on function public.reopen_after_recovery_v1(uuid, jsonb) to service_role;

-- Health is safe pre-Member-Data metadata. Clients use a non-open recovery
-- phase as the ordinary connection-unavailable state during restore.
create or replace function public.foundation_health_v1()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'service', 'larp-code', 'schemaVersion', 14,
    'serverTime', statement_timestamp(), 'minimumClientVersion', '0.1.0',
    'recoveryPhase', state.phase
  ) || public.contract_compatibility_json_v1()
  from public.operational_recovery_state state
  where state.singleton;
$$;
revoke all on function public.foundation_health_v1() from public;
grant execute on function public.foundation_health_v1() to anon, authenticated;
