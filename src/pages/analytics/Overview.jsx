import { useEffect, useState } from "react";
import { api } from "../../api.js";
import { SkelCards, SkelPanel } from "../../components/Skeleton.jsx";
import {
  RangeBar, Stat, ShareRow, fmtDur, fmtHours, fmtMinutes, fmtDay, pct, DOW, REASON_LABEL, DISPOSITION_LABEL,
} from "./shared.jsx";

// Przegląd — raport rozmów Ringostat w wybranym okresie.

function DailyChart({ days }) {
  const max = Math.max(1, ...days.map((d) => d.in + d.out));
  return (
    <>
      <div className="stack-bars">
        {days.length === 0 && <span className="muted small">Brak rozmów w tym okresie</span>}
        {days.map((d) => (
          <div key={d.date} className="stack-col"
            title={`${d.date}\nwychodzące: ${d.out}\nprzychodzące odebrane: ${d.in - d.missed}\nnieodebrane: ${d.missed}\nczas rozmów: ${fmtHours(d.talk)}`}>
            <div className="seg missed" style={{ height: `${(d.missed / max) * 100}%` }} />
            <div className="seg in" style={{ height: `${((d.in - d.missed) / max) * 100}%` }} />
            <div className="seg out" style={{ height: `${(d.out / max) * 100}%` }} />
          </div>
        ))}
      </div>
      {days.length > 0 && (
        <div className="row between" style={{ marginTop: 6 }}>
          <span className="small muted">{fmtDay(days[0].date)}</span>
          <div className="row small muted" style={{ gap: 14 }}>
            <span><i className="legend out" />wychodzące</span>
            <span><i className="legend in" />przychodzące odebrane</span>
            <span><i className="legend missed" />nieodebrane</span>
          </div>
          <span className="small muted">{fmtDay(days[days.length - 1].date)}</span>
        </div>
      )}
    </>
  );
}

// kiedy dzwonią klienci: dzień tygodnia × godzina (przychodzące), z liczbą nieodebranych
function Heatmap({ cells }) {
  const hours = Array.from({ length: 14 }, (_, i) => i + 8); // 8–21
  const get = (dow, h) => cells.find((c) => c.dow === dow && c.hour === h);
  const max = Math.max(1, ...cells.map((c) => c.in));
  return (
    <div className="heat">
      <div className="heat-row">
        <span className="heat-lbl" />
        {hours.map((h) => <span key={h} className="heat-h">{h}</span>)}
      </div>
      {DOW.map((d, i) => (
        <div key={d} className="heat-row">
          <span className="heat-lbl">{d}</span>
          {hours.map((h) => {
            const c = get(i + 1, h);
            const v = c?.in ?? 0;
            return (
              <span key={h} className={"heat-cell" + (c?.missed ? " has-missed" : "")}
                style={{ background: v ? `rgba(225, 29, 42, ${0.12 + (v / max) * 0.8})` : undefined }}
                title={`${d} ${h}:00–${h + 1}:00 · przychodzące: ${v}${c?.missed ? ` · nieodebrane: ${c.missed}` : ""} · wychodzące: ${c?.out ?? 0}`}>
                {v || ""}
              </span>
            );
          })}
        </div>
      ))}
      <div className="small muted" style={{ marginTop: 8 }}>Kolor = liczba połączeń przychodzących; żółta ramka = były nieodebrane.</div>
    </div>
  );
}

export default function Overview({ range, setRange, employee, setEmployee, openCalls }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true); setErr("");
    api("rs.overview", { from: range.from, to: range.to, employee: employee || null })
      .then((r) => alive && setD(r))
      .catch((e) => alive && setErr(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [range.from, range.to, employee]);

  const s = d?.stats;
  const emps = (s?.byEmployee ?? []);
  const maxReason = Math.max(1, ...(s?.missedReasons ?? []).map((x) => x.count));
  const maxSrc = Math.max(1, ...(s?.sources ?? []).map((x) => x.count));
  const maxBucket = Math.max(1, ...(s?.durationBuckets ?? []).map((x) => x.count));
  const maxDisp = Math.max(1, ...(s?.dispositions ?? []).map((x) => x.count));

  return (
    <>
      <RangeBar range={range} setRange={setRange} employees={d?.employees} employee={employee} setEmployee={setEmployee} />
      {err && <div className="err" style={{ marginBottom: 16 }}>{err}</div>}

      {loading || !s ? (
        <div className="grid" style={{ gap: 18 }}>
          <SkelCards n={4} /><SkelPanel height={170} /><SkelCards n={4} />
        </div>
      ) : (
        <div className="grid" style={{ gap: 18 }}>
          <div className="grid cols-4">
            <Stat k="Rozmowy w okresie" v={s.total} cls="red" sub={`${s.uniqueClients} unikalnych numerów`} />
            <Stat k="Wychodzące" v={s.outgoing} sub={`dodzwonione: ${s.outgoingAnswered} (${pct(s.outgoingAnswered, s.outgoing)}%)`} />
            <Stat k="Przychodzące" v={s.incoming} cls="green" sub={`odebrane: ${s.incomingAnswered} (${pct(s.incomingAnswered, s.incoming)}%)`} />
            <Stat k="Czas rozmów" v={fmtHours(s.talkSec)} sub={`śr. rozmowa ${fmtDur(s.avgTalkSec)} · ${s.answered} odebranych`} />
          </div>

          <div className="panel">
            <h3>Rozmowy dzień po dniu · {d.range.from} → {d.range.to}</h3>
            <DailyChart days={s.byDay ?? []} />
          </div>

          <div className="grid cols-4">
            <div className="panel stat clickable" onClick={() => openCalls({ type: "in", status: "missed" })} title="Pokaż nieodebrane">
              <span className="k">Nieodebrane przychodzące</span>
              <span className={"v " + (s.incomingMissed ? "amber" : "")}>{s.incomingMissed}</span>
              <span className="small muted">{pct(s.incomingMissed, s.incoming)}% przychodzących</span>
            </div>
            <div className="panel stat clickable" onClick={() => openCalls(null, "missed")} title="Lista do oddzwonienia">
              <span className="k">Bez oddzwonienia</span>
              <span className={"v " + (s.missedNotCalledBack ? "red" : "green")}>{s.missedNotCalledBack}</span>
              <span className="small muted">oddzwoniono: {s.missedCalledBack} · w ciągu 1 h: {s.callbackWithin1h}</span>
            </div>
            <Stat k="Czas do oddzwonienia" v={fmtMinutes(s.medianCallbackMin)} sub="mediana od nieodebranego do kontaktu" />
            <Stat k="Śr. czas oczekiwania" v={`${s.avgWaitIn} s`} sub="zanim handlowiec odebrał" />
          </div>

          <div className="grid cols-4">
            <div className="panel stat clickable" onClick={() => openCalls({ onlyLead: true })} title="Rozmowy z leadami">
              <span className="k">Rozmowy z leadami FB</span>
              <span className="v">{s.withLead}</span>
              <span className="small muted">{s.leadsCalled} leadów, do których dzwoniono</span>
            </div>
            <Stat k="Nowi klienci" v={s.newClients} sub={`docelowe: ${s.proper} · powtórne: ${s.repeated}`} />
            <div className="panel stat clickable" onClick={() => openCalls({ onlyRecording: true })}>
              <span className="k">Nagrania</span>
              <span className="v">{s.withRecording}</span>
              <span className="small muted">do odsłuchania w zakładce Rozmowy</span>
            </div>
            <div className="panel stat clickable" onClick={() => openCalls({ onlyAi: true })}>
              <span className="k">Przeanalizowane przez AI</span>
              <span className="v">{s.withAi}</span>
              <span className="small muted">{s.avgAiScore !== null ? `śr. ocena jakości: ${s.avgAiScore}` : "wyniki z Ringostat AI"}</span>
            </div>
          </div>

          <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ padding: "18px 20px 4px" }}><h3>Pracownicy</h3></div>
            <table className="tbl">
              <thead><tr>
                <th>Pracownik</th><th>Rozmowy</th><th>Wychodzące</th><th>Dodzwonione</th><th>Przychodzące</th>
                <th>Czas rozmów</th><th>Śr. rozmowa</th><th>Śr. odbiór</th><th>Klienci</th><th>Leady</th><th>AI</th>
              </tr></thead>
              <tbody>
                {emps.map((e) => (
                  <tr key={e.name} className="clickable" onClick={() => e.name !== "(bez pracownika)" && openCalls({ employee: e.name })}>
                    <td><b>{e.name}</b></td>
                    <td>{e.calls}</td>
                    <td>{e.out}</td>
                    <td>{e.out_answered} <span className="muted small">({pct(e.out_answered, e.out)}%)</span></td>
                    <td>{e.in}</td>
                    <td>{fmtHours(e.talk)}</td>
                    <td>{fmtDur(e.avg_talk)}</td>
                    <td>{e.avg_wait ? `${e.avg_wait} s` : "—"}</td>
                    <td>{e.clients}</td>
                    <td>{e.leads}</td>
                    <td>{e.ai ? `${e.ai}${e.ai_score !== null ? ` · ${e.ai_score}` : ""}` : "—"}</td>
                  </tr>
                ))}
                {emps.length === 0 && <tr><td colSpan="11" className="muted" style={{ textAlign: "center", padding: 24 }}>Brak danych</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="grid cols-2">
            <div className="panel">
              <h3>Kiedy dzwonią klienci</h3>
              <Heatmap cells={s.byHour ?? []} />
            </div>
            <div className="grid" style={{ gap: 18, alignContent: "start" }}>
              <div className="panel">
                <h3>Powody nieodebranych</h3>
                {(s.missedReasons ?? []).map((x) => <ShareRow key={x.name} name={REASON_LABEL[x.name] ?? x.name} count={x.count} max={maxReason} />)}
                {(s.missedReasons ?? []).length === 0 && <div className="muted small">Brak nieodebranych — świetnie!</div>}
              </div>
              <div className="panel">
                <h3>Długość odebranych rozmów</h3>
                {(s.durationBuckets ?? []).map((x) => <ShareRow key={x.name} name={x.name} count={x.count} max={maxBucket} />)}
              </div>
            </div>
          </div>

          <div className="grid cols-2">
            <div className="panel">
              <h3>Źródła połączeń przychodzących</h3>
              {(s.sources ?? []).map((x) => <ShareRow key={x.name} name={x.name} count={x.count} max={maxSrc} />)}
              {(s.sources ?? []).length === 0 && <div className="muted small">Brak danych</div>}
            </div>
            <div className="panel">
              <h3>Statusy połączeń</h3>
              {(s.dispositions ?? []).map((x) => <ShareRow key={x.name} name={DISPOSITION_LABEL[x.name] ?? x.name} count={x.count} max={maxDisp} />)}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
