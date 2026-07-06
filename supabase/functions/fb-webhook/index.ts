// fb-webhook — Facebook Lead Ads webhook receiver.
//   GET  = Meta verification handshake (hub.challenge).
//   POST = leadgen events. Verifies X-Hub-Signature-256, stores the raw event,
//          inserts a deduped `pending` lead, then fires process-lead in the
//          background. Lossless: every authenticated event is persisted and can
//          be replayed by the reconcile job even if downstream processing fails.
//
// Deploy with verify_jwt = false (Facebook cannot send a Supabase JWT).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

let secretsCache: Record<string, string> | null = null;
async function getSecrets(): Promise<Record<string, string>> {
  if (secretsCache) return secretsCache;
  const { data, error } = await db.from("app_secrets").select("key,value");
  if (error) throw new Error(`app_secrets read failed: ${error.message}`);
  secretsCache = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
  return secretsCache;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Fire process-lead without blocking the webhook ack.
function triggerProcessing(leadgenId: string, secrets: Record<string, string>) {
  const url = `${SUPABASE_URL}/functions/v1/process-lead`;
  const p = fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": secrets.INTERNAL_TOKEN ?? "",
      // Supabase gateway needs an apikey even for verify_jwt=false functions.
      "apikey": SERVICE_ROLE,
      "authorization": `Bearer ${SERVICE_ROLE}`,
    },
    body: JSON.stringify({ leadgen_id: leadgenId }),
  }).catch((e) => console.error("trigger process-lead failed", e));
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p);
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge") ?? "";
    try {
      const { FB_VERIFY_TOKEN } = await getSecrets();
      if (mode === "subscribe" && token && FB_VERIFY_TOKEN && timingSafeEqual(token, FB_VERIFY_TOKEN)) {
        return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
      }
    } catch (e) {
      console.error("verify error", e);
    }
    return new Response("Forbidden", { status: 403 });
  }

  if (req.method === "POST") {
    const raw = await req.text();
    let secrets: Record<string, string>;
    try {
      secrets = await getSecrets();
    } catch (e) {
      console.error(e);
      return new Response("server error", { status: 500 });
    }

    const header = req.headers.get("x-hub-signature-256") ?? "";
    const expected = "sha256=" + (await hmacSha256Hex(secrets.FB_APP_SECRET ?? "", raw));
    if (!(header.length > 0 && timingSafeEqual(header, expected))) {
      console.warn("bad signature");
      return new Response("invalid signature", { status: 401 });
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw);
    } catch {
      return new Response("bad json", { status: 400 });
    }

    const changes: Record<string, unknown>[] = [];
    for (const entry of (body?.entry as any[]) ?? []) {
      for (const ch of entry?.changes ?? []) {
        if (ch?.field === "leadgen" && ch?.value?.leadgen_id) changes.push(ch.value);
      }
    }

    await db.from("webhook_events").insert({
      source: "facebook",
      event_type: (body?.object as string) ?? null,
      leadgen_id: (changes[0]?.leadgen_id as string) ?? null,
      signature_ok: true,
      payload: body,
    });

    for (const v of changes) {
      const created = v.created_time ? new Date(Number(v.created_time) * 1000).toISOString() : null;
      const { error } = await db.from("leads").upsert(
        {
          leadgen_id: String(v.leadgen_id),
          page_id: v.page_id ? String(v.page_id) : null,
          form_id: v.form_id ? String(v.form_id) : null,
          ad_id: v.ad_id ? String(v.ad_id) : null,
          adset_id: v.adgroup_id ? String(v.adgroup_id) : null,
          created_time: created,
          status: "pending",
        },
        { onConflict: "leadgen_id", ignoreDuplicates: true },
      );
      if (error) console.error("lead upsert error", error.message);
      else triggerProcessing(String(v.leadgen_id), secrets);
    }

    return new Response("EVENT_RECEIVED", { status: 200 });
  }

  return new Response("Method Not Allowed", { status: 405 });
});
