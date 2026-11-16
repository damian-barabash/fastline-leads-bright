import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { SkelCards, SkelPanel } from "../components/Skeleton.jsx";
import { IconDownload, IconSpark } from "../components/Icons.jsx";
import { RangeBar, defaultRange, downloadCsv, fmtDateTime, fmtDay, iso } from "./analytics/shared.jsx";

// Kampanie — statystyki kampanii Facebook: leady, wydatki, koszt leada, jakość (kontakt / gorące)
// + porównanie z poprzednim okresem tej samej długości, trend tygodniowy i komentarz AI (Barabash AI).

const brk = (s) => String(s ?? "").replace(/_/g, "_​");
const addDays = (ds, n) => { const d = new Date(ds + "T12:00:00"); d.setDate(d.getDate() + n); return iso(d); };
const monday = (ds) => { const d = new Date(ds + "T12:00:00"); return addDays(ds, -((d.getDay() + 6) % 7)); };
const today = () => iso(new Date());
const monthStart = (ds) => ds.slice(0, 8) + "01";

const EXTRA = [
  { key: "tw", label: "Ten tydzień", get: () => ({ from: monday(today()), to: today() }) },
  { key: "lw", label: "Poprz. tydzień", get: () => ({ from: addDays(monday(today()), -7), to: addDays(monday(today()), -1) }) },
  { key: "tm", label: "Ten miesiąc", get: () => ({ from: monthStart(today()), to: today() }) },
  { key: "lm", label: "Poprz. miesiąc", get: () => { const e = addDays(monthStart(today()), -1); return { from: monthStart(e), to: e }; } },
];

const nf0 = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (v, cur = "PLN", dec = false) => (v === null || v === undefined ? "—" : `${(dec ? nf2 : nf0).format(v)} ${cur === "PLN" ? "zł" : cur}`);
const num = (v) => (v === null || v === undefined ? "—" : nf0.format(v));
const pctS = (v) => (v === null || v === undefined ? "—" : `${v}%`);
const ctrS = (v) => (v === null || v === undefined ? "—" : `${nf2.format(v)}%`);

// zmiana vs poprzedni okres; invert = mniej znaczy lepiej (koszty)
function Delta({ cur, prev, invert, small }) {
  if (cur === null || cur === undefined || prev === null || prev === undefined) return null;
  if (!prev && !cur) return null;
  if (!prev) return <span className={"small delta " + (invert ? "down" : "up")}>nowe</span>;
  const p = Math.round(((cur - prev) / prev) * 100);
  if (p === 0) return <span className="small muted">= {small ? "" : "bez zmian"}</span>;
  const good = invert ? p < 0 : p > 0;
  return <span className={"small delta " + (good ? "up" : "down")}>{p > 0 ? "▲" : "▼"} {p > 0 ? "+" : ""}{p}%</span>;
}

function Kpi({ k, v, prevV, cur, prev, invert, sub }) {
  return (
    <div className="panel stat">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
      <span className="small muted">
        {prevV !== undefined && <>poprz.: {prevV} </>}
        <Delta cur={cur} prev={prev} invert={invert} />
      </span>
      {sub && <span className="small muted">{sub}</span>}
    </div>
  );
}

// słupki tygodniowe: leady (wysokość) + koszt leada nad słupkiem
function WeekBars({ weeks, cur }) {
  const max = Math.max(1, ...weeks.map((w) => w.leads));
  return (
    <>
      <div className="cs-weeks">
        {weeks.map((w) => (
          <div key={w.week} className="cs-wcol" title={`Tydzień od ${w.week}${w.partial ? " (niepełny)" : ""}\nleady: ${w.leads}\ngorące: ${w.hot}${w.spend !== null ? `\nwydatki: ${money(w.spend, cur)}\nkoszt leada: ${money(w.cpl, cur)}` : ""}`}>
            <span className="cs-wval">{w.leads}</span>
            <div className={"cs-wbar" + (w.partial ? " partial" : "")} style={{ height: `${(w.leads / max) * 100}%` }} />
            <span className="cs-wlbl">{fmtDay(w.week)}</span>
            {w.cpl !== null && <span className="cs-wcpl">{money(w.cpl, cur)}</span>}
          </div>
        ))}
      </div>
      <div className="small muted" style={{ marginTop: 8 }}>
        Liczba leadów w tygodniu (pn–nd){weeks.some((w) => w.cpl !== null) ? " · pod słupkiem koszt leada" : ""} · jaśniejszy słupek = tydzień niepełny
      </div>
    </>
  );
}

function DayBars({ days, cur }) {
  const max = Math.max(1, ...days.map((d) => d.leads));
  return (
    <>
      <div className="bars" style={{ height: 110 }}>
        {days.map((d) => (
          <div key={d.date} className="bar" style={{ height: `${(d.leads / max) * 100}%` }}
            title={`${d.date}\nleady: ${d.leads}\ngorące: ${d.hot}${d.spend !== null ? `\nwydatki: ${money(d.spend, cur)}` : ""}`} />
        ))}
      </div>
      {days.length > 0 && (
        <div className="row between small muted" style={{ marginTop: 6 }}>
          <span>{fmtDay(days[0].date)}</span><span>{fmtDay(days[days.length - 1].date)}</span>
        </div>
      )}
    </>
  );
}

const TREND = {
  lepiej: { label: "Lepiej", cls: "v-good" }, gorzej: { label: "Gorzej", cls: "v-bad" },
  stabilnie: { label: "Stabilnie", cls: "v-mid" }, nowa: { label: "Nowa", cls: "v-mid" }, zatrzymana: { label: "Zatrzymana", cls: "v-warn" },
};

function AiPanel({ ai, busy, err, onRun }) {
  const r = ai?.status === "done" ? ai.result : null;
  const running = busy || ai?.status === "queued" || ai?.status === "running";
  return (
    <div className="panel cs-ai" style={{ marginBottom: 18 }}>
      <div className="row between" style={{ marginBottom: r || running ? 12 : 0 }}>
        <h3 style={{ margin: 0 }}><IconSpark size={13} /> Komentarz AI — co się zmieniło</h3>
        <div className="row" style={{ gap: 10 }}>
          {ai?.finished_at && ai.status === "done" && <span className="small muted">z {fmtDateTime(ai.finished_at)}{ai.stale ? " · dane od tego czasu się zmieniły" : ""}</span>}
          <button className="btn sm primary" disabled={running} onClick={onRun}>
            {running ? <><span className="spin" style={{ width: 12, height: 12 }} /> AI analizuje…</> : r ? "Odśwież komentarz" : "Generuj komentarz AI"}
          </button>
        </div>
      </div>
      {running && <div className="small muted">Barabash AI czyta liczby kampanii i porównuje z poprzednim okresem — zwykle 1–2 minuty. Możesz zostać na stronie, wynik pojawi się sam.</div>}
      {!running && !r && !err && ai?.status !== "error" && <div className="small muted" style={{ marginTop: 6 }}>AI przeanalizuje wybrany okres: mniej/więcej leadów, droższe/tańsze leady, które kampanie ciągną wynik i co poprawić.</div>}
      {(err || ai?.status === "error") && <div className="err" style={{ marginTop: 8 }}>Nie udało się wygenerować komentarza: {err || ai?.error}</div>}
      {r && !running && (
        <>
          {r.headline && <div className="cs-headline">{r.headline}</div>}
          {r.summary && <p className="cs-summary">{r.summary}</p>}
          <div className="grid cols-2 sr-rec" style={{ gap: 18 }}>
            {r.alerts?.length > 0 && <div><b className="small amber-t">Na co uważać</b><ul>{r.alerts.map((a, i) => <li key={i}>{a}</li>)}</ul></div>}
            {r.actions?.length > 0 && <div><b className="small green-t">Co zrobić</b><ul>{r.actions.map((a, i) => <li key={i}>{a}</li>)}</ul></div>}
          </div>
          {r.campaigns?.length > 0 && (
            <div className="cs-aicamps">
              {r.campaigns.map((c, i) => (
                <div key={i} className="cs-aicamp">
                  <div className="row" style={{ gap: 8, marginBottom: 4 }}>
                    <span className={"sr-verdict " + (TREND[c.trend]?.cls ?? "v-mid")}>{TREND[c.trend]?.label ?? c.trend}</span>
                    <b className="small">{brk(c.name)}</b>
                  </div>
                  <div className="small">{c.comment}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const COLS = [
  { key: "campaign_name", label: "Kampania" },
  { key: "leads", label: "Leady" },
  { key: "spend", label: "Wydatki", title: "Wydatki z Meta Ads w wybranym okresie" },
  { key: "cpl", label: "Koszt leada", title: "Wydatki / leady, które wpadły do systemu" },
  { key: "ctr", label: "CTR", spend: true },
  { key: "cpm", label: "CPM", spend: true },
  { key: "contact_pct", label: "Kontakt" },
  { key: "hot", label: "Gorące" },
  { key: "cost_hot", label: "Koszt gorącego", spend: true },
  { key: "bad", label: "Błędne" },
  { key: "last_lead", label: "Ostatni lead" },
];

export default function Campaigns() {
  const { user } = useAuth();
  const [range, setRange] = useState(() => ({ ...EXTRA[1].get(), preset: "lw" }));
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState({ key: "leads", dir: -1 });
  const [open, setOpen] = useState({});
  const [ai, setAi] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState("");
  const [syncing, setSyncing] = useState(false);
  const poll = useRef(null);

  const load = () => {
    setLoading(true); setErr("");
    return api("cs.report", { from: range.from, to: range.to })
      .then((r) => { setD(r); setAi(r.ai); setAiErr(""); if (r.ai && (r.ai.status === "queued" || r.ai.status === "running")) startPoll(r.ai.id); })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { stopPoll(); load(); }, [range.from, range.to]);
  useEffect(() => stopPoll, []);

  function stopPoll() { if (poll.current) { clearInterval(poll.current); poll.current = null; } }
  function startPoll(id) {
    stopPoll();
    const t0 = Date.now();
    poll.current = setInterval(async () => {
      try {
        const { note } = await api("cs.aiGet", { id });
        if (!note) return;
        if (note.status === "done" || note.status === "error") { stopPoll(); setAi({ ...note, stale: false }); setAiBusy(false); }
        else if (Date.now() - t0 > 5 * 60_000) { stopPoll(); setAiBusy(false); setAiErr("AI nie odpowiedziało w 5 min — spróbuj ponownie."); }
      } catch { /* kolejna próba */ }
    }, 5000);
  }
  const runAi = async () => {
    setAiBusy(true); setAiErr("");
    try {
      const r = await api("cs.ai", { from: range.from, to: range.to, force: !!ai && !ai.stale && ai.status === "done" });
      setAi({ id: r.id, status: r.status });
      startPoll(r.id);
    } catch (e) { setAiErr(e.message); setAiBusy(false); }
  };
  const sync = async () => {
    setSyncing(true);
    try { await api("cs.sync", {}); await load(); } catch (e) { setErr(e.message); } finally { setSyncing(false); }
  };

  const cur = d?.currency ?? "PLN";
  const rows = useMemo(() => {
    if (!d) return [];
    const v = (r) => r[sort.key] ?? (typeof r[sort.key] === "string" ? "" : -Infinity);
    return [...d.campaigns].sort((a, b) => {
      const x = v(a), y = v(b);
      return (typeof x === "string" ? String(x).localeCompare(String(y)) : x - y) * sort.dir;
    });
  }, [d, sort]);
  const cols = COLS.filter((c) => !c.spend || d?.hasSpend);

  const exportCsv = () => downloadCsv(`kampanie_${range.from}_${range.to}.csv`, rows, [
    { label: "Kampania", get: (r) => r.campaign_name },
    { label: "Stan", get: (r) => r.state },
    { label: "Leady", get: (r) => r.leads },
    { label: "Leady poprz.", get: (r) => r.prev?.leads ?? 0 },
    { label: "Leady wg Meta", get: (r) => r.fb_leads },
    { label: "Wydatki", get: (r) => r.spend },
    { label: "Wydatki poprz.", get: (r) => r.prev?.spend },
    { label: "Koszt leada", get: (r) => r.cpl },
    { label: "Koszt leada poprz.", get: (r) => r.prev?.cpl },
    { label: "Wyświetlenia", get: (r) => r.impressions },
    { label: "Kliknięcia", get: (r) => r.clicks },
    { label: "CTR %", get: (r) => r.ctr },
    { label: "CPM", get: (r) => r.cpm },
    { label: "Kontakt %", get: (r) => r.contact_pct },
    { label: "Gorące", get: (r) => r.hot },
    { label: "Kupione", get: (r) => r.bought },
    { label: "Błędne", get: (r) => r.bad },
    { label: "Koszt gorącego", get: (r) => r.cost_hot },
  ]);

  const t = d?.total, p = d?.prevTotal;
  const extraBtns = EXTRA.map((x) => (
    <button key={x.key} className={"btn sm" + (range.preset === x.key ? " primary" : "")} onClick={() => setRange({ ...x.get(), preset: x.key })}>{x.label}</button>
  ));

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Kampanie</h1>
          <div className="sub">Statystyki kampanii Facebook — leady, wydatki, koszt leada, jakość i komentarz AI. Porównanie z poprzednim okresem tej samej długości.</div>
        </div>
        {d && <button className="btn sm" onClick={exportCsv}><IconDownload size={13} /> CSV</button>}
      </div>

      <RangeBar range={range} setRange={setRange}>{extraBtns}</RangeBar>

      {err && <div className="err" style={{ marginBottom: 14 }}>{err}</div>}

      {d && !d.hasSpend && (
        <div className="panel cs-warn" style={{ marginBottom: 18 }}>
          <div className="row between">
            <div>
              <b>Brak danych o wydatkach z Meta</b> — koszt leada, CTR i CPM pojawią się automatycznie, gdy token Meta dostanie dostęp do konta reklamowego (uprawnienie <code>ads_read</code>). Liczby leadów i jakości działają już teraz.
              {d.sync?.error && <div className="small muted" style={{ marginTop: 6 }}>Ostatnia próba ({fmtDateTime(d.sync.at)}): {d.sync.error}</div>}
            </div>
            {user.role === "admin" && <button className="btn sm" disabled={syncing} onClick={sync}>{syncing ? "Sprawdzam…" : "Sprawdź ponownie"}</button>}
          </div>
        </div>
      )}

      {loading && !d && <><SkelCards n={4} /><div style={{ height: 18 }} /><SkelPanel height={220} /></>}

      {d && (
        <div style={{ opacity: loading ? 0.55 : 1, transition: "opacity .2s" }}>
          <div className="small muted" style={{ marginBottom: 10 }}>
            Okres: <b>{d.range.from} — {d.range.to}</b> ({d.range.days} dni) · porównanie z: {d.prevRange.from} — {d.prevRange.to}
            {d.hasSpend && d.sync?.at && <> · wydatki z Meta zsynchronizowane {fmtDateTime(d.sync.at)}</>}
          </div>
          <div className="grid cols-4" style={{ marginBottom: 18 }}>
            <Kpi k="Leady" v={num(t.leads)} prevV={num(p.leads)} cur={t.leads} prev={p.leads} />
            <Kpi k="Wydatki" v={money(t.spend, cur)} prevV={d.hasSpend ? money(p.spend, cur) : undefined} cur={t.spend} prev={p.spend} invert
              sub={!d.hasSpend ? "brak danych z Meta" : null} />
            <Kpi k="Koszt leada (CPL)" v={money(t.cpl, cur, true)} prevV={d.hasSpend ? money(p.cpl, cur, true) : undefined} cur={t.cpl} prev={p.cpl} invert
              sub={!d.hasSpend ? "wydatki / leady" : null} />
            <Kpi k="Kontakt z leadem" v={pctS(t.contact_pct)} prevV={pctS(p.contact_pct)} cur={t.contact_pct} prev={p.contact_pct}
              sub="telefon (Ringostat) lub notatka w Pipedrive" />
            <Kpi k="Gorące / kupione" v={`${t.hot} / ${t.bought}`} prevV={`${p.hot} / ${p.bought}`} cur={t.hot} prev={p.hot}
              sub={`ocena AI z rozmów · ocenionych ${t.analyzed} z ${t.leads}`} />
            <Kpi k="Koszt gorącego leada" v={money(t.cost_hot, cur)} prevV={d.hasSpend ? money(p.cost_hot, cur) : undefined} cur={t.cost_hot} prev={p.cost_hot} invert />
            <Kpi k="CTR (link)" v={ctrS(t.ctr)} prevV={d.hasSpend ? ctrS(p.ctr) : undefined} cur={t.ctr} prev={p.ctr} />
            <Kpi k="CPM" v={money(t.cpm, cur, true)} prevV={d.hasSpend ? money(p.cpm, cur, true) : undefined} cur={t.cpm} prev={p.cpm} invert
              sub={d.hasSpend ? `leady wg Meta: ${num(t.fb_leads)}` : null} />
          </div>

          <AiPanel ai={ai} busy={aiBusy} err={aiErr} onRun={runAi} />

          <div className="grid" style={{ gridTemplateColumns: "1.3fr 1fr", marginBottom: 18 }}>
            <div className="panel"><h3>Trend tygodniowy — ostatnie 12 tygodni</h3><WeekBars weeks={d.weeks} cur={cur} /></div>
            <div className="panel"><h3>Leady dzień po dniu (wybrany okres)</h3><DayBars days={d.days} cur={cur} /></div>
          </div>

          <div className="panel" style={{ marginBottom: 18 }}>
            <h3>Kampanie — kliknij wiersz, aby zobaczyć grupy reklam</h3>
            <div className="sr-scroll">
              <table className="tbl sr-tbl cs-tbl">
                <thead>
                  <tr>
                    {cols.map((c) => (
                      <th key={c.key} title={c.title && !d?.hasSpend ? `${c.title} — pojawi się po podłączeniu danych z Meta` : c.title} className="clickable nowrap" onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? -s.dir : c.key === "campaign_name" ? 1 : -1 }))}>
                        {c.label}{sort.key === c.key ? (sort.dir > 0 ? " ▲" : " ▼") : ""}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && <tr><td colSpan={cols.length} className="muted">Brak leadów i wydatków w tym okresie</td></tr>}
                  {rows.map((r) => (
                    <Fragment key={r.campaign_id}>
                      <tr className="clickable" onClick={() => setOpen((o) => ({ ...o, [r.campaign_id]: !o[r.campaign_id] }))}>
                        {cols.map((c) => <Cell key={c.key} c={c} r={r} cur={cur} isOpen={!!open[r.campaign_id]} />)}
                      </tr>
                      {open[r.campaign_id] && r.adsets.map((a) => (
                        <tr key={a.adset_id} className="cs-sub">
                          {cols.map((c) => <Cell key={c.key} c={c} r={a} cur={cur} sub />)}
                        </tr>
                      ))}
                      {open[r.campaign_id] && r.adsets.length === 0 && <tr className="cs-sub"><td colSpan={cols.length} className="muted small">Brak grup reklam w tym okresie</td></tr>}
                    </Fragment>
                  ))}
                  {rows.length > 0 && (
                    <tr className="sr-total">
                      {cols.map((c) => <Cell key={c.key} c={c} r={{ ...t, campaign_name: "Razem", last_lead: null, prev: p }} cur={cur} total />)}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="small muted" style={{ marginTop: 10 }}>
              Leady = zgłoszenia, które realnie wpadły do systemu (bez pominiętych). Kontakt = telefon w Ringostat lub notatka handlowca w Pipedrive.
              Gorące = ocena AI z rozmów i notatek (Raport AI kampanii) — dolna granica, świeże leady mogą czekać na ocenę.
            </div>
          </div>

          <div className="panel">
            <h3>Tydzień po tygodniu</h3>
            <table className="tbl">
              <thead><tr><th>Tydzień</th><th>Leady</th><th>Zmiana</th>{d.hasSpend && <><th>Wydatki</th><th>Koszt leada</th><th>Zmiana CPL</th></>}<th>Gorące</th></tr></thead>
              <tbody>
                {[...d.weeks].reverse().map((w, i, arr) => {
                  const pw = arr[i + 1];
                  return (
                    <tr key={w.week}>
                      <td className="nowrap">{fmtDay(w.week)} – {fmtDay(addDays(w.week, 6))}{w.partial ? <span className="small muted"> (niepełny)</span> : ""}</td>
                      <td><b>{w.leads}</b></td>
                      <td>{pw && <Delta cur={w.leads} prev={pw.leads} small />}</td>
                      {d.hasSpend && <><td>{money(w.spend, cur)}</td><td>{money(w.cpl, cur, true)}</td><td>{pw && <Delta cur={w.cpl} prev={pw.cpl} invert small />}</td></>}
                      <td>{w.hot}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

const STATE = { nowa: "nowa", zatrzymana: "brak leadów" };

function Cell({ c, r, cur, sub, total, isOpen }) {
  const pr = r.prev;
  switch (c.key) {
    case "campaign_name":
      return (
        <td>
          {sub ? <span className="small muted">↳ {brk(r.adset_name)}</span> : <b>{!total && (isOpen ? "▾ " : "▸ ")}{brk(r.campaign_name)}</b>}
          {!sub && !total && STATE[r.state] && <span className="sr-chip ghost" style={{ marginLeft: 6 }}>{STATE[r.state]}</span>}
        </td>
      );
    case "leads":
      return <td><b>{r.leads}</b>{!sub && pr !== undefined && <div><Delta cur={r.leads} prev={pr?.leads ?? 0} small /></div>}</td>;
    case "spend":
      return <td>{money(r.spend, cur)}{!sub && pr && <div><Delta cur={r.spend} prev={pr.spend} invert small /></div>}</td>;
    case "cpl":
      return <td><b>{money(r.cpl, cur, true)}</b>{!sub && pr && <div><Delta cur={r.cpl} prev={pr.cpl} invert small /></div>}</td>;
    case "ctr": return <td>{ctrS(r.ctr)}</td>;
    case "cpm": return <td>{money(r.cpm, cur, true)}</td>;
    case "contact_pct": return <td>{sub ? (r.leads ? pctS(Math.round((r.contacted / r.leads) * 100)) : "—") : pctS(r.contact_pct)}</td>;
    case "hot": return <td>{r.hot}{r.bought ? <span className="small green-t"> ({r.bought} kup.)</span> : ""}</td>;
    case "cost_hot": return <td>{money(r.cost_hot, cur)}</td>;
    case "bad": return <td className={r.bad ? "amber-t" : ""}>{r.bad}</td>;
    case "last_lead": return <td className="small muted">{r.last_lead ? fmtDay(r.last_lead) : "—"}</td>;
    default: return <td />;
  }
}
