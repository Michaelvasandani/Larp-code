-- Ticket 24: Invitation terminal transitions are authoritative, recoverable,
-- and independent of scheduled reconciliation timing.

alter table public.invitations
  add column terminal_actor_id uuid references auth.users(id),
  add column terminal_at timestamptz;

alter table public.invitations
  add constraint invitations_terminal_metadata check (
    (status in ('pending', 'accepted') and terminal_actor_id is null and terminal_at is null)
    or (status in ('revoked', 'declined') and terminal_actor_id is not null and terminal_at is not null)
    or (status = 'expired' and terminal_actor_id is null and terminal_at is not null)
  );

create or replace function public.enforce_invitation_terminal_transition_v1()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- Acceptance and other server-side competing-Invitation cleanup may only
  -- provide the terminal status. Attribute that automatic revocation to the
  -- authenticated command actor while preserving explicit command metadata.
  if NEW.status = 'revoked' and NEW.terminal_at is null then
    NEW.terminal_actor_id := coalesce(auth.uid(), OLD.inviter_id);
    NEW.terminal_at := clock_timestamp();
  end if;
  if OLD.status in ('revoked', 'declined', 'expired') then
    if row(NEW.status, NEW.terminal_actor_id, NEW.terminal_at)
      is distinct from row(OLD.status, OLD.terminal_actor_id, OLD.terminal_at) then
      raise exception 'Invitation terminals cannot be reactivated.' using errcode = '22023';
    end if;
  elsif NEW.status is distinct from OLD.status
    and NEW.status not in ('accepted', 'revoked', 'declined', 'expired') then
    raise exception 'Invitation state transition is invalid.' using errcode = '22023';
  end if;
  return NEW;
end;
$$;

create trigger invitations_terminal_transition
before update on public.invitations
for each row execute function public.enforce_invitation_terminal_transition_v1();

create or replace function public.invitation_effective_status_v1(invitation_row public.invitations)
returns text language sql volatile set search_path = '' as $$
  select case
    when invitation_row.status = 'pending'
      and ((clock_timestamp() at time zone invitation_row.challenge_time_zone)::date >= invitation_row.start_date)
      then 'expired'
    else invitation_row.status
  end;
$$;

create or replace function public.expire_invitation_if_due_v1(p_invitation_id uuid)
returns public.invitations language plpgsql security definer set search_path = '' as $$
declare
  invitation_row public.invitations;
begin
  update public.invitations
     set status = 'expired',
         terminal_at = clock_timestamp()
   where id = p_invitation_id
     and status = 'pending'
     and ((clock_timestamp() at time zone challenge_time_zone)::date >= start_date)
  returning * into invitation_row;
  if found then return invitation_row; end if;
  select * into invitation_row from public.invitations where id = p_invitation_id;
  return invitation_row;
end;
$$;

create or replace function public.invitation_json_v1(invitation_row public.invitations)
returns jsonb language sql volatile set search_path = '' as $$
  select jsonb_build_object(
    'id', invitation_row.id,
    'inviterId', invitation_row.inviter_id,
    'inviterDisplayName', coalesce((select display_name from public.member_accounts where id = invitation_row.inviter_id), 'A Member'),
    'invitedEmail', invitation_row.invited_email,
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

create or replace function public.get_pending_invitation_for_member_v1()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_member uuid := (select auth.uid());
  invitation_row public.invitations;
begin
  if current_member is null then return null; end if;
  for invitation_row in
    select invitation_item.*
      from public.invitations invitation_item
      join auth.users invited_user on lower(invited_user.email) = lower(invitation_item.invited_email)
      join public.member_accounts invited_account on invited_account.id = invited_user.id and invited_account.status = 'active'
     where invited_user.id = current_member
       and invitation_item.status = 'pending'
     order by invitation_item.created_at asc
  loop
    invitation_row := public.expire_invitation_if_due_v1(invitation_row.id);
    if public.invitation_effective_status_v1(invitation_row) = 'pending' then
      return public.invitation_json_v1(invitation_row);
    end if;
  end loop;
  return null;
end;
$$;

create or replace function public.get_pending_outgoing_invitation_v1()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_member uuid := (select auth.uid());
  invitation_row public.invitations;
begin
  if current_member is null then return null; end if;
  select * into invitation_row
    from public.invitations
   where inviter_id = current_member
     and exists (select 1 from public.member_accounts where id = current_member and status = 'active')
     and status = 'pending'
   order by created_at asc
   limit 1;
  if not found then return null; end if;
  invitation_row := public.expire_invitation_if_due_v1(invitation_row.id);
  if public.invitation_effective_status_v1(invitation_row) <> 'pending' then return null; end if;
  return public.invitation_json_v1(invitation_row);
end;
$$;

create or replace function public.get_invitation_v1(p_invitation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_member uuid := (select auth.uid());
  caller_email text;
  invitation_row public.invitations;
begin
  select * into invitation_row from public.invitations where id = p_invitation_id;
  select lower(email) into caller_email from auth.users where id = current_member;
  if not found or current_member is null or invitation_row.id is null
    or (invitation_row.inviter_id is distinct from current_member
      and (lower(coalesce(invitation_row.invited_email, '')) is distinct from caller_email
        or not exists (select 1 from public.member_accounts where id = current_member and status = 'active')))
    or (invitation_row.inviter_id = current_member
      and not exists (select 1 from public.member_accounts where id = current_member and status = 'active')) then
    raise exception 'Invitation is unavailable.' using errcode = '42501';
  end if;
  invitation_row := public.expire_invitation_if_due_v1(invitation_row.id);
  return public.invitation_json_v1(invitation_row);
end;
$$;

create or replace function public.transition_invitation_terminal_v1(
  p_idempotency_key uuid,
  p_command_version integer,
  p_command_kind text,
  p_member_id uuid,
  p_member_email text,
  p_invitation_id uuid,
  p_terminal_status text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_member uuid := (select auth.uid());
  verified_email text;
  invitation_row public.invitations;
  command_result jsonb;
  existing_kind text;
  existing_version integer;
  claimed boolean := false;
  allowed boolean := false;
begin
  if current_member is null or p_member_id is distinct from current_member then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_command_version is distinct from 1
    or p_command_kind is distinct from (case when p_terminal_status = 'revoked' then 'revoke_invitation' else 'decline_invitation' end)
    or p_terminal_status not in ('revoked', 'declined') then
    raise exception 'The command version is no longer current.' using errcode = '22023';
  end if;
  select lower(email) into verified_email from auth.users
   where id = current_member and email is not null and email_confirmed_at is not null;
  if verified_email is null or lower(btrim(coalesce(p_member_email, ''))) is distinct from verified_email then
    raise exception 'A verified email is required.' using errcode = '42501';
  end if;

  select command_kind, command_version, result into existing_kind, existing_version, command_result
    from public.member_command_idempotency
   where member_id = current_member and idempotency_key = p_idempotency_key;
  if found then
    if existing_kind is distinct from p_command_kind or existing_version is distinct from p_command_version then
      raise exception 'The idempotency key is bound to another command.' using errcode = '22023';
    end if;
    return command_result;
  end if;

  select * into invitation_row from public.invitations where id = p_invitation_id for update;
  if not found then
    raise exception 'Invitation is unavailable.' using errcode = '42501';
  end if;
  invitation_row := public.expire_invitation_if_due_v1(invitation_row.id);
  select * into invitation_row from public.invitations where id = p_invitation_id for update;
  if invitation_row.status <> 'pending' then
    raise exception 'Invitation is no longer pending.' using errcode = '22023';
  end if;
  if p_terminal_status = 'revoked' then
    allowed := invitation_row.inviter_id = current_member
      and exists (select 1 from public.member_accounts where id = current_member and status = 'active');
  else
    allowed := lower(invitation_row.invited_email) = verified_email
      and exists (select 1 from public.member_accounts where id = current_member and status = 'active');
  end if;
  if not allowed then
    raise exception 'Invitation is unavailable.' using errcode = '42501';
  end if;

  insert into public.member_command_idempotency (
    member_id, idempotency_key, command_version, command_kind, member_email, intent
  ) values (
    current_member, p_idempotency_key, 1, p_command_kind, verified_email,
    jsonb_build_object('invitationId', p_invitation_id, 'status', p_terminal_status)
  ) on conflict (member_id, idempotency_key) do nothing returning true into claimed;
  if not coalesce(claimed, false) then
    select result into command_result from public.member_command_idempotency
     where member_id = current_member and idempotency_key = p_idempotency_key;
    if command_result is not null then return command_result; end if;
  end if;

  update public.invitations
     set status = p_terminal_status,
         terminal_actor_id = current_member,
         terminal_at = clock_timestamp()
   where id = p_invitation_id and status = 'pending'
  returning * into invitation_row;
  if not found then
    raise exception 'Invitation is no longer pending.' using errcode = '22023';
  end if;
  command_result := public.invitation_json_v1(invitation_row);
  update public.member_command_idempotency set result = command_result
   where member_id = current_member and idempotency_key = p_idempotency_key;
  return command_result;
end;
$$;

create or replace function public.revoke_invitation_v1(
  p_idempotency_key uuid, p_command_version integer, p_command_kind text,
  p_member_id uuid, p_member_email text, p_invitation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return public.transition_invitation_terminal_v1(
    p_idempotency_key, p_command_version, p_command_kind, p_member_id,
    p_member_email, p_invitation_id, 'revoked'
  );
end;
$$;

create or replace function public.decline_invitation_v1(
  p_idempotency_key uuid, p_command_version integer, p_command_kind text,
  p_member_id uuid, p_member_email text, p_invitation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return public.transition_invitation_terminal_v1(
    p_idempotency_key, p_command_version, p_command_kind, p_member_id,
    p_member_email, p_invitation_id, 'declined'
  );
end;
$$;

revoke all on function public.invitation_effective_status_v1(public.invitations) from public;
revoke all on function public.expire_invitation_if_due_v1(uuid) from public;
revoke all on function public.get_pending_invitation_for_member_v1() from public;
revoke all on function public.get_pending_outgoing_invitation_v1() from public;
revoke all on function public.get_invitation_v1(uuid) from public;
revoke all on function public.transition_invitation_terminal_v1(uuid, integer, text, uuid, text, uuid, text) from public;
revoke all on function public.revoke_invitation_v1(uuid, integer, text, uuid, text, uuid) from public;
revoke all on function public.decline_invitation_v1(uuid, integer, text, uuid, text, uuid) from public;
grant execute on function public.get_pending_invitation_for_member_v1() to authenticated;
grant execute on function public.get_pending_outgoing_invitation_v1() to authenticated;
grant execute on function public.get_invitation_v1(uuid) to authenticated;
grant execute on function public.revoke_invitation_v1(uuid, integer, text, uuid, text, uuid) to authenticated;
grant execute on function public.decline_invitation_v1(uuid, integer, text, uuid, text, uuid) to authenticated;

create or replace function public.foundation_health_v1()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('service', 'larp-code', 'schemaVersion', 5, 'serverTime', clock_timestamp());
$$;
revoke all on function public.foundation_health_v1() from public;
grant execute on function public.foundation_health_v1() to anon, authenticated;
