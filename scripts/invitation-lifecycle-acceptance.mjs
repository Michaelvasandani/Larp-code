import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for the invitation lifecycle acceptance.");

// The acceptance harness uses Auth and REST/RPC only. Supabase initializes its
// Realtime client eagerly, so provide a deliberately inert Node 20 transport.
if (!globalThis.WebSocket) {
  globalThis.WebSocket = class DisabledWebSocket {
    addEventListener() {}
    removeEventListener() {}
    close() {}
    send() {}
  };
}

const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const profiles = ["inviter", "invitee", "outsider"].map((role) => ({
  role,
  email: `ticket24-${role}-${suffix}@example.test`,
  password: `Ticket24-${suffix}-Password!`,
}));
const accounts = new Map();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function addDays(days) {
  const value = new Date(Date.now() + days * 86_400_000);
  return value.toISOString().slice(0, 10);
}

async function createProfile(profile) {
  const { data, error } = await admin.auth.admin.createUser({
    email: profile.email,
    password: profile.password,
    email_confirm: true,
  });
  if (error) throw error;
  const client = createClient(url, process.env.SUPABASE_ANON_KEY ?? serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const signedIn = await client.auth.signInWithPassword({ email: profile.email, password: profile.password });
  if (signedIn.error) throw signedIn.error;
  const account = await client.rpc("create_member_account_v1", {
    p_display_name: profile.role,
    p_adult_confirmed: true,
    p_consent_accepted: true,
    p_consent_version: "PRIV-031-v1",
  });
  if (account.error) throw account.error;
  accounts.set(profile.role, { id: data.user.id, client });
}

async function rpc(role, name, params) {
  const result = await accounts.get(role).client.rpc(name, params);
  if (result.error) throw result.error;
  return result.data;
}

async function main() {
  for (const profile of profiles) await createProfile(profile);
  const inviter = accounts.get("inviter");
  const invitee = accounts.get("invitee");
  const outsider = accounts.get("outsider");
  const startDate = addDays(1);
  const deadlineDate = addDays(4);
  const terms = {
    p_command_version: 1,
    p_command_kind: "create_invitation",
    p_member_id: inviter.id,
    p_member_email: profiles[0].email,
    p_invited_email: profiles[1].email,
    p_challenge_time_zone: "UTC",
    p_start_date: startDate,
    p_deadline_date: deadlineDate,
    p_problem_set_version_id: "neetcode-150-2026-08-15",
  };
  const created = await rpc("inviter", "create_invitation_v1", { ...terms, p_idempotency_key: crypto.randomUUID() });
  assert(created.status === "pending", "creation did not return pending");
  const invitationId = created.id;

  const inviteeView = await rpc("invitee", "get_invitation_v1", { p_invitation_id: invitationId });
  assert(inviteeView.status === "pending", "invitee cannot read complete pending Invitation");
  const outsiderView = await outsider.client.rpc("get_invitation_v1", { p_invitation_id: invitationId });
  assert(outsiderView.error, "outsider Invitation response was not generic denial");

  const boundaryBefore = await rpc("invitee", "invitation_effective_status_at_v1", {
    p_status: "pending", p_start_date: startDate, p_challenge_time_zone: "UTC", p_authoritative_now: new Date(Date.parse(`${startDate}T00:00:00.000Z`) - 1).toISOString(),
  });
  assert(boundaryBefore === "pending", "controlled time before the Start boundary was already expired");
  const boundaryAt = await rpc("invitee", "invitation_effective_status_at_v1", {
    p_status: "pending", p_start_date: startDate, p_challenge_time_zone: "UTC", p_authoritative_now: `${startDate}T00:00:00.000Z`,
  });
  assert(boundaryAt === "expired", "controlled Start boundary did not expire at midnight");

  const declined = await rpc("invitee", "decline_invitation_v1", {
    p_idempotency_key: crypto.randomUUID(), p_command_version: 1, p_command_kind: "decline_invitation",
    p_member_id: accounts.get("invitee").id, p_member_email: profiles[1].email, p_invitation_id: invitationId,
  });
  assert(declined.status === "declined" && declined.terminalActorId === invitee.id && declined.terminalAt, "decline did not produce an attributed terminal result");

  const replacement = await rpc("inviter", "create_invitation_v1", { ...terms, p_deadline_date: addDays(5), p_idempotency_key: crypto.randomUUID() });
  assert(replacement.status === "pending" && replacement.id !== invitationId, "replacement Invitation was not fresh");
  const changedTerms = await admin.from("invitations").update({ start_date: addDays(2) }).eq("id", replacement.id);
  assert(changedTerms.error, "Invitation terms were editable in place");

  const [revokedAttempt, declineAttempt] = await Promise.all([
    rpc("inviter", "revoke_invitation_v1", {
      p_idempotency_key: crypto.randomUUID(), p_command_version: 1, p_command_kind: "revoke_invitation",
      p_member_id: inviter.id, p_member_email: profiles[0].email, p_invitation_id: replacement.id,
    }).catch((error) => ({ error })),
    rpc("invitee", "decline_invitation_v1", {
      p_idempotency_key: crypto.randomUUID(), p_command_version: 1, p_command_kind: "decline_invitation",
      p_member_id: invitee.id, p_member_email: profiles[1].email, p_invitation_id: replacement.id,
    }).catch((error) => ({ error })),
  ]);
  const terminal = await rpc("inviter", "get_invitation_v1", { p_invitation_id: replacement.id });
  assert(["revoked", "declined"].includes(terminal.status), "competing terminal actions did not settle");
  assert(Boolean(revokedAttempt.error) !== Boolean(declineAttempt.error), "competing terminal actions both succeeded or both failed");

  const boundaryFixture = await admin.from("invitations").insert({
    inviter_id: inviter.id,
    invited_email: profiles[1].email,
    challenge_time_zone: "UTC",
    start_date: addDays(0),
    deadline_date: addDays(2),
    problem_set_version_id: "neetcode-150-2026-08-15",
  }).select("id").single();
  assert(!boundaryFixture.error, `could not create controlled boundary fixture: ${boundaryFixture.error?.message}`);
  const lateAcceptance = await admin.from("invitations").update({ status: "accepted" }).eq("id", boundaryFixture.data.id);
  assert(lateAcceptance.error, "raw pending-to-accepted transition bypassed the authoritative Start boundary");
  await admin.from("invitations").delete().eq("id", boundaryFixture.data.id);

  const commitments = await admin.from("member_commitments").select("member_id").in("member_id", [inviter.id, invitee.id]);
  assert(!commitments.error ? commitments.data.length === 0 : /relation .* does not exist/i.test(commitments.error.message), "terminal Invitations reserved Challenge capacity");
  console.log("Invitation lifecycle acceptance passed for two Members and an outsider.");
}

try {
  await main();
} finally {
  const accountIds = [...accounts.values()].map(({ id }) => id);
  if (accountIds.length > 0) {
    const byInviter = await admin.from("invitations").delete().in("inviter_id", accountIds);
    if (byInviter.error) console.warn(`Could not clean inviter fixtures: ${byInviter.error.message}`);
  }
  const byInvitee = await admin.from("invitations").delete().in("invited_email", profiles.map(({ email }) => email));
  if (byInvitee.error) console.warn(`Could not clean invitee fixtures: ${byInvitee.error.message}`);
  for (const profile of profiles) {
    const user = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const match = user.data.users.find((candidate) => candidate.email === profile.email);
    if (match) await admin.auth.admin.deleteUser(match.id);
  }
}
