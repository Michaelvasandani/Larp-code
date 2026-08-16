-- Ticket 34: technical-abuse enforcement and privacy-safe diagnostic support.
-- Operator actions are a security boundary, never a social moderation surface.

alter table public.member_accounts
  drop constraint if exists member_accounts_status_check,
  add column if not exists suspended_at timestamptz,
  add column if not exists suspension_reason text;

alter table public.member_accounts
  add constraint member_accounts_status_check check (status in ('active', 'suspended'));

alter table public.member_accounts
  add constraint member_accounts_suspension_metadata check (
    (status = 'active' and suspended_at is null and suspension_reason is null)
    or (status = 'suspended' and suspended_at is not null and suspension_reason is not null)
  );
grant select on public.member_accounts to service_role;

create or replace function public.is_active_member_v1(p_member_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_member_id is not null and exists (
    select 1 from public.member_accounts
     where id = p_member_id and status = 'active'
  );
$$;
revoke all on function public.is_active_member_v1(uuid) from public;
grant execute on function public.is_active_member_v1(uuid) to authenticated;

-- RLS policies must not ask each other to prove the same membership: a
-- challenge policy consulting challenge_members while challenge_members
-- consults challenges causes PostgreSQL's infinite-recursion guard. This
-- owner-bypassing predicate keeps the three read policies equivalent without
-- broadening the authenticated table grants.
create or replace function public.challenge_member_visible_v1(
  p_challenge_id uuid,
  p_member_id uuid
)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_active_member_v1(p_member_id)
    and exists (
      select 1 from public.challenge_members member_row
       where member_row.challenge_id = p_challenge_id
         and member_row.member_id = p_member_id
    )
    and exists (
      select 1 from public.challenges challenge_row
       where challenge_row.id = p_challenge_id
         and (challenge_row.retention_expires_at is null or challenge_row.retention_expires_at > statement_timestamp())
    );
$$;
revoke all on function public.challenge_member_visible_v1(uuid, uuid) from public;
grant execute on function public.challenge_member_visible_v1(uuid, uuid) to authenticated;

drop policy if exists challenge_members_realtime_read on public.challenge_members;
create policy challenge_members_realtime_read
on public.challenge_members for select to authenticated
using (public.challenge_member_visible_v1(challenge_id, (select auth.uid())));

drop policy if exists challenges_member_realtime_read on public.challenges;
create policy challenges_member_realtime_read
on public.challenges for select to authenticated
using (public.challenge_member_visible_v1(id, (select auth.uid())));

drop policy if exists solves_member_realtime_read on public.solves;
create policy solves_member_realtime_read
on public.solves for select to authenticated
using (public.challenge_member_visible_v1(challenge_id, (select auth.uid())));

create or replace function public.reject_inactive_member_mutation_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null
    and not public.is_active_member_v1((select auth.uid())) then
    raise exception 'The Member Account is unavailable.' using errcode = '42501';
  end if;
  return NEW;
end;
$$;

drop trigger if exists challenges_active_member_guard on public.challenges;
-- Authenticated Members have no direct UPDATE grant on Challenges. Keep the
-- insert guard for any future client-side write, while allowing the
-- security-definer lifecycle reconciler to transition a delayed Challenge
-- after the Member's own account has been removed from auth sessions.
create trigger challenges_active_member_guard
before insert on public.challenges
for each row execute function public.reject_inactive_member_mutation_v1();
drop trigger if exists solves_active_member_guard on public.solves;
create trigger solves_active_member_guard
before insert or update on public.solves
for each row execute function public.reject_inactive_member_mutation_v1();
drop trigger if exists solve_corrections_active_member_guard on public.solve_corrections;
create trigger solve_corrections_active_member_guard
before insert or update on public.solve_corrections
for each row execute function public.reject_inactive_member_mutation_v1();
drop trigger if exists invitations_active_member_guard on public.invitations;
create trigger invitations_active_member_guard
before insert or update on public.invitations
for each row execute function public.reject_inactive_member_mutation_v1();

-- Destination limiting already exists on the Invitation command. This second
-- bucket prevents an attacker from evading it by rotating destination inputs.
create table public.invitation_account_rate_limits (
  member_id uuid not null references auth.users(id) on delete cascade,
  window_started_at timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0),
  primary key (member_id, window_started_at)
);
alter table public.invitation_account_rate_limits enable row level security;
revoke all on public.invitation_account_rate_limits from anon, authenticated;

create or replace function public.enforce_invitation_account_rate_limit_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  window_start timestamptz := date_trunc('hour', clock_timestamp());
  attempt_count integer;
  current_member uuid := (select auth.uid());
begin
  if current_member is null then return NEW; end if;
  insert into public.invitation_account_rate_limits(member_id, window_started_at, attempts)
  values (current_member, window_start, 1)
  on conflict (member_id, window_started_at)
  do update set attempts = public.invitation_account_rate_limits.attempts + 1
  returning attempts into attempt_count;
  if attempt_count > 20 then
    raise exception 'Too many Invitations. Please wait and try again.' using errcode = 'P0002';
  end if;
  return NEW;
end;
$$;

drop trigger if exists invitations_account_rate_limit on public.invitations;
create trigger invitations_account_rate_limit
before insert on public.invitations
for each row execute function public.enforce_invitation_account_rate_limit_v1();

-- Authentication requests must share an authoritative bucket across browsers
-- and worker restarts. Unknown destinations use a privacy-preserving hash;
-- known accounts also consume an account-wide bucket.
create table public.otp_request_rate_limits (
  scope_key text primary key,
  window_started_at timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0)
);
alter table public.otp_request_rate_limits enable row level security;
revoke all on public.otp_request_rate_limits from anon, authenticated;

create or replace function public.claim_email_otp_request_v1(p_destination_email text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  clean_destination text := lower(btrim(coalesce(p_destination_email, '')));
  account_id uuid;
  current_scope_key text;
  attempt_count integer;
  window_start timestamptz := date_trunc('hour', clock_timestamp());
  scope_keys text[];
begin
  if clean_destination !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    or length(clean_destination) > 320 then
    raise exception 'A valid email destination is required.' using errcode = '22023';
  end if;
  select id into account_id from auth.users where lower(email) = clean_destination limit 1;
  scope_keys := array['destination:' || md5(clean_destination)];
  if account_id is not null then
    scope_keys := array_append(scope_keys, 'account:' || account_id::text);
  end if;
  foreach current_scope_key in array scope_keys loop
    insert into public.otp_request_rate_limits(scope_key, window_started_at, attempts)
    values (current_scope_key, window_start, 1)
    on conflict (scope_key) do update
      set attempts = case
        when public.otp_request_rate_limits.window_started_at < window_start
          then 1
        else public.otp_request_rate_limits.attempts + 1
      end,
      window_started_at = case
        when public.otp_request_rate_limits.window_started_at < window_start
          then window_start
        else public.otp_request_rate_limits.window_started_at
      end
    returning attempts into attempt_count;
    if attempt_count > 5 then
      raise exception 'Too many requests. Please wait and try again.' using errcode = 'P0002';
    end if;
  end loop;
  return true;
end;
$$;

alter table public.challenges
  add column if not exists terminal_reason text;

alter table public.challenges
  add constraint challenges_terminal_reason_check check (
    terminal_reason is null or terminal_reason in ('member_deleted', 'member_suspended')
  );

create or replace function public.reject_terminal_reason_update_v1()
returns trigger language plpgsql set search_path = '' as $$
begin
  if OLD.status in ('canceled', 'abandoned', 'completed', 'incomplete')
    and NEW.terminal_reason is distinct from OLD.terminal_reason then
    raise exception 'Terminal Challenge reason is immutable.' using errcode = '22023';
  end if;
  return NEW;
end;
$$;
drop trigger if exists challenges_terminal_reason_immutable on public.challenges;
create trigger challenges_terminal_reason_immutable
before update on public.challenges
for each row execute function public.reject_terminal_reason_update_v1();

create or replace function public.member_identity_json_v1(
  p_member_id uuid,
  p_fallback_email text,
  p_fallback_display_name text
)
returns jsonb language sql stable security definer set search_path = '' as $$
  with account as (
    select status, email, display_name
      from public.member_accounts
     where id = p_member_id
  )
  select jsonb_build_object(
    'email', case when (select status from account) = 'suspended'
      then 'Suspended Member' else coalesce((select email from account), p_fallback_email) end,
    'displayName', case when (select status from account) = 'suspended'
      then 'Suspended Member' else coalesce((select display_name from account), p_fallback_display_name) end
  );
$$;

create or replace function public.challenge_member_json_v1(member_row public.challenge_members)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'memberId', member_row.member_id,
    'email', visible_identity.value->>'email',
    'displayName', visible_identity.value->>'displayName',
    'authority', member_row.authority
  ) from lateral (
    select public.member_identity_json_v1(member_row.member_id, member_row.member_email, member_row.display_name) as value
  ) visible_identity;
$$;

create or replace function public.invitation_json_v1(invitation_row public.invitations)
returns jsonb language sql stable set search_path = '' as $$
  with inviter as (
    select public.member_identity_json_v1(invitation_row.inviter_id, null, 'A Member') as identity,
           exists (select 1 from public.deleted_member_records record_row where record_row.id = invitation_row.inviter_id) as deleted
  ), invited as (
    select account_row.status
      from auth.users user_row
      left join public.member_accounts account_row on account_row.id = user_row.id
     where lower(user_row.email) = lower(invitation_row.invited_email)
     limit 1
  )
  select jsonb_build_object(
    'id', invitation_row.id,
    'inviterId', invitation_row.inviter_id,
    'inviterDisplayName', case when (select deleted from inviter) then 'Deleted Member'
      else (select identity->>'displayName' from inviter) end,
    'invitedEmail', case when invitation_row.deleted_member_record_id is not null then 'Deleted Member'
      when (select status from invited) = 'suspended' then 'Suspended Member'
      else invitation_row.invited_email end,
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

create or replace function public.invitation_details_json_v1(invitation_row public.invitations)
returns jsonb language sql stable security definer set search_path = '' as $$
  with partner as (
    select public.member_identity_json_v1(
      invitation_row.inviter_id,
      lower(coalesce((select email from auth.users where id = invitation_row.inviter_id), '')),
      'A Member'
    ) as identity
  )
  select jsonb_build_object(
    'invitation', public.effective_invitation_json_v1(invitation_row),
    'problemSetVersion', (
      select public.problem_set_version_json_v1(version_row) || jsonb_build_object(
        'problemCount', (select count(*) from public.problem_set_version_problems item where item.problem_set_version_id = version_row.id)
      ) from public.problem_set_versions version_row where version_row.id = invitation_row.problem_set_version_id
    ),
    'partner', jsonb_build_object(
      'memberId', invitation_row.inviter_id,
      'email', (select identity->>'email' from partner),
      'displayName', (select identity->>'displayName' from partner)
    ),
    'sharedRecord', jsonb_build_object('visibility', 'both_members', 'authority', 'equal', 'canEitherMemberEnd', true)
  );
$$;

-- A revoked session may still carry a parseable access token until expiry.
-- Every Member-scoped read therefore repeats the active-account check.
create or replace function public.get_member_account_v1()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  account_row public.member_accounts;
begin
  if (select auth.uid()) is null then return null; end if;
  select * into account_row from public.member_accounts
   where id = (select auth.uid()) and status in ('active', 'suspended');
  if not found then return null; end if;
  return public.member_account_json_v1(account_row);
end;
$$;

create or replace function public.get_challenge_v1(p_challenge_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.challenge_json_v1(challenge_row)
    from public.challenges challenge_row
   where challenge_row.id = p_challenge_id
     and exists (select 1 from public.member_accounts account_row
       where account_row.id = (select auth.uid()) and account_row.status = 'active')
     and (challenge_row.retention_expires_at is null or challenge_row.retention_expires_at > clock_timestamp())
     and exists (select 1 from public.challenge_members member_row
       where member_row.challenge_id = challenge_row.id and member_row.member_id = (select auth.uid()));
$$;

create or replace function public.get_committed_challenge_for_member_v1()
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.challenge_json_v1(challenge_row)
    from public.member_commitments commitment
    join public.challenges challenge_row on challenge_row.id = commitment.challenge_id
   where commitment.member_id = (select auth.uid())
     and exists (select 1 from public.member_accounts account_row
       where account_row.id = (select auth.uid()) and account_row.status = 'active')
     and challenge_row.status in ('scheduled', 'active')
   limit 1;
$$;

create or replace function public.get_latest_terminal_challenge_for_member_v1()
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.challenge_json_v1(challenge_row)
    from public.challenges challenge_row
   where challenge_row.status in ('canceled', 'abandoned', 'completed', 'incomplete')
     and exists (select 1 from public.member_accounts account_row
       where account_row.id = (select auth.uid()) and account_row.status = 'active')
     and (challenge_row.retention_expires_at is null or challenge_row.retention_expires_at > clock_timestamp())
     and exists (select 1 from public.challenge_members member_row
       where member_row.challenge_id = challenge_row.id and member_row.member_id = (select auth.uid()))
   order by challenge_row.terminal_at desc nulls last limit 1;
$$;

create or replace function public.get_latest_canceled_challenge_for_member_v1()
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.get_latest_terminal_challenge_for_member_v1();
$$;

create or replace function public.authorized_invitation_v1(p_invitation_id uuid)
returns public.invitations language plpgsql volatile security definer set search_path = '' as $$
declare
  current_member uuid := (select auth.uid());
  caller_email text;
  invitation_row public.invitations;
begin
  if not public.is_active_member_v1(current_member) then
    raise exception 'Invitation is unavailable.' using errcode = '42501';
  end if;
  select * into invitation_row from public.invitations where id = p_invitation_id;
  select lower(email) into caller_email from auth.users where id = current_member;
  if not found or invitation_row.id is null
    or (invitation_row.inviter_id is distinct from current_member
      and lower(coalesce(invitation_row.invited_email, '')) is distinct from caller_email) then
    raise exception 'Invitation is unavailable.' using errcode = '42501';
  end if;
  if invitation_row.retention_expires_at is not null
    and invitation_row.retention_expires_at <= clock_timestamp() then
    return null;
  end if;
  invitation_row := public.expire_invitation_if_due_v1(invitation_row.id);
  return invitation_row;
end;
$$;

create or replace function public.get_invitation_v1(p_invitation_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  invitation_row public.invitations;
begin
  invitation_row := public.authorized_invitation_v1(p_invitation_id);
  if invitation_row.id is null then return null; end if;
  return public.invitation_json_v1(invitation_row);
end;
$$;

create or replace function public.get_invitation_details_v1(p_invitation_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  invitation_row public.invitations;
begin
  invitation_row := public.authorized_invitation_v1(p_invitation_id);
  if invitation_row.id is null then return null; end if;
  return public.invitation_details_json_v1(invitation_row);
end;
$$;

create or replace function public.get_solve_history_v1(p_challenge_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.member_accounts account_row
    where account_row.id = (select auth.uid()) and account_row.status = 'active')
    or not exists (select 1 from public.challenge_members
      where challenge_id = p_challenge_id and member_id = (select auth.uid())) then
    raise exception 'The Challenge is no longer available.' using errcode = '42501';
  end if;
  return public.solve_history_json_v1(p_challenge_id);
end;
$$;

create or replace function public.get_challenge_solve_history_v1(p_challenge_id uuid)
returns jsonb language sql security definer set search_path = '' as $$
  select public.get_solve_history_v1(p_challenge_id);
$$;

create or replace function public.get_challenge_effective_status_at_v1(
  p_challenge_id uuid,
  p_authoritative_now timestamptz
)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  challenge_row public.challenges;
begin
  if not exists (select 1 from public.member_accounts account_row
    where account_row.id = (select auth.uid()) and account_row.status = 'active') then
    raise exception 'The Challenge is no longer available.' using errcode = '42501';
  end if;
  select challenge_item.* into challenge_row from public.challenges challenge_item
   where challenge_item.id = p_challenge_id
     and exists (select 1 from public.challenge_members member_row
       where member_row.challenge_id = challenge_item.id and member_row.member_id = (select auth.uid()));
  if not found then raise exception 'The Challenge is no longer available.' using errcode = 'P0003'; end if;
  return public.challenge_effective_status_at_v1(
    challenge_row.status, challenge_row.start_date, challenge_row.challenge_time_zone, p_authoritative_now
  );
end;
$$;

-- The actual log shape is deliberately an allow-list of operational fields.
-- It cannot become a second behavioural dataset or a credential/content dump.
create table public.security_events (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  event_type text not null check (event_type in ('technical_abuse_suspension', 'authorization_denied', 'rate_limited', 'diagnostic')),
  diagnostic_id text,
  subject_member_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  constraint security_events_diagnostic_id check (diagnostic_id is null or diagnostic_id ~ '^[0-9A-F]{10}$'),
  constraint security_events_details_object check (jsonb_typeof(details) = 'object')
);

alter table public.security_events enable row level security;
revoke all on public.security_events from anon, authenticated;
grant select, insert on public.security_events to service_role;

create or replace function public.security_event_details_safe_v1(value jsonb)
returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  item record;
  normalized_key text;
begin
  if value is null then return true; end if;
  if jsonb_typeof(value) = 'string' then
    return not ((value #>> '{}') ~ '[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+'
      or (value #>> '{}') ~ '(^|[^0-9])[0-9]{6}([^0-9]|$)');
  end if;
  if jsonb_typeof(value) = 'array' then
    for item in select array_item.value as child
      from jsonb_array_elements(value) as array_item(value) loop
      if not public.security_event_details_safe_v1(item.child) then return false; end if;
    end loop;
    return true;
  end if;
  if jsonb_typeof(value) <> 'object' then return true; end if;
  for item in select * from jsonb_each(value) loop
    normalized_key := lower(regexp_replace(item.key, '[^a-zA-Z]', '', 'g'));
    if normalized_key not in (
      'code', 'operation', 'operatoraction', 'outcome', 'reason', 'resource',
      'retryafterseconds', 'safe', 'source', 'status'
    ) then return false; end if;
    if normalized_key in (
      'email', 'memberemail', 'recipientemail', 'token', 'accesstoken', 'refreshtoken',
      'otp', 'authcode', 'verificationcode', 'passcode', 'solve', 'solvecontent',
      'content', 'snapshot', 'completesnapshot', 'partnerprogress', 'petstate', 'pet',
      'memberdata', 'displayname', 'invitationterms', 'challengeprogress'
    ) then return false; end if;
    if jsonb_typeof(item.value) = 'string'
      and ((item.value #>> '{}') ~ '[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+'
        or (item.value #>> '{}') ~ '(^|[^0-9])[0-9]{6}([^0-9]|$)') then
      return false;
    end if;
    if not public.security_event_details_safe_v1(item.value) then return false; end if;
  end loop;
  return true;
end;
$$;

revoke all on function public.security_event_details_safe_v1(jsonb) from public, anon, authenticated;
grant execute on function public.security_event_details_safe_v1(jsonb) to service_role;

alter table public.security_events
  add constraint security_events_details_safe check (public.security_event_details_safe_v1(details));

create or replace function public.record_security_event_v1(
  p_event_key text,
  p_event_type text,
  p_diagnostic_id text default null,
  p_subject_member_id uuid default null,
  p_details jsonb default '{}'::jsonb
)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  event_id uuid;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'Security event recording is restricted to the operator boundary.' using errcode = '42501';
  end if;
  if p_event_key is null or btrim(p_event_key) = ''
    or p_event_key !~ '^[a-z][a-z0-9_.:-]{0,119}$' then
    raise exception 'Security event identity is required.' using errcode = '22023';
  end if;
  if not public.security_event_details_safe_v1(coalesce(p_details, '{}'::jsonb)) then
    raise exception 'Security event details contain restricted Member Data.' using errcode = '22023';
  end if;
  insert into public.security_events(event_key, event_type, diagnostic_id, subject_member_id, details)
  values (p_event_key, p_event_type, p_diagnostic_id, p_subject_member_id, coalesce(p_details, '{}'::jsonb))
  on conflict (event_key) do update set event_type = excluded.event_type
  returning id into event_id;
  return event_id;
end;
$$;

-- Access is opt-in, narrow in scope, expires, and produces its own low-detail audit row.
create table public.support_access_grants (
  id uuid primary key default gen_random_uuid(),
  operator_id text not null,
  member_id uuid not null,
  scope text not null check (scope = 'diagnostic'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint support_access_operator_not_blank check (length(btrim(operator_id)) between 1 and 120),
  constraint support_access_expiry check (expires_at > created_at)
);
alter table public.support_access_grants enable row level security;
revoke all on public.support_access_grants from anon, authenticated;
grant select, insert, update on public.support_access_grants to service_role;

create table public.support_access_audit (
  id uuid primary key default gen_random_uuid(),
  operator_id text not null,
  grant_id uuid,
  member_id uuid,
  action text not null check (action in ('grant', 'read', 'revoke')),
  created_at timestamptz not null default clock_timestamp()
);
alter table public.support_access_audit enable row level security;
revoke all on public.support_access_audit from anon, authenticated;
grant select, insert on public.support_access_audit to service_role;

create or replace function public.grant_support_diagnostic_access_v1(
  p_operator_id text,
  p_member_id uuid,
  p_expires_at timestamptz
)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  grant_id uuid;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'Support access is restricted to the operator boundary.' using errcode = '42501';
  end if;
  if p_operator_id is null or length(btrim(p_operator_id)) not between 1 and 120
    or p_expires_at <= statement_timestamp()
    or p_expires_at > statement_timestamp() + interval '24 hours' then
    raise exception 'A bounded support access grant is required.' using errcode = '22023';
  end if;
  insert into public.support_access_grants(operator_id, member_id, scope, expires_at)
  values (btrim(p_operator_id), p_member_id, 'diagnostic', p_expires_at)
  returning id into grant_id;
  insert into public.support_access_audit(operator_id, grant_id, member_id, action)
  values (btrim(p_operator_id), grant_id, p_member_id, 'grant');
  return grant_id;
end;
$$;

create or replace function public.revoke_support_diagnostic_access_v1(
  p_operator_id text,
  p_grant_id uuid
)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  changed boolean;
  member_id uuid;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'Support access is restricted to the operator boundary.' using errcode = '42501';
  end if;
  update public.support_access_grants
     set revoked_at = coalesce(revoked_at, clock_timestamp())
   where id = p_grant_id
  returning true, support_access_grants.member_id into changed, member_id;
  if changed then
    insert into public.support_access_audit(operator_id, grant_id, member_id, action)
    values (btrim(p_operator_id), p_grant_id, member_id, 'revoke');
  end if;
  return coalesce(changed, false);
end;
$$;

create or replace function public.get_support_diagnostics_v1(
  p_operator_id text,
  p_grant_id uuid
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  grant_row public.support_access_grants;
  result jsonb;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'Support access is restricted to the operator boundary.' using errcode = '42501';
  end if;
  select * into grant_row from public.support_access_grants
   where id = p_grant_id and operator_id = btrim(p_operator_id)
     and scope = 'diagnostic' and revoked_at is null and expires_at > clock_timestamp();
  if not found then
    raise exception 'Diagnostic support access is unavailable.' using errcode = '42501';
  end if;
  insert into public.support_access_audit(operator_id, grant_id, member_id, action)
  values (btrim(p_operator_id), p_grant_id, grant_row.member_id, 'read');
  select coalesce(jsonb_agg(jsonb_build_object(
    'eventType', event_type,
    'diagnosticId', diagnostic_id,
    'createdAt', created_at,
    'details', details
  ) order by created_at), '[]'::jsonb)
    into result
    from public.security_events
   where subject_member_id = grant_row.member_id;
  return result;
end;
$$;

create or replace function public.suspend_member_account_v1(
  p_member_id uuid,
  p_reason text,
  p_operator_id text
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  target public.member_accounts;
  challenge_row public.challenges;
  invitation_row public.invitations;
  effective_status text;
  authoritative_now timestamptz := statement_timestamp();
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'Account suspension is restricted to the operator boundary.' using errcode = '42501';
  end if;
  if p_reason not in ('credential_stuffing', 'token_replay', 'authorization_bypass', 'automated_request_flood', 'security_vulnerability') then
    raise exception 'Only a defined technical-abuse reason is permitted.' using errcode = '22023';
  end if;
  if p_operator_id is null or length(btrim(p_operator_id)) not between 1 and 120 then
    raise exception 'An operator identity is required.' using errcode = '42501';
  end if;
  select * into target from public.member_accounts where id = p_member_id for update;
  if not found then raise exception 'The Member Account is unavailable.' using errcode = '42501'; end if;
  if target.status = 'suspended' then
    return jsonb_build_object('memberId', target.id, 'status', target.status, 'suspendedAt', target.suspended_at);
  end if;

  perform pg_advisory_xact_lock(hashtext(p_member_id::text));
  update public.member_accounts
     set status = 'suspended', suspended_at = authoritative_now, suspension_reason = p_reason,
         updated_at = authoritative_now
   where id = p_member_id;
  -- Existing access tokens remain parseable, but neither refresh nor any
  -- Member-scoped function can continue after this transaction.
  delete from auth.sessions where user_id = p_member_id;

  for invitation_row in
    select * from public.invitations
     where status = 'pending' and (inviter_id = p_member_id or lower(invited_email) = lower(target.email))
     for update
  loop
    update public.invitations
       set status = 'revoked', terminal_actor_id = p_member_id, terminal_at = authoritative_now
     where id = invitation_row.id;
  end loop;

  for challenge_row in
    select * from public.challenges
     where status in ('scheduled', 'active')
       and (inviter_id = p_member_id or invited_member_id = p_member_id)
     for update
  loop
    effective_status := public.challenge_effective_status_at_v1(
      challenge_row.status, challenge_row.start_date, challenge_row.challenge_time_zone, authoritative_now
    );
    if effective_status = 'active' then
      if challenge_row.status = 'scheduled' then
        -- A scheduled row whose effective date has arrived must first cross
        -- the normal lifecycle boundary before it is abandoned.
        update public.challenges
           set status = 'active', updated_at = authoritative_now
         where id = challenge_row.id and status = 'scheduled';
      end if;
      update public.challenges
         set status = 'abandoned', terminal_actor_id = p_member_id, terminal_at = authoritative_now,
             terminal_reason = 'member_suspended', updated_at = authoritative_now
       where id = challenge_row.id and status = 'active';
    else
      update public.challenges
         set status = 'canceled', terminal_actor_id = p_member_id, terminal_at = authoritative_now,
             terminal_reason = 'member_suspended', updated_at = authoritative_now
       where id = challenge_row.id and status = 'scheduled';
    end if;
    delete from public.member_commitments where challenge_id = challenge_row.id;
  end loop;

  insert into public.security_events(event_key, event_type, subject_member_id, details)
  values (
    'suspension:' || p_member_id || ':' || to_char(authoritative_now, 'YYYYMMDDHH24MISSMS'),
    'technical_abuse_suspension', p_member_id,
    jsonb_build_object('reason', p_reason, 'operatorAction', 'suspend')
  );
  return jsonb_build_object('memberId', p_member_id, 'status', 'suspended', 'suspendedAt', authoritative_now);
end;
$$;

-- Account-ending partner notices are intentionally the only outward effect.
create or replace function public.enqueue_challenge_transactional_notice_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  recipient_id uuid;
  recipient_email text;
  actor_id uuid;
  original_actor_id uuid;
  event_type text;
  event_suffix text;
begin
  if OLD.status = NEW.status and NEW.deleted_member_record_id is null then return NEW; end if;
  if NEW.deleted_member_record_id is not null then
    if OLD.status not in ('scheduled', 'active')
      or not exists (select 1 from public.member_commitments where challenge_id = NEW.id) then
      return NEW;
    end if;
    event_type := 'challenge_account_ended';
    actor_id := NEW.terminal_actor_id;
    select original_member_id into original_actor_id from public.deleted_member_records where id = NEW.deleted_member_record_id;
    event_suffix := 'account-ended';
  elsif NEW.terminal_reason = 'member_suspended' and OLD.status in ('scheduled', 'active') then
    event_type := 'challenge_account_ended';
    actor_id := NEW.terminal_actor_id;
    event_suffix := 'account-ended';
  elsif NEW.status = 'canceled' and OLD.status is distinct from NEW.status then
    event_type := 'challenge_canceled';
    actor_id := coalesce((select auth.uid()), NEW.terminal_actor_id);
    event_suffix := 'canceled';
  elsif NEW.status = 'abandoned' and OLD.status is distinct from NEW.status then
    event_type := 'challenge_abandoned';
    actor_id := coalesce((select auth.uid()), NEW.terminal_actor_id);
    event_suffix := 'abandoned';
  else return NEW;
  end if;
  select member_row.member_id, member_row.member_email into recipient_id, recipient_email
    from public.challenge_members member_row
   where member_row.challenge_id = NEW.id
     and member_row.member_id is distinct from actor_id
     and member_row.member_id is distinct from original_actor_id
   order by member_row.member_id limit 1;
  if recipient_email is null or (recipient_id is not null and recipient_id = actor_id) then return NEW; end if;
  perform public.queue_transactional_notice_v1(row(
    'challenge:' || NEW.id || ':' || event_suffix, event_type, recipient_email, recipient_id, actor_id,
    null, NEW.id, null
  )::public.transactional_notice_input);
  return NEW;
end;
$$;

create or replace function public.enqueue_invitation_transactional_notice_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  recipient_id uuid;
  recipient_email text;
  actor_id uuid := coalesce((select auth.uid()), NEW.terminal_actor_id);
  event_type text;
begin
  if NEW.deleted_member_record_id is not null or OLD.status = NEW.status
    or NEW.status not in ('accepted', 'declined', 'revoked') then return NEW; end if;
  if NEW.status = 'accepted' then event_type := 'invitation_accepted';
  elsif NEW.status = 'declined' then event_type := 'invitation_declined';
  else event_type := 'invitation_revoked'; end if;
  if event_type = 'invitation_revoked' then
    select user_row.id, lower(user_row.email) into recipient_id, recipient_email from auth.users user_row
     where lower(user_row.email) = lower(NEW.invited_email) limit 1;
  else
    recipient_id := NEW.inviter_id;
    select lower(email) into recipient_email from auth.users where id = recipient_id;
  end if;
  if recipient_email is null or (recipient_id is not null and recipient_id = actor_id) then return NEW; end if;
  perform public.queue_transactional_notice_v1(row(
    'invitation:' || NEW.id || ':' || replace(event_type, 'invitation_', ''), event_type,
    recipient_email, recipient_id, actor_id, NEW.id, null,
    (select display_name from public.member_accounts where id = NEW.inviter_id)
  )::public.transactional_notice_input);
  return NEW;
end;
$$;

revoke all on function public.record_security_event_v1(text, text, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.grant_support_diagnostic_access_v1(text, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.revoke_support_diagnostic_access_v1(text, uuid) from public, anon, authenticated;
revoke all on function public.get_support_diagnostics_v1(text, uuid) from public, anon, authenticated;
revoke all on function public.suspend_member_account_v1(uuid, text, text) from public, anon, authenticated;
revoke all on function public.authorized_invitation_v1(uuid) from public, anon, authenticated;
revoke all on function public.member_identity_json_v1(uuid, text, text) from public, anon, authenticated;
revoke all on function public.reject_inactive_member_mutation_v1() from public, anon, authenticated;
revoke all on function public.claim_email_otp_request_v1(text) from public;
grant execute on function public.claim_email_otp_request_v1(text) to anon, authenticated;
grant execute on function public.record_security_event_v1(text, text, text, uuid, jsonb) to service_role;
grant execute on function public.grant_support_diagnostic_access_v1(text, uuid, timestamptz) to service_role;
grant execute on function public.revoke_support_diagnostic_access_v1(text, uuid) to service_role;
grant execute on function public.get_support_diagnostics_v1(text, uuid) to service_role;
grant execute on function public.suspend_member_account_v1(uuid, text, text) to service_role;

create or replace function public.foundation_health_v1()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'service', 'larp-code', 'schemaVersion', 13, 'serverTime', statement_timestamp(),
    'minimumClientVersion', '0.1.0'
  );
$$;
revoke all on function public.foundation_health_v1() from public;
grant execute on function public.foundation_health_v1() to anon, authenticated;
