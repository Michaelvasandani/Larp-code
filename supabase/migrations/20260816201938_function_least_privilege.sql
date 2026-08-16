-- Supabase grants new public-schema functions to API roles through managed
-- default privileges. Reset that broad surface and preserve only the RPCs the
-- extension intentionally calls. Internal helpers and trigger functions run
-- through their owning functions/triggers and are not client endpoints.
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function
  public.claim_email_otp_request_v1(text),
  public.foundation_health_v1()
to anon, authenticated;

grant execute on function
  public.abandon_challenge_v1(uuid, integer, text, uuid, text, uuid),
  public.accept_invitation_v1(uuid, integer, text, uuid, text, uuid),
  public.cancel_challenge_v1(uuid, integer, text, uuid, text, uuid),
  public.challenge_member_visible_v1(uuid, uuid),
  public.correct_solve_v1(uuid, integer, text, uuid, text, uuid, uuid, text, text, text),
  public.create_invitation_v1(uuid, integer, text, uuid, text, text, text, date, date, text),
  public.create_member_account_v1(text, boolean, boolean, text),
  public.create_solve_correction_v1(uuid, integer, text, uuid, text, uuid, uuid, text, text, text),
  public.create_solve_v1(uuid, integer, text, uuid, text, uuid, text, boolean),
  public.decline_invitation_v1(uuid, integer, text, uuid, text, uuid),
  public.delete_member_account_v1(uuid, integer, text, uuid, text),
  public.get_challenge_at_v1(uuid, timestamptz),
  public.get_challenge_effective_status_at_v1(uuid, timestamptz),
  public.get_challenge_solve_history_v1(uuid),
  public.get_challenge_v1(uuid),
  public.get_committed_challenge_for_member_v1(),
  public.get_invitation_details_v1(uuid),
  public.get_invitation_v1(uuid),
  public.get_latest_canceled_challenge_for_member_v1(),
  public.get_latest_terminal_challenge_for_member_v1(),
  public.get_member_account_v1(),
  public.get_pending_invitation_details_for_member_v1(),
  public.get_pending_invitation_for_member_v1(),
  public.get_pending_outgoing_invitation_v1(),
  public.get_problem_set_version_v1(text),
  public.get_solve_history_v1(uuid),
  public.invitation_effective_status_at_v1(text, date, text, timestamptz),
  public.is_active_member_v1(uuid),
  public.revoke_invitation_v1(uuid, integer, text, uuid, text, uuid),
  public.update_member_display_name_v1(uuid, integer, text, uuid, text, text)
to authenticated;
