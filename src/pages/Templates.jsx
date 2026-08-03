import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { SkelTable } from "../components/Skeleton.jsx";

// Wiadomości do klienta (e-mail + SMS z linkiem do kalendarza oddzwonień).
// Dopasowanie szablonu: nadpisanie w regule → wzorzec nazwy → domyślny.

const blank = () => ({
  name: "", enabled: true, is_default: false, match_patterns: [], priority: 100,
  send_email: true, send_sms: true, email_subject: "", email_body: "", sms_body: "",
});

const SMS_LIMIT_HINT = (len) => {
  const parts = len <= 160 ? 1 : Math.ceil(len / 153);
  return `${len} znaków ≈ ${parts} SMS${parts > 1 ? "-y" : ""} (polskie znaki mogą zwiększyć liczbę części)`;
};

export default function Templates() {
  const { user } = useAuth();
  const admin = user.role === "admin";
  const [rows, setRows] = useState(null);
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState("");

  const load = async () => { const r = await api("templates.list"); setRows(r.rows); };
  useEffect(() => { load(); }, []);

  const save = async () => {
    setErr("");
    try {
      const t = { ...edit, priority: Number(edit.priority) || 100, match_patterns: (edit.match_patterns || []).filter(Boolean) };
      await api("templates.upsert", { template: t });
      setEdit(null); load();
    } catch (e) { setErr(e.message); }
  };
  const del = async (id) => { if (confirm("Usunąć szablon?")) { await api("templates.delete", { id }); load(); } };

  return (
    <>
      <div className="topbar">
        <div><h1>Wiadomości do klienta</h1><div className="sub">Automatyczny e-mail i SMS z linkiem do kalendarza — zaraz po wpadnięciu leada</div></div>
        {admin && <button className="btn primary" onClick={() => setEdit(blank())}>+ Nowy szablon</button>}
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="small muted">
          Który szablon dostanie klient? 1) jeśli reguła w „Sortowaniu” wskazuje szablon — ten; 2) inaczej pierwszy szablon,
          którego <b>wzorzec</b> pasuje do nazwy kampanii/formularza (np. „heels”); 3) inaczej szablon <b>domyślny</b>.
          W treści działają: <b>{"{{link}}"}</b> — osobisty link do kalendarza, <b>{"{{imie}}"}</b> — imię klienta.
          Globalne włączniki wysyłek i test znajdziesz w „Ustawieniach”.
        </div>
      </div>

      {!rows && <SkelTable cols={6} rows={4} />}

      {rows && (
        <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
          <table className="tbl">
            <thead><tr><th>Szablon</th><th>Wzorce dopasowania</th><th>Kanały</th><th>Priorytet</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td><b>{t.name}</b> {t.is_default && <span className="badge pending">domyślny</span>}</td>
                  <td className="small muted">{(t.match_patterns || []).join(", ") || "—"}</td>
                  <td className="small">{[t.send_email && "e-mail", t.send_sms && "SMS"].filter(Boolean).join(" + ") || "—"}</td>
                  <td className="small">{t.priority}</td>
                  <td>{t.enabled ? <span className="badge done">aktywny</span> : <span className="badge skipped">wyłączony</span>}</td>
                  <td>
                    {admin && (
                      <div className="row" style={{ gap: 6 }}>
                        <button className="btn sm ghost" onClick={() => setEdit({ ...t, match_patterns: [...(t.match_patterns || [])] })}>Edytuj</button>
                        <button className="btn sm ghost" onClick={() => del(t.id)}>✕</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan="6" className="muted" style={{ textAlign: "center", padding: 30 }}>Brak szablonów</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {edit && (
        <div className="overlay" onClick={() => setEdit(null)}>
          <div className="panel modal" style={{ width: 680 }} onClick={(e) => e.stopPropagation()}>
            <div className="row between"><h3>{edit.id ? "Edytuj szablon" : "Nowy szablon"}</h3><button className="btn sm ghost" onClick={() => setEdit(null)}>✕</button></div>
            {err && <div className="err small" style={{ marginBottom: 12 }}>{err}</div>}

            <label className="fld"><span className="lbl">Nazwa</span>
              <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="np. Heels on the Track" /></label>

            <div className="row wrap" style={{ gap: 18, marginBottom: 14 }}>
              <label className="toggle"><input type="checkbox" checked={edit.enabled} onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })} /><span className="track" />Aktywny</label>
              <label className="toggle"><input type="checkbox" checked={edit.is_default} onChange={(e) => setEdit({ ...edit, is_default: e.target.checked })} /><span className="track" />Domyślny (gdy nic nie pasuje)</label>
              <label className="toggle"><input type="checkbox" checked={edit.send_email} onChange={(e) => setEdit({ ...edit, send_email: e.target.checked })} /><span className="track" />Wysyłaj e-mail</label>
              <label className="toggle"><input type="checkbox" checked={edit.send_sms} onChange={(e) => setEdit({ ...edit, send_sms: e.target.checked })} /><span className="track" />Wysyłaj SMS</label>
            </div>

            <div className="grid cols-2">
              <label className="fld"><span className="lbl">Wzorce dopasowania (po przecinku, fragment nazwy kampanii/formularza)</span>
                <input value={(edit.match_patterns || []).join(", ")} placeholder="np. heels, szpilki"
                  onChange={(e) => setEdit({ ...edit, match_patterns: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} /></label>
              <label className="fld"><span className="lbl">Priorytet (mniejszy = ważniejszy)</span>
                <input type="number" value={edit.priority} onChange={(e) => setEdit({ ...edit, priority: e.target.value })} /></label>
            </div>

            <label className="fld"><span className="lbl">Temat e-maila</span>
              <input value={edit.email_subject} onChange={(e) => setEdit({ ...edit, email_subject: e.target.value })} /></label>
            <label className="fld"><span className="lbl">Treść e-maila — {"{{link}}"} w osobnej linii zamieni się w czerwony przycisk</span>
              <textarea rows={8} value={edit.email_body} onChange={(e) => setEdit({ ...edit, email_body: e.target.value })} /></label>
            <label className="fld"><span className="lbl">Treść SMS</span>
              <textarea rows={4} value={edit.sms_body} onChange={(e) => setEdit({ ...edit, sms_body: e.target.value })} /></label>
            <div className="small muted" style={{ marginBottom: 14 }}>{SMS_LIMIT_HINT((edit.sms_body || "").replace(/\{\{\s*link\s*\}\}/g, "https://leads.fastlineracingacademy.pl/calendar?t=xxxxxxxxxxxxxxxxxxxxxxxx").length)}</div>

            <div className="row" style={{ gap: 10, justifyContent: "flex-end" }}>
              <button className="btn ghost" onClick={() => setEdit(null)}>Anuluj</button>
              <button className="btn primary" onClick={save}>Zapisz</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
