// booking — publiczny API kalendarza oddzwonień (strona /calendar).
// Klient dostaje w e-mailu/SMS-ie osobisty link z tokenem (leads.booking_token)
// i wybiera slot 20-minutowy (pon–pt 10:00–18:00 Europe/Warsaw).
//
// Actions (POST JSON):
//   { action: "info", t }              -> lead + siatka slotów + obecna rezerwacja
//   { action: "book", t, slot }        -> rezerwuje slot (ISO); zmiana terminu = nowa rezerwacja
//
// Token "demo" = tryb podglądu (nic nie zapisuje) — do testów z panelu.
// Po rezerwacji: notatka + aktywność "call" na leadzie w Pipedrive.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const PD = "https://api.pipedrive.com/v1";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "content-type": "application/json" } });

async function getSecrets() {
  const { data, error } = await db.from("app_secrets").select("key,value");
  if (error) throw new Error(error.message);
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
}
async function getSettings() {
  const { data, error } = await db.from("settings").select("key,value");
  if (error) throw new Error(error.message);
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
}

// ---- strefa czasowa (Europe/Warsaw) bez zewnętrznych bibliotek ----
function tzOffsetMs(ts: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(ts))) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUTC - ts;
}
// lokalna data/godzina w tz -> Date (UTC)
function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let ts = wall - tzOffsetMs(wall, tz);
  ts = wall - tzOffsetMs(ts, tz); // druga iteracja łapie zmianę czasu
  return new Date(ts);
}
function localParts(ts: number, tz: string) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(ts))) p[part.type] = part.value;
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday] ?? 0;
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour % 24, mm: +p.minute, weekday: wd };
}

type Cfg = { tz: string; days: number[]; start: string; end: string; step_min: number; horizon_days: number; min_notice_min: number };
const DEF_CFG: Cfg = { tz: "Europe/Warsaw", days: [1, 2, 3, 4, 5], start: "10:00", end: "18:00", step_min: 20, horizon_days: 14, min_notice_min: 60 };

// siatka slotów: [{date:"YYYY-MM-DD", slots:[isoUTC,...]}] — tylko przyszłe
function buildGrid(cfg: Cfg, now: Date) {
  const [sh, sm] = cfg.start.split(":").map(Number);
  const [eh, em] = cfg.end.split(":").map(Number);
  const minTs = now.getTime() + cfg.min_notice_min * 60_000;
  const days: { date: string; slots: string[] }[] = [];
  // idziemy dzień po dniu wg lokalnego kalendarza
  const startLocal = localParts(now.getTime(), cfg.tz);
  let cur = new Date(Date.UTC(startLocal.y, startLocal.m - 1, startLocal.d, 12, 0)); // południe ≈ stabilny dzień
  // zapas iteracji: horyzont liczony w dniach roboczych, kalendarz ma też weekendy
  for (let i = 0; i < cfg.horizon_days * 2 + 7 && days.length < cfg.horizon_days; i++) {
    const lp = localParts(cur.getTime(), cfg.tz);
    if (cfg.days.includes(lp.weekday)) {
      const slots: string[] = [];
      for (let t = sh * 60 + sm; t + cfg.step_min <= eh * 60 + em; t += cfg.step_min) {
        const slot = zonedToUtc(lp.y, lp.m, lp.d, Math.floor(t / 60), t % 60, cfg.tz);
        if (slot.getTime() >= minTs) slots.push(slot.toISOString());
      }
      if (slots.length) {
        days.push({ date: `${lp.y}-${String(lp.m).padStart(2, "0")}-${String(lp.d).padStart(2, "0")}`, slots });
      }
    }
    cur = new Date(cur.getTime() + 864e5);
  }
  return days;
}

function plDateTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("pl-PL", {
    timeZone: tz, weekday: "long", day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  }).format(new Date(iso));
}

async function takenSlots(fromIso: string): Promise<Set<string>> {
  const { data } = await db.from("callback_bookings").select("slot_at").eq("status", "booked").gte("slot_at", fromIso);
  return new Set((data ?? []).map((r) => new Date(r.slot_at).toISOString()));
}

// ---- Pipedrive: notatka + aktywność "call" ----
async function pdNotify(secrets: Record<string, string>, settings: Record<string, unknown>, lead: any, slotIso: string, cfg: Cfg, existing: any | null) {
  const token = secrets.PIPEDRIVE_TOKEN;
  if (!token || !lead.pipedrive_lead_id) return { activityId: null, noteId: null };
  const when = plDateTime(slotIso, cfg.tz);
  const isChange = !!existing;
  const content = `📞 <b>${isChange ? "Klient zmienił termin rozmowy" : "Klient wybrał termin rozmowy"}</b> (strona rezerwacji):<br><b>${when}</b> (czas PL, ~20 min)`;
  let noteId: number | null = null;
  try {
    const nres = await fetch(`${PD}/notes?api_token=${token}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, lead_id: lead.pipedrive_lead_id }),
    });
    const nj = await nres.json();
    noteId = nj?.data?.id ?? null;
  } catch (_e) { /* notatka to bonus */ }

  // owner aktywności: reguła leada -> default
  let ownerId: number | null = null;
  if (lead.matched_rule_id) {
    const { data: rule } = await db.from("routing_rules").select("pd_owner_id").eq("id", lead.matched_rule_id).maybeSingle();
    ownerId = rule?.pd_owner_id ?? null;
  }
  if (!ownerId) ownerId = Number(settings.default_owner_id ?? 14906954);

  // Pipedrive przyjmuje due_date/due_time w UTC
  const d = new Date(slotIso);
  const due_date = d.toISOString().slice(0, 10);
  const due_time = d.toISOString().slice(11, 16);
  const payload: Record<string, unknown> = {
    subject: `Oddzwonić: ${lead.full_name || lead.email || "lead"} (wybrany termin)`,
    type: "call", due_date, due_time, duration: "00:20",
    lead_id: lead.pipedrive_lead_id, user_id: ownerId,
  };
  if (lead.pipedrive_person_id) payload.person_id = lead.pipedrive_person_id;

  let activityId: number | null = existing?.pd_activity_id ?? null;
  try {
    if (activityId) {
      await fetch(`${PD}/activities/${activityId}?api_token=${token}`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ due_date, due_time, done: 0 }),
      });
    } else {
      const ares = await fetch(`${PD}/activities?api_token=${token}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const aj = await ares.json();
      activityId = aj?.data?.id ?? null;
    }
  } catch (_e) { /* aktywność to bonus */ }
  return { activityId, noteId };
}

// ---- e-mail do opiekuna: klient zarezerwował / zmienił termin ----
// Tylko gdy reguła leada ma włączoną kopię (routing_rules.client_copy_on).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function notifyCopy(secrets: Record<string, string>, settings: Record<string, unknown>, lead: any, slotIso: string, cfg: Cfg, isChange: boolean) {
  if (!lead.matched_rule_id || !secrets.RESEND_KEY) return;
  const { data: rule } = await db.from("routing_rules").select("client_copy_on,client_copy_emails").eq("id", lead.matched_rule_id).maybeSingle();
  const to: string[] = rule?.client_copy_on ? (rule.client_copy_emails ?? []).filter((a: string) => EMAIL_RE.test(a)) : [];
  if (!to.length) return;

  const when = plDateTime(slotIso, cfg.tz);
  const who = lead.full_name || lead.email || lead.phone || "Klient";
  const domain = String(settings.pipedrive_company_domain ?? "fastlineracingacademy");
  const row = (k: string, v: unknown) => v ? `<tr><td style="padding:4px 10px;color:#888">${k}</td><td style="padding:4px 10px"><b>${esc(v)}</b></td></tr>` : "";
  const html = `<div style="font-family:Arial,sans-serif"><h2 style="color:#e11d2a">${isChange ? "Klient zmienił termin rozmowy" : "Klient wybrał termin rozmowy"}</h2>
    <p style="font-size:17px;margin:0 0 14px">${esc(who)} — <b>${esc(when)}</b> (czas PL, ok. ${cfg.step_min} min)</p>
    <table style="border-collapse:collapse">${row("Imię i nazwisko", lead.full_name)}${row("E-mail", lead.email)}${row("Telefon", lead.phone)}${row("Kampania", lead.campaign_name)}${row("Formularz", lead.form_name)}</table>
    ${lead.pipedrive_lead_id ? `<p style="margin-top:14px"><a href="https://${esc(domain)}.pipedrive.com/leads/inbox/${esc(lead.pipedrive_lead_id)}" style="color:#e11d2a;font-weight:700">Otwórz leada w Pipedrive ›</a></p>` : ""}
    <p style="color:#aaa;font-size:12px;margin-top:16px">FASTLINE LEADS BRIGHT</p></div>`;
  const from = `Fastline Racing Academy <${String(settings.email_from ?? "leads@fastlineracingacademy.pl")}>`;
  const subject = `${isChange ? "Zmiana terminu rozmowy" : "Termin rozmowy"}: ${who} — ${when}`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "authorization": `Bearer ${secrets.RESEND_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!res.ok) throw new Error(`resend failed: ${res.status} ${await res.text()}`);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const action = String(body.action ?? "info");
  const token = String(body.t ?? "").trim();
  if (!token || token.length > 64) return json({ error: "invalid_link" }, 400);

  try {
    const settings = await getSettings();
    const cfg: Cfg = { ...DEF_CFG, ...(settings.booking_config as object ?? {}) };
    const now = new Date();

    // tryb demo (test z panelu): pełna siatka, nic nie zapisujemy
    const isDemo = token === "demo";
    let lead: any = null;
    if (!isDemo) {
      const { data } = await db.from("leads").select("id,full_name,email,phone,campaign_name,form_name,matched_rule_id,pipedrive_lead_id,pipedrive_person_id").eq("booking_token", token).maybeSingle();
      if (!data) return json({ error: "invalid_link" }, 404);
      lead = data;
    }

    if (action === "info") {
      const grid = buildGrid(cfg, now);
      const taken = await takenSlots(now.toISOString());
      let current: string | null = null;
      if (lead) {
        const { data: b } = await db.from("callback_bookings").select("slot_at").eq("lead_id", lead.id).eq("status", "booked").maybeSingle();
        if (b) current = new Date(b.slot_at).toISOString();
      }
      const firstName = isDemo ? "Anna" : String(lead.full_name ?? "").trim().split(/\s+/)[0] || "";
      return json({
        ok: true,
        name: firstName,
        current,
        tz: cfg.tz,
        step_min: cfg.step_min,
        days: grid.map((d) => ({
          date: d.date,
          slots: d.slots.map((s) => ({ iso: s, taken: taken.has(s) && s !== current })),
        })),
      });
    }

    if (action === "book") {
      const slot = String(body.slot ?? "");
      const grid = buildGrid(cfg, now);
      const valid = grid.some((d) => d.slots.includes(slot));
      if (!valid) return json({ error: "invalid_slot" }, 400);

      if (isDemo) return json({ ok: true, demo: true, slot, label: plDateTime(slot, cfg.tz) });

      const taken = await takenSlots(now.toISOString());
      const { data: existing } = await db.from("callback_bookings").select("*").eq("lead_id", lead.id).eq("status", "booked").maybeSingle();
      if (taken.has(slot) && new Date(existing?.slot_at ?? 0).toISOString() !== slot) {
        return json({ error: "slot_taken" }, 409);
      }

      if (existing) {
        await db.from("callback_bookings").update({ status: "cancelled", updated_at: now.toISOString() }).eq("id", existing.id);
      }
      const { data: ins, error: insErr } = await db.from("callback_bookings")
        .insert({ lead_id: lead.id, slot_at: slot })
        .select().single();
      if (insErr) {
        // wyścig o slot -> unikalny indeks; przywróć starą rezerwację
        if (existing) await db.from("callback_bookings").update({ status: "booked", updated_at: now.toISOString() }).eq("id", existing.id);
        if (String(insErr.message).includes("callback_bookings_slot_uq")) return json({ error: "slot_taken" }, 409);
        throw new Error(insErr.message);
      }

      const secrets = await getSecrets();
      const { activityId, noteId } = await pdNotify(secrets, settings, lead, slot, cfg, existing);
      if (activityId || noteId) {
        await db.from("callback_bookings").update({ pd_activity_id: activityId, pd_note_id: noteId, updated_at: new Date().toISOString() }).eq("id", ins.id);
      }
      // powiadomienie opiekuna nie może zepsuć rezerwacji klienta
      try { await notifyCopy(secrets, settings, lead, slot, cfg, !!existing); }
      catch (e) { console.error("booking copy mail failed", e); }
      return json({ ok: true, slot, label: plDateTime(slot, cfg.tz), changed: !!existing });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error("booking error", e);
    return json({ error: "server", detail: String(e) }, 500);
  }
});
