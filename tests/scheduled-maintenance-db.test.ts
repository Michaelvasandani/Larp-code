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

function sql(databaseUrl: string, statement: string): string {
  return execFileSync("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-At", "-c", statement], {
    encoding: "utf8",
  }).trim();
}

const databaseUrl = localDatabaseUrl();
const scheduledMaintenance = describe.skipIf(!databaseUrl)("scheduled lifecycle maintenance", () => {
  it("installs one active five-minute lifecycle job", () => {
    const job = sql(databaseUrl!, `
      select jobname || '|' || schedule || '|' || active
      from cron.job
      where jobname = 'larp-code-lifecycle-maintenance-v1';
    `);

    expect(job).toBe("larp-code-lifecycle-maintenance-v1|*/5 * * * *|true");
  });

  it("keeps the scheduler entrypoint private while allowing Postgres to run it", () => {
    const privileges = sql(databaseUrl!, `
      select role_name || ':' || has_function_privilege(
        role_name,
        'private.run_lifecycle_maintenance_v1()'::regprocedure,
        'execute'
      )
      from (values ('anon'), ('authenticated'), ('service_role')) roles(role_name)
      order by role_name;
    `).split("\n");

    expect(privileges).toEqual([
      "anon:false",
      "authenticated:false",
      "service_role:false",
    ]);

    const result = JSON.parse(sql(databaseUrl!, "select private.run_lifecycle_maintenance_v1();"));
    expect(result).toMatchObject({
      invitationsExpired: 0,
      challengesReconciled: 0,
      noticesQueued: 0,
      cleanup: { ok: true },
    });
  });
});

void scheduledMaintenance;
