import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-scheduled-work-secret",
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return response({ error: "Method not allowed." }, 405);

  const serviceUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const expectedSecret = Deno.env.get("SCHEDULED_WORK_SECRET");
  if (!serviceUrl || !serviceKey || !expectedSecret
    || request.headers.get("x-scheduled-work-secret") !== expectedSecret) {
    return response({ error: "Scheduled lifecycle work is unavailable." }, 503);
  }

  const input = await request.json().catch(() => null) as { batchSize?: unknown } | null;
  const batchSize = typeof input?.batchSize === "number" && Number.isInteger(input.batchSize)
    ? Math.min(Math.max(input.batchSize, 1), 500)
    : 100;
  const admin = createClient(serviceUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await admin.rpc("reconcile_scheduled_work_at_v1", {
    p_batch_size: batchSize,
  });
  if (error) return response({ error: "Scheduled lifecycle work is unavailable." }, 503);
  return response(data);
});
