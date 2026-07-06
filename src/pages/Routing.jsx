import { useEffect, useState, useMemo } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";

const blank = () => ({
  name: "", matchType: "form", match_form_id: "", match_page_id: "", match_name_pattern: "",
  is_default: false, enabled: true, priority: 100,
  to_crm: true, to_email: false, email_recipients: [], pd_owner_id: null, pd_label_ids: [],
  pd_source_option_id: 26, pd_campaign_from_fb: true, pd_campaign_static: "",
});

// derive matchType for editing an existing rule
const typeOf = (r) => r.is_default ? "default" : r.match_form_id ? "form" : r.match_name_pattern ? "pattern" : r.match_page_id ? "page" : "form";

export default function Routing() {
  const { user } = useAuth();
  const admin = user.role === "admin";
  const [tab, setTab] = useState("campaigns");
  const [rules, setRules] = useState([]);
  const [meta, setMeta] = useState({ labels: [], owners: [] });
  const [pages, setPages] = useState([]);
  const [forms, setForms] = useState([]);
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [pageFilter, setPageFilter] = useState("");

  const load = async () => {
    const [r, m, p, f] = await Promise.all([
      api("rules.list"), api("pd.meta").catch(() => ({ labels: [], owners: [] })),
      api("fb.pages").catch(() => ({ rows: [] })), api("fb.forms").catch(() => ({ rows: [] })),
    ]);
    setRules(r.rows); setMeta(m); setPages(p.rows); setForms(f.rows);
  };
  useEffect(() => { load(); }, []);

  const pageName = (id) => pages.find((p) => p.page_id === id)?.name || id;
  const labelName = (id) => meta.labels.find((l) => String(l.id) === String(id))?.name || id;
  const ownerName = (id) => meta.owners.find((o) => String(o.id) === String(id))?.name || id;

  // effective rule for a given form (mirrors backend precedence)
  const effRule = (form) => {
    const hay = `${form.name || ""} ${form.form_id}`.toLowerCase();
    return rules.filter((r) => r.enabled).sort((a, b) => a.priority - b.priority).find((r) => r.match_form_id === form.form_id)
      || rules.filter((r) => r.enabled).sort((a, b) => a.priority - b.priority).find((r) => r.match_name_pattern && hay.includes(String(r.match_name_pattern).toLowerCase()))
      || rules.filter((r) => r.enabled).sort((a, b) => a.priority - b.priority).find((r) => !r.match_form_id && !r.match_name_pattern && r.match_page_id === form.page_id)
      || rules.find((r) => r.is_default) || null;
  };
  const destText = (r) => r ? ([r.to_crm && "Pipedrive", r.to_email && "e-mail"].filter(Boolean).join(" + ") || "—") : "—";

  const filteredForms = useMemo(() => {
    let f = forms;
    if (pageFilter) f = f.filter((x) => x.page_id === pageFilter);
    if (q) f = f.filter((x) => (x.name || "").toLowerCase().includes(q.toLowerCase()));
    return [...f].sort((a, b) => (a.status === "ACTIVE" ? -1 : 1) - (b.status === "ACTIVE" ? -1 : 1) || (b.leads_count || 0) - (a.leads_count || 0));
  }, [forms, q, pageFilter]);

  const openForForm = (form) => {
    const existing = rules.find((r) => r.match_form_id === form.form_id);
    if (existing) setEdit({ ...existing, matchType: typeOf(existing) });
    else setEdit({ ...blank(), matchType: "form", match_form_id: form.form_id, match_page_id: form.page_id, name: form.name || form.form_id });
  };

  const save = async () => {
    setErr("");
    try {
      const e = { ...edit };
      const rule = {
        id: e.id, name: e.name, is_default: e.is_default, enabled: e.enabled,
        priority: Number(e.priority) || 100, to_crm: e.to_crm, to_email: e.to_email,
        email_recipients: e.email_recipients, pd_owner_id: e.pd_owner_id ? Number(e.pd_owner_id) : null,
        pd_label_ids: e.pd_label_ids, pd_source_option_id: Number(e.pd_source_option_id) || 26,
        pd_campaign_from_fb: e.pd_campaign_from_fb, pd_campaign_static: e.pd_campaign_static,
        match_form_id: null, match_page_id: null, match_name_pattern: null,
      };
      if (!e.is_default) {
        if (e.matchType === "form") rule.match_form_id = e.match_form_id || null;
        if (e.matchType === "pattern") rule.match_name_pattern = e.match_name_pattern || null;
        if (e.matchType === "page") rule.match_page_id = e.match_page_id || null;
      }
      await api("rules.upsert", { rule });
      setEdit(null); load();
    } catch (e) { setErr(e.message); }
  };
  const del = async (id) => { if (confirm("Usunąć regułę?")) { await api("rules.delete", { id }); load(); } };

  return (
    <>
      <div className="topbar">
        <div><h1>Sortowanie leadów</h1><div className="sub">Domyślnie każdy lead trafia do Pipedrive. Poniżej ustawisz wyjątki per kampania.</div></div>
        {admin && <button className="btn primary" onClick={() => setEdit(blank())}>+ Nowa reguła</button>}
      </div>

      <div className="row" style={{ gap: 10, marginBottom: 16 }}>
        <button className={"btn sm" + (tab === "campaigns" ? " primary" : "")} onClick={() => setTab("campaigns")}>Kampanie ({forms.length})</button>
        <button className={"btn sm" + (tab === "rules" ? " primary" : "")} onClick={() => setTab("rules")}>Reguły ({rules.length})</button>
      </div>

      {tab === "campaigns" && (
        <>
          <div className="panel" style={{ marginBottom: 14 }}>
            <div className="row wrap" style={{ gap: 10 }}>
              <select value={pageFilter} onChange={(e) => setPageFilter(e.target.value)} style={{ maxWidth: 240 }}>
                <option value="">Wszystkie strony</option>
                {pages.map((p) => <option key={p.page_id} value={p.page_id}>{p.name}</option>)}
              </select>
              <input placeholder="Szukaj kampanii / formularza…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
            </div>
          </div>
          <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
            <table className="tbl">
              <thead><tr><th>Kampania / formularz</th><th>Strona</th><th>Status</th><th>Leady</th><th>Trasa</th><th></th></tr></thead>
              <tbody>
                {filteredForms.slice(0, 200).map((f) => {
                  const r = effRule(f);
                  const custom = r && (r.match_form_id === f.form_id);
                  return (
                    <tr key={f.form_id}>
                      <td><b>{f.name || f.form_id}</b></td>
                      <td className="small muted">{pageName(f.page_id)}</td>
                      <td><span className={"badge " + (f.status === "ACTIVE" ? "done" : "skipped")}>{f.status || "—"}</span></td>
                      <td className="small">{f.leads_count ?? 0}</td>
                      <td className="small">{destText(r)} {!custom && <span className="muted">(domyślnie)</span>}</td>
                      <td>{admin && <button className="btn sm" onClick={() => openForForm(f)}>Ustaw trasę</button>}</td>
                    </tr>
                  );
                })}
                {filteredForms.length === 0 && <tr><td colSpan="6" className="muted" style={{ textAlign: "center", padding: 26 }}>Brak formularzy — zsynchronizuj w zakładce Facebook</td></tr>}
              </tbody>
            </table>
          </div>
          {filteredForms.length > 200 && <div className="muted small" style={{ marginTop: 8 }}>Pokazano 200 z {filteredForms.length}. Zawęź wyszukiwaniem.</div>}
        </>
      )}

      {tab === "rules" && (
        <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
          <table className="tbl">
            <thead><tr><th>Nazwa</th><th>Dopasowanie</th><th>Właściciel</th><th>Etykiety</th><th>Trasa</th><th>Prio</th><th></th></tr></thead>
            <tbody>
              {rules.sort((a, b) => a.priority - b.priority).map((r) => (
                <tr key={r.id} style={{ opacity: r.enabled ? 1 : 0.5 }}>
                  <td><b>{r.name}</b>{r.is_default && <span className="badge skipped" style={{ marginLeft: 6 }}>domyślna</span>}</td>
                  <td className="small">{r.is_default ? "wszystkie" : r.match_form_id ? "formularz" : r.match_name_pattern ? `nazwa ~ „${r.match_name_pattern}”` : r.match_page_id ? `strona ${pageName(r.match_page_id)}` : "—"}</td>
                  <td className="small">{r.pd_owner_id ? ownerName(r.pd_owner_id) : "—"}</td>
                  <td className="small">{(r.pd_label_ids || []).map(labelName).join(", ") || "—"}</td>
                  <td className="small">{destText(r)}</td>
                  <td className="small">{r.priority}</td>
                  <td>{admin && <div className="row" style={{ gap: 6 }}><button className="btn sm ghost" onClick={() => setEdit({ ...r, matchType: typeOf(r) })}>Edytuj</button>{!r.is_default && <button className="btn sm ghost" onClick={() => del(r.id)}>🗑</button>}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {edit && (
        <div className="overlay" onClick={() => setEdit(null)}>
          <div className="panel modal" onClick={(e) => e.stopPropagation()}>
            <div className="row between"><h3>{edit.id ? "Edytuj regułę" : "Nowa reguła"}</h3><button className="btn sm ghost" onClick={() => setEdit(null)}>✕</button></div>
            {err && <div className="err" style={{ marginBottom: 12 }}>{err}</div>}

            <label className="fld"><span className="lbl">Nazwa reguły</span>
              <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>

            {!edit.is_default && (
              <>
                <label className="fld"><span className="lbl">Dopasuj po</span>
                  <select value={edit.matchType} onChange={(e) => setEdit({ ...edit, matchType: e.target.value })}>
                    <option value="form">Konkretny formularz</option>
                    <option value="pattern">Wzorzec nazwy (np. „eventy”, „firmowe”)</option>
                    <option value="page">Cała strona</option>
                  </select></label>
                {edit.matchType === "form" && (
                  <label className="fld"><span className="lbl">Formularz</span>
                    <select value={edit.match_form_id || ""} onChange={(e) => setEdit({ ...edit, match_form_id: e.target.value })}>
                      <option value="">— wybierz —</option>
                      {forms.map((f) => <option key={f.form_id} value={f.form_id}>{f.name || f.form_id}</option>)}
                    </select></label>
                )}
                {edit.matchType === "pattern" && (
                  <label className="fld"><span className="lbl">Wzorzec w nazwie kampanii/formularza</span>
                    <input placeholder="np. eventy" value={edit.match_name_pattern || ""} onChange={(e) => setEdit({ ...edit, match_name_pattern: e.target.value })} /></label>
                )}
                {edit.matchType === "page" && (
                  <label className="fld"><span className="lbl">Strona</span>
                    <select value={edit.match_page_id || ""} onChange={(e) => setEdit({ ...edit, match_page_id: e.target.value })}>
                      <option value="">— wybierz —</option>
                      {pages.map((p) => <option key={p.page_id} value={p.page_id}>{p.name}</option>)}
                    </select></label>
                )}
              </>
            )}

            <div className="row wrap" style={{ gap: 20, margin: "6px 0 14px" }}>
              <label className="toggle"><input type="checkbox" checked={edit.enabled} onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })} /><span className="track" />Aktywna</label>
              <label className="toggle"><input type="checkbox" checked={edit.to_crm} onChange={(e) => setEdit({ ...edit, to_crm: e.target.checked })} /><span className="track" />Pipedrive</label>
              <label className="toggle"><input type="checkbox" checked={edit.to_email} onChange={(e) => setEdit({ ...edit, to_email: e.target.checked })} /><span className="track" />E-mail</label>
            </div>

            {edit.to_email && (
              <label className="fld"><span className="lbl">Adresy e-mail (oddziel przecinkiem)</span>
                <input value={(edit.email_recipients || []).join(", ")} onChange={(e) => setEdit({ ...edit, email_recipients: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} /></label>
            )}

            {edit.to_crm && (
              <div className="grid cols-2">
                <label className="fld"><span className="lbl">Właściciel w Pipedrive</span>
                  <select value={edit.pd_owner_id || ""} onChange={(e) => setEdit({ ...edit, pd_owner_id: e.target.value })}>
                    <option value="">— domyślny (Łukasz) —</option>
                    {meta.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select></label>
                <label className="fld"><span className="lbl">Etykieta lead</span>
                  <select value={(edit.pd_label_ids || [])[0] || ""} onChange={(e) => setEdit({ ...edit, pd_label_ids: e.target.value ? [e.target.value] : [] })}>
                    <option value="">— brak —</option>
                    {meta.labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select></label>
              </div>
            )}

            <label className="fld"><span className="lbl">Priorytet (niższy = ważniejszy)</span>
              <input type="number" value={edit.priority} onChange={(e) => setEdit({ ...edit, priority: e.target.value })} /></label>

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
