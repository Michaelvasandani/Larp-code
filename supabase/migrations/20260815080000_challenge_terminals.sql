-- Ticket 29: authoritative Challenge outcomes, Active abandonment, and
-- terminal-record retention. A terminal Challenge keeps immutable members and
-- Solves; only the two capacity rows are released.

alter table public.challenges
  add column completion_farewell_at timestamptz;

alter table public.challenges
  drop constraint if exists challenges_terminal_metadata;

alter table public.challenges
  add constraint challenges_terminal_metadata check (
    (status in ('scheduled', 'active') and terminal_actor_id is null and terminal_at is null and completion_farewell_at is null)
    or (status in ('canceled', 'abandoned', 'completed', 'incomplete')
      and terminal_at is not null)
  );

create or replace function public.enforce_challenge_lifecycle_transition_v1()
returns trigger language plpgsql set search_path = '' as $$
begin
  if OLD.status in ('canceled', 'abandoned', 'completed', 'incomplete') then
    if (OLD.status not in ('completed', 'incomplete') or NEW.status not in ('completed', 'incomplete'))
      and row(NEW.status, NEW.terminal_actor_id, NEW.terminal_at)
      is distinct from row(OLD.status, OLD.terminal_actor_id, OLD.terminal_at) then
      raise exception 'Terminal Challenges cannot be reactivated.' using errcode = '22023';
    end if;
    if OLD.status in ('completed', 'incomplete') and NEW.status in ('completed', 'incomplete')
      and row(NEW.terminal_actor_id, NEW.terminal_at)
      is distinct from row(OLD.terminal_actor_id, OLD.terminal_at) then
      raise exception 'Terminal Challenge attribution is immutable.' using errcode = '22023';
    end if;
    if NEW.completion_farewell_at is distinct from OLD.completion_farewell_at then
      raise exception 'Terminal Challenge farewell metadata is immutable.' using errcode = '22023';
    end if;
  elsif NEW.status = 'canceled' then
    if OLD.status <> 'scheduled' or NEW.terminal_actor_id is null or NEW.terminal_at is null then
      raise exception 'Only a Scheduled Challenge can be canceled.' using errcode = '22023';
    end if;
  elsif NEW.status = 'abandoned' then
    if OLD.status <> 'active' or NEW.terminal_actor_id is null or NEW.terminal_at is null then
      raise exception 'Only an Active Challenge can be abandoned.' using errcode = '22023';
    end if;
  elsif NEW.status = 'active' and OLD.status = 'scheduled'
    and coalesce(NEW.updated_at, statement_timestamp()) < (OLD.start_date::timestamp at time zone OLD.challenge_time_zone) then
    raise exception 'A Challenge cannot become Active before its Start Date.' using errcode = 'P0003';
  end if;
  return NEW;
end;
$$;

create or replace function public.challenge_terminal_totals_json_v1(p_challenge_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'memberId', totals.member_id,
    'creditedTotal', totals.member_total
  ) order by totals.member_id), '[]'::jsonb)
  from public.challenge_member_totals_v1(p_challenge_id) totals;
$$;

create or replace function public.challenge_terminal_outcome_at_v1(
  p_challenge_id uuid,
  p_authoritative_now timestamptz
)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  challenge_row public.challenges;
  deadline_at timestamptz;
  qualifying_totals integer[];
begin
  select * into challenge_row from public.challenges where id = p_challenge_id;
  if not found or challenge_row.status not in ('scheduled', 'active') then return null; end if;
  if (p_authoritative_now at time zone challenge_row.challenge_time_zone)::date < challenge_row.start_date then
    return null;
  end if;
  deadline_at := (challenge_row.deadline_date + 1)::timestamp at time zone challenge_row.challenge_time_zone;
  select array_agg(t.member_total order by t.member_id) into qualifying_totals
  from (
    select member_row.member_id,
      count(solve_row.id)::integer as member_total
    from public.challenge_members member_row
    left join public.solves solve_row
      on solve_row.challenge_id = member_row.challenge_id
     and solve_row.member_id = member_row.member_id
     and solve_row.credit_status = 'credited'
     and solve_row.claimed_at <= p_authoritative_now
     and solve_row.claimed_at < deadline_at
    where member_row.challenge_id = p_challenge_id
    group by member_row.member_id
  ) t;
  if coalesce(array_length(qualifying_totals, 1), 0) <> 2 then return null; end if;
  if qualifying_totals[1] >= 150 and qualifying_totals[2] >= 150 then return 'completed'; end if;
  if p_authoritative_now >= deadline_at then return 'incomplete'; end if;
  return null;
end;
$$;

-- This function is the sole status-and-capacity transition seam. Reads use it
-- as well as commands, so delayed jobs cannot retain capacity or leave a
-- Challenge effectively Active after its hard deadline.
create or replace function public.reconcile_challenge_terminal_v1(
  p_challenge_id uuid,
  p_authoritative_now timestamptz default statement_timestamp(),
  p_terminal_actor_id uuid default null,
  p_allow_farewell boolean default false
)
returns public.challenges language plpgsql security definer set search_path = '' as $$
declare
  challenge_row public.challenges;
  outcome text;
  local_start timestamptz;
begin
  select * into challenge_row from public.challenges where id = p_challenge_id for update;
  if not found then return null; end if;
  local_start := challenge_row.start_date::timestamp at time zone challenge_row.challenge_time_zone;
  if challenge_row.status = 'scheduled' and p_authoritative_now >= local_start then
    update public.challenges set status = 'active', updated_at = p_authoritative_now where id = p_challenge_id;
    select * into challenge_row from public.challenges where id = p_challenge_id for update;
  end if;
  if challenge_row.status <> 'active' then return challenge_row; end if;

  outcome := public.challenge_terminal_outcome_at_v1(p_challenge_id, p_authoritative_now);
  if outcome is null then return challenge_row; end if;
  update public.challenges
     set status = outcome,
         terminal_actor_id = case when outcome = 'completed' then p_terminal_actor_id else null end,
         terminal_at = p_authoritative_now,
         completion_farewell_at = case
           when outcome = 'completed' and p_allow_farewell then coalesce(completion_farewell_at, p_authoritative_now)
           else completion_farewell_at
         end,
         highest_evolution_stage = case when outcome = 'completed' then 4 else highest_evolution_stage end,
         updated_at = p_authoritative_now
   where id = p_challenge_id;
  delete from public.member_commitments where challenge_id = p_challenge_id;
  select * into challenge_row from public.challenges where id = p_challenge_id;
  return challenge_row;
end;
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
    'status', challenge_row.status,
    'createdAt', challenge_row.created_at,
    'terminalActorId', challenge_row.terminal_actor_id,
    'terminalAt', challenge_row.terminal_at,
    'completionFarewellAt', challenge_row.completion_farewell_at,
    'viewerMemberId', (select auth.uid()),
    'members', coalesce((
      select jsonb_agg(public.challenge_member_json_v1(member_row) order by member_row.member_id)
      from public.challenge_members member_row
      where member_row.challenge_id = challenge_row.id
    ), '[]'::jsonb),
    'finalTotals', case when challenge_row.status in ('canceled', 'abandoned', 'completed', 'incomplete')
      then public.challenge_terminal_totals_json_v1(challenge_row.id) else null end,
    'progress', case
      when challenge_row.status = 'active'
      then public.challenge_progress_json_v1(challenge_row)
      else null
    end,
    'solveHistory', public.solve_history_json_v1(challenge_row.id)
  ) - case when challenge_row.status = 'active'
      then array['finalTotals']::text[]
      else array['progress']::text[] end;
$$;


-- Active abandonment has the same durable idempotency boundary as scheduled
-- cancellation, but its start-boundary check deliberately wins over a stale
-- client projection.
create or replace function public.abandon_challenge_v1(
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
  authoritative_now timestamptz := statement_timestamp();
begin
  if current_member is null or p_member_id is distinct from current_member then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_command_version is distinct from 1 or p_command_kind is distinct from 'abandon_challenge' then
    raise exception 'The command version is no longer current.' using errcode = '22023';
  end if;
  select lower(email) into verified_email from auth.users
   where id = current_member and email is not null and email_confirmed_at is not null;
  if verified_email is null or lower(btrim(coalesce(p_member_email, ''))) is distinct from verified_email then
    raise exception 'A verified email is required.' using errcode = '42501';
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
  select * into challenge_row from public.challenges where id = p_challenge_id for update;
  if not found then raise exception 'The Challenge is no longer available.' using errcode = 'P0003'; end if;
  if not exists (
    select 1 from public.challenge_members member_row
     where member_row.challenge_id = challenge_row.id
       and member_row.member_id = current_member
       and lower(member_row.member_email) = verified_email
  ) then raise exception 'Only a Challenge Member can abandon this Challenge.' using errcode = '42501'; end if;
  challenge_row := public.reconcile_challenge_terminal_v1(challenge_row.id, authoritative_now, null, false);
  if challenge_row.status <> 'active' then
    raise exception 'The Challenge is no longer Active.' using errcode = 'P0003';
  end if;
  insert into public.member_command_idempotency(
    member_id, idempotency_key, command_version, command_kind, member_email, intent
  ) values (
    current_member, p_idempotency_key, 1, 'abandon_challenge', verified_email,
    jsonb_build_object('challengeId', p_challenge_id)
  ) on conflict (member_id, idempotency_key) do nothing returning true into claimed;
  if not coalesce(claimed, false) then
    select result into command_result from public.member_command_idempotency
     where member_id = current_member and idempotency_key = p_idempotency_key;
    if command_result is not null then return command_result; end if;
  end if;
  update public.challenges
     set status = 'abandoned', terminal_actor_id = current_member, terminal_at = authoritative_now,
         updated_at = authoritative_now
   where id = challenge_row.id;
  delete from public.member_commitments where challenge_id = challenge_row.id;
  select * into challenge_row from public.challenges where id = challenge_row.id;
  command_result := public.challenge_json_v1(challenge_row);
  update public.member_command_idempotency set result = command_result
   where member_id = current_member and idempotency_key = p_idempotency_key;
  return command_result;
end;
$$;

-- Controlled-time command seam used by two-profile boundary acceptance tests.
create or replace function public.abandon_challenge_at_v1(
  p_idempotency_key uuid,
  p_command_version integer,
  p_command_kind text,
  p_member_id uuid,
  p_member_email text,
  p_challenge_id uuid,
  p_authoritative_now timestamptz
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_member uuid := null;
  verified_email text;
  challenge_row public.challenges;
  command_result jsonb;
  claimed boolean := false;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'This controlled-time seam is restricted to the service role.' using errcode = '42501';
  end if;
  current_member := p_member_id;
  if p_command_version is distinct from 1 or p_command_kind is distinct from 'abandon_challenge' then
    raise exception 'The command version is no longer current.' using errcode = '22023';
  end if;
  select lower(email) into verified_email from auth.users
   where id = current_member and email_confirmed_at is not null;
  if verified_email is null or lower(btrim(coalesce(p_member_email, ''))) is distinct from verified_email then
    raise exception 'A verified email is required.' using errcode = '42501';
  end if;
  select * into challenge_row from public.challenges where id = p_challenge_id for update;
  if not found then raise exception 'The Challenge is no longer available.' using errcode = 'P0003'; end if;
  if not exists (
    select 1 from public.challenge_members
     where challenge_id = challenge_row.id and member_id = current_member and lower(member_email) = verified_email
  ) then raise exception 'Only a Challenge Member can abandon this Challenge.' using errcode = '42501'; end if;
  challenge_row := public.reconcile_challenge_terminal_v1(challenge_row.id, p_authoritative_now, null, false);
  if challenge_row.status <> 'active' then raise exception 'The Challenge is no longer Active.' using errcode = 'P0003'; end if;
  insert into public.member_command_idempotency(member_id, idempotency_key, command_version, command_kind, member_email, intent)
  values (current_member, p_idempotency_key, 1, 'abandon_challenge', verified_email, jsonb_build_object('challengeId', p_challenge_id))
  on conflict (member_id, idempotency_key) do nothing returning true into claimed;
  if not coalesce(claimed, false) then
    select result into command_result from public.member_command_idempotency
     where member_id = current_member and idempotency_key = p_idempotency_key;
    if command_result is not null then return command_result; end if;
  end if;
  update public.challenges set status = 'abandoned', terminal_actor_id = current_member, terminal_at = p_authoritative_now, updated_at = p_authoritative_now where id = challenge_row.id;
  delete from public.member_commitments where challenge_id = challenge_row.id;
  select * into challenge_row from public.challenges where id = challenge_row.id;
  command_result := public.challenge_json_v1(challenge_row);
  update public.member_command_idempotency set result = command_result where member_id = current_member and idempotency_key = p_idempotency_key;
  return command_result;
end;
$$;

-- A Solve insert is the immediate success seam; this trigger is backend-owned
-- so scheduled-job timing cannot delay completion.
create or replace function public.reconcile_solve_challenge_terminal_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.reconcile_challenge_terminal_v1(NEW.challenge_id, NEW.claimed_at, NEW.member_id, true);
  return NEW;
end;
$$;

drop trigger if exists solves_reconcile_challenge_terminal on public.solves;
create trigger solves_reconcile_challenge_terminal
after insert on public.solves
for each row execute function public.reconcile_solve_challenge_terminal_v1();

-- Corrections can change Success versus Incomplete, but never recreate the
-- Pet, commitments, or completion farewell.
create or replace function public.recompute_terminal_outcome_after_correction_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  challenge_row public.challenges;
  outcome text;
  qualifying_totals integer[];
  deadline_at timestamptz;
begin
  select * into challenge_row from public.challenges where id = NEW.challenge_id for update;
  if not found or challenge_row.status not in ('completed', 'incomplete') then return NEW; end if;
  deadline_at := (challenge_row.deadline_date + 1)::timestamp at time zone challenge_row.challenge_time_zone;
  select array_agg(t.member_total order by t.member_id) into qualifying_totals
  from (
    select member_row.member_id, count(solve_row.id)::integer member_total
    from public.challenge_members member_row
    left join public.solves solve_row on solve_row.challenge_id = member_row.challenge_id and solve_row.member_id = member_row.member_id
      and solve_row.credit_status = 'credited' and solve_row.claimed_at < deadline_at
    where member_row.challenge_id = NEW.challenge_id
    group by member_row.member_id
  ) t;
  if coalesce(array_length(qualifying_totals, 1), 0) = 2
    and qualifying_totals[1] >= 150 and qualifying_totals[2] >= 150 then outcome := 'completed';
  else outcome := 'incomplete'; end if;
  if outcome is distinct from challenge_row.status then
    update public.challenges set status = outcome, updated_at = statement_timestamp() where id = NEW.challenge_id;
  end if;
  return NEW;
end;
$$;

drop trigger if exists solves_recompute_terminal_after_correction on public.solves;
create trigger solves_recompute_terminal_after_correction
after update of credit_status on public.solves
for each row when (OLD.credit_status is distinct from NEW.credit_status)
execute function public.recompute_terminal_outcome_after_correction_v1();


-- Controlled-time reads transition the same authoritative row before they
-- construct the Snapshot. Terminal corrections therefore remain visible while
-- membership and capacity stay closed.
create or replace function public.get_challenge_at_v1(
  p_challenge_id uuid,
  p_authoritative_now timestamptz
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_member uuid := (select auth.uid());
  challenge_row public.challenges;
  effective_status text;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'This controlled-time seam is restricted to the service role.' using errcode = '42501';
  end if;
  select * into challenge_row
    from public.challenges challenge_item
   where challenge_item.id = p_challenge_id;
  if not found then return null; end if;
  challenge_row := public.reconcile_challenge_terminal_v1(challenge_row.id, p_authoritative_now, null, true);
  select * into challenge_row from public.challenges where id = p_challenge_id;
  effective_status := public.challenge_effective_status_at_v1(
    challenge_row.status, challenge_row.start_date, challenge_row.challenge_time_zone, p_authoritative_now
  );
  return public.challenge_json_v1(challenge_row)
    || jsonb_build_object(
      'status', effective_status,
      'progress', case when effective_status = 'active'
        then public.challenge_progress_json_v1(challenge_row, p_authoritative_now) else null end
    )
    - case when effective_status = 'active'
      then array['finalTotals']::text[] else array['progress']::text[] end;
end;
$$;

create or replace function public.get_challenge_v1(p_challenge_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  challenge_row public.challenges;
begin
  select * into challenge_row
    from public.challenges
   where id = p_challenge_id
     and exists (
       select 1 from public.challenge_members
        where challenge_id = p_challenge_id and member_id = (select auth.uid())
     );
  if not found then return null; end if;
  challenge_row := public.reconcile_challenge_terminal_v1(challenge_row.id, statement_timestamp(), null, true);
  return public.challenge_json_v1(challenge_row);
end;
$$;

create or replace function public.get_committed_challenge_for_member_v1()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  challenge_id uuid;
  challenge_row public.challenges;
begin
  select commitment.challenge_id into challenge_id
    from public.member_commitments commitment
   where commitment.member_id = (select auth.uid())
   limit 1;
  if challenge_id is null then return null; end if;
  challenge_row := public.reconcile_challenge_terminal_v1(challenge_id, statement_timestamp(), null, true);
  if challenge_row.status not in ('scheduled', 'active') then return null; end if;
  return public.challenge_json_v1(challenge_row);
end;
$$;

create or replace function public.get_latest_terminal_challenge_for_member_v1()
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.challenge_json_v1(challenge_row)
    from public.challenges challenge_row
   where challenge_row.status in ('canceled', 'abandoned', 'completed', 'incomplete')
     and exists (
       select 1 from public.challenge_members member_row
        where member_row.challenge_id = challenge_row.id and member_row.member_id = (select auth.uid())
     )
   order by challenge_row.terminal_at desc nulls last
   limit 1;
$$;

-- Compatibility name retained for clients from ticket 26; its result now
-- includes all terminal Challenge kinds.
create or replace function public.get_latest_canceled_challenge_for_member_v1()
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.get_latest_terminal_challenge_for_member_v1();
$$;

revoke all on function public.challenge_terminal_totals_json_v1(uuid) from public;
revoke all on function public.challenge_terminal_outcome_at_v1(uuid, timestamptz) from public;
revoke all on function public.reconcile_challenge_terminal_v1(uuid, timestamptz, uuid, boolean) from public;
revoke all on function public.abandon_challenge_v1(uuid, integer, text, uuid, text, uuid) from public;
revoke all on function public.abandon_challenge_at_v1(uuid, integer, text, uuid, text, uuid, timestamptz) from public;
revoke all on function public.get_challenge_at_v1(uuid, timestamptz) from public;
revoke all on function public.get_challenge_v1(uuid) from public;
revoke all on function public.get_committed_challenge_for_member_v1() from public;
revoke all on function public.get_latest_terminal_challenge_for_member_v1() from public;
revoke all on function public.get_latest_canceled_challenge_for_member_v1() from public;
grant execute on function public.abandon_challenge_v1(uuid, integer, text, uuid, text, uuid) to authenticated;
grant execute on function public.abandon_challenge_at_v1(uuid, integer, text, uuid, text, uuid, timestamptz) to service_role;
grant execute on function public.get_challenge_at_v1(uuid, timestamptz) to service_role;
grant execute on function public.get_challenge_v1(uuid) to authenticated;
grant execute on function public.get_committed_challenge_for_member_v1() to authenticated;
grant execute on function public.get_latest_terminal_challenge_for_member_v1() to authenticated;
grant execute on function public.get_latest_canceled_challenge_for_member_v1() to authenticated;

create or replace function public.foundation_health_v1()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('service', 'larp-code', 'schemaVersion', 9, 'serverTime', statement_timestamp());
$$;
revoke all on function public.foundation_health_v1() from public;
grant execute on function public.foundation_health_v1() to anon, authenticated;


-- Rebind Solve creation to the same terminal reconciliation seam so a late
-- Solve both fails and releases capacity in one authoritative transaction.
create or replace function public.create_solve_v1(
  p_idempotency_key uuid,
  p_command_version integer,
  p_command_kind text,
  p_member_id uuid,
  p_member_email text,
  p_challenge_id uuid,
  p_problem_id text,
  p_affirmed boolean default false
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_member uuid := (select auth.uid());
  verified_email text;
  challenge_row public.challenges;
  solve_row public.solves;
  command_result jsonb;
  existing_kind text;
  existing_version integer;
  claimed boolean := false;
  authoritative_now timestamptz;
  local_date date;
  pair_progress numeric;
  attained_stage integer;
begin
  if current_member is null or p_member_id is distinct from current_member then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_command_version is distinct from 1 or p_command_kind is distinct from 'create_solve' then
    raise exception 'The command version is no longer current.' using errcode = '22023';
  end if;
  if p_affirmed is distinct from true then
    raise exception 'Explicit self-attestation is required to credit this Solve.' using errcode = '22023';
  end if;
  select lower(email) into verified_email from auth.users
   where id = current_member and email is not null and email_confirmed_at is not null;
  if verified_email is null or lower(btrim(coalesce(p_member_email, ''))) is distinct from verified_email then
    raise exception 'A verified email is required.' using errcode = '42501';
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
  select * into challenge_row from public.challenges where id = p_challenge_id for update;
  if not found then raise exception 'The Challenge is no longer available.' using errcode = 'P0003'; end if;
  if not exists (
    select 1 from public.challenge_members member_row
     where member_row.challenge_id = challenge_row.id
       and member_row.member_id = current_member
       and lower(member_row.member_email) = verified_email
  ) then raise exception 'Only a Challenge Member can credit a Solve.' using errcode = '42501'; end if;
  authoritative_now := statement_timestamp();
  challenge_row := public.reconcile_challenge_terminal_v1(challenge_row.id, authoritative_now, null, true);
  local_date := authoritative_now at time zone challenge_row.challenge_time_zone;
  if public.challenge_effective_status_at_v1(
    challenge_row.status, challenge_row.start_date, challenge_row.challenge_time_zone, authoritative_now
  ) <> 'active' then
    raise exception 'Solves can only be credited during an Active Challenge.' using errcode = 'P0003';
  end if;
  if local_date < challenge_row.start_date then
    raise exception 'The Challenge has not started; no Solve can be credited yet.' using errcode = 'P0003';
  end if;
  if local_date >= (challenge_row.deadline_date + 1) then
    raise exception 'The Challenge deadline has passed; no new Solves can be credited.' using errcode = 'P0003';
  end if;
  if not exists (
    select 1 from public.problem_set_version_problems item
     where item.problem_set_version_id = challenge_row.problem_set_version_id
       and item.problem_id = p_problem_id
  ) then
    raise exception 'Select a Problem from the pinned Problem Set Version.' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.solves existing_solve
     where existing_solve.challenge_id = challenge_row.id
       and existing_solve.member_id = current_member
       and existing_solve.problem_id = p_problem_id
  ) then
    raise exception 'The Problem is already credited for this Challenge Member.' using errcode = 'P0003';
  end if;
  insert into public.member_command_idempotency(
    member_id, idempotency_key, command_version, command_kind, member_email, intent
  ) values (
    current_member, p_idempotency_key, 1, 'create_solve', verified_email,
    jsonb_build_object('challengeId', p_challenge_id, 'problemId', p_problem_id, 'affirmed', true)
  ) on conflict (member_id, idempotency_key) do nothing returning true into claimed;
  if not coalesce(claimed, false) then
    select result into command_result from public.member_command_idempotency
     where member_id = current_member and idempotency_key = p_idempotency_key;
    if command_result is not null then return command_result; end if;
  end if;
  insert into public.solves(member_id, challenge_id, problem_id, claimed_at)
    values (current_member, challenge_row.id, p_problem_id, authoritative_now)
    returning * into solve_row;
  select coalesce(sum(totals.member_total), 0) / 2.0 into pair_progress
    from public.challenge_member_totals_v1(challenge_row.id) totals;
  attained_stage := case when pair_progress >= 150 then 4 when pair_progress >= 100 then 3 when pair_progress >= 50 then 2 else 1 end;
  update public.challenges
     set highest_evolution_stage = greatest(highest_evolution_stage, attained_stage), updated_at = authoritative_now
   where id = challenge_row.id;
  command_result := public.solve_json_v1(solve_row);
  update public.member_command_idempotency set result = command_result
   where member_id = current_member and idempotency_key = p_idempotency_key;
  return command_result;
exception
  when unique_violation then
    raise exception 'The Problem is already credited for this Challenge Member.' using errcode = 'P0003';
end;
$$;
