// process-lead — turns a `pending` lead into a Pipedrive lead + notification.
//   1. fetch full lead from Graph API (needs the page access token)
//   2. only-new guard (created_time >= settings.go_live_at)
//   3. match a routing rule (form > page > default)
//   4. to_crm  -> create Person (always new) + Lead with the exact Zapier mapping
//   5. to_email -> Resend notification
//   6. CAPI    -> server-side "Lead" event (hashed PII), if enabled
//
// Auth: header `x-internal-token` must equal app_secrets.INTERNAL_TOKEN.
// Body: { leadgen_id } | { lead_id } | { batch: true, limit? }
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const GRAPH = "https://graph.facebook.com/v21.0";
const PD = "https://api.pipedrive.com/v1";

// Pipedrive custom-field keys (verified against the live account).
const F_SOURCE = "214af8c48dd4523a5d5b83c1eaddd2aa0efd906a"; // Pochodzenie leada (enum)
const F_CAMPAIGN = "2d62550465f8d1d468fa785d90dee13a8b62a44b"; // Nazwa kampanii
const F_ANSWER = "98c7457b47568f8696691c95b3a43db2d2c4c36e"; // Odpowiedz w formularzu

const STD_FIELDS = new Set([
  "full_name", "first_name", "last_name", "email", "phone_number",
  "city", "state", "province", "country", "zip_code", "post_code", "street_address",
]);

// Pipedrive custom varchar fields reject values longer than 255 chars.
const PD_VARCHAR_MAX = 255;
function clip(s: string, n = PD_VARCHAR_MAX): string {
  const str = s ?? "";
  return str.length > n ? str.slice(0, n) : str;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Robustly pull email / phone / name out of Facebook field_data, even when the
// form uses custom (localized) question labels like "Imię i nazwisko" / "E-mail"
// / "Numer Telefonu" instead of the standard english keys. Order of preference:
//   1. standard FB key  2. localized label match  3. value pattern (email/phone).
// Returns the keys it consumed so they can be excluded from the "answer" blob.
function extractContact(fd: Record<string, string>): { email: string; phone: string; fullName: string; usedKeys: Set<string> } {
  const used = new Set<string>();
  const entries = Object.entries(fd);

  // --- email ---
  let email = fd.email ?? "", emailKey = email ? "email" : "";
  if (!email) for (const [k, v] of entries) { if (/e[\-_ ]?mail/i.test(k) && v) { email = v; emailKey = k; break; } }
  if (!email) for (const [k, v] of entries) { const c = (v ?? "").trim(); if (EMAIL_RE.test(c)) { email = c; emailKey = k; break; } }
  if (emailKey) used.add(emailKey);

  // --- phone ---
  let phone = fd.phone_number ?? "", phoneKey = phone ? "phone_number" : "";
  if (!phone) for (const [k, v] of entries) { if (/phone|tel|telefon|numer|komó?rk|mobile/i.test(k) && v) { phone = v; phoneKey = k; break; } }
  if (!phone) for (const [k, v] of entries) {
    if (used.has(k)) continue;
    const raw = (v ?? "").trim();
    if (raw.replace(/[^\d]/g, "").length >= 9 && /^[+\d][\d\s\-()]{7,}$/.test(raw)) { phone = raw; phoneKey = k; break; }
  }
  if (phoneKey) used.add(phoneKey);

  // --- name --- (key-based only; never guess a name from an arbitrary value)
  let fullName = fd.full_name ?? "", nameKey = fullName ? "full_name" : "";
  if (!fullName && (fd.first_name || fd.last_name)) {
    fullName = [fd.first_name, fd.last_name].filter(Boolean).join(" ");
    if (fd.first_name) used.add("first_name");
    if (fd.last_name) used.add("last_name");
  }
  if (!fullName) for (const [k, v] of entries) {
    if (used.has(k)) continue;
    if (/(full[_ ]?name|imi[ęe]|nazwisko|\bname\b|imie)/i.test(k) && v && !EMAIL_RE.test(v.trim())) { fullName = v; nameKey = k; break; }
  }
  if (nameKey) used.add(nameKey);

  return { email, phone, fullName, usedKeys: used };
}

let secretsCache: Record<string, string> | null = null;
async function getSecrets() {
  if (secretsCache) return secretsCache;
  const { data, error } = await db.from("app_secrets").select("key,value");
  if (error) throw new Error(`app_secrets read failed: ${error.message}`);
  secretsCache = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
  return secretsCache;
}
async function getSettings() {
  const { data, error } = await db.from("settings").select("key,value");
  if (error) throw new Error(`settings read failed: ${error.message}`);
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function firstLast(fullName: string, fd: Record<string, string>): [string, string] {
  if (fd.first_name || fd.last_name) return [fd.first_name ?? "", fd.last_name ?? ""];
  const parts = (fullName ?? "").trim().split(/\s+/);
  return [parts[0] ?? "", parts.slice(1).join(" ")];
}

// --- routing: form_id > name-pattern > page > default ---------------------
async function matchRule(form_id: string | null, page_id: string | null, nameHay: string) {
  const { data } = await db.from("routing_rules").select("*").eq("enabled", true);
  const rules = data ?? [];
  const P = (a: any, b: any) => a.priority - b.priority;
  const byForm = rules.filter((r) => r.match_form_id && r.match_form_id === form_id).sort(P);
  if (byForm.length) return byForm[0];
  const byName = rules.filter((r) => r.match_name_pattern && nameHay.includes(String(r.match_name_pattern).toLowerCase())).sort(P);
  if (byName.length) return byName[0];
  const byPage = rules.filter((r) => !r.match_form_id && !r.match_name_pattern && r.match_page_id && r.match_page_id === page_id).sort(P);
  if (byPage.length) return byPage[0];
  const def = rules.filter((r) => r.is_default).sort(P);
  return def[0] ?? null;
}

// --- Pipedrive ------------------------------------------------------------
async function pdCreatePerson(token: string, name: string, email: string, phone: string, ownerId: number) {
  const body: Record<string, unknown> = { name, owner_id: ownerId };
  if (email) body.email = [{ value: email, primary: true, label: "work" }];
  if (phone) body.phone = [{ value: phone, primary: true, label: "work" }];
  const res = await fetch(`${PD}/persons?api_token=${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok || !j?.data?.id) throw new Error(`person create failed: ${res.status} ${JSON.stringify(j?.error ?? j)}`);
  return j.data.id as number;
}

async function pdCreateLead(token: string, payload: Record<string, unknown>) {
  const res = await fetch(`${PD}/leads?api_token=${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await res.json();
  if (!res.ok || !j?.data?.id) throw new Error(`lead create failed: ${res.status} ${JSON.stringify(j?.error ?? j)}`);
  return j.data.id as string;
}

// --- Resend ---------------------------------------------------------------
async function sendEmail(key: string, from: string, to: string[], cc: string[], subject: string, html: string) {
  const payload: Record<string, unknown> = { from, to, subject, html };
  if (cc && cc.length) payload.cc = cc;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "authorization": `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`resend failed: ${res.status} ${await res.text()}`);
}

// --- CAPI -----------------------------------------------------------------
async function sendCapi(
  datasetId: string, token: string, actionSource: string, leadgenId: string,
  eventTime: number, email: string, phone: string, first: string, last: string,
) {
  const ud: Record<string, unknown> = { lead_id: leadgenId };
  if (email) ud.em = [await sha256Hex(email.trim().toLowerCase())];
  if (phone) ud.ph = [await sha256Hex(phone.replace(/[^0-9]/g, ""))];
  if (first) ud.fn = [await sha256Hex(first.trim().toLowerCase())];
  if (last) ud.ln = [await sha256Hex(last.trim().toLowerCase())];
  const res = await fetch(`${GRAPH}/${datasetId}/events?access_token=${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      data: [{
        event_name: "Lead",
        event_time: eventTime,
        action_source: actionSource,
        event_id: leadgenId,
        user_data: ud,
        custom_data: { lead_event_source: "FASTLINE LEADS BRIGHT", event_source: "crm" },
      }],
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`capi failed: ${res.status} ${JSON.stringify(j)}`);
}

// --- core -----------------------------------------------------------------
async function processOne(lead: Record<string, any>) {
  const secrets = await getSecrets();
  const settings = await getSettings();
  await db.from("leads").update({ status: "processing", attempts: (lead.attempts ?? 0) + 1 }).eq("id", lead.id);

  // page token
  const { data: page } = await db.from("fb_pages").select("*").eq("page_id", lead.page_id).maybeSingle();
  if (!page?.access_token) {
    await db.from("leads").update({ status: "failed", last_error: "no page access token for page " + lead.page_id }).eq("id", lead.id);
    return { ok: false, reason: "no_page_token" };
  }

  // fetch full lead from Graph
  const fields = "id,created_time,field_data,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,form_id,platform";
  const gres = await fetch(`${GRAPH}/${lead.leadgen_id}?fields=${fields}&access_token=${page.access_token}`);
  const g = await gres.json();
  if (!gres.ok) {
    await db.from("leads").update({ status: "failed", last_error: `graph fetch: ${gres.status} ${JSON.stringify(g?.error ?? g)}` }).eq("id", lead.id);
    return { ok: false, reason: "graph_failed" };
  }

  const fd: Record<string, string> = {};
  for (const f of g.field_data ?? []) fd[f.name] = (f.values ?? []).join(", ");
  const contact = extractContact(fd);
  const email = contact.email;
  const phone = contact.phone;
  const fullName = contact.fullName;
  const answerParts: string[] = [];
  for (const [k, v] of Object.entries(fd)) {
    if (STD_FIELDS.has(k) || contact.usedKeys.has(k)) continue;
    answerParts.push(`${k}: ${v}`);
  }
  const answer = clip(answerParts.join(" | "));
  const createdTime = g.created_time ? new Date(g.created_time).toISOString() : lead.created_time;

  const enrich = {
    form_id: g.form_id ?? lead.form_id,
    campaign_id: g.campaign_id ?? null,
    campaign_name: g.campaign_name ?? null,
    adset_id: g.adset_id ?? null,
    adset_name: g.adset_name ?? null,
    ad_id: g.ad_id ?? lead.ad_id,
    ad_name: g.ad_name ?? null,
    platform: g.platform ?? null,
    page_name: page.name ?? null,
    form_name: null as string | null,
    created_time: createdTime,
    full_name: fullName,
    email,
    phone,
    field_data: fd,
  };

  // only-new guard
  const goLive = settings.go_live_at ? new Date(settings.go_live_at) : null;
  if (goLive && createdTime && new Date(createdTime) < goLive) {
    await db.from("leads").update({ ...enrich, status: "skipped", crm_status: "skipped", email_status: "skipped", capi_status: "skipped", last_error: "older than go_live_at", processed_at: new Date().toISOString() }).eq("id", lead.id);
    return { ok: true, reason: "old_lead_skipped" };
  }

  const { data: formRow } = await db.from("fb_forms").select("name,archived").eq("form_id", enrich.form_id ?? "").maybeSingle();
  enrich.form_name = formRow?.name ?? null;

  // archived campaign → goes nowhere (restorable from the panel)
  if (formRow?.archived) {
    await db.from("leads").update({ ...enrich, matched_rule_id: null, status: "skipped", crm_status: "skipped", email_status: "skipped", capi_status: "skipped", last_error: "kampania zarchiwizowana", processed_at: new Date().toISOString() }).eq("id", lead.id);
    return { ok: true, reason: "archived" };
  }

  const nameHay = `${enrich.campaign_name ?? ""} ${enrich.form_name ?? ""} ${enrich.form_id ?? ""}`.toLowerCase();
  const rule = await matchRule(enrich.form_id, lead.page_id, nameHay);
  if (!rule) {
    await db.from("leads").update({ ...enrich, status: "skipped", crm_status: "skipped", email_status: "skipped", capi_status: "skipped", last_error: "no matching routing rule" }).eq("id", lead.id);
    return { ok: true, reason: "no_rule" };
  }

  const ownerId = Number(rule.pd_owner_id ?? settings.default_owner_id ?? 14906954);
  let crm_status = "skipped", email_status = "skipped", capi_status = "skipped";
  let pipedrive_lead_id: string | null = null, pipedrive_person_id: number | null = null;
  const errors: string[] = [];

  // --- CRM ---
  if (rule.to_crm) {
    try {
      const personId = await pdCreatePerson(secrets.PIPEDRIVE_TOKEN, fullName || email || "Lead", email, phone, ownerId);
      const campaign = rule.pd_campaign_from_fb ? (enrich.campaign_name ?? "") : (rule.pd_campaign_static ?? "");
      const payload: Record<string, unknown> = {
        title: clip(fullName || email || "Facebook Lead"),
        person_id: personId,
        owner_id: ownerId,
        label_ids: rule.pd_label_ids ?? [],
        [F_SOURCE]: rule.pd_source_option_id ?? 26,
        [F_CAMPAIGN]: clip(campaign),
        [rule.answer_field_key || F_ANSWER]: answer, // already clipped to 255
      };
      for (const m of (rule.field_map ?? []) as any[]) {
        if (m?.question && m?.pd_field_key && fd[m.question] != null) payload[m.pd_field_key] = clip(String(fd[m.question]));
      }
      pipedrive_person_id = personId;
      pipedrive_lead_id = await pdCreateLead(secrets.PIPEDRIVE_TOKEN, payload);
      crm_status = "sent";
    } catch (e) {
      crm_status = "failed";
      errors.push(String(e));
    }
  }

  // --- e-mail ---
  if (rule.to_email) {
    try {
      const recipients: string[] = (rule.email_recipients?.length ? rule.email_recipients : []);
      if (!recipients.length) throw new Error("to_email is on but no recipients configured");
      const from = String(settings.email_from ?? "leads@fastlineracingacademy.pl");
      const rows = Object.entries(fd).map(([k, v]) => `<tr><td style="padding:4px 10px;color:#888">${k}</td><td style="padding:4px 10px"><b>${v}</b></td></tr>`).join("");
      const html = `<div style="font-family:Arial,sans-serif"><h2 style="color:#e11d2a">Nowy lead — ${fullName || "(bez nazwy)"}</h2>
        <p>Kampania: <b>${enrich.campaign_name ?? "-"}</b><br>Formularz: <b>${enrich.form_id ?? "-"}</b></p>
        <table style="border-collapse:collapse">${rows}</table>
        <p style="color:#aaa;font-size:12px;margin-top:16px">FASTLINE LEADS BRIGHT</p></div>`;
      const cc: string[] = rule.email_cc?.length ? rule.email_cc : [];
      await sendEmail(secrets.RESEND_KEY, from, recipients, cc, `Nowy lead: ${fullName || email}`, html);
      email_status = "sent";
    } catch (e) {
      email_status = "failed";
      errors.push(String(e));
    }
  }

  // --- CAPI ---
  if (settings.capi_enabled === true && secrets.FB_CAPI_TOKEN && settings.capi_pixel_id) {
    try {
      const [first, last] = firstLast(fullName, fd);
      const evtTime = Math.floor((createdTime ? new Date(createdTime).getTime() : Date.now()) / 1000);
      const action = String(settings.capi_action_source ?? "system_generated");
      await sendCapi(String(settings.capi_pixel_id), secrets.FB_CAPI_TOKEN, action, lead.leadgen_id, evtTime, email, phone, first, last);
      capi_status = "sent";
    } catch (e) {
      capi_status = "failed";
      errors.push(String(e));
    }
  }

  const anyFailed = [crm_status, email_status, capi_status].includes("failed");
  const status = anyFailed ? "failed" : (crm_status === "skipped" && email_status === "skipped" ? "skipped" : "done");

  await db.from("leads").update({
    ...enrich,
    matched_rule_id: rule.id,
    crm_status, email_status, capi_status, status,
    pipedrive_lead_id, pipedrive_person_id,
    last_error: errors.length ? errors.join(" || ") : null,
    processed_at: new Date().toISOString(),
  }).eq("id", lead.id);

  return { ok: !anyFailed, crm_status, email_status, capi_status };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const secrets = await getSecrets();
  const token = req.headers.get("x-internal-token") ?? "";
  if (!secrets.INTERNAL_TOKEN || token !== secrets.INTERNAL_TOKEN) {
    return new Response("unauthorized", { status: 401 });
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }

  try {
    if (body.batch) {
      const limit = Math.min(Number(body.limit ?? 20), 100);
      const { data } = await db.from("leads").select("*")
        .in("status", ["pending", "failed"]).lt("attempts", 5)
        .order("received_at", { ascending: true }).limit(limit);
      const results = [];
      for (const l of data ?? []) results.push(await processOne(l));
      return Response.json({ processed: results.length, results });
    }

    let q = db.from("leads").select("*").limit(1);
    if (body.lead_id) q = q.eq("id", body.lead_id);
    else if (body.leadgen_id) q = q.eq("leadgen_id", String(body.leadgen_id));
    else return new Response("leadgen_id, lead_id or batch required", { status: 400 });

    const { data } = await q;
    const lead = data?.[0];
    if (!lead) return new Response("lead not found", { status: 404 });
    if (lead.status === "done") return Response.json({ ok: true, reason: "already_done" });

    const r = await processOne(lead);
    return Response.json(r);
  } catch (e) {
    console.error("process-lead error", e);
    return new Response("server error: " + String(e), { status: 500 });
  }
});
