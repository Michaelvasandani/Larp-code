create or replace function public.foundation_health_v1()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'service', 'larp-code',
    'schemaVersion', 1,
    'serverTime', clock_timestamp()
  );
$$;

revoke all on function public.foundation_health_v1() from public;
grant execute on function public.foundation_health_v1() to anon, authenticated;

-- One centralized contract registry for every transactional command function.
-- A future rollout changes these two values once, then deploys the additive
-- function definitions before publishing the consuming extension.
create or replace function public.is_supported_command_contract_version_v1(p_command_version integer)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_command_version in (1, 2);
$$;

revoke all on function public.is_supported_command_contract_version_v1(integer) from public;

create or replace function public.contract_compatibility_json_v1()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'snapshotContractVersion', 2,
    'commandContractVersion', 2,
    'supportedSnapshotContractVersions', jsonb_build_array(1, 2),
    'supportedCommandContractVersions', jsonb_build_array(1, 2)
  );
$$;

revoke all on function public.contract_compatibility_json_v1() from public;
