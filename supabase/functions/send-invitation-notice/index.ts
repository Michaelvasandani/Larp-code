import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { renderInvitationEmail } from "../../../src/shared/invitation-email.ts";
import { createTransactionalMailTransport } from "../_shared/transactional-mail.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type InvitationNotice = {
  id: string;
  event_key: string;
  recipient_email: string;
  inviter_display_name: string;
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

  const authorization = request.headers.get("Authorization");
  const serviceUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const transport = Deno.env.get("TRANSACTIONAL_MAIL_TRANSPORT") ?? "resend";
  if (!authorization || !serviceUrl || !serviceKey || (transport !== "mailpit" && !resendKey)
    || Deno.env.get("TRANSACTIONAL_TRACKING") === "true") {
    return response({ error: "Notice delivery is unavailable." }, 503);
  }

  const userClient = createClient(serviceUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? serviceKey, {
    global: { headers: { Authorization: authorization } },
  });
  const { data: userData } = await userClient.auth.getUser();
  if (!userData.user) return response({ error: "Authentication is required." }, 401);

  const body = await request.json().catch(() => null) as { invitationId?: unknown } | null;
  if (!body || typeof body.invitationId !== "string" || body.invitationId.length < 10) return response({ error: "Invalid Invitation." }, 400);

  const admin = createClient(serviceUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: invitation } = await admin.from("invitations")
    .select("id,inviter_id")
    .eq("id", body.invitationId)
    .maybeSingle();
  if (!invitation || invitation.inviter_id !== userData.user.id) return response({ error: "Invitation is unavailable." }, 403);

  // Claiming happens before provider I/O. A timeout after provider acceptance
  // therefore cannot cause a second product email on reconnect or retry.
  const { data: notice } = await admin.rpc("claim_transactional_notice_v1", {
    p_event_key: `invitation:${body.invitationId}:created`,
  }) as { data: InvitationNotice | null };
  if (!notice) return response({ delivered: true });

  const email = renderInvitationEmail({
    inviterDisplayName: notice.inviter_display_name,
    invitationId: body.invitationId,
  });
  try {
    const providerMessageId = await createTransactionalMailTransport({
      transport: transport as "mailpit" | "resend",
      resendKey,
      from: Deno.env.get("INVITATION_FROM_EMAIL") ?? "larp-code <invite@auth.larp-code.example>",
    }).send({ to: notice.recipient_email, subject: email.subject, text: email.text }, notice.event_key);
    await admin.rpc("mark_transactional_notice_delivered_v1", {
      p_notice_id: notice.id,
      p_provider_message_id: providerMessageId,
    });
  } catch {
    return response({ error: "Notice delivery is unavailable." }, 503);
  }
  return response({ delivered: true });
});
