-- Ticket 33: one-time Transactional Notices. The outbox contains only the
-- minimum routing facts needed to send an operational message. It is not a
-- preference store and never contains progress, Pet state, Challenge terms,
-- tokens, or a delivery status visible to either Member.

alter table public.transactional_notices
  drop constraint if exists transactional_notices_notice_type_check;

alter table public.transactional_notices
  add column if not exists actor_member_id uuid,
  add column if not exists invitation_id uuid,
  add column if not exists challenge_id uuid,
  add column if not exists source_event_key text,
  add column if not exists delivery_state text not null default 'queued',
  add column if not exists claimed_at timestamptz,
  add column if not exists provider_message_id text;

create table public.transactional_notice_types (
  notice_type text primary key,
  recipient_role text not null,
  delivery_source text not null check (delivery_source in ('authentication_provider', 'product_outbox')),
  product_email boolean not null
);

insert into public.transactional_notice_types(notice_type, recipient_role, delivery_source, product_email) values
  ('sign_in_code', 'authenticating_member', 'authentication_provider', false),
  ('account_security', 'affected_member', 'authentication_provider', false),
  ('invitation', 'invitee', 'product_outbox', true),
  ('invitation_accepted', 'inviter', 'product_outbox', true),
  ('invitation_declined', 'inviter', 'product_outbox', true),
  ('invitation_revoked', 'invitee', 'product_outbox', true),
  ('challenge_canceled', 'non_actor_member', 'product_outbox', true),
  ('challenge_abandoned', 'non_actor_member', 'product_outbox', true),
  ('challenge_account_ended', 'non_actor_member', 'product_outbox', true);

alter table public.transactional_notice_types enable row level security;
revoke all on public.transactional_notice_types from anon, authenticated;
grant select on public.transactional_notice_types to service_role;

alter table public.transactional_notices
  drop constraint if exists transactional_notices_type_check,
  add constraint transactional_notices_type_fkey foreign key (notice_type)
    references public.transactional_notice_types(notice_type),
  add constraint transactional_notices_delivery_state_check check (
    delivery_state in ('queued', 'claimed', 'delivered')
    and (delivery_state = 'queued' or claimed_at is not null)
    and (delivery_state <> 'delivered' or delivered_at is not null)
  );

-- Existing Invitation rows predate the generic outbox columns. Preserve their
-- event identity and attribute the actor without changing their recipient.
update public.transactional_notices notice_row
   set actor_member_id = coalesce(notice_row.actor_member_id, notice_row.inviter_member_id),
       source_event_key = coalesce(notice_row.source_event_key, notice_row.event_key),
       invitation_id = coalesce(notice_row.invitation_id,
         nullif(split_part(notice_row.event_key, ':', 2), '')::uuid)
 where notice_row.notice_type = 'invitation';

update public.transactional_notices
   set event_key = 'notice:' || md5(concat_ws('|', source_event_key, notice_type,
     lower(recipient_email), coalesce(recipient_member_id::text, '')))
 where source_event_key is not null
   and event_key = source_event_key;

alter table public.transactional_notices
  alter column source_event_key set not null;

create unique index transactional_notices_identity
  on public.transactional_notices (
    source_event_key,
    notice_type,
    lower(recipient_email),
    coalesce(recipient_member_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- The original Invitation command inserts its outbox row after the Invitation
-- row itself. Populate actor/routing identity in the existing before-insert
-- trigger without changing that command's already-tested transaction shape.
create or replace function public.populate_notice_member_ids_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if NEW.source_event_key is null then NEW.source_event_key := NEW.event_key; end if;
  if NEW.recipient_member_id is null then
    select id into NEW.recipient_member_id from auth.users
     where lower(email) = lower(NEW.recipient_email) limit 1;
  end if;
  if NEW.inviter_member_id is null then
    select inviter_id into NEW.inviter_member_id from public.invitations
     where NEW.event_key = 'invitation:' || id || ':created' limit 1;
  end if;
  if NEW.notice_type = 'invitation' and NEW.invitation_id is null then
    select id into NEW.invitation_id from public.invitations
     where NEW.event_key = 'invitation:' || id || ':created' limit 1;
  end if;
  if NEW.notice_type = 'invitation' and NEW.actor_member_id is null then
    NEW.actor_member_id := NEW.inviter_member_id;
  end if;
  if NEW.event_key = NEW.source_event_key then
    NEW.event_key := 'notice:' || md5(concat_ws('|', NEW.source_event_key, NEW.notice_type,
      lower(NEW.recipient_email), coalesce(NEW.recipient_member_id::text, '')));
  end if;
  return NEW;
end;
$$;

create index transactional_notices_delivery_queue
  on public.transactional_notices (created_at, id)
 where delivery_state = 'queued';

-- Product mail is a closed set. Auth OTPs use the Supabase Auth provider and
-- never enter this product outbox. A composite input keeps routing identity
-- together so callers cannot accidentally swap recipient/type fields.
create type public.transactional_notice_input as (
  source_event_key text,
  notice_type text,
  recipient_email text,
  recipient_member_id uuid,
  actor_member_id uuid,
  invitation_id uuid,
  challenge_id uuid,
  inviter_display_name text
);

create or replace function public.queue_transactional_notice_v1(p_notice public.transactional_notice_input)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  notice_id uuid;
  clean_email text := lower(btrim(coalesce(p_notice.recipient_email, '')));
  derived_event_key text;
begin
  if p_notice.source_event_key is null or btrim(p_notice.source_event_key) = '' then
    raise exception 'Transactional Notice event identity is required.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.transactional_notice_types type_row
    where type_row.notice_type = p_notice.notice_type and type_row.product_email) then
    raise exception 'The event is not permitted to send a Transactional Notice.' using errcode = '22023';
  end if;
  if clean_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
    raise exception 'Transactional Notice recipient is invalid.' using errcode = '22023';
  end if;
  if p_notice.recipient_member_id is not null and p_notice.actor_member_id is not null
    and p_notice.recipient_member_id = p_notice.actor_member_id then
    return null;
  end if;

  derived_event_key := 'notice:' || md5(concat_ws('|', p_notice.source_event_key,
    p_notice.notice_type, clean_email, coalesce(p_notice.recipient_member_id::text, '')));

  insert into public.transactional_notices(
    event_key, source_event_key, notice_type, recipient_email, recipient_member_id,
    inviter_display_name, actor_member_id, invitation_id, challenge_id
  ) values (
    derived_event_key, p_notice.source_event_key, p_notice.notice_type, clean_email, p_notice.recipient_member_id,
    coalesce(nullif(btrim(p_notice.inviter_display_name), ''), 'A Member'),
    p_notice.actor_member_id, p_notice.invitation_id, p_notice.challenge_id
  ) on conflict do nothing
  returning id into notice_id;
  return notice_id;
end;
$$;

-- Claim before provider I/O. A claimed row is never selected again, including
-- after a worker restart following an uncertain provider response. This is the
-- product-level at-most-once boundary; provider-side retries use the same
-- event key as their idempotency key where supported.
create or replace function public.claim_transactional_notice_v1(p_event_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  notice_row public.transactional_notices;
begin
  update public.transactional_notices
     set delivery_state = 'claimed', claimed_at = clock_timestamp()
   where (event_key = p_event_key or source_event_key = p_event_key)
     and delivery_state = 'queued'
  returning * into notice_row;
  if not found then return null; end if;
  return to_jsonb(notice_row);
end;
$$;

create or replace function public.mark_transactional_notice_delivered_v1(
  p_notice_id uuid,
  p_provider_message_id text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed boolean := false;
begin
  update public.transactional_notices
     set delivery_state = 'delivered',
         delivered_at = coalesce(delivered_at, clock_timestamp()),
         provider_message_id = coalesce(p_provider_message_id, provider_message_id)
   where id = p_notice_id and delivery_state = 'claimed'
  returning true into changed;
  return coalesce(changed, false);
end;
$$;

-- Invitation terminal transitions notify only the non-actor. Expiration and
-- automatic activation do not enter this trigger and therefore stay silent.
create or replace function public.enqueue_invitation_transactional_notice_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  recipient_id uuid;
  recipient_email text;
  actor_id uuid := (select auth.uid());
  event_type text;
begin
  if NEW.deleted_member_record_id is not null
    or OLD.status = NEW.status
    or NEW.status not in ('accepted', 'declined', 'revoked') then
    return NEW;
  end if;

  if NEW.status = 'accepted' then
    event_type := 'invitation_accepted';
  elsif NEW.status = 'declined' then
    event_type := 'invitation_declined';
  else
    event_type := 'invitation_revoked';
  end if;

  if event_type = 'invitation_revoked' then
    select user_row.id, lower(user_row.email)
      into recipient_id, recipient_email
      from auth.users user_row
     where lower(user_row.email) = lower(NEW.invited_email)
     limit 1;
  else
    recipient_id := NEW.inviter_id;
    select lower(email) into recipient_email from auth.users where id = recipient_id;
  end if;
  if recipient_email is null or (recipient_id is not null and recipient_id = actor_id) then
    return NEW;
  end if;

  perform public.queue_transactional_notice_v1(row(
    'invitation:' || NEW.id || ':' || replace(event_type, 'invitation_', ''),
    event_type,
    recipient_email,
    recipient_id,
    actor_id,
    NEW.id,
    null,
    (select display_name from public.member_accounts where id = NEW.inviter_id)
  )::public.transactional_notice_input);
  return NEW;
end;
$$;

drop trigger if exists invitations_transactional_notice on public.invitations;
create trigger invitations_transactional_notice
after update of status on public.invitations
for each row execute function public.enqueue_invitation_transactional_notice_v1();

-- Challenge terminal transitions notify only the other Challenge Member. A
-- terminal outcome caused by deadline, completion, or automatic activation is
-- intentionally absent from this trigger and produces no email.
create or replace function public.enqueue_challenge_transactional_notice_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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
    select original_member_id into original_actor_id
      from public.deleted_member_records
     where id = NEW.deleted_member_record_id;
    event_suffix := 'account-ended';
  elsif NEW.status = 'canceled' and OLD.status is distinct from NEW.status then
    event_type := 'challenge_canceled';
    actor_id := coalesce((select auth.uid()), NEW.terminal_actor_id);
    event_suffix := 'canceled';
  elsif NEW.status = 'abandoned' and OLD.status is distinct from NEW.status then
    event_type := 'challenge_abandoned';
    actor_id := coalesce((select auth.uid()), NEW.terminal_actor_id);
    event_suffix := 'abandoned';
  else
    return NEW;
  end if;

  select member_row.member_id, member_row.member_email
    into recipient_id, recipient_email
   from public.challenge_members member_row
   where member_row.challenge_id = NEW.id
     and member_row.member_id is distinct from actor_id
     and member_row.member_id is distinct from original_actor_id
   order by member_row.member_id
   limit 1;
  if recipient_email is null or (recipient_id is not null and recipient_id = actor_id) then
    return NEW;
  end if;

  perform public.queue_transactional_notice_v1(row(
    'challenge:' || NEW.id || ':' || event_suffix,
    event_type,
    recipient_email,
    recipient_id,
    actor_id,
    null,
    NEW.id,
    null
  )::public.transactional_notice_input);
  return NEW;
end;
$$;

drop trigger if exists challenges_transactional_notice on public.challenges;
create trigger challenges_transactional_notice
after update of status, deleted_member_record_id on public.challenges
for each row execute function public.enqueue_challenge_transactional_notice_v1();

revoke all on function public.queue_transactional_notice_v1(public.transactional_notice_input) from public, anon, authenticated;
revoke all on function public.claim_transactional_notice_v1(text) from public, anon, authenticated;
revoke all on function public.mark_transactional_notice_delivered_v1(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_transactional_notice_v1(text) to service_role;
grant execute on function public.mark_transactional_notice_delivered_v1(uuid, text) to service_role;
grant select, update on public.transactional_notices to service_role;

create or replace function public.foundation_health_v1()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'service', 'larp-code', 'schemaVersion', 12, 'serverTime', statement_timestamp(),
    'minimumClientVersion', '0.1.0'
  );
$$;
revoke all on function public.foundation_health_v1() from public;
grant execute on function public.foundation_health_v1() to anon, authenticated;
-- Migration history note: 20260815110000 is retained by the compatible
-- contract backfill; this migration uses 110100 to keep every version unique.
