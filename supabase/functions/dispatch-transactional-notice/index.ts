import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { renderTransactionalNoticeEmail, type ProductNoticeType } from "../../../src/shared/transactional-notices.ts";
import { createTransactionalMailTransport } from "../_shared/transactional-mail.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-dispatch-secret",
};

type OutboxNotice = {
  id: string;
  event_key: string;
  notice_type: ProductNoticeType;
  recipient_email: string;
  inviter_display_name: string;
  invitation_id: string | null;
  challenge_id: string | null;
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
  const dispatchSecret = Deno.env.get("TRANSACTIONAL_DISPATCH_SECRET");
  const suppliedSecret = request.headers.get("x-dispatch-secret");
  if (!serviceUrl || !serviceKey || !dispatchSecret || suppliedSecret !== dispatchSecret
    || Deno.env.get("TRANSACTIONAL_TRACKING") === "true") {
    return response({ error: "Notice delivery is unavailable." }, 503);
  }

  const body = await request.json().catch(() => null) as { eventKey?: unknown } | null;
  const eventKey = typeof body?.eventKey === "string" ? body.eventKey : null;
  const admin = createClient(serviceUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  let claimKey = eventKey;
  if (!claimKey) {
    const { data: queued, error } = await admin.from("transactional_notices")
      .select("event_key")
      .eq("delivery_state", "queued")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error || !queued) return response({ delivered: false, drained: true });
    claimKey = queued.event_key;
  }

  const { data: notice, error: claimError } = await admin.rpc("claim_transactional_notice_v1", {
    p_event_key: claimKey,
  }) as { data: OutboxNotice | null; error: unknown };
  if (claimError) return response({ error: "Notice delivery is unavailable." }, 503);
  if (!notice) return response({ delivered: false, drained: true });

  try {
    const email = renderTransactionalNoticeEmail({
      eventKey: notice.event_key,
      type: notice.notice_type,
      recipientEmail: notice.recipient_email,
      inviterDisplayName: notice.inviter_display_name,
      invitationId: notice.invitation_id ?? undefined,
      challengeId: notice.challenge_id ?? undefined,
    });
    const providerMessageId = await createTransactionalMailTransport().send(email, notice.event_key);
    await admin.rpc("mark_transactional_notice_delivered_v1", {
      p_notice_id: notice.id,
      p_provider_message_id: providerMessageId,
    });
  } catch {
    // The row remains claimed by design: product-level delivery is at-most-once
    // even if this worker loses the provider response or is restarted.
    return response({ error: "Notice delivery is unavailable." }, 503);
  }
  return response({ delivered: true, drained: false });
});
