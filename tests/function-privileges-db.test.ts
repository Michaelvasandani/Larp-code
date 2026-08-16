import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

function localDatabaseUrl(): string | null {
  try {
    const output = execFileSync("pnpm", ["exec", "supabase", "status", "-o", "env"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.match(/^DB_URL="([^"]+)"$/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

const databaseUrl = localDatabaseUrl();
const databasePrivileges = describe.skipIf(!databaseUrl)("database function privileges", () => {
  it("exposes only the explicitly supported client RPC surface", () => {
    const sql = `
      select role_name || ':' || p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join (values ('anon'), ('authenticated')) roles(role_name)
      where n.nspname = 'public'
        and has_function_privilege(role_name, p.oid, 'execute')
      order by role_name, p.proname;
    `;
    const output = execFileSync("psql", [databaseUrl!, "-v", "ON_ERROR_STOP=1", "-At", "-c", sql], {
      encoding: "utf8",
    });
    const exposed = output.trim().split("\n").filter(Boolean);

    const anon = ["claim_email_otp_request_v1", "foundation_health_v1"];
    const authenticated = [
      ...anon,
      "abandon_challenge_v1",
      "accept_invitation_v1",
      "cancel_challenge_v1",
      "challenge_member_visible_v1",
      "correct_solve_v1",
      "create_invitation_v1",
      "create_member_account_v1",
      "create_solve_correction_v1",
      "create_solve_v1",
      "decline_invitation_v1",
      "delete_member_account_v1",
      "get_challenge_at_v1",
      "get_challenge_effective_status_at_v1",
      "get_challenge_solve_history_v1",
      "get_challenge_v1",
      "get_committed_challenge_for_member_v1",
      "get_invitation_details_v1",
      "get_invitation_v1",
      "get_latest_canceled_challenge_for_member_v1",
      "get_latest_terminal_challenge_for_member_v1",
      "get_member_account_v1",
      "get_pending_invitation_details_for_member_v1",
      "get_pending_invitation_for_member_v1",
      "get_pending_outgoing_invitation_v1",
      "get_problem_set_version_v1",
      "get_solve_history_v1",
      "invitation_effective_status_at_v1",
      "is_active_member_v1",
      "revoke_invitation_v1",
      "update_member_display_name_v1",
    ];
    expect(exposed).toEqual([
      ...anon.map((name) => `anon:${name}`),
      ...authenticated.sort().map((name) => `authenticated:${name}`),
    ]);
  });
});

void databasePrivileges;
