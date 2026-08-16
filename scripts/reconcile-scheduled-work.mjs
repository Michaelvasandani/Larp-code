const endpoint = process.env.SCHEDULED_WORK_URL;
const secret = process.env.SCHEDULED_WORK_SECRET;
if (!endpoint || !secret) {
  throw new Error("SCHEDULED_WORK_URL and SCHEDULED_WORK_SECRET are required.");
}

const batchSize = Number(process.env.SCHEDULED_WORK_BATCH ?? 100);
const response = await fetch(endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-scheduled-work-secret": secret },
  body: JSON.stringify({ batchSize }),
});
const body = await response.json().catch(() => null);
if (!response.ok) throw new Error(body?.error ?? "Scheduled lifecycle work failed.");
console.log(JSON.stringify(body));
