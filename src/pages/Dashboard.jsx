import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { SkelCards, SkelPanel } from "../components/Skeleton.jsx";

// Pulpit — analityka leadów z filtrem zakresu dat.

function Stat({ k, v, cls, sub }) {
  return (
    <div className="panel stat">
      <span className="k">{k}</span>
      <span className={"v " + (cls || "")}>{v}</span>
      {sub && <span className="small muted">{sub}</span>}
    </div>
  );
}

function ShareRow({ name, count, max }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="row between" style={{ marginBottom: 4 }}>
        <span className="small" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "78%" }} title={name}>{name}</span>
        <b className="small">{count}</b>
      </div>
      <div style={{ height: 6, background: "rgba(255,255,255,0.06)" }}>
        <div style={{ height: "100%", width: `${(count / max) * 100}%`, background: "linear-gradient(90deg, var(--red-2), var(--red))" }} />
      </div>
    </div>
  );
}

const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };

const PRESETS = [
  { key: "7", label: "7 dni", from: () => daysAgo(6) },
  { key: "30", label: "30 dni", from: () => daysAgo(29) },
  { key: "90", label: "90 dni", from: () => daysAgo(89) },
];

const fmtDay = (ds) => new Date(ds + "T12:00:00").toLocaleDateString("pl-PL", { day: "2-digit", month: "2-digit" });

export default function Dashboard() {
  const [s, setS] = useState(null);
  const [err, setErr] = useState("");
  const [preset, setPreset] = useState("30");
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(iso(new Date()));
  const [loading, setLoading] = useState(true);

  const load = async (f = from, t = to) => {
    setLoading(true); setErr("");
    try { setS(await api("stats", { from: f, to: t })); }
    catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const pickPreset = (p) => {
    const f = p.from(), t = iso(new Date());
    setPreset(p.key); setFrom(f); setTo(t); load(f, t);
  };
  const pickCustom = (f, t) => { setPreset("custom"); setFrom(f); setTo(t); if (f && t && f <= t) load(f, t); };

  const maxBar = s ? Math.max(1, ...s.byDay.map((d) => d.count)) : 1;
  const maxCamp = s ? Math.max(1, ...(s.topCampaigns ?? []).map((c) => c.count)) : 1;
  const maxPage = s ? Math.max(1, ...(s.topPages ?? []).map((c) => c.count)) : 1;

  const rangeDays = useMemo(() => {
    if (!from || !to) return 0;
    return Math.round((new Date(to) - new Date(from)) / 864e5) + 1;
  }, [from, to]);
  const avgPerDay = s && rangeDays ? (s.inRange / rangeDays).toFixed(1) : "0";
  const crmPct = s && s.inRange ? Math.round((s.crmSent / s.inRange) * 100) : 0;
  const bookPct = s && s.inRange ? Math.round((s.bookingsInRange / s.inRange) * 100) : 0;

  return (
    <>
      <div className="topbar">
        <div><h1>Pulpit</h1><div className="sub">Analityka leadów — wybierz zakres dat</div></div>
      </div>

      <div className="panel" style={{ marginBottom: 18 }}>
        <div className="row wrap" style={{ gap: 10 }}>
          {PRESETS.map((p) => (
            <button key={p.key} className={"btn sm" + (preset === p.key ? " primary" : "")} onClick={() => pickPreset(p)}>{p.label}</button>
          ))}
          <div className="row" style={{ gap: 8, marginLeft: "auto" }}>
            <span className="small muted">od</span>
            <input type="date" value={from} max={to} style={{ width: 150, padding: "7px 10px" }}
              onChange={(e) => pickCustom(e.target.value, to)} />
            <span className="small muted">do</span>
            <input type="date" value={to} min={from} max={iso(new Date())} style={{ width: 150, padding: "7px 10px" }}
              onChange={(e) => pickCustom(from, e.target.value)} />
          </div>
        </div>
      </div>

      {err && <div className="err" style={{ marginBottom: 16 }}>{err}</div>}

      {loading || !s ? (
        <div className="grid" style={{ gap: 18 }}>
          <SkelCards n={4} />
          <SkelPanel height={150} />
          <SkelCards n={4} />
        </div>
      ) : (
        <div className="grid" style={{ gap: 18 }}>
          <div className="grid cols-4">
            <Stat k="Leady w okresie" v={s.inRange} cls="red" sub={`śr. ${avgPerDay}/dzień`} />
            <Stat k="Dziś" v={s.today} />
            <Stat k="Wysłane do CRM" v={s.crmSent} cls="green" sub={`${crmPct}% leadów`} />
            <Stat k="Błędy" v={s.failed} cls={s.failed ? "amber" : ""} sub={s.pending ? `${s.pending} w kolejce` : ""} />
          </div>

          <div className="panel">
            <h3>Leady dzień po dniu · {s.range?.from} → {s.range?.to}</h3>
            <div className="bars" style={{ height: 150 }}>
              {s.byDay.length === 0 && <span className="muted small">Brak danych w tym okresie</span>}
              {s.byDay.map((d) => (
                <div key={d.date} className="bar" style={{ height: `${(d.count / maxBar) * 100}%` }} title={`${d.date}: ${d.count}`} />
              ))}
            </div>
            {s.byDay.length > 0 && (
              <div className="row between" style={{ marginTop: 6 }}>
                <span className="small muted">{fmtDay(s.byDay[0].date)}</span>
                <span className="small muted">{fmtDay(s.byDay[s.byDay.length - 1].date)}</span>
              </div>
            )}
          </div>

          <div className="grid cols-4">
            <Stat k="E-maile do klientów" v={s.clientEmailSent} sub="z linkiem do kalendarza" />
            <Stat k="SMS-y do klientów" v={s.clientSmsSent} sub="z linkiem do kalendarza" />
            <Stat k="Rezerwacje rozmów" v={s.bookingsInRange} cls="green" sub={`${bookPct}% leadów wybrało termin`} />
            <Stat k="Nadchodzące rozmowy" v={s.bookingsUpcoming} cls="red" sub="wszystkie przyszłe sloty" />
          </div>

          <div className="grid cols-2">
            <div className="panel">
              <h3>Top kampanie w okresie</h3>
              {(s.topCampaigns ?? []).length === 0 && <div className="muted small">Brak danych</div>}
              {(s.topCampaigns ?? []).map((c) => <ShareRow key={c.name} name={c.name} count={c.count} max={maxCamp} />)}
            </div>
            <div className="grid" style={{ gap: 18, alignContent: "start" }}>
              <div className="panel">
                <h3>Strony Facebook</h3>
                {(s.topPages ?? []).map((c) => <ShareRow key={c.name} name={c.name} count={c.count} max={maxPage} />)}
                {(s.topPages ?? []).length === 0 && <div className="muted small">Brak danych</div>}
              </div>
              <div className="panel">
                <h3>Statusy przetwarzania</h3>
                <div className="row wrap" style={{ gap: 14 }}>
                  <span className="badge done">done · {s.done}</span>
                  <span className="badge pending">pending · {s.pending}</span>
                  <span className="badge failed">failed · {s.failed}</span>
                  <span className="badge skipped">skipped · {s.skipped ?? 0}</span>
                </div>
                <div className="small muted" style={{ marginTop: 12 }}>
                  Łącznie w bazie od początku: <b style={{ color: "var(--text)" }}>{s.total}</b> leadów.
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
