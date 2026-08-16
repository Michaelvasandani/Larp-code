import type { TransactionalEmail } from "../../../src/shared/transactional-notices.ts";

export type MailPayload = Pick<TransactionalEmail, "to" | "subject" | "text"> & { tracking?: false };

type MailFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function address(value: string): { Email: string } {
  return { Email: value.replace(/^.*<([^>]+)>.*$/, "$1").trim() };
}

/**
 * One provider adapter is shared by the authenticated invitation endpoint and
 * the scheduled outbox worker. The provider is replaceable for Mailpit tests;
 * production is Resend. Any explicit tracking enablement is rejected.
 */
export function createTransactionalMailTransport({
  fetcher = fetch,
  transport = Deno.env.get("TRANSACTIONAL_MAIL_TRANSPORT") ?? "resend",
  mailpitUrl = Deno.env.get("MAILPIT_URL") ?? "http://127.0.0.1:54324",
  resendKey = Deno.env.get("RESEND_API_KEY"),
  from = Deno.env.get("TRANSACTIONAL_FROM_EMAIL") ?? "larp-code <notice@auth.larp-code.example>",
  tracking = Deno.env.get("TRANSACTIONAL_TRACKING") ?? "false",
}: {
  fetcher?: MailFetcher;
  transport?: "mailpit" | "resend";
  mailpitUrl?: string;
  resendKey?: string | undefined;
  from?: string;
  tracking?: string;
} = {}) {
  if (tracking !== "false") throw new Error("Transactional mail tracking must remain disabled.");
  return {
    async send(email: MailPayload, eventKey: string): Promise<string | null> {
      if (transport === "mailpit") {
        const result = await fetcher(`${mailpitUrl}/api/v1/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            From: address(from),
            To: [address(email.to)],
            Subject: email.subject,
            Text: email.text,
          }),
        });
        if (!result.ok) throw new Error("Mailpit delivery failed.");
        const body = await result.json().catch(() => null) as { ID?: unknown; id?: unknown } | null;
        const id = body?.ID ?? body?.id;
        return typeof id === "string" ? id : null;
      }
      if (!resendKey) throw new Error("The production Resend transactional-mail recipient is not configured.");
      const result = await fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to: [email.to],
          subject: email.subject,
          text: email.text,
          headers: { "X-Transactional-Event-Key": eventKey, "X-Tracking-Disabled": "true" },
        }),
      });
      if (!result.ok) throw new Error("Transactional notice delivery is unavailable.");
      const body = await result.json().catch(() => null) as { id?: unknown } | null;
      return typeof body?.id === "string" ? body.id : null;
    },
  };
}
