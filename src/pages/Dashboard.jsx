import { useEffect, useState } from "react";
import { api } from "../api.js";

function Stat({ k, v, cls }) {
  return <div className="panel stat"><span className="k">{k}</span><span className={"v " + (cls || "")}>{v}</span></div>;
}

export default function Dashboard() {
  const [s, setS] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => { api("stats").then(setS).catch((e) => setErr(e.message)); }, []);

  const max = s ? Math.max(1, ...s.byDay.map((d) => d.count)) : 1;

  return (
    <>
      <div className="topbar">
        <div><h1>Pulpit</h1><div className="sub">Przegląd leadów z ostatnich 30 dni</div></div>
      </div>
      {err && <div className="err">{err}</div>}
      {!s ? <span className="spin" /> : (
        <div className="grid" style={{ gap: 18 }}>
          <div className="grid cols-4">
            <Stat k="Wszystkich leadów" v={s.total} />
            <Stat k="Dziś" v={s.today} cls="red" />
            <Stat k="Wysłane do CRM" v={s.crmSent} cls="green" />
            <Stat k="Błędy" v={s.failed} cls={s.failed ? "amber" : ""} />
          </div>
          <div className="panel">
            <h3>Leady dzień po dniu (30 dni)</h3>
            <div className="bars">
              {s.byDay.length === 0 && <span className="muted small">Brak danych</span>}
              {s.byDay.map((d) => (
                <div key={d.date} className="bar" style={{ height: `${(d.count / max) * 100}%` }} title={`${d.date}: ${d.count}`} />
              ))}
            </div>
          </div>
          <div className="grid cols-3">
            <Stat k="W kolejce" v={s.pending} cls="amber" />
            <Stat k="Przetworzone OK" v={s.done} cls="green" />
            <Stat k="Ostatnie 30 dni" v={s.last30} />
          </div>
        </div>
      )}
    </>
  );
}
