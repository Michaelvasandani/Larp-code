-- Ticket 25: accept an immutable Invitation as one atomic two-Member commitment.
-- Invitations remain immutable proposals; all accepted terms are copied into the
-- Challenge so later Invitation status changes cannot mutate a Challenge record.
create table public.challenges (
  id uuid primary key default gen_random_uuid(),
  invitation_id uuid not null unique references public.invitations(id),
  inviter_id uuid not null references auth.users(id),
  invited_member_id uuid not null references auth.users(id),
  challenge_time_zone text not null,
  start_date date not null,
  deadline_date date not null,
  problem_set_version_id text not null references public.problem_set_versions(id),
  status text not null default 'scheduled'
    check (status in ('scheduled', 'active', 'canceled', 'abandoned', 'completed', 'incomplete')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint challenges_distinct_members check (inviter_id <> invited_member_id),
  constraint challenges_ordered_dates check (deadline_date >= start_date)
);

create table public.challenge_members (
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  member_id uuid not null references auth.users(id),
  member_email text not null,
  display_name text not null,
  authority text not null default 'equal' check (authority = 'equal'),
  joined_at timestamptz not null default clock_timestamp(),
  primary key (challenge_id, member_id),
  unique (challenge_id, member_email)
);

-- A Member's capacity is represented by one uniquely keyed row. Acceptance and
-- every future terminal lifecycle command can therefore reserve/release both
-- participants in one transaction without a check-then-insert race.
create table public.member_commitments (
  member_id uuid primary key references auth.users(id) on delete cascade,
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  committed_at timestamptz not null default clock_timestamp()
);

alter table public.challenges enable row level security;
alter table public.challenge_members enable row level security;
alter table public.member_commitments enable row level security;
revoke all on table public.challenges, public.challenge_members, public.member_commitments from anon, authenticated;
-- The trusted notice/scheduled-job boundary and local invariant tests use the
-- service role; client roles remain unable to read or mutate these relations.
-- The trusted local invariant harness seeds boundary rows through the service
-- role; client roles remain unable to read or mutate these relations.
grant select, insert, update on table public.challenges to service_role;
grant select, insert on table public.challenge_members, public.member_commitments to service_role;
grant select, insert, update on table public.invitations to service_role;

create or replace function public.reject_challenge_terms_update_v1()
returns trigger language plpgsql set search_path = '' as $$
begin
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

create trigger challenges_terms_immutable
before update on public.challenges
for each row execute function public.reject_challenge_terms_update_v1();

create or replace function public.reject_challenge_membership_update_v1()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Challenge membership is immutable.' using errcode = '22023';
end;
$$;

create trigger challenge_members_immutable
before update or delete on public.challenge_members
for each row execute function public.reject_challenge_membership_update_v1();

create or replace function public.challenge_member_json_v1(member_row public.challenge_members)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'memberId', member_row.member_id,
    'email', member_row.member_email,
    'displayName', member_row.display_name,
    'authority', member_row.authority
  );
$$;

create or replace function public.challenge_json_v1(challenge_row public.challenges)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', challenge_row.id,
    'invitationId', challenge_row.invitation_id,
    'timeZone', challenge_row.challenge_time_zone,
    'startDate', challenge_row.start_date,
    'deadlineDate', challenge_row.deadline_date,
    'problemSetVersionId', challenge_row.problem_set_version_id,
    'status', challenge_row.status,
    'createdAt', challenge_row.created_at,
    'members', coalesce((
      select jsonb_agg(public.challenge_member_json_v1(member_row) order by member_row.member_id)
      from public.challenge_members member_row
      where member_row.challenge_id = challenge_row.id
    ), '[]'::jsonb)
  );
$$;

create or replace function public.effective_invitation_json_v1(invitation_row public.invitations)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  result jsonb := public.invitation_json_v1(invitation_row);
begin
  if invitation_row.status = 'pending'
    and clock_timestamp() >= (invitation_row.start_date::timestamp at time zone invitation_row.challenge_time_zone) then
    return result || jsonb_build_object('status', 'expired');
  end if;
  return result;
end;
$$;

create or replace function public.invitation_details_json_v1(invitation_row public.invitations)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'invitation', public.effective_invitation_json_v1(invitation_row),
    'problemSetVersion', (
      select public.problem_set_version_json_v1(version_row) || jsonb_build_object(
        'problemCount', (select count(*) from public.problem_set_version_problems item
                         where item.problem_set_version_id = version_row.id)
      )
      from public.problem_set_versions version_row
      where version_row.id = invitation_row.problem_set_version_id
    ),
    'partner', jsonb_build_object(
      'memberId', invitation_row.inviter_id,
      'email', lower(coalesce((select email from auth.users where id = invitation_row.inviter_id), '')),
      'displayName', coalesce((select display_name from public.member_accounts where id = invitation_row.inviter_id), 'A Member')
    ),
    'sharedRecord', jsonb_build_object(
      'visibility', 'both_members',
      'authority', 'equal',
      'canEitherMemberEnd', true
    )
  );
$$;

create or replace function public.get_pending_invitation_details_for_member_v1()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  current_member uuid := (select auth.uid());
  caller_email text;
  invitation_row public.invitations;
begin
  select lower(email) into caller_email from auth.users where id = current_member;
  select * into invitation_row
  from public.invitations
  where status = 'pending'
    and lower(invited_email) = caller_email
  order by created_at asc
  limit 1;
  if not found then return null; end if;
  return public.invitation_details_json_v1(invitation_row);
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
  if not found or current_member is null or (invitation_row.inviter_id is distinct from current_member
    and lower(coalesce(invitation_row.invited_email, '')) is distinct from caller_email) then
    raise exception 'Invitation is unavailable.' using errcode = '42501';
  end if;
  return public.invitation_details_json_v1(invitation_row);
end;
$$;

create or replace function public.accept_invitation_v1(
  p_idempotency_key uuid,
  p_command_version integer,
  p_command_kind text,
  p_member_id uuid,
  p_member_email text,
  p_invitation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_member uuid := (select auth.uid());
  verified_email text;
  invitation_row public.invitations;
  challenge_row public.challenges;
  inviter_account public.member_accounts;
  invited_account public.member_accounts;
  inviter_email text;
  command_result jsonb;
  existing_kind text;
  existing_version integer;
  claimed boolean := false;
  authoritative_now timestamptz;
begin
  if current_member is null or p_member_id is distinct from current_member then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if not public.is_supported_command_contract_version_v1(p_command_version)
    or p_command_kind is distinct from 'accept_invitation' then
    raise exception 'The command version is no longer current.' using errcode = '22023';
  end if;
  select lower(email) into verified_email
  from auth.users
  where id = current_member and email is not null and email_confirmed_at is not null;
  if verified_email is null or lower(btrim(coalesce(p_member_email, ''))) is distinct from verified_email then
    raise exception 'A verified email is required.' using errcode = '42501';
  end if;

  -- A completed idempotency result wins before any current Invitation state is
  -- inspected. This makes a retry after success return the same Challenge.
  select command_kind, command_version, result
    into existing_kind, existing_version, command_result
    from public.member_command_idempotency
   where member_id = current_member and idempotency_key = p_idempotency_key
   for update;
  if found then
    if existing_kind is distinct from p_command_kind or existing_version is distinct from p_command_version then
      raise exception 'The idempotency key is bound to another command.' using errcode = '22023';
    end if;
    if command_result is not null then return command_result; end if;
  end if;

  select * into invitation_row
  from public.invitations
  where id = p_invitation_id
  for update;
  if not found then
    raise exception 'The Invitation is no longer available.' using errcode = 'P0003';
  end if;
  if invitation_row.status <> 'pending' then
    raise exception 'The Invitation is no longer pending.' using errcode = 'P0003';
  end if;
  if lower(invitation_row.invited_email) is distinct from verified_email then
    raise exception 'Sign in with the invited email to accept this Invitation.' using errcode = '42501';
  end if;
  if invitation_row.inviter_id = current_member then
    raise exception 'The inviter cannot accept their own Invitation.' using errcode = '42501';
  end if;

  -- Advisory transaction locks are acquired in a stable order so two
  -- competing Invitations involving the same pair cannot deadlock while they
  -- both inspect and reserve capacity.
  if invitation_row.inviter_id::text < current_member::text then
    perform pg_advisory_xact_lock(hashtext(invitation_row.inviter_id::text));
    perform pg_advisory_xact_lock(hashtext(current_member::text));
  else
    perform pg_advisory_xact_lock(hashtext(current_member::text));
    perform pg_advisory_xact_lock(hashtext(invitation_row.inviter_id::text));
  end if;

  -- Read authoritative time only after all participant locks are acquired. A
  -- waiter that crosses the Start boundary must lose just like a fresh call.
  authoritative_now := clock_timestamp();
  if authoritative_now >= (invitation_row.start_date::timestamp at time zone invitation_row.challenge_time_zone) then
    raise exception 'The Invitation has expired because its Start Date has begun.' using errcode = 'P0003';
  end if;

  select * into inviter_account from public.member_accounts
  where id = invitation_row.inviter_id and status = 'active';
  select * into invited_account from public.member_accounts
  where id = current_member and status = 'active';
  if not found or inviter_account.id is null then
    raise exception 'Both Members must have an active Member Account.' using errcode = '42501';
  end if;
  select lower(email) into inviter_email from auth.users where id = invitation_row.inviter_id;
  if inviter_email is null then
    raise exception 'The inviter is unavailable.' using errcode = 'P0003';
  end if;
  perform public.assert_problem_set_version_complete_v1(invitation_row.problem_set_version_id);
  if exists (
    select 1 from public.member_commitments
    where member_id in (invitation_row.inviter_id, current_member)
  ) then
    raise exception 'A Member already has another Committed Challenge.' using errcode = 'P0003';
  end if;

  insert into public.member_command_idempotency(
    member_id, idempotency_key, command_version, command_kind, member_email, intent
  ) values (
    current_member, p_idempotency_key, p_command_version, 'accept_invitation', verified_email,
    jsonb_build_object('invitationId', p_invitation_id)
  ) on conflict (member_id, idempotency_key) do nothing returning true into claimed;
  if not coalesce(claimed, false) then
    select result into command_result from public.member_command_idempotency
    where member_id = current_member and idempotency_key = p_idempotency_key;
    if command_result is not null then return command_result; end if;
  end if;

  insert into public.challenges(
    invitation_id, inviter_id, invited_member_id, challenge_time_zone,
    start_date, deadline_date, problem_set_version_id
  ) values (
    invitation_row.id, invitation_row.inviter_id, current_member, invitation_row.challenge_time_zone,
    invitation_row.start_date, invitation_row.deadline_date, invitation_row.problem_set_version_id
  ) returning * into challenge_row;

  insert into public.challenge_members(challenge_id, member_id, member_email, display_name)
  values
    (challenge_row.id, invitation_row.inviter_id, inviter_email, inviter_account.display_name),
    (challenge_row.id, current_member, verified_email, invited_account.display_name);

  insert into public.member_commitments(member_id, challenge_id)
  values (invitation_row.inviter_id, challenge_row.id), (current_member, challenge_row.id);

  -- Acceptance is the only state transition for the current Invitation. All
  -- other pending proposals involving either Member are terminally revoked in
  -- the same transaction, so no stale competing proposal survives success.
  update public.invitations
  set status = 'revoked', updated_at = clock_timestamp()
  where status = 'pending'
    and id <> invitation_row.id
    and (inviter_id in (invitation_row.inviter_id, current_member)
      or lower(invited_email) in (inviter_email, verified_email));
  update public.invitations
  set status = 'accepted', updated_at = clock_timestamp()
  where id = invitation_row.id;

  command_result := public.challenge_json_v1(challenge_row);
  update public.member_command_idempotency
  set result = command_result
  where member_id = current_member and idempotency_key = p_idempotency_key;
  return command_result;
end;
$$;

create or replace function public.get_committed_challenge_for_member_v1()
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.challenge_json_v1(challenge_row)
  from public.member_commitments commitment
  join public.challenges challenge_row on challenge_row.id = commitment.challenge_id
  where commitment.member_id = (select auth.uid())
    and challenge_row.status = 'scheduled'
  limit 1;
$$;

revoke all on function public.challenge_member_json_v1(public.challenge_members) from public;
revoke all on function public.challenge_json_v1(public.challenges) from public;
revoke all on function public.effective_invitation_json_v1(public.invitations) from public;
revoke all on function public.invitation_details_json_v1(public.invitations) from public;
revoke all on function public.get_pending_invitation_details_for_member_v1() from public;
revoke all on function public.get_invitation_details_v1(uuid) from public;
revoke all on function public.accept_invitation_v1(uuid, integer, text, uuid, text, uuid) from public;
revoke all on function public.get_committed_challenge_for_member_v1() from public;
grant execute on function public.get_pending_invitation_details_for_member_v1() to authenticated;
grant execute on function public.get_invitation_details_v1(uuid) to authenticated;
grant execute on function public.accept_invitation_v1(uuid, integer, text, uuid, text, uuid) to authenticated;
grant execute on function public.get_committed_challenge_for_member_v1() to authenticated;

create or replace function public.foundation_health_v1()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('service', 'larp-code', 'schemaVersion', 5, 'serverTime', clock_timestamp());
$$;
revoke all on function public.foundation_health_v1() from public;
grant execute on function public.foundation_health_v1() to anon, authenticated;
