-- Ticket 32: destructive Member Account deletion with bounded shared-record
-- retention. Identity-bearing rows are rewritten to a synthetic Deleted Member
-- before the auth user is removed, so a partner can finish reading a coherent
-- terminal Challenge without creating a link to future registration.

create table public.deleted_member_records (
  id uuid primary key default gen_random_uuid(),
  original_member_id uuid not null unique,
  deleted_at timestamptz not null,
  invitation_retention_until timestamptz not null,
  challenge_retention_until timestamptz not null,
  diagnostic_retention_until timestamptz not null,
  security_audit_retention_until timestamptz not null,
  backup_retention_until timestamptz not null,
  constraint deleted_member_record_windows check (
    invitation_retention_until >= deleted_at
    and challenge_retention_until >= invitation_retention_until
    and diagnostic_retention_until >= deleted_at
    and security_audit_retention_until >= diagnostic_retention_until
    and backup_retention_until >= deleted_at
  )
);

alter table public.deleted_member_records enable row level security;
revoke all on table public.deleted_member_records from anon, authenticated;
grant select, insert, delete on table public.deleted_member_records to service_role;

-- The extension has no diagnostic or audit payload store. This ledger is the
-- repository-owned seam that records the deletion windows without retaining a
-- credential or Challenge content. Provider-managed backups are represented
-- by their maximum contractual window, not copied into this database.
create table public.member_retention_metadata (
  id uuid primary key default gen_random_uuid(),
  deleted_member_record_id uuid not null references public.deleted_member_records(id) on delete cascade,
  category text not null check (category in ('diagnostic', 'security_audit', 'backup')),
  retention_expires_at timestamptz not null,
  source text not null check (source in ('repository_ledger', 'managed_backup')),
  created_at timestamptz not null default clock_timestamp(),
  unique (deleted_member_record_id, category)
);
alter table public.member_retention_metadata enable row level security;
revoke all on table public.member_retention_metadata from anon, authenticated;
grant select, insert, delete on table public.member_retention_metadata to service_role;

-- Preferences are intentionally a small, server-owned store so deletion has
-- an explicit erasure seam even before a client setting is added.
create table public.member_preferences (
  member_id uuid primary key references auth.users(id) on delete cascade,
  preferences jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default clock_timestamp()
);
alter table public.member_preferences enable row level security;
revoke all on table public.member_preferences from anon, authenticated;
grant select, insert, update, delete on table public.member_preferences to service_role;

alter table public.invitations
  add column deleted_member_record_id uuid references public.deleted_member_records(id),
  add column retention_expires_at timestamptz;
alter table public.challenges
  add column deleted_member_record_id uuid references public.deleted_member_records(id),
  add column retention_expires_at timestamptz;

-- Shared rows intentionally outlive auth.users. Their immutable UUID columns
-- now point either to a live auth user or to deleted_member_records.id.
alter table public.invitations drop constraint if exists invitations_inviter_id_fkey;
alter table public.challenges drop constraint if exists challenges_inviter_id_fkey;
alter table public.challenges drop constraint if exists challenges_invited_member_id_fkey;
alter table public.challenge_members drop constraint if exists challenge_members_member_id_fkey;
alter table public.solves drop constraint if exists solves_member_id_fkey;
alter table public.solve_corrections drop constraint if exists solve_corrections_actor_id_fkey;
alter table public.transactional_notices drop constraint if exists transactional_notices_recipient_member_id_fkey;
alter table public.transactional_notices
  add column inviter_member_id uuid;
grant select on table public.transactional_notices to service_role;
alter table public.transactional_notices drop constraint if exists transactional_notices_inviter_member_id_fkey;
update public.transactional_notices notice_row
   set inviter_member_id = invitation_row.inviter_id
  from public.invitations invitation_row
 where notice_row.inviter_member_id is null
   and notice_row.event_key = 'invitation:' || invitation_row.id || ':created';

create or replace function public.populate_notice_member_ids_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if NEW.recipient_member_id is null then
    select id into NEW.recipient_member_id from auth.users
     where lower(email) = lower(NEW.recipient_email) limit 1;
  end if;
  if NEW.inviter_member_id is null then
    select inviter_id into NEW.inviter_member_id from public.invitations
     where NEW.event_key = 'invitation:' || id || ':created' limit 1;
  end if;
  return NEW;
end;
$$;
create trigger transactional_notices_member_ids
before insert or update on public.transactional_notices
for each row execute function public.populate_notice_member_ids_v1();

-- Existing terminal rows receive the same finite logical retention guarantee.
update public.challenges
   set retention_expires_at = terminal_at + interval '365 days'
 where status in ('canceled', 'abandoned', 'completed', 'incomplete')
   and terminal_at is not null
   and retention_expires_at is null;
update public.invitations
   set retention_expires_at = terminal_at + interval '30 days'
 where status in ('revoked', 'declined', 'expired')
   and terminal_at is not null
   and retention_expires_at is null;

create or replace function public.reject_invitation_term_update_v1()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- The only permitted terms rewrite is the security-definer deletion
  -- transaction replacing identity fields with Deleted Member.
  if NEW.deleted_member_record_id is not null
    and exists (select 1 from public.deleted_member_records record_row where record_row.id = NEW.deleted_member_record_id)
    and NEW.status in ('pending', 'accepted', 'revoked', 'declined', 'expired') then
    NEW.updated_at := clock_timestamp();
    return NEW;
  end if;
  if row(NEW.inviter_id, NEW.invited_email, NEW.challenge_time_zone, NEW.start_date,
    NEW.deadline_date, NEW.problem_set_version_id)
    is distinct from row(OLD.inviter_id, OLD.invited_email, OLD.challenge_time_zone, OLD.start_date,
    OLD.deadline_date, OLD.problem_set_version_id) then
    raise exception 'Invitation terms are immutable; create a replacement Invitation.' using errcode = '22023';
  end if;
  NEW.updated_at := clock_timestamp();
  return NEW;
end;
$$;

create or replace function public.reject_challenge_terms_update_v1()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (NEW.inviter_id in (select id from public.deleted_member_records)
      or NEW.invited_member_id in (select id from public.deleted_member_records))
    and row(NEW.invitation_id, NEW.challenge_time_zone, NEW.start_date,
      NEW.deadline_date, NEW.problem_set_version_id)
      = row(OLD.invitation_id, OLD.challenge_time_zone, OLD.start_date,
      OLD.deadline_date, OLD.problem_set_version_id) then
    NEW.updated_at := clock_timestamp();
    return NEW;
  end if;
  if row(NEW.invitation_id, NEW.inviter_id, NEW.invited_member_id,
    NEW.challenge_time_zone, NEW.start_date, NEW.deadline_date, NEW.problem_set_version_id)
    is distinct from row(OLD.invitation_id, OLD.inviter_id, OLD.invited_member_id,
    OLD.challenge_time_zone, OLD.start_date, OLD.deadline_date, OLD.problem_set_version_id) then
    raise exception 'Accepted Challenge terms are immutable.' using errcode = '22023';
  end if;
  NEW.updated_at := clock_timestamp();
  return NEW;
end;
$$;

create or replace function public.reject_challenge_membership_update_v1()
returns trigger language plpgsql set search_path = '' as $$
begin
  if TG_OP = 'DELETE' and pg_trigger_depth() > 1 then
    return OLD;
  end if;
  if NEW.member_id in (select id from public.deleted_member_records)
    and NEW.member_email = 'Deleted Member'
    and NEW.display_name = 'Deleted Member'
    and row(NEW.challenge_id, NEW.authority, NEW.joined_at)
      = row(OLD.challenge_id, OLD.authority, OLD.joined_at) then
    return NEW;
  end if;
  raise exception 'Challenge membership is immutable.' using errcode = '22023';
end;
$$;

create or replace function public.invitation_json_v1(invitation_row public.invitations)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', invitation_row.id,
    'inviterId', invitation_row.inviter_id,
    'inviterDisplayName', coalesce((select display_name from public.member_accounts where id = invitation_row.inviter_id),
      case when exists (select 1 from public.deleted_member_records where id = invitation_row.inviter_id) then 'Deleted Member' else 'A Member' end),
    'invitedEmail', case when invitation_row.deleted_member_record_id is not null then 'Deleted Member' else invitation_row.invited_email end,
    'timeZone', invitation_row.challenge_time_zone,
    'startDate', invitation_row.start_date,
    'deadlineDate', invitation_row.deadline_date,
    'problemSetVersionId', invitation_row.problem_set_version_id,
    'status', public.invitation_effective_status_v1(invitation_row),
    'createdAt', invitation_row.created_at,
    'terminalActorId', invitation_row.terminal_actor_id,
    'terminalAt', invitation_row.terminal_at
  );
$$;

create or replace function public.challenge_json_v1(challenge_row public.challenges)
returns jsonb language sql volatile set search_path = '' as $$
  select jsonb_build_object(
    'id', challenge_row.id,
    'invitationId', challenge_row.invitation_id,
    'timeZone', challenge_row.challenge_time_zone,
    'startDate', challenge_row.start_date,
    'deadlineDate', challenge_row.deadline_date,
    'problemSetVersionId', challenge_row.problem_set_version_id,
    'status', public.challenge_effective_status_v1(challenge_row),
    'createdAt', challenge_row.created_at,
    'terminalActorId', challenge_row.terminal_actor_id,
    'terminalAt', challenge_row.terminal_at,
    'completionFarewellAt', challenge_row.completion_farewell_at,
    'viewerMemberId', (select auth.uid()),
    'finalTotals', case when challenge_row.status in ('canceled', 'abandoned', 'completed', 'incomplete')
      then public.challenge_terminal_totals_json_v1(challenge_row.id) else null end,
    'members', coalesce((
      select jsonb_agg(public.challenge_member_json_v1(member_row) order by member_row.member_id)
      from public.challenge_members member_row
      where member_row.challenge_id = challenge_row.id
    ), '[]'::jsonb),
    'progress', case when public.challenge_effective_status_v1(challenge_row) = 'active'
      then public.challenge_progress_json_v1(challenge_row) else null end,
    'solveHistory', public.solve_history_json_v1(challenge_row.id)
  ) - case when public.challenge_effective_status_v1(challenge_row) = 'active'
    then array['finalTotals']::text[] else array['progress']::text[] end;
$$;

create or replace function public.invitation_details_json_v1(invitation_row public.invitations)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'invitation', public.effective_invitation_json_v1(invitation_row),
    'problemSetVersion', (
      select public.problem_set_version_json_v1(version_row) || jsonb_build_object(
        'problemCount', (select count(*) from public.problem_set_version_problems item where item.problem_set_version_id = version_row.id)
      ) from public.problem_set_versions version_row where version_row.id = invitation_row.problem_set_version_id
    ),
    'partner', jsonb_build_object(
      'memberId', invitation_row.inviter_id,
      'email', case when exists (select 1 from public.deleted_member_records where id = invitation_row.inviter_id)
        then 'Deleted Member' else lower(coalesce((select email from auth.users where id = invitation_row.inviter_id), '')) end,
      'displayName', coalesce((select display_name from public.member_accounts where id = invitation_row.inviter_id),
        case when exists (select 1 from public.deleted_member_records where id = invitation_row.inviter_id) then 'Deleted Member' else 'A Member' end)
    ),
    'sharedRecord', jsonb_build_object('visibility', 'both_members', 'authority', 'equal', 'canEitherMemberEnd', true)
  );
$$;

create or replace function public.delete_member_account_v1(
  p_idempotency_key uuid,
  p_command_version integer,
  p_command_kind text,
  p_member_id uuid,
  p_member_email text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_member uuid := (select auth.uid());
  verified_email text;
  member_row public.member_accounts;
  deleted_row public.deleted_member_records;
  challenge_row public.challenges;
  invitation_row public.invitations;
  command_result jsonb;
  existing_kind text;
  existing_version integer;
  authoritative_now timestamptz := statement_timestamp();
  auth_time timestamptz;
  effective_status text;
  deleted_email text;
begin
  if current_member is null or p_member_id is distinct from current_member then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_command_version is distinct from 1 or p_command_kind is distinct from 'delete_member_account' then
    raise exception 'The command version is no longer current.' using errcode = '22023';
  end if;
  select lower(email) into verified_email from auth.users
   where id = current_member and email is not null and email_confirmed_at is not null;
  if verified_email is null or lower(btrim(coalesce(p_member_email, ''))) is distinct from verified_email then
    raise exception 'A verified email is required.' using errcode = '42501';
  end if;
  -- Supabase records the OTP verification instant in auth_time. A recent
  -- auth_time is the server-enforced fresh-email-confirmation boundary; the
  -- client cannot manufacture it by setting a request field.
  begin
    auth_time := coalesce(
      to_timestamp(((select auth.jwt())->>'auth_time')::double precision),
      to_timestamp((((select auth.jwt())->'amr'->0)->>'timestamp')::double precision)
    );
  exception when others then
    auth_time := null;
  end;
  if auth_time is null or auth_time < authoritative_now - interval '15 minutes' then
    raise exception 'A fresh email confirmation is required.' using errcode = '42501';
  end if;

  select command_kind, command_version, result into existing_kind, existing_version, command_result
    from public.member_command_idempotency
   where member_id = current_member and idempotency_key = p_idempotency_key for update;
  if found then
    if existing_kind is distinct from p_command_kind or existing_version is distinct from p_command_version then
      raise exception 'The idempotency key is bound to another command.' using errcode = '22023';
    end if;
    if command_result is not null then return command_result; end if;
  end if;
  select * into member_row from public.member_accounts where id = current_member and status = 'active' for update;
  if not found then raise exception 'A Member Account is required.' using errcode = '42501'; end if;

  -- Serialize deletion against acceptance and lifecycle commands for this
  -- Member. Every row rewrite below is part of this one transaction.
  perform pg_advisory_xact_lock(hashtext(current_member::text));
  insert into public.deleted_member_records(
    original_member_id, deleted_at, invitation_retention_until,
    challenge_retention_until, diagnostic_retention_until,
    security_audit_retention_until, backup_retention_until
  ) values (
    current_member, authoritative_now, authoritative_now + interval '30 days',
    authoritative_now + interval '365 days', authoritative_now + interval '30 days',
    authoritative_now + interval '90 days',
    authoritative_now + interval '30 days'
  ) returning * into deleted_row;
  deleted_email := 'deleted+' || replace(deleted_row.id::text, '-', '') || '@invalid.larp-code.example';
  insert into public.member_retention_metadata(deleted_member_record_id, category, retention_expires_at, source)
  values
    (deleted_row.id, 'diagnostic', deleted_row.diagnostic_retention_until, 'repository_ledger'),
    (deleted_row.id, 'security_audit', deleted_row.security_audit_retention_until, 'repository_ledger'),
    (deleted_row.id, 'backup', deleted_row.backup_retention_until, 'managed_backup');

  for challenge_row in
    select * from public.challenges
     where inviter_id = current_member or invited_member_id = current_member
     for update
  loop
    effective_status := public.challenge_effective_status_at_v1(
      challenge_row.status, challenge_row.start_date, challenge_row.challenge_time_zone, authoritative_now
    );
    if challenge_row.status = 'scheduled' and effective_status = 'active' then
      update public.challenges set status = 'active', updated_at = authoritative_now where id = challenge_row.id;
      challenge_row.status := 'active';
    end if;
    if challenge_row.status in ('scheduled', 'active') then
      update public.challenges
         set status = case when effective_status = 'active' then 'abandoned' else 'canceled' end,
             terminal_actor_id = deleted_row.id,
             terminal_at = authoritative_now,
             deleted_member_record_id = deleted_row.id,
             retention_expires_at = deleted_row.challenge_retention_until,
             updated_at = authoritative_now
       where id = challenge_row.id;
    elsif challenge_row.retention_expires_at is null then
      update public.challenges
         set deleted_member_record_id = deleted_row.id,
             retention_expires_at = deleted_row.challenge_retention_until
       where id = challenge_row.id;
    end if;
    delete from public.member_commitments where challenge_id = challenge_row.id;
    update public.challenge_members
       set member_id = deleted_row.id, member_email = 'Deleted Member', display_name = 'Deleted Member'
     where challenge_id = challenge_row.id and member_id = current_member;
    update public.solves set member_id = deleted_row.id where challenge_id = challenge_row.id and member_id = current_member;
    update public.solve_corrections set actor_id = deleted_row.id where challenge_id = challenge_row.id and actor_id = current_member;
    update public.challenges
       set inviter_id = case when inviter_id = current_member then deleted_row.id else inviter_id end,
           invited_member_id = case when invited_member_id = current_member then deleted_row.id else invited_member_id end
     where id = challenge_row.id;
  end loop;

  for invitation_row in
    select * from public.invitations
     where inviter_id = current_member or lower(invited_email) = verified_email
     for update
  loop
    if invitation_row.status = 'pending' then
      update public.invitations
         set status = 'revoked', terminal_actor_id = deleted_row.id, terminal_at = authoritative_now
       where id = invitation_row.id;
    end if;
    update public.invitations
       set inviter_id = case when inviter_id = current_member then deleted_row.id else inviter_id end,
           invited_email = case when lower(invited_email) = verified_email then deleted_email else invited_email end,
           deleted_member_record_id = deleted_row.id,
           retention_expires_at = deleted_row.invitation_retention_until
     where id = invitation_row.id;
  end loop;

  update public.transactional_notices
     set recipient_member_id = case when recipient_member_id = current_member then deleted_row.id else recipient_member_id end,
         recipient_email = case when recipient_member_id = current_member then deleted_email else recipient_email end,
         inviter_member_id = case when inviter_member_id = current_member then deleted_row.id else inviter_member_id end,
         inviter_display_name = case when inviter_member_id = current_member then 'Deleted Member' else inviter_display_name end
   where recipient_member_id = current_member
      or inviter_member_id = current_member
      or (recipient_member_id is null and lower(recipient_email) = verified_email);
  delete from public.invitation_rate_limits where member_id = current_member;
  delete from public.member_preferences where member_id = current_member;
  delete from public.member_command_idempotency where member_id = current_member;
  delete from public.member_accounts where id = current_member;
  -- Revoke every server session before removing the auth row. Existing access
  -- tokens remain cryptographically parseable until expiry, but cannot refresh
  -- or authorize any Member-scoped function after this transaction.
  delete from auth.sessions where user_id = current_member;

  command_result := jsonb_build_object(
    'deletedMemberId', deleted_row.id,
    'deletedAt', deleted_row.deleted_at
  );
  -- No credential, email, display name, or command envelope is retained for
  -- a deleted account. Auth deletion is last so auth.uid remains available for
  -- all authorization checks above.
  delete from auth.users where id = current_member;
  return command_result;
end;
$$;

create or replace function public.get_challenge_v1(p_challenge_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.challenge_json_v1(challenge_row)
    from public.challenges challenge_row
   where challenge_row.id = p_challenge_id
     and (challenge_row.retention_expires_at is null or challenge_row.retention_expires_at > clock_timestamp())
     and exists (select 1 from public.challenge_members member_row
       where member_row.challenge_id = challenge_row.id and member_row.member_id = (select auth.uid()));
$$;

create or replace function public.get_latest_terminal_challenge_for_member_v1()
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.challenge_json_v1(challenge_row)
    from public.challenges challenge_row
   where challenge_row.status in ('canceled', 'abandoned', 'completed', 'incomplete')
     and (challenge_row.retention_expires_at is null or challenge_row.retention_expires_at > clock_timestamp())
     and exists (select 1 from public.challenge_members member_row
       where member_row.challenge_id = challenge_row.id and member_row.member_id = (select auth.uid()))
   order by challenge_row.terminal_at desc nulls last limit 1;
$$;

create or replace function public.get_invitation_v1(p_invitation_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  current_member uuid := (select auth.uid());
  caller_email text;
  invitation_row public.invitations;
begin
  select * into invitation_row from public.invitations where id = p_invitation_id;
  select lower(email) into caller_email from auth.users where id = current_member;
  if not found or current_member is null
    or (invitation_row.inviter_id is distinct from current_member and lower(coalesce(invitation_row.invited_email, '')) is distinct from caller_email) then
    raise exception 'Invitation is unavailable.' using errcode = '42501';
  end if;
  if invitation_row.retention_expires_at is not null and invitation_row.retention_expires_at <= clock_timestamp() then return null; end if;
  invitation_row := public.expire_invitation_if_due_v1(invitation_row.id);
  return public.invitation_json_v1(invitation_row);
end;
$$;

create or replace function public.get_invitation_details_v1(p_invitation_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  current_member uuid := (select auth.uid());
  caller_email text;
  invitation_row public.invitations;
begin
  select * into invitation_row from public.invitations where id = p_invitation_id;
  select lower(email) into caller_email from auth.users where id = current_member;
  if not found or current_member is null
    or (invitation_row.inviter_id is distinct from current_member and lower(coalesce(invitation_row.invited_email, '')) is distinct from caller_email) then
    raise exception 'Invitation is unavailable.' using errcode = '42501';
  end if;
  if invitation_row.retention_expires_at is not null and invitation_row.retention_expires_at <= clock_timestamp() then return null; end if;
  return public.invitation_details_json_v1(invitation_row);
end;
$$;

create or replace function public.get_challenge_at_v1(p_challenge_id uuid, p_authoritative_now timestamptz)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  challenge_row public.challenges;
  effective_status text;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'This controlled-time seam is restricted to the service role.' using errcode = '42501';
  end if;
  select * into challenge_row from public.challenges where id = p_challenge_id;
  if not found then return null; end if;
  challenge_row := public.reconcile_challenge_terminal_v1(challenge_row.id, p_authoritative_now, null, true);
  select * into challenge_row from public.challenges where id = p_challenge_id;
  if challenge_row.retention_expires_at is not null and challenge_row.retention_expires_at <= p_authoritative_now then return null; end if;
  effective_status := public.challenge_effective_status_at_v1(
    challenge_row.status, challenge_row.start_date, challenge_row.challenge_time_zone, p_authoritative_now
  );
  return public.challenge_json_v1(challenge_row)
    || jsonb_build_object(
      'status', effective_status,
      'progress', case when effective_status = 'active' then public.challenge_progress_json_v1(challenge_row, p_authoritative_now) else null end
    )
    - case when effective_status = 'active' then array['finalTotals']::text[] else array['progress']::text[] end;
end;
$$;

create or replace function public.get_invitation_at_v1(p_invitation_id uuid, p_authoritative_now timestamptz)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when invitation_row.retention_expires_at is not null and invitation_row.retention_expires_at <= p_authoritative_now then null
    else public.invitation_json_v1(invitation_row) end
   from public.invitations invitation_row
   where invitation_row.id = p_invitation_id
     and ((select auth.role()) = 'service_role' or invitation_row.inviter_id = (select auth.uid())
       or lower(invitation_row.invited_email) = lower((select email from auth.users where id = (select auth.uid()))));
$$;

create or replace function public.cleanup_deleted_member_records_at_v1(p_authoritative_now timestamptz default statement_timestamp())
returns integer language plpgsql security definer set search_path = '' as $$
declare
  removed integer := 0;
  record_row public.deleted_member_records;
begin
  for record_row in
    select * from public.deleted_member_records
     where challenge_retention_until <= p_authoritative_now
     for update
  loop
    delete from public.member_retention_metadata
     where deleted_member_record_id = record_row.id
       and retention_expires_at <= p_authoritative_now;
    delete from public.solve_corrections where challenge_id in (select id from public.challenges where deleted_member_record_id = record_row.id);
    delete from public.solves where challenge_id in (select id from public.challenges where deleted_member_record_id = record_row.id);
    delete from public.challenges where deleted_member_record_id = record_row.id;
    delete from public.invitations where deleted_member_record_id = record_row.id;
    delete from public.deleted_member_records where id = record_row.id;
    removed := removed + 1;
  end loop;
  -- Records whose Challenge view is still retained can nevertheless have
  -- their shorter diagnostic/security/backup ledger windows cleaned now.
  delete from public.member_retention_metadata
   where retention_expires_at <= p_authoritative_now;
  return removed;
end;
$$;

create or replace function public.get_deleted_member_retention_v1(p_deleted_member_record_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'deletedMemberId', record_row.id,
    'deletedAt', record_row.deleted_at,
    'invitation', record_row.invitation_retention_until,
    'challenge', record_row.challenge_retention_until,
    'diagnostic', record_row.diagnostic_retention_until,
    'securityAudit', record_row.security_audit_retention_until,
    'backup', record_row.backup_retention_until,
    'ledger', coalesce((select jsonb_agg(jsonb_build_object(
      'category', metadata_row.category,
      'expiresAt', metadata_row.retention_expires_at,
      'source', metadata_row.source
    ) order by metadata_row.category) from public.member_retention_metadata metadata_row
      where metadata_row.deleted_member_record_id = record_row.id), '[]'::jsonb)
  )
  from public.deleted_member_records record_row
  where record_row.id = p_deleted_member_record_id;
$$;

revoke all on function public.delete_member_account_v1(uuid, integer, text, uuid, text) from public;
revoke all on function public.get_challenge_at_v1(uuid, timestamptz) from public;
revoke all on function public.get_invitation_at_v1(uuid, timestamptz) from public;
revoke all on function public.cleanup_deleted_member_records_at_v1(timestamptz) from public;
grant execute on function public.delete_member_account_v1(uuid, integer, text, uuid, text) to authenticated;
grant execute on function public.get_challenge_at_v1(uuid, timestamptz) to service_role;
grant execute on function public.get_invitation_at_v1(uuid, timestamptz) to service_role;
grant execute on function public.cleanup_deleted_member_records_at_v1(timestamptz) to service_role;
grant execute on function public.get_deleted_member_retention_v1(uuid) to service_role;

create or replace function public.foundation_health_v1()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'service', 'larp-code', 'schemaVersion', 11, 'serverTime', statement_timestamp(),
    'minimumClientVersion', '0.1.0'
  );
$$;
revoke all on function public.foundation_health_v1() from public;
grant execute on function public.foundation_health_v1() to anon, authenticated;
