import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { SkelTable, SkelPanel } from "../components/Skeleton.jsx";

// Rezerwacje oddzwonień — duży kalendarz miesięczny (pon–pt) + widok listy.

const TZ = "Europe/Warsaw";
const DOW = ["Poniedziałek", "Wtorek", "Środa", "Czwartek", "Piątek"];

const fmtSlot = (iso) => new Intl.DateTimeFormat("pl-PL", {
  timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
}).format(new Date(iso));
const fmtTime = (iso) => new Intl.DateTimeFormat("pl-PL", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const fmtShort = (iso) => (iso ? new Date(iso).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
// YYYY-MM-DD w czasie polskim
const dayKey = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const monthLabel = (y, m) => new Intl.DateTimeFormat("pl-PL", { month: "long", year: "numeric" }).format(new Date(y, m, 15));

export default function Bookings() {
  const [rows, setRows] = useState(null);
  const [view, setView] = useState("cal"); // cal | list
  const [mode, setMode] = useState("upcoming"); // filtr listy
  const [pdDomain, setPdDomain] = useState("fastlineracingacademy");
  const now = new Date();
  const [cursor, setCursor] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [open, setOpen] = useState(null);

  const load = async () => {
    setRows(null);
    const [r, s] = await Promise.all([api("bookings.list", { mode: "all" }), api("settings.get").catch(() => null)]);
    setRows(r.rows);
    if (s?.settings?.pipedrive_company_domain) setPdDomain(String(s.settings.pipedrive_company_domain));
  };
  useEffect(() => { load(); }, []);

  const isPast = (iso) => new Date(iso) < new Date();
  const todayKey = dayKey(new Date().toISOString());

  // aktywne rezerwacje pogrupowane po dniu (czas PL)
  const byDay = useMemo(() => {
    const m = {};
    for (const b of rows ?? []) {
      if (b.status !== "booked") continue;
      const k = dayKey(b.slot_at);
      (m[k] = m[k] ?? []).push(b);
    }
    for (const k of Object.keys(m)) m[k].sort((a, b) => new Date(a.slot_at) - new Date(b.slot_at));
    return m;
  }, [rows]);

  // siatka miesiąca: tylko PON–PT, tygodnie wierszami
  const weeks = useMemo(() => {
    const first = new Date(cursor.y, cursor.m, 1);
    const last = new Date(cursor.y, cursor.m + 1, 0);
    const start = new Date(first);
    start.setDate(first.getDate() - ((first.getDay() + 6) % 7)); // poniedziałek 1. tygodnia
    const out = [];
    for (let w = 0; out.length <= 6; w++) {
      const weekStart = new Date(start); weekStart.setDate(start.getDate() + w * 7);
      if (weekStart > last) break;
      const week = [];
      let anyInMonth = false;
      for (let d = 0; d < 5; d++) {
        const cur = new Date(weekStart); cur.setDate(weekStart.getDate() + d);
        const inMonth = cur.getMonth() === cursor.m;
        if (inMonth) anyInMonth = true;
        const ds = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`;
        week.push({ d: cur.getDate(), ds, inMonth });
      }
      if (anyInMonth) out.push(week);
    }
    return out;
  }, [cursor]);

  const nav = (dir) => {
    let { y, m } = cursor;
    m += dir; if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; }
    setCursor({ y, m });
  };
  const goToday = () => setCursor({ y: now.getFullYear(), m: now.getMonth() });

  const upcomingCount = (rows ?? []).filter((b) => b.status === "booked" && !isPast(b.slot_at)).length;

  const listRows = useMemo(() => {
    let r = rows ?? [];
    if (mode === "upcoming") r = r.filter((b) => b.status === "booked" && new Date(b.slot_at) > new Date(Date.now() - 3600_000));
    return [...r].sort((a, b) => mode === "upcoming"
      ? new Date(a.slot_at) - new Date(b.slot_at)
      : new Date(b.slot_at) - new Date(a.slot_at));
  }, [rows, mode]);

  const pdLink = (b) => b.lead?.pipedrive_lead_id ? `https://${pdDomain}.pipedrive.com/leads/inbox/${b.lead.pipedrive_lead_id}` : null;

  return (
    <>
      <div className="topbar">
        <div><h1>Rezerwacje rozmów</h1><div className="sub">Terminy oddzwonień wybrane przez klientów (pon–pt 10:00–18:00, sloty 20 min) · nadchodzące: <b style={{ color: "var(--red-2)" }}>{upcomingCount}</b></div></div>
        <div className="row" style={{ gap: 8 }}>
          <button className={"btn sm" + (view === "cal" ? " primary" : "")} onClick={() => setView("cal")}>Kalendarz</button>
          <button className={"btn sm" + (view === "list" ? " primary" : "")} onClick={() => setView("list")}>Lista</button>
          <button className="btn sm" onClick={load}>Odśwież</button>
        </div>
      </div>

      {!rows && (view === "cal" ? <SkelPanel height={420} /> : <SkelTable cols={6} rows={6} />)}

      {rows && view === "cal" && (
        <>
          <div className="panel" style={{ marginBottom: 14, padding: "14px 18px" }}>
            <div className="row between">
              <div className="row" style={{ gap: 10 }}>
                <button className="btn sm" onClick={() => nav(-1)}>‹</button>
                <b style={{ fontSize: 17, textTransform: "capitalize", minWidth: 180, textAlign: "center" }}>{monthLabel(cursor.y, cursor.m)}</b>
                <button className="btn sm" onClick={() => nav(1)}>›</button>
              </div>
              <button className="btn sm ghost" onClick={goToday}>Dziś</button>
            </div>
          </div>

          <div className="panel calx" style={{ padding: 0, overflow: "hidden" }}>
            <div className="calx-head">
              {DOW.map((d) => <div key={d}>{d}</div>)}
            </div>
            {weeks.map((week, wi) => (
              <div key={wi} className="calx-week">
                {week.map((c) => {
                  const items = byDay[c.ds] ?? [];
                  const past = c.ds < todayKey;
                  return (
                    <div key={c.ds} className={"calx-day" + (c.inMonth ? "" : " out") + (c.ds === todayKey ? " today" : "") + (past ? " past" : "")}>
                      <div className="calx-num">{c.ds === todayKey ? <span className="calx-today-pill">DZIŚ · {c.d}</span> : c.d}</div>
                      <div className="calx-items">
                        {items.map((b) => (
                          <button key={b.id} className={"calx-chip" + (isPast(b.slot_at) ? " gone" : "")} onClick={() => setOpen(b)} title={b.lead?.campaign_name || ""}>
                            <b>{fmtTime(b.slot_at)}</b> {(b.lead?.full_name || "—").split(/\s+/)[0]}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="small muted" style={{ marginTop: 10 }}>Kliknij rezerwację, aby zobaczyć szczegóły. Weekendy pominięte — sloty są tylko pon–pt.</div>
        </>
      )}

      {rows && view === "list" && (
        <>
          <div className="row" style={{ gap: 10, marginBottom: 16 }}>
            <button className={"btn sm" + (mode === "upcoming" ? " primary" : "")} onClick={() => setMode("upcoming")}>Nadchodzące</button>
            <button className={"btn sm" + (mode === "all" ? " primary" : "")} onClick={() => setMode("all")}>Wszystkie</button>
          </div>
          <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
            <table className="tbl">
              <thead><tr><th>Termin rozmowy</th><th>Klient</th><th>Kontakt</th><th>Kampania</th><th>Status</th><th>Zarezerwowano</th><th></th></tr></thead>
              <tbody>
                {listRows.map((b) => (
                  <tr key={b.id} style={{ opacity: b.status === "cancelled" ? 0.45 : 1 }}>
                    <td><b style={{ color: isPast(b.slot_at) ? undefined : "var(--red-2)" }}>{fmtSlot(b.slot_at)}</b></td>
                    <td><b>{b.lead?.full_name || "—"}</b></td>
                    <td className="small">{b.lead?.phone || "—"}<br /><span className="muted">{b.lead?.email || ""}</span></td>
                    <td className="small muted">{b.lead?.campaign_name || b.lead?.form_name || "—"}</td>
                    <td>{b.status === "booked"
                      ? (isPast(b.slot_at) ? <span className="badge skipped">minęła</span> : <span className="badge done">umówiona</span>)
                      : <span className="badge skipped">zmieniona</span>}</td>
                    <td className="small muted">{fmtShort(b.created_at)}</td>
                    <td>{pdLink(b) && <a className="btn sm ghost" target="_blank" rel="noreferrer" href={pdLink(b)}>Pipedrive ↗</a>}</td>
                  </tr>
                ))}
                {listRows.length === 0 && <tr><td colSpan="7" className="muted" style={{ textAlign: "center", padding: 30 }}>
                  {mode === "upcoming" ? "Brak nadchodzących rezerwacji" : "Brak rezerwacji"}</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {open && (
        <div className="overlay" onClick={() => setOpen(null)}>
          <div className="panel modal" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
            <div className="row between"><h3>Rezerwacja rozmowy</h3><button className="btn sm ghost" onClick={() => setOpen(null)}>✕</button></div>
            <div style={{ fontSize: 19, fontWeight: 700, color: "var(--red-2)", marginBottom: 14, textTransform: "capitalize" }}>{fmtSlot(open.slot_at)}</div>
            <div className="grid" style={{ gap: 8, marginBottom: 16 }}>
              <div className="small"><span className="muted">Klient:</span> <b>{open.lead?.full_name || "—"}</b></div>
              <div className="small"><span className="muted">Telefon:</span> <b>{open.lead?.phone || "—"}</b></div>
              <div className="small"><span className="muted">E-mail:</span> {open.lead?.email || "—"}</div>
              <div className="small"><span className="muted">Kampania:</span> {open.lead?.campaign_name || open.lead?.form_name || "—"}</div>
              <div className="small"><span className="muted">Strona:</span> {open.lead?.page_name || "—"}</div>
              <div className="small"><span className="muted">Zarezerwowano:</span> {fmtShort(open.created_at)}</div>
            </div>
            <div className="row" style={{ gap: 10, justifyContent: "flex-end" }}>
              {open.lead?.phone && <a className="btn sm" href={`tel:${open.lead.phone}`}>Zadzwoń</a>}
              {pdLink(open) && <a className="btn primary sm" target="_blank" rel="noreferrer" href={pdLink(open)}>Otwórz w Pipedrive ↗</a>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
