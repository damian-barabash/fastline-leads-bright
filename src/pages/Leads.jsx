import { useEffect, useState, useCallback } from "react";
import { api } from "../api.js";

const STATUSES = ["all", "done", "pending", "failed", "skipped"];
const fmt = (t) => (t ? new Date(t).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");

function Badge({ v }) { return <span className={"badge " + v}>{v}</span>; }

export default function Leads() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState("all");
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);
  const LIMIT = 50;

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await api("leads.list", { status, q, offset, limit: LIMIT });
      setRows(r.rows); setTotal(r.total);
    } finally { setBusy(false); }
  }, [status, q, offset]);

  useEffect(() => { load(); }, [load]);

  const reprocess = async (id) => {
    await api("lead.reprocess", { id });
    load();
  };

  return (
    <>
      <div className="topbar">
        <div><h1>Leady</h1><div className="sub">Wszystkie leady i status wysyłki do CRM / e-mail</div></div>
        <button className="btn sm" onClick={load}>{busy ? <span className="spin" /> : "Odśwież"}</button>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="row wrap" style={{ gap: 10 }}>
          {STATUSES.map((s) => (
            <button key={s} className={"btn sm" + (status === s ? " primary" : "")} onClick={() => { setStatus(s); setOffset(0); }}>{s}</button>
          ))}
          <div style={{ flex: 1 }} />
          <input placeholder="Szukaj: imię, e-mail, kampania…" value={q} style={{ maxWidth: 280 }}
            onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (setOffset(0), load())} />
        </div>
      </div>

      <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
        <table className="tbl">
          <thead><tr>
            <th>Data</th><th>Imię i nazwisko</th><th>Kontakt</th><th>Kampania</th>
            <th>CRM</th><th>E-mail</th><th>Status</th><th></th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="small muted">{fmt(r.received_at)}</td>
                <td><b>{r.full_name || "—"}</b></td>
                <td className="small">{r.email || "—"}<br /><span className="muted">{r.phone || ""}</span></td>
                <td className="small">{r.campaign_name || "—"}</td>
                <td><Badge v={r.crm_status} /></td>
                <td><Badge v={r.email_status} /></td>
                <td><Badge v={r.status} /></td>
                <td>
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn sm ghost" onClick={() => setOpen(r)}>Szczegóły</button>
                    {(r.status === "failed" || r.status === "pending") && <button className="btn sm" onClick={() => reprocess(r.id)}>↻</button>}
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && busy && Array.from({ length: 6 }).map((_, i) => (
              <tr key={"s" + i}>{Array.from({ length: 8 }).map((_, c) => <td key={c}><div className="skel skel-line" style={{ width: c === 0 ? "70%" : "50%" }} /></td>)}</tr>
            ))}
            {rows.length === 0 && !busy && <tr><td colSpan="8" className="muted" style={{ textAlign: "center", padding: 30 }}>Brak leadów</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="row between" style={{ marginTop: 14 }}>
        <span className="muted small">{total} leadów</span>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>← Poprzednie</button>
          <button className="btn sm" disabled={offset + LIMIT >= total} onClick={() => setOffset(offset + LIMIT)}>Następne →</button>
        </div>
      </div>

      {open && (
        <div className="overlay" onClick={() => setOpen(null)}>
          <div className="panel modal" onClick={(e) => e.stopPropagation()}>
            <div className="row between"><h3>{open.full_name || "Lead"}</h3><button className="btn sm ghost" onClick={() => setOpen(null)}>✕</button></div>
            <div className="grid cols-2" style={{ gap: 8, marginBottom: 14 }}>
              <div className="small"><span className="muted">E-mail:</span> {open.email || "—"}</div>
              <div className="small"><span className="muted">Telefon:</span> {open.phone || "—"}</div>
              <div className="small"><span className="muted">Kampania:</span> {open.campaign_name || "—"}</div>
              <div className="small"><span className="muted">Formularz:</span> {open.form_id || "—"}</div>
              <div className="small"><span className="muted">Pipedrive lead:</span> {open.pipedrive_lead_id || "—"}</div>
              <div className="small"><span className="muted">Status:</span> <Badge v={open.status} /></div>
            </div>
            {open.last_error && <div className="err small" style={{ marginBottom: 12 }}>{open.last_error}</div>}
            <h3>Odpowiedzi z formularza</h3>
            <table className="tbl">
              <tbody>
                {Object.entries(open.field_data || {}).map(([k, v]) => (
                  <tr key={k}><td className="muted small">{k}</td><td className="small"><b>{String(v)}</b></td></tr>
                ))}
                {!open.field_data && <tr><td className="muted small">Dane pojawią się po przetworzeniu</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
