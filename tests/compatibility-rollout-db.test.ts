import { execFileSync } from "node:child_process";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

if (!("WebSocket" in globalThis)) {
  class TestWebSocket {
    close(): void { /* no realtime assertions in this test */ }
    send(): void { /* no realtime assertions in this test */ }
    addEventListener(): void { /* no realtime assertions in this test */ }
    removeEventListener(): void { /* no realtime assertions in this test */ }
  }
  Object.assign(globalThis, { WebSocket: TestWebSocket });
}

type Credentials = { url: string; anonKey: string; serviceKey: string };

function localCredentials(): Credentials | null {
  try {
    const output = execFileSync("pnpm", ["exec", "supabase", "status", "-o", "env"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const values = Object.fromEntries(output.split("\n").flatMap((line) => {
      const match = line.match(/^([A-Z_]+)="(.*)"$/);
      return match ? [[match[1], match[2]]] : [];
    }));
    if (!values.API_URL || !values.ANON_KEY || !values.SERVICE_ROLE_KEY) return null;
    return { url: values.API_URL, anonKey: values.ANON_KEY, serviceKey: values.SERVICE_ROLE_KEY };
  } catch {
    return null;
  }
}

const credentials = localCredentials();

const rolloutDb = describe.skipIf(!credentials)("compatible contract rollout against local Supabase", () => {
  let admin: SupabaseClient;

  afterAll(async () => {
    if (!admin) return;
    const listed = await admin.auth.admin.listUsers({ perPage: 1000 });
    for (const user of listed.data.users.filter((user) => user.email?.startsWith("ticket37-"))) {
      await admin.auth.admin.deleteUser(user.id);
    }
    await admin.from("compatibility_backfill_runs").delete().eq("migration_version", "ticket-37-contract-v1");
  });

  it("advertises exactly two contracts and leaves the old contract usable", async () => {
    admin = createClient(credentials!.url, credentials!.serviceKey);
    const healthClient = createClient(credentials!.url, credentials!.anonKey);
    const health = await healthClient.rpc("foundation_health_v1");
    expect(health.error).toBeNull();
    expect(health.data).toMatchObject({
      snapshotContractVersion: 2,
      commandContractVersion: 2,
      supportedSnapshotContractVersions: [1, 2],
      supportedCommandContractVersions: [1, 2],
    });

    const invalid = await admin.rpc("run_compatibility_backfill_v1", { p_batch_size: 0 });
    expect(invalid.error?.code).toBe("22023");
  });

  it("resumes a failed/restarted backfill without changing domain identities", async () => {
    admin = createClient(credentials!.url, credentials!.serviceKey);
    await admin.from("compatibility_backfill_runs").delete().eq("migration_version", "ticket-37-contract-v1");
    const suffix = crypto.randomUUID().slice(0, 8);
    const users = await Promise.all(["a", "b"].map((name) => admin.auth.admin.createUser({
      email: `ticket37-${name}-${suffix}@example.test`,
      password: "pass-12345",
      email_confirm: true,
    })));
    expect(users.every((result) => result.error === null && result.data.user !== null)).toBe(true);
    const memberClients = users.map((_result) => createClient(credentials!.url, credentials!.anonKey));
    const rows = users.map((_result, index) => ({
      id: _result.data.user!.id,
      email: users[index]!.data.user!.email!,
      displayName: `Ticket 37 ${index}`,
    }));
    for (let index = 0; index < memberClients.length; index += 1) {
      const signIn = await memberClients[index]!.auth.signInWithPassword({ email: users[index]!.data.user!.email!, password: "pass-12345" });
      expect(signIn.error).toBeNull();
      const account = await memberClients[index]!.rpc("create_member_account_v1", {
        p_display_name: rows[index]!.displayName,
        p_adult_confirmed: true,
        p_consent_accepted: true,
        p_consent_version: "PRIV-031-v1",
      });
      expect(account.error).toBeNull();
    }
    const before = await Promise.all(memberClients.map((client) => client.rpc("get_member_account_v1")));
    expect(before.every((result) => result.error === null)).toBe(true);
    const domainTables = [
      "invitations",
      "challenges",
      "challenge_members",
      "member_commitments",
      "solves",
      "solve_corrections",
    ] as const;
    const domainOrderColumns: Record<typeof domainTables[number], string> = {
      invitations: "id",
      challenges: "id",
      challenge_members: "challenge_id",
      member_commitments: "member_id",
      solves: "id",
      solve_corrections: "id",
    };
    const readDomainState = async () => Promise.all(domainTables.map(async (table) => {
      const result = await admin.from(table).select("*").order(domainOrderColumns[table]);
      expect(result.error).toBeNull();
      return result.data;
    }));
    const domainBefore = await readDomainState();
    const legacyCommand = await memberClients[0]!.rpc("update_member_display_name_v1", {
      p_idempotency_key: crypto.randomUUID(),
      p_command_version: 1,
      p_command_kind: "update_display_name",
      p_member_id: rows[0]!.id,
      p_member_email: rows[0]!.email,
      p_display_name: "Ticket 37 legacy",
    });
    expect(legacyCommand.error).toBeNull();
    expect(legacyCommand.data).toMatchObject({ displayName: "Ticket 37 legacy" });
    const baselineAfterLegacyCommand = await Promise.all(memberClients.map((client) => client.rpc("get_member_account_v1")));

    // Two workers may be restarted or deployed concurrently. The row lock
    // must serialize them and keep the high-water cursor monotonic.
    const concurrent = await Promise.all([
      admin.rpc("run_compatibility_backfill_v1", { p_batch_size: 1 }),
      admin.rpc("run_compatibility_backfill_v1", { p_batch_size: 1 }),
    ]);
    expect(concurrent.every((result) => result.error === null)).toBe(true);
    const concurrentStates = concurrent.map((result) => result.data as { completed: boolean; processedRows: number; cursorMemberId: string | null });
    const orderedConcurrentStates = [...concurrentStates].sort((left, right) => left.processedRows - right.processedRows);
    expect(orderedConcurrentStates[1]!.processedRows).toBeGreaterThanOrEqual(orderedConcurrentStates[0]!.processedRows);
    let current = orderedConcurrentStates[orderedConcurrentStates.length - 1]!;
    for (let attempt = 0; attempt < 100 && !current.completed; attempt += 1) {
      const resumed = await admin.rpc("run_compatibility_backfill_v1", { p_batch_size: 1 });
      expect(resumed.error).toBeNull();
      expect((resumed.data as { processedRows: number }).processedRows).toBeGreaterThanOrEqual(current.processedRows);
      expect((resumed.data as { cursorMemberId: string | null }).cursorMemberId === null
        || current.cursorMemberId === null
        || (resumed.data as { cursorMemberId: string }).cursorMemberId >= current.cursorMemberId).toBe(true);
      current = resumed.data as typeof current;
    }
    expect(current.completed).toBe(true);
    const replay = await admin.rpc("run_compatibility_backfill_v1", { p_batch_size: 1 });
    expect(replay.error).toBeNull();
    expect(replay.data).toEqual(current);

    const after = await Promise.all(memberClients.map((client) => client.rpc("get_member_account_v1")));
    expect(after.every((result) => result.error === null)).toBe(true);
    expect(after.map((result) => result.data)).toEqual(baselineAfterLegacyCommand.map((result) => result.data));
    expect(await readDomainState()).toEqual(domainBefore);
    await Promise.all(users.map((result) => admin.auth.admin.deleteUser(result.data.user!.id)));
  });
});

void rolloutDb;
