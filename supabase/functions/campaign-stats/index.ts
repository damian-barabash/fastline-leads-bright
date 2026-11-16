// campaign-stats — zakładka «Kampanie».
//  {action:"sync"}          — wydatki z Meta Marketing API (insights per grupa reklam per dzień) → fb_insights.
//                             pg_cron co 3 h; pierwszy przebieg (pusta tabela) robi backfill od SYNC_FROM.
//                             Wymaga tokenu FB_SYSTEM_TOKEN z uprawnieniem ads_read i przypisanym kontem reklamowym.
//  {action:"ai", id}         — komentarz AI (Barabash AI) do zlecenia z campaign_ai_notes.
// Auth: x-internal-token. Deploy z verify_jwt = false.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const GRAPH = "https://graph.facebook.com/v21.0";
const SYNC_FROM = "2026-07-01";
const REFRESH_DAYS = 7; // Meta dopisuje konwersje wstecz — odświeżamy ostatni tydzień

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
const setSetting = (key: string, value: unknown) =>
  db.from("settings").upsert({ key, value, updated_at: new Date().toISOString() });

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (ds: string, n: number) => { const d = new Date(ds + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return isoDay(d); };
const warsawToday = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });

// ---------------- Meta ----------------
async function graph(url: string) {
  const res = await fetch(url);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j?.error) throw new Error(j?.error?.message ?? `graph ${res.status}`);
  return j;
}

async function adAccounts(token: string): Promise<{ id: string; name: string; currency: string }[]> {
  // ręczna lista w settings (np. gdy /me/adaccounts nic nie zwraca), inaczej wszystkie dostępne dla tokenu
  const manual = await getSetting("cs_ad_accounts");
  if (Array.isArray(manual) && manual.length) {
    return manual.map((id: string) => ({ id: String(id).startsWith("act_") ? id : `act_${id}`, name: "", currency: "" }));
  }
  const j = await graph(`${GRAPH}/me/adaccounts?fields=id,name,currency,account_status&limit=100&access_token=${token}`)
    .catch((e) => {
      if (/Unsupported get request|permission|ads_read/i.test(String(e?.message))) {
        throw new Error("Token Meta nie ma uprawnienia ads_read — wygeneruj token użytkownika systemowego z ads_read i przypisz mu konto reklamowe.");
      }
      throw e;
    });
  return (j.data ?? []).map((a: any) => ({ id: a.id, name: a.name, currency: a.currency }));
}

const LEAD_ACTIONS = ["lead", "onsite_conversion.lead_grouped", "leadgen_grouped", "offsite_conversion.fb_pixel_lead"];
function leadsFromActions(actions: any[] | undefined) {
  if (!actions) return 0;
  for (const t of LEAD_ACTIONS) {
    const a = actions.find((x) => x.action_type === t);
    if (a) return Math.round(Number(a.value) || 0);
  }
  return 0;
}

async function syncAccount(token: string, act: { id: string }, since: string, until: string) {
  let rows = 0;
  // okna po 31 dni — mniejsze odpowiedzi, brak limitów czasu po stronie Meta
  for (let s = since; s <= until; s = addDays(s, 31)) {
    const e = addDays(s, 30) < until ? addDays(s, 30) : until;
    const fields = "campaign_id,campaign_name,adset_id,adset_name,objective,spend,impressions,reach,inline_link_clicks,actions,account_currency";
    let url: string | null = `${GRAPH}/${act.id}/insights?level=adset&time_increment=1&limit=500` +
      `&time_range=${encodeURIComponent(JSON.stringify({ since: s, until: e }))}&fields=${fields}&access_token=${token}`;
    const batch: any[] = [];
    while (url) {
      const j = await graph(url);
      for (const r of j.data ?? []) {
        batch.push({
          date: r.date_start, adset_id: String(r.adset_id), ad_account_id: act.id,
          campaign_id: String(r.campaign_id), campaign_name: r.campaign_name, adset_name: r.adset_name,
          objective: r.objective ?? null, currency: r.account_currency ?? null,
          spend: Number(r.spend) || 0, impressions: Number(r.impressions) || 0, reach: Number(r.reach) || 0,
          clicks: Number(r.inline_link_clicks) || 0, fb_leads: leadsFromActions(r.actions),
          synced_at: new Date().toISOString(),
        });
      }
      url = j.paging?.next ?? null;
    }
    // okno zastępujemy w całości (grupa bez wydatków w danym dniu znika z odpowiedzi)
    await db.from("fb_insights").delete().eq("ad_account_id", act.id).gte("date", s).lte("date", e);
    for (let i = 0; i < batch.length; i += 500) {
      const { error } = await db.from("fb_insights").upsert(batch.slice(i, i + 500), { onConflict: "date,adset_id" });
      if (error) throw new Error(error.message);
    }
    rows += batch.length;
  }
  return rows;
}

async function sync(secrets: Secrets, body: any) {
  const started = new Date();
  const token = secrets.FB_SYSTEM_TOKEN;
  try {
    if (!token) throw new Error("Brak FB_SYSTEM_TOKEN");
    const until = body.to ?? warsawToday();
    let since = body.from;
    if (!since) {
      const { count } = await db.from("fb_insights").select("*", { count: "exact", head: true });
      since = count ? addDays(until, -REFRESH_DAYS) : SYNC_FROM;
    }
    const accounts = await adAccounts(token);
    if (!accounts.length) {
      throw new Error("Token Meta nie ma dostępu do żadnego konta reklamowego (brak uprawnienia ads_read lub konto nie jest przypisane do użytkownika systemowego).");
    }
    const per: any[] = [];
    let total = 0;
    for (const a of accounts) {
      try {
        const n = await syncAccount(token, a, since, until);
        total += n;
        per.push({ id: a.id, name: a.name, rows: n });
      } catch (e) {
        per.push({ id: a.id, name: a.name, error: String((e as Error)?.message ?? e) });
      }
    }
    const allFailed = per.every((p) => p.error);
    const result = { at: started.toISOString(), ok: !allFailed, from: since, to: until, rows: total, accounts: per, error: allFailed ? per[0]?.error : undefined };
    await setSetting("cs_sync_result", result);
    return result;
  } catch (e) {
    const result = { at: started.toISOString(), ok: false, error: String((e as Error)?.message ?? e) };
    await setSetting("cs_sync_result", result);
    return result;
  }
}

// ---------------- Barabash AI ----------------
async function llm(secrets: Secrets, system: string, user: string, maxTokens: number, timeoutMs: number) {
  const res = await fetch(`${secrets.BARABASH_AI_URL || "https://barabash-ai.tailcd3444.ts.net/v1"}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secrets.BARABASH_AI_KEY}` },
    body: JSON.stringify({
      model: secrets.BARABASH_AI_MODEL || "qwen3.8:27b-q4_K_M",
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0.2, max_tokens: maxTokens, response_format: { type: "json_object" },
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

const AI_SYSTEM = `Jesteś analitykiem performance marketingu Fastline Racing Academy (szkolenia jazdy sportowej na torze, Driver to Racer, eventy firmowe, Heels on the track, wyjazdy: Laponia, Sewilla/Andaluzja, Azur). Dostajesz liczby kampanii Facebook Lead Ads za wybrany okres i za poprzedni okres tej samej długości oraz trend tygodniowy. Twoje zadanie: zamiast człowieka przeanalizować te liczby i krótko napisać, co się dzieje — np. "w tym tygodniu mniej leadów", "lead podrożał o 30%", "kampania X daje tanie, ale słabe leady".
Zasady:
- Opieraj się WYŁĄCZNIE na danych. Każde twierdzenie poprzyj liczbą (np. "CPL 42 zł → 58 zł, +38%"). Nie wymyślaj przyczyn, których nie widać w danych — możesz wskazać prawdopodobną przyczynę jako hipotezę ("prawdopodobnie").
- "leady" = leady, które realnie wpadły do systemu; "cpl" = wydatki / leady; "kontakt_proc" = % leadów, z którymi był telefon lub notatka handlowca; "gorace" = leady ocenione przez AI jako gorące lub kupione (dolna granica — ocena tylko tam, gdzie była rozmowa).
- Jeśli "wydatki_dostepne" = false — nie pisz nic o kosztach, CPL, CTR ani CPM; skup się na liczbie i jakości leadów, i raz krótko wspomnij, że brak danych o wydatkach.
- Leady z ostatnich dni okresu mogą jeszcze czekać na telefon i ocenę AI (ocena AI liczy się w tle co godzinę) — niższy "kontakt_proc" lub mniej "ocenione_ai" w świeżym okresie to zwykle opóźnienie, a nie problem; wspominaj o tym ostrożnie i nie nazywaj tego problemem technicznym.
- Małe liczby (np. 2 → 4 leady) to nie trend — zaznacz, że próbka jest mała.
- Kwoty w zł bez groszy. Pisz po polsku, rzeczowo, krótko.
- W "campaigns" max 8 kampanii, najważniejsze najpierw; pomiń kampanie, które w obu okresach mają mniej niż 3 leady.
Odpowiedz samym JSON w jednej linii, bez wcięć:
{"headline":"1 zdanie — najważniejsza zmiana w okresie","summary":"3–5 zdań: leady, koszt, CPL i jakość vs poprzedni okres, co ciągnie wynik w górę lub w dół","alerts":["max 4 krótkie punkty, które wymagają reakcji"],"actions":["max 5 konkretnych kroków do zrobienia w kampaniach"],"campaigns":[{"name":"dokładna nazwa kampanii z danych","trend":"lepiej|gorzej|stabilnie|nowa|zatrzymana","comment":"1–2 zdania z liczbami"}]}`;

async function runAi(secrets: Secrets, id: string) {
  const { data: row } = await db.from("campaign_ai_notes").select("*").eq("id", id).maybeSingle();
  if (!row) return { error: "not found" };
  if (row.status === "running" && Date.now() - new Date(row.created_at).getTime() < 170_000) return { skipped: "running" };
  await db.from("campaign_ai_notes").update({ status: "running", error: null }).eq("id", id);
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await llm(secrets, AI_SYSTEM, "DANE:\n" + JSON.stringify(row.input), 2200, 130_000);
      await db.from("campaign_ai_notes").update({ status: "done", result: res, finished_at: new Date().toISOString() }).eq("id", id);
      return { ok: true };
    } catch (e) {
      lastErr = String((e as Error)?.message ?? e);
      if (/abort|timeout/i.test(lastErr)) break; // drugi raz nie zmieści się w limicie funkcji
    }
  }
  await db.from("campaign_ai_notes").update({ status: "error", error: lastErr, finished_at: new Date().toISOString() }).eq("id", id);
  return { error: lastErr };
}

Deno.serve(async (req) => {
  const secrets = await getSecrets();
  if (!secrets.INTERNAL_TOKEN || req.headers.get("x-internal-token") !== secrets.INTERNAL_TOKEN) {
    return json({ error: "unauthorized" }, 401);
  }
  let body: any = {};
  try { body = await req.json(); } catch { /* pusty */ }
  try {
    if (body.action === "sync") return json(await sync(secrets, body));
    if (body.action === "ai") return json(await runAi(secrets, body.id));
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
