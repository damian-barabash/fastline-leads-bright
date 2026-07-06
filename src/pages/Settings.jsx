import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";

export default function Settings() {
  const { user } = useAuth();
  const admin = user.role === "admin";
  const [s, setS] = useState(null);
  const [msg, setMsg] = useState("");

  const load = async () => { const r = await api("settings.get"); setS(r.settings); };
  useEffect(() => { load(); }, []);

  const set = async (key, value) => {
    await api("settings.set", { key, value });
    setS((p) => ({ ...p, [key]: value }));
    setMsg("Zapisano"); setTimeout(() => setMsg(""), 1500);
  };

  if (!s) return <span className="spin" />;

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
