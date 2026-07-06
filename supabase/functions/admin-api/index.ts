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
        const since = new Date(Date.now() - 30 * 864e5).toISOString();
        const { data: rows } = await db.from("leads").select("status,crm_status,received_at").gte("received_at", since);
        const all = rows ?? [];
        const todayStr = new Date().toISOString().slice(0, 10);
        const byDayMap: Record<string, number> = {};
        for (const r of all) {
          const d = String(r.received_at).slice(0, 10);
          byDayMap[d] = (byDayMap[d] ?? 0) + 1;
        }
        const byDay = Object.entries(byDayMap).map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date));
        const { count: total } = await db.from("leads").select("*", { count: "exact", head: true });
        return json({
          total: total ?? 0,
          last30: all.length,
          today: all.filter((r) => String(r.received_at).slice(0, 10) === todayStr).length,
          done: all.filter((r) => r.status === "done").length,
          failed: all.filter((r) => r.status === "failed").length,
          pending: all.filter((r) => r.status === "pending" || r.status === "processing").length,
          crmSent: all.filter((r) => r.crm_status === "sent").length,
          byDay,
        });
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
        let q = db.from("fb_forms").select("form_id,page_id,name,status,created_time,leads_count").order("created_time", { ascending: false });
        if (body.page_id) q = q.eq("page_id", body.page_id);
        const { data } = await q;
        return json({ rows: data ?? [] });
      }

      default:
        return json({ error: "unknown action: " + action }, 400);
    }
  } catch (e) {
    const msg = String(e?.message ?? e);
    return json({ error: msg }, msg === "forbidden" ? 403 : 400);
  }
});
