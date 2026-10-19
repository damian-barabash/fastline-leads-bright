// smart-report — Raport AI kampanii (Barabash AI, model lokalny Qwen).
// pg_cron raz na godzinę ({action:"tick"}) — analiza nowych leadów w tle; zlecony raport liczy się krok po kroku od razu (smart_kick).
//  1. synchronizacja Pipedrive → pd_notes (komentarze handlowców), pd_deals, notatki Ringostat AI → rs_calls
//  2. analiza AI każdego leada (dossier → JSON), cache w lead_insights, przeliczana tylko gdy dossier się zmieni
//  3. zlecone raporty: liczby per kampania / grupa reklam / reklama / odpowiedź z formularza + wnioski AI
// Auth: x-internal-token. Deploy z verify_jwt = false.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const PD = "https://api.pipedrive.com/v1";
const PD_DOMAIN = "fastlineracingacademy";
const SYNC_FROM = "2026-07-01";
const BUDGET_MS = 120_000;
const PARALLEL = 3;

type Secrets = Record<string, string>;
async function getSecrets(): Promise<Secrets> {
  const { data, error } = await db.from("app_secrets").select("key,value");
  if (error) throw new Error(error.message);
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
}
async function getSetting(key: string) {
  const { data } = await db.from("settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}
const setSetting = (key: string, value: unknown) => db.from("settings").upsert({ key, value });

// ---------------- Pipedrive ----------------
async function pdGet(token: string, path: string) {
  const res = await fetch(`${PD}${path}${path.includes("?") ? "&" : "?"}api_token=${token}`);
  return await res.json();
}
async function pdAll(token: string, path: string, stop?: (row: any) => boolean, max = 6000) {
  const out: any[] = [];
  let start = 0;
  while (out.length < max) {
    const j = await pdGet(token, `${path}${path.includes("?") ? "&" : "?"}start=${start}&limit=500`);
    if (!j?.success) throw new Error(`Pipedrive ${path}: ${j?.error ?? "błąd"}`);
    const rows = j.data ?? [];
    out.push(...rows);
    if (stop && rows.length && stop(rows[rows.length - 1])) break;
    const p = j.additional_data?.pagination;
    if (!p?.more_items_in_collection) break;
    start = p.next_start;
  }
  return out;
}
const pdTime = (t: string | null | undefined) => (t ? new Date(String(t).replace(" ", "T") + "Z").toISOString() : null);
const decodeEntities = (s: string) => s
  .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function htmlToText(html: string) {
  return decodeEntities(String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(div|p|li|h\d)>/gi, "\n").replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, ""))
    .replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
const AI_NOTE_FIELDS: Record<string, string> = {
  "podsumowanie": "summary", "nastrój menedżera": "employee_mood", "nastrój klienta": "client_mood",
  "analiza nastroju": "sentiment", "czy należy zwrócić uwagę na rozmowę: ocena": "review_score",
  "czy należy zwrócić uwagę na rozmowę: szczegóły": "review_details",
};
function parseAiNote(html: string) {
  const uid = String(html).match(/uniqueId=([^"&<\s]+)/)?.[1];
  if (!uid || !/<b>\s*Podsumowanie\s*<\/b>/i.test(html)) return null;
  const ai: Record<string, unknown> = {};
  const re = /<b>([^<]+)<\/b>\s*<\/div>\s*<div>([\s\S]*?)<\/div>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const label = decodeEntities(m[1]).trim().toLowerCase();
    const val = htmlToText(m[2]);
    const key = AI_NOTE_FIELDS[label];
    if (key && val) ai[key] = key === "review_score" ? Number(val.replace(",", ".")) || val : val;
  }
  return { uniqueid: decodeURIComponent(uid), ai };
}
const ACT_TYPE: Record<string, string> = { call: "telefon", email: "e-mail", meeting: "spotkanie", task: "zadanie", deadline: "termin", lunch: "spotkanie", sms: "SMS" };

async function syncPipedrive(secrets: Secrets, force = false) {
  const last = await getSetting("smart_pd_sync_at");
  const lastMs = last ? new Date(String(last)).getTime() : 0;
  if (!force && Date.now() - lastMs < 10 * 60_000) return { skipped: true };
  const T = secrets.PIPEDRIVE_TOKEN;
  const first = !lastMs;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const today = day(Date.now());
  const notesFrom = first ? SYNC_FROM : day(lastMs - 3 * 864e5);
  const actsFrom = first ? SYNC_FROM : day(Date.now() - 30 * 864e5);

  const users: any[] = (await pdGet(T, "/users"))?.data ?? [];
  const uname = new Map(users.map((u) => [u.id, u.name]));
  // imiona jak w Ringostat (pełne), jeśli e-mail się zgadza
  const { data: emps } = await db.from("rs_employees").select("fio,email");
  const fioByEmail = new Map((emps ?? []).map((e: any) => [String(e.email ?? "").toLowerCase(), e.fio]));
  const author = (id: number) => {
    const u = users.find((x) => x.id === id);
    return (u && fioByEmail.get(String(u.email ?? "").toLowerCase())) || uname.get(id) || String(id ?? "");
  };

  // notatki
  const notes = await pdAll(T, `/notes?start_date=${notesFrom}&end_date=${today}`);
  const rows: any[] = [];
  const aiNotes: any[] = [];
  for (const n of notes) {
    const html = String(n.content ?? "");
    const ai = parseAiNote(html);
    if (ai) { aiNotes.push({ ...ai, at: pdTime(n.add_time) }); continue; }
    if (/strona rezerwacji/i.test(html)) continue;
    const text = htmlToText(html);
    if (!text) continue;
    rows.push({
      id: `n${n.id}`, kind: "note", pd_lead_id: n.lead_id ?? null, pd_deal_id: n.deal_id ?? null, pd_person_id: n.person_id ?? null,
      user_id: n.user_id, author: author(n.user_id), at: pdTime(n.add_time), subject: null, act_type: null, done: null,
      text: text.slice(0, 4000), synced_at: new Date().toISOString(),
    });
  }
  // aktywności z notatką
  const acts = await pdAll(T, `/activities?user_id=0&start_date=${actsFrom}&end_date=${day(Date.now() + 864e5)}`);
  for (const a of acts) {
    const text = htmlToText(a.note ?? "");
    if (!text) continue;
    const doneAt = pdTime(a.marked_as_done_time);
    rows.push({
      id: `a${a.id}`, kind: "activity", pd_lead_id: a.lead_id ?? null, pd_deal_id: a.deal_id ?? null, pd_person_id: a.person_id ?? null,
      user_id: a.user_id, author: author(a.user_id),
      at: doneAt ?? pdTime(`${a.due_date} ${a.due_time && a.due_time !== "00:00" ? a.due_time : "10:00"}:00`),
      subject: a.subject ?? null, act_type: ACT_TYPE[a.type] ?? a.type, done: !!a.done, text: text.slice(0, 4000),
      synced_at: new Date().toISOString(),
    });
  }
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from("pd_notes").upsert(rows.slice(i, i + 500));
    if (error) throw new Error(`pd_notes: ${error.message}`);
  }
  // wyniki Ringostat AI z notatek → rs_calls (gdy brak wyników z webhooka)
  let aiApplied = 0;
  for (let i = 0; i < aiNotes.length; i += 25) {
    const res = await Promise.all(aiNotes.slice(i, i + 25).map((a) =>
      db.from("rs_calls").update({
        ai: { ...a.ai, source: "pipedrive" }, ai_summary: a.ai.summary ? String(a.ai.summary) : null, ai_at: a.at,
      }).eq("uniqueid", a.uniqueid).is("ai_at", null).select("uniqueid")));
    aiApplied += res.reduce((s, r) => s + (r.data?.length ?? 0), 0);
  }
  // dealy (od najświeżej zmienionych)
  const stages: any[] = (await pdGet(T, "/stages"))?.data ?? [];
  const stageName = new Map(stages.map((s) => [s.id, s.name]));
  const cutoff = first ? SYNC_FROM : new Date(lastMs - 2 * 864e5).toISOString().replace("T", " ").slice(0, 19);
  const deals = (await pdAll(T, "/deals?status=all_not_deleted&sort=update_time%20DESC", (r) => String(r.update_time) < cutoff))
    .filter((d) => String(d.update_time) >= cutoff);
  const dealRows = deals.map((d) => ({
    id: d.id, person_id: d.person_id?.value ?? d.person_id ?? null, title: d.title, status: d.status, value: d.value, currency: d.currency,
    pipeline_id: d.pipeline_id, stage_id: d.stage_id, stage_name: stageName.get(d.stage_id) ?? null, lost_reason: d.lost_reason,
    add_time: pdTime(d.add_time), won_time: pdTime(d.won_time), lost_time: pdTime(d.lost_time), update_time: pdTime(d.update_time),
  }));
  for (let i = 0; i < dealRows.length; i += 500) {
    const { error } = await db.from("pd_deals").upsert(dealRows.slice(i, i + 500));
    if (error) throw new Error(`pd_deals: ${error.message}`);
  }
  await db.rpc("rs_match_leads");
  const result = { at: new Date().toISOString(), notes: rows.length, aiNotes: aiNotes.length, aiApplied, deals: dealRows.length };
  await setSetting("smart_pd_sync_at", result.at);
  await setSetting("smart_pd_sync_result", result);
  return result;
}

// ---------------- dossier ----------------
const PII_KEYS = /^(e-?mail|email|phone|phone_number|numer[_ ]telefonu|telefon|imię[_ ]i[_ ]nazwisko|full_name|first_name|last_name|imie|nazwisko|data)$/i;
const clean = (s: unknown) => String(s ?? "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
const fmtDate = (t: string) => new Date(t).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const mmss = (s: number) => `${Math.floor((s ?? 0) / 60)}:${String((s ?? 0) % 60).padStart(2, "0")}`;
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function formFields(fields: Record<string, unknown> | null) {
  return Object.entries(fields ?? {}).filter(([k]) => !PII_KEYS.test(k.trim())).map(([k, v]) => [clean(k).replace(/\?$/, "").trim(), clean(v)] as [string, string]).filter(([, v]) => v);
}

function dossierText(d: any) {
  const L: string[] = [];
  L.push(`KAMPANIA: ${d.campaign ?? "?"} | grupa reklam: ${d.adset ?? "?"} | reklama: ${d.ad ?? "?"} | formularz: ${d.form ?? "?"}`);
  L.push(`ZGŁOSZENIE: ${fmtDate(d.received_at)}`);
  const ff = formFields(d.fields);
  if (ff.length) { L.push("ODPOWIEDZI Z FORMULARZA:"); for (const [k, v] of ff) L.push(`- ${k}: ${v}`); }
  const c = d.calls ?? {};
  const firstH = c.first_out ? (new Date(c.first_out).getTime() - new Date(d.received_at).getTime()) / 3600_000 : null;
  L.push(`ROZMOWY TELEFONICZNE (Ringostat): ${c.n ?? 0} (odebrane ${c.answered ?? 0}, łącznie ${mmss(c.talk ?? 0)})` +
    (firstH !== null ? `, pierwszy telefon ${firstH < 1 ? `${Math.max(1, Math.round(firstH * 60))} min` : `${Math.round(firstH)} h`} po zgłoszeniu` : ", brak telefonu wychodzącego"));
  const ai = (d.ai ?? []).slice(-8);
  if (ai.length) {
    L.push("PODSUMOWANIA ROZMÓW (AI Ringostat):");
    for (const a of ai) L.push(`[${fmtDate(a.at)}, ${a.emp ?? "?"}, ${mmss(a.sec ?? 0)}] ${cut(clean(a.summary), 700)}${a.mood ? ` (nastrój klienta: ${a.mood})` : ""}`);
  }
  const notes = (d.notes ?? []).slice(-15);
  if (notes.length) {
    L.push("KOMENTARZE HANDLOWCÓW (CRM):");
    for (const n of notes) L.push(`[${fmtDate(n.at)}, ${n.author}${n.kind === "activity" ? `, ${n.type}${n.done ? "" : " (zaplanowane)"}` : ""}] ${n.subject && !/^(rozmowa telefoniczna|e-mail|telefon)$/i.test(n.subject) ? `${cut(n.subject, 120)}: ` : ""}${cut(String(n.text).replace(/\s+/g, " "), 450)}`);
  }
  const deals = d.deals ?? [];
  if (deals.length) {
    L.push("DEALE W PIPEDRIVE:");
    for (const x of deals) L.push(`- ${x.status === "won" ? "WYGRANY" : x.status === "lost" ? "PRZEGRANY" : "otwarty"}${x.value ? `, wartość ${x.value} ${x.currency ?? ""}` : ""}${x.stage ? `, etap: ${x.stage}` : ""}${x.lost_reason ? `, powód przegranej: ${x.lost_reason}` : ""}`);
  }
  return cut(L.join("\n"), 9000);
}
async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
// lead bez treści rozmów — klasyfikacja bez AI
function ruleInsight(d: any) {
  const c = d.calls ?? {};
  const hasContent = (d.ai ?? []).length || (d.notes ?? []).length || (d.deals ?? []).length;
  if (hasContent) return null;
  if ((c.answered ?? 0) > 0) return { status: "bez_opisu", note: "rozmowa odbyła się, ale brak podsumowania i notatek" };
  if ((c.n ?? 0) > 0) return { status: "nieosiagalny", note: "telefony bez odebrania" };
  return { status: "brak_kontaktu", note: "nikt nie dzwonił" };
}

// ---------------- Barabash AI ----------------
async function llm(secrets: Secrets, system: string, user: string, maxTokens: number, timeoutMs: number) {
  const res = await fetch(`${secrets.BARABASH_AI_URL || "https://barabash-ai.tailcd3444.ts.net/v1"}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secrets.BARABASH_AI_KEY}` },
    body: JSON.stringify({
      model: secrets.BARABASH_AI_MODEL || "qwen3.8:27b-q4_K_M",
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0.1, max_tokens: maxTokens, response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`AI ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  const txt = String(j.choices?.[0]?.message?.content ?? "");
  const s = txt.indexOf("{"), e = txt.lastIndexOf("}");
  if (s < 0 || e <= s) throw new Error(`AI: brak JSON (${txt.slice(0, 120)})`);
  return JSON.parse(txt.slice(s, e + 1));
}

// stały prompt (prefiks cache w Ollama) — dossier zawsze na końcu
const LEAD_SYSTEM = `Jesteś analitykiem sprzedaży Fastline Racing Academy (szkolenia jazdy sportowej na torze — własnym autem lub autem szkoły, Driver to Racer, eventy firmowe, Heels on the track dla kobiet, wyjazdy: Laponia/jazda po lodzie, Sewilla, Andaluzja, Azur). Dostajesz dossier jednego leada z reklamy Facebook: odpowiedzi z formularza, podsumowania rozmów telefonicznych (AI Ringostat), komentarze handlowców z CRM i deale. Oceń leada WYŁĄCZNIE na podstawie faktów z dossier. Nie zgaduj. Odpowiedz samym JSON:
{"status":"kupil|goracy|cieply|zimny|niezainteresowany|nieosiagalny|bledny","interest":0-10,"stage":"brak_kontaktu|pierwszy_kontakt|oferta_przedstawiona|oferta_wyslana|negocjacje|rezerwacja|sprzedaz|odrzucenie","price":"akceptuje|negocjuje|za_drogo|nie_rozmawiano","objections":[{"type":"cena|termin|lokalizacja|brak_czasu|tylko_przeglada|decyzja_innej_osoby|pogoda_sezon|inny_produkt|konkurencja|brak_auta|bezpieczenstwo|zdrowie_wiek|odleglosc_dojazd|inne","quote":"krótki cytat lub parafraza z dossier"}],"quality":"dobry|sredni|slaby|nieprawidlowy","quality_issues":["falszywy_numer|nie_pamieta_zgloszenia|przypadkowe_zgloszenie|niepelnoletni|zly_kraj_jezyk|szuka_czegos_innego|duplikat"],"intent":"dla_siebie|prezent|firma|grupa_znajomych|nieznany","product":"czym konkretnie zainteresowany (max 10 słów)","persona":"kim jest klient — tylko fakty: auto, zawód/firma, wiek, kto kupuje (max 14 słów)","budget":"kwota jeśli padła, inaczej null","next_step":"co dalej (max 12 słów)","lost_reason":"dlaczego nie kupił (max 12 słów) lub null","insight":"1 zdanie najważniejsze dla targetowania reklam lub oferty"}
Zasady:
- "kupil" tylko przy rezerwacji, płatności albo wygranym dealu. "goracy" = konkretny termin/oferta w toku i wyraźna chęć. "cieply" = zainteresowany, ale bez decyzji. "zimny" = słabe zainteresowanie, odkłada na później. "niezainteresowany" = odmówił. "nieosiagalny" = nie udało się porozmawiać. "bledny" = fałszywy numer, nie zgłaszał się, szuka czegoś innego.
- price "za_drogo" gdy klient mówi, że drogo / za dużo / nie stać go / szuka taniej. "negocjuje" gdy pyta o rabat lub tańszy wariant.
- objections: tylko faktycznie wypowiedziane zastrzeżenia, pusta lista gdy ich brak. quality_issues: pusta lista gdy brak.
- Pisz po polsku, krótko.`;

const STATUSES = ["kupil", "goracy", "cieply", "zimny", "niezainteresowany", "nieosiagalny", "bledny"];
const PRICES = ["akceptuje", "negocjuje", "za_drogo", "nie_rozmawiano"];
const QUALITIES = ["dobry", "sredni", "slaby", "nieprawidlowy"];
const INTENTS = ["dla_siebie", "prezent", "firma", "grupa_znajomych", "nieznany"];
const pick = (v: unknown, list: string[], def: string) => (list.includes(String(v)) ? String(v) : def);

async function analyzeLead(secrets: Secrets, leadId: string, d: any, text: string, hash: string) {
  try {
    const r = await llm(secrets, LEAD_SYSTEM, `DOSSIER:\n${text}`, 700, 60_000);
    const objections = (Array.isArray(r.objections) ? r.objections : [])
      .filter((o: any) => o && o.type).slice(0, 6)
      .map((o: any) => ({ type: String(o.type).toLowerCase().trim(), quote: cut(clean(o.quote), 220) }));
    const result = {
      ...r, objections,
      quality_issues: (Array.isArray(r.quality_issues) ? r.quality_issues : []).map(String).filter((x: string) => x && x !== "null").slice(0, 5),
    };
    await db.from("lead_insights").upsert({
      lead_id: leadId, hash, source: "llm", model: secrets.BARABASH_AI_MODEL || "qwen3.8:27b-q4_K_M",
      status: pick(r.status, STATUSES, "cieply"), interest: Math.max(0, Math.min(10, Math.round(Number(r.interest) || 0))),
      price: pick(r.price, PRICES, "nie_rozmawiano"), quality: pick(r.quality, QUALITIES, "sredni"), intent: pick(r.intent, INTENTS, "nieznany"),
      objections: objections.map((o: any) => o.type), result, error: null, analyzed_at: new Date().toISOString(),
    });
    return true;
  } catch (e) {
    await db.from("lead_insights").upsert({
      lead_id: leadId, hash, source: "llm", status: null, error: String((e as Error).message ?? e).slice(0, 300), analyzed_at: new Date().toISOString(),
    });
    return false;
  }
}

async function loadDossiers(ids: string[] | null, since: string | null) {
  const out: any[] = [];
  if (ids) {
    for (let i = 0; i < ids.length; i += 300) {
      const { data, error } = await db.rpc("smart_dossiers", { p_ids: ids.slice(i, i + 300), p_since: null });
      if (error) throw new Error(error.message);
      out.push(...(data ?? []));
    }
    return out;
  }
  for (let off = 0; ; off += 500) {
    const { data, error } = await db.rpc("smart_dossiers", { p_ids: null, p_since: since }).range(off, off + 499);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data ?? []).length < 500) break;
  }
  return out;
}
async function loadInsights(ids: string[]) {
  const map = new Map<string, any>();
  for (let i = 0; i < ids.length; i += 300) {
    const { data } = await db.from("lead_insights").select("*").in("lead_id", ids.slice(i, i + 300));
    for (const r of data ?? []) map.set(r.lead_id, r);
  }
  return map;
}

// przygotuj kolejkę: reguły od razu, AI — lista do przeliczenia
async function prepare(rows: any[]) {
  const ins = await loadInsights(rows.map((r) => r.lead_id));
  const queue: any[] = [];
  const ruleRows: any[] = [];
  for (const r of rows) {
    const text = dossierText(r.d);
    const hash = await sha(text);
    const cur = ins.get(r.lead_id);
    const retry = cur?.error && Date.now() - new Date(cur.analyzed_at).getTime() > 30 * 60_000;
    if (cur && cur.hash === hash && !retry) continue;
    const rule = ruleInsight(r.d);
    if (rule) {
      ruleRows.push({ lead_id: r.lead_id, hash, source: "rule", model: null, status: rule.status, interest: null, price: null, quality: null, intent: null, objections: [], result: rule, error: null, analyzed_at: new Date().toISOString() });
    } else queue.push({ id: r.lead_id, d: r.d, text, hash });
  }
  for (let i = 0; i < ruleRows.length; i += 500) await db.from("lead_insights").upsert(ruleRows.slice(i, i + 500));
  return { queue, rules: ruleRows.length };
}
async function runQueue(secrets: Secrets, queue: any[], deadline: number, onDone?: (n: number) => Promise<void>, parallel = PARALLEL) {
  let i = 0, done = 0;
  const worker = async () => {
    while (i < queue.length && Date.now() < deadline - 55_000) {
      const q = queue[i++];
      await analyzeLead(secrets, q.id, q.d, q.text, q.hash);
      done++;
      if (onDone && done % 3 === 0) await onDone(done);
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  return done;
}

// "YYYY-MM-DD" (dzień w Europe/Warsaw) -> ISO początku dnia
function warsawDayStart(day: string): string {
  const probe = new Date(`${day}T12:00:00Z`);
  const off = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Warsaw", timeZoneName: "shortOffset" })
    .formatToParts(probe).find((p) => p.type === "timeZoneName")?.value ?? "GMT+1";
  const m = off.match(/GMT([+-])(\d+)/);
  const h = m ? (m[1] === "-" ? -1 : 1) * Number(m[2]) : 1;
  return new Date(new Date(`${day}T00:00:00Z`).getTime() - h * 3600_000).toISOString();
}
const nextDay = (day: string) => new Date(new Date(`${day}T12:00:00Z`).getTime() + 864e5).toISOString().slice(0, 10);
function rangeTs(p: any) { return { fromTs: warsawDayStart(p.from), toTs: warsawDayStart(nextDay(p.to)) }; }

// ---------------- liczby raportu ----------------
const TALKED = new Set(["kupil", "goracy", "cieply", "zimny", "niezainteresowany", "bledny", "bez_opisu"]);
const median = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);

function metrics(list: any[]) {
  const st: Record<string, number> = {};
  for (const l of list) st[l.status ?? "w_analizie"] = (st[l.status ?? "w_analizie"] ?? 0) + 1;
  const ai = list.filter((l) => l.source === "llm" && l.status);
  const n = (s: string) => st[s] ?? 0;
  const contacted = list.filter((l) => l.calls.out > 0 || l.notes > 0 || l.calls.answered > 0).length;
  const talked = list.filter((l) => TALKED.has(l.status)).length;
  const firstH = list.map((l) => l.firstCallH).filter((x) => x !== null) as number[];
  const objCount: Record<string, number> = {};
  for (const l of ai) for (const o of new Set(l.objections as string[])) objCount[o] = (objCount[o] ?? 0) + 1;
  const priceCount: Record<string, number> = {};
  for (const l of ai) priceCount[l.price] = (priceCount[l.price] ?? 0) + 1;
  const qualCount: Record<string, number> = {};
  for (const l of ai) qualCount[l.quality] = (qualCount[l.quality] ?? 0) + 1;
  const issues: Record<string, number> = {};
  for (const l of ai) for (const q of l.issues) issues[q] = (issues[q] ?? 0) + 1;
  const intents: Record<string, number> = {};
  for (const l of ai) intents[l.intent] = (intents[l.intent] ?? 0) + 1;
  const won = list.filter((l) => l.dealWon);
  return {
    leads: list.length, contacted, talked, analyzed: ai.length,
    statuses: st,
    bought: n("kupil"), hot: n("goracy"), warm: n("cieply"), cold: n("zimny"), notInterested: n("niezainteresowany"),
    invalid: n("bledny"), unreachable: n("nieosiagalny"), noContact: n("brak_kontaktu"), noNotes: n("bez_opisu"), pending: n("w_analizie"),
    avgInterest: ai.length ? r1(ai.reduce((s, l) => s + (l.interest ?? 0), 0) / ai.length) : null,
    tooExpensive: priceCount.za_drogo ?? 0, negotiates: priceCount.negocjuje ?? 0, priceAccepted: priceCount.akceptuje ?? 0,
    priceObjection: objCount.cena ?? 0,
    objections: objCount, price: priceCount, quality: qualCount, issues, intents,
    medianFirstCallH: r1(median(firstH)),
    dealsWon: won.length, dealsValue: Math.round(won.reduce((s, l) => s + (l.dealValue ?? 0), 0)),
    dealsOpen: list.filter((l) => l.dealOpen).length,
  };
}
function groupBy(list: any[], key: (l: any) => string | null) {
  const m = new Map<string, any[]>();
  for (const l of list) { const k = key(l); if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k)!.push(l); }
  return m;
}

async function buildData(params: any) {
  const { fromTs, toTs } = rangeTs(params);
  const rows = (await loadDossiers(null, fromTs)).filter((r) => r.d.received_at < toTs &&
    (!params.campaigns?.length || params.campaigns.includes(r.d.campaign)));
  const ins = await loadInsights(rows.map((r) => r.lead_id));
  const leads = rows.map((r) => {
    const d = r.d, i = ins.get(r.lead_id), res = i?.result ?? {};
    const c = d.calls ?? {};
    const won = (d.deals ?? []).filter((x: any) => x.status === "won");
    return {
      id: r.lead_id, name: d.name, campaign: d.campaign ?? "(nieznana)", adset: d.adset, ad: d.ad, form: d.form,
      received_at: d.received_at, pdUrl: d.pd_lead ? `https://${PD_DOMAIN}.pipedrive.com/leads/inbox/${d.pd_lead}` : null,
      fields: formFields(d.fields),
      calls: { n: c.n ?? 0, out: c.out ?? 0, answered: c.answered ?? 0, talk: c.talk ?? 0 },
      employees: c.employees ?? [], notes: (d.notes ?? []).length, aiCalls: (d.ai ?? []).length,
      firstCallH: c.first_out ? r1((new Date(c.first_out).getTime() - new Date(d.received_at).getTime()) / 3600_000) : null,
      source: i?.source ?? null, status: i?.status ?? null, interest: i?.interest ?? null, price: i?.price ?? null,
      quality: i?.quality ?? null, intent: i?.intent ?? null, objections: i?.objections ?? [],
      objectionQuotes: (res.objections ?? []).map((o: any) => ({ type: o.type, quote: o.quote })),
      issues: res.quality_issues ?? [], persona: res.persona ?? null, product: res.product ?? null, budget: res.budget ?? null,
      nextStep: res.next_step ?? null, lostReason: res.lost_reason ?? null, insight: res.insight ?? null, stage: res.stage ?? null,
      dealWon: won.length > 0, dealValue: won.reduce((s: number, x: any) => s + (Number(x.value) || 0), 0),
      dealOpen: (d.deals ?? []).some((x: any) => x.status === "open"),
    };
  });

  const segment = (list: any[], key: (l: any) => string | null) =>
    [...groupBy(list, key)].map(([name, ls]) => ({ name, ...metrics(ls) })).sort((a, b) => b.leads - a.leads);

  const campaigns = [...groupBy(leads, (l) => l.campaign)].map(([name, ls]) => {
    // odpowiedzi z formularza × wynik
    const qMap = new Map<string, Map<string, any[]>>();
    for (const l of ls) for (const [q, a] of l.fields) {
      if (!qMap.has(q)) qMap.set(q, new Map());
      const m = qMap.get(q)!; if (!m.has(a)) m.set(a, []); m.get(a)!.push(l);
    }
    const formAnswers = [...qMap].map(([question, m]) => ({
      question,
      answers: [...m].map(([answer, al]) => ({ answer, ...metrics(al) })).sort((a, b) => b.leads - a.leads).slice(0, 12),
    })).filter((q) => q.answers.length > 1 || q.answers[0]?.leads > 2);
    const quotes: Record<string, { quote: string; lead: string; id: string }[]> = {};
    for (const l of ls) for (const o of l.objectionQuotes) {
      (quotes[o.type] ??= []);
      if (quotes[o.type].length < 8 && o.quote) quotes[o.type].push({ quote: o.quote, lead: l.name ?? "", id: l.id });
    }
    const emp = new Map<string, any[]>();
    for (const l of ls) for (const e of l.employees.length ? l.employees : []) { if (!emp.has(e)) emp.set(e, []); emp.get(e)!.push(l); }
    return {
      name, ...metrics(ls),
      adsets: segment(ls, (l) => l.adset), ads: segment(ls, (l) => l.ad),
      formAnswers, quotes,
      employees: [...emp].map(([n, el]) => ({ name: n, ...metrics(el) })).sort((a, b) => b.leads - a.leads),
      byWeek: [...groupBy(ls, (l) => { const d = new Date(l.received_at); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })]
        .map(([week, wl]) => ({ week, ...metrics(wl) })).sort((a, b) => a.week.localeCompare(b.week)),
    };
  }).sort((a, b) => b.leads - a.leads);

  return {
    params, generatedAt: new Date().toISOString(), totals: metrics(leads), campaigns,
    leads: leads.map(({ fields: _f, objectionQuotes, ...l }) => ({ ...l, quotes: objectionQuotes })),
  };
}

// ---------------- wnioski AI ----------------
// stały system (cache prefiksu), zadanie na końcu wiadomości użytkownika; dwie krótkie części, bo 27b generuje ~9 tok/s
const CAMPAIGN_SYSTEM = `Jesteś senior performance marketerem i trenerem sprzedaży Fastline Racing Academy (szkolenia jazdy sportowej na torze, eventy firmowe, Heels on the track, wyjazdy: Laponia, Sewilla, Andaluzja, Azur). Dostajesz zagregowane dane jednej kampanii Facebook Lead Ads: lejek, statusy leadów po rozmowach (analiza AI rozmów i notatek handlowców), zastrzeżenia klientów z cytatami, reakcję na cenę, jakość leadów, wyniki wg grupy reklam, reklamy i odpowiedzi w formularzu, persony kupujących i odrzucających. Opieraj się tylko na liczbach i cytatach z danych; podawaj liczby/procenty jako dowód. Gdy danych jest mało — powiedz to. Pisz po polsku, konkretnie i zwięźle. Odpowiadasz samym JSON. WAŻNE o danych: liczba „kupil”/deale to dolna granica — handlowcy często zakładają deal w CRM na nowy kontakt, więc wielu zakupów nie da się przypisać do leada; NIE wnioskuj o braku sprzedaży ani przychodu. „nikt_jeszcze_nie_dzwonil_ani_nie_notowal” to NIE są błędne numery — to leady bez telefonu w Ringostat i bez notatek w CRM (proces sprzedaży; część handlowców dzwoni z prywatnych telefonów). Błędne numery to tylko status „bledny” / problem „falszywy_numer”. Zainteresowanie ma skalę 0–10. Procenty jakości liczone od rozmów przeanalizowanych przez AI. Nie myl liczb — cytuj dokładnie wartości z danych. W tekście NIE używaj nazw kluczy z danych (np. z podkreślnikami) — pisz zwykłymi słowami.`;
const CAMPAIGN_TASKS: Record<string, string> = {
  a: `ZADANIE: diagnoza kampanii. JSON: {"verdict":"skaluj|optymalizuj|zmien_grupe|zmien_oferte|wstrzymaj","quality_score":0-100,"headline":"1 zdanie — główny wniosek","summary":"2-3 zdania: co się dzieje i dlaczego","who_buys":"kto kupuje / jest gorący — profil (1-2 zdania)","who_wastes":"kto marnuje budżet — profil i skala (1-2 zdania)","pricing":"1 zdanie o percepcji ceny"}`,
  b: `ZADANIE: co zmienić. Każdy punkt max 25 słów, z liczbą jako dowodem. JSON: {"audience":["2-3 zmiany grupy odbiorców/targetowania"],"creative":["2 zmiany komunikatu/kreacji"],"form":["1-2 zmiany formularza (pytania kwalifikujące)"],"sales":["2 wskazówki dla handlowców"],"alerts":["0-2 pilne problemy"]}`,
};
const OVERALL_SYSTEM = `Jesteś szefem marketingu Fastline Racing Academy. Dostajesz porównanie kampanii Facebook Lead Ads z wnioskami per kampania. Napisz zarządcze podsumowanie: gdzie przesunąć budżet, które grupy odbiorców zmienić, co poprawić w sprzedaży. Konkretnie, z liczbami, zwięźle (każdy punkt max 25 słów). WAŻNE o danych: liczba „kupil”/deale to dolna granica — handlowcy często zakładają deal w CRM na nowy kontakt, więc wielu zakupów nie da się przypisać do leada; NIE wnioskuj o braku sprzedaży ani przychodu. „nikt_jeszcze_nie_dzwonil_ani_nie_notowal” to NIE są błędne numery — to leady bez telefonu w Ringostat i bez notatek w CRM (proces sprzedaży; część handlowców dzwoni z prywatnych telefonów). Błędne numery to tylko status „bledny” / problem „falszywy_numer”. Zainteresowanie ma skalę 0–10. Procenty jakości liczone od rozmów przeanalizowanych przez AI. Nie myl liczb — cytuj dokładnie wartości z danych. W tekście NIE używaj nazw kluczy z danych (np. z podkreślnikami) — pisz zwykłymi słowami. Odpowiedz samym JSON po polsku:
{"summary":"3-4 zdania","budget":["2-3 rekomendacje przesunięcia budżetu"],"top_actions":["3-5 najważniejszych działań na najbliższy tydzień, w kolejności"],"audience_shift":"1-2 zdania","sales_process":"1-2 zdania o procesie sprzedaży (szybkość kontaktu, notatki, zastrzeżenia)"}`;

function pctOf(a: number, b: number) { return b ? Math.round((a / b) * 100) : 0; }
function compactMetrics(m: any) {
  return {
    leady: m.leads, kontakt: `${pctOf(m.contacted, m.leads)}%`, rozmowa: `${pctOf(m.talked, m.leads)}%`, przeanalizowane: m.analyzed,
    kupil: m.bought, goracy: m.hot, cieply: m.warm, zimny: m.cold, niezainteresowany: m.notInterested, bledny: m.invalid,
    nie_odebral_telefonu: m.unreachable, nikt_jeszcze_nie_dzwonil_ani_nie_notowal: m.noContact, rozmowa_bez_notatek: m.noNotes,
    sr_zainteresowanie_skala_0_10: m.avgInterest, za_drogo: m.tooExpensive, negocjuje_cene: m.negotiates, zastrzezenie_cena: m.priceObjection,
    mediana_h_do_telefonu: m.medianFirstCallH, deale_wygrane: m.dealsWon, wartosc_wygranych: m.dealsValue,
  };
}
function campaignPrompt(c: any, leads: any[]) {
  const ls = leads.filter((l) => l.campaign === c.name && l.source === "llm");
  const sample = (f: (l: any) => boolean, n: number) => ls.filter(f).slice(0, n).map((l) => [l.persona, l.product, l.lostReason, l.insight].filter(Boolean).join(" | "));
  return JSON.stringify({
    kampania: c.name, lejek: compactMetrics(c),
    zastrzezenia: Object.entries(c.objections).sort((a: any, b: any) => b[1] - a[1]).map(([t, n]) => ({ typ: t, leady: n, cytaty: (c.quotes[t] ?? []).slice(0, 4).map((q: any) => q.quote) })),
    jakosc: c.quality, problemy_jakosci: c.issues, cel_zakupu: c.intents,
    grupy_reklam: c.adsets.map((a: any) => ({ nazwa: a.name, ...compactMetrics(a) })),
    reklamy: c.ads.map((a: any) => ({ nazwa: a.name, ...compactMetrics(a) })),
    formularz: c.formAnswers.map((q: any) => ({ pytanie: q.question, odpowiedzi: q.answers.slice(0, 8).map((a: any) => ({ odp: a.answer, leady: a.leads, kupil: a.bought, goracy_cieply: a.hot + a.warm, niezainteresowany_zimny: a.notInterested + a.cold, bledny: a.invalid, za_drogo: a.tooExpensive, sr_zaint_0_10: a.avgInterest })) })),
    handlowcy: c.employees.map((e: any) => ({ imie: e.name, leady: e.leads, kupil: e.bought, goracy_cieply: e.hot + e.warm, sr_zaint_0_10: e.avgInterest })),
    kupujacy_i_goracy: sample((l) => ["kupil", "goracy"].includes(l.status), 15),
    odrzucajacy: sample((l) => ["niezainteresowany", "zimny", "bledny"].includes(l.status), 15),
    wnioski_z_rozmow: ls.map((l) => l.insight).filter(Boolean).slice(0, 25),
  }).slice(0, 9000);
}

// ---------------- raport ----------------
async function stepReport(secrets: Secrets, rep: any, deadline: number) {
  const upd = (patch: Record<string, unknown>) => db.from("ai_reports").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", rep.id);
  const p = rep.params;
  if (rep.status === "queued" || rep.status === "analyzing") {
    const { fromTs, toTs } = rangeTs(p);
    const rows = (await loadDossiers(null, fromTs)).filter((r) => r.d.received_at < toTs && (!p.campaigns?.length || p.campaigns.includes(r.d.campaign)));
    const { queue } = await prepare(rows);
    const total = rows.length;
    const base = { total, toAnalyze: queue.length, stage: "analiza leadów" };
    await upd({ status: "analyzing", progress: { ...base, done: total - queue.length } });
    if (queue.length) {
      const done = await runQueue(secrets, queue, deadline, (n) => upd({ progress: { ...base, done: total - queue.length + n } }) as any);
      await upd({ progress: { ...base, done: total - queue.length + done } });
      if (done < queue.length) return;
    }
    const data = await buildData(p);
    await upd({ status: "summarizing", data, result: { campaigns: {} }, progress: { total, done: total, stage: "wnioski AI", ai: 0, aiTotal: data.campaigns.filter((c: any) => c.analyzed >= 3).length * 2 + 1 } });
    rep = { ...rep, status: "summarizing", data, result: { campaigns: {} } };
  }
  if (rep.status === "summarizing") {
    const data = rep.data, result = rep.result ?? { campaigns: {} };
    result.campaigns ??= {}; result.tries ??= {};
    const eligible = data.campaigns.filter((c: any) => c.analyzed >= 3);
    const aiTotal = eligible.length * 2 + 1;
    const doneParts = () => eligible.reduce((n: number, c: any) => n + ["a", "b"].filter((k) => result.campaigns[c.name]?.[`_${k}`]).length, 0) + (result.overall ? 1 : 0);
    const save = () => upd({ result, progress: { ...rep.progress, stage: "wnioski AI", ai: doneParts(), aiTotal } });
    const tasks = eligible.flatMap((c: any) => ["a", "b"].filter((k) => !result.campaigns[c.name]?.[`_${k}`]).map((k) => ({ c, k })));
    let t = 0;
    // 2 naraz, każde wywołanie tylko gdy zostało ≥ 100 s
    const worker = async () => {
      while (t < tasks.length && Date.now() < deadline - 100_000) {
        const { c, k } = tasks[t++];
        const key = `${c.name}|${k}`;
        try {
          const r = await llm(secrets, CAMPAIGN_SYSTEM, `${campaignPrompt(c, data.leads)}\n\n${CAMPAIGN_TASKS[k]}`, k === "a" ? 600 : 750, 125_000);
          result.campaigns[c.name] = { ...(result.campaigns[c.name] ?? {}), ...r, [`_${k}`]: true };
          delete result.campaigns[c.name].error;
        } catch (e) {
          result.tries[key] = (result.tries[key] ?? 0) + 1;
          if (result.tries[key] >= 3) result.campaigns[c.name] = { ...(result.campaigns[c.name] ?? {}), [`_${k}`]: true, error: String((e as Error).message ?? e) };
        }
        await save();
      }
    };
    await Promise.all([worker(), worker()]);
    if (eligible.some((c: any) => !result.campaigns[c.name]?._a || !result.campaigns[c.name]?._b)) return;
    if (!result.overall) {
      if (Date.now() > deadline - 100_000) return;
      const cmp = data.campaigns.map((c: any) => ({
        kampania: c.name, ...compactMetrics(c),
        werdykt: result.campaigns[c.name]?.verdict ?? "za mało danych", wniosek: result.campaigns[c.name]?.headline ?? null,
        kto_kupuje: result.campaigns[c.name]?.who_buys ?? null, kto_marnuje: result.campaigns[c.name]?.who_wastes ?? null,
      }));
      try { result.overall = await llm(secrets, OVERALL_SYSTEM, JSON.stringify({ okres: `${p.from} – ${p.to}`, kampanie: cmp, razem: compactMetrics(data.totals) }).slice(0, 9000), 800, 125_000); }
      catch (e) {
        result.tries.overall = (result.tries.overall ?? 0) + 1;
        if (result.tries.overall >= 3) result.overall = { error: String((e as Error).message ?? e) };
      }
      if (!result.overall) { await save(); return; }
    }
    await upd({ status: "done", result, finished_at: new Date().toISOString(), progress: { ...rep.progress, stage: "gotowe", ai: aiTotal, aiTotal } });
  }
}

async function tick(secrets: Secrets, body: any) {
  const started = Date.now();
  const deadline = started + BUDGET_MS;
  const out: Record<string, unknown> = {};
  const { data: active } = await db.from("ai_reports").select("status").in("status", ["queued", "analyzing", "summarizing"]).limit(1);
  if (active?.[0]?.status !== "summarizing" || body.forceSync) {
    try { out.sync = await syncPipedrive(secrets, !!body.forceSync); } catch (e) { out.syncError = String((e as Error).message ?? e); }
  }

  const { data: reps } = await db.from("ai_reports").select("*").in("status", ["queued", "analyzing", "summarizing"]).order("created_at").limit(1);
  const rep = reps?.[0];
  if (rep) {
    try { await stepReport(secrets, rep, deadline); out.report = rep.id; }
    catch (e) {
      const msg = String((e as Error).message ?? e);
      await db.from("ai_reports").update({ status: "error", error: msg, updated_at: new Date().toISOString() }).eq("id", rep.id);
      out.reportError = msg;
    }
    return out;
  }
  // tło: analiza nowych / zmienionych leadów (najświeższe najpierw), żeby raporty liczyły się szybko
  if (Date.now() < deadline - 45_000) {
    const rows = await loadDossiers(null, new Date(`${SYNC_FROM}T00:00:00Z`).toISOString());
    const { queue, rules } = await prepare(rows);
    const done = await runQueue(secrets, queue, deadline, undefined, 2);
    out.background = { pending: queue.length - done, analyzed: done, rules };
    await setSetting("smart_bg_status", { at: new Date().toISOString(), pending: queue.length - done, total: rows.length });
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  const secrets = await getSecrets();
  if (req.headers.get("x-internal-token") !== secrets.INTERNAL_TOKEN) return new Response("unauthorized", { status: 401 });
  const body = await req.json().catch(() => ({}));
  const { data: locked } = await db.rpc("smart_try_lock", { p_ttl: 170 });
  if (!locked) return Response.json({ ok: true, busy: true });
  let res: Response;
  try {
    const out = await tick(secrets, body);
    res = Response.json({ ok: true, ...out });
  } catch (e) {
    res = Response.json({ ok: false, error: String((e as Error).message ?? e) }, { status: 500 });
  } finally {
    await db.rpc("smart_unlock");
  }
  // cron chodzi raz na godzinę; zlecony raport liczy się dalej od razu (kolejny krok przez pg_net), aż będzie gotowy
  const { data: active } = await db.from("ai_reports").select("id").in("status", ["queued", "analyzing", "summarizing"]).limit(1);
  if (active?.length) await db.rpc("smart_kick");
  return res!;
});
