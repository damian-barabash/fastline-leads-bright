import { useEffect, useMemo, useState } from "react";
import { api } from "../../api.js";
import { SkelCards, SkelPanel } from "../../components/Skeleton.jsx";
import { IconExternal, IconSpark } from "../../components/Icons.jsx";
import { DailyChart } from "./Overview.jsx";
import { ShareRow, fmtDur, fmtHours, fmtMinutes, fmtPhone, iso, pct } from "./shared.jsx";

// Raport tygodniowy: rozmowy Ringostat + komentarze handlowców i podsumowania AI z Pipedrive.

const addDays = (ds, n) => { const d = new Date(ds + "T12:00:00"); d.setDate(d.getDate() + n); return iso(d); };
const mondayOf = (ds) => { const d = new Date(ds + "T12:00:00"); return addDays(ds, -((d.getDay() + 6) % 7)); };
const lastWeek = () => addDays(mondayOf(iso(new Date())), -7);
const fmtD = (ds, opt) => new Date(ds + "T12:00:00").toLocaleDateString("pl-PL", opt);
const fmtAt = (t) => t ? new Date(t).toLocaleString("pl-PL", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
function weekNo(ds) {
  const d = new Date(ds + "T12:00:00"); d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const w1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - w1) / 864e5 - 3 + ((w1.getDay() + 6) % 7)) / 7);
}

function Delta({ cur, prev, invert, fmt }) {
  if (prev === null || prev === undefined || cur === null || cur === undefined) return null;
  const diff = cur - prev;
  if (!prev && !cur) return null;
  const p = prev ? Math.round((diff / prev) * 100) : null;
  const good = invert ? diff < 0 : diff > 0;
  const cls = diff === 0 ? "muted" : good ? "delta up" : "delta down";
  return <span className={"small " + cls}>{diff > 0 ? "▲" : diff < 0 ? "▼" : "="} {fmt ? fmt(Math.abs(diff)) : Math.abs(diff)}{p !== null && diff !== 0 ? ` (${p > 0 ? "+" : ""}${p}%)` : ""} vs poprz. tydz.</span>;
}

function Kpi({ k, v, cls, sub, delta }) {
  return (
    <div className="panel stat">
      <span className="k">{k}</span>
      <span className={"v " + (cls || "")}>{v}</span>
      {sub && <span className="small muted">{sub}</span>}
      {delta}
    </div>
  );
}

function Entry({ e }) {
  if (e.kind === "ai") {
    return (
      <div className="wk-entry ai">
        <div className="wk-meta">
          <IconSpark size={12} /> <b>Podsumowanie rozmowy (AI)</b>
          <span>· {fmtAt(e.at)}</span>
          {e.author && e.author !== "Ringostat AI" && <span>· {e.author}</span>}
          {e.billsec ? <span>· {fmtDur(e.billsec)}</span> : null}
          {e.clientMood && <span className="wk-chip">klient: {e.clientMood}</span>}
          {e.employeeMood && <span className="wk-chip">handlowiec: {e.employeeMood}</span>}
          {typeof e.reviewScore === "number" && <span className={"wk-chip" + (e.reviewScore >= 4 ? " warn" : "")}>uwaga: {e.reviewScore}/10</span>}
        </div>
        <div className="wk-text">{e.text}</div>
      </div>
    );
  }
  return (
    <div className="wk-entry">
      <div className="wk-meta">
        <b>{e.author}</b>
        <span>· {fmtAt(e.at)}</span>
        {e.kind === "activity" && <span className="wk-chip">{e.actType}{e.done ? "" : ` · plan ${e.due ?? ""}`}</span>}
        {e.kind === "note" && <span className="wk-chip">notatka</span>}
      </div>
      <div className="wk-text">{e.text}</div>
    </div>
  );
}

export default function Weekly({ onOpen }) {
  const [week, setWeek] = useState(lastWeek);
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [who, setWho] = useState("");
  const [q, setQ] = useState("");
  const [showAi, setShowAi] = useState(true);
  const [limit, setLimit] = useState(40);

  useEffect(() => {
    let alive = true;
    setLoading(true); setErr(""); setLimit(40);
    api("rs.weekly", { week })
      .then((r) => alive && setD(r))
      .catch((e) => alive && setErr(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [week]);

  const thisMonday = mondayOf(iso(new Date()));
  const s = d?.stats, p = d?.prev, f = d?.funnel;

  const clients = useMemo(() => {
    if (!d) return [];
    const t = q.trim().toLowerCase();
    return d.clients
      .map((c) => ({ ...c, entries: c.entries.filter((e) => (showAi || e.kind !== "ai") && (!who || e.author === who)) }))
      .filter((c) => c.entries.length)
      .filter((c) => !t || c.name.toLowerCase().includes(t) || (c.lead?.campaign ?? "").toLowerCase().includes(t)
        || c.entries.some((e) => e.text.toLowerCase().includes(t)));
  }, [d, who, q, showAi]);
  const authors = useMemo(() => [...new Set((d?.clients ?? []).flatMap((c) => c.entries.map((e) => e.author)))].filter((a) => a !== "Ringostat AI").sort(), [d]);
  const maxMood = Math.max(1, ...(d?.moods ?? []).map((m) => m.count));
  const maxCamp = Math.max(1, ...(f?.byCampaign ?? []).map((c) => c.leads));

  return (
    <div className="weekly">
      <div className="panel no-print-bg" style={{ marginBottom: 18 }}>
        <div className="row wrap" style={{ gap: 10 }}>
          <button className="btn sm no-print" onClick={() => setWeek(addDays(week, -7))}>‹ Poprzedni</button>
          <div style={{ minWidth: 260 }}>
            <b style={{ fontSize: 16 }}>Tydzień {weekNo(week)} · {fmtD(week, { day: "numeric", month: "long" })} – {fmtD(addDays(week, 6), { day: "numeric", month: "long", year: "numeric" })}</b>
            <div className="small muted">{week === thisMonday ? "bieżący tydzień — dane do teraz" : "pn–nd, czas PL"} · porównanie z tygodniem wcześniej</div>
          </div>
          <button className="btn sm no-print" disabled={week >= thisMonday} onClick={() => setWeek(addDays(week, 7))}>Następny ›</button>
          <div className="row no-print" style={{ gap: 8, marginLeft: "auto" }}>
            <button className={"btn sm" + (week === lastWeek() ? " primary" : "")} onClick={() => setWeek(lastWeek())}>Ostatni pełny tydzień</button>
            <button className={"btn sm" + (week === thisMonday ? " primary" : "")} onClick={() => setWeek(thisMonday)}>Bieżący</button>
            <input type="date" value={week} max={iso(new Date())} style={{ width: 150, padding: "7px 10px" }}
              onChange={(e) => e.target.value && setWeek(mondayOf(e.target.value))} />
            <button className="btn sm" disabled={!d} onClick={() => window.print()}>Drukuj / PDF</button>
          </div>
        </div>
      </div>

      {err && <div className="err" style={{ marginBottom: 16 }}>{err}</div>}

      {loading || !d ? (
        <div className="grid" style={{ gap: 18 }}><SkelCards n={4} /><SkelPanel height={170} /><SkelCards n={4} /><SkelPanel height={260} /></div>
      ) : (
        <div className="grid" style={{ gap: 18 }}>
          {/* --- rozmowy --- */}
          <div className="grid cols-4">
            <Kpi k="Rozmowy" v={s.total} cls="red" sub={`${s.uniqueClients} różnych numerów`} delta={<Delta cur={s.total} prev={p.total} />} />
            <Kpi k="Wychodzące" v={s.outgoing} sub={`dodzwonione: ${s.outgoingAnswered} (${pct(s.outgoingAnswered, s.outgoing)}%)`} delta={<Delta cur={s.outgoing} prev={p.outgoing} />} />
            <Kpi k="Przychodzące" v={s.incoming} cls="green" sub={`odebrane: ${s.incomingAnswered} (${pct(s.incomingAnswered, s.incoming)}%)`} delta={<Delta cur={s.incoming} prev={p.incoming} />} />
            <Kpi k="Czas rozmów" v={fmtHours(s.talkSec)} sub={`śr. rozmowa ${fmtDur(s.avgTalkSec)}`} delta={<Delta cur={s.talkSec} prev={p.talkSec} fmt={fmtHours} />} />
          </div>
          <div className="grid cols-4">
            <Kpi k="Nieodebrane przychodzące" v={s.incomingMissed} cls={s.incomingMissed ? "amber" : ""} sub={`${pct(s.incomingMissed, s.incoming)}% przychodzących`} delta={<Delta cur={s.incomingMissed} prev={p.incomingMissed} invert />} />
            <Kpi k="Bez oddzwonienia" v={s.missedNotCalledBack} cls={s.missedNotCalledBack ? "red" : "green"} sub={`oddzwoniono: ${s.missedCalledBack} · mediana ${fmtMinutes(s.medianCallbackMin)}`} delta={<Delta cur={s.missedNotCalledBack} prev={p.missedNotCalledBack} invert />} />
            <Kpi k="Komentarze w Pipedrive" v={d.pipedrive.comments} sub={`notatki: ${d.pipedrive.notes} · aktywności wykonane: ${d.pipedrive.actsDone}`} />
            <Kpi k="Rozmowy z analizą AI" v={d.pipedrive.aiNotes} sub={`rezerwacje terminu przez klientów: ${d.pipedrive.bookings}`} />
          </div>

          <div className="panel">
            <h3>Rozmowy dzień po dniu</h3>
            <DailyChart days={s.byDay ?? []} />
          </div>

          {/* --- handlowcy --- */}
          <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ padding: "18px 20px 4px" }}><h3>Handlowcy — telefon (Ringostat) + praca w Pipedrive</h3></div>
            <table className="tbl">
              <thead><tr>
                <th>Handlowiec</th><th>Rozmowy</th><th>Wychodzące / dodzw.</th><th>Przychodzące</th><th>Czas rozmów</th><th>Śr. rozmowa</th>
                <th>Komentarze PD</th><th>Aktywności wyk.</th><th>Zaległe</th><th>Plan na kolejny tydz.</th><th>AI: nastrój klientów</th>
              </tr></thead>
              <tbody>
                {d.sellers.map((x) => (
                  <tr key={x.key}>
                    <td><b>{x.name}</b></td>
                    <td>{x.calls} <Delta cur={x.calls} prev={x.prevCalls} /></td>
                    <td>{x.out} / {x.outAnswered} <span className="muted small">({pct(x.outAnswered, x.out)}%)</span></td>
                    <td>{x.in}</td>
                    <td>{fmtHours(x.talk)}</td>
                    <td>{x.avgTalk ? fmtDur(x.avgTalk) : "—"}</td>
                    <td>{x.comments}</td>
                    <td>{x.actsDone}</td>
                    <td className={x.actsOpen ? "amber-t" : ""}>{x.actsOpen}</td>
                    <td>{x.nextWeek}</td>
                    <td className="small">{x.ai ? `${x.ai} rozm. · ${x.topMoods.map((m) => `${m.name} ${m.count}`).join(", ")}` : "—"}</td>
                  </tr>
                ))}
                {d.sellers.length === 0 && <tr><td colSpan="11" className="muted" style={{ textAlign: "center", padding: 24 }}>Brak danych</td></tr>}
              </tbody>
            </table>
            <div className="small muted" style={{ padding: "10px 20px 14px" }}>
              Zaległe = aktywności z terminem w tym tygodniu, nieoznaczone jako wykonane. Rozmowy wykonywane poza Ringostat (np. z prywatnego telefonu) nie są liczone w kolumnach telefonu — widać je w komentarzach.
            </div>
          </div>

          {/* --- leady FB --- */}
          <div className="grid cols-2">
            <div className="panel">
              <h3>Leady z Facebooka w tym tygodniu</h3>
              <div className="grid cols-3" style={{ gap: 12, marginBottom: 14 }}>
                <div className="stat"><span className="k">Nowe leady</span><span className="v">{f.total}</span></div>
                <div className="stat"><span className="k">Z kontaktem</span><span className="v green">{f.called + f.pdOnly}</span>
                  <span className="small muted">{pct(f.called + f.pdOnly, f.total)}% · dodzwonione: {f.talked}{f.pdOnly ? ` · tylko wpis w PD: ${f.pdOnly}` : ""}</span></div>
                <div className="stat"><span className="k">Bez kontaktu</span><span className={"v " + (f.notCalled.length ? "red" : "green")}>{f.notCalled.length}</span></div>
              </div>
              <div className="small muted" style={{ marginBottom: 14 }}>
                Pierwszy telefon: mediana <b>{fmtMinutes(f.medianFirstCallMin)}</b> od zgłoszenia · w ciągu 1 h: {f.calledWithin1h} · w ciągu 24 h: {f.calledWithin24h}
              </div>
              {(f.byCampaign ?? []).map((c) => (
                <ShareRow key={c.name} name={`${c.name} — kontakt ${c.called}/${c.leads}`} count={c.leads} max={maxCamp} />
              ))}
            </div>
            <div className="panel">
              <h3>Leady bez żadnego kontaktu ({f.notCalled.length})</h3>
              <div className="wk-scroll">
                {f.notCalled.map((l) => (
                  <div key={l.id} className="hist-row" style={{ cursor: "default" }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <b className="small">{l.full_name || "(bez nazwy)"}</b> <span className="small muted">{fmtPhone(l.phone)}</span>
                      <div className="small muted ellipsis" style={{ maxWidth: "100%" }}>{l.campaign_name || l.form_name} · {fmtAt(l.received_at)}</div>
                    </div>
                    {l.pdUrl && <a className="link small no-print" href={l.pdUrl} target="_blank" rel="noreferrer">Pipedrive <IconExternal /></a>}
                  </div>
                ))}
                {f.notCalled.length === 0 && <div className="muted small">Do każdego leada był kontakt.</div>}
              </div>
            </div>
          </div>

          {/* --- AI: nastroje + uwaga --- */}
          <div className="grid cols-2">
            <div className="panel">
              <h3>Nastrój klientów w rozmowach (Ringostat AI)</h3>
              {d.moods.slice(0, 10).map((m) => <ShareRow key={m.name} name={m.name} count={m.count} max={maxMood} />)}
              {d.moods.length === 0 && <div className="muted small">Brak analiz AI w tym tygodniu.</div>}
            </div>
            <div className="panel">
              <h3>Rozmowy wymagające uwagi ({d.attention.length})</h3>
              <div className="wk-scroll">
                {d.attention.map((a) => (
                  <div key={a.id} className="wk-entry ai" style={{ marginBottom: 10 }}>
                    <div className="wk-meta">
                      <b>{a.client?.name ?? "Klient"}</b><span>· {fmtAt(a.at)} · {a.author}</span>
                      {typeof a.reviewScore === "number" && <span className={"wk-chip" + (a.reviewScore >= 4 ? " warn" : "")}>uwaga: {a.reviewScore}/10</span>}
                      {a.clientMood && <span className="wk-chip">klient: {a.clientMood}</span>}
                      <button className="btn sm no-print" style={{ marginLeft: "auto" }} onClick={() => onOpen(a.uniqueid)}>Rozmowa</button>
                    </div>
                    <div className="wk-text">{a.text}</div>
                  </div>
                ))}
                {d.attention.length === 0 && <div className="muted small">Brak rozmów oznaczonych przez AI jako wymagające uwagi.</div>}
              </div>
            </div>
          </div>

          {/* --- klienci: komentarze --- */}
          <div className="panel">
            <div className="row wrap between" style={{ marginBottom: 14, gap: 10 }}>
              <h3 style={{ margin: 0 }}>Komentarze handlowców z Pipedrive — klient po kliencie ({clients.length})</h3>
              <div className="row no-print" style={{ gap: 10 }}>
                <select value={who} onChange={(e) => setWho(e.target.value)} style={{ width: 200, padding: "7px 10px" }}>
                  <option value="">Wszyscy handlowcy</option>
                  {authors.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
                <input placeholder="Szukaj: klient, kampania, treść…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240, padding: "7px 10px" }} />
                <label className="chk"><input type="checkbox" checked={showAi} onChange={(e) => setShowAi(e.target.checked)} /> podsumowania AI</label>
              </div>
            </div>
            <div className="grid" style={{ gap: 12 }}>
              {clients.slice(0, limit).map((c) => (
                <div key={c.key} className="wk-client">
                  <div className="row between" style={{ marginBottom: 8, gap: 10 }}>
                    <div style={{ minWidth: 0 }}>
                      <b>{c.name}</b>{c.org && <span className="muted small"> · {c.org}</span>}
                      <div className="small muted">
                        {c.lead?.campaign ?? "bez kampanii FB"}
                        {c.lead?.phone && ` · ${fmtPhone(c.lead.phone)}`}
                        {c.calls ? ` · ${c.calls} rozm. w tygodniu (${fmtHours(c.talk)})` : ""}
                        {` · ${c.people.join(", ")}`}
                      </div>
                    </div>
                    {c.pdUrl && <a className="link small no-print nowrap" href={c.pdUrl} target="_blank" rel="noreferrer">Pipedrive <IconExternal /></a>}
                  </div>
                  {c.entries.map((e) => <Entry key={e.id} e={e} />)}
                </div>
              ))}
              {clients.length === 0 && <div className="muted small">Brak komentarzy dla wybranych filtrów.</div>}
              {clients.length > limit && (
                <button className="btn no-print" onClick={() => setLimit(limit + 40)}>Pokaż kolejnych ({clients.length - limit})</button>
              )}
            </div>
          </div>
          <div className="small muted">Wygenerowano {fmtAt(d.generatedAt)} · dane: Ringostat + Pipedrive (notatki i aktywności) + leady FB.</div>
        </div>
      )}
    </div>
  );
}
