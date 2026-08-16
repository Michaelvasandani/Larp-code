-- One append-only idempotency record per authenticated Member and command key.
-- The table is reachable only through the versioned security-definer command.
create table public.member_command_idempotency (
  member_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key uuid not null,
  command_version integer not null,
  command_kind text not null,
  member_email text not null,
  intent jsonb not null,
  result jsonb,
  created_at timestamptz not null default clock_timestamp(),
  primary key (member_id, idempotency_key)
);

alter table public.member_command_idempotency enable row level security;
revoke all on table public.member_command_idempotency from anon, authenticated;

create or replace function public.update_member_display_name_v1(
  p_idempotency_key uuid,
  p_command_version integer,
  p_command_kind text,
  p_member_id uuid,
  p_member_email text,
  p_display_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_member uuid := (select auth.uid());
  verified_email text;
  account_row public.member_accounts;
  existing_kind text;
  existing_version integer;
  command_result jsonb;
  claimed boolean := false;
  clean_display_name text;
begin
  if current_member is null or p_member_id is distinct from current_member then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if not public.is_supported_command_contract_version_v1(p_command_version)
    or p_command_kind is distinct from 'update_display_name' then
    raise exception 'The command version is no longer current.' using errcode = '22023';
  end if;

  select lower(email) into verified_email
  from auth.users
  where id = current_member
    and email is not null
    and email_confirmed_at is not null;
  if verified_email is null or lower(coalesce(p_member_email, '')) is distinct from verified_email then
    raise exception 'A verified email is required.' using errcode = '42501';
  end if;

  -- A committed result wins over any current Snapshot revision or retry input.
  -- The primary key also makes concurrent claims wait for the original transaction.
  select command_kind, command_version, result
    into existing_kind, existing_version, command_result
    from public.member_command_idempotency
   where member_id = current_member
     and idempotency_key = p_idempotency_key;
  if found then
    if existing_kind is distinct from p_command_kind or existing_version is distinct from p_command_version then
      raise exception 'The idempotency key is bound to another command.' using errcode = '22023';
    end if;
    return command_result;
  end if;

  select * into account_row
  from public.member_accounts
  where id = current_member
    and status = 'active';
  if not found then
    raise exception 'A Member Account is required.' using errcode = '42501';
  end if;

  clean_display_name := btrim(regexp_replace(coalesce(p_display_name, ''), '[[:cntrl:]]', '', 'g'));
  if char_length(clean_display_name) < 1 then
    raise exception 'Display name is required.' using errcode = '22023';
  end if;
  if char_length(clean_display_name) > 80 then
    raise exception 'Display name must be 80 characters or fewer.' using errcode = '22023';
  end if;

  insert into public.member_command_idempotency (
    member_id,
    idempotency_key,
    command_version,
    command_kind,
    member_email,
    intent
  ) values (
    current_member,
    p_idempotency_key,
    p_command_version,
    p_command_kind,
    verified_email,
    jsonb_build_object('displayName', clean_display_name)
  ) on conflict (member_id, idempotency_key) do nothing
    returning true into claimed;

  if not coalesce(claimed, false) then
    select result into command_result
      from public.member_command_idempotency
     where member_id = current_member
       and idempotency_key = p_idempotency_key;
    return command_result;
  end if;

  update public.member_accounts
     set display_name = clean_display_name,
         updated_at = clock_timestamp()
   where id = current_member
     and status = 'active'
  returning * into account_row;

  if not found then
    raise exception 'A Member Account is required.' using errcode = '42501';
  end if;

  command_result := public.member_account_json_v1(account_row);
  update public.member_command_idempotency
     set result = command_result
   where member_id = current_member
     and idempotency_key = p_idempotency_key;

  return command_result;
end;
$$;

revoke all on function public.update_member_display_name_v1(uuid, integer, text, uuid, text, text) from public;
grant execute on function public.update_member_display_name_v1(uuid, integer, text, uuid, text, text) to authenticated;

create or replace function public.foundation_health_v1()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'service', 'larp-code',
    'schemaVersion', 3,
    'serverTime', clock_timestamp()
  );
$$;

revoke all on function public.foundation_health_v1() from public;
grant execute on function public.foundation_health_v1() to anon, authenticated;
