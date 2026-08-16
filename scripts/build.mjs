import { execFileSync } from "node:child_process";

function parseStatus(output) {
  const values = Object.fromEntries(
    output
      .split("\n")
      .map((line) => line.match(/^([A-Z_]+)="?(.*?)"?$/))
      .filter(Boolean)
      .map((match) => [match[1], match[2].replace(/"$/, "")]),
  );
  if (!values.API_URL || !values.ANON_KEY) {
    throw new Error("Supabase status did not report API_URL and ANON_KEY.");
  }
  return { url: values.API_URL, anonKey: values.ANON_KEY };
}

function backendEnvironment() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    return { url: process.env.SUPABASE_URL, anonKey: process.env.SUPABASE_ANON_KEY };
  }
  try {
    const status = execFileSync("pnpm", ["exec", "supabase", "status", "-o", "env"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    return parseStatus(status);
  } catch {
    throw new Error(
      "No Supabase build target found. Start local Supabase with `pnpm backend:start`, "
        + "or provide SUPABASE_URL and SUPABASE_ANON_KEY.",
    );
  }
}

const backend = backendEnvironment();
const environment = {
  ...process.env,
  SUPABASE_URL: backend.url,
  SUPABASE_ANON_KEY: backend.anonKey,
};

execFileSync("pnpm", ["exec", "vite", "build"], {
  env: environment,
  stdio: "inherit",
});
