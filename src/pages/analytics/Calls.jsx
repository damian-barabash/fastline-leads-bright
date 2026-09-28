import { useCallback, useEffect, useState } from "react";
import { api } from "../../api.js";
import { IconPlay, IconSpark, IconDownload } from "../../components/Icons.jsx";
import {
  RangeBar, Direction, StatusBadge, fmtDateTime, fmtDur, fmtPhone, TYPE_LABEL, DISPOSITION_LABEL, REASON_LABEL,
  downloadCsv,
} from "./shared.jsx";

// Rozmowy — pełny dziennik połączeń z filtrami, odsłuchem i eksportem CSV.

const LIMIT = 50;
const TYPES = [["", "Wszystkie"], ["in", "Przychodzące"], ["out", "Wychodzące"], ["callback", "Callback"]];
const STATUSES = [["", "Każdy status"], ["answered", "Odebrane"], ["missed", "Nieodebrane"]];

const CSV_COLS = [
  { label: "Data", get: (r) => fmtDateTime(r.calldate) },
  { label: "Kierunek", get: (r) => TYPE_LABEL[r.call_type] ?? r.call_type },
  { label: "Status", get: (r) => DISPOSITION_LABEL[r.disposition] ?? r.disposition },
  { label: "Klient", get: (r) => r.client_phone },
  { label: "Lead", get: (r) => r.lead?.full_name ?? "" },
  { label: "Kampania", get: (r) => r.lead?.campaign_name ?? "" },
  { label: "Pracownik", get: (r) => r.employee_fio ?? "" },
  { label: "Rozmowa (s)", get: (r) => r.billsec },
  { label: "Oczekiwanie (s)", get: (r) => r.waittime },
  { label: "Powód nieodebrania", get: (r) => REASON_LABEL[r.missing_reason] ?? r.missing_reason ?? "" },
  { label: "Źródło", get: (r) => r.utm_source || r.pool_name || "" },
  { label: "AI: tytuł", get: (r) => r.ai_title ?? "" },
  { label: "AI: podsumowanie", get: (r) => r.ai_summary ?? "" },
  { label: "AI: ocena", get: (r) => r.ai_score ?? "" },
  { label: "Nagranie", get: (r) => r.recording ?? "" },
  { label: "Karta Ringostat", get: (r) => r.call_card ?? "" },
];

export default function Calls({ range, setRange, employee, setEmployee, employees, preset, onOpen }) {
  const [f, setF] = useState({ type: "", status: "", onlyAi: false, onlyLead: false, onlyRecording: false, minSec: "", ...(preset || {}) });
  const [q, setQ] = useState("");
  const [qApplied, setQApplied] = useState("");
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [playing, setPlaying] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => { if (preset) { setF((x) => ({ ...x, ...preset })); setOffset(0); } }, [preset]);

  const params = useCallback(() => ({
    from: range.from, to: range.to, employee: employee || null, q: qApplied,
    type: f.type, status: f.status, onlyAi: f.onlyAi, onlyLead: f.onlyLead, onlyRecording: f.onlyRecording,
    minSec: f.minSec ? Number(f.minSec) : null,
  }), [range.from, range.to, employee, qApplied, f]);

  useEffect(() => {
    let alive = true;
    setBusy(true); setErr("");
    api("rs.calls", { ...params(), offset, limit: LIMIT })
      .then((r) => { if (alive) { setRows(r.rows); setTotal(r.total); } })
      .catch((e) => alive && setErr(e.message))
      .finally(() => alive && setBusy(false));
    return () => { alive = false; };
  }, [params, offset]);

  const set = (patch) => { setF((x) => ({ ...x, ...patch })); setOffset(0); };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const all = [];
      for (let off = 0; off < Math.min(total, 10000); off += 500) {
        const r = await api("rs.calls", { ...params(), offset: off, limit: 500 });
        all.push(...r.rows);
        if (r.rows.length < 500) break;
      }
      downloadCsv(`ringostat_rozmowy_${range.from}_${range.to}.csv`, all, CSV_COLS);
    } catch (e) { setErr(e.message); } finally { setExporting(false); }
  };

  return (
    <>
      <RangeBar range={range} setRange={(r) => { setRange(r); setOffset(0); }} employees={employees} employee={employee}
        setEmployee={(v) => { setEmployee(v); setOffset(0); }} />

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="row wrap" style={{ gap: 10 }}>
          <select value={f.type} onChange={(e) => set({ type: e.target.value })} style={{ width: 160, padding: "7px 10px" }}>
            {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select value={f.status} onChange={(e) => set({ status: e.target.value })} style={{ width: 160, padding: "7px 10px" }}>
            {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select value={f.minSec} onChange={(e) => set({ minSec: e.target.value })} style={{ width: 170, padding: "7px 10px" }}>
            <option value="">Dowolna długość</option>
            <option value="30">≥ 30 s</option>
            <option value="60">≥ 1 min</option>
            <option value="180">≥ 3 min</option>
            <option value="600">≥ 10 min</option>
          </select>
          {[["onlyRecording", "z nagraniem"], ["onlyLead", "z leadem FB"], ["onlyAi", "z analizą AI"]].map(([k, l]) => (
            <label key={k} className="chk"><input type="checkbox" checked={!!f[k]} onChange={(e) => set({ [k]: e.target.checked })} /> {l}</label>
          ))}
          <div style={{ flex: 1 }} />
          <input placeholder="Numer telefonu lub tekst z AI…" value={q} style={{ maxWidth: 250, padding: "7px 10px" }}
            onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { setQApplied(q.trim()); setOffset(0); } }}
            onBlur={() => { if (q.trim() !== qApplied) { setQApplied(q.trim()); setOffset(0); } }} />
          <button className="btn sm" onClick={exportCsv} disabled={exporting || !total} title="Eksport wszystkich rozmów z filtra">
            {exporting ? <span className="spin" /> : <IconDownload size={13} />} CSV
          </button>
        </div>
      </div>

      {err && <div className="err" style={{ marginBottom: 16 }}>{err}</div>}

      <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
        <table className="tbl">
          <thead><tr>
            <th></th><th>Data</th><th>Klient</th><th>Pracownik</th><th>Status</th><th>Rozmowa</th><th>Wynik rozmowy (AI)</th><th></th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.uniqueid} className="clickable" onClick={() => onOpen(r.uniqueid)}>
                <td style={{ width: 28 }}><Direction type={r.call_type} /></td>
                <td className="small muted nowrap">{fmtDateTime(r.calldate)}</td>
                <td>
                  <b className="nowrap">{r.lead?.full_name || fmtPhone(r.client_phone)}</b>
                  <div className="small muted ellipsis" style={{ maxWidth: 230 }}>
                    {r.lead ? `${fmtPhone(r.client_phone)} · ${r.lead.campaign_name || ""}` : (r.utm_source || r.pool_name || "")}
                  </div>
                </td>
                <td className="small">{r.employee_fio || <span className="muted">—</span>}</td>
                <td>
                  <StatusBadge c={r} />
                  {r.missing_reason && <div className="small muted" style={{ marginTop: 3 }}>{REASON_LABEL[r.missing_reason] ?? r.missing_reason}</div>}
                </td>
                <td className="nowrap">{r.answered ? fmtDur(r.billsec) : <span className="muted">—</span>}
                  {r.waittime ? <div className="small muted">czekał {r.waittime} s</div> : null}</td>
                <td className="small" style={{ maxWidth: 340 }}>
                  {r.ai_at ? (
                    <div className="row" style={{ gap: 6, alignItems: "flex-start" }}>
                      <span className="ai-dot"><IconSpark size={12} /></span>
                      <span className="clamp2">{r.ai_title ? <b>{r.ai_title}. </b> : null}{r.ai_summary}</span>
                      {r.ai_score !== null && <span className="score-pill sm">{r.ai_score}</span>}
                    </div>
                  ) : <span className="muted">—</span>}
                </td>
                <td onClick={(e) => e.stopPropagation()} style={{ width: 44 }}>
                  {r.recording && (
                    <button className={"btn sm ghost icon" + (playing === r.uniqueid ? " active" : "")} title="Odsłuchaj"
                      onClick={() => setPlaying(playing === r.uniqueid ? null : r.uniqueid)}><IconPlay size={12} /></button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && busy && Array.from({ length: 8 }).map((_, i) => (
              <tr key={"s" + i}>{Array.from({ length: 8 }).map((_, c) => <td key={c}><div className="skel skel-line" style={{ width: c === 0 ? 16 : "60%" }} /></td>)}</tr>
            ))}
            {rows.length === 0 && !busy && <tr><td colSpan="8" className="muted" style={{ textAlign: "center", padding: 30 }}>Brak rozmów dla wybranych filtrów</td></tr>}
          </tbody>
        </table>
      </div>

      {playing && (() => {
        const r = rows.find((x) => x.uniqueid === playing);
        return r ? (
          <div className="mini-player panel">
            <div className="row between" style={{ marginBottom: 8 }}>
              <span className="small"><b>{r.lead?.full_name || fmtPhone(r.client_phone)}</b> · {fmtDateTime(r.calldate)} · {r.employee_fio || ""}</span>
              <button className="btn sm ghost" onClick={() => setPlaying(null)}>✕</button>
            </div>
            <audio key={r.uniqueid} controls autoPlay src={r.recording} style={{ width: "100%" }} />
          </div>
        ) : null;
      })()}

      <div className="row between" style={{ marginTop: 14 }}>
        <span className="muted small">{busy ? <span className="spin" /> : `${total} rozmów`}</span>
        <div className="row" style={{ gap: 8 }}>
          <span className="small muted">{total ? `${offset + 1}–${Math.min(offset + LIMIT, total)}` : ""}</span>
          <button className="btn sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>← Poprzednie</button>
          <button className="btn sm" disabled={offset + LIMIT >= total} onClick={() => setOffset(offset + LIMIT)}>Następne →</button>
        </div>
      </div>
    </>
  );
}
