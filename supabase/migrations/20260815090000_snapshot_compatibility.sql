-- Ticket 30: expose the compatibility floor alongside the authoritative
-- server clock.  The client must receive this before any Member Data read.
create or replace function public.foundation_health_v1()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'service', 'larp-code',
    'schemaVersion', 10,
    'serverTime', statement_timestamp(),
    'minimumClientVersion', '0.1.0'
  );
$$;

revoke all on function public.foundation_health_v1() from public;
grant execute on function public.foundation_health_v1() to anon, authenticated;
