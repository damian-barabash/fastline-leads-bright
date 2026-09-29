import { useEffect, useState } from "react";
import { api } from "../../api.js";
import { useAuth } from "../../auth.jsx";
import { fmtDateTime } from "./shared.jsx";

// Integracja — stan synchronizacji z Ringostat + instrukcja webhooka Ringostat AI.

// nazwy parametrów, które rozpoznaje ringostat-webhook → zmienna w Ringostat
const AI_PARAMS = [
  ["call_id", "Call ID (ID połączenia)", true],
  ["title", "Title"],
  ["summary", "Short summary / Summary"],
  ["client_mood", "Client's sentiment"],
  ["employee_mood", "Employee's sentiment"],
  ["overall_mood", "General sentiment"],
  ["recommendations", "Recommended actions"],
  ["transcript", "File with processing result by AI (vtt)"],
  ["key_points", "Key points"],
  ["next_steps", "Next steps"],
  ["mistakes", "Mistakes"],
  ["good_points", "Good points"],
  ["keywords", "Keywords"],
  ["quality_opening", "Dialogue quality: Opening"],
  ["quality_anamnesis", "Dialogue quality: History (Anamnesis)"],
  ["quality_presentation", "Dialogue quality: Presentation"],
  ["quality_closing", "Dialogue quality: Closing"],
  ["quality_score", "Dialogue quality: Score"],
  ["quality_review", "Dialogue quality: Review"],
  ["parasite_words", "Parasite words"],
  ["obscene_language", "Obscene language"],
  ["review_score", "Review required: Score"],
  ["review_details", "Review required: Details"],
  ["followup_main_points", "Follow-up: Main points"],
  ["followup_next_steps", "Follow-up: Next steps"],
];

export default function Integration({ onSynced }) {
  const { user } = useAuth();
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [copied, setCopied] = useState(false);

  const load = () => api("rs.config").then(setD).catch((e) => setMsg({ err: e.message }));
  useEffect(() => { load(); }, []);

  const sync = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api("rs.sync");
      setMsg({ ok: `Zsynchronizowano ${r.calls} rozmów (${r.from} → ${r.to}).` });
      load(); onSynced?.();
    } catch (e) { setMsg({ err: e.message }); } finally { setBusy(false); }
  };
  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState(null);
  const doImport = async () => {
    setImporting(true); setImportMsg(null);
    try {
      const r = await api("rs.importAi", { text: importText });
      setImportMsg({ ok: `Zaimportowano analizę rozmowy ${r.call_id} — widoczna w karcie rozmowy.` });
      setImportText(""); load();
    } catch (e) { setImportMsg({ err: e.message }); } finally { setImporting(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(d.webhookUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* brak dostępu do schowka */ }
  };

  const ls = d?.lastSync;
  return (
    <div className="grid" style={{ gap: 18 }}>
      <div className="grid cols-4">
        <div className="panel stat"><span className="k">Projekt Ringostat</span><span className="v" style={{ fontSize: 22 }}>{d?.projectId ?? "—"}</span>
          <span className="small muted">{d?.connected ? "klucz API aktywny" : "brak klucza"}</span></div>
        <div className="panel stat"><span className="k">Rozmów w bazie</span><span className="v">{d?.calls ?? "—"}</span><span className="small muted">od 15.09.2025</span></div>
        <div className="panel stat"><span className="k">Z analizą AI</span><span className="v">{d?.ai ?? "—"}</span><span className="small muted">z webhooka Ringostat AI</span></div>
        <div className="panel stat"><span className="k">Ostatnia synchronizacja</span>
          <span className={"v " + (ls && !ls.ok ? "amber" : "")} style={{ fontSize: 18 }}>{ls ? fmtDateTime(ls.at) : "—"}</span>
          <span className="small muted">{ls ? (ls.ok ? `${ls.calls} rozmów w oknie` : ls.error) : ""}</span></div>
      </div>

      <div className="panel">
        <h3>Synchronizacja dziennika połączeń</h3>
        <div className="small muted" style={{ marginBottom: 12, lineHeight: 1.6 }}>
          Rozmowy, nagrania, pracownicy i statusy pobierane są z Ringostat API automatycznie <b>co 5 minut</b> (ostatnie 6 h są odświeżane,
          żeby rozmowy w trakcie dostały końcowy status i nagranie). Rozmowy są automatycznie łączone z leadami z Facebooka po numerze telefonu.
        </div>
        <button className="btn primary sm" onClick={sync} disabled={busy}>{busy ? <span className="spin" /> : null} Synchronizuj teraz</button>
        {msg?.ok && <div className="ok" style={{ marginTop: 12 }}>{msg.ok}</div>}
        {msg?.err && <div className="err" style={{ marginTop: 12 }}>{msg.err}</div>}
      </div>

      <div className="panel">
        <h3>Wyniki rozmów z Ringostat AI (webhook)</h3>
        <div className="small muted" style={{ lineHeight: 1.6, marginBottom: 12 }}>
          Ringostat nie udostępnia analizy AI (podsumowanie, nastroje, ocena jakości, transkrypcja) przez API — wysyła ją tylko webhookiem
          po przetworzeniu rozmowy. Wymaga aktywnego modułu <b>Ringostat AI</b> w projekcie.
        </div>
        {user.role === "admin" ? (
          <>
            <ol className="small steps">
              <li>Ringostat → <b>Integracje → Webhooks</b> → „Dodaj webhook”.</li>
              <li>Zdarzenie: <b>„Połączenie przetworzone przez AI” (Call processed by AI)</b>, metoda <b>POST</b>, format <b>JSON</b>.</li>
              <li>URL:
                <div className="row" style={{ gap: 8, margin: "6px 0" }}>
                  <input readOnly value={d?.webhookUrl ?? ""} style={{ fontFamily: "monospace", fontSize: 12, padding: "7px 10px" }} onFocus={(e) => e.target.select()} />
                  <button className="btn sm" onClick={copy}>{copied ? "Skopiowano" : "Kopiuj"}</button>
                </div>
                <span className="muted">URL zawiera tajny token — nie udostępniaj go poza Ringostat.</span>
              </li>
              <li>Dodaj parametry (nazwa po lewej → zmienna Ringostat po prawej). Wymagany jest tylko <code>call_id</code>, resztę dodaj według uznania — nieznane nazwy też zostaną zapisane.</li>
            </ol>
            <table className="tbl" style={{ marginTop: 8 }}>
              <thead><tr><th>Nazwa parametru</th><th>Zmienna w Ringostat</th></tr></thead>
              <tbody>
                {AI_PARAMS.map(([k, v, req]) => (
                  <tr key={k}><td><code>{k}</code>{req && <span className="badge failed" style={{ marginLeft: 8 }}>wymagany</span>}</td><td className="small">{v}</td></tr>
                ))}
              </tbody>
            </table>
            <div className="small muted" style={{ marginTop: 12, lineHeight: 1.6 }}>
              Opcjonalnie: drugi webhook na zdarzenie <b>„Po rozmowie” (After call)</b> na ten sam URL z parametrem <code>call_id</code> —
              wtedy rozmowy pojawiają się w panelu od razu, bez czekania na synchronizację co 5 min.
            </div>
          </>
        ) : (
          <div className="small muted">Konfigurację webhooka widzi administrator.</div>
        )}

        <h3 style={{ marginTop: 20 }}>Ręczny import analizy AI</h3>
        <div className="small muted" style={{ marginBottom: 8, lineHeight: 1.6 }}>
          Gdy webhook nie dotarł: Ringostat → Integracje → „Sprawdź działania z błędami” → <b>„Pokaż”</b> → skopiuj cały tekst i wklej tutaj.
        </div>
        <textarea rows={5} value={importText} onChange={(e) => setImportText(e.target.value)}
          placeholder='{ "call_id": "pl2_-…", "summary": "…", … }' style={{ fontFamily: "monospace", fontSize: 12 }} />
        <button className="btn sm" style={{ marginTop: 8 }} onClick={doImport} disabled={importing || !importText.trim()}>
          {importing ? <span className="spin" /> : null} Importuj
        </button>
        {importMsg?.ok && <div className="ok" style={{ marginTop: 10 }}>{importMsg.ok}</div>}
        {importMsg?.err && <div className="err" style={{ marginTop: 10 }}>{importMsg.err}</div>}

        <h3 style={{ marginTop: 20 }}>Ostatnie zdarzenia webhooka</h3>
        <table className="tbl">
          <thead><tr><th>Otrzymano</th><th>ID rozmowy</th><th>Status</th></tr></thead>
          <tbody>
            {(d?.events ?? []).map((e) => (
              <tr key={e.id}>
                <td className="small">{fmtDateTime(e.received_at)}</td>
                <td className="small">{e.call_id || "—"}</td>
                <td><span className={"badge " + (e.status === "applied" ? "done" : e.status === "error" ? "failed" : "skipped")}>{e.status}</span>
                  {e.error && <span className="small muted"> {e.error}</span>}</td>
              </tr>
            ))}
            {d && d.events.length === 0 && <tr><td colSpan="3" className="muted small" style={{ textAlign: "center", padding: 18 }}>Jeszcze nie otrzymano żadnego webhooka</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
