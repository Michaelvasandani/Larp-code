-- Ticket 28: append-only self-corrections and shared Solve history.
-- A correction changes only the current credit state. The original Solve and
-- every correction remain readable to both Challenge Members.

alter table public.solves
  drop constraint solves_credit_status_check;

alter table public.solves
  add constraint solves_credit_status_check
  check (credit_status in ('credited', 'not_credited'));

alter table public.solves
  add column original_credit_status text not null default 'credited'
  check (original_credit_status = 'credited');

create or replace function public.reject_solve_original_update_v1()
returns trigger language plpgsql set search_path = '' as $$
begin
  if NEW.original_credit_status is distinct from OLD.original_credit_status then
    raise exception 'Original Solve credit status is immutable.' using errcode = '22023';
  end if;
  return NEW;
end;
$$;

create trigger solves_original_credit_immutable
before update on public.solves
for each row execute function public.reject_solve_original_update_v1();

create table public.solve_corrections (
  id uuid primary key default gen_random_uuid(),
  solve_id uuid not null references public.solves(id) on delete restrict,
  challenge_id uuid not null references public.challenges(id) on delete restrict,
  actor_id uuid not null references auth.users(id),
  corrected_at timestamptz not null default clock_timestamp(),
  sequence integer not null check (sequence >= 1),
  category text not null check (category in ('retracted', 'reclassified', 'restored')),
  reason text not null check (char_length(btrim(reason)) between 1 and 500),
  resulting_credit_status text not null check (resulting_credit_status in ('credited', 'not_credited')),
  unique (solve_id, sequence)
);

create index solve_corrections_challenge_order
  on public.solve_corrections (challenge_id, corrected_at, id);

alter table public.solve_corrections enable row level security;
revoke all on table public.solve_corrections from anon, authenticated;
grant select, insert on table public.solve_corrections to service_role;

create or replace function public.solve_json_v1(solve_row public.solves)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', solve_row.id,
    'memberId', solve_row.member_id,
    'challengeId', solve_row.challenge_id,
    'problemId', solve_row.problem_id,
    'claimedAt', solve_row.claimed_at,
    'originalCreditStatus', solve_row.original_credit_status,
    'creditStatus', solve_row.credit_status
  );
$$;

create or replace function public.solve_correction_json_v1(correction_row public.solve_corrections)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', correction_row.id,
    'solveId', correction_row.solve_id,
    'challengeId', correction_row.challenge_id,
    'actorId', correction_row.actor_id,
    'correctedAt', correction_row.corrected_at,
    'category', correction_row.category,
    'reason', correction_row.reason,
    'resultingCreditStatus', correction_row.resulting_credit_status,
    'sequence', correction_row.sequence
  );
$$;

create or replace function public.solve_history_json_v1(p_challenge_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(
    public.solve_json_v1(solve_row) || jsonb_build_object(
      'canCorrect', solve_row.member_id = (select auth.uid()),
      'corrections', coalesce((
        select jsonb_agg(public.solve_correction_json_v1(correction_row) order by correction_row.sequence)
        from public.solve_corrections correction_row
        where correction_row.solve_id = solve_row.id
      ), '[]'::jsonb)
    )
    order by solve_row.claimed_at, solve_row.id
  ), '[]'::jsonb)
  from public.solves solve_row
  where solve_row.challenge_id = p_challenge_id;
$$;

-- The Challenge JSON remains the one authoritative read. History is nested on
-- the Challenge so a Snapshot cannot accidentally combine a fresh progress
-- read with a stale or partial audit read.
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
    end,
    'solveHistory', public.solve_history_json_v1(challenge_row.id)
  ) - case when public.challenge_effective_status_v1(challenge_row) = 'active' then array[]::text[] else array['progress'] end;
$$;

create or replace function public.correct_solve_v1(
  p_idempotency_key uuid,
  p_command_version integer,
  p_command_kind text,
  p_member_id uuid,
  p_member_email text,
  p_challenge_id uuid,
  p_solve_id uuid,
  p_category text,
  p_reason text,
  p_resulting_credit_status text default 'not_credited'
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_member uuid := (select auth.uid());
  verified_email text;
  challenge_row public.challenges;
  solve_row public.solves;
  correction_row public.solve_corrections;
  command_result jsonb;
  existing_kind text;
  existing_version integer;
  claimed boolean := false;
  authoritative_now timestamptz;
  next_sequence integer;
  pair_progress numeric;
  attained_stage integer;
  clean_category text := btrim(coalesce(p_category, ''));
  clean_reason text := btrim(coalesce(p_reason, ''));
begin
  if current_member is null or p_member_id is distinct from current_member then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_command_version is distinct from 1 or p_command_kind is distinct from 'correct_solve' then
    raise exception 'The command version is no longer current.' using errcode = '22023';
  end if;
  select lower(email) into verified_email
    from auth.users
   where id = current_member and email is not null and email_confirmed_at is not null;
  if verified_email is null or lower(btrim(coalesce(p_member_email, ''))) is distinct from verified_email then
    raise exception 'A verified email is required.' using errcode = '42501';
  end if;
  if clean_category not in ('retracted', 'reclassified', 'restored')
    or clean_reason = '' or char_length(clean_reason) > 500 then
    raise exception 'A correction category and reason are required.' using errcode = '22023';
  end if;
  if p_resulting_credit_status not in ('credited', 'not_credited') then
    raise exception 'The resulting credit state is invalid.' using errcode = '22023';
  end if;

  -- A completed idempotency result wins before current Solve state is read.
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

  -- Lock in the same Challenge-first order as Solve creation. This serializes
  -- corrections on one Challenge and makes both sequence numbering and the
  -- persisted evolution high-water mark race-free.
  select * into challenge_row
    from public.challenges
   where id = p_challenge_id
   for update;
  if not found then
    raise exception 'The Challenge is no longer available.' using errcode = 'P0003';
  end if;
  if not exists (
    select 1 from public.challenge_members member_row
     where member_row.challenge_id = challenge_row.id
       and member_row.member_id = current_member
       and lower(member_row.member_email) = verified_email
  ) then
    raise exception 'Only a Challenge Member can correct a Solve.' using errcode = '42501';
  end if;

  select * into solve_row
    from public.solves
   where id = p_solve_id and challenge_id = challenge_row.id
   for update;
  if not found then
    raise exception 'The Solve is no longer available.' using errcode = 'P0003';
  end if;
  if solve_row.member_id is distinct from current_member then
    raise exception 'A Member can correct only their own Solve.' using errcode = '42501';
  end if;

  authoritative_now := clock_timestamp();
  select coalesce(max(sequence), 0) + 1 into next_sequence
    from public.solve_corrections
   where solve_id = solve_row.id;
  insert into public.member_command_idempotency(
    member_id, idempotency_key, command_version, command_kind, member_email, intent
  ) values (
    current_member, p_idempotency_key, 1, 'correct_solve', verified_email,
    jsonb_build_object(
      'challengeId', p_challenge_id,
      'solveId', p_solve_id,
      'category', clean_category,
      'reason', clean_reason,
      'resultingCreditStatus', p_resulting_credit_status
    )
  ) on conflict (member_id, idempotency_key) do nothing returning true into claimed;
  if not coalesce(claimed, false) then
    select result into command_result
      from public.member_command_idempotency
     where member_id = current_member and idempotency_key = p_idempotency_key;
    if command_result is not null then return command_result; end if;
  end if;

  insert into public.solve_corrections(
    solve_id, challenge_id, actor_id, corrected_at, sequence,
    category, reason, resulting_credit_status
  ) values (
    solve_row.id, challenge_row.id, current_member, authoritative_now, next_sequence,
    clean_category, clean_reason, p_resulting_credit_status
  ) returning * into correction_row;

  update public.solves
     set credit_status = p_resulting_credit_status
   where id = solve_row.id;

  select coalesce(sum(totals.member_total), 0) / 2.0 into pair_progress
    from public.challenge_member_totals_v1(challenge_row.id) totals;
  attained_stage := case
    when pair_progress >= 150 then 4
    when pair_progress >= 100 then 3
    when pair_progress >= 50 then 2
    else 1
  end;
  update public.challenges
     set highest_evolution_stage = greatest(highest_evolution_stage, attained_stage), updated_at = authoritative_now
   where id = challenge_row.id;

  command_result := public.solve_correction_json_v1(correction_row);
  update public.member_command_idempotency
     set result = command_result
   where member_id = current_member and idempotency_key = p_idempotency_key;
  return command_result;
end;
$$;

-- Compatibility entry point for clients that name the command after the
-- aggregate it creates. It delegates to the canonical correct_solve_v1 path.
create or replace function public.create_solve_correction_v1(
  p_idempotency_key uuid,
  p_command_version integer,
  p_command_kind text,
  p_member_id uuid,
  p_member_email text,
  p_challenge_id uuid,
  p_solve_id uuid,
  p_category text,
  p_reason text,
  p_resulting_credit_status text default 'not_credited'
)
returns jsonb language sql security definer set search_path = '' as $$
  select public.correct_solve_v1(
    p_idempotency_key, p_command_version, p_command_kind, p_member_id, p_member_email,
    p_challenge_id, p_solve_id, p_category, p_reason, p_resulting_credit_status
  );
$$;

create or replace function public.get_solve_history_v1(p_challenge_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.challenge_members
     where challenge_id = p_challenge_id and member_id = (select auth.uid())
  ) then
    raise exception 'The Challenge is no longer available.' using errcode = '42501';
  end if;
  return public.solve_history_json_v1(p_challenge_id);
end;
$$;

-- Compatibility read alias retained for clients that use the Challenge-first
-- vocabulary; authorization and ordering remain in the canonical function.
create or replace function public.get_challenge_solve_history_v1(p_challenge_id uuid)
returns jsonb language sql security definer set search_path = '' as $$
  select public.get_solve_history_v1(p_challenge_id);
$$;

revoke all on function public.solve_correction_json_v1(public.solve_corrections) from public;
revoke all on function public.solve_history_json_v1(uuid) from public;
revoke all on function public.correct_solve_v1(uuid, integer, text, uuid, text, uuid, uuid, text, text, text) from public;
revoke all on function public.create_solve_correction_v1(uuid, integer, text, uuid, text, uuid, uuid, text, text, text) from public;
revoke all on function public.get_solve_history_v1(uuid) from public;
revoke all on function public.get_challenge_solve_history_v1(uuid) from public;
grant execute on function public.correct_solve_v1(uuid, integer, text, uuid, text, uuid, uuid, text, text, text) to authenticated;
grant execute on function public.create_solve_correction_v1(uuid, integer, text, uuid, text, uuid, uuid, text, text, text) to authenticated;
grant execute on function public.get_solve_history_v1(uuid) to authenticated;
grant execute on function public.get_challenge_solve_history_v1(uuid) to authenticated;

alter publication supabase_realtime add table public.solve_corrections;

create or replace function public.foundation_health_v1()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('service', 'larp-code', 'schemaVersion', 8, 'serverTime', clock_timestamp());
$$;
revoke all on function public.foundation_health_v1() from public;
grant execute on function public.foundation_health_v1() to anon, authenticated;
