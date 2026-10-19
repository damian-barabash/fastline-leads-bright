import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api.js";
import { useAuth } from "../../auth.jsx";
import { SkelPanel } from "../../components/Skeleton.jsx";
import { IconExternal, IconSpark, IconTrash } from "../../components/Icons.jsx";
import { daysAgo, fmtDateTime, iso, pct } from "./shared.jsx";

// Raport AI kampanii: każdy lead przeanalizowany przez Barabash AI (rozmowy + notatki handlowców + formularz),
// liczby per kampania / grupa reklam / reklama / odpowiedź w formularzu + wnioski do ustawienia kampanii.

export const STATUS = {
  kupil: { label: "Kupił", color: "#35c46b" },
  goracy: { label: "Gorący", color: "#ff3b47" },
  cieply: { label: "Ciepły", color: "#f0a92c" },
  zimny: { label: "Zimny", color: "#6aa5ff" },
  niezainteresowany: { label: "Niezainteresowany", color: "#8c6f75" },
  bledny: { label: "Błędny lead", color: "#b05cff" },
  bez_opisu: { label: "Rozmowa bez notatek", color: "#5d4a4f" },
  nieosiagalny: { label: "Nie odebrał", color: "#3d2e32" },
  brak_kontaktu: { label: "Brak kontaktu", color: "#2a1f22" },
  w_analizie: { label: "W analizie", color: "#1d1517" },
};
const ORDER = Object.keys(STATUS);
const OBJ = {
  cena: "Cena / za drogo", termin: "Termin", lokalizacja: "Lokalizacja toru", odleglosc_dojazd: "Dojazd / odległość", brak_czasu: "Brak czasu",
  tylko_przeglada: "Tylko się rozgląda", decyzja_innej_osoby: "Decyduje ktoś inny", pogoda_sezon: "Pogoda / sezon", inny_produkt: "Chce innego produktu",
  konkurencja: "Konkurencja", brak_auta: "Brak auta", bezpieczenstwo: "Bezpieczeństwo / ryzyko", zdrowie_wiek: "Zdrowie / wiek", inne: "Inne",
};
const PRICE = { akceptuje: "Akceptuje cenę", negocjuje: "Negocjuje", za_drogo: "Za drogo", nie_rozmawiano: "Nie rozmawiano o cenie" };
const QUAL = { dobry: "Dobry", sredni: "Średni", slaby: "Słaby", nieprawidlowy: "Nieprawidłowy" };
const ISSUE = {
  falszywy_numer: "Fałszywy numer", nie_pamieta_zgloszenia: "Nie pamięta zgłoszenia", przypadkowe_zgloszenie: "Przypadkowe zgłoszenie",
  niepelnoletni: "Niepełnoletni", zly_kraj_jezyk: "Inny kraj / język", szuka_czegos_innego: "Szuka czegoś innego", duplikat: "Duplikat",
};
const INTENT = { dla_siebie: "Dla siebie", prezent: "Prezent", firma: "Firma", grupa_znajomych: "Grupa znajomych", nieznany: "Nieznany" };
const VERDICT = {
  skaluj: { label: "Skaluj", cls: "v-good" }, optymalizuj: { label: "Optymalizuj", cls: "v-mid" },
  zmien_grupe: { label: "Zmień grupę odbiorców", cls: "v-warn" }, zmien_oferte: { label: "Zmień ofertę", cls: "v-warn" },
  wstrzymaj: { label: "Wstrzymaj", cls: "v-bad" },
};
const lbl = (map, k) => map[k] ?? String(k ?? "—").replace(/_/g, " ");
const fmtH = (h) => (h === null || h === undefined ? "—" : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`);

function StatusBar({ m, onPick }) {
  const total = Math.max(1, m.leads);
  return (
    <div>
      <div className="sr-bar">
        {ORDER.map((k) => {
          const n = m.statuses?.[k] ?? 0;
          if (!n) return null;
          return <div key={k} className="clickable" style={{ width: `${(n / total) * 100}%`, background: STATUS[k].color }} title={`${STATUS[k].label}: ${n}`} onClick={() => onPick?.({ status: k })} />;
        })}
      </div>
      <div className="row wrap small" style={{ gap: 12, marginTop: 8 }}>
        {ORDER.filter((k) => m.statuses?.[k]).map((k) => (
          <span key={k} className="clickable" onClick={() => onPick?.({ status: k })}>
            <i className="legend" style={{ background: STATUS[k].color }} />{STATUS[k].label} <b>{m.statuses[k]}</b> <span className="muted">({pct(m.statuses[k], m.leads)}%)</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Bars({ data, labels, base, onPick, pickKey }) {
  const rows = Object.entries(data ?? {}).filter(([k]) => k && k !== "null").sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...rows.map((r) => r[1]));
  if (!rows.length) return <div className="muted small">Brak danych</div>;
  return rows.map(([k, n]) => (
    <div key={k} className={onPick ? "clickable" : ""} style={{ marginBottom: 9 }} onClick={() => onPick?.({ [pickKey]: k })}>
      <div className="row between" style={{ marginBottom: 3 }}>
        <span className="small">{lbl(labels, k)}</span>
        <span className="small"><b>{n}</b> <span className="muted">{base ? `${pct(n, base)}%` : ""}</span></span>
      </div>
      <div className="share-track"><div className="share-fill" style={{ width: `${(n / max) * 100}%` }} /></div>
    </div>
  ));
}

// procenty liczone od leadów z rozmową przeanalizowaną przez AI
const rate = (n, m) => (m.analyzed ? `${pct(n, m.analyzed)}%` : "—");
function MetricCells({ m }) {
  return (
    <>
      <td>{m.leads}</td>
      <td>{pct(m.contacted, m.leads)}%</td>
      <td>{m.analyzed}</td>
      <td className="green-t">{m.bought || "—"}</td>
      <td><b>{rate(m.hot + m.warm, m)}</b></td>
      <td>{rate(m.notInterested + m.cold, m)}</td>
      <td className={pct(m.invalid, m.analyzed) >= 15 ? "red-t" : ""}>{rate(m.invalid, m)}</td>
      <td className={pct(m.tooExpensive, m.analyzed) >= 20 ? "amber-t" : ""}>{rate(m.tooExpensive, m)}</td>
      <td>{m.avgInterest ?? "—"}</td>
      <td>{pct(m.unreachable + m.noContact, m.leads)}%</td>
    </>
  );
}
const METRIC_HEAD = (
  <>
    <th title="Liczba leadów">Leady</th><th title="Dzwoniono lub jest wpis w CRM">Kontakt</th><th title="Leady z rozmową przeanalizowaną przez AI">Rozmowy AI</th>
    <th>Kupił</th><th title="% rozmów AI">Gorący + ciepły</th><th title="% rozmów AI">Zimny + niezaint.</th><th title="% rozmów AI">Błędne</th>
    <th title="% rozmów AI">Za drogo</th><th title="Średnie zainteresowanie 0–10">Zaint.</th><th title="% wszystkich leadów">Bez rozmowy</th>
  </>
);

function Recs({ title, items }) {
  const list = Array.isArray(items) ? items : items ? [items] : [];
  if (!list.length) return null;
  return (
    <div className="sr-rec">
      <span className="ai-k">{title}</span>
      <ul>{list.map((x, i) => <li key={i}>{String(x)}</li>)}</ul>
    </div>
  );
}

function LeadList({ leads, filter, setFilter }) {
  const [limit, setLimit] = useState(30);
  useEffect(() => setLimit(30), [filter]);
  const list = leads.filter((l) =>
    (!filter.status || (l.status ?? "w_analizie") === filter.status) &&
    (!filter.objection || l.objections.includes(filter.objection)) &&
    (!filter.price || l.price === filter.price) &&
    (!filter.issue || l.issues.includes(filter.issue)) &&
    (!filter.intent || l.intent === filter.intent) &&
    (!filter.adset || l.adset === filter.adset) && (!filter.ad || l.ad === filter.ad))
    .sort((a, b) => (b.interest ?? -1) - (a.interest ?? -1));
  const desc = Object.entries(filter).map(([k, v]) => (k === "status" ? STATUS[v]?.label : k === "objection" ? lbl(OBJ, v) : k === "price" ? lbl(PRICE, v) : k === "issue" ? lbl(ISSUE, v) : k === "intent" ? lbl(INTENT, v) : v)).join(" · ");
  return (
    <div>
      <div className="row wrap no-print" style={{ gap: 8, marginBottom: 10 }}>
        {[["Do domknięcia", { status: "goracy" }], ["Ciepłe", { status: "cieply" }], ["Kupili", { status: "kupil" }], ["Za drogo", { price: "za_drogo" }],
          ["Niezainteresowani", { status: "niezainteresowany" }], ["Błędne", { status: "bledny" }], ["Bez notatek", { status: "bez_opisu" }], ["Brak kontaktu", { status: "brak_kontaktu" }]]
          .map(([t, f]) => (
            <button key={t} className={"btn sm" + (JSON.stringify(f) === JSON.stringify(filter) ? " primary" : "")} onClick={() => setFilter(f)}>{t}</button>
          ))}
        {desc && <span className="small muted">Filtr: <b>{desc}</b> — {list.length} leadów</span>}
      </div>
      <div className="grid" style={{ gap: 8 }}>
        {list.slice(0, limit).map((l) => (
          <div key={l.id} className="sr-lead">
            <div className="row between" style={{ gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <b>{l.name || "(bez nazwy)"}</b>
                <span className="sr-chip" style={{ background: STATUS[l.status ?? "w_analizie"]?.color }}>{STATUS[l.status ?? "w_analizie"]?.label}</span>
                {l.interest !== null && <span className="sr-chip ghost">zainteresowanie {l.interest}/10</span>}
                {l.price && l.price !== "nie_rozmawiano" && <span className="sr-chip ghost">{lbl(PRICE, l.price)}</span>}
                {l.intent && l.intent !== "nieznany" && <span className="sr-chip ghost">{lbl(INTENT, l.intent)}</span>}
                <div className="small muted">{fmtDateTime(l.received_at)} · {l.adset} / {l.ad}{l.employees?.length ? ` · ${l.employees.join(", ")}` : ""}{l.calls?.answered ? ` · ${l.calls.answered} rozm.` : ""}</div>
              </div>
              {l.pdUrl && <a className="link small nowrap no-print" href={l.pdUrl} target="_blank" rel="noreferrer">Pipedrive <IconExternal /></a>}
            </div>
            {l.persona && <div className="small" style={{ marginTop: 6 }}><span className="muted">Kto: </span>{l.persona}{l.budget ? ` · budżet: ${l.budget}` : ""}</div>}
            {l.insight && <div className="small" style={{ marginTop: 3 }}><span className="muted">Wniosek: </span>{l.insight}</div>}
            {(l.quotes ?? []).length > 0 && <div className="small" style={{ marginTop: 3 }}>{l.quotes.map((q, i) => <div key={i}><span className="sr-chip ghost">{lbl(OBJ, q.type)}</span> „{q.quote}”</div>)}</div>}
            {l.lostReason && <div className="small" style={{ marginTop: 3 }}><span className="muted">Dlaczego nie: </span>{l.lostReason}</div>}
            {l.nextStep && <div className="small" style={{ marginTop: 3 }}><span className="muted">Dalej: </span>{l.nextStep}</div>}
          </div>
        ))}
        {list.length === 0 && <div className="muted small">Brak leadów dla tego filtra.</div>}
        {list.length > limit && <button className="btn no-print" onClick={() => setLimit(limit + 30)}>Pokaż kolejne ({list.length - limit})</button>}
      </div>
    </div>
  );
}

function SegmentTable({ rows, onPick, kind }) {
  return (
    <table className="tbl">
      <thead><tr><th>{kind === "adset" ? "Grupa reklam" : kind === "ad" ? "Reklama" : "Odpowiedź"}</th>{METRIC_HEAD}</tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name ?? r.answer} className={onPick ? "clickable" : ""} onClick={() => onPick?.(r)}>
            <td><b>{r.name ?? r.answer}</b></td><MetricCells m={r} />
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CampaignCard({ c, ai, leads, open, onToggle }) {
  // domyślnie pierwsza niepusta grupa: gorący → ciepły → kupił
  const [filter, setFilter] = useState(() => ({ status: ["goracy", "cieply", "kupil"].find((k) => c.statuses?.[k]) ?? "goracy" }));
  const [seg, setSeg] = useState("adset");
  const [quoteType, setQuoteType] = useState(null);
  const listRef = useRef(null);
  const v = VERDICT[ai?.verdict];
  const pick = (f) => { setFilter(f); setTimeout(() => listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); };
  const myLeads = useMemo(() => leads.filter((l) => l.campaign === c.name), [leads, c.name]);
  return (
    <div className="panel sr-card">
      <div className="row between clickable" style={{ gap: 12 }} onClick={onToggle}>
        <div style={{ minWidth: 0 }}>
          <div className="row wrap" style={{ gap: 8 }}>
            <h3 style={{ margin: 0 }}>{c.name}</h3>
            {v && <span className={"sr-verdict " + v.cls}>{v.label}</span>}
            {typeof ai?.quality_score === "number" && <span className="score-pill sm">{ai.quality_score}<small>/100</small></span>}
          </div>
          <div className="small muted" style={{ marginTop: 4 }}>
            {c.leads} leadów · rozmowy AI {c.analyzed} · gorący+ciepły {rate(c.hot + c.warm, c)} · kupiło {c.bought}{c.dealsValue ? ` (${c.dealsValue.toLocaleString("pl-PL")} zł)` : ""} · za drogo {rate(c.tooExpensive, c)}
          </div>
          {ai?.headline && <div style={{ marginTop: 6 }}><IconSpark size={12} /> <b>{ai.headline}</b></div>}
        </div>
        <span className="muted no-print">{open ? "▲" : "▼"}</span>
      </div>

      {open && (
        <div className="grid" style={{ gap: 16, marginTop: 16 }}>
          <StatusBar m={c} onPick={pick} />

          {ai && !ai.error && (
            <div className="ai-box">
              {ai.summary && <div className="ai-v" style={{ marginBottom: 10 }}>{ai.summary}</div>}
              <div className="grid cols-2" style={{ gap: 14 }}>
                <div className="sr-rec"><span className="ai-k">Kto kupuje / jest gorący</span><div className="ai-v">{ai.who_buys || "—"}</div></div>
                <div className="sr-rec"><span className="ai-k">Kto marnuje budżet</span><div className="ai-v">{ai.who_wastes || "—"}</div></div>
                <Recs title="Grupa odbiorców — co zmienić" items={ai.audience} />
                <Recs title="Kreacja i komunikat" items={ai.creative} />
                <Recs title="Formularz" items={ai.form} />
                <Recs title="Sprzedaż — wskazówki dla handlowców" items={ai.sales} />
                {ai.pricing && <div className="sr-rec"><span className="ai-k">Cena</span><div className="ai-v">{ai.pricing}</div></div>}
                <Recs title="Pilne" items={ai.alerts} />
              </div>
            </div>
          )}
          {ai?.error && <div className="err small">Wnioski AI: {ai.error}</div>}
          {!ai && c.analyzed < 3 && <div className="muted small">Za mało przeanalizowanych rozmów na wnioski AI (min. 3).</div>}

          <div className="grid cols-3">
            <div className="panel inner">
              <h3>Zastrzeżenia klientów <span className="muted small">(% rozmów AI)</span></h3>
              <Bars data={c.objections} labels={OBJ} base={c.analyzed} pickKey="objection" onPick={(f) => { setQuoteType(f.objection); pick(f); }} />
            </div>
            <div className="panel inner">
              <h3>Reakcja na cenę</h3>
              <Bars data={c.price} labels={PRICE} base={c.analyzed} pickKey="price" onPick={pick} />
              <h3 style={{ marginTop: 16 }}>Cel zakupu</h3>
              <Bars data={c.intents} labels={INTENT} base={c.analyzed} pickKey="intent" onPick={pick} />
            </div>
            <div className="panel inner">
              <h3>Jakość leadów</h3>
              <Bars data={c.quality} labels={QUAL} base={c.analyzed} />
              <h3 style={{ marginTop: 16 }}>Problemy z leadami</h3>
              <Bars data={c.issues} labels={ISSUE} base={c.analyzed} pickKey="issue" onPick={pick} />
              <div className="small muted" style={{ marginTop: 10 }}>Pierwszy telefon: mediana {fmtH(c.medianFirstCallH)} od zgłoszenia</div>
            </div>
          </div>

          {Object.keys(c.quotes ?? {}).length > 0 && (
            <div className="panel inner">
              <h3>Co mówią klienci</h3>
              <div className="row wrap no-print" style={{ gap: 6, marginBottom: 10 }}>
                {Object.keys(c.quotes).sort((a, b) => (c.objections[b] ?? 0) - (c.objections[a] ?? 0)).map((t) => (
                  <button key={t} className={"btn sm" + ((quoteType ?? Object.keys(c.quotes)[0]) === t ? " primary" : "")} onClick={() => setQuoteType(t)}>{lbl(OBJ, t)} ({c.objections[t] ?? 0})</button>
                ))}
              </div>
              {(c.quotes[quoteType ?? Object.keys(c.quotes).sort((a, b) => (c.objections[b] ?? 0) - (c.objections[a] ?? 0))[0]] ?? []).map((q, i) => (
                <div key={i} className="sr-quote">„{q.quote}” <span className="muted small">— {q.lead}</span></div>
              ))}
            </div>
          )}

          <div className="panel inner" style={{ padding: 0, overflow: "hidden" }}>
            <div className="row" style={{ gap: 8, padding: "14px 16px 6px" }}>
              <h3 style={{ margin: 0, marginRight: 10 }}>Wyniki wg</h3>
              <button className={"btn sm" + (seg === "adset" ? " primary" : "")} onClick={() => setSeg("adset")}>Grupy reklam ({c.adsets.length})</button>
              <button className={"btn sm" + (seg === "ad" ? " primary" : "")} onClick={() => setSeg("ad")}>Reklamy ({c.ads.length})</button>
              <button className={"btn sm" + (seg === "emp" ? " primary" : "")} onClick={() => setSeg("emp")}>Handlowcy ({c.employees.length})</button>
            </div>
            {seg === "adset" && <SegmentTable rows={c.adsets} kind="adset" onPick={(r) => pick({ adset: r.name })} />}
            {seg === "ad" && <SegmentTable rows={c.ads} kind="ad" onPick={(r) => pick({ ad: r.name })} />}
            {seg === "emp" && <SegmentTable rows={c.employees} kind="emp" />}
          </div>

          {c.formAnswers.map((q) => (
            <div key={q.question} className="panel inner" style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ padding: "14px 16px 6px" }}><h3 style={{ margin: 0 }}>Formularz: „{q.question}”</h3></div>
              <SegmentTable rows={q.answers} kind="answer" />
            </div>
          ))}

          <div className="panel inner" ref={listRef}>
            <h3>Leady</h3>
            <LeadList leads={myLeads} filter={filter} setFilter={setFilter} />
          </div>
        </div>
      )}
    </div>
  );
}

function ReportView({ id, onDeleted }) {
  const { user } = useAuth();
  const [rep, setRep] = useState(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState({});
  useEffect(() => {
    let alive = true, t;
    const load = () => api("smart.get", { id }).then((r) => {
      if (!alive) return;
      setRep(r.report);
      if (!["done", "error"].includes(r.report.status)) t = setTimeout(load, 4000);
    }).catch((e) => alive && setErr(e.message));
    setRep(null); setErr(""); load();
    return () => { alive = false; clearTimeout(t); };
  }, [id]);
  useEffect(() => { if (rep?.data?.campaigns?.[0]) setOpen((o) => (Object.keys(o).length ? o : { [rep.data.campaigns[0].name]: true })); }, [rep?.data]);

  if (err) return <div className="err">{err}</div>;
  if (!rep) return <SkelPanel height={300} />;
  const p = rep.params, pr = rep.progress ?? {};
  if (rep.status === "error") return <div className="panel"><div className="err">Błąd raportu: {rep.error}</div></div>;
  if (rep.status !== "done") {
    const frac = pr.stage === "wnioski AI" ? 0.7 + 0.3 * ((pr.ai ?? 0) / Math.max(1, pr.aiTotal ?? 1)) : 0.7 * ((pr.done ?? 0) / Math.max(1, pr.total ?? 1));
    return (
      <div className="panel">
        <h3><IconSpark /> Raport w przygotowaniu — {p.from} → {p.to}</h3>
        <div className="share-track" style={{ height: 10, margin: "14px 0" }}><div className="share-fill" style={{ width: `${Math.round(frac * 100)}%`, transition: "width .6s" }} /></div>
        <div className="small">
          {pr.stage === "wnioski AI" ? `Wnioski AI dla kampanii: ${pr.ai ?? 0} / ${pr.aiTotal ?? "?"}` :
            pr.total ? `Analiza leadów: ${pr.done ?? 0} / ${pr.total} (nowych do analizy AI: ${pr.toAnalyze ?? 0})` : "W kolejce — start w ciągu minuty"}
        </div>
        <div className="small muted" style={{ marginTop: 8 }}>
          Każdy lead z rozmową jest czytany przez Barabash AI (~15–20 s, 3 naraz); wyniki zostają w pamięci, więc kolejne raporty liczą się szybko. Możesz zamknąć tę stronę — raport policzy się w tle.
        </div>
      </div>
    );
  }
  const d = rep.data, res = rep.result ?? {}, ov = res.overall ?? {};
  return (
    <div className="grid" style={{ gap: 18 }}>
      <div className="panel">
        <div className="row between wrap" style={{ gap: 10 }}>
          <div>
            <h3 style={{ margin: 0 }}><IconSpark /> Raport AI kampanii · {p.from} → {p.to}</h3>
            <div className="small muted" style={{ marginTop: 4 }}>
              {p.campaigns?.length ? `${p.campaigns.length} kampanii` : "wszystkie kampanie"} · {d.totals.leads} leadów · {d.totals.analyzed} rozmów przeanalizowanych przez AI · wygenerowano {fmtDateTime(rep.finished_at)} ({rep.created_by})
            </div>
          </div>
          <div className="row no-print" style={{ gap: 8 }}>
            <button className="btn sm" onClick={() => window.print()}>Drukuj / PDF</button>
            {user?.role === "admin" && <button className="btn sm" title="Usuń raport" onClick={async () => { await api("smart.delete", { id }); onDeleted(); }}><IconTrash /></button>}
          </div>
        </div>
        {ov.summary && (
          <div className="ai-box" style={{ marginTop: 16 }}>
            <div className="ai-v" style={{ fontSize: 14.5 }}>{ov.summary}</div>
            <div className="grid cols-2" style={{ gap: 14, marginTop: 12 }}>
              <Recs title="Najważniejsze działania" items={ov.top_actions} />
              <Recs title="Budżet" items={ov.budget} />
              {ov.audience_shift && <div className="sr-rec"><span className="ai-k">Grupy odbiorców</span><div className="ai-v">{ov.audience_shift}</div></div>}
              {ov.sales_process && <div className="sr-rec"><span className="ai-k">Proces sprzedaży</span><div className="ai-v">{ov.sales_process}</div></div>}
            </div>
          </div>
        )}
        {ov.error && <div className="err small" style={{ marginTop: 12 }}>Podsumowanie AI: {ov.error}</div>}
      </div>

      <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "18px 20px 4px" }}><h3>Porównanie kampanii</h3></div>
        <table className="tbl">
          <thead><tr><th>Kampania</th>{METRIC_HEAD}<th>Werdykt AI</th></tr></thead>
          <tbody>
            {d.campaigns.map((c) => {
              const v = VERDICT[res.campaigns?.[c.name]?.verdict];
              return (
                <tr key={c.name} className="clickable" onClick={() => { setOpen({ ...open, [c.name]: true }); document.getElementById("sr-" + c.name)?.scrollIntoView({ behavior: "smooth" }); }}>
                  <td><b className="small">{c.name}</b></td><MetricCells m={c} />
                  <td>{v ? <span className={"sr-verdict " + v.cls}>{v.label}</span> : <span className="muted small">—</span>}</td>
                </tr>
              );
            })}
            <tr className="sr-total"><td><b>Razem</b></td><MetricCells m={d.totals} /><td /></tr>
          </tbody>
        </table>
        <div className="small muted" style={{ padding: "10px 20px 14px" }}>
          Procenty „gorący + ciepły”, „zimny + niezaint.”, „błędne”, „za drogo” — od leadów, z którymi była rozmowa przeanalizowana przez AI. „Bez rozmowy” — nie odebrał lub nikt nie dzwonił, od wszystkich leadów.
        </div>
      </div>

      <div className="panel">
        <h3>Wszystkie kampanie — statusy leadów</h3>
        <StatusBar m={d.totals} />
      </div>

      {d.campaigns.map((c) => (
        <div key={c.name} id={"sr-" + c.name}>
          <CampaignCard c={c} ai={res.campaigns?.[c.name]} leads={d.leads} open={!!open[c.name]} onToggle={() => setOpen({ ...open, [c.name]: !open[c.name] })} />
        </div>
      ))}
    </div>
  );
}

const PRESETS = [["30 dni", 29], ["60 dni", 59], ["90 dni", 89], ["Od początku", null]];

export default function SmartReport() {
  const [opts, setOpts] = useState(null);
  const [list, setList] = useState([]);
  const [sel, setSel] = useState(null);
  const [from, setFrom] = useState(daysAgo(59));
  const [to, setTo] = useState(iso(new Date()));
  const [camps, setCamps] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const loadList = () => api("smart.list").then((r) => { setList(r.rows); return r.rows; });
  useEffect(() => {
    api("smart.options").then((o) => {
      setOpts(o);
      const cutoff = daysAgo(30);
      setCamps(o.campaigns.filter((c) => c.last.slice(0, 10) >= cutoff).map((c) => c.name));
    }).catch((e) => setErr(e.message));
    loadList().then((rows) => { const d = rows.find((r) => r.status === "done") ?? rows[0]; if (d) setSel(d.id); }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!list.some((r) => !["done", "error"].includes(r.status))) return;
    const t = setInterval(loadList, 5000);
    return () => clearInterval(t);
  }, [list]);

  const create = async () => {
    setBusy(true); setErr("");
    try {
      const r = await api("smart.create", { from, to, campaigns: camps.length === opts.campaigns.length ? [] : camps });
      await loadList(); setSel(r.id);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const toggle = (n) => setCamps(camps.includes(n) ? camps.filter((x) => x !== n) : [...camps, n]);
  const inRange = (c) => c.last.slice(0, 10) >= from && c.first.slice(0, 10) <= to;

  return (
    <div className="grid sr" style={{ gap: 18 }}>
      <div className="grid sr-top no-print" style={{ gap: 18 }}>
        <div className="panel">
          <h3><IconSpark /> Nowy raport AI</h3>
          <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
            {PRESETS.map(([t, n]) => (
              <button key={t} className="btn sm" onClick={() => { setFrom(n === null ? "2026-07-06" : daysAgo(n)); setTo(iso(new Date())); }}>{t}</button>
            ))}
            <span className="small muted" style={{ marginLeft: 8 }}>od</span>
            <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} style={{ width: 150, padding: "7px 10px" }} />
            <span className="small muted">do</span>
            <input type="date" value={to} min={from} max={iso(new Date())} onChange={(e) => e.target.value && setTo(e.target.value)} style={{ width: 150, padding: "7px 10px" }} />
          </div>
          <div className="row between" style={{ marginBottom: 6 }}>
            <span className="small muted">Kampanie ({camps.length} wybrane)</span>
            <span className="row" style={{ gap: 6 }}>
              <button className="btn sm ghost" onClick={() => setCamps(opts?.campaigns.filter(inRange).map((c) => c.name) ?? [])}>z okresu</button>
              <button className="btn sm ghost" onClick={() => setCamps(opts?.campaigns.map((c) => c.name) ?? [])}>wszystkie</button>
              <button className="btn sm ghost" onClick={() => setCamps([])}>żadna</button>
            </span>
          </div>
          <div className="sr-camps">
            {(opts?.campaigns ?? []).map((c) => (
              <label key={c.name} className={"chk sr-camp" + (inRange(c) ? "" : " dim")}>
                <input type="checkbox" checked={camps.includes(c.name)} onChange={() => toggle(c.name)} />
                <span className="ellipsis" style={{ flex: 1 }} title={c.name}>{c.name}</span>
                <span className="muted">{c.leads} · ost. {c.last.slice(5, 10).split("-").reverse().join(".")}</span>
              </label>
            ))}
          </div>
          {err && <div className="err small" style={{ marginTop: 10 }}>{err}</div>}
          <div className="row between" style={{ marginTop: 12 }}>
            <span className="small muted">
              {opts ? `Pamięć analiz: ${opts.cache.analyzed} rozmów przeanalizowanych przez AI${opts.cache.bg?.pending ? `, w tle czeka ${opts.cache.bg.pending}` : ""}.` : ""}
            </span>
            <button className="btn primary" disabled={busy || !camps.length || !opts} onClick={create}>{busy ? "Zlecam…" : "Generuj raport"}</button>
          </div>
        </div>
        <div className="panel">
          <h3>Raporty</h3>
          <div className="history" style={{ maxHeight: 330 }}>
            {list.map((r) => (
              <div key={r.id} className={"hist-row" + (sel === r.id ? " current" : "")} onClick={() => setSel(r.id)}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="small"><b>{r.params.from} → {r.params.to}</b></div>
                  <div className="small muted ellipsis" style={{ maxWidth: "100%" }}>
                    {r.params.campaigns?.length ? r.params.campaigns.join(", ") : "wszystkie kampanie"}
                  </div>
                </div>
                <span className={"badge " + (r.status === "done" ? "done" : r.status === "error" ? "failed" : "pending")}>
                  {r.status === "done" ? "gotowy" : r.status === "error" ? "błąd" : r.progress?.stage ?? "w kolejce"}
                </span>
              </div>
            ))}
            {list.length === 0 && <div className="muted small">Brak raportów — wygeneruj pierwszy.</div>}
          </div>
        </div>
      </div>
      {sel && <ReportView id={sel} onDeleted={() => { setSel(null); loadList(); }} />}
    </div>
  );
}
