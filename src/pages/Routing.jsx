import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";

const blank = () => ({
  name: "", match_page_id: "", match_form_id: "", is_default: false, enabled: true, priority: 100,
  to_crm: true, to_email: false, email_recipients: [], pd_owner_id: null, pd_label_ids: [],
  pd_source_option_id: 26, pd_campaign_from_fb: true, pd_campaign_static: "",
});

export default function Routing() {
  const { user } = useAuth();
  const admin = user.role === "admin";
  const [rules, setRules] = useState([]);
  const [meta, setMeta] = useState({ labels: [], owners: [] });
  const [pages, setPages] = useState([]);
  const [forms, setForms] = useState([]);
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState("");

  const load = async () => {
    const [r, m, p, f] = await Promise.all([
      api("rules.list"), api("pd.meta").catch(() => ({ labels: [], owners: [] })),
      api("fb.pages").catch(() => ({ rows: [] })), api("fb.forms").catch(() => ({ rows: [] })),
    ]);
    setRules(r.rows); setMeta(m); setPages(p.rows); setForms(f.rows);
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    setErr("");
    try {
      const rule = { ...edit };
      rule.priority = Number(rule.priority) || 100;
      rule.pd_owner_id = rule.pd_owner_id ? Number(rule.pd_owner_id) : null;
      rule.pd_source_option_id = Number(rule.pd_source_option_id) || 26;
      if (!rule.match_form_id) rule.match_form_id = null;
      if (!rule.match_page_id) rule.match_page_id = null;
      await api("rules.upsert", { rule });
      setEdit(null); load();
    } catch (e) { setErr(e.message); }
  };
  const del = async (id) => { if (confirm("Usunąć regułę?")) { await api("rules.delete", { id }); load(); } };

  const labelName = (id) => meta.labels.find((l) => String(l.id) === String(id))?.name || id;
  const ownerName = (id) => meta.owners.find((o) => String(o.id) === String(id))?.name || id;
  const formName = (id) => forms.find((f) => f.form_id === id)?.name || id;

  return (
    <>
      <div className="topbar">
        <div><h1>Sortowanie leadów</h1><div className="sub">Reguły: który formularz → jaka etykieta, właściciel i dokąd trafia (CRM / e-mail)</div></div>
        {admin && <button className="btn primary" onClick={() => setEdit(blank())}>+ Nowa reguła</button>}
      </div>

      <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
        <table className="tbl">
          <thead><tr>
            <th>Nazwa</th><th>Dopasowanie</th><th>Właściciel</th><th>Etykiety</th><th>Cel</th><th>Prio</th><th></th>
          </tr></thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} style={{ opacity: r.enabled ? 1 : 0.5 }}>
                <td><b>{r.name}</b>{r.is_default && <span className="badge skipped" style={{ marginLeft: 6 }}>domyślna</span>}</td>
                <td className="small">{r.match_form_id ? `Formularz: ${formName(r.match_form_id)}` : r.match_page_id ? `Strona: ${r.match_page_id}` : "wszystkie"}</td>
                <td className="small">{r.pd_owner_id ? ownerName(r.pd_owner_id) : "—"}</td>
                <td className="small">{(r.pd_label_ids || []).map(labelName).join(", ") || "—"}</td>
                <td className="small">{[r.to_crm && "CRM", r.to_email && "e-mail"].filter(Boolean).join(" + ") || "—"}</td>
                <td className="small">{r.priority}</td>
                <td>{admin && <div className="row" style={{ gap: 6 }}><button className="btn sm ghost" onClick={() => setEdit(r)}>Edytuj</button>{!r.is_default && <button className="btn sm ghost" onClick={() => del(r.id)}>🗑</button>}</div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {edit && (
        <div className="overlay" onClick={() => setEdit(null)}>
          <div className="panel modal" onClick={(e) => e.stopPropagation()}>
            <div className="row between"><h3>{edit.id ? "Edytuj regułę" : "Nowa reguła"}</h3><button className="btn sm ghost" onClick={() => setEdit(null)}>✕</button></div>
            {err && <div className="err" style={{ marginBottom: 12 }}>{err}</div>}

            <label className="fld"><span className="lbl">Nazwa reguły</span>
              <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>

            {!edit.is_default && (
              <div className="grid cols-2">
                <label className="fld"><span className="lbl">Strona (opcjonalnie)</span>
                  <select value={edit.match_page_id || ""} onChange={(e) => setEdit({ ...edit, match_page_id: e.target.value })}>
                    <option value="">— dowolna —</option>
                    {pages.map((p) => <option key={p.page_id} value={p.page_id}>{p.name}</option>)}
                  </select></label>
                <label className="fld"><span className="lbl">Formularz (najwyższy priorytet)</span>
                  <select value={edit.match_form_id || ""} onChange={(e) => setEdit({ ...edit, match_form_id: e.target.value })}>
                    <option value="">— dowolny —</option>
                    {forms.filter((f) => !edit.match_page_id || f.page_id === edit.match_page_id).map((f) => <option key={f.form_id} value={f.form_id}>{f.name}</option>)}
                  </select></label>
              </div>
            )}

            <div className="grid cols-2">
              <label className="fld"><span className="lbl">Właściciel w Pipedrive</span>
                <select value={edit.pd_owner_id || ""} onChange={(e) => setEdit({ ...edit, pd_owner_id: e.target.value })}>
                  <option value="">— domyślny (Łukasz) —</option>
                  {meta.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select></label>
              <label className="fld"><span className="lbl">Priorytet (niższy = ważniejszy)</span>
                <input type="number" value={edit.priority} onChange={(e) => setEdit({ ...edit, priority: e.target.value })} /></label>
            </div>

            <label className="fld"><span className="lbl">Etykieta lead (Pipedrive)</span>
              <select value={(edit.pd_label_ids || [])[0] || ""} onChange={(e) => setEdit({ ...edit, pd_label_ids: e.target.value ? [e.target.value] : [] })}>
                <option value="">— brak —</option>
                {meta.labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select></label>

            <div className="row wrap" style={{ gap: 20, margin: "6px 0 14px" }}>
              <label className="toggle"><input type="checkbox" checked={edit.enabled} onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })} /><span className="track" />Aktywna</label>
              <label className="toggle"><input type="checkbox" checked={edit.to_crm} onChange={(e) => setEdit({ ...edit, to_crm: e.target.checked })} /><span className="track" />Wysyłaj do CRM</label>
              <label className="toggle"><input type="checkbox" checked={edit.to_email} onChange={(e) => setEdit({ ...edit, to_email: e.target.checked })} /><span className="track" />Wysyłaj e-mail</label>
              <label className="toggle"><input type="checkbox" checked={edit.pd_campaign_from_fb} onChange={(e) => setEdit({ ...edit, pd_campaign_from_fb: e.target.checked })} /><span className="track" />Nazwa kampanii z FB</label>
            </div>

            {edit.to_email && (
              <label className="fld"><span className="lbl">Odbiorcy e-mail (oddziel przecinkiem)</span>
                <input value={(edit.email_recipients || []).join(", ")} onChange={(e) => setEdit({ ...edit, email_recipients: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} /></label>
            )}

            <div className="row" style={{ justifyContent: "flex-end", gap: 10, marginTop: 8 }}>
              <button className="btn ghost" onClick={() => setEdit(null)}>Anuluj</button>
              <button className="btn primary" onClick={save}>Zapisz</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
