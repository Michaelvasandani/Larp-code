-- Ticket 27: self-attested Challenge Solves and authoritative Active state.
-- The Solve identity is stable across retries and is unique per Member,
-- Challenge, and pinned Problem. Progress/Pet values are derived on reads.

alter table public.challenges
  add column highest_evolution_stage integer not null default 1
    check (highest_evolution_stage between 1 and 4);

create table public.solves (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references auth.users(id),
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  problem_id text not null references public.problems(id),
  claimed_at timestamptz not null default clock_timestamp(),
  credit_status text not null default 'credited' check (credit_status = 'credited'),
  unique (member_id, challenge_id, problem_id)
);

create index solves_challenge_member on public.solves (challenge_id, member_id);
alter table public.solves enable row level security;
revoke all on table public.solves from anon, authenticated;
grant select, insert on table public.solves to service_role;

-- Realtime authorization is scoped to the two Challenge Members. Domain reads
-- still use the versioned functions; these grants/policies only make the
-- publication's invalidation signal RLS-authorized.
create policy challenge_members_realtime_read
on public.challenge_members for select to authenticated
using (member_id = (select auth.uid()));
create policy challenges_member_realtime_read
on public.challenges for select to authenticated
using (exists (
  select 1 from public.challenge_members member_row
   where member_row.challenge_id = challenges.id
     and member_row.member_id = (select auth.uid())
));
create policy solves_member_realtime_read
on public.solves for select to authenticated
using (exists (
  select 1 from public.challenge_members member_row
   where member_row.challenge_id = solves.challenge_id
     and member_row.member_id = (select auth.uid())
));
grant select on table public.challenge_members, public.challenges, public.solves to authenticated;

create or replace function public.solve_json_v1(solve_row public.solves)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', solve_row.id,
    'memberId', solve_row.member_id,
    'challengeId', solve_row.challenge_id,
    'problemId', solve_row.problem_id,
    'claimedAt', solve_row.claimed_at,
    'creditStatus', solve_row.credit_status
  );
$$;

create or replace function public.challenge_progress_json_v1(challenge_row public.challenges)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare
  local_date date := (clock_timestamp() at time zone challenge_row.challenge_time_zone)::date;
  duration_days integer := challenge_row.deadline_date - challenge_row.start_date + 1;
  day_number integer;
  current_target integer;
  previous_target integer;
  earlier_target integer;
  pair_progress numeric;
  pet_condition text;
  current_stage integer;
  member_rows jsonb;
begin
  if local_date < challenge_row.start_date then
    day_number := 0;
  elsif local_date > challenge_row.deadline_date then
    day_number := duration_days + 1;
  else
    day_number := local_date - challenge_row.start_date + 1;
  end if;
  current_target := case
    when day_number <= 0 then 0
    when day_number > duration_days then 150
    else ceil(150.0 * day_number / duration_days)::integer
  end;
  previous_target := case
    when day_number <= 1 then 0
    else ceil(150.0 * least(duration_days, day_number - 1) / duration_days)::integer
  end;
  earlier_target := case
    when day_number <= 2 then 0
    else ceil(150.0 * least(duration_days, day_number - 2) / duration_days)::integer
  end;
  -- Keep the calculation in one function so clients cannot treat event
  -- payloads or a partial member query as authoritative.
  select coalesce(sum(member_total), 0) / 2.0 into pair_progress
    from (
      select member_row.member_id, count(solve_row.id)::numeric as member_total
        from public.challenge_members member_row
        left join public.solves solve_row
          on solve_row.challenge_id = challenge_row.id
         and solve_row.member_id = member_row.member_id
         and solve_row.credit_status = 'credited'
       where member_row.challenge_id = challenge_row.id
       group by member_row.member_id
    ) totals;
  pet_condition := case
    when pair_progress >= current_target then 'healthy'
    when pair_progress >= previous_target then 'hungry'
    when pair_progress >= earlier_target then 'sad'
    else 'deteriorated'
  end;
  current_stage := case
    when pair_progress >= 150 then 4
    when pair_progress >= 100 then 3
    when pair_progress >= 50 then 2
    else 1
  end;
  member_rows := coalesce((
    select jsonb_agg(jsonb_build_object(
      'memberId', totals.member_id,
      'email', totals.email,
      'displayName', totals.display_name,
      'authority', 'equal',
      'creditedTotal', totals.member_total,
      'paceStatus', case
        when totals.member_total < previous_target then 'behind'
        when totals.member_total < current_target then 'on_pace_today'
        else 'todays_pace_met'
      end,
      'paceGap', jsonb_build_object(
        'previousTarget', previous_target,
        'currentTarget', current_target,
        'gapToPreviousTarget', greatest(0, previous_target - totals.member_total),
        'amountNeededToday', greatest(0, current_target - totals.member_total),
        'amountAhead', greatest(0, totals.member_total - current_target),
        'copy', case
          when totals.member_total < previous_target then
            'Behind by ' || (previous_target - totals.member_total) || ' to the prior target; '
              || greatest(0, current_target - totals.member_total) || ' more needed for today''s target.'
          when totals.member_total < current_target then
            (current_target - totals.member_total) || ' more needed for today''s target.'
          when totals.member_total > current_target then
            'Today''s pace met; ' || (totals.member_total - current_target) || ' ahead of the target.'
          else 'Today''s pace met.'
        end
      )
    ) order by totals.member_id)
    from (
      select member_row.member_id, member_row.member_email as email,
        member_row.display_name,
        count(solve_row.id)::integer as member_total
        from public.challenge_members member_row
        left join public.solves solve_row
          on solve_row.challenge_id = challenge_row.id
         and solve_row.member_id = member_row.member_id
         and solve_row.credit_status = 'credited'
       where member_row.challenge_id = challenge_row.id
       group by member_row.member_id, member_row.member_email, member_row.display_name
    ) totals
  ), '[]'::jsonb);
  return jsonb_build_object(
    'problemSetVersionId', challenge_row.problem_set_version_id,
    'day', day_number,
    'durationDays', duration_days,
    'expectedProgress', current_target,
    'previousExpectedProgress', previous_target,
    'earlierExpectedProgress', earlier_target,
    'pairProgress', pair_progress,
    'petCondition', pet_condition,
    'currentEvolutionStage', current_stage,
    'highestEvolutionStage', greatest(challenge_row.highest_evolution_stage, current_stage),
    'members', member_rows
  );
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
    'status', public.challenge_effective_status_v1(challenge_row),
    'createdAt', challenge_row.created_at,
    'terminalActorId', challenge_row.terminal_actor_id,
    'terminalAt', challenge_row.terminal_at,
    'members', coalesce((
      select jsonb_agg(public.challenge_member_json_v1(member_row) order by member_row.member_id)
      from public.challenge_members member_row
      where member_row.challenge_id = challenge_row.id
    ), '[]'::jsonb),
    'progress', case
      when public.challenge_effective_status_v1(challenge_row) = 'active'
      then public.challenge_progress_json_v1(challenge_row)
      else null
    end
  ) - case when public.challenge_effective_status_v1(challenge_row) = 'active' then array[]::text[] else array['progress'] end;
$$;

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
   where member_id = current_member and idempotency_key = p_idempotency_key
   for update;
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
  ) then
    raise exception 'Only a Challenge Member can credit a Solve.' using errcode = '42501';
  end if;
  authoritative_now := clock_timestamp();
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
  select coalesce(sum(member_total), 0) / 2.0 into pair_progress
    from (
      select member_row.member_id, count(solve_item.id)::numeric as member_total
        from public.challenge_members member_row
        left join public.solves solve_item
          on solve_item.challenge_id = challenge_row.id
         and solve_item.member_id = member_row.member_id
         and solve_item.credit_status = 'credited'
       where member_row.challenge_id = challenge_row.id
       group by member_row.member_id
    ) totals;
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

revoke all on function public.solve_json_v1(public.solves) from public;
revoke all on function public.challenge_progress_json_v1(public.challenges) from public;
revoke all on function public.create_solve_v1(uuid, integer, text, uuid, text, uuid, text, boolean) from public;
grant execute on function public.create_solve_v1(uuid, integer, text, uuid, text, uuid, text, boolean) to authenticated;

-- Relevant changes are invalidation signals only; the worker always refetches
-- the complete Active Snapshot after a debounced event.
alter publication supabase_realtime add table public.challenges;
alter publication supabase_realtime add table public.solves;

create or replace function public.foundation_health_v1()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('service', 'larp-code', 'schemaVersion', 7, 'serverTime', clock_timestamp());
$$;
revoke all on function public.foundation_health_v1() from public;
grant execute on function public.foundation_health_v1() to anon, authenticated;
