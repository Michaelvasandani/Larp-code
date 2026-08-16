import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { renderInvitationEmail } from "../../../src/shared/invitation-email.ts";

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
  if (!authorization || !serviceUrl || !serviceKey || !resendKey) return response({ error: "Notice delivery is unavailable." }, 503);

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

  const { data: notice } = await admin.from("transactional_notices")
    .select("id,event_key,recipient_email,inviter_display_name")
    .eq("event_key", `invitation:${body.invitationId}:created`)
    .is("delivered_at", null)
    .maybeSingle() as { data: InvitationNotice | null };
  if (!notice) return response({ delivered: true });

  const email = renderInvitationEmail({
    inviterDisplayName: notice.inviter_display_name,
    invitationId: body.invitationId,
  });
  const mail = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: Deno.env.get("INVITATION_FROM_EMAIL") ?? "larp-code <invite@auth.larp-code.example>",
      to: [notice.recipient_email],
      subject: email.subject,
      text: email.text,
    }),
  });
  if (!mail.ok) return response({ error: "Notice delivery is unavailable." }, 503);
  await admin.from("transactional_notices").update({ delivered_at: new Date().toISOString() }).eq("id", notice.id).is("delivered_at", null);
  return response({ delivered: true });
});
