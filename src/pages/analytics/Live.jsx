import { useEffect, useState } from "react";
import { api } from "../../api.js";
import { fmtHours } from "./shared.jsx";

// Zespół na żywo — kto jest online w Ringostat i kto właśnie rozmawia (odświeżanie co 15 s).

export default function Live() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    const load = () => api("rs.live").then((r) => { if (alive) { setD(r); setErr(""); } }).catch((e) => alive && setErr(e.message));
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 15000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  return (
    <>
      <div className="row between" style={{ marginBottom: 14 }}>
        <span className="small muted">Stan kont SIP z Ringostat · odświeżanie co 15 s{d ? ` · ${new Date(d.at).toLocaleTimeString("pl-PL")}` : ""}</span>
      </div>
      {err && <div className="err" style={{ marginBottom: 16 }}>{err}</div>}
      <div className="grid cols-3">
        {(d?.employees ?? []).map((e) => {
          const state = e.speaking ? "speaking" : e.online ? "online" : "offline";
          return (
            <div key={e.fio} className={"panel live-card " + state}>
              <div className="row between">
                <div>
                  <b style={{ fontSize: 16 }}>{e.fio}</b>
                  <div className="small muted">wewn. {e.extension} · {e.email}</div>
                </div>
                <span className={"live-dot " + state} />
              </div>
              <div className="live-state">
                {state === "speaking" ? "Rozmawia" : state === "online" ? "Dostępny" : "Offline"}
                {e.devices?.length > 0 && <span className="small muted"> · {e.devices.join(", ")}</span>}
              </div>
              <div className="row" style={{ gap: 18, marginTop: 12 }}>
                <div className="small"><span className="muted">Dziś rozmów:</span> <b>{e.today.calls}</b></div>
                <div className="small"><span className="muted">wychodzące:</span> <b>{e.today.out}</b></div>
                <div className="small"><span className="muted">czas:</span> <b>{fmtHours(e.today.talk)}</b></div>
              </div>
            </div>
          );
        })}
        {!d && !err && Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="panel"><div className="skel skel-line" style={{ width: "50%" }} /><div className="skel" style={{ height: 40, marginTop: 12 }} /></div>
        ))}
      </div>
      <div className="small muted" style={{ marginTop: 14 }}>
        Statystyki „dziś” pochodzą z dziennika połączeń (synchronizacja co 5 min), stan online/rozmowa — bezpośrednio z Ringostat.
      </div>
    </>
  );
}
