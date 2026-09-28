// admin-api — backend for the FASTLINE LEADS BRIGHT panel.
// Own session auth (bcrypt + sessions table). Action-based JSON router.
// Deploy with verify_jwt = false (custom auth via Bearer session token).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import bcrypt from "https://esm.sh/bcryptjs@2.4.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const GRAPH = "https://graph.facebook.com/v21.0";
const PD = "https://api.pipedrive.com/v1";
const SESSION_DAYS = 7;

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "content-type": "application/json" } });

let secretsCache: Record<string, string> | null = null;
async function getSecrets() {
  if (secretsCache) return secretsCache;
  const { data, error } = await db.from("app_secrets").select("key,value");
  if (error) throw new Error(error.message);
  secretsCache = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
  return secretsCache;
}

async function auth(req: Request) {
  const h = req.headers.get("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return null;
  const { data: s } = await db.from("sessions").select("*").eq("token", token).maybeSingle();
  if (!s || new Date(s.expires_at) < new Date()) return null;
  const { data: u } = await db.from("app_users").select("id,username,role,active").eq("id", s.user_id).maybeSingle();
  if (!u || !u.active) return null;
  db.from("sessions").update({ last_seen_at: new Date().toISOString() }).eq("token", token).then(() => {});
  return u;
}

// ---- Pipedrive helpers ----
async function pdGet(token: string, path: string) {
  const res = await fetch(`${PD}${path}${path.includes("?") ? "&" : "?"}api_token=${token}`);
  return await res.json();
}

// ---- Facebook helpers ----
async function fbGet(url: string) {
  const res = await fetch(url);
  const j = await res.json();
  if (!res.ok) throw new Error(j?.error?.message ?? `graph ${res.status}`);
  return j;
}

// ---- wiadomości do klienta: helpery testowej wysyłki (kopia z process-lead) ----
const escHtml = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function renderText(tpl: string, vars: Record<string, string>): string {
  return String(tpl ?? "").replace(/\{\{\s*link\s*\}\}/g, vars.link).replace(/\{\{\s*imie\s*\}\}/g, vars.imie);
}
function brandedEmailHtml(bodyTpl: string, vars: Record<string, string>): string {
  const btn = `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px auto"><tr><td style="background:linear-gradient(145deg,#ff3b47,#e11d2a);background-color:#e11d2a;"><a href="${vars.link}" style="display:inline-block;padding:15px 34px;color:#ffffff;font-weight:700;font-size:15px;text-decoration:none;font-family:Arial,sans-serif;letter-spacing:.4px">WYBIERZ TERMIN ROZMOWY&nbsp;›</a></td></tr></table>`;
  const paras = escHtml(bodyTpl)
    .replace(/\{\{\s*imie\s*\}\}/g, escHtml(vars.imie))
    .split(/\n/)
    .map((l) => {
      const t = l.trim();
      if (!t) return "";
      if (/^\{\{\s*link\s*\}\}$/.test(t)) return btn;
      return `<p style="margin:0 0 12px;color:#2b2325;font-size:15px;line-height:1.6;font-family:Arial,sans-serif">${t.replace(/\{\{\s*link\s*\}\}/g, `<a href="${vars.link}" style="color:#e11d2a;font-weight:700">${vars.link}</a>`)}</p>`;
    })
    .join("");
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f3eeef">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3eeef;padding:28px 12px"><tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-top:4px solid #e11d2a;box-shadow:0 8px 30px rgba(0,0,0,.08)">
      <tr><td style="background:#ffffff;padding:28px 32px 10px" align="center">
        <img src="${vars.logo_url}" alt="Fastline Racing Academy" width="190" style="display:block;width:190px;height:auto;border:0">
      </td></tr>
      <tr><td style="padding:32px 32px 20px">${paras}</td></tr>
      <tr><td style="padding:0 32px 28px">
        <div style="border-top:1px solid #eee2e3;padding-top:16px;color:#a08a8d;font-size:12px;font-family:Arial,sans-serif;line-height:1.6">
          Fastline Racing Academy · <a href="https://www.fastlineracingacademy.pl" style="color:#e11d2a;text-decoration:none">fastlineracingacademy.pl</a><br>
          Ta wiadomość została wysłana automatycznie po Twoim zgłoszeniu.
        </div>
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
}
async function sendResend(key: string, from: string, to: string, subject: string, html: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "authorization": `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  if (!res.ok) throw new Error(`resend: ${res.status} ${await res.text()}`);
}
async function sendSms(token: string, from: string, phone: string, message: string) {
  let to = phone.replace(/[^\d]/g, "");
  if (to.length === 9) to = "48" + to;
  const params = new URLSearchParams({ to, from, message, format: "json", encoding: "utf-8" });
  const res = await fetch("https://api.smsapi.pl/sms.do", {
    method: "POST",
    headers: { "authorization": `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(`smsapi: ${JSON.stringify(j)}`);
}

// ---- Ringostat (zakładka Analityka) ----
const RS = "https://api.ringostat.net";
// "YYYY-MM-DD" (dzień w Europe/Warsaw) -> ISO początku dnia
function warsawDayStart(day: string): string {
  const probe = new Date(`${day}T12:00:00Z`);
  const off = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Warsaw", timeZoneName: "shortOffset" })
    .formatToParts(probe).find((p) => p.type === "timeZoneName")?.value ?? "GMT+1";
  const m = off.match(/GMT([+-])(\d+)/);
  const h = m ? (m[1] === "-" ? -1 : 1) * Number(m[2]) : 1;
  return new Date(new Date(`${day}T00:00:00Z`).getTime() - h * 3600_000).toISOString();
}
function rsRange(body: any) {
  const today = new Date().toISOString().slice(0, 10);
  const to = String(body.to || today);
  const from = String(body.from || new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10));
  const next = new Date(new Date(`${to}T12:00:00Z`).getTime() + 864e5).toISOString().slice(0, 10);
  return { from, to, fromTs: warsawDayStart(from), toTs: warsawDayStart(next) };
}
const RS_LIST_COLS = "uniqueid,calldate,call_type,disposition,answered,client_phone,caller,dst,connected_with,n_alias,pool_name,scheme_name,duration,billsec,waittime,call_counter,proper_flag,repeated_flag,employee_fio,missing_reason,has_recording,recording,call_card,utm_source,utm_campaign,lead_id,ai_title,ai_summary,ai_score,ai_at";
async function attachLeads(rows: any[]) {
  const ids = [...new Set(rows.map((r) => r.lead_id).filter(Boolean))];
  if (!ids.length) return rows;
  const { data } = await db.from("leads").select("id,full_name,email,phone,campaign_name,form_name,page_name,pipedrive_lead_id,received_at").in("id", ids);
  const byId = Object.fromEntries((data ?? []).map((l) => [l.id, l]));
  return rows.map((r) => ({ ...r, lead: r.lead_id ? byId[r.lead_id] ?? null : null }));
}
async function runRsSync(secrets: Record<string, string>, payload: unknown = {}) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/ringostat-sync`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": secrets.INTERNAL_TOKEN, "authorization": `Bearer ${SERVICE_ROLE}` },
    body: JSON.stringify(payload),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok === false) throw new Error(j.error ?? `sync ${res.status}`);
  return j;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const action = body.action as string;
  const secrets = await getSecrets();

  try {
    // ---------- login (no session) ----------
    if (action === "login") {
      const { data: u } = await db.from("app_users").select("*").eq("username", body.username).eq("active", true).maybeSingle();
      if (!u || !bcrypt.compareSync(String(body.password ?? ""), u.password_hash)) {
        return json({ error: "Nieprawidłowy login lub hasło" }, 401);
      }
      const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
      const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
      await db.from("sessions").insert({ token, user_id: u.id, expires_at: expires });
      return json({ token, user: { id: u.id, username: u.username, role: u.role } });
    }

    // ---------- everything else requires a session ----------
    const user = await auth(req);
    if (!user) return json({ error: "unauthorized" }, 401);
    const isAdmin = user.role === "admin";
    const needAdmin = () => { if (!isAdmin) throw new Error("forbidden"); };

    switch (action) {
      case "me":
        return json({ user });

      case "logout": {
        const h = req.headers.get("authorization") ?? "";
        await db.from("sessions").delete().eq("token", h.slice(7));
        return json({ ok: true });
      }

      case "stats": {
        // zakres dat z filtra Pulpitu (domyślnie ostatnie 30 dni)
        const to = body.to ? new Date(body.to) : new Date();
        const from = body.from ? new Date(body.from) : new Date(to.getTime() - 30 * 864e5);
        const toEnd = new Date(to.getTime() + 864e5 - 1); // włącznie z dniem "do"
        const { data: rows } = await db.from("leads")
          .select("status,crm_status,email_status,client_email_status,client_sms_status,received_at,campaign_name,page_name,form_name,form_id")
          .gte("received_at", from.toISOString()).lte("received_at", toEnd.toISOString())
          .order("received_at", { ascending: true }).limit(10000);
        const all = rows ?? [];
        const todayStr = new Date().toISOString().slice(0, 10);
        const byDayMap: Record<string, number> = {};
        const byCampaign: Record<string, number> = {};
        const byPage: Record<string, number> = {};
        for (const r of all) {
          const d = String(r.received_at).slice(0, 10);
          byDayMap[d] = (byDayMap[d] ?? 0) + 1;
          const c = r.campaign_name || r.form_name || r.form_id || "(nieznana)";
          byCampaign[c] = (byCampaign[c] ?? 0) + 1;
          const p = r.page_name || "(nieznana)";
          byPage[p] = (byPage[p] ?? 0) + 1;
        }
        const byDay = Object.entries(byDayMap).map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date));
        const top = (m: Record<string, number>, n = 8) => Object.entries(m).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, n);
        const { count: total } = await db.from("leads").select("*", { count: "exact", head: true });
        // rezerwacje: w zakresie + nadchodzące
        const { data: bkRange } = await db.from("callback_bookings").select("id").eq("status", "booked")
          .gte("created_at", from.toISOString()).lte("created_at", toEnd.toISOString());
        const { count: bkUpcoming } = await db.from("callback_bookings").select("*", { count: "exact", head: true })
          .eq("status", "booked").gte("slot_at", new Date().toISOString());
        return json({
          total: total ?? 0,
          range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
          inRange: all.length,
          last30: all.length,
          today: all.filter((r) => String(r.received_at).slice(0, 10) === todayStr).length,
          done: all.filter((r) => r.status === "done").length,
          failed: all.filter((r) => r.status === "failed").length,
          pending: all.filter((r) => r.status === "pending" || r.status === "processing").length,
          skipped: all.filter((r) => r.status === "skipped").length,
          crmSent: all.filter((r) => r.crm_status === "sent").length,
          emailSent: all.filter((r) => r.email_status === "sent").length,
          clientEmailSent: all.filter((r) => r.client_email_status === "sent").length,
          clientSmsSent: all.filter((r) => r.client_sms_status === "sent").length,
          bookingsInRange: (bkRange ?? []).length,
          bookingsUpcoming: bkUpcoming ?? 0,
          byDay,
          topCampaigns: top(byCampaign),
          topPages: top(byPage, 6),
        });
      }

      // ---- szablony wiadomości do klienta ----
      case "templates.list": {
        const { data } = await db.from("client_templates").select("*").order("priority", { ascending: true });
        return json({ rows: data ?? [] });
      }
      case "templates.upsert": {
        needAdmin();
        const t = { ...body.template, updated_at: new Date().toISOString() };
        if (t.is_default) await db.from("client_templates").update({ is_default: false }).neq("id", t.id ?? "00000000-0000-0000-0000-000000000000");
        if (!t.id) delete t.id;
        const { data, error } = await db.from("client_templates").upsert(t).select().single();
        if (error) throw new Error(error.message);
        return json({ template: data });
      }
      case "templates.delete":
        needAdmin();
        await db.from("client_templates").delete().eq("id", body.id);
        return json({ ok: true });

      // ---- rezerwacje oddzwonień ----
      case "bookings.list": {
        const mode = body.mode === "all" ? "all" : "upcoming";
        let q = db.from("callback_bookings").select("*").order("slot_at", { ascending: mode === "upcoming" });
        if (mode === "upcoming") q = q.eq("status", "booked").gte("slot_at", new Date(Date.now() - 3600_000).toISOString());
        const { data: bks } = await q.limit(300);
        const leadIds = [...new Set((bks ?? []).map((b) => b.lead_id))];
        let leadsById: Record<string, any> = {};
        if (leadIds.length) {
          const { data: ls } = await db.from("leads").select("id,full_name,email,phone,campaign_name,form_name,page_name,pipedrive_lead_id").in("id", leadIds);
          leadsById = Object.fromEntries((ls ?? []).map((l) => [l.id, l]));
        }
        return json({ rows: (bks ?? []).map((b) => ({ ...b, lead: leadsById[b.lead_id] ?? null })) });
      }

      // ---- Ringostat: analityka rozmów (dostępne dla wszystkich ról) ----
      case "rs.overview": {
        const r = rsRange(body);
        const { data: stats, error } = await db.rpc("rs_stats", { p_from: r.fromTs, p_to: r.toTs, p_employee: body.employee || null });
        if (error) throw new Error(error.message);
        const { data: st } = await db.from("settings").select("key,value").in("key", ["rs_last_sync_at", "rs_last_sync_result"]);
        const s = Object.fromEntries((st ?? []).map((x) => [x.key, x.value]));
        const { data: emps } = await db.from("rs_employees").select("staff_id,fio,extension,online").order("extension");
        return json({ range: { from: r.from, to: r.to }, stats, employees: emps ?? [], lastSync: s.rs_last_sync_result ?? null });
      }
      case "rs.calls": {
        const r = rsRange(body);
        const limit = Math.min(Number(body.limit ?? 50), 500);
        const offset = Number(body.offset ?? 0);
        let q = db.from("rs_calls").select(RS_LIST_COLS, { count: "exact" })
          .gte("calldate", r.fromTs).lt("calldate", r.toTs)
          .order("calldate", { ascending: false }).range(offset, offset + limit - 1);
        if (body.type === "in") q = q.in("call_type", ["in", "transitin"]);
        if (body.type === "out") q = q.eq("call_type", "out");
        if (body.type === "callback") q = q.eq("call_type", "callback");
        if (body.status === "answered") q = q.eq("answered", true);
        if (body.status === "missed") q = q.eq("answered", false);
        if (body.employee) q = q.eq("employee_fio", body.employee);
        if (body.onlyAi) q = q.not("ai_at", "is", null);
        if (body.onlyLead) q = q.not("lead_id", "is", null);
        if (body.onlyRecording) q = q.eq("has_recording", true);
        if (body.minSec) q = q.gte("billsec", Number(body.minSec));
        const qd = String(body.q ?? "").replace(/\D/g, "");
        if (qd.length >= 3) q = q.like("client_phone", `%${qd.slice(-9)}%`);
        else if (body.q) {
          const t = String(body.q).replace(/[%,()]/g, " ");
          q = q.or(`ai_summary.ilike.%${t}%,ai_title.ilike.%${t}%,employee_fio.ilike.%${t}%`);
        }
        const { data, count, error } = await q;
        if (error) throw new Error(error.message);
        return json({ rows: await attachLeads(data ?? []), total: count ?? 0 });
      }
      case "rs.call": {
        const { data: c } = await db.from("rs_calls").select("*").eq("uniqueid", body.id).maybeSingle();
        if (!c) throw new Error("Nie znaleziono rozmowy");
        let history: any[] = [];
        if (c.client_phone && c.client_phone.length >= 9) {
          const { data } = await db.from("rs_calls").select(RS_LIST_COLS)
            .eq("phone9", c.client_phone.slice(-9)).order("calldate", { ascending: false }).limit(100);
          history = data ?? [];
        }
        const [withLead] = await attachLeads([c]);
        delete (withLead as any).raw;
        return json({ call: withLead, raw: c.raw, history });
      }
      case "rs.leadCalls": {
        const { data: l } = await db.from("leads").select("id,phone").eq("id", body.lead_id).maybeSingle();
        const p = String(l?.phone ?? "").replace(/\D/g, "");
        let q = db.from("rs_calls").select(RS_LIST_COLS).order("calldate", { ascending: false }).limit(50);
        q = p.length >= 9 ? q.or(`lead_id.eq.${body.lead_id},phone9.eq.${p.slice(-9)}`) : q.eq("lead_id", body.lead_id);
        const { data } = await q;
        return json({ rows: data ?? [] });
      }
      case "rs.missed": {
        const r = rsRange(body);
        const { data, error } = await db.rpc("rs_missed_open", { p_from: r.fromTs, p_to: r.toTs });
        if (error) throw new Error(error.message);
        const rows = (data ?? []).sort((a: any, b: any) => String(b.calldate).localeCompare(String(a.calldate)));
        return json({ rows: await attachLeads(rows) });
      }
      case "rs.live": {
        const h = { "Auth-key": secrets.RINGOSTAT_AUTH_KEY, "x-project-id": secrets.RINGOSTAT_PROJECT_ID };
        const [online, speaking] = await Promise.all([
          fetch(`${RS}/sipstatus/online`, { headers: h }).then((r) => r.json()).catch(() => []),
          fetch(`${RS}/sipstatus/speaking`, { headers: h }).then((r) => r.json()).catch(() => []),
        ]);
        const on = new Set((Array.isArray(online) ? online : []).map(String));
        const sp = new Set((Array.isArray(speaking) ? speaking : []).map((x: any) => String(typeof x === "object" ? (x.login ?? x.sip ?? JSON.stringify(x)) : x)));
        const { data: emps } = await db.from("rs_employees").select("*").order("extension");
        const today = warsawDayStart(new Date().toISOString().slice(0, 10));
        const { data: todayCalls } = await db.from("rs_calls").select("employee_fio,billsec,call_type").gte("calldate", today).limit(1000);
        return json({
          at: new Date().toISOString(),
          raw: { online, speaking },
          employees: (emps ?? []).map((e) => {
            const logins: string[] = e.sip_logins ?? [];
            const mine = (todayCalls ?? []).filter((c) => c.employee_fio === e.fio);
            return {
              fio: e.fio, extension: e.extension, email: e.email,
              online: logins.some((l) => on.has(l)),
              speaking: logins.some((l) => sp.has(l) || [...sp].some((s) => s.includes(l))),
              devices: logins.filter((l) => on.has(l)).map((l) => (l.endsWith("_rspmob") ? "aplikacja mobilna" : "Smart Phone / SIP")),
              today: { calls: mine.length, talk: mine.reduce((a, c) => a + (c.billsec ?? 0), 0), out: mine.filter((c) => c.call_type === "out").length },
            };
          }),
        });
      }
      case "rs.employees": {
        const { data } = await db.from("rs_employees").select("staff_id,fio,extension,online").order("extension");
        return json({ rows: data ?? [] });
      }
      case "rs.sync":
        return json(await runRsSync(secrets));
      case "rs.config": {
        const { count: calls } = await db.from("rs_calls").select("*", { count: "exact", head: true });
        const { count: ai } = await db.from("rs_calls").select("*", { count: "exact", head: true }).not("ai_at", "is", null);
        const { data: events } = await db.from("rs_webhook_events").select("id,received_at,call_id,status,error").order("id", { ascending: false }).limit(10);
        const { data: st } = await db.from("settings").select("value").eq("key", "rs_last_sync_result").maybeSingle();
        return json({
          projectId: secrets.RINGOSTAT_PROJECT_ID,
          connected: !!secrets.RINGOSTAT_AUTH_KEY,
          webhookUrl: isAdmin ? `${SUPABASE_URL}/functions/v1/ringostat-webhook?token=${secrets.RINGOSTAT_WEBHOOK_TOKEN}` : null,
          calls: calls ?? 0, ai: ai ?? 0, events: events ?? [], lastSync: st?.value ?? null,
        });
      }

      // ---- testowa wysyłka (Ustawienia) ----
      case "client.testSend": {
        needAdmin();
        const { data: tpl } = await db.from("client_templates").select("*").eq("id", body.template_id).maybeSingle();
        if (!tpl) throw new Error("Nie znaleziono szablonu");
        const { data: st } = await db.from("settings").select("key,value");
        const settings = Object.fromEntries((st ?? []).map((r) => [r.key, r.value]));
        const base = String(settings.booking_url_base ?? "https://leads.fastlineracingacademy.pl/calendar");
        const vars = { link: `${base}?t=demo`, imie: "Anna", logo_url: "https://kltggicuonljcgyehcev.supabase.co/storage/v1/object/public/assets/logo-mail.png" };
        const out: Record<string, string> = {};
        if (body.email) {
          const from = `Fastline Racing Academy <${String(settings.email_from ?? "leads@fastlineracingacademy.pl")}>`;
          await sendResend(secrets.RESEND_KEY, from, String(body.email), "[TEST] " + renderText(tpl.email_subject, vars), brandedEmailHtml(tpl.email_body, vars));
          out.email = "sent";
        }
        if (body.phone) {
          if (!secrets.SMSAPI_TOKEN) throw new Error("Brak SMSAPI_TOKEN w sekretach");
          await sendSms(secrets.SMSAPI_TOKEN, String(settings.sms_sender ?? "FASTLINE RA"), String(body.phone), renderText(tpl.sms_body, vars));
          out.sms = "sent";
        }
        return json({ ok: true, ...out });
      }

      case "leads.list": {
        const limit = Math.min(Number(body.limit ?? 50), 200);
        const offset = Number(body.offset ?? 0);
        let q = db.from("leads").select("*", { count: "exact" }).order("received_at", { ascending: false }).range(offset, offset + limit - 1);
        if (body.status && body.status !== "all") q = q.eq("status", body.status);
        if (body.q) q = q.or(`full_name.ilike.%${body.q}%,email.ilike.%${body.q}%,campaign_name.ilike.%${body.q}%`);
        const { data, count } = await q;
        return json({ rows: data ?? [], total: count ?? 0 });
      }

      case "lead.reprocess": {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/process-lead`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-internal-token": secrets.INTERNAL_TOKEN, "apikey": SERVICE_ROLE, "authorization": `Bearer ${SERVICE_ROLE}` },
          body: JSON.stringify({ lead_id: body.id }),
        });
        return json(await res.json(), res.ok ? 200 : 500);
      }

      case "rules.list": {
        const { data } = await db.from("routing_rules").select("*").order("priority", { ascending: true });
        return json({ rows: data ?? [] });
      }
      case "rules.upsert": {
        needAdmin();
        const r = { ...body.rule, updated_at: new Date().toISOString() };
        const { data, error } = await db.from("routing_rules").upsert(r).select().single();
        if (error) throw new Error(error.message);
        return json({ rule: data });
      }
      case "rules.delete":
        needAdmin();
        await db.from("routing_rules").delete().eq("id", body.id);
        return json({ ok: true });

      case "settings.get": {
        const { data } = await db.from("settings").select("key,value");
        return json({ settings: Object.fromEntries((data ?? []).map((r) => [r.key, r.value])) });
      }
      case "settings.set": {
        needAdmin();
        await db.from("settings").upsert({ key: body.key, value: body.value, updated_at: new Date().toISOString() });
        return json({ ok: true });
      }

      case "users.list": {
        needAdmin();
        const { data } = await db.from("app_users").select("id,username,role,active,created_at").order("created_at", { ascending: true });
        return json({ rows: data ?? [] });
      }
      case "users.create": {
        needAdmin();
        const hash = bcrypt.hashSync(String(body.password), 10);
        const { data, error } = await db.from("app_users").insert({ username: body.username, password_hash: hash, role: body.role ?? "operator", created_by: user.id }).select("id,username,role,active").single();
        if (error) throw new Error(error.message.includes("duplicate") ? "Taki użytkownik już istnieje" : error.message);
        return json({ user: data });
      }
      case "users.update": {
        needAdmin();
        const patch: Record<string, unknown> = {};
        if (body.role) patch.role = body.role;
        if (typeof body.active === "boolean") patch.active = body.active;
        if (body.password) patch.password_hash = bcrypt.hashSync(String(body.password), 10);
        await db.from("app_users").update(patch).eq("id", body.id);
        return json({ ok: true });
      }
      case "users.delete":
        needAdmin();
        if (body.id === user.id) throw new Error("Nie można usunąć samego siebie");
        await db.from("app_users").delete().eq("id", body.id);
        return json({ ok: true });

      // ---- Pipedrive dropdown metadata for the routing editor ----
      case "pd.meta": {
        const [labels, users] = await Promise.all([
          pdGet(secrets.PIPEDRIVE_TOKEN, "/leadLabels"),
          pdGet(secrets.PIPEDRIVE_TOKEN, "/users"),
        ]);
        return json({
          labels: (labels?.data ?? []).map((l: any) => ({ id: l.id, name: l.name, color: l.color })),
          owners: (users?.data ?? []).filter((u: any) => u.active_flag).map((u: any) => ({ id: u.id, name: u.name })),
        });
      }

      // ---- Facebook ----
      case "fb.pages": {
        const { data } = await db.from("fb_pages").select("page_id,name,token_valid,subscribed,last_synced_at,updated_at").order("name");
        return json({ rows: data ?? [] });
      }
      case "fb.connect": {
        needAdmin();
        const userToken = String(body.user_token ?? "").trim();
        if (!userToken) throw new Error("Brak tokenu użytkownika");
        // exchange to long-lived (best-effort: system-user tokens can't be
        // exchanged and are already non-expiring — fall back to the original).
        let longToken = userToken;
        try {
          const ll = await fbGet(`${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${secrets.FB_APP_ID}&client_secret=${secrets.FB_APP_SECRET}&fb_exchange_token=${encodeURIComponent(userToken)}`);
          if (ll.access_token) longToken = ll.access_token;
        } catch (_e) { /* keep original token */ }
        // fetch all managed pages with their (long-lived) page tokens
        const pages: any[] = [];
        let url = `${GRAPH}/me/accounts?fields=id,name,access_token&limit=100&access_token=${longToken}`;
        for (let i = 0; i < 20 && url; i++) {
          const j = await fbGet(url);
          pages.push(...(j.data ?? []));
          url = j.paging?.next ?? "";
        }
        for (const p of pages) {
          await db.from("fb_pages").upsert({
            page_id: String(p.id), name: p.name, access_token: p.access_token,
            token_valid: true, token_checked_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          }, { onConflict: "page_id" });
        }
        return json({ connected: pages.length, pages: pages.map((p) => ({ page_id: p.id, name: p.name })) });
      }
      case "fb.subscribe": {
        needAdmin();
        const { data: p } = await db.from("fb_pages").select("*").eq("page_id", body.page_id).maybeSingle();
        if (!p?.access_token) throw new Error("Strona nie połączona");
        const res = await fetch(`${GRAPH}/${p.page_id}/subscribed_apps`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subscribed_fields: "leadgen", access_token: p.access_token }),
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j?.error?.message ?? "subscribe failed");
        await db.from("fb_pages").update({ subscribed: true, updated_at: new Date().toISOString() }).eq("page_id", body.page_id);
        return json({ ok: true });
      }
      case "fb.syncForms": {
        needAdmin();
        const { data: p } = await db.from("fb_pages").select("*").eq("page_id", body.page_id).maybeSingle();
        if (!p?.access_token) throw new Error("Strona nie połączona");
        const forms: any[] = [];
        let url = `${GRAPH}/${p.page_id}/leadgen_forms?fields=id,name,status,locale,questions,created_time,leads_count&limit=100&access_token=${p.access_token}`;
        for (let i = 0; i < 20 && url; i++) {
          const j = await fbGet(url);
          forms.push(...(j.data ?? []));
          url = j.paging?.next ?? "";
        }
        // keep only currently-running campaigns: ACTIVE status AND (recent OR has leads).
        // Facebook keeps thousands of old forms as "ACTIVE" (non-archived) forever, so
        // recency/leads is the real "running now" signal.
        const cutoff = Date.now() - 120 * 864e5;
        const active = forms.filter((f) =>
          f.status === "ACTIVE" &&
          ((Number(f.leads_count) > 0) || (f.created_time && new Date(f.created_time).getTime() >= cutoff))
        );
        await db.from("fb_forms").delete().eq("page_id", p.page_id);
        for (const f of active) {
          await db.from("fb_forms").upsert({
            form_id: String(f.id), page_id: String(p.page_id), name: f.name, status: f.status,
            locale: f.locale, questions: f.questions ?? null,
            created_time: f.created_time ? new Date(f.created_time).toISOString() : null,
            leads_count: f.leads_count ?? null, last_synced_at: new Date().toISOString(),
          }, { onConflict: "form_id" });
        }
        await db.from("fb_pages").update({ last_synced_at: new Date().toISOString() }).eq("page_id", body.page_id);
        return json({ synced: active.length });
      }
      case "fb.forms": {
        let q = db.from("fb_forms").select("form_id,page_id,name,status,created_time,leads_count,archived").order("created_time", { ascending: false });
        if (body.page_id) q = q.eq("page_id", body.page_id);
        const { data } = await q;
        return json({ rows: data ?? [] });
      }
      case "form.archive": {
        needAdmin();
        await db.from("fb_forms").update({ archived: true }).eq("form_id", body.form_id);
        return json({ ok: true });
      }
      case "form.restore": {
        needAdmin();
        await db.from("fb_forms").update({ archived: false }).eq("form_id", body.form_id);
        return json({ ok: true });
      }

      default:
        return json({ error: "unknown action: " + action }, 400);
    }
  } catch (e) {
    const msg = String(e?.message ?? e);
    return json({ error: msg }, msg === "forbidden" ? 403 : 400);
  }
});
