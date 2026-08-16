-- Ticket 26: derive Scheduled/Active state from immutable terms and release a
-- whole scheduled Challenge atomically on an explicit cancellation.

alter table public.challenges
  add column terminal_actor_id uuid,
  add column terminal_at timestamptz;

alter table public.challenges
  add constraint challenges_terminal_metadata check (
    (status in ('scheduled', 'active') and terminal_actor_id is null and terminal_at is null)
    or (status = 'canceled' and terminal_actor_id is not null and terminal_at is not null)
    or (status in ('abandoned', 'completed', 'incomplete') and terminal_at is null)
  );

create or replace function public.challenge_effective_status_at_v1(
  p_status text,
  p_start_date date,
  p_challenge_time_zone text,
  p_authoritative_now timestamptz
)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_status = 'scheduled'
      and ((p_authoritative_now at time zone p_challenge_time_zone)::date >= p_start_date)
      then 'active'
    else p_status
  end;
$$;

create or replace function public.challenge_effective_status_v1(challenge_row public.challenges)
returns text language sql volatile set search_path = '' as $$
  select public.challenge_effective_status_at_v1(
    challenge_row.status,
    challenge_row.start_date,
    challenge_row.challenge_time_zone,
    clock_timestamp()
  );
$$;

-- Authenticated read seam for deterministic clients and invariant tests. It
-- exposes only the lifecycle status of a Challenge the caller belongs to;
-- callers cannot use it to inspect another Member's schedule.
create or replace function public.get_challenge_effective_status_at_v1(
  p_challenge_id uuid,
  p_authoritative_now timestamptz
)
returns text language plpgsql stable security definer set search_path = '' as $$
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
     and exists (
       select 1 from public.challenge_members member_row
        where member_row.challenge_id = challenge_item.id
          and member_row.member_id = current_member
     );
  if not found then
    raise exception 'The Challenge is no longer available.' using errcode = 'P0003';
  end if;
  return public.challenge_effective_status_at_v1(
    challenge_row.status,
    challenge_row.start_date,
    challenge_row.challenge_time_zone,
    p_authoritative_now
  );
end;
$$;

create or replace function public.enforce_challenge_lifecycle_transition_v1()
returns trigger language plpgsql set search_path = '' as $$
begin
  if OLD.status = 'canceled' then
    if row(NEW.status, NEW.terminal_actor_id, NEW.terminal_at)
      is distinct from row(OLD.status, OLD.terminal_actor_id, OLD.terminal_at) then
      raise exception 'Canceled Challenges cannot be reactivated.' using errcode = '22023';
    end if;
  elsif NEW.status = 'canceled' then
    if OLD.status <> 'scheduled' or NEW.terminal_actor_id is null or NEW.terminal_at is null then
      raise exception 'Only a Scheduled Challenge can be canceled.' using errcode = '22023';
    end if;
  elsif NEW.status = 'active' and OLD.status = 'scheduled'
    and clock_timestamp() < (OLD.start_date::timestamp at time zone OLD.challenge_time_zone) then
    raise exception 'A Challenge cannot become Active before its Start Date.' using errcode = 'P0003';
  end if;
  return NEW;
end;
$$;

create trigger challenges_lifecycle_transition
before update on public.challenges
for each row execute function public.enforce_challenge_lifecycle_transition_v1();

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
    'members', coalesce((
      select jsonb_agg(public.challenge_member_json_v1(member_row) order by member_row.member_id)
      from public.challenge_members member_row
      where member_row.challenge_id = challenge_row.id
    ), '[]'::jsonb)
  );
$$;

create or replace function public.cancel_challenge_v1(
  p_idempotency_key uuid,
  p_command_version integer,
  p_command_kind text,
  p_member_id uuid,
  p_member_email text,
  p_challenge_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_member uuid := (select auth.uid());
  verified_email text;
  challenge_row public.challenges;
  command_result jsonb;
  existing_kind text;
  existing_version integer;
  claimed boolean := false;
  authoritative_now timestamptz;
  commitment_count integer;
begin
  if current_member is null or p_member_id is distinct from current_member then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_command_version is distinct from 1 or p_command_kind is distinct from 'cancel_challenge' then
    raise exception 'The command version is no longer current.' using errcode = '22023';
  end if;
  select lower(email) into verified_email
    from auth.users
   where id = current_member and email is not null and email_confirmed_at is not null;
  if verified_email is null or lower(btrim(coalesce(p_member_email, ''))) is distinct from verified_email then
    raise exception 'A verified email is required.' using errcode = '42501';
  end if;

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

  select * into challenge_row
    from public.challenges
   where id = p_challenge_id
   for update;
  if not found then
    raise exception 'The Challenge is no longer available.' using errcode = 'P0003';
  end if;
  if not exists (
    select 1 from public.challenge_members
     where challenge_id = challenge_row.id and member_id = current_member and lower(member_email) = verified_email
  ) then
    raise exception 'Only a Challenge Member can cancel this Challenge.' using errcode = '42501';
  end if;

  authoritative_now := clock_timestamp();
  if public.challenge_effective_status_at_v1(
    challenge_row.status, challenge_row.start_date, challenge_row.challenge_time_zone, authoritative_now
  ) = 'active' then
    raise exception 'The Challenge is already Active and cannot be canceled.' using errcode = 'P0003';
  end if;
  if challenge_row.status <> 'scheduled' then
    raise exception 'The Challenge is no longer Scheduled.' using errcode = 'P0003';
  end if;

  insert into public.member_command_idempotency(
    member_id, idempotency_key, command_version, command_kind, member_email, intent
  ) values (
    current_member, p_idempotency_key, p_command_version, p_command_kind, verified_email,
    jsonb_build_object('challengeId', p_challenge_id)
  ) on conflict (member_id, idempotency_key) do nothing returning true into claimed;
  if not coalesce(claimed, false) then
    select result into command_result
      from public.member_command_idempotency
     where member_id = current_member and idempotency_key = p_idempotency_key;
    if command_result is not null then return command_result; end if;
  end if;

  select count(*) into commitment_count
    from public.member_commitments
   where challenge_id = challenge_row.id;
  if commitment_count <> 2 then
    raise exception 'The Challenge commitments are incomplete.' using errcode = 'P0003';
  end if;

  update public.challenges
     set status = 'canceled', terminal_actor_id = current_member, terminal_at = authoritative_now,
         updated_at = authoritative_now
   where id = challenge_row.id;
  select * into challenge_row from public.challenges where id = challenge_row.id;
  delete from public.member_commitments where challenge_id = challenge_row.id;

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
     and challenge_row.status in ('scheduled', 'active')
   limit 1;
$$;

create or replace function public.get_challenge_v1(p_challenge_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.challenge_json_v1(challenge_row)
    from public.challenges challenge_row
   where challenge_row.id = p_challenge_id
     and exists (
       select 1 from public.challenge_members member_row
        where member_row.challenge_id = challenge_row.id and member_row.member_id = (select auth.uid())
     );
$$;

create or replace function public.get_latest_canceled_challenge_for_member_v1()
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.challenge_json_v1(challenge_row)
    from public.challenges challenge_row
   where challenge_row.status = 'canceled'
     and exists (
       select 1 from public.challenge_members member_row
        where member_row.challenge_id = challenge_row.id and member_row.member_id = (select auth.uid())
     )
   order by challenge_row.terminal_at desc
   limit 1;
$$;

revoke all on function public.challenge_effective_status_at_v1(text, date, text, timestamptz) from public;
revoke all on function public.challenge_effective_status_v1(public.challenges) from public;
revoke all on function public.get_challenge_effective_status_at_v1(uuid, timestamptz) from public;
revoke all on function public.cancel_challenge_v1(uuid, integer, text, uuid, text, uuid) from public;
revoke all on function public.get_committed_challenge_for_member_v1() from public;
revoke all on function public.get_challenge_v1(uuid) from public;
revoke all on function public.get_latest_canceled_challenge_for_member_v1() from public;
grant execute on function public.cancel_challenge_v1(uuid, integer, text, uuid, text, uuid) to authenticated;
grant execute on function public.get_committed_challenge_for_member_v1() to authenticated;
grant execute on function public.get_challenge_v1(uuid) to authenticated;
grant execute on function public.get_latest_canceled_challenge_for_member_v1() to authenticated;
grant execute on function public.get_challenge_effective_status_at_v1(uuid, timestamptz) to authenticated;

create or replace function public.foundation_health_v1()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('service', 'larp-code', 'schemaVersion', 6, 'serverTime', clock_timestamp());
$$;

revoke all on function public.foundation_health_v1() from public;
grant execute on function public.foundation_health_v1() to anon, authenticated;
