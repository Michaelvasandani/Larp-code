create table public.member_accounts (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text not null,
  status text not null default 'active' check (status = 'active'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  adult_confirmed_at timestamptz not null,
  consent_accepted_at timestamptz not null,
  consent_version text not null,
  constraint member_accounts_email_not_blank check (length(btrim(email)) > 0),
  constraint member_accounts_display_name_length check (char_length(display_name) between 1 and 80)
);

alter table public.member_accounts enable row level security;
revoke all on table public.member_accounts from anon, authenticated;

create or replace function public.member_account_json_v1(account_row public.member_accounts)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', account_row.id,
    'email', account_row.email,
    'displayName', account_row.display_name,
    'status', account_row.status,
    'createdAt', account_row.created_at,
    'updatedAt', account_row.updated_at,
    'adultConfirmedAt', account_row.adult_confirmed_at,
    'consentAcceptedAt', account_row.consent_accepted_at,
    'consentVersion', account_row.consent_version
  );
$$;

create or replace function public.get_member_account_v1()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  account_row public.member_accounts;
begin
  if (select auth.uid()) is null then
    return null;
  end if;

  select * into account_row
  from public.member_accounts
  where id = (select auth.uid())
    and status = 'active';

  if not found then
    return null;
  end if;
  return public.member_account_json_v1(account_row);
end;
$$;

create or replace function public.create_member_account_v1(
  p_display_name text,
  p_adult_confirmed boolean,
  p_consent_accepted boolean,
  p_consent_version text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_row public.member_accounts;
  clean_display_name text;
  verified_email text;
  current_member uuid := (select auth.uid());
begin
  if current_member is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  -- An already-created account is idempotent: a retried request cannot mutate
  -- its profile or consent record, even if the retry carries different input.
  select * into account_row
  from public.member_accounts
  where id = current_member
    and status = 'active';
  if found then
    return public.member_account_json_v1(account_row);
  end if;

  if p_adult_confirmed is not true or p_consent_accepted is not true then
    raise exception 'Adult confirmation and consent are required.' using errcode = '22023';
  end if;
  if p_consent_version is distinct from 'PRIV-031-v1' then
    raise exception 'The consent version is no longer current.' using errcode = '22023';
  end if;

  clean_display_name := btrim(regexp_replace(coalesce(p_display_name, ''), '[[:cntrl:]]', '', 'g'));
  if char_length(clean_display_name) < 1 then
    raise exception 'Display name is required.' using errcode = '22023';
  end if;
  if char_length(clean_display_name) > 80 then
    raise exception 'Display name must be 80 characters or fewer.' using errcode = '22023';
  end if;

  select lower(email) into verified_email
  from auth.users
  where id = current_member
    and email is not null
    and email_confirmed_at is not null;
  if verified_email is null then
    raise exception 'A verified email is required.' using errcode = '42501';
  end if;

  insert into public.member_accounts (
    id,
    email,
    display_name,
    adult_confirmed_at,
    consent_accepted_at,
    consent_version
  ) values (
    current_member,
    verified_email,
    clean_display_name,
    now(),
    now(),
    p_consent_version
  ) on conflict (id) do nothing;

  select * into account_row
  from public.member_accounts
  where id = current_member
    and status = 'active';
  if not found then
    raise exception 'The Member Account could not be created.';
  end if;
  return public.member_account_json_v1(account_row);
end;
$$;

revoke all on function public.member_account_json_v1(public.member_accounts) from public;
revoke all on function public.get_member_account_v1() from public;
revoke all on function public.create_member_account_v1(text, boolean, boolean, text) from public;
grant execute on function public.get_member_account_v1() to authenticated;
grant execute on function public.create_member_account_v1(text, boolean, boolean, text) to authenticated;

create or replace function public.foundation_health_v1()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'service', 'larp-code',
    'schemaVersion', 2,
    'serverTime', clock_timestamp()
  );
$$;

revoke all on function public.foundation_health_v1() from public;
grant execute on function public.foundation_health_v1() to anon, authenticated;
