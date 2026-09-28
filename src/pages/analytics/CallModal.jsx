import { useEffect, useState } from "react";
import { api } from "../../api.js";
import { IconExternal, IconDownload, IconSpark } from "../../components/Icons.jsx";
import {
  Direction, StatusBadge, fmtDateTime, fmtDur, fmtPhone, pdLeadUrl, TYPE_LABEL, REASON_LABEL,
} from "./shared.jsx";

// Karta rozmowy: nagranie, wyniki Ringostat AI, transkrypcja, lead, historia kontaktu, wszystkie pola z API.

const AI_LABELS = {
  title: "Tytuł", summary: "Podsumowanie", client_mood: "Nastrój klienta", employee_mood: "Nastrój handlowca",
  overall_mood: "Ogólny przebieg", sentiment: "Sentyment", recommendations: "Rekomendowane działania",
  key_points: "Kluczowe punkty", next_steps: "Kolejne kroki", mistakes: "Błędy handlowca", good_points: "Mocne strony",
  keywords: "Słowa kluczowe", parasite_words: "Słowa-wypełniacze", obscene_language: "Wulgaryzmy",
  review_score: "Potrzeba ręcznej weryfikacji (1–10)", review_details: "Uzasadnienie weryfikacji",
  followup_points: "Follow-up: główne wnioski", followup_steps: "Follow-up: kto i co dalej",
};
const QUALITY = [
  ["q_opening", "Otwarcie"], ["q_anamnesis", "Wywiad (potrzeby)"], ["q_presentation", "Prezentacja"], ["q_closing", "Zamknięcie"],
];
const AI_ORDER = ["summary", "overall_mood", "client_mood", "employee_mood", "sentiment", "recommendations", "next_steps",
  "key_points", "good_points", "mistakes", "followup_points", "followup_steps", "keywords", "parasite_words",
  "obscene_language", "review_score", "review_details"];

// WebVTT -> [{t, who, text}]
function parseVtt(vtt) {
  const out = [];
  const blocks = String(vtt).replace(/\r/g, "").split(/\n\n+/);
  for (const b of blocks) {
    const lines = b.split("\n").filter(Boolean);
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const t = lines[ti].split("-->")[0].trim().replace(/\.\d+$/, "").replace(/^00:/, "");
    let text = lines.slice(ti + 1).join(" ");
    let who = "";
    const v = text.match(/^<v\s+([^>]+)>/);
    if (v) { who = v[1]; text = text.replace(/^<v\s+[^>]+>/, "").replace(/<\/v>/g, ""); }
    else {
      const m = text.match(/^([^:]{2,30}):\s+/);
      if (m) { who = m[1]; text = text.slice(m[0].length); }
    }
    out.push({ t, who: who.trim(), text: text.trim() });
  }
  return out;
}

function Transcript({ text }) {
  if (!text) return null;
  if (/^https?:\/\//.test(text)) {
    return <a className="link" href={text} target="_blank" rel="noreferrer">Plik transkrypcji (VTT) <IconExternal /></a>;
  }
  const cues = parseVtt(text);
  if (!cues.length) return <pre className="transcript-raw">{text}</pre>;
  const speakers = [...new Set(cues.map((c) => c.who).filter(Boolean))];
  return (
    <div className="transcript">
      {cues.map((c, i) => (
        <div key={i} className={"cue" + (speakers.indexOf(c.who) === 1 ? " alt" : "")}>
          <span className="cue-t">{c.t}</span>
          <div>{c.who && <b className="cue-who">{c.who}</b>}<span>{c.text}</span></div>
        </div>
      ))}
    </div>
  );
}

function AiBlock({ call }) {
  const ai = call.ai || {};
  const quality = QUALITY.filter(([k]) => ai[k] !== undefined && ai[k] !== null && ai[k] !== "");
  const num = (v) => { const m = String(v).replace(",", ".").match(/\d+(\.\d+)?/); return m ? Number(m[0]) : null; };
  const scale = Math.max(5, ...quality.map(([k]) => num(ai[k]) ?? 0), num(ai.q_score) ?? 0) > 5 ? 10 : 5;
  const custom = ai.custom && typeof ai.custom === "object" ? Object.entries(ai.custom) : [];
  return (
    <div className="ai-box">
      <div className="row between" style={{ marginBottom: 10 }}>
        <h3 style={{ margin: 0 }} className="row"><IconSpark /> Ringostat AI{call.ai_title ? ` · ${call.ai_title}` : ""}</h3>
        {call.ai_score !== null && call.ai_score !== undefined && <span className="score-pill">{call.ai_score}<small>/{scale}</small></span>}
      </div>
      {AI_ORDER.filter((k) => ai[k] !== undefined && ai[k] !== null && ai[k] !== "").map((k) => (
        <div key={k} className="ai-field">
          <span className="ai-k">{AI_LABELS[k]}</span>
          <div className="ai-v">{Array.isArray(ai[k]) ? ai[k].join(", ") : String(ai[k])}</div>
        </div>
      ))}
      {quality.length > 0 && (
        <div className="ai-field">
          <span className="ai-k">Jakość rozmowy</span>
          <div className="grid cols-2" style={{ gap: 10 }}>
            {quality.map(([k, label]) => {
              const v = num(ai[k]);
              return (
                <div key={k}>
                  <div className="row between small"><span>{label}</span><b>{ai[k]}</b></div>
                  <div className="share-track"><div className="share-fill" style={{ width: `${v !== null ? Math.min(100, (v / scale) * 100) : 0}%` }} /></div>
                </div>
              );
            })}
          </div>
          {ai.q_review && <div className="ai-v" style={{ marginTop: 10 }}>{String(ai.q_review)}</div>}
        </div>
      )}
      {custom.map(([k, v]) => (
        <div key={k} className="ai-field"><span className="ai-k">{k}</span><div className="ai-v">{typeof v === "object" ? JSON.stringify(v) : String(v)}</div></div>
      ))}
    </div>
  );
}

export default function CallModal({ id, onClose, onOpen }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    setD(null); setErr(""); setShowRaw(false);
    api("rs.call", { id }).then(setD).catch((e) => setErr(e.message));
  }, [id]);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const c = d?.call;
  const lead = c?.lead;
  const pd = pdLeadUrl(lead);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="row between" style={{ marginBottom: 14 }}>
          <h3 style={{ margin: 0 }} className="row">
            {c && <Direction type={c.call_type} />}
            {c ? `${lead?.full_name || fmtPhone(c.client_phone)} · ${fmtDateTime(c.calldate)}` : "Rozmowa"}
          </h3>
          <button className="btn sm ghost" onClick={onClose}>✕</button>
        </div>
        {err && <div className="err">{err}</div>}
        {!c && !err && <div style={{ padding: 30, textAlign: "center" }}><span className="spin" /></div>}

        {c && (
          <div className="grid" style={{ gap: 16 }}>
            <div className="grid cols-4 kv">
              <div><span>Kierunek</span><b>{TYPE_LABEL[c.call_type] ?? c.call_type}</b></div>
              <div><span>Status</span><StatusBadge c={c} /></div>
              <div><span>Rozmowa</span><b>{fmtDur(c.billsec)}</b></div>
              <div><span>Oczekiwanie</span><b>{c.waittime ?? 0} s</b></div>
              <div><span>Klient</span><b>{fmtPhone(c.client_phone)}</b></div>
              <div><span>Pracownik</span><b>{c.employee_fio || "—"}</b></div>
              <div><span>Numer firmowy</span><b>{fmtPhone(c.n_alias || c.caller_number)}</b></div>
              <div><span>Połączenie nr</span><b>{c.call_counter > 0 ? c.call_counter : "—"}</b></div>
              {c.missing_reason && <div><span>Powód nieodebrania</span><b>{REASON_LABEL[c.missing_reason] ?? c.missing_reason}</b></div>}
              {c.scheme_name && <div><span>Schemat przekierowania</span><b>{c.scheme_name}</b></div>}
              {c.pool_name && <div><span>Pula numerów</span><b>{c.pool_name}</b></div>}
              {(c.utm_source || c.utm_campaign) && <div><span>UTM</span><b>{[c.utm_source, c.utm_medium, c.utm_campaign].filter(Boolean).join(" / ")}</b></div>}
              {c.landing && <div><span>Strona wejścia</span><b className="ellipsis" title={c.landing}>{c.landing}</b></div>}
              {c.proper_flag === 1 && <div><span>Docelowa</span><b>tak</b></div>}
              {c.csat_rating && <div><span>Ocena CSAT</span><b>{c.csat_rating}</b></div>}
            </div>

            {c.recording && (
              <div className="player">
                <audio controls preload="none" src={c.recording} style={{ width: "100%" }} />
                <div className="row" style={{ gap: 14, marginTop: 8 }}>
                  <a className="link small" href={c.recording} target="_blank" rel="noreferrer" download><IconDownload size={12} /> Pobierz nagranie (WAV)</a>
                  <span className="small muted">Ringostat przechowuje nagrania przez 1 rok.</span>
                </div>
              </div>
            )}
            {!c.recording && c.answered && <div className="small muted">Brak nagrania tej rozmowy.</div>}

            {c.ai_at ? <AiBlock call={c} /> : (
              c.answered && <div className="small muted row"><IconSpark size={12} /> Brak analizy AI dla tej rozmowy — pojawi się automatycznie, gdy Ringostat AI przetworzy rozmowę (webhook).</div>
            )}

            {c.transcript && (
              <div>
                <h3>Transkrypcja</h3>
                <Transcript text={c.transcript} />
              </div>
            )}

            <div className="grid cols-2">
              <div className="panel inner">
                <h3>Lead z Facebooka</h3>
                {lead ? (
                  <div className="small grid" style={{ gap: 6 }}>
                    <div><b style={{ fontSize: 14 }}>{lead.full_name || "—"}</b></div>
                    <div><span className="muted">E-mail:</span> {lead.email || "—"}</div>
                    <div><span className="muted">Telefon:</span> {lead.phone || "—"}</div>
                    <div><span className="muted">Kampania:</span> {lead.campaign_name || "—"}</div>
                    <div><span className="muted">Strona FB:</span> {lead.page_name || "—"}</div>
                    <div><span className="muted">Lead z dnia:</span> {fmtDateTime(lead.received_at)}</div>
                    {pd && <a className="link" href={pd} target="_blank" rel="noreferrer">Otwórz w Pipedrive <IconExternal /></a>}
                  </div>
                ) : <div className="small muted">Numer nie pasuje do żadnego leada z formularzy FB.</div>}
              </div>
              <div className="panel inner">
                <h3>Historia kontaktu z tym numerem ({d.history.length})</h3>
                <div className="history">
                  {d.history.map((h) => (
                    <div key={h.uniqueid} className={"hist-row" + (h.uniqueid === c.uniqueid ? " current" : "")}
                      onClick={() => h.uniqueid !== c.uniqueid && onOpen(h.uniqueid)}>
                      <Direction type={h.call_type} />
                      <span className="small">{fmtDateTime(h.calldate)}</span>
                      <span className="small muted ellipsis" style={{ flex: 1 }}>{h.employee_fio || "—"}</span>
                      <span className="small">{h.answered ? fmtDur(h.billsec) : <span className="muted">nieodebrana</span>}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="row wrap" style={{ gap: 12 }}>
              {c.call_card && <a className="btn sm" href={c.call_card} target="_blank" rel="noreferrer">Karta w Ringostat <IconExternal /></a>}
              <button className="btn sm ghost" onClick={() => setShowRaw(!showRaw)}>{showRaw ? "Ukryj" : "Pokaż"} wszystkie dane z Ringostat</button>
              <span className="small muted" style={{ marginLeft: "auto" }}>ID: {c.uniqueid}</span>
            </div>
            {showRaw && (
              <table className="tbl">
                <tbody>
                  {Object.entries(d.raw || {}).map(([k, v]) => (
                    <tr key={k}><td className="muted small" style={{ width: 200 }}>{k}</td><td className="small" style={{ wordBreak: "break-all" }}>{v === null || v === "" ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
