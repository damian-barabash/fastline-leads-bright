import { useEffect, useState } from "react";
import { api } from "../../api.js";
import { IconExternal } from "../../components/Icons.jsx";
import { RangeBar, fmtDateTime, fmtPhone, timeAgo, pdLeadUrl, REASON_LABEL } from "./shared.jsx";

// Do oddzwonienia — nieodebrane przychodzące, po których nikt nie oddzwonił
// i klient nie dodzwonił się ponownie (jeden wiersz na numer, ostatnia próba).

export default function Missed({ range, setRange, onOpen }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    setRows(null); setErr("");
    api("rs.missed", { from: range.from, to: range.to })
      .then((r) => alive && setRows(r.rows))
      .catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [range.from, range.to]);

  return (
    <>
      <RangeBar range={range} setRange={setRange} />
      {err && <div className="err" style={{ marginBottom: 16 }}>{err}</div>}
      <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "18px 20px 6px" }}>
          <h3 style={{ marginBottom: 4 }}>Klienci, do których nikt nie oddzwonił {rows ? `(${rows.length})` : ""}</h3>
          <div className="small muted" style={{ marginBottom: 10 }}>
            Numer znika z listy automatycznie, gdy ktoś zadzwoni do klienta albo klient dodzwoni się ponownie (synchronizacja co 5 min).
          </div>
        </div>
        <table className="tbl">
          <thead><tr><th>Ostatnia próba</th><th>Klient</th><th>Lead FB</th><th>Prób</th><th>Powód</th><th>Linia</th><th></th></tr></thead>
          <tbody>
            {(rows ?? []).map((r) => {
              const pd = pdLeadUrl(r.lead);
              return (
                <tr key={r.uniqueid} className="clickable" onClick={() => onOpen(r.uniqueid)}>
                  <td className="nowrap"><b>{timeAgo(r.calldate)}</b><div className="small muted">{fmtDateTime(r.calldate)}</div></td>
                  <td className="nowrap"><a className="link" href={`tel:+${r.client_phone}`} onClick={(e) => e.stopPropagation()}>{fmtPhone(r.client_phone)}</a></td>
                  <td className="small">{r.lead ? <><b>{r.lead.full_name}</b><div className="muted ellipsis" style={{ maxWidth: 240 }}>{r.lead.campaign_name}</div></> : <span className="muted">—</span>}</td>
                  <td>{r.attempts > 1 ? <span className="badge pending">{r.attempts}×</span> : r.attempts}</td>
                  <td className="small">{REASON_LABEL[r.missing_reason] ?? r.missing_reason ?? <span className="muted">—</span>}</td>
                  <td className="small muted">{r.scheme_name || "—"}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {pd && <a className="btn sm ghost" href={pd} target="_blank" rel="noreferrer">Pipedrive <IconExternal /></a>}
                  </td>
                </tr>
              );
            })}
            {rows === null && !err && Array.from({ length: 5 }).map((_, i) => (
              <tr key={i}>{Array.from({ length: 7 }).map((_, c) => <td key={c}><div className="skel skel-line" style={{ width: "60%" }} /></td>)}</tr>
            ))}
            {rows && rows.length === 0 && <tr><td colSpan="7" className="muted" style={{ textAlign: "center", padding: 30 }}>Wszyscy klienci obsłużeni — nie ma do kogo oddzwaniać.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
