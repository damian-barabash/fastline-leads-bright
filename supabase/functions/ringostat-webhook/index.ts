// ringostat-webhook — odbiornik webhooków Ringostat.
//  • „Call processed by AI” → podsumowanie, nastroje, rekomendacje, ocena jakości, transkrypcja (VTT) do rs_calls.
//  • dowolne inne zdarzenie (np. „After call”) → szybka synchronizacja dziennika (max raz na minutę).
// Auth: ?token=<app_secrets.RINGOSTAT_WEBHOOK_TOKEN> w URL (Ringostat nie podpisuje żądań).
// Body: JSON, x-www-form-urlencoded albo parametry w query — nazwy pól dowolne, mapowane po aliasach.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

// klucz znormalizowany (małe litery, bez znaków specjalnych) -> pole docelowe
const ALIASES: Record<string, string[]> = {
  call_id: ["callid", "uniqueid", "id", "call", "idpolaczenia", "identyfikatorpolaczenia"],
  title: ["title", "aititle", "tytul", "calltitle"],
  summary: ["summary", "shortsummary", "briefsummary", "aisummary", "podsumowanie", "krotkiepodsumowanie"],
  client_mood: ["clientmood", "customermood", "clientssentiment", "clientsentiment", "customersentiment", "nastrojklienta"],
  employee_mood: ["employeemood", "managermood", "employeessentiment", "employeesentiment", "nastrojpracownika"],
  overall_mood: ["overallmood", "generalsentiment", "generalmood", "nastrojogolny"],
  sentiment: ["sentiment", "sentyment"],
  recommendations: ["recommendedactions", "recommendations", "rekomendacje", "zalecanedzialania"],
  key_points: ["keypoints", "kluczowepunkty"],
  next_steps: ["nextsteps", "kolejnekroki", "nastepnekroki"],
  mistakes: ["mistakes", "bledy"],
  good_points: ["goodpoints", "mocnestrony", "plusy"],
  keywords: ["keywords", "slowakluczowe"],
  parasite_words: ["parasitewords", "fillerwords", "slowapasozyty"],
  obscene_language: ["obscenelanguage", "profanity", "wulgaryzmy"],
  q_opening: ["dialoguequalityopening", "qualityopening", "opening", "powitanie"],
  q_anamnesis: ["dialoguequalityhistoryanamnesis", "dialoguequalityhistory", "qualityanamnesis", "qualityhistory", "anamnesis", "wywiad"],
  q_presentation: ["dialoguequalitypresentation", "qualitypresentation", "presentation", "prezentacja"],
  q_closing: ["dialoguequalityclosing", "qualityclosing", "closing", "zamkniecie"],
  q_score: ["dialoguequalityscore", "qualityscore", "score", "ocena", "averagescore"],
  q_review: ["dialoguequalityreview", "qualityreview", "review", "recenzja"],
  review_score: ["reviewrequiredscore", "reviewscore"],
  review_details: ["reviewrequireddetails", "reviewdetails"],
  followup_points: ["followupmainpoints", "mainpoints"],
  followup_steps: ["followupnextsteps"],
  transcript: ["transcript", "transcription", "vtt", "aivtt", "fileprocessingresultbyaivtt", "transkrypcja", "aifile", "vttfile"],
  event: ["event", "eventtype", "zdarzenie"],
};
const norm = (k: string) => k.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l").replace(/[^a-z0-9]/g, "");
const LOOKUP: Record<string, string> = {};
for (const [field, keys] of Object.entries(ALIASES)) for (const k of keys) LOOKUP[k] = field;

function flatten(obj: any, out: Record<string, unknown> = {}, prefix = ""): Record<string, unknown> {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix} ${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, out, key);
    else out[key] = v;
  }
  return out;
}

function num(v: unknown): number | null {
  const m = String(v ?? "").replace(",", ".").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

async function readBody(req: Request, url: URL): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  url.searchParams.forEach((v, k) => { if (k !== "token") out[k] = v; });
  const raw = await req.text();
  if (!raw) return out;
  try { return { ...out, ...flatten(JSON.parse(raw)) }; } catch { /* nie JSON */ }
  new URLSearchParams(raw).forEach((v, k) => { out[k] = v; });
  return out;
}

async function loadTranscript(v: unknown): Promise<string | null> {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) return s;
  try {
    const res = await fetch(s);
    if (!res.ok) return s; // zostawiamy link
    return (await res.text()).slice(0, 500_000);
  } catch { return s; }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET") return new Response("ok"); // test dostępności z panelu Ringostat
  if (req.method !== "POST") return new Response("method", { status: 405 });

  const { data: sec } = await db.from("app_secrets").select("key,value").in("key", ["RINGOSTAT_WEBHOOK_TOKEN", "INTERNAL_TOKEN"]);
  const secrets = Object.fromEntries((sec ?? []).map((r) => [r.key, r.value]));
  const token = url.searchParams.get("token") ?? req.headers.get("x-webhook-token") ?? "";
  if (!secrets.RINGOSTAT_WEBHOOK_TOKEN || token !== secrets.RINGOSTAT_WEBHOOK_TOKEN) {
    return new Response("unauthorized", { status: 401 });
  }

  const payload = await readBody(req, url);
  const f: Record<string, unknown> = {};
  const custom: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    const field = LOOKUP[norm(k)];
    if (field) f[field] = v; else custom[k] = v;
  }
  const callId = f.call_id ? String(f.call_id) : null;

  const { data: ev } = await db.from("rs_webhook_events")
    .insert({ call_id: callId, payload }).select("id").single();
  const mark = (status: string, error?: string) =>
    db.from("rs_webhook_events").update({ status, error: error ?? null }).eq("id", ev?.id);

  try {
    const aiKeys = Object.keys(f).filter((k) => !["call_id", "event"].includes(k));
    if (!callId || aiKeys.length === 0) {
      // zdarzenie bez danych AI → odśwież dziennik (debounce 60 s)
      const { data: st } = await db.from("settings").select("value").eq("key", "rs_last_sync_at").maybeSingle();
      const last = st?.value ? new Date(String(st.value)).getTime() : 0;
      if (Date.now() - last > 60_000) {
        fetch(`${SUPABASE_URL}/functions/v1/ringostat-sync`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-internal-token": secrets.INTERNAL_TOKEN, "authorization": `Bearer ${SERVICE_ROLE}` },
          body: "{}",
        }).catch(() => {});
      }
      await mark(callId ? "sync" : "no_call_id");
      return Response.json({ ok: true, ai: false });
    }

    const transcript = f.transcript ? await loadTranscript(f.transcript) : null;
    const ai: Record<string, unknown> = { ...f };
    delete ai.call_id; delete ai.transcript; delete ai.event;
    if (Object.keys(custom).length) ai.custom = custom;

    const row: Record<string, unknown> = {
      uniqueid: callId,
      ai,
      ai_title: f.title ? String(f.title) : null,
      ai_summary: f.summary ? String(f.summary) : (f.followup_points ? String(f.followup_points) : null),
      ai_score: num(f.q_score),
      ai_at: new Date().toISOString(),
    };
    if (transcript) row.transcript = transcript;
    const { error } = await db.from("rs_calls").upsert(row, { onConflict: "uniqueid" });
    if (error) throw new Error(error.message);
    await mark("applied");
    return Response.json({ ok: true, ai: true });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    await mark("error", msg);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
});
