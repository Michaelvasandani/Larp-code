-- Ticket 23: the catalog is an offline, reviewed import. Runtime code never
-- synchronizes or fetches NeetCode/LeetCode pages.
create table public.problem_set_versions (
  id text primary key,
  source_repository_url text not null,
  source_data_file text not null,
  source_commit_sha text not null check (source_commit_sha ~ '^[0-9a-f]{40}$'),
  license_notice text not null,
  non_affiliation_notice text not null,
  imported_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp()
);

-- The reviewed pointer is the only mutable catalog selection. The versions and
-- records themselves are append-only so invitations can always be replayed.
create table public.catalog_current_problem_set_version (
  version_id text primary key references public.problem_set_versions(id)
);

create table public.problems (
  id text primary key,
  source_code text not null unique,
  slug text not null,
  title text not null,
  pattern text not null,
  difficulty text not null check (difficulty in ('Easy', 'Medium', 'Hard')),
  public_url text not null check (public_url ~ '^https://leetcode[.]com/problems/[a-z0-9]+(-[a-z0-9]+)*/$')
);

create table public.problem_set_version_problems (
  problem_set_version_id text not null references public.problem_set_versions(id),
  problem_id text not null references public.problems(id),
  source_code text not null,
  slug text not null,
  title text not null,
  pattern text not null,
  difficulty text not null check (difficulty in ('Easy', 'Medium', 'Hard')),
  public_url text not null check (public_url ~ '^https://leetcode[.]com/problems/[a-z0-9]+(-[a-z0-9]+)*/$'),
  list_order integer not null check (list_order between 1 and 150),
  primary key (problem_set_version_id, problem_id),
  unique (problem_set_version_id, list_order)
);

alter table public.problem_set_versions enable row level security;
alter table public.problems enable row level security;
alter table public.problem_set_version_problems enable row level security;
revoke all on table public.problem_set_versions, public.problems, public.problem_set_version_problems from anon, authenticated;
alter table public.catalog_current_problem_set_version enable row level security;
revoke all on table public.catalog_current_problem_set_version from anon, authenticated;

create or replace function public.reject_problem_set_version_update_v1()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Problem Set Versions are immutable; import a new reviewed version.' using errcode = '22023';
end;
$$;

create trigger problem_set_versions_immutable
before update or delete on public.problem_set_versions
for each row execute function public.reject_problem_set_version_update_v1();

create or replace function public.reject_catalog_record_update_v1()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Imported catalog records are immutable; create a new Problem Set Version.' using errcode = '22023';
end;
$$;

create trigger problems_immutable
before update or delete on public.problems
for each row execute function public.reject_catalog_record_update_v1();
create trigger problem_set_version_problems_immutable
before update or delete on public.problem_set_version_problems
for each row execute function public.reject_catalog_record_update_v1();

create or replace function public.problem_set_version_json_v1(version_row public.problem_set_versions)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', version_row.id,
    'sourceRepository', version_row.source_repository_url,
    'sourceDataFile', version_row.source_data_file,
    'sourceCommitSha', version_row.source_commit_sha,
    'licenseNotice', version_row.license_notice,
    'nonAffiliationNotice', version_row.non_affiliation_notice,
    'importedAt', version_row.imported_at
  );
$$;

create or replace function public.assert_problem_set_version_complete_v1(p_version_id text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  problem_count integer;
begin
  select count(*) into problem_count
  from public.problem_set_version_problems
  where problem_set_version_id = p_version_id;
  if problem_count <> 150 then
    raise exception 'The reviewed Problem Set Version must contain exactly 150 problems.' using errcode = '22023';
  end if;
  return true;
end;
$$;

create or replace function public.get_problem_set_version_v1(p_version_id text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.problem_set_version_json_v1(version_row) || jsonb_build_object(
    'problems', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', item.problem_id,
        'sourceCode', item.source_code,
        'slug', item.slug,
        'title', item.title,
        'pattern', item.pattern,
        'difficulty', item.difficulty,
        'listOrder', item.list_order,
        'publicUrl', item.public_url
      ) order by item.list_order)
      from public.problem_set_version_problems item
      where item.problem_set_version_id = version_row.id
    ), '[]'::jsonb)
  )
  from public.problem_set_versions version_row
  where version_row.id = p_version_id
    and public.assert_problem_set_version_complete_v1(version_row.id);
$$;

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  inviter_id uuid not null references auth.users(id),
  invited_email text not null check (length(invited_email) between 3 and 320),
  challenge_time_zone text not null,
  start_date date not null,
  deadline_date date not null,
  problem_set_version_id text not null references public.problem_set_versions(id),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'declined', 'expired')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint invitations_ordered_dates check (deadline_date >= start_date)
);

create unique index invitations_one_pending_outgoing
on public.invitations (inviter_id) where status = 'pending';
create index invitations_invited_email_status on public.invitations (invited_email, status);

create or replace function public.reject_invitation_term_update_v1()
returns trigger language plpgsql set search_path = '' as $$
begin
  if row(NEW.inviter_id, NEW.invited_email, NEW.challenge_time_zone, NEW.start_date,
    NEW.deadline_date, NEW.problem_set_version_id)
    is distinct from row(OLD.inviter_id, OLD.invited_email, OLD.challenge_time_zone, OLD.start_date,
    OLD.deadline_date, OLD.problem_set_version_id) then
    raise exception 'Invitation terms are immutable; create a replacement Invitation.' using errcode = '22023';
  end if;
  NEW.updated_at := clock_timestamp();
  return NEW;
end;
$$;

create trigger invitations_terms_immutable
before update on public.invitations
for each row execute function public.reject_invitation_term_update_v1();

alter table public.invitations enable row level security;
revoke all on table public.invitations from anon, authenticated;

create table public.transactional_notices (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  notice_type text not null check (notice_type = 'invitation'),
  recipient_email text not null,
  recipient_member_id uuid references auth.users(id),
  inviter_display_name text not null,
  created_at timestamptz not null default clock_timestamp(),
  delivered_at timestamptz
);

alter table public.transactional_notices enable row level security;
revoke all on table public.transactional_notices from anon, authenticated;

create table public.invitation_rate_limits (
  member_id uuid not null references auth.users(id) on delete cascade,
  destination_email text not null,
  window_started_at timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0),
  primary key (member_id, destination_email, window_started_at)
);

alter table public.invitation_rate_limits enable row level security;
revoke all on table public.invitation_rate_limits from anon, authenticated;

create or replace function public.invitation_json_v1(invitation_row public.invitations)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', invitation_row.id,
    'inviterId', invitation_row.inviter_id,
    'inviterDisplayName', coalesce((select display_name from public.member_accounts where id = invitation_row.inviter_id), 'A Member'),
    'invitedEmail', invitation_row.invited_email,
    'timeZone', invitation_row.challenge_time_zone,
    'startDate', invitation_row.start_date,
    'deadlineDate', invitation_row.deadline_date,
    'problemSetVersionId', invitation_row.problem_set_version_id,
    'status', invitation_row.status,
    'createdAt', invitation_row.created_at
  );
$$;

create or replace function public.get_pending_invitation_for_member_v1()
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.invitation_json_v1(invitation_row)
  from public.invitations invitation_row
  join auth.users invited_user on lower(invited_user.email) = lower(invitation_row.invited_email)
  where invited_user.id = (select auth.uid())
    and invitation_row.status = 'pending'
  order by invitation_row.created_at asc
  limit 1;
$$;

create or replace function public.create_invitation_v1(
  p_idempotency_key uuid,
  p_command_version integer,
  p_command_kind text,
  p_member_id uuid,
  p_member_email text,
  p_invited_email text,
  p_challenge_time_zone text,
  p_start_date date,
  p_deadline_date date,
  p_problem_set_version_id text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_member uuid := (select auth.uid());
  verified_email text;
  account_row public.member_accounts;
  version_row public.problem_set_versions;
  invitation_row public.invitations;
  command_result jsonb;
  clean_destination text := lower(btrim(coalesce(p_invited_email, '')));
  claimed boolean := false;
  window_start timestamptz := date_trunc('hour', clock_timestamp());
  attempt_count integer;
begin
  if current_member is null or p_member_id is distinct from current_member then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_command_version is distinct from 1 or p_command_kind is distinct from 'create_invitation' then
    raise exception 'The command version is no longer current.' using errcode = '22023';
  end if;
  select lower(email) into verified_email from auth.users
    where id = current_member and email is not null and email_confirmed_at is not null;
  if verified_email is null or lower(btrim(coalesce(p_member_email, ''))) is distinct from verified_email then
    raise exception 'A verified email is required.' using errcode = '42501';
  end if;
  select * into account_row from public.member_accounts where id = current_member and status = 'active';
  if not found then raise exception 'A Member Account is required.' using errcode = '42501'; end if;

  -- A replay returns the stored result before any rate-limit or domain effect.
  select result into command_result from public.member_command_idempotency
    where member_id = current_member and idempotency_key = p_idempotency_key
      and command_kind = 'create_invitation' and command_version = 1;
  if found and command_result is not null then return command_result; end if;

  if clean_destination !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(clean_destination) > 320 then
    raise exception 'Enter one valid invited email address.' using errcode = '22023';
  end if;
  if not exists (select 1 from pg_timezone_names where name = p_challenge_time_zone) then
    raise exception 'Choose a valid IANA Challenge Time Zone.' using errcode = '22023';
  end if;
  if p_deadline_date < p_start_date then
    raise exception 'Deadline Date must be on or after Start Date.' using errcode = '22023';
  end if;
  if p_start_date < ((clock_timestamp() at time zone p_challenge_time_zone)::date + 1) then
    raise exception 'Start Date must be the next calendar day or later in the Challenge Time Zone.' using errcode = '22023';
  end if;
  -- The backend chooses the explicit current reviewed version. A client-provided
  -- version is an expected identity only; it can never pin an obsolete edition.
  select version.* into version_row
  from public.problem_set_versions version
  join public.catalog_current_problem_set_version current_version
    on current_version.version_id = version.id;
  if not found then raise exception 'The reviewed Problem Set Version is unavailable.' using errcode = '22023'; end if;
  perform public.assert_problem_set_version_complete_v1(version_row.id);
  if p_problem_set_version_id is not null and p_problem_set_version_id is distinct from version_row.id then
    raise exception 'The reviewed Problem Set Version is no longer current.' using errcode = '22023';
  end if;

  insert into public.invitation_rate_limits(member_id, destination_email, window_started_at, attempts)
    values (current_member, clean_destination, window_start, 1)
    on conflict (member_id, destination_email, window_started_at)
    do update set attempts = public.invitation_rate_limits.attempts + 1
    returning attempts into attempt_count;
  if attempt_count > 5 then
    raise exception 'Too many Invitations. Please wait and try again.' using errcode = 'P0002';
  end if;

  insert into public.member_command_idempotency(
    member_id, idempotency_key, command_version, command_kind, member_email, intent
  ) values (
    current_member, p_idempotency_key, 1, 'create_invitation', verified_email,
    jsonb_build_object('invitedEmail', clean_destination, 'timeZone', p_challenge_time_zone,
      'startDate', p_start_date, 'deadlineDate', p_deadline_date, 'problemSetVersionId', version_row.id)
  ) on conflict (member_id, idempotency_key) do nothing returning true into claimed;
  if not coalesce(claimed, false) then
    select result into command_result from public.member_command_idempotency
      where member_id = current_member and idempotency_key = p_idempotency_key;
    if command_result is not null then return command_result; end if;
  end if;

  insert into public.invitations(
    inviter_id, invited_email, challenge_time_zone, start_date, deadline_date, problem_set_version_id
  ) values (
    current_member, clean_destination, p_challenge_time_zone, p_start_date, p_deadline_date, version_row.id
  ) returning * into invitation_row;

  command_result := public.invitation_json_v1(invitation_row);
  update public.member_command_idempotency set result = command_result
    where member_id = current_member and idempotency_key = p_idempotency_key;

  insert into public.transactional_notices(
    event_key, notice_type, recipient_email, inviter_display_name
  ) values (
    'invitation:' || invitation_row.id || ':created', 'invitation', clean_destination, account_row.display_name
  ) on conflict (event_key) do nothing;
  return command_result;
exception
  when unique_violation then
    raise exception 'You already have a pending outgoing Invitation.' using errcode = '22023';
end;
$$;

create or replace function public.get_invitation_v1(p_invitation_id uuid)
returns jsonb language plpgsql security definer stable set search_path = '' as $$
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
  return public.invitation_json_v1(invitation_row);
end;
$$;

revoke all on function public.problem_set_version_json_v1(public.problem_set_versions) from public;
revoke all on function public.assert_problem_set_version_complete_v1(text) from public;
revoke all on function public.get_problem_set_version_v1(text) from public;
revoke all on function public.invitation_json_v1(public.invitations) from public;
revoke all on function public.get_pending_invitation_for_member_v1() from public;
revoke all on function public.create_invitation_v1(uuid, integer, text, uuid, text, text, text, date, date, text) from public;
revoke all on function public.get_invitation_v1(uuid) from public;
grant execute on function public.create_invitation_v1(uuid, integer, text, uuid, text, text, text, date, date, text) to authenticated;
grant execute on function public.get_invitation_v1(uuid) to authenticated;
grant execute on function public.get_pending_invitation_for_member_v1() to authenticated;
grant execute on function public.get_problem_set_version_v1(text) to authenticated;

create or replace function public.foundation_health_v1()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('service', 'larp-code', 'schemaVersion', 4, 'serverTime', clock_timestamp());
$$;
revoke all on function public.foundation_health_v1() from public;
grant execute on function public.foundation_health_v1() to anon, authenticated;


-- Reviewed static catalog import: generated from 150 selected records above.
insert into public.problem_set_versions (id, source_repository_url, source_data_file, source_commit_sha, license_notice, non_affiliation_notice, imported_at) values
  ('neetcode-150-2026-08-15', 'https://github.com/neetcode-gh/leetcode', '.problemSiteData.json', '5f9dbb6030c8243c933b799f7999092183d258d1', 'MIT License

Copyright (c) 2022 neetcode-gh

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.', 'larp-code is an independent product and is not affiliated with, endorsed by, or sponsored by NeetCode or LeetCode. NeetCode and LeetCode are referenced only to identify the third-party study list and problem destinations used by members.', '2026-08-15T00:00:00Z')
on conflict (id) do nothing;

insert into public.catalog_current_problem_set_version (version_id)
values ('neetcode-150-2026-08-15')
on conflict (version_id) do nothing;

insert into public.problems (id, source_code, slug, title, pattern, difficulty, public_url) values
  ('problem:0217-contains-duplicate', '0217-contains-duplicate', 'contains-duplicate', 'Contains Duplicate', 'Arrays & Hashing', 'Easy', 'https://leetcode.com/problems/contains-duplicate/'),
  ('problem:0242-valid-anagram', '0242-valid-anagram', 'valid-anagram', 'Valid Anagram', 'Arrays & Hashing', 'Easy', 'https://leetcode.com/problems/valid-anagram/'),
  ('problem:0001-two-sum', '0001-two-sum', 'two-sum', 'Two Sum', 'Arrays & Hashing', 'Easy', 'https://leetcode.com/problems/two-sum/'),
  ('problem:0049-group-anagrams', '0049-group-anagrams', 'group-anagrams', 'Group Anagrams', 'Arrays & Hashing', 'Medium', 'https://leetcode.com/problems/group-anagrams/'),
  ('problem:0347-top-k-frequent-elements', '0347-top-k-frequent-elements', 'top-k-frequent-elements', 'Top K Frequent Elements', 'Arrays & Hashing', 'Medium', 'https://leetcode.com/problems/top-k-frequent-elements/'),
  ('problem:0238-product-of-array-except-self', '0238-product-of-array-except-self', 'product-of-array-except-self', 'Product of Array Except Self', 'Arrays & Hashing', 'Medium', 'https://leetcode.com/problems/product-of-array-except-self/'),
  ('problem:0036-valid-sudoku', '0036-valid-sudoku', 'valid-sudoku', 'Valid Sudoku', 'Arrays & Hashing', 'Medium', 'https://leetcode.com/problems/valid-sudoku/'),
  ('problem:0271-encode-and-decode-strings', '0271-encode-and-decode-strings', 'encode-and-decode-strings', 'Encode and Decode Strings', 'Arrays & Hashing', 'Medium', 'https://leetcode.com/problems/encode-and-decode-strings/'),
  ('problem:0128-longest-consecutive-sequence', '0128-longest-consecutive-sequence', 'longest-consecutive-sequence', 'Longest Consecutive Sequence', 'Arrays & Hashing', 'Medium', 'https://leetcode.com/problems/longest-consecutive-sequence/'),
  ('problem:0125-valid-palindrome', '0125-valid-palindrome', 'valid-palindrome', 'Valid Palindrome', 'Two Pointers', 'Easy', 'https://leetcode.com/problems/valid-palindrome/'),
  ('problem:0167-two-sum-ii-input-array-is-sorted', '0167-two-sum-ii-input-array-is-sorted', 'two-sum-ii-input-array-is-sorted', 'Two Sum II Input Array Is Sorted', 'Two Pointers', 'Medium', 'https://leetcode.com/problems/two-sum-ii-input-array-is-sorted/'),
  ('problem:0015-3sum', '0015-3sum', '3sum', '3Sum', 'Two Pointers', 'Medium', 'https://leetcode.com/problems/3sum/'),
  ('problem:0011-container-with-most-water', '0011-container-with-most-water', 'container-with-most-water', 'Container With Most Water', 'Two Pointers', 'Medium', 'https://leetcode.com/problems/container-with-most-water/'),
  ('problem:0042-trapping-rain-water', '0042-trapping-rain-water', 'trapping-rain-water', 'Trapping Rain Water', 'Two Pointers', 'Hard', 'https://leetcode.com/problems/trapping-rain-water/'),
  ('problem:0121-best-time-to-buy-and-sell-stock', '0121-best-time-to-buy-and-sell-stock', 'best-time-to-buy-and-sell-stock', 'Best Time to Buy And Sell Stock', 'Sliding Window', 'Easy', 'https://leetcode.com/problems/best-time-to-buy-and-sell-stock/'),
  ('problem:0003-longest-substring-without-repeating-characters', '0003-longest-substring-without-repeating-characters', 'longest-substring-without-repeating-characters', 'Longest Substring Without Repeating Characters', 'Sliding Window', 'Medium', 'https://leetcode.com/problems/longest-substring-without-repeating-characters/'),
  ('problem:0424-longest-repeating-character-replacement', '0424-longest-repeating-character-replacement', 'longest-repeating-character-replacement', 'Longest Repeating Character Replacement', 'Sliding Window', 'Medium', 'https://leetcode.com/problems/longest-repeating-character-replacement/'),
  ('problem:0567-permutation-in-string', '0567-permutation-in-string', 'permutation-in-string', 'Permutation In String', 'Sliding Window', 'Medium', 'https://leetcode.com/problems/permutation-in-string/'),
  ('problem:0076-minimum-window-substring', '0076-minimum-window-substring', 'minimum-window-substring', 'Minimum Window Substring', 'Sliding Window', 'Hard', 'https://leetcode.com/problems/minimum-window-substring/'),
  ('problem:0239-sliding-window-maximum', '0239-sliding-window-maximum', 'sliding-window-maximum', 'Sliding Window Maximum', 'Sliding Window', 'Hard', 'https://leetcode.com/problems/sliding-window-maximum/'),
  ('problem:0020-valid-parentheses', '0020-valid-parentheses', 'valid-parentheses', 'Valid Parentheses', 'Stack', 'Easy', 'https://leetcode.com/problems/valid-parentheses/'),
  ('problem:0155-min-stack', '0155-min-stack', 'min-stack', 'Min Stack', 'Stack', 'Medium', 'https://leetcode.com/problems/min-stack/'),
  ('problem:0150-evaluate-reverse-polish-notation', '0150-evaluate-reverse-polish-notation', 'evaluate-reverse-polish-notation', 'Evaluate Reverse Polish Notation', 'Stack', 'Medium', 'https://leetcode.com/problems/evaluate-reverse-polish-notation/'),
  ('problem:0022-generate-parentheses', '0022-generate-parentheses', 'generate-parentheses', 'Generate Parentheses', 'Stack', 'Medium', 'https://leetcode.com/problems/generate-parentheses/'),
  ('problem:0739-daily-temperatures', '0739-daily-temperatures', 'daily-temperatures', 'Daily Temperatures', 'Stack', 'Medium', 'https://leetcode.com/problems/daily-temperatures/'),
  ('problem:0853-car-fleet', '0853-car-fleet', 'car-fleet', 'Car Fleet', 'Stack', 'Medium', 'https://leetcode.com/problems/car-fleet/'),
  ('problem:0084-largest-rectangle-in-histogram', '0084-largest-rectangle-in-histogram', 'largest-rectangle-in-histogram', 'Largest Rectangle In Histogram', 'Stack', 'Hard', 'https://leetcode.com/problems/largest-rectangle-in-histogram/'),
  ('problem:0704-binary-search', '0704-binary-search', 'binary-search', 'Binary Search', 'Binary Search', 'Easy', 'https://leetcode.com/problems/binary-search/'),
  ('problem:0074-search-a-2d-matrix', '0074-search-a-2d-matrix', 'search-a-2d-matrix', 'Search a 2D Matrix', 'Binary Search', 'Medium', 'https://leetcode.com/problems/search-a-2d-matrix/'),
  ('problem:0875-koko-eating-bananas', '0875-koko-eating-bananas', 'koko-eating-bananas', 'Koko Eating Bananas', 'Binary Search', 'Medium', 'https://leetcode.com/problems/koko-eating-bananas/'),
  ('problem:0153-find-minimum-in-rotated-sorted-array', '0153-find-minimum-in-rotated-sorted-array', 'find-minimum-in-rotated-sorted-array', 'Find Minimum In Rotated Sorted Array', 'Binary Search', 'Medium', 'https://leetcode.com/problems/find-minimum-in-rotated-sorted-array/'),
  ('problem:0033-search-in-rotated-sorted-array', '0033-search-in-rotated-sorted-array', 'search-in-rotated-sorted-array', 'Search In Rotated Sorted Array', 'Binary Search', 'Medium', 'https://leetcode.com/problems/search-in-rotated-sorted-array/'),
  ('problem:0981-time-based-key-value-store', '0981-time-based-key-value-store', 'time-based-key-value-store', 'Time Based Key Value Store', 'Binary Search', 'Medium', 'https://leetcode.com/problems/time-based-key-value-store/'),
  ('problem:0004-median-of-two-sorted-arrays', '0004-median-of-two-sorted-arrays', 'median-of-two-sorted-arrays', 'Median of Two Sorted Arrays', 'Binary Search', 'Hard', 'https://leetcode.com/problems/median-of-two-sorted-arrays/'),
  ('problem:0206-reverse-linked-list', '0206-reverse-linked-list', 'reverse-linked-list', 'Reverse Linked List', 'Linked List', 'Easy', 'https://leetcode.com/problems/reverse-linked-list/'),
  ('problem:0021-merge-two-sorted-lists', '0021-merge-two-sorted-lists', 'merge-two-sorted-lists', 'Merge Two Sorted Lists', 'Linked List', 'Easy', 'https://leetcode.com/problems/merge-two-sorted-lists/'),
  ('problem:0143-reorder-list', '0143-reorder-list', 'reorder-list', 'Reorder List', 'Linked List', 'Medium', 'https://leetcode.com/problems/reorder-list/'),
  ('problem:0019-remove-nth-node-from-end-of-list', '0019-remove-nth-node-from-end-of-list', 'remove-nth-node-from-end-of-list', 'Remove Nth Node From End of List', 'Linked List', 'Medium', 'https://leetcode.com/problems/remove-nth-node-from-end-of-list/'),
  ('problem:0138-copy-list-with-random-pointer', '0138-copy-list-with-random-pointer', 'copy-list-with-random-pointer', 'Copy List With Random Pointer', 'Linked List', 'Medium', 'https://leetcode.com/problems/copy-list-with-random-pointer/'),
  ('problem:0002-add-two-numbers', '0002-add-two-numbers', 'add-two-numbers', 'Add Two Numbers', 'Linked List', 'Medium', 'https://leetcode.com/problems/add-two-numbers/'),
  ('problem:0141-linked-list-cycle', '0141-linked-list-cycle', 'linked-list-cycle', 'Linked List Cycle', 'Linked List', 'Easy', 'https://leetcode.com/problems/linked-list-cycle/'),
  ('problem:0287-find-the-duplicate-number', '0287-find-the-duplicate-number', 'find-the-duplicate-number', 'Find The Duplicate Number', 'Linked List', 'Medium', 'https://leetcode.com/problems/find-the-duplicate-number/'),
  ('problem:0146-lru-cache', '0146-lru-cache', 'lru-cache', 'LRU Cache', 'Linked List', 'Medium', 'https://leetcode.com/problems/lru-cache/'),
  ('problem:0023-merge-k-sorted-lists', '0023-merge-k-sorted-lists', 'merge-k-sorted-lists', 'Merge K Sorted Lists', 'Linked List', 'Hard', 'https://leetcode.com/problems/merge-k-sorted-lists/'),
  ('problem:0025-reverse-nodes-in-k-group', '0025-reverse-nodes-in-k-group', 'reverse-nodes-in-k-group', 'Reverse Nodes In K Group', 'Linked List', 'Hard', 'https://leetcode.com/problems/reverse-nodes-in-k-group/'),
  ('problem:0226-invert-binary-tree', '0226-invert-binary-tree', 'invert-binary-tree', 'Invert Binary Tree', 'Trees', 'Easy', 'https://leetcode.com/problems/invert-binary-tree/'),
  ('problem:0104-maximum-depth-of-binary-tree', '0104-maximum-depth-of-binary-tree', 'maximum-depth-of-binary-tree', 'Maximum Depth of Binary Tree', 'Trees', 'Easy', 'https://leetcode.com/problems/maximum-depth-of-binary-tree/'),
  ('problem:0543-diameter-of-binary-tree', '0543-diameter-of-binary-tree', 'diameter-of-binary-tree', 'Diameter of Binary Tree', 'Trees', 'Easy', 'https://leetcode.com/problems/diameter-of-binary-tree/'),
  ('problem:0110-balanced-binary-tree', '0110-balanced-binary-tree', 'balanced-binary-tree', 'Balanced Binary Tree', 'Trees', 'Easy', 'https://leetcode.com/problems/balanced-binary-tree/'),
  ('problem:0100-same-tree', '0100-same-tree', 'same-tree', 'Same Tree', 'Trees', 'Easy', 'https://leetcode.com/problems/same-tree/'),
  ('problem:0572-subtree-of-another-tree', '0572-subtree-of-another-tree', 'subtree-of-another-tree', 'Subtree of Another Tree', 'Trees', 'Easy', 'https://leetcode.com/problems/subtree-of-another-tree/'),
  ('problem:0235-lowest-common-ancestor-of-a-binary-search-tree', '0235-lowest-common-ancestor-of-a-binary-search-tree', 'lowest-common-ancestor-of-a-binary-search-tree', 'Lowest Common Ancestor of a Binary Search Tree', 'Trees', 'Medium', 'https://leetcode.com/problems/lowest-common-ancestor-of-a-binary-search-tree/'),
  ('problem:0102-binary-tree-level-order-traversal', '0102-binary-tree-level-order-traversal', 'binary-tree-level-order-traversal', 'Binary Tree Level Order Traversal', 'Trees', 'Medium', 'https://leetcode.com/problems/binary-tree-level-order-traversal/'),
  ('problem:0199-binary-tree-right-side-view', '0199-binary-tree-right-side-view', 'binary-tree-right-side-view', 'Binary Tree Right Side View', 'Trees', 'Medium', 'https://leetcode.com/problems/binary-tree-right-side-view/'),
  ('problem:1448-count-good-nodes-in-binary-tree', '1448-count-good-nodes-in-binary-tree', 'count-good-nodes-in-binary-tree', 'Count Good Nodes In Binary Tree', 'Trees', 'Medium', 'https://leetcode.com/problems/count-good-nodes-in-binary-tree/'),
  ('problem:0098-validate-binary-search-tree', '0098-validate-binary-search-tree', 'validate-binary-search-tree', 'Validate Binary Search Tree', 'Trees', 'Medium', 'https://leetcode.com/problems/validate-binary-search-tree/'),
  ('problem:0230-kth-smallest-element-in-a-bst', '0230-kth-smallest-element-in-a-bst', 'kth-smallest-element-in-a-bst', 'Kth Smallest Element In a Bst', 'Trees', 'Medium', 'https://leetcode.com/problems/kth-smallest-element-in-a-bst/'),
  ('problem:0105-construct-binary-tree-from-preorder-and-inorder-traversal', '0105-construct-binary-tree-from-preorder-and-inorder-traversal', 'construct-binary-tree-from-preorder-and-inorder-traversal', 'Construct Binary Tree From Preorder And Inorder Traversal', 'Trees', 'Medium', 'https://leetcode.com/problems/construct-binary-tree-from-preorder-and-inorder-traversal/'),
  ('problem:0124-binary-tree-maximum-path-sum', '0124-binary-tree-maximum-path-sum', 'binary-tree-maximum-path-sum', 'Binary Tree Maximum Path Sum', 'Trees', 'Hard', 'https://leetcode.com/problems/binary-tree-maximum-path-sum/'),
  ('problem:0297-serialize-and-deserialize-binary-tree', '0297-serialize-and-deserialize-binary-tree', 'serialize-and-deserialize-binary-tree', 'Serialize And Deserialize Binary Tree', 'Trees', 'Hard', 'https://leetcode.com/problems/serialize-and-deserialize-binary-tree/'),
  ('problem:0208-implement-trie-prefix-tree', '0208-implement-trie-prefix-tree', 'implement-trie-prefix-tree', 'Implement Trie Prefix Tree', 'Tries', 'Medium', 'https://leetcode.com/problems/implement-trie-prefix-tree/'),
  ('problem:0211-design-add-and-search-words-data-structure', '0211-design-add-and-search-words-data-structure', 'design-add-and-search-words-data-structure', 'Design Add And Search Words Data Structure', 'Tries', 'Medium', 'https://leetcode.com/problems/design-add-and-search-words-data-structure/'),
  ('problem:0212-word-search-ii', '0212-word-search-ii', 'word-search-ii', 'Word Search II', 'Tries', 'Hard', 'https://leetcode.com/problems/word-search-ii/'),
  ('problem:0703-kth-largest-element-in-a-stream', '0703-kth-largest-element-in-a-stream', 'kth-largest-element-in-a-stream', 'Kth Largest Element In a Stream', 'Heap / Priority Queue', 'Easy', 'https://leetcode.com/problems/kth-largest-element-in-a-stream/'),
  ('problem:1046-last-stone-weight', '1046-last-stone-weight', 'last-stone-weight', 'Last Stone Weight', 'Heap / Priority Queue', 'Easy', 'https://leetcode.com/problems/last-stone-weight/'),
  ('problem:0973-k-closest-points-to-origin', '0973-k-closest-points-to-origin', 'k-closest-points-to-origin', 'K Closest Points to Origin', 'Heap / Priority Queue', 'Medium', 'https://leetcode.com/problems/k-closest-points-to-origin/'),
  ('problem:0215-kth-largest-element-in-an-array', '0215-kth-largest-element-in-an-array', 'kth-largest-element-in-an-array', 'Kth Largest Element In An Array', 'Heap / Priority Queue', 'Medium', 'https://leetcode.com/problems/kth-largest-element-in-an-array/'),
  ('problem:0621-task-scheduler', '0621-task-scheduler', 'task-scheduler', 'Task Scheduler', 'Heap / Priority Queue', 'Medium', 'https://leetcode.com/problems/task-scheduler/'),
  ('problem:0355-design-twitter', '0355-design-twitter', 'design-twitter', 'Design Twitter', 'Heap / Priority Queue', 'Medium', 'https://leetcode.com/problems/design-twitter/'),
  ('problem:0295-find-median-from-data-stream', '0295-find-median-from-data-stream', 'find-median-from-data-stream', 'Find Median From Data Stream', 'Heap / Priority Queue', 'Hard', 'https://leetcode.com/problems/find-median-from-data-stream/'),
  ('problem:0078-subsets', '0078-subsets', 'subsets', 'Subsets', 'Backtracking', 'Medium', 'https://leetcode.com/problems/subsets/'),
  ('problem:0039-combination-sum', '0039-combination-sum', 'combination-sum', 'Combination Sum', 'Backtracking', 'Medium', 'https://leetcode.com/problems/combination-sum/'),
  ('problem:0046-permutations', '0046-permutations', 'permutations', 'Permutations', 'Backtracking', 'Medium', 'https://leetcode.com/problems/permutations/'),
  ('problem:0090-subsets-ii', '0090-subsets-ii', 'subsets-ii', 'Subsets II', 'Backtracking', 'Medium', 'https://leetcode.com/problems/subsets-ii/'),
  ('problem:0040-combination-sum-ii', '0040-combination-sum-ii', 'combination-sum-ii', 'Combination Sum II', 'Backtracking', 'Medium', 'https://leetcode.com/problems/combination-sum-ii/'),
  ('problem:0079-word-search', '0079-word-search', 'word-search', 'Word Search', 'Backtracking', 'Medium', 'https://leetcode.com/problems/word-search/'),
  ('problem:0131-palindrome-partitioning', '0131-palindrome-partitioning', 'palindrome-partitioning', 'Palindrome Partitioning', 'Backtracking', 'Medium', 'https://leetcode.com/problems/palindrome-partitioning/'),
  ('problem:0017-letter-combinations-of-a-phone-number', '0017-letter-combinations-of-a-phone-number', 'letter-combinations-of-a-phone-number', 'Letter Combinations of a Phone Number', 'Backtracking', 'Medium', 'https://leetcode.com/problems/letter-combinations-of-a-phone-number/'),
  ('problem:0051-n-queens', '0051-n-queens', 'n-queens', 'N Queens', 'Backtracking', 'Hard', 'https://leetcode.com/problems/n-queens/'),
  ('problem:0200-number-of-islands', '0200-number-of-islands', 'number-of-islands', 'Number of Islands', 'Graphs', 'Medium', 'https://leetcode.com/problems/number-of-islands/'),
  ('problem:0133-clone-graph', '0133-clone-graph', 'clone-graph', 'Clone Graph', 'Graphs', 'Medium', 'https://leetcode.com/problems/clone-graph/'),
  ('problem:0695-max-area-of-island', '0695-max-area-of-island', 'max-area-of-island', 'Max Area of Island', 'Graphs', 'Medium', 'https://leetcode.com/problems/max-area-of-island/'),
  ('problem:0417-pacific-atlantic-water-flow', '0417-pacific-atlantic-water-flow', 'pacific-atlantic-water-flow', 'Pacific Atlantic Water Flow', 'Graphs', 'Medium', 'https://leetcode.com/problems/pacific-atlantic-water-flow/'),
  ('problem:0130-surrounded-regions', '0130-surrounded-regions', 'surrounded-regions', 'Surrounded Regions', 'Graphs', 'Medium', 'https://leetcode.com/problems/surrounded-regions/'),
  ('problem:0994-rotting-oranges', '0994-rotting-oranges', 'rotting-oranges', 'Rotting Oranges', 'Graphs', 'Medium', 'https://leetcode.com/problems/rotting-oranges/'),
  ('problem:0286-walls-and-gates', '0286-walls-and-gates', 'walls-and-gates', 'Walls And Gates', 'Graphs', 'Medium', 'https://leetcode.com/problems/walls-and-gates/'),
  ('problem:0207-course-schedule', '0207-course-schedule', 'course-schedule', 'Course Schedule', 'Graphs', 'Medium', 'https://leetcode.com/problems/course-schedule/'),
  ('problem:0210-course-schedule-ii', '0210-course-schedule-ii', 'course-schedule-ii', 'Course Schedule II', 'Graphs', 'Medium', 'https://leetcode.com/problems/course-schedule-ii/'),
  ('problem:0684-redundant-connection', '0684-redundant-connection', 'redundant-connection', 'Redundant Connection', 'Graphs', 'Medium', 'https://leetcode.com/problems/redundant-connection/'),
  ('problem:0323-number-of-connected-components-in-an-undirected-graph', '0323-number-of-connected-components-in-an-undirected-graph', 'number-of-connected-components-in-an-undirected-graph', 'Number of Connected Components In An Undirected Graph', 'Graphs', 'Medium', 'https://leetcode.com/problems/number-of-connected-components-in-an-undirected-graph/'),
  ('problem:0261-graph-valid-tree', '0261-graph-valid-tree', 'graph-valid-tree', 'Graph Valid Tree', 'Graphs', 'Medium', 'https://leetcode.com/problems/graph-valid-tree/'),
  ('problem:0127-word-ladder', '0127-word-ladder', 'word-ladder', 'Word Ladder', 'Graphs', 'Hard', 'https://leetcode.com/problems/word-ladder/'),
  ('problem:0332-reconstruct-itinerary', '0332-reconstruct-itinerary', 'reconstruct-itinerary', 'Reconstruct Itinerary', 'Advanced Graphs', 'Hard', 'https://leetcode.com/problems/reconstruct-itinerary/'),
  ('problem:1584-min-cost-to-connect-all-points', '1584-min-cost-to-connect-all-points', 'min-cost-to-connect-all-points', 'Min Cost to Connect All Points', 'Advanced Graphs', 'Medium', 'https://leetcode.com/problems/min-cost-to-connect-all-points/'),
  ('problem:0743-network-delay-time', '0743-network-delay-time', 'network-delay-time', 'Network Delay Time', 'Advanced Graphs', 'Medium', 'https://leetcode.com/problems/network-delay-time/'),
  ('problem:0778-swim-in-rising-water', '0778-swim-in-rising-water', 'swim-in-rising-water', 'Swim In Rising Water', 'Advanced Graphs', 'Hard', 'https://leetcode.com/problems/swim-in-rising-water/'),
  ('problem:0269-alien-dictionary', '0269-alien-dictionary', 'alien-dictionary', 'Alien Dictionary', 'Advanced Graphs', 'Hard', 'https://leetcode.com/problems/alien-dictionary/'),
  ('problem:0787-cheapest-flights-within-k-stops', '0787-cheapest-flights-within-k-stops', 'cheapest-flights-within-k-stops', 'Cheapest Flights Within K Stops', 'Advanced Graphs', 'Medium', 'https://leetcode.com/problems/cheapest-flights-within-k-stops/'),
  ('problem:0070-climbing-stairs', '0070-climbing-stairs', 'climbing-stairs', 'Climbing Stairs', '1-D Dynamic Programming', 'Easy', 'https://leetcode.com/problems/climbing-stairs/'),
  ('problem:0746-min-cost-climbing-stairs', '0746-min-cost-climbing-stairs', 'min-cost-climbing-stairs', 'Min Cost Climbing Stairs', '1-D Dynamic Programming', 'Easy', 'https://leetcode.com/problems/min-cost-climbing-stairs/'),
  ('problem:0198-house-robber', '0198-house-robber', 'house-robber', 'House Robber', '1-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/house-robber/'),
  ('problem:0213-house-robber-ii', '0213-house-robber-ii', 'house-robber-ii', 'House Robber II', '1-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/house-robber-ii/'),
  ('problem:0005-longest-palindromic-substring', '0005-longest-palindromic-substring', 'longest-palindromic-substring', 'Longest Palindromic Substring', '1-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/longest-palindromic-substring/'),
  ('problem:0647-palindromic-substrings', '0647-palindromic-substrings', 'palindromic-substrings', 'Palindromic Substrings', '1-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/palindromic-substrings/'),
  ('problem:0091-decode-ways', '0091-decode-ways', 'decode-ways', 'Decode Ways', '1-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/decode-ways/'),
  ('problem:0322-coin-change', '0322-coin-change', 'coin-change', 'Coin Change', '1-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/coin-change/'),
  ('problem:0152-maximum-product-subarray', '0152-maximum-product-subarray', 'maximum-product-subarray', 'Maximum Product Subarray', '1-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/maximum-product-subarray/'),
  ('problem:0139-word-break', '0139-word-break', 'word-break', 'Word Break', '1-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/word-break/'),
  ('problem:0300-longest-increasing-subsequence', '0300-longest-increasing-subsequence', 'longest-increasing-subsequence', 'Longest Increasing Subsequence', '1-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/longest-increasing-subsequence/'),
  ('problem:0416-partition-equal-subset-sum', '0416-partition-equal-subset-sum', 'partition-equal-subset-sum', 'Partition Equal Subset Sum', '1-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/partition-equal-subset-sum/'),
  ('problem:0062-unique-paths', '0062-unique-paths', 'unique-paths', 'Unique Paths', '2-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/unique-paths/'),
  ('problem:1143-longest-common-subsequence', '1143-longest-common-subsequence', 'longest-common-subsequence', 'Longest Common Subsequence', '2-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/longest-common-subsequence/'),
  ('problem:0309-best-time-to-buy-and-sell-stock-with-cooldown', '0309-best-time-to-buy-and-sell-stock-with-cooldown', 'best-time-to-buy-and-sell-stock-with-cooldown', 'Best Time to Buy And Sell Stock With Cooldown', '2-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/best-time-to-buy-and-sell-stock-with-cooldown/'),
  ('problem:0518-coin-change-ii', '0518-coin-change-ii', 'coin-change-ii', 'Coin Change II', '2-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/coin-change-ii/'),
  ('problem:0494-target-sum', '0494-target-sum', 'target-sum', 'Target Sum', '2-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/target-sum/'),
  ('problem:0097-interleaving-string', '0097-interleaving-string', 'interleaving-string', 'Interleaving String', '2-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/interleaving-string/'),
  ('problem:0329-longest-increasing-path-in-a-matrix', '0329-longest-increasing-path-in-a-matrix', 'longest-increasing-path-in-a-matrix', 'Longest Increasing Path In a Matrix', '2-D Dynamic Programming', 'Hard', 'https://leetcode.com/problems/longest-increasing-path-in-a-matrix/'),
  ('problem:0115-distinct-subsequences', '0115-distinct-subsequences', 'distinct-subsequences', 'Distinct Subsequences', '2-D Dynamic Programming', 'Hard', 'https://leetcode.com/problems/distinct-subsequences/'),
  ('problem:0072-edit-distance', '0072-edit-distance', 'edit-distance', 'Edit Distance', '2-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/edit-distance/'),
  ('problem:0312-burst-balloons', '0312-burst-balloons', 'burst-balloons', 'Burst Balloons', '2-D Dynamic Programming', 'Hard', 'https://leetcode.com/problems/burst-balloons/'),
  ('problem:0010-regular-expression-matching', '0010-regular-expression-matching', 'regular-expression-matching', 'Regular Expression Matching', '2-D Dynamic Programming', 'Hard', 'https://leetcode.com/problems/regular-expression-matching/'),
  ('problem:0053-maximum-subarray', '0053-maximum-subarray', 'maximum-subarray', 'Maximum Subarray', 'Greedy', 'Medium', 'https://leetcode.com/problems/maximum-subarray/'),
  ('problem:0055-jump-game', '0055-jump-game', 'jump-game', 'Jump Game', 'Greedy', 'Medium', 'https://leetcode.com/problems/jump-game/'),
  ('problem:0045-jump-game-ii', '0045-jump-game-ii', 'jump-game-ii', 'Jump Game II', 'Greedy', 'Medium', 'https://leetcode.com/problems/jump-game-ii/'),
  ('problem:0134-gas-station', '0134-gas-station', 'gas-station', 'Gas Station', 'Greedy', 'Medium', 'https://leetcode.com/problems/gas-station/'),
  ('problem:0846-hand-of-straights', '0846-hand-of-straights', 'hand-of-straights', 'Hand of Straights', 'Greedy', 'Medium', 'https://leetcode.com/problems/hand-of-straights/'),
  ('problem:1899-merge-triplets-to-form-target-triplet', '1899-merge-triplets-to-form-target-triplet', 'merge-triplets-to-form-target-triplet', 'Merge Triplets to Form Target Triplet', 'Greedy', 'Medium', 'https://leetcode.com/problems/merge-triplets-to-form-target-triplet/'),
  ('problem:0763-partition-labels', '0763-partition-labels', 'partition-labels', 'Partition Labels', 'Greedy', 'Medium', 'https://leetcode.com/problems/partition-labels/'),
  ('problem:0678-valid-parenthesis-string', '0678-valid-parenthesis-string', 'valid-parenthesis-string', 'Valid Parenthesis String', 'Greedy', 'Medium', 'https://leetcode.com/problems/valid-parenthesis-string/'),
  ('problem:0057-insert-interval', '0057-insert-interval', 'insert-interval', 'Insert Interval', 'Intervals', 'Medium', 'https://leetcode.com/problems/insert-interval/'),
  ('problem:0056-merge-intervals', '0056-merge-intervals', 'merge-intervals', 'Merge Intervals', 'Intervals', 'Medium', 'https://leetcode.com/problems/merge-intervals/'),
  ('problem:0435-non-overlapping-intervals', '0435-non-overlapping-intervals', 'non-overlapping-intervals', 'Non Overlapping Intervals', 'Intervals', 'Medium', 'https://leetcode.com/problems/non-overlapping-intervals/'),
  ('problem:0252-meeting-rooms', '0252-meeting-rooms', 'meeting-rooms', 'Meeting Rooms', 'Intervals', 'Easy', 'https://leetcode.com/problems/meeting-rooms/'),
  ('problem:0253-meeting-rooms-ii', '0253-meeting-rooms-ii', 'meeting-rooms-ii', 'Meeting Rooms II', 'Intervals', 'Medium', 'https://leetcode.com/problems/meeting-rooms-ii/'),
  ('problem:1851-minimum-interval-to-include-each-query', '1851-minimum-interval-to-include-each-query', 'minimum-interval-to-include-each-query', 'Minimum Interval to Include Each Query', 'Intervals', 'Hard', 'https://leetcode.com/problems/minimum-interval-to-include-each-query/'),
  ('problem:0048-rotate-image', '0048-rotate-image', 'rotate-image', 'Rotate Image', 'Math & Geometry', 'Medium', 'https://leetcode.com/problems/rotate-image/'),
  ('problem:0054-spiral-matrix', '0054-spiral-matrix', 'spiral-matrix', 'Spiral Matrix', 'Math & Geometry', 'Medium', 'https://leetcode.com/problems/spiral-matrix/'),
  ('problem:0073-set-matrix-zeroes', '0073-set-matrix-zeroes', 'set-matrix-zeroes', 'Set Matrix Zeroes', 'Math & Geometry', 'Medium', 'https://leetcode.com/problems/set-matrix-zeroes/'),
  ('problem:0202-happy-number', '0202-happy-number', 'happy-number', 'Happy Number', 'Math & Geometry', 'Easy', 'https://leetcode.com/problems/happy-number/'),
  ('problem:0066-plus-one', '0066-plus-one', 'plus-one', 'Plus One', 'Math & Geometry', 'Easy', 'https://leetcode.com/problems/plus-one/'),
  ('problem:0050-powx-n', '0050-powx-n', 'powx-n', 'Pow(x, n)', 'Math & Geometry', 'Medium', 'https://leetcode.com/problems/powx-n/'),
  ('problem:0043-multiply-strings', '0043-multiply-strings', 'multiply-strings', 'Multiply Strings', 'Math & Geometry', 'Medium', 'https://leetcode.com/problems/multiply-strings/'),
  ('problem:2013-detect-squares', '2013-detect-squares', 'detect-squares', 'Detect Squares', 'Math & Geometry', 'Medium', 'https://leetcode.com/problems/detect-squares/'),
  ('problem:0136-single-number', '0136-single-number', 'single-number', 'Single Number', 'Bit Manipulation', 'Easy', 'https://leetcode.com/problems/single-number/'),
  ('problem:0191-number-of-1-bits', '0191-number-of-1-bits', 'number-of-1-bits', 'Number of 1 Bits', 'Bit Manipulation', 'Easy', 'https://leetcode.com/problems/number-of-1-bits/'),
  ('problem:0338-counting-bits', '0338-counting-bits', 'counting-bits', 'Counting Bits', 'Bit Manipulation', 'Easy', 'https://leetcode.com/problems/counting-bits/'),
  ('problem:0190-reverse-bits', '0190-reverse-bits', 'reverse-bits', 'Reverse Bits', 'Bit Manipulation', 'Easy', 'https://leetcode.com/problems/reverse-bits/'),
  ('problem:0268-missing-number', '0268-missing-number', 'missing-number', 'Missing Number', 'Bit Manipulation', 'Easy', 'https://leetcode.com/problems/missing-number/'),
  ('problem:0371-sum-of-two-integers', '0371-sum-of-two-integers', 'sum-of-two-integers', 'Sum of Two Integers', 'Bit Manipulation', 'Medium', 'https://leetcode.com/problems/sum-of-two-integers/'),
  ('problem:0007-reverse-integer', '0007-reverse-integer', 'reverse-integer', 'Reverse Integer', 'Bit Manipulation', 'Medium', 'https://leetcode.com/problems/reverse-integer/')

on conflict (id) do nothing;

insert into public.problem_set_version_problems (problem_set_version_id, problem_id, source_code, slug, title, pattern, difficulty, public_url, list_order) values
  ('neetcode-150-2026-08-15', 'problem:0217-contains-duplicate', '0217-contains-duplicate', 'contains-duplicate', 'Contains Duplicate', 'Arrays & Hashing', 'Easy', 'https://leetcode.com/problems/contains-duplicate/', 1),
  ('neetcode-150-2026-08-15', 'problem:0242-valid-anagram', '0242-valid-anagram', 'valid-anagram', 'Valid Anagram', 'Arrays & Hashing', 'Easy', 'https://leetcode.com/problems/valid-anagram/', 2),
  ('neetcode-150-2026-08-15', 'problem:0001-two-sum', '0001-two-sum', 'two-sum', 'Two Sum', 'Arrays & Hashing', 'Easy', 'https://leetcode.com/problems/two-sum/', 3),
  ('neetcode-150-2026-08-15', 'problem:0049-group-anagrams', '0049-group-anagrams', 'group-anagrams', 'Group Anagrams', 'Arrays & Hashing', 'Medium', 'https://leetcode.com/problems/group-anagrams/', 4),
  ('neetcode-150-2026-08-15', 'problem:0347-top-k-frequent-elements', '0347-top-k-frequent-elements', 'top-k-frequent-elements', 'Top K Frequent Elements', 'Arrays & Hashing', 'Medium', 'https://leetcode.com/problems/top-k-frequent-elements/', 5),
  ('neetcode-150-2026-08-15', 'problem:0238-product-of-array-except-self', '0238-product-of-array-except-self', 'product-of-array-except-self', 'Product of Array Except Self', 'Arrays & Hashing', 'Medium', 'https://leetcode.com/problems/product-of-array-except-self/', 6),
  ('neetcode-150-2026-08-15', 'problem:0036-valid-sudoku', '0036-valid-sudoku', 'valid-sudoku', 'Valid Sudoku', 'Arrays & Hashing', 'Medium', 'https://leetcode.com/problems/valid-sudoku/', 7),
  ('neetcode-150-2026-08-15', 'problem:0271-encode-and-decode-strings', '0271-encode-and-decode-strings', 'encode-and-decode-strings', 'Encode and Decode Strings', 'Arrays & Hashing', 'Medium', 'https://leetcode.com/problems/encode-and-decode-strings/', 8),
  ('neetcode-150-2026-08-15', 'problem:0128-longest-consecutive-sequence', '0128-longest-consecutive-sequence', 'longest-consecutive-sequence', 'Longest Consecutive Sequence', 'Arrays & Hashing', 'Medium', 'https://leetcode.com/problems/longest-consecutive-sequence/', 9),
  ('neetcode-150-2026-08-15', 'problem:0125-valid-palindrome', '0125-valid-palindrome', 'valid-palindrome', 'Valid Palindrome', 'Two Pointers', 'Easy', 'https://leetcode.com/problems/valid-palindrome/', 10),
  ('neetcode-150-2026-08-15', 'problem:0167-two-sum-ii-input-array-is-sorted', '0167-two-sum-ii-input-array-is-sorted', 'two-sum-ii-input-array-is-sorted', 'Two Sum II Input Array Is Sorted', 'Two Pointers', 'Medium', 'https://leetcode.com/problems/two-sum-ii-input-array-is-sorted/', 11),
  ('neetcode-150-2026-08-15', 'problem:0015-3sum', '0015-3sum', '3sum', '3Sum', 'Two Pointers', 'Medium', 'https://leetcode.com/problems/3sum/', 12),
  ('neetcode-150-2026-08-15', 'problem:0011-container-with-most-water', '0011-container-with-most-water', 'container-with-most-water', 'Container With Most Water', 'Two Pointers', 'Medium', 'https://leetcode.com/problems/container-with-most-water/', 13),
  ('neetcode-150-2026-08-15', 'problem:0042-trapping-rain-water', '0042-trapping-rain-water', 'trapping-rain-water', 'Trapping Rain Water', 'Two Pointers', 'Hard', 'https://leetcode.com/problems/trapping-rain-water/', 14),
  ('neetcode-150-2026-08-15', 'problem:0121-best-time-to-buy-and-sell-stock', '0121-best-time-to-buy-and-sell-stock', 'best-time-to-buy-and-sell-stock', 'Best Time to Buy And Sell Stock', 'Sliding Window', 'Easy', 'https://leetcode.com/problems/best-time-to-buy-and-sell-stock/', 15),
  ('neetcode-150-2026-08-15', 'problem:0003-longest-substring-without-repeating-characters', '0003-longest-substring-without-repeating-characters', 'longest-substring-without-repeating-characters', 'Longest Substring Without Repeating Characters', 'Sliding Window', 'Medium', 'https://leetcode.com/problems/longest-substring-without-repeating-characters/', 16),
  ('neetcode-150-2026-08-15', 'problem:0424-longest-repeating-character-replacement', '0424-longest-repeating-character-replacement', 'longest-repeating-character-replacement', 'Longest Repeating Character Replacement', 'Sliding Window', 'Medium', 'https://leetcode.com/problems/longest-repeating-character-replacement/', 17),
  ('neetcode-150-2026-08-15', 'problem:0567-permutation-in-string', '0567-permutation-in-string', 'permutation-in-string', 'Permutation In String', 'Sliding Window', 'Medium', 'https://leetcode.com/problems/permutation-in-string/', 18),
  ('neetcode-150-2026-08-15', 'problem:0076-minimum-window-substring', '0076-minimum-window-substring', 'minimum-window-substring', 'Minimum Window Substring', 'Sliding Window', 'Hard', 'https://leetcode.com/problems/minimum-window-substring/', 19),
  ('neetcode-150-2026-08-15', 'problem:0239-sliding-window-maximum', '0239-sliding-window-maximum', 'sliding-window-maximum', 'Sliding Window Maximum', 'Sliding Window', 'Hard', 'https://leetcode.com/problems/sliding-window-maximum/', 20),
  ('neetcode-150-2026-08-15', 'problem:0020-valid-parentheses', '0020-valid-parentheses', 'valid-parentheses', 'Valid Parentheses', 'Stack', 'Easy', 'https://leetcode.com/problems/valid-parentheses/', 21),
  ('neetcode-150-2026-08-15', 'problem:0155-min-stack', '0155-min-stack', 'min-stack', 'Min Stack', 'Stack', 'Medium', 'https://leetcode.com/problems/min-stack/', 22),
  ('neetcode-150-2026-08-15', 'problem:0150-evaluate-reverse-polish-notation', '0150-evaluate-reverse-polish-notation', 'evaluate-reverse-polish-notation', 'Evaluate Reverse Polish Notation', 'Stack', 'Medium', 'https://leetcode.com/problems/evaluate-reverse-polish-notation/', 23),
  ('neetcode-150-2026-08-15', 'problem:0022-generate-parentheses', '0022-generate-parentheses', 'generate-parentheses', 'Generate Parentheses', 'Stack', 'Medium', 'https://leetcode.com/problems/generate-parentheses/', 24),
  ('neetcode-150-2026-08-15', 'problem:0739-daily-temperatures', '0739-daily-temperatures', 'daily-temperatures', 'Daily Temperatures', 'Stack', 'Medium', 'https://leetcode.com/problems/daily-temperatures/', 25),
  ('neetcode-150-2026-08-15', 'problem:0853-car-fleet', '0853-car-fleet', 'car-fleet', 'Car Fleet', 'Stack', 'Medium', 'https://leetcode.com/problems/car-fleet/', 26),
  ('neetcode-150-2026-08-15', 'problem:0084-largest-rectangle-in-histogram', '0084-largest-rectangle-in-histogram', 'largest-rectangle-in-histogram', 'Largest Rectangle In Histogram', 'Stack', 'Hard', 'https://leetcode.com/problems/largest-rectangle-in-histogram/', 27),
  ('neetcode-150-2026-08-15', 'problem:0704-binary-search', '0704-binary-search', 'binary-search', 'Binary Search', 'Binary Search', 'Easy', 'https://leetcode.com/problems/binary-search/', 28),
  ('neetcode-150-2026-08-15', 'problem:0074-search-a-2d-matrix', '0074-search-a-2d-matrix', 'search-a-2d-matrix', 'Search a 2D Matrix', 'Binary Search', 'Medium', 'https://leetcode.com/problems/search-a-2d-matrix/', 29),
  ('neetcode-150-2026-08-15', 'problem:0875-koko-eating-bananas', '0875-koko-eating-bananas', 'koko-eating-bananas', 'Koko Eating Bananas', 'Binary Search', 'Medium', 'https://leetcode.com/problems/koko-eating-bananas/', 30),
  ('neetcode-150-2026-08-15', 'problem:0153-find-minimum-in-rotated-sorted-array', '0153-find-minimum-in-rotated-sorted-array', 'find-minimum-in-rotated-sorted-array', 'Find Minimum In Rotated Sorted Array', 'Binary Search', 'Medium', 'https://leetcode.com/problems/find-minimum-in-rotated-sorted-array/', 31),
  ('neetcode-150-2026-08-15', 'problem:0033-search-in-rotated-sorted-array', '0033-search-in-rotated-sorted-array', 'search-in-rotated-sorted-array', 'Search In Rotated Sorted Array', 'Binary Search', 'Medium', 'https://leetcode.com/problems/search-in-rotated-sorted-array/', 32),
  ('neetcode-150-2026-08-15', 'problem:0981-time-based-key-value-store', '0981-time-based-key-value-store', 'time-based-key-value-store', 'Time Based Key Value Store', 'Binary Search', 'Medium', 'https://leetcode.com/problems/time-based-key-value-store/', 33),
  ('neetcode-150-2026-08-15', 'problem:0004-median-of-two-sorted-arrays', '0004-median-of-two-sorted-arrays', 'median-of-two-sorted-arrays', 'Median of Two Sorted Arrays', 'Binary Search', 'Hard', 'https://leetcode.com/problems/median-of-two-sorted-arrays/', 34),
  ('neetcode-150-2026-08-15', 'problem:0206-reverse-linked-list', '0206-reverse-linked-list', 'reverse-linked-list', 'Reverse Linked List', 'Linked List', 'Easy', 'https://leetcode.com/problems/reverse-linked-list/', 35),
  ('neetcode-150-2026-08-15', 'problem:0021-merge-two-sorted-lists', '0021-merge-two-sorted-lists', 'merge-two-sorted-lists', 'Merge Two Sorted Lists', 'Linked List', 'Easy', 'https://leetcode.com/problems/merge-two-sorted-lists/', 36),
  ('neetcode-150-2026-08-15', 'problem:0143-reorder-list', '0143-reorder-list', 'reorder-list', 'Reorder List', 'Linked List', 'Medium', 'https://leetcode.com/problems/reorder-list/', 37),
  ('neetcode-150-2026-08-15', 'problem:0019-remove-nth-node-from-end-of-list', '0019-remove-nth-node-from-end-of-list', 'remove-nth-node-from-end-of-list', 'Remove Nth Node From End of List', 'Linked List', 'Medium', 'https://leetcode.com/problems/remove-nth-node-from-end-of-list/', 38),
  ('neetcode-150-2026-08-15', 'problem:0138-copy-list-with-random-pointer', '0138-copy-list-with-random-pointer', 'copy-list-with-random-pointer', 'Copy List With Random Pointer', 'Linked List', 'Medium', 'https://leetcode.com/problems/copy-list-with-random-pointer/', 39),
  ('neetcode-150-2026-08-15', 'problem:0002-add-two-numbers', '0002-add-two-numbers', 'add-two-numbers', 'Add Two Numbers', 'Linked List', 'Medium', 'https://leetcode.com/problems/add-two-numbers/', 40),
  ('neetcode-150-2026-08-15', 'problem:0141-linked-list-cycle', '0141-linked-list-cycle', 'linked-list-cycle', 'Linked List Cycle', 'Linked List', 'Easy', 'https://leetcode.com/problems/linked-list-cycle/', 41),
  ('neetcode-150-2026-08-15', 'problem:0287-find-the-duplicate-number', '0287-find-the-duplicate-number', 'find-the-duplicate-number', 'Find The Duplicate Number', 'Linked List', 'Medium', 'https://leetcode.com/problems/find-the-duplicate-number/', 42),
  ('neetcode-150-2026-08-15', 'problem:0146-lru-cache', '0146-lru-cache', 'lru-cache', 'LRU Cache', 'Linked List', 'Medium', 'https://leetcode.com/problems/lru-cache/', 43),
  ('neetcode-150-2026-08-15', 'problem:0023-merge-k-sorted-lists', '0023-merge-k-sorted-lists', 'merge-k-sorted-lists', 'Merge K Sorted Lists', 'Linked List', 'Hard', 'https://leetcode.com/problems/merge-k-sorted-lists/', 44),
  ('neetcode-150-2026-08-15', 'problem:0025-reverse-nodes-in-k-group', '0025-reverse-nodes-in-k-group', 'reverse-nodes-in-k-group', 'Reverse Nodes In K Group', 'Linked List', 'Hard', 'https://leetcode.com/problems/reverse-nodes-in-k-group/', 45),
  ('neetcode-150-2026-08-15', 'problem:0226-invert-binary-tree', '0226-invert-binary-tree', 'invert-binary-tree', 'Invert Binary Tree', 'Trees', 'Easy', 'https://leetcode.com/problems/invert-binary-tree/', 46),
  ('neetcode-150-2026-08-15', 'problem:0104-maximum-depth-of-binary-tree', '0104-maximum-depth-of-binary-tree', 'maximum-depth-of-binary-tree', 'Maximum Depth of Binary Tree', 'Trees', 'Easy', 'https://leetcode.com/problems/maximum-depth-of-binary-tree/', 47),
  ('neetcode-150-2026-08-15', 'problem:0543-diameter-of-binary-tree', '0543-diameter-of-binary-tree', 'diameter-of-binary-tree', 'Diameter of Binary Tree', 'Trees', 'Easy', 'https://leetcode.com/problems/diameter-of-binary-tree/', 48),
  ('neetcode-150-2026-08-15', 'problem:0110-balanced-binary-tree', '0110-balanced-binary-tree', 'balanced-binary-tree', 'Balanced Binary Tree', 'Trees', 'Easy', 'https://leetcode.com/problems/balanced-binary-tree/', 49),
  ('neetcode-150-2026-08-15', 'problem:0100-same-tree', '0100-same-tree', 'same-tree', 'Same Tree', 'Trees', 'Easy', 'https://leetcode.com/problems/same-tree/', 50),
  ('neetcode-150-2026-08-15', 'problem:0572-subtree-of-another-tree', '0572-subtree-of-another-tree', 'subtree-of-another-tree', 'Subtree of Another Tree', 'Trees', 'Easy', 'https://leetcode.com/problems/subtree-of-another-tree/', 51),
  ('neetcode-150-2026-08-15', 'problem:0235-lowest-common-ancestor-of-a-binary-search-tree', '0235-lowest-common-ancestor-of-a-binary-search-tree', 'lowest-common-ancestor-of-a-binary-search-tree', 'Lowest Common Ancestor of a Binary Search Tree', 'Trees', 'Medium', 'https://leetcode.com/problems/lowest-common-ancestor-of-a-binary-search-tree/', 52),
  ('neetcode-150-2026-08-15', 'problem:0102-binary-tree-level-order-traversal', '0102-binary-tree-level-order-traversal', 'binary-tree-level-order-traversal', 'Binary Tree Level Order Traversal', 'Trees', 'Medium', 'https://leetcode.com/problems/binary-tree-level-order-traversal/', 53),
  ('neetcode-150-2026-08-15', 'problem:0199-binary-tree-right-side-view', '0199-binary-tree-right-side-view', 'binary-tree-right-side-view', 'Binary Tree Right Side View', 'Trees', 'Medium', 'https://leetcode.com/problems/binary-tree-right-side-view/', 54),
  ('neetcode-150-2026-08-15', 'problem:1448-count-good-nodes-in-binary-tree', '1448-count-good-nodes-in-binary-tree', 'count-good-nodes-in-binary-tree', 'Count Good Nodes In Binary Tree', 'Trees', 'Medium', 'https://leetcode.com/problems/count-good-nodes-in-binary-tree/', 55),
  ('neetcode-150-2026-08-15', 'problem:0098-validate-binary-search-tree', '0098-validate-binary-search-tree', 'validate-binary-search-tree', 'Validate Binary Search Tree', 'Trees', 'Medium', 'https://leetcode.com/problems/validate-binary-search-tree/', 56),
  ('neetcode-150-2026-08-15', 'problem:0230-kth-smallest-element-in-a-bst', '0230-kth-smallest-element-in-a-bst', 'kth-smallest-element-in-a-bst', 'Kth Smallest Element In a Bst', 'Trees', 'Medium', 'https://leetcode.com/problems/kth-smallest-element-in-a-bst/', 57),
  ('neetcode-150-2026-08-15', 'problem:0105-construct-binary-tree-from-preorder-and-inorder-traversal', '0105-construct-binary-tree-from-preorder-and-inorder-traversal', 'construct-binary-tree-from-preorder-and-inorder-traversal', 'Construct Binary Tree From Preorder And Inorder Traversal', 'Trees', 'Medium', 'https://leetcode.com/problems/construct-binary-tree-from-preorder-and-inorder-traversal/', 58),
  ('neetcode-150-2026-08-15', 'problem:0124-binary-tree-maximum-path-sum', '0124-binary-tree-maximum-path-sum', 'binary-tree-maximum-path-sum', 'Binary Tree Maximum Path Sum', 'Trees', 'Hard', 'https://leetcode.com/problems/binary-tree-maximum-path-sum/', 59),
  ('neetcode-150-2026-08-15', 'problem:0297-serialize-and-deserialize-binary-tree', '0297-serialize-and-deserialize-binary-tree', 'serialize-and-deserialize-binary-tree', 'Serialize And Deserialize Binary Tree', 'Trees', 'Hard', 'https://leetcode.com/problems/serialize-and-deserialize-binary-tree/', 60),
  ('neetcode-150-2026-08-15', 'problem:0208-implement-trie-prefix-tree', '0208-implement-trie-prefix-tree', 'implement-trie-prefix-tree', 'Implement Trie Prefix Tree', 'Tries', 'Medium', 'https://leetcode.com/problems/implement-trie-prefix-tree/', 61),
  ('neetcode-150-2026-08-15', 'problem:0211-design-add-and-search-words-data-structure', '0211-design-add-and-search-words-data-structure', 'design-add-and-search-words-data-structure', 'Design Add And Search Words Data Structure', 'Tries', 'Medium', 'https://leetcode.com/problems/design-add-and-search-words-data-structure/', 62),
  ('neetcode-150-2026-08-15', 'problem:0212-word-search-ii', '0212-word-search-ii', 'word-search-ii', 'Word Search II', 'Tries', 'Hard', 'https://leetcode.com/problems/word-search-ii/', 63),
  ('neetcode-150-2026-08-15', 'problem:0703-kth-largest-element-in-a-stream', '0703-kth-largest-element-in-a-stream', 'kth-largest-element-in-a-stream', 'Kth Largest Element In a Stream', 'Heap / Priority Queue', 'Easy', 'https://leetcode.com/problems/kth-largest-element-in-a-stream/', 64),
  ('neetcode-150-2026-08-15', 'problem:1046-last-stone-weight', '1046-last-stone-weight', 'last-stone-weight', 'Last Stone Weight', 'Heap / Priority Queue', 'Easy', 'https://leetcode.com/problems/last-stone-weight/', 65),
  ('neetcode-150-2026-08-15', 'problem:0973-k-closest-points-to-origin', '0973-k-closest-points-to-origin', 'k-closest-points-to-origin', 'K Closest Points to Origin', 'Heap / Priority Queue', 'Medium', 'https://leetcode.com/problems/k-closest-points-to-origin/', 66),
  ('neetcode-150-2026-08-15', 'problem:0215-kth-largest-element-in-an-array', '0215-kth-largest-element-in-an-array', 'kth-largest-element-in-an-array', 'Kth Largest Element In An Array', 'Heap / Priority Queue', 'Medium', 'https://leetcode.com/problems/kth-largest-element-in-an-array/', 67),
  ('neetcode-150-2026-08-15', 'problem:0621-task-scheduler', '0621-task-scheduler', 'task-scheduler', 'Task Scheduler', 'Heap / Priority Queue', 'Medium', 'https://leetcode.com/problems/task-scheduler/', 68),
  ('neetcode-150-2026-08-15', 'problem:0355-design-twitter', '0355-design-twitter', 'design-twitter', 'Design Twitter', 'Heap / Priority Queue', 'Medium', 'https://leetcode.com/problems/design-twitter/', 69),
  ('neetcode-150-2026-08-15', 'problem:0295-find-median-from-data-stream', '0295-find-median-from-data-stream', 'find-median-from-data-stream', 'Find Median From Data Stream', 'Heap / Priority Queue', 'Hard', 'https://leetcode.com/problems/find-median-from-data-stream/', 70),
  ('neetcode-150-2026-08-15', 'problem:0078-subsets', '0078-subsets', 'subsets', 'Subsets', 'Backtracking', 'Medium', 'https://leetcode.com/problems/subsets/', 71),
  ('neetcode-150-2026-08-15', 'problem:0039-combination-sum', '0039-combination-sum', 'combination-sum', 'Combination Sum', 'Backtracking', 'Medium', 'https://leetcode.com/problems/combination-sum/', 72),
  ('neetcode-150-2026-08-15', 'problem:0046-permutations', '0046-permutations', 'permutations', 'Permutations', 'Backtracking', 'Medium', 'https://leetcode.com/problems/permutations/', 73),
  ('neetcode-150-2026-08-15', 'problem:0090-subsets-ii', '0090-subsets-ii', 'subsets-ii', 'Subsets II', 'Backtracking', 'Medium', 'https://leetcode.com/problems/subsets-ii/', 74),
  ('neetcode-150-2026-08-15', 'problem:0040-combination-sum-ii', '0040-combination-sum-ii', 'combination-sum-ii', 'Combination Sum II', 'Backtracking', 'Medium', 'https://leetcode.com/problems/combination-sum-ii/', 75),
  ('neetcode-150-2026-08-15', 'problem:0079-word-search', '0079-word-search', 'word-search', 'Word Search', 'Backtracking', 'Medium', 'https://leetcode.com/problems/word-search/', 76),
  ('neetcode-150-2026-08-15', 'problem:0131-palindrome-partitioning', '0131-palindrome-partitioning', 'palindrome-partitioning', 'Palindrome Partitioning', 'Backtracking', 'Medium', 'https://leetcode.com/problems/palindrome-partitioning/', 77),
  ('neetcode-150-2026-08-15', 'problem:0017-letter-combinations-of-a-phone-number', '0017-letter-combinations-of-a-phone-number', 'letter-combinations-of-a-phone-number', 'Letter Combinations of a Phone Number', 'Backtracking', 'Medium', 'https://leetcode.com/problems/letter-combinations-of-a-phone-number/', 78),
  ('neetcode-150-2026-08-15', 'problem:0051-n-queens', '0051-n-queens', 'n-queens', 'N Queens', 'Backtracking', 'Hard', 'https://leetcode.com/problems/n-queens/', 79),
  ('neetcode-150-2026-08-15', 'problem:0200-number-of-islands', '0200-number-of-islands', 'number-of-islands', 'Number of Islands', 'Graphs', 'Medium', 'https://leetcode.com/problems/number-of-islands/', 80),
  ('neetcode-150-2026-08-15', 'problem:0133-clone-graph', '0133-clone-graph', 'clone-graph', 'Clone Graph', 'Graphs', 'Medium', 'https://leetcode.com/problems/clone-graph/', 81),
  ('neetcode-150-2026-08-15', 'problem:0695-max-area-of-island', '0695-max-area-of-island', 'max-area-of-island', 'Max Area of Island', 'Graphs', 'Medium', 'https://leetcode.com/problems/max-area-of-island/', 82),
  ('neetcode-150-2026-08-15', 'problem:0417-pacific-atlantic-water-flow', '0417-pacific-atlantic-water-flow', 'pacific-atlantic-water-flow', 'Pacific Atlantic Water Flow', 'Graphs', 'Medium', 'https://leetcode.com/problems/pacific-atlantic-water-flow/', 83),
  ('neetcode-150-2026-08-15', 'problem:0130-surrounded-regions', '0130-surrounded-regions', 'surrounded-regions', 'Surrounded Regions', 'Graphs', 'Medium', 'https://leetcode.com/problems/surrounded-regions/', 84),
  ('neetcode-150-2026-08-15', 'problem:0994-rotting-oranges', '0994-rotting-oranges', 'rotting-oranges', 'Rotting Oranges', 'Graphs', 'Medium', 'https://leetcode.com/problems/rotting-oranges/', 85),
  ('neetcode-150-2026-08-15', 'problem:0286-walls-and-gates', '0286-walls-and-gates', 'walls-and-gates', 'Walls And Gates', 'Graphs', 'Medium', 'https://leetcode.com/problems/walls-and-gates/', 86),
  ('neetcode-150-2026-08-15', 'problem:0207-course-schedule', '0207-course-schedule', 'course-schedule', 'Course Schedule', 'Graphs', 'Medium', 'https://leetcode.com/problems/course-schedule/', 87),
  ('neetcode-150-2026-08-15', 'problem:0210-course-schedule-ii', '0210-course-schedule-ii', 'course-schedule-ii', 'Course Schedule II', 'Graphs', 'Medium', 'https://leetcode.com/problems/course-schedule-ii/', 88),
  ('neetcode-150-2026-08-15', 'problem:0684-redundant-connection', '0684-redundant-connection', 'redundant-connection', 'Redundant Connection', 'Graphs', 'Medium', 'https://leetcode.com/problems/redundant-connection/', 89),
  ('neetcode-150-2026-08-15', 'problem:0323-number-of-connected-components-in-an-undirected-graph', '0323-number-of-connected-components-in-an-undirected-graph', 'number-of-connected-components-in-an-undirected-graph', 'Number of Connected Components In An Undirected Graph', 'Graphs', 'Medium', 'https://leetcode.com/problems/number-of-connected-components-in-an-undirected-graph/', 90),
  ('neetcode-150-2026-08-15', 'problem:0261-graph-valid-tree', '0261-graph-valid-tree', 'graph-valid-tree', 'Graph Valid Tree', 'Graphs', 'Medium', 'https://leetcode.com/problems/graph-valid-tree/', 91),
  ('neetcode-150-2026-08-15', 'problem:0127-word-ladder', '0127-word-ladder', 'word-ladder', 'Word Ladder', 'Graphs', 'Hard', 'https://leetcode.com/problems/word-ladder/', 92),
  ('neetcode-150-2026-08-15', 'problem:0332-reconstruct-itinerary', '0332-reconstruct-itinerary', 'reconstruct-itinerary', 'Reconstruct Itinerary', 'Advanced Graphs', 'Hard', 'https://leetcode.com/problems/reconstruct-itinerary/', 93),
  ('neetcode-150-2026-08-15', 'problem:1584-min-cost-to-connect-all-points', '1584-min-cost-to-connect-all-points', 'min-cost-to-connect-all-points', 'Min Cost to Connect All Points', 'Advanced Graphs', 'Medium', 'https://leetcode.com/problems/min-cost-to-connect-all-points/', 94),
  ('neetcode-150-2026-08-15', 'problem:0743-network-delay-time', '0743-network-delay-time', 'network-delay-time', 'Network Delay Time', 'Advanced Graphs', 'Medium', 'https://leetcode.com/problems/network-delay-time/', 95),
  ('neetcode-150-2026-08-15', 'problem:0778-swim-in-rising-water', '0778-swim-in-rising-water', 'swim-in-rising-water', 'Swim In Rising Water', 'Advanced Graphs', 'Hard', 'https://leetcode.com/problems/swim-in-rising-water/', 96),
  ('neetcode-150-2026-08-15', 'problem:0269-alien-dictionary', '0269-alien-dictionary', 'alien-dictionary', 'Alien Dictionary', 'Advanced Graphs', 'Hard', 'https://leetcode.com/problems/alien-dictionary/', 97),
  ('neetcode-150-2026-08-15', 'problem:0787-cheapest-flights-within-k-stops', '0787-cheapest-flights-within-k-stops', 'cheapest-flights-within-k-stops', 'Cheapest Flights Within K Stops', 'Advanced Graphs', 'Medium', 'https://leetcode.com/problems/cheapest-flights-within-k-stops/', 98),
  ('neetcode-150-2026-08-15', 'problem:0070-climbing-stairs', '0070-climbing-stairs', 'climbing-stairs', 'Climbing Stairs', '1-D Dynamic Programming', 'Easy', 'https://leetcode.com/problems/climbing-stairs/', 99),
  ('neetcode-150-2026-08-15', 'problem:0746-min-cost-climbing-stairs', '0746-min-cost-climbing-stairs', 'min-cost-climbing-stairs', 'Min Cost Climbing Stairs', '1-D Dynamic Programming', 'Easy', 'https://leetcode.com/problems/min-cost-climbing-stairs/', 100),
  ('neetcode-150-2026-08-15', 'problem:0198-house-robber', '0198-house-robber', 'house-robber', 'House Robber', '1-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/house-robber/', 101),
  ('neetcode-150-2026-08-15', 'problem:0213-house-robber-ii', '0213-house-robber-ii', 'house-robber-ii', 'House Robber II', '1-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/house-robber-ii/', 102),
  ('neetcode-150-2026-08-15', 'problem:0005-longest-palindromic-substring', '0005-longest-palindromic-substring', 'longest-palindromic-substring', 'Longest Palindromic Substring', '1-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/longest-palindromic-substring/', 103),
  ('neetcode-150-2026-08-15', 'problem:0647-palindromic-substrings', '0647-palindromic-substrings', 'palindromic-substrings', 'Palindromic Substrings', '1-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/palindromic-substrings/', 104),
  ('neetcode-150-2026-08-15', 'problem:0091-decode-ways', '0091-decode-ways', 'decode-ways', 'Decode Ways', '1-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/decode-ways/', 105),
  ('neetcode-150-2026-08-15', 'problem:0322-coin-change', '0322-coin-change', 'coin-change', 'Coin Change', '1-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/coin-change/', 106),
  ('neetcode-150-2026-08-15', 'problem:0152-maximum-product-subarray', '0152-maximum-product-subarray', 'maximum-product-subarray', 'Maximum Product Subarray', '1-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/maximum-product-subarray/', 107),
  ('neetcode-150-2026-08-15', 'problem:0139-word-break', '0139-word-break', 'word-break', 'Word Break', '1-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/word-break/', 108),
  ('neetcode-150-2026-08-15', 'problem:0300-longest-increasing-subsequence', '0300-longest-increasing-subsequence', 'longest-increasing-subsequence', 'Longest Increasing Subsequence', '1-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/longest-increasing-subsequence/', 109),
  ('neetcode-150-2026-08-15', 'problem:0416-partition-equal-subset-sum', '0416-partition-equal-subset-sum', 'partition-equal-subset-sum', 'Partition Equal Subset Sum', '1-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/partition-equal-subset-sum/', 110),
  ('neetcode-150-2026-08-15', 'problem:0062-unique-paths', '0062-unique-paths', 'unique-paths', 'Unique Paths', '2-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/unique-paths/', 111),
  ('neetcode-150-2026-08-15', 'problem:1143-longest-common-subsequence', '1143-longest-common-subsequence', 'longest-common-subsequence', 'Longest Common Subsequence', '2-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/longest-common-subsequence/', 112),
  ('neetcode-150-2026-08-15', 'problem:0309-best-time-to-buy-and-sell-stock-with-cooldown', '0309-best-time-to-buy-and-sell-stock-with-cooldown', 'best-time-to-buy-and-sell-stock-with-cooldown', 'Best Time to Buy And Sell Stock With Cooldown', '2-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/best-time-to-buy-and-sell-stock-with-cooldown/', 113),
  ('neetcode-150-2026-08-15', 'problem:0518-coin-change-ii', '0518-coin-change-ii', 'coin-change-ii', 'Coin Change II', '2-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/coin-change-ii/', 114),
  ('neetcode-150-2026-08-15', 'problem:0494-target-sum', '0494-target-sum', 'target-sum', 'Target Sum', '2-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/target-sum/', 115),
  ('neetcode-150-2026-08-15', 'problem:0097-interleaving-string', '0097-interleaving-string', 'interleaving-string', 'Interleaving String', '2-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/interleaving-string/', 116),
  ('neetcode-150-2026-08-15', 'problem:0329-longest-increasing-path-in-a-matrix', '0329-longest-increasing-path-in-a-matrix', 'longest-increasing-path-in-a-matrix', 'Longest Increasing Path In a Matrix', '2-D Dynamic Programming', 'Hard', 'https://leetcode.com/problems/longest-increasing-path-in-a-matrix/', 117),
  ('neetcode-150-2026-08-15', 'problem:0115-distinct-subsequences', '0115-distinct-subsequences', 'distinct-subsequences', 'Distinct Subsequences', '2-D Dynamic Programming', 'Hard', 'https://leetcode.com/problems/distinct-subsequences/', 118),
  ('neetcode-150-2026-08-15', 'problem:0072-edit-distance', '0072-edit-distance', 'edit-distance', 'Edit Distance', '2-D Dynamic Programming', 'Medium', 'https://leetcode.com/problems/edit-distance/', 119),
  ('neetcode-150-2026-08-15', 'problem:0312-burst-balloons', '0312-burst-balloons', 'burst-balloons', 'Burst Balloons', '2-D Dynamic Programming', 'Hard', 'https://leetcode.com/problems/burst-balloons/', 120),
  ('neetcode-150-2026-08-15', 'problem:0010-regular-expression-matching', '0010-regular-expression-matching', 'regular-expression-matching', 'Regular Expression Matching', '2-D Dynamic Programming', 'Hard', 'https://leetcode.com/problems/regular-expression-matching/', 121),
  ('neetcode-150-2026-08-15', 'problem:0053-maximum-subarray', '0053-maximum-subarray', 'maximum-subarray', 'Maximum Subarray', 'Greedy', 'Medium', 'https://leetcode.com/problems/maximum-subarray/', 122),
  ('neetcode-150-2026-08-15', 'problem:0055-jump-game', '0055-jump-game', 'jump-game', 'Jump Game', 'Greedy', 'Medium', 'https://leetcode.com/problems/jump-game/', 123),
  ('neetcode-150-2026-08-15', 'problem:0045-jump-game-ii', '0045-jump-game-ii', 'jump-game-ii', 'Jump Game II', 'Greedy', 'Medium', 'https://leetcode.com/problems/jump-game-ii/', 124),
  ('neetcode-150-2026-08-15', 'problem:0134-gas-station', '0134-gas-station', 'gas-station', 'Gas Station', 'Greedy', 'Medium', 'https://leetcode.com/problems/gas-station/', 125),
  ('neetcode-150-2026-08-15', 'problem:0846-hand-of-straights', '0846-hand-of-straights', 'hand-of-straights', 'Hand of Straights', 'Greedy', 'Medium', 'https://leetcode.com/problems/hand-of-straights/', 126),
  ('neetcode-150-2026-08-15', 'problem:1899-merge-triplets-to-form-target-triplet', '1899-merge-triplets-to-form-target-triplet', 'merge-triplets-to-form-target-triplet', 'Merge Triplets to Form Target Triplet', 'Greedy', 'Medium', 'https://leetcode.com/problems/merge-triplets-to-form-target-triplet/', 127),
  ('neetcode-150-2026-08-15', 'problem:0763-partition-labels', '0763-partition-labels', 'partition-labels', 'Partition Labels', 'Greedy', 'Medium', 'https://leetcode.com/problems/partition-labels/', 128),
  ('neetcode-150-2026-08-15', 'problem:0678-valid-parenthesis-string', '0678-valid-parenthesis-string', 'valid-parenthesis-string', 'Valid Parenthesis String', 'Greedy', 'Medium', 'https://leetcode.com/problems/valid-parenthesis-string/', 129),
  ('neetcode-150-2026-08-15', 'problem:0057-insert-interval', '0057-insert-interval', 'insert-interval', 'Insert Interval', 'Intervals', 'Medium', 'https://leetcode.com/problems/insert-interval/', 130),
  ('neetcode-150-2026-08-15', 'problem:0056-merge-intervals', '0056-merge-intervals', 'merge-intervals', 'Merge Intervals', 'Intervals', 'Medium', 'https://leetcode.com/problems/merge-intervals/', 131),
  ('neetcode-150-2026-08-15', 'problem:0435-non-overlapping-intervals', '0435-non-overlapping-intervals', 'non-overlapping-intervals', 'Non Overlapping Intervals', 'Intervals', 'Medium', 'https://leetcode.com/problems/non-overlapping-intervals/', 132),
  ('neetcode-150-2026-08-15', 'problem:0252-meeting-rooms', '0252-meeting-rooms', 'meeting-rooms', 'Meeting Rooms', 'Intervals', 'Easy', 'https://leetcode.com/problems/meeting-rooms/', 133),
  ('neetcode-150-2026-08-15', 'problem:0253-meeting-rooms-ii', '0253-meeting-rooms-ii', 'meeting-rooms-ii', 'Meeting Rooms II', 'Intervals', 'Medium', 'https://leetcode.com/problems/meeting-rooms-ii/', 134),
  ('neetcode-150-2026-08-15', 'problem:1851-minimum-interval-to-include-each-query', '1851-minimum-interval-to-include-each-query', 'minimum-interval-to-include-each-query', 'Minimum Interval to Include Each Query', 'Intervals', 'Hard', 'https://leetcode.com/problems/minimum-interval-to-include-each-query/', 135),
  ('neetcode-150-2026-08-15', 'problem:0048-rotate-image', '0048-rotate-image', 'rotate-image', 'Rotate Image', 'Math & Geometry', 'Medium', 'https://leetcode.com/problems/rotate-image/', 136),
  ('neetcode-150-2026-08-15', 'problem:0054-spiral-matrix', '0054-spiral-matrix', 'spiral-matrix', 'Spiral Matrix', 'Math & Geometry', 'Medium', 'https://leetcode.com/problems/spiral-matrix/', 137),
  ('neetcode-150-2026-08-15', 'problem:0073-set-matrix-zeroes', '0073-set-matrix-zeroes', 'set-matrix-zeroes', 'Set Matrix Zeroes', 'Math & Geometry', 'Medium', 'https://leetcode.com/problems/set-matrix-zeroes/', 138),
  ('neetcode-150-2026-08-15', 'problem:0202-happy-number', '0202-happy-number', 'happy-number', 'Happy Number', 'Math & Geometry', 'Easy', 'https://leetcode.com/problems/happy-number/', 139),
  ('neetcode-150-2026-08-15', 'problem:0066-plus-one', '0066-plus-one', 'plus-one', 'Plus One', 'Math & Geometry', 'Easy', 'https://leetcode.com/problems/plus-one/', 140),
  ('neetcode-150-2026-08-15', 'problem:0050-powx-n', '0050-powx-n', 'powx-n', 'Pow(x, n)', 'Math & Geometry', 'Medium', 'https://leetcode.com/problems/powx-n/', 141),
  ('neetcode-150-2026-08-15', 'problem:0043-multiply-strings', '0043-multiply-strings', 'multiply-strings', 'Multiply Strings', 'Math & Geometry', 'Medium', 'https://leetcode.com/problems/multiply-strings/', 142),
  ('neetcode-150-2026-08-15', 'problem:2013-detect-squares', '2013-detect-squares', 'detect-squares', 'Detect Squares', 'Math & Geometry', 'Medium', 'https://leetcode.com/problems/detect-squares/', 143),
  ('neetcode-150-2026-08-15', 'problem:0136-single-number', '0136-single-number', 'single-number', 'Single Number', 'Bit Manipulation', 'Easy', 'https://leetcode.com/problems/single-number/', 144),
  ('neetcode-150-2026-08-15', 'problem:0191-number-of-1-bits', '0191-number-of-1-bits', 'number-of-1-bits', 'Number of 1 Bits', 'Bit Manipulation', 'Easy', 'https://leetcode.com/problems/number-of-1-bits/', 145),
  ('neetcode-150-2026-08-15', 'problem:0338-counting-bits', '0338-counting-bits', 'counting-bits', 'Counting Bits', 'Bit Manipulation', 'Easy', 'https://leetcode.com/problems/counting-bits/', 146),
  ('neetcode-150-2026-08-15', 'problem:0190-reverse-bits', '0190-reverse-bits', 'reverse-bits', 'Reverse Bits', 'Bit Manipulation', 'Easy', 'https://leetcode.com/problems/reverse-bits/', 147),
  ('neetcode-150-2026-08-15', 'problem:0268-missing-number', '0268-missing-number', 'missing-number', 'Missing Number', 'Bit Manipulation', 'Easy', 'https://leetcode.com/problems/missing-number/', 148),
  ('neetcode-150-2026-08-15', 'problem:0371-sum-of-two-integers', '0371-sum-of-two-integers', 'sum-of-two-integers', 'Sum of Two Integers', 'Bit Manipulation', 'Medium', 'https://leetcode.com/problems/sum-of-two-integers/', 149),
  ('neetcode-150-2026-08-15', 'problem:0007-reverse-integer', '0007-reverse-integer', 'reverse-integer', 'Reverse Integer', 'Bit Manipulation', 'Medium', 'https://leetcode.com/problems/reverse-integer/', 150);

do $$
begin
  if (select count(*) from public.problem_set_version_problems where problem_set_version_id = 'neetcode-150-2026-08-15') <> 150 then
    raise exception 'Pinned Problem Set Version must contain exactly 150 records.';
  end if;
end;
$$;
