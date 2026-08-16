-- Ticket 38: durable scheduled-work and retention seams.
--
-- Scheduled work is a repair/maintenance path, never the source of domain
-- truth. Reads and commands continue to derive effective state from immutable
-- terms and authoritative time. This migration gives operators one resumable
-- service-role seam for lifecycle reconciliation and physical cleanup while
-- keeping logical expiry independent of job timing.

create table if not exists public.lifecycle_history (
  id uuid primary key default gen_random_uuid(),
  aggregate_kind text not null check (aggregate_kind in ('invitation', 'challenge')),
  aggregate_id uuid not null,
  status text not null,
  effective_at timestamptz not null,
  source text not null check (source in ('command', 'reconciliation', 'deletion', 'backfill')),
  created_at timestamptz not null default clock_timestamp(),
  unique (aggregate_kind, aggregate_id, status)
);

alter table public.lifecycle_history enable row level security;
revoke all on public.lifecycle_history from anon, authenticated;
grant select, insert, delete on public.lifecycle_history to service_role;

create index if not exists lifecycle_history_expiry_lookup
  on public.lifecycle_history (aggregate_kind, aggregate_id, effective_at);

-- A deliberately small operational alert record. Details are a closed,
-- privacy-filtered vocabulary; raw SQL errors and Member Data never enter it.
create table if not exists public.operational_alerts (
  id uuid primary key default gen_random_uuid(),
  code text not null check (code in (
    'retention_cleanup_failed',
    'lifecycle_reconciliation_failed',
    'transactional_notice_dispatch_failed'
  )),
  severity text not null default 'error' check (severity in ('warning', 'error')),
  privacy_filtered boolean not null default true check (privacy_filtered),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp()
);

alter table public.operational_alerts enable row level security;
revoke all on public.operational_alerts from anon, authenticated;
grant select, insert on public.operational_alerts to service_role;

create index if not exists operational_alerts_code_created
  on public.operational_alerts (code, created_at desc);

-- Every status is represented once. The unique identity makes retries and
-- overlapping workers unable to create duplicate lifecycle history. Both
-- aggregate triggers use this one write seam; only their classification differs.
create or replace function public.record_lifecycle_history_v1(
  p_aggregate_kind text,
  p_aggregate_id uuid,
  p_status text,
  p_effective_at timestamptz,
  p_source text
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.lifecycle_history(
    aggregate_kind, aggregate_id, status, effective_at, source
  ) values (
    p_aggregate_kind, p_aggregate_id, p_status, p_effective_at, p_source
  ) on conflict (aggregate_kind, aggregate_id, status) do nothing;
$$;

create or replace function public.invitation_lifecycle_history_source_v1(
  p_status text,
  p_deleted_member_record_id uuid
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_deleted_member_record_id is not null then 'deletion'
    when p_status = 'expired' then 'reconciliation'
    else 'command'
  end;
$$;

create or replace function public.challenge_lifecycle_history_source_v1(
  p_status text,
  p_deleted_member_record_id uuid
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_deleted_member_record_id is not null then 'deletion'
    when p_status in ('active', 'incomplete', 'completed') then 'reconciliation'
    else 'command'
  end;
$$;

create or replace function public.record_invitation_lifecycle_history_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if TG_OP = 'INSERT' or NEW.status is distinct from OLD.status then
    perform public.record_lifecycle_history_v1(
      'invitation', NEW.id, NEW.status,
      coalesce(NEW.terminal_at, NEW.updated_at, NEW.created_at),
      public.invitation_lifecycle_history_source_v1(NEW.status, NEW.deleted_member_record_id)
    );
  end if;
  return NEW;
end;
$$;

create or replace function public.record_challenge_lifecycle_history_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if TG_OP = 'INSERT' or NEW.status is distinct from OLD.status then
    perform public.record_lifecycle_history_v1(
      'challenge', NEW.id, NEW.status,
      coalesce(NEW.terminal_at, NEW.updated_at, NEW.created_at),
      public.challenge_lifecycle_history_source_v1(NEW.status, NEW.deleted_member_record_id)
    );
  end if;
  return NEW;
end;
$$;

drop trigger if exists invitations_lifecycle_history on public.invitations;
create trigger invitations_lifecycle_history
after insert or update of status on public.invitations
for each row execute function public.record_invitation_lifecycle_history_v1();

drop trigger if exists challenges_lifecycle_history on public.challenges;
create trigger challenges_lifecycle_history
after insert or update of status on public.challenges
for each row execute function public.record_challenge_lifecycle_history_v1();

-- Backfill is safe to rerun and preserves the current status identity of rows
-- created before the history table existed.
insert into public.lifecycle_history(
  aggregate_kind, aggregate_id, status, effective_at, source
)
select 'invitation', invitation_row.id, invitation_row.status,
  coalesce(invitation_row.terminal_at, invitation_row.updated_at, invitation_row.created_at),
  'backfill'
from public.invitations invitation_row
on conflict (aggregate_kind, aggregate_id, status) do nothing;

insert into public.lifecycle_history(
  aggregate_kind, aggregate_id, status, effective_at, source
)
select 'challenge', challenge_row.id, challenge_row.status,
  coalesce(challenge_row.terminal_at, challenge_row.updated_at, challenge_row.created_at),
  'backfill'
from public.challenges challenge_row
on conflict (aggregate_kind, aggregate_id, status) do nothing;

-- Terminal rows receive their policy cutoff in the same transaction as the
-- status change. This helper is the single policy table for terminal status,
-- duration, and cutoff calculation; trigger and backfill paths both reuse it.
create or replace function public.retention_expires_at_v1(
  p_aggregate_kind text,
  p_status text,
  p_terminal_at timestamptz
)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select case
    when p_terminal_at is null then null
    when p_aggregate_kind = 'invitation'
      and p_status in ('revoked', 'declined', 'expired')
      then p_terminal_at + interval '30 days'
    when p_aggregate_kind = 'challenge'
      and p_status in ('canceled', 'abandoned', 'completed', 'incomplete')
      then p_terminal_at + interval '365 days'
    else null
  end;
$$;

create or replace function public.assign_retention_cutoff_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if NEW.retention_expires_at is null then
    NEW.retention_expires_at := public.retention_expires_at_v1(
      case when TG_TABLE_NAME = 'invitations' then 'invitation' else 'challenge' end,
      NEW.status,
      NEW.terminal_at
    );
  end if;
  return NEW;
end;
$$;

drop trigger if exists invitations_retention_cutoff on public.invitations;
create trigger invitations_retention_cutoff
before insert or update on public.invitations
for each row execute function public.assign_retention_cutoff_v1();

drop trigger if exists challenges_retention_cutoff on public.challenges;
create trigger challenges_retention_cutoff
before insert or update on public.challenges
for each row execute function public.assign_retention_cutoff_v1();

-- Existing rows are backfilled from their immutable terminal timestamp. No
-- live or pending row is assigned an expiry.
update public.invitations
   set retention_expires_at = public.retention_expires_at_v1('invitation', status, terminal_at)
 where public.retention_expires_at_v1('invitation', status, terminal_at) is not null
   and retention_expires_at is null;

update public.challenges
   set retention_expires_at = public.retention_expires_at_v1('challenge', status, terminal_at)
 where public.retention_expires_at_v1('challenge', status, terminal_at) is not null
   and retention_expires_at is null;

-- Notice delivery history is security/audit metadata, not a shared record.
-- It follows the 90-day security/audit ceiling and contains no message body.
create or replace function public.notice_retention_expires_at_v1(p_created_at timestamptz)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select coalesce(p_created_at, statement_timestamp()) + interval '90 days';
$$;

alter table public.transactional_notices
  add column if not exists retention_expires_at timestamptz;

update public.transactional_notices
   set retention_expires_at = public.notice_retention_expires_at_v1(created_at)
 where retention_expires_at is null;

create or replace function public.populate_notice_member_ids_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if NEW.source_event_key is null then NEW.source_event_key := NEW.event_key; end if;
  if NEW.recipient_member_id is null then
    select id into NEW.recipient_member_id from auth.users
     where lower(email) = lower(NEW.recipient_email) limit 1;
  end if;
  if NEW.inviter_member_id is null then
    select inviter_id into NEW.inviter_member_id from public.invitations
     where NEW.event_key = 'invitation:' || id || ':created' limit 1;
  end if;
  if NEW.notice_type = 'invitation' and NEW.invitation_id is null then
    select id into NEW.invitation_id from public.invitations
     where NEW.event_key = 'invitation:' || id || ':created' limit 1;
  end if;
  if NEW.notice_type = 'invitation' and NEW.actor_member_id is null then
    NEW.actor_member_id := NEW.inviter_member_id;
  end if;
  if NEW.event_key = NEW.source_event_key then
    NEW.event_key := 'notice:' || md5(concat_ws('|', NEW.source_event_key, NEW.notice_type,
      lower(NEW.recipient_email), coalesce(NEW.recipient_member_id::text, '')));
  end if;
  if NEW.retention_expires_at is null then
    NEW.retention_expires_at := public.notice_retention_expires_at_v1(NEW.created_at);
  end if;
  return NEW;
end;
$$;

-- Controlled-time expiration is the same transition as ordinary reads, but a
-- scheduled worker can pass the authoritative time it is reconciling.
create or replace function public.expire_invitation_at_v1(
  p_invitation_id uuid,
  p_authoritative_now timestamptz
)
returns public.invitations
language plpgsql
security definer
set search_path = ''
as $$
declare
  invitation_row public.invitations;
begin
  if p_authoritative_now is null then
    raise exception 'Authoritative time is required.' using errcode = '22023';
  end if;
  update public.invitations
     set status = 'expired', terminal_at = p_authoritative_now,
         updated_at = p_authoritative_now
   where id = p_invitation_id
     and status = 'pending'
     and p_authoritative_now >= (start_date::timestamp at time zone challenge_time_zone)
  returning * into invitation_row;
  if found then return invitation_row; end if;
  select * into invitation_row from public.invitations where id = p_invitation_id;
  return invitation_row;
end;
$$;

create or replace function public.expire_invitation_if_due_v1(p_invitation_id uuid)
returns public.invitations
language sql
security definer
set search_path = ''
as $$
  select public.expire_invitation_at_v1(p_invitation_id, clock_timestamp());
$$;

-- The scheduler locks work items with SKIP LOCKED. A second worker therefore
-- either skips an item currently being repaired or observes its durable result;
-- it never creates a second status/history transition.
create or replace function public.reconcile_scheduled_work_at_v1(
  p_authoritative_now timestamptz default statement_timestamp(),
  p_batch_size integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  invitation_row public.invitations;
  challenge_row public.challenges;
  cleanup_result jsonb;
  invitations_expired integer := 0;
  challenges_reconciled integer := 0;
  was_pending boolean;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'Scheduled lifecycle work is restricted to the service role.' using errcode = '42501';
  end if;
  if p_authoritative_now is null or p_batch_size is null or p_batch_size < 1 then
    raise exception 'A positive work batch and authoritative time are required.' using errcode = '22023';
  end if;

  for invitation_row in
    select invitation_item.*
      from public.invitations invitation_item
     where invitation_item.status = 'pending'
       and p_authoritative_now >= (invitation_item.start_date::timestamp at time zone invitation_item.challenge_time_zone)
     order by invitation_item.start_date, invitation_item.id
     limit p_batch_size
     for update skip locked
  loop
    was_pending := invitation_row.status = 'pending';
    invitation_row := public.expire_invitation_at_v1(invitation_row.id, p_authoritative_now);
    if was_pending and invitation_row.status = 'expired' then
      invitations_expired := invitations_expired + 1;
    end if;
  end loop;

  for challenge_row in
    select challenge_item.*
      from public.challenges challenge_item
     where challenge_item.status in ('scheduled', 'active')
       and (
         (p_authoritative_now >= (challenge_item.start_date::timestamp at time zone challenge_item.challenge_time_zone))
         or (p_authoritative_now >= ((challenge_item.deadline_date + 1)::timestamp at time zone challenge_item.challenge_time_zone))
       )
     order by challenge_item.start_date, challenge_item.id
     limit p_batch_size
     for update skip locked
  loop
    perform public.reconcile_challenge_terminal_v1(challenge_row.id, p_authoritative_now, null, true);
    challenges_reconciled := challenges_reconciled + 1;
  end loop;

  -- Keep lifecycle repairs durable even when physical cleanup is temporarily
  -- unavailable; the cleanup wrapper records the privacy-filtered alert.
  cleanup_result := public.run_retention_cleanup_at_v1(p_authoritative_now, p_batch_size);
  return jsonb_build_object(
    'authoritativeNow', p_authoritative_now,
    'invitationsExpired', invitations_expired,
    'challengesReconciled', challenges_reconciled,
    -- Automatic activation/deadline work is intentionally silent. Notice
    -- delivery is a separate outbox worker and remains at-most-once.
    'noticesQueued', 0,
    'cleanup', cleanup_result
  );
end;
$$;

-- Physical cleanup is deliberately separate from logical expiry. It removes
-- only rows whose authoritative cutoff has been reached and can safely be
-- called again after a worker stops halfway through a batch.
create or replace function public.cleanup_retained_data_at_v1(
  p_authoritative_now timestamptz,
  p_batch_size integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  invitation_row public.invitations;
  challenge_row public.challenges;
  deleted_invitations integer := 0;
  deleted_challenges integer := 0;
  deleted_notices integer := 0;
  deleted_history integer := 0;
  deleted_member_records integer := 0;
  deleted_ledger integer := 0;
  affected integer := 0;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'Retention cleanup is restricted to the service role.' using errcode = '42501';
  end if;
  if p_authoritative_now is null or p_batch_size is null or p_batch_size < 1 then
    raise exception 'A positive cleanup batch and authoritative time are required.' using errcode = '22023';
  end if;

  for challenge_row in
    select challenge_item.*
      from public.challenges challenge_item
     where challenge_item.retention_expires_at is not null
       and challenge_item.retention_expires_at <= p_authoritative_now
       and challenge_item.status in ('canceled', 'abandoned', 'completed', 'incomplete')
     order by challenge_item.retention_expires_at, challenge_item.id
     limit p_batch_size
     for update skip locked
  loop
    -- Corrections restrict Challenge deletion; Solves and memberships cascade.
    delete from public.solve_corrections where challenge_id = challenge_row.id;
    delete from public.lifecycle_history
     where aggregate_kind = 'challenge' and aggregate_id = challenge_row.id;
    get diagnostics affected = row_count;
    deleted_history := deleted_history + affected;
    delete from public.challenges where id = challenge_row.id;
    if found then deleted_challenges := deleted_challenges + 1; end if;
  end loop;

  -- Notice delivery metadata has its independent 90-day security/audit
  -- cutoff. It is intentionally not removed merely because a shared record
  -- reaches its shorter Invitation or longer Challenge cutoff.
  -- Challenges reference their source Invitation, so remove expired
  -- Invitations after their retained Challenge (if any) is gone.
  for invitation_row in
    select invitation_item.*
     from public.invitations invitation_item
     where invitation_item.retention_expires_at is not null
       and invitation_item.retention_expires_at <= p_authoritative_now
       and not exists (
         select 1 from public.challenges challenge_item
          where challenge_item.invitation_id = invitation_item.id
       )
     order by invitation_item.retention_expires_at, invitation_item.id
     limit p_batch_size
     for update skip locked
  loop
    delete from public.lifecycle_history
     where aggregate_kind = 'invitation' and aggregate_id = invitation_row.id;
    get diagnostics affected = row_count;
    deleted_history := deleted_history + affected;
    delete from public.invitations where id = invitation_row.id;
    if found then deleted_invitations := deleted_invitations + 1; end if;
  end loop;

  delete from public.transactional_notices
   where retention_expires_at is not null and retention_expires_at <= p_authoritative_now;
  get diagnostics affected = row_count;
  deleted_notices := deleted_notices + affected;

  delete from public.member_retention_metadata
   where retention_expires_at <= p_authoritative_now;
  get diagnostics deleted_ledger = row_count;

  -- A Deleted Member record is no longer needed once its longest shared
  -- Challenge window has closed. Only delete a parent proven childless; this
  -- keeps a bounded batch resumable when one deleted Member owns more child
  -- rows than the worker's batch size.
  delete from public.deleted_member_records record_row
     where record_row.challenge_retention_until <= p_authoritative_now
     and not exists (
       select 1 from public.challenges challenge_child
        where challenge_child.deleted_member_record_id = record_row.id
     )
     and not exists (
       select 1 from public.invitations invitation_child
        where invitation_child.deleted_member_record_id = record_row.id
     )
     and not exists (
       select 1 from public.member_retention_metadata metadata_child
        where metadata_child.deleted_member_record_id = record_row.id
     );
  get diagnostics deleted_member_records = row_count;

  return jsonb_build_object(
    'invitationsDeleted', deleted_invitations,
    'challengesDeleted', deleted_challenges,
    'noticesDeleted', deleted_notices,
    'historyDeleted', deleted_history,
    'ledgerDeleted', deleted_ledger,
    'deletedMemberRecords', deleted_member_records
  );
end;
$$;

-- This wrapper is intentionally non-throwing for an operational scheduler:
-- a late/failed cleanup raises a privacy-filtered alert while leaving logical
-- expiry in force. The next invocation retries the same idempotent cutoff.
create or replace function public.run_retention_cleanup_at_v1(
  p_authoritative_now timestamptz default statement_timestamp(),
  p_batch_size integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cleanup_result jsonb;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'Retention cleanup is restricted to the service role.' using errcode = '42501';
  end if;
  begin
    cleanup_result := public.cleanup_retained_data_at_v1(p_authoritative_now, p_batch_size);
    return jsonb_build_object('ok', true) || cleanup_result;
  exception when others then
    insert into public.operational_alerts(code, severity, details)
    values (
      'retention_cleanup_failed', 'error',
      jsonb_build_object('window', 'retention', 'retryable', true)
    );
    return jsonb_build_object('ok', false, 'alertCode', 'retention_cleanup_failed');
  end;
end;
$$;

-- Keep the ticket-32 compatibility seam while routing it through the same
-- resumable policy. Existing callers receive the historical integer count.
create or replace function public.cleanup_deleted_member_records_at_v1(
  p_authoritative_now timestamptz default statement_timestamp()
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  result := public.cleanup_retained_data_at_v1(p_authoritative_now, 100);
  return coalesce((result->>'deletedMemberRecords')::integer, 0);
end;
$$;

-- Logical expiry also applies to direct table reads used only for Realtime
-- invalidation. Snapshot functions remain the authoritative read path.
drop policy if exists challenge_members_realtime_read on public.challenge_members;
create policy challenge_members_realtime_read
on public.challenge_members for select to authenticated
using (member_id = (select auth.uid()) and exists (
  select 1 from public.challenges challenge_row
   where challenge_row.id = challenge_members.challenge_id
     and (challenge_row.retention_expires_at is null or challenge_row.retention_expires_at > clock_timestamp())
));

drop policy if exists challenges_member_realtime_read on public.challenges;
create policy challenges_member_realtime_read
on public.challenges for select to authenticated
using (
  (retention_expires_at is null or retention_expires_at > clock_timestamp())
  and exists (
    select 1 from public.challenge_members member_row
     where member_row.challenge_id = challenges.id
       and member_row.member_id = (select auth.uid())
  )
);

drop policy if exists solves_member_realtime_read on public.solves;
create policy solves_member_realtime_read
on public.solves for select to authenticated
using (exists (
  select 1 from public.challenge_members member_row
  join public.challenges challenge_row on challenge_row.id = member_row.challenge_id
   where member_row.challenge_id = solves.challenge_id
     and member_row.member_id = (select auth.uid())
     and (challenge_row.retention_expires_at is null or challenge_row.retention_expires_at > clock_timestamp())
));

-- Expired records are unavailable to the authenticated status/history seams,
-- even if a cleanup worker has not physically removed them yet.
create or replace function public.challenge_effective_status_at_v1(
  p_status text,
  p_start_date date,
  p_challenge_time_zone text,
  p_authoritative_now timestamptz
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_status in ('scheduled', 'active')
      and p_authoritative_now < (p_start_date::timestamp at time zone p_challenge_time_zone)
      then 'scheduled'
    when p_status = 'scheduled'
      and p_authoritative_now >= (p_start_date::timestamp at time zone p_challenge_time_zone)
      then 'active'
    else p_status
  end;
$$;

create or replace function public.get_challenge_effective_status_at_v1(
  p_challenge_id uuid,
  p_authoritative_now timestamptz
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_member uuid := (select auth.uid());
  challenge_row public.challenges;
begin
  if current_member is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  select challenge_item.* into challenge_row
    from public.challenges challenge_item
   where challenge_item.id = p_challenge_id
     and (challenge_item.retention_expires_at is null or challenge_item.retention_expires_at > p_authoritative_now)
     and exists (
       select 1 from public.challenge_members member_row
        where member_row.challenge_id = challenge_item.id
          and member_row.member_id = current_member
     );
  if not found then
    raise exception 'The Challenge is no longer available.' using errcode = 'P0003';
  end if;
  challenge_row := public.reconcile_challenge_terminal_v1(
    challenge_row.id, p_authoritative_now, null, true
  );
  if challenge_row.id is null then
    raise exception 'The Challenge is no longer available.' using errcode = 'P0003';
  end if;
  if challenge_row.terminal_at is not null
    and p_authoritative_now < challenge_row.terminal_at then
    return public.challenge_effective_status_at_v1(
      'scheduled', challenge_row.start_date,
      challenge_row.challenge_time_zone, p_authoritative_now
    );
  end if;
  return public.challenge_effective_status_at_v1(
    challenge_row.status, challenge_row.start_date,
    challenge_row.challenge_time_zone, p_authoritative_now
  );
end;
$$;

create or replace function public.get_solve_history_v1(p_challenge_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  challenge_row public.challenges;
begin
  select * into challenge_row
    from public.challenges
   where id = p_challenge_id
     and (retention_expires_at is null or retention_expires_at > clock_timestamp())
     and exists (
       select 1 from public.challenge_members
        where challenge_id = p_challenge_id and member_id = (select auth.uid())
     );
  if not found then
    raise exception 'The Challenge is no longer available.' using errcode = '42501';
  end if;
  return public.solve_history_json_v1(p_challenge_id);
end;
$$;

create or replace function public.get_pending_invitation_details_for_member_v1()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller_email text;
  invitation_row public.invitations;
begin
  select lower(email) into caller_email from auth.users where id = (select auth.uid());
  select invitation_item.* into invitation_row
    from public.invitations invitation_item
   where invitation_item.status = 'pending'
     and lower(invitation_item.invited_email) = caller_email
   order by invitation_item.created_at asc
   limit 1;
  if not found then return null; end if;
  invitation_row := public.expire_invitation_if_due_v1(invitation_row.id);
  if invitation_row.status <> 'pending' then return null; end if;
  return public.invitation_details_json_v1(invitation_row);
end;
$$;

create or replace function public.get_invitation_at_v1(
  p_invitation_id uuid,
  p_authoritative_now timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  invitation_row public.invitations;
begin
  select * into invitation_row
    from public.invitations invitation_item
   where invitation_item.id = p_invitation_id
     and ((select auth.role()) = 'service_role'
       or invitation_item.inviter_id = (select auth.uid())
       or lower(invitation_item.invited_email) = lower((select email from auth.users where id = (select auth.uid()))));
  if not found then return null; end if;
  if invitation_row.retention_expires_at is not null
    and invitation_row.retention_expires_at <= p_authoritative_now then
    return null;
  end if;
  invitation_row := public.expire_invitation_at_v1(invitation_row.id, p_authoritative_now);
  return public.invitation_json_v1(invitation_row)
    || jsonb_build_object('status', public.invitation_effective_status_at_v1(
      invitation_row.status, invitation_row.start_date,
      invitation_row.challenge_time_zone, p_authoritative_now
    ));
end;
$$;

-- A correction is a command against a retained Challenge Record. This trigger
-- guards the existing ticket-28 command without changing its public signature.
create or replace function public.reject_expired_solve_correction_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.challenges challenge_row
     where challenge_row.id = NEW.challenge_id
       and challenge_row.retention_expires_at is not null
       and challenge_row.retention_expires_at <= clock_timestamp()
  ) then
    raise exception 'The Challenge is no longer available.' using errcode = 'P0003';
  end if;
  return NEW;
end;
$$;

drop trigger if exists solve_corrections_retention_guard on public.solve_corrections;
create trigger solve_corrections_retention_guard
before insert on public.solve_corrections
for each row execute function public.reject_expired_solve_correction_v1();

revoke all on function public.expire_invitation_at_v1(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.record_lifecycle_history_v1(text, uuid, text, timestamptz, text) from public, anon, authenticated;
revoke all on function public.invitation_lifecycle_history_source_v1(text, uuid) from public, anon, authenticated;
revoke all on function public.challenge_lifecycle_history_source_v1(text, uuid) from public, anon, authenticated;
revoke all on function public.retention_expires_at_v1(text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.notice_retention_expires_at_v1(timestamptz) from public, anon, authenticated;
revoke all on function public.assign_retention_cutoff_v1() from public, anon, authenticated;
revoke all on function public.reject_expired_solve_correction_v1() from public, anon, authenticated;
revoke all on function public.reconcile_scheduled_work_at_v1(timestamptz, integer) from public, anon, authenticated;
revoke all on function public.cleanup_retained_data_at_v1(timestamptz, integer) from public, anon, authenticated;
revoke all on function public.run_retention_cleanup_at_v1(timestamptz, integer) from public, anon, authenticated;
revoke all on function public.record_invitation_lifecycle_history_v1() from public, anon, authenticated;
revoke all on function public.record_challenge_lifecycle_history_v1() from public, anon, authenticated;
grant execute on function public.reconcile_scheduled_work_at_v1(timestamptz, integer) to service_role;
grant execute on function public.expire_invitation_at_v1(uuid, timestamptz) to service_role;
grant execute on function public.cleanup_retained_data_at_v1(timestamptz, integer) to service_role;
grant execute on function public.run_retention_cleanup_at_v1(timestamptz, integer) to service_role;
grant execute on function public.cleanup_deleted_member_records_at_v1(timestamptz) to service_role;
grant execute on function public.get_challenge_effective_status_at_v1(uuid, timestamptz) to authenticated;
grant execute on function public.get_solve_history_v1(uuid) to authenticated;

create or replace function public.foundation_health_v1()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'service', 'larp-code', 'schemaVersion', 13,
    'serverTime', statement_timestamp(), 'minimumClientVersion', '0.1.0'
  );
$$;
revoke all on function public.foundation_health_v1() from public;
grant execute on function public.foundation_health_v1() to anon, authenticated;
