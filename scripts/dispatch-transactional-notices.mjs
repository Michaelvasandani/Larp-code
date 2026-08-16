const endpoint = process.env.TRANSACTIONAL_DISPATCH_URL;
const secret = process.env.TRANSACTIONAL_DISPATCH_SECRET;
if (!endpoint || !secret) {
  throw new Error("TRANSACTIONAL_DISPATCH_URL and TRANSACTIONAL_DISPATCH_SECRET are required.");
}

const maxBatch = Number(process.env.TRANSACTIONAL_DISPATCH_BATCH ?? 100);
let drained = 0;
for (; drained < maxBatch; drained += 1) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-dispatch-secret": secret },
    body: "{}",
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? "Transactional notice dispatch failed.");
  if (body?.drained === true) break;
}
console.log(`Dispatched ${drained} Transactional Notice(s).`);
