import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { SkelCards } from "../components/Skeleton.jsx";

export default function Settings() {
  const { user } = useAuth();
  const admin = user.role === "admin";
  const [s, setS] = useState(null);
  const [msg, setMsg] = useState("");
  const [tpls, setTpls] = useState([]);
  const [test, setTest] = useState({ template_id: "", email: "", phone: "", busy: false, out: "" });

  const load = async () => {
    const [r, t] = await Promise.all([api("settings.get"), api("templates.list").catch(() => ({ rows: [] }))]);
    setS(r.settings); setTpls(t.rows);
    setTest((p) => ({ ...p, template_id: p.template_id || t.rows.find((x) => x.is_default)?.id || t.rows[0]?.id || "" }));
  };
  useEffect(() => { load(); }, []);

  const set = async (key, value) => {
    await api("settings.set", { key, value });
    setS((p) => ({ ...p, [key]: value }));
    setMsg("Zapisano"); setTimeout(() => setMsg(""), 1500);
  };

  const runTest = async () => {
    if (!test.template_id || (!test.email && !test.phone)) { setTest((p) => ({ ...p, out: "Podaj e-mail i/lub telefon" })); return; }
    setTest((p) => ({ ...p, busy: true, out: "" }));
    try {
      const r = await api("client.testSend", { template_id: test.template_id, email: test.email || undefined, phone: test.phone || undefined });
      setTest((p) => ({ ...p, busy: false, out: "Wysłano: " + [r.email && "e-mail", r.sms && "SMS"].filter(Boolean).join(" + ") }));
    } catch (e) {
      setTest((p) => ({ ...p, busy: false, out: "Błąd: " + e.message }));
    }
  };

  if (!s) return (<><div className="topbar"><div><h1>Ustawienia</h1><div className="sub">Konfiguracja globalna automatyzacji</div></div></div><div className="grid cols-2"><SkelCards n={4} cols={2} /></div></>);

  return (
    <>
      <div className="topbar">
        <div><h1>Ustawienia</h1><div className="sub">Konfiguracja globalna automatyzacji</div></div>
        {msg && <span className="ok">{msg}</span>}
      </div>

      <div className="grid cols-2">
        <div className="panel">
          <h3>Powiadomienia e-mail</h3>
          <label className="fld"><span className="lbl">Adres nadawcy</span>
            <input defaultValue={s.email_from} disabled={!admin} onBlur={(e) => admin && set("email_from", e.target.value)} /></label>
          <p className="muted small">Odbiorców powiadomień ustawiasz per-reguła w sekcji „Sortowanie”.</p>
        </div>

        <div className="panel">
          <h3>Facebook Conversions API (CAPI)</h3>
          <label className="toggle" style={{ marginBottom: 14 }}>
            <input type="checkbox" checked={s.capi_enabled === true} disabled={!admin} onChange={(e) => set("capi_enabled", e.target.checked)} />
            <span className="track" />Wysyłaj zdarzenie „Lead” do Facebooka
          </label>
          <label className="fld"><span className="lbl">Dataset / Pixel ID</span>
            <input defaultValue={s.capi_pixel_id || ""} disabled={!admin} onBlur={(e) => admin && set("capi_pixel_id", e.target.value)} /></label>
          <p className="muted small">Token CAPI przechowywany jest bezpiecznie po stronie serwera.</p>
        </div>

        <div className="panel">
          <h3>Wiadomości do klienta — kalendarz oddzwonień</h3>
          <label className="toggle" style={{ marginBottom: 12 }}>
            <input type="checkbox" checked={s.client_email_enabled === true} disabled={!admin} onChange={(e) => set("client_email_enabled", e.target.checked)} />
            <span className="track" />Wysyłaj klientowi e-mail z linkiem do kalendarza
          </label>
          <label className="toggle" style={{ marginBottom: 14 }}>
            <input type="checkbox" checked={s.client_sms_enabled === true} disabled={!admin} onChange={(e) => set("client_sms_enabled", e.target.checked)} />
            <span className="track" />Wysyłaj klientowi SMS z linkiem do kalendarza
          </label>
          <label className="fld"><span className="lbl">Pole nadawcy SMS (SMSAPI.pl)</span>
            <input defaultValue={s.sms_sender || "FASTLINE RA"} disabled={!admin} onBlur={(e) => admin && set("sms_sender", e.target.value)} /></label>
          <p className="muted small">Treści wiadomości edytujesz w zakładce „Wiadomości”. <a href="/calendar?t=demo" target="_blank" rel="noreferrer" style={{ color: "var(--red-2)" }}>Podgląd kalendarza (tryb testowy) ↗</a></p>
        </div>

        <div className="panel">
          <h3>Wysyłka testowa</h3>
          <label className="fld"><span className="lbl">Szablon</span>
            <select value={test.template_id} onChange={(e) => setTest((p) => ({ ...p, template_id: e.target.value }))}>
              {tpls.map((t) => <option key={t.id} value={t.id}>{t.name}{t.is_default ? " (domyślny)" : ""}</option>)}
            </select></label>
          <div className="grid cols-2">
            <label className="fld"><span className="lbl">Testowy e-mail</span>
              <input value={test.email} placeholder="adres@..." onChange={(e) => setTest((p) => ({ ...p, email: e.target.value }))} /></label>
            <label className="fld"><span className="lbl">Testowy telefon (SMS)</span>
              <input value={test.phone} placeholder="+48…" onChange={(e) => setTest((p) => ({ ...p, phone: e.target.value }))} /></label>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <button className="btn primary sm" disabled={!admin || test.busy} onClick={runTest}>{test.busy ? "Wysyłam…" : "Wyślij test"}</button>
            {test.out && <span className={"small " + (test.out.startsWith("Błąd") ? "err" : "ok")} style={{ padding: "6px 10px" }}>{test.out}</span>}
          </div>
          <p className="muted small" style={{ marginTop: 10 }}>Link w teście prowadzi do kalendarza w trybie testowym (nic nie zapisuje).</p>
        </div>

        <div className="panel">
          <h3>Domyślny właściciel</h3>
          <label className="fld"><span className="lbl">Pipedrive owner ID (fallback)</span>
            <input type="number" defaultValue={s.default_owner_id} disabled={!admin} onBlur={(e) => admin && set("default_owner_id", Number(e.target.value))} /></label>
          <p className="muted small">Używany, gdy reguła nie wskazuje właściciela. Domyślnie 14906954 (Łukasz).</p>
        </div>

        <div className="panel">
          <h3>Data uruchomienia (tylko nowe leady)</h3>
          <div className="small muted" style={{ marginBottom: 8 }}>Leady utworzone przed tą datą są pomijane.</div>
          <div><b>{s.go_live_at ? new Date(s.go_live_at).toLocaleString("pl-PL") : "—"}</b></div>
          {admin && <button className="btn sm" style={{ marginTop: 12 }} onClick={() => set("go_live_at", new Date().toISOString())}>Ustaw na teraz</button>}
        </div>
      </div>
    </>
  );
}
