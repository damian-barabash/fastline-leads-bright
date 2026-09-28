import { IconCallIn, IconCallOut } from "../../components/Icons.jsx";

// ---- formatowanie ----
export const iso = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};
export const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };

export const fmtDateTime = (t) =>
  t ? new Date(t).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
export const fmtDay = (ds) => new Date(ds + "T12:00:00").toLocaleDateString("pl-PL", { day: "2-digit", month: "2-digit" });

// sekundy -> "2:05" / "1:02:05"
export function fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}
// sekundy -> "14 h 32 min"
export function fmtHours(sec) {
  const m = Math.round((Number(sec) || 0) / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}
// minuty -> "25 min" / "3 h 10 min" / "2 dni 4 h"
export function fmtMinutes(min) {
  if (min === null || min === undefined) return "—";
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${Math.floor(m / 60)} h ${m % 60} min`;
  return `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
}
export function fmtPhone(p) {
  const d = String(p ?? "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("48")) return `+48 ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
  return p ? (d.length > 9 ? "+" + d : d) : "—";
}
export const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
export function timeAgo(t) {
  const min = (Date.now() - new Date(t).getTime()) / 60000;
  if (min < 1) return "teraz";
  return fmtMinutes(min) + " temu";
}

// ---- słowniki ----
export const TYPE_LABEL = { in: "Przychodząca", out: "Wychodząca", callback: "Callback", transitin: "Przychodząca (tranzyt)", transitout: "Wychodząca (tranzyt)", internal: "Wewnętrzna" };
export const DISPOSITION_LABEL = {
  ANSWERED: "Odebrana", PROPER: "Odebrana · docelowa", REPEATED: "Odebrana · powtórna", "NO ANSWER": "Nieodebrana",
  BUSY: "Zajęte", VOICEMAIL: "Poczta głosowa", FAILED: "Błąd", "FAILED FORBIDDEN DESTINATION": "Zablokowany numer",
  "CLIENT NO ANSWER": "Klient nie odebrał", CALLING: "W trakcie", "IN PROGRESS": "W trakcie", DECLINE: "Odrzucona",
};
export const REASON_LABEL = {
  "Not answered by managers": "Handlowcy nie odebrali",
  "Abandoned before 10 seconds": "Klient rozłączył się < 10 s",
  "Outside of business hours": "Poza godzinami pracy",
  "All managers were unavailable": "Wszyscy handlowcy niedostępni",
  "(brak powodu)": "(brak powodu)",
};
export const DOW = ["Pn", "Wt", "Śr", "Cz", "Pt", "Sb", "Nd"];

export function StatusBadge({ c }) {
  const live = c.disposition === "CALLING" || c.disposition === "IN PROGRESS";
  const cls = live ? "pending" : c.answered ? "done" : c.call_type === "out" ? "skipped" : "failed";
  return <span className={"badge " + cls}>{DISPOSITION_LABEL[c.disposition] ?? c.disposition ?? "—"}</span>;
}

export function Direction({ type }) {
  const incoming = type === "in" || type === "transitin";
  return (
    <span className={"dir " + (incoming ? "in" : "out")} title={TYPE_LABEL[type] ?? type}>
      {incoming ? <IconCallIn /> : <IconCallOut />}
    </span>
  );
}

export function Stat({ k, v, cls, sub }) {
  return (
    <div className="panel stat">
      <span className="k">{k}</span>
      <span className={"v " + (cls || "")}>{v}</span>
      {sub && <span className="small muted">{sub}</span>}
    </div>
  );
}

export function ShareRow({ name, count, max, suffix }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="row between" style={{ marginBottom: 4 }}>
        <span className="small ellipsis" style={{ maxWidth: "78%" }} title={name}>{name}</span>
        <b className="small">{count}{suffix}</b>
      </div>
      <div className="share-track"><div className="share-fill" style={{ width: `${(count / Math.max(1, max)) * 100}%` }} /></div>
    </div>
  );
}

const PRESETS = [
  { key: "0", label: "Dziś", from: () => daysAgo(0) },
  { key: "7", label: "7 dni", from: () => daysAgo(6) },
  { key: "30", label: "30 dni", from: () => daysAgo(29) },
  { key: "90", label: "90 dni", from: () => daysAgo(89) },
  { key: "365", label: "Rok", from: () => daysAgo(364) },
];

// wspólny filtr zakresu dat + (opcjonalnie) pracownika
export function RangeBar({ range, setRange, employees, employee, setEmployee, children }) {
  const pick = (p) => setRange({ preset: p.key, from: p.from(), to: iso(new Date()) });
  const custom = (from, to) => { if (from && to && from <= to) setRange({ preset: "custom", from, to }); };
  return (
    <div className="panel" style={{ marginBottom: 18 }}>
      <div className="row wrap" style={{ gap: 10 }}>
        {PRESETS.map((p) => (
          <button key={p.key} className={"btn sm" + (range.preset === p.key ? " primary" : "")} onClick={() => pick(p)}>{p.label}</button>
        ))}
        {employees && (
          <select value={employee} onChange={(e) => setEmployee(e.target.value)} style={{ width: 210, padding: "7px 10px" }}>
            <option value="">Wszyscy pracownicy</option>
            {employees.map((e) => <option key={e.staff_id ?? e.fio} value={e.fio}>{e.fio}</option>)}
          </select>
        )}
        {children}
        <div className="row" style={{ gap: 8, marginLeft: "auto" }}>
          <span className="small muted">od</span>
          <input type="date" value={range.from} max={range.to} style={{ width: 150, padding: "7px 10px" }}
            onChange={(e) => custom(e.target.value, range.to)} />
          <span className="small muted">do</span>
          <input type="date" value={range.to} min={range.from} max={iso(new Date())} style={{ width: 150, padding: "7px 10px" }}
            onChange={(e) => custom(range.from, e.target.value)} />
        </div>
      </div>
    </div>
  );
}

export const defaultRange = () => ({ preset: "30", from: daysAgo(29), to: iso(new Date()) });

// link do leada w Pipedrive
export const pdLeadUrl = (lead, domain = "fastlineracingacademy") =>
  lead?.pipedrive_lead_id ? `https://${domain}.pipedrive.com/leads/inbox/${lead.pipedrive_lead_id}` : null;

// eksport CSV (UTF-8 z BOM — poprawne polskie znaki w Excelu)
export function downloadCsv(filename, rows, cols) {
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.map((c) => esc(c.label)).join(";"), ...rows.map((r) => cols.map((c) => esc(c.get(r))).join(";"))];
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
