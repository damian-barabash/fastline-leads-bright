// ringostat-sync — pobiera dziennik połączeń z Ringostat API (calls/list) do rs_calls,
// odświeża listę pracowników (JSON-RPC) i przypina rozmowy do leadów po numerze telefonu.
// Auth: header `x-internal-token` = app_secrets.INTERNAL_TOKEN (pg_cron co 5 min + admin-api).
// Body: {} (przyrostowo od ostatniej synchronizacji) | { from, to } ("YYYY-MM-DD HH:MM:SS", czas projektu)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const RS = "https://api.ringostat.net";
const FIELDS = [
  "calldate", "caller", "dst", "pool_name", "disposition", "category_mark", "duration", "call_type", "waittime",
  "billsec", "connected_with", "call_counter", "proper_flag", "repeated_flag", "utm_source", "utm_medium",
  "utm_campaign", "utm_content", "utm_term", "uniqueid", "category_number", "employee_number", "employee_mark",
  "client_id", "remote_ip", "refferrer", "landing", "recording", "call_card", "additional_number", "has_recording",
  "scheme_name", "employee_fio", "employee_email", "department", "caller_number", "n_alias", "region",
  "missing_reason", "who_missed", "csat_survey_name", "csat_survey", "csat_rating",
].join(",");
// przy synchronizacji przyrostowej cofamy się o 6 h — rozmowy „IN PROGRESS” dostają finalny status i nagranie
const OVERLAP_MS = 6 * 3600_000;

async function getSecrets() {
  const { data, error } = await db.from("app_secrets").select("key,value");
  if (error) throw new Error(error.message);
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value])) as Record<string, string>;
}

// "YYYY-MM-DD HH:MM:SS" w strefie Europe/Warsaw (strefa projektu Ringostat)
function warsaw(d: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour === "24" ? "00" : p.hour}:${p.minute}:${p.second}`;
}

const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "");
const int = (v: unknown) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Math.round(Number(v)));
const txt = (v: unknown) => (v === null || v === undefined ? null : String(v));

function clientPhone(c: any, own: Set<string>): string | null {
  const isPhone = (s: string) => s.length >= 9 && !own.has(s);
  const outgoing = c.call_type === "out" || c.call_type === "transitout";
  const order = outgoing ? [c.dst, c.connected_with, c.caller] : [c.caller, c.caller_number, c.dst];
  for (const v of order) {
    // "p48534645556" = numer z prefiksem wybierania; login SIP / "anonymous" pomijamy
    const s = String(v ?? "").trim().replace(/^p(?=\+?\d)/i, "");
    if (/[a-z_]/i.test(s)) continue;
    const d = digits(s);
    if (isPhone(d)) return d;
  }
  return null;
}

function parseWhoMissed(v: unknown) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "object") return v;
  try { return JSON.parse(String(v).replace(/'/g, '"')); } catch { return String(v); }
}

function mapCall(c: any, own: Set<string>) {
  return {
    uniqueid: String(c.uniqueid),
    calldate: c.calldate ? new Date(String(c.calldate).replace(/([+-]\d{2})(\d{2})$/, "$1:$2")).toISOString() : null,
    call_type: txt(c.call_type),
    disposition: txt(c.disposition),
    caller: txt(c.caller),
    caller_number: txt(c.caller_number),
    dst: txt(c.dst),
    connected_with: txt(c.connected_with),
    n_alias: txt(c.n_alias),
    pool_name: txt(c.pool_name),
    scheme_name: txt(c.scheme_name),
    client_phone: clientPhone(c, own),
    duration: int(c.duration),
    billsec: int(c.billsec),
    waittime: int(c.waittime),
    call_counter: int(c.call_counter),
    proper_flag: int(c.proper_flag),
    repeated_flag: int(c.repeated_flag),
    employee_number: int(c.employee_number),
    employee_fio: c.employee_fio || null,
    employee_email: c.employee_email || null,
    department: c.department || null,
    employee_mark: int(c.employee_mark),
    category_mark: c.category_mark === null || c.category_mark === "" ? null : Number(c.category_mark),
    category_number: txt(c.category_number),
    missing_reason: c.missing_reason || null,
    who_missed: parseWhoMissed(c.who_missed),
    has_recording: String(c.has_recording) === "1",
    recording: c.recording || null,
    call_card: c.call_card || null,
    additional_number: c.additional_number || null,
    csat_survey: int(c.csat_survey),
    csat_survey_name: c.csat_survey_name || null,
    csat_rating: c.csat_rating || null,
    utm_source: c.utm_source || null,
    utm_medium: c.utm_medium || null,
    utm_campaign: c.utm_campaign || null,
    utm_content: c.utm_content || null,
    utm_term: c.utm_term || null,
    client_id: c.client_id || null,
    remote_ip: c.remote_ip || null,
    referrer: c.refferrer || null,
    landing: c.landing || null,
    region: c.region || null,
    raw: c,
    synced_at: new Date().toISOString(),
  };
}

async function syncEmployees(key: string, projectId: string) {
  const res = await fetch(`${RS}/api/json-rpc`, {
    method: "POST",
    headers: { "Auth-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      id: 1, jsonrpc: "2.0", method: "getProjectStaffListAndDirections",
      params: { projectId: Number(projectId), departmentsFullFormat: true, filter: [{}] },
    }),
  });
  const j = await res.json().catch(() => ({}));
  const list = Object.values(j?.result ?? {}) as any[];
  const own = new Set<string>();
  for (const e of list) {
    const dirs = [...(e.directions?.main ?? []), ...(e.directions?.additional ?? [])];
    const phones = dirs.filter((d: any) => d.type !== "sip").map((d: any) => digits(d.direction)).filter(Boolean);
    phones.forEach((p: string) => own.add(p));
    await db.from("rs_employees").upsert({
      staff_id: e.staffId, fio: e.fio, email: e.email, extension: e.extensionNumber,
      sip_logins: dirs.filter((d: any) => d.type === "sip").map((d: any) => String(d.direction)),
      phones, online: !!e.status, updated_at: new Date().toISOString(),
    });
  }
  return { count: list.length, own };
}

async function fetchCalls(key: string, projectId: string, from: string, to: string) {
  const qs = new URLSearchParams({ export_type: "json", from, to, fields: FIELDS, order: "calldate asc" });
  const res = await fetch(`${RS}/calls/list?${qs}`, { headers: { "Auth-key": key, "x-project-id": projectId } });
  const text = await res.text();
  if (!res.ok) throw new Error(`ringostat ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text) as any[]; } catch { throw new Error(`ringostat: ${text.slice(0, 300)}`); }
}

async function setSetting(key: string, value: unknown) {
  await db.from("settings").upsert({ key, value, updated_at: new Date().toISOString() });
}

Deno.serve(async (req) => {
  const secrets = await getSecrets();
  if (!secrets.INTERNAL_TOKEN || req.headers.get("x-internal-token") !== secrets.INTERNAL_TOKEN) {
    return new Response("unauthorized", { status: 401 });
  }
  const key = secrets.RINGOSTAT_AUTH_KEY, projectId = secrets.RINGOSTAT_PROJECT_ID;
  if (!key) return Response.json({ error: "Brak RINGOSTAT_AUTH_KEY" }, { status: 400 });

  let body: any = {};
  try { body = await req.json(); } catch { /* cron bez body */ }
  const started = new Date();

  try {
    const emp = await syncEmployees(key, projectId);
    // numery firmowe (linie, numery pracowników) — żeby nie brać ich za numer klienta
    const { data: aliases } = await db.from("rs_calls").select("n_alias").not("n_alias", "is", null).neq("n_alias", "").limit(1000);
    for (const a of aliases ?? []) emp.own.add(digits(a.n_alias));

    let from: string, to: string;
    if (body.from) {
      from = body.from; to = body.to ?? warsaw(started);
    } else {
      const { data: st } = await db.from("settings").select("value").eq("key", "rs_last_sync_at").maybeSingle();
      const last = st?.value ? new Date(String(st.value)) : new Date(started.getTime() - 7 * 864e5);
      from = warsaw(new Date(last.getTime() - OVERLAP_MS)); to = warsaw(started);
    }

    const calls = await fetchCalls(key, projectId, from, to);
    const rows = calls.filter((c) => c.uniqueid).map((c) => mapCall(c, emp.own));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db.from("rs_calls").upsert(rows.slice(i, i + 500), { onConflict: "uniqueid" });
      if (error) throw new Error(error.message);
    }
    const { data: matched } = await db.rpc("rs_match_leads");

    if (!body.from) await setSetting("rs_last_sync_at", started.toISOString());
    await setSetting("rs_last_sync_result", { at: started.toISOString(), from, to, calls: rows.length, matched, employees: emp.count, ok: true });
    return Response.json({ ok: true, from, to, calls: rows.length, matched, employees: emp.count });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    await setSetting("rs_last_sync_result", { at: started.toISOString(), ok: false, error: msg });
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
});
