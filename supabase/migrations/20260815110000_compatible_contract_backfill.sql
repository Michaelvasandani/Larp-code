-- Ticket 37: additive contract support and a resumable compatibility backfill.
--
-- This migration is intentionally additive and therefore runs in one Postgres
-- transaction. The current (1) and immediately preceding (0) command and
-- Snapshot contracts remain accepted by every versioned command function.
-- Contract removal is a separate, later migration after the Store rollout.

create table if not exists public.compatibility_backfill_runs (
  migration_version text primary key,
  cursor_member_id uuid,
  processed_rows bigint not null default 0 check (processed_rows >= 0),
  completed boolean not null default false,
  started_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  constraint compatibility_backfill_runs_known_version check (
    migration_version = 'ticket-37-contract-v1'
  )
);

alter table public.compatibility_backfill_runs enable row level security;
revoke all on table public.compatibility_backfill_runs from public, anon, authenticated;

comment on table public.compatibility_backfill_runs is
  'Version-marked, resumable, idempotent operational cursor for additive compatibility backfills.';

-- Existing installations already ran the earlier command migrations. Rewrite
-- their function bodies in this additive release as well; changing only the
-- historical migration files would help a fresh reset but would leave a
-- deployed Store rollout on the old, current-only envelope.
do $$
declare
  function_oid oid;
  function_definition text;
begin
  for function_oid in
    select proc_row.oid
      from pg_proc proc_row
      join pg_namespace namespace on namespace.oid = proc_row.pronamespace
     where namespace.nspname = 'public'
       and proc_row.proname in (
         'update_member_display_name_v1', 'create_invitation_v1',
         'transition_invitation_terminal_v1', 'accept_invitation_v1',
         'cancel_challenge_v1', 'abandon_challenge_v1', 'abandon_challenge_at_v1',
         'create_solve_v1', 'correct_solve_v1', 'delete_member_account_v1'
       )
  loop
    function_definition := pg_get_functiondef(function_oid);
    function_definition := replace(
      function_definition,
      'p_command_version is distinct from 1',
      'p_command_version is null or p_command_version not in (0, 1)'
    );
    if position('create_invitation_v1' in function_definition) > 0 then
      function_definition := replace(
        function_definition,
        'and command_kind = ''create_invitation'' and command_version = 1;',
        'and command_kind = ''create_invitation'' and command_version = p_command_version;'
      );
    end if;
    execute function_definition;
  end loop;
end;
$$;

create or replace function public.run_compatibility_backfill_v1(
  p_batch_size integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  run_row public.compatibility_backfill_runs;
  batch_ids uuid[];
  batch_count integer := 0;
  next_cursor uuid;
  backfill_version constant text := 'ticket-37-contract-v1';
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'This controlled migration seam is restricted to the service role.' using errcode = '42501';
  end if;
  if p_batch_size is null or p_batch_size < 1 or p_batch_size > 1000 then
    raise exception 'Backfill batch size must be between 1 and 1000.' using errcode = '22023';
  end if;

  insert into public.compatibility_backfill_runs (migration_version)
  values (backfill_version)
  on conflict (migration_version) do nothing;

  -- The row lock makes concurrent workers serialize. A completed run is a
  -- no-op, which makes retries safe after a worker or deployment interruption.
  select * into run_row
    from public.compatibility_backfill_runs
   where compatibility_backfill_runs.migration_version = backfill_version
   for update;
  if run_row.completed then
    return jsonb_build_object(
      'migrationVersion', run_row.migration_version,
      'cursorMemberId', run_row.cursor_member_id,
      'processedRows', run_row.processed_rows,
      'completed', true,
      'currentSnapshotContractVersion', 1,
      'previousSnapshotContractVersion', 0,
      'currentCommandContractVersion', 1,
      'previousCommandContractVersion', 0
    );
  end if;

  -- The additive release does not rewrite domain rows. Walking stable Member
  -- identities records rollout progress without fabricating Solves or changing
  -- schedules, outcomes, lifecycle, corrections, or Problem Set identities.
  select coalesce(array_agg(member.id order by member.id), '{}'::uuid[])
    into batch_ids
    from (
      select id
        from public.member_accounts member
       where run_row.cursor_member_id is null or member.id > run_row.cursor_member_id
       order by id
       limit p_batch_size
    ) member;
  batch_count := coalesce(array_length(batch_ids, 1), 0);

  if batch_count = 0 then
    update public.compatibility_backfill_runs
       set completed = true,
           completed_at = coalesce(completed_at, clock_timestamp()),
           updated_at = clock_timestamp()
     where migration_version = run_row.migration_version;
  else
    next_cursor := batch_ids[batch_count];
    update public.compatibility_backfill_runs
       set cursor_member_id = next_cursor,
           processed_rows = processed_rows + batch_count,
           completed = batch_count < p_batch_size,
           completed_at = case when batch_count < p_batch_size then clock_timestamp() else null end,
           updated_at = clock_timestamp()
     where migration_version = run_row.migration_version;
  end if;

  select * into run_row
    from public.compatibility_backfill_runs
   where compatibility_backfill_runs.migration_version = backfill_version;
  return jsonb_build_object(
    'migrationVersion', run_row.migration_version,
    'cursorMemberId', run_row.cursor_member_id,
    'processedRows', run_row.processed_rows,
    'completed', run_row.completed,
    'currentSnapshotContractVersion', 1,
    'previousSnapshotContractVersion', 0,
    'currentCommandContractVersion', 1,
    'previousCommandContractVersion', 0
  );
end;
$$;

revoke all on function public.run_compatibility_backfill_v1(integer) from public, anon, authenticated;
grant execute on function public.run_compatibility_backfill_v1(integer) to service_role;

-- Narrow compatibility metadata is safe to expose before Member Data reads.
-- The extension consuming a future additive field is deliberately shipped only
-- after this function and the backfill have been verified in both contracts.
create or replace function public.foundation_health_v1()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'service', 'larp-code',
    'schemaVersion', 12,
    'serverTime', statement_timestamp(),
    'minimumClientVersion', '0.1.0',
    'minimumClientReason', 'security',
    'snapshotContractVersion', 1,
    'commandContractVersion', 1,
    'supportedSnapshotContractVersions', jsonb_build_array(0, 1),
    'supportedCommandContractVersions', jsonb_build_array(0, 1)
  );
$$;

revoke all on function public.foundation_health_v1() from public;
grant execute on function public.foundation_health_v1() to anon, authenticated;
