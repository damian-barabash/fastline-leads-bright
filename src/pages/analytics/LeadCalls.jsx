import { useEffect, useState } from "react";
import { api } from "../../api.js";
import { IconSpark } from "../../components/Icons.jsx";
import CallModal from "./CallModal.jsx";
import { Direction, fmtDateTime, fmtDur } from "./shared.jsx";

// Rozmowy Ringostat z danym leadem (po numerze telefonu) — w szczegółach leada.
export default function LeadCalls({ leadId }) {
  const [rows, setRows] = useState(null);
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    setRows(null);
    api("rs.leadCalls", { lead_id: leadId }).then((r) => setRows(r.rows)).catch(() => setRows([]));
  }, [leadId]);

  if (rows === null) return <div className="small muted" style={{ marginBottom: 12 }}><span className="spin" /></div>;
  const talk = rows.reduce((a, r) => a + (r.answered ? r.billsec : 0), 0);
  return (
    <div style={{ marginBottom: 14 }}>
      <h3>Rozmowy telefoniczne ({rows.length}){rows.length ? <span className="small muted"> · łącznie {fmtDur(talk)}</span> : null}</h3>
      {rows.length === 0 && <div className="small muted">Brak rozmów z tym numerem w Ringostat.</div>}
      <div className="history">
        {rows.map((r) => (
          <div key={r.uniqueid} className="hist-row" onClick={() => setOpenId(r.uniqueid)}>
            <Direction type={r.call_type} />
            <span className="small nowrap">{fmtDateTime(r.calldate)}</span>
            <span className="small muted ellipsis" style={{ flex: 1 }}>
              {r.ai_at ? <><IconSpark size={11} /> {r.ai_title || r.ai_summary}</> : (r.employee_fio || "—")}
            </span>
            <span className="small nowrap">{r.answered ? fmtDur(r.billsec) : <span className="muted">nieodebrana</span>}</span>
          </div>
        ))}
      </div>
      {openId && <CallModal id={openId} onClose={() => setOpenId(null)} onOpen={setOpenId} />}
    </div>
  );
}
