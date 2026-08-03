import { useEffect, useState } from "react";
import { api } from "../api.js";
import { SkelTable } from "../components/Skeleton.jsx";

// Rezerwacje oddzwonień — sloty wybrane przez klientów w kalendarzu.

const fmtSlot = (iso) => new Intl.DateTimeFormat("pl-PL", {
  timeZone: "Europe/Warsaw", weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
}).format(new Date(iso));
const fmtShort = (iso) => (iso ? new Date(iso).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");

export default function Bookings() {
  const [rows, setRows] = useState(null);
  const [mode, setMode] = useState("upcoming");
  const [pdDomain, setPdDomain] = useState("fastlineracingacademy");

  const load = async (m = mode) => {
    setRows(null);
    const [r, s] = await Promise.all([api("bookings.list", { mode: m }), api("settings.get").catch(() => null)]);
    setRows(r.rows);
    if (s?.settings?.pipedrive_company_domain) setPdDomain(String(s.settings.pipedrive_company_domain));
  };
  useEffect(() => { load(); }, []);

  const isPast = (iso) => new Date(iso) < new Date();

  return (
    <>
      <div className="topbar">
        <div><h1>Rezerwacje rozmów</h1><div className="sub">Terminy oddzwonień wybrane przez klientów (pon–pt 10:00–18:00, sloty 20 min)</div></div>
        <button className="btn sm" onClick={() => load()}>Odśwież</button>
      </div>

      <div className="row" style={{ gap: 10, marginBottom: 16 }}>
        <button className={"btn sm" + (mode === "upcoming" ? " primary" : "")} onClick={() => { setMode("upcoming"); load("upcoming"); }}>Nadchodzące</button>
        <button className={"btn sm" + (mode === "all" ? " primary" : "")} onClick={() => { setMode("all"); load("all"); }}>Wszystkie</button>
      </div>

      {!rows && <SkelTable cols={6} rows={6} />}

      {rows && (
        <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
          <table className="tbl">
            <thead><tr><th>Termin rozmowy</th><th>Klient</th><th>Kontakt</th><th>Kampania</th><th>Status</th><th>Zarezerwowano</th><th></th></tr></thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id} style={{ opacity: b.status === "cancelled" ? 0.45 : 1 }}>
                  <td><b style={{ color: isPast(b.slot_at) ? undefined : "var(--red-2)" }}>{fmtSlot(b.slot_at)}</b></td>
                  <td><b>{b.lead?.full_name || "—"}</b></td>
                  <td className="small">{b.lead?.phone || "—"}<br /><span className="muted">{b.lead?.email || ""}</span></td>
                  <td className="small muted">{b.lead?.campaign_name || b.lead?.form_name || "—"}</td>
                  <td>{b.status === "booked"
                    ? (isPast(b.slot_at) ? <span className="badge skipped">minęła</span> : <span className="badge done">umówiona</span>)
                    : <span className="badge skipped">zmieniona</span>}</td>
                  <td className="small muted">{fmtShort(b.created_at)}</td>
                  <td>
                    {b.lead?.pipedrive_lead_id && (
                      <a className="btn sm ghost" target="_blank" rel="noreferrer"
                        href={`https://${pdDomain}.pipedrive.com/leads/inbox/${b.lead.pipedrive_lead_id}`}>Pipedrive ↗</a>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan="7" className="muted" style={{ textAlign: "center", padding: 30 }}>
                {mode === "upcoming" ? "Brak nadchodzących rezerwacji" : "Brak rezerwacji"}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
