import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";

export default function Facebook() {
  const { user } = useAuth();
  const admin = user.role === "admin";
  const [pages, setPages] = useState([]);
  const [token, setTokenVal] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(true);

  const load = async () => { try { const r = await api("fb.pages"); setPages(r.rows); } finally { setLoading(false); } };
  useEffect(() => { load(); }, []);

  const connect = async () => {
    setErr(""); setMsg(""); setBusy("connect");
    try {
      const r = await api("fb.connect", { user_token: token.trim() });
      setMsg(`Połączono ${r.connected} stron.`); setTokenVal(""); load();
    } catch (e) { setErr(e.message); } finally { setBusy(""); }
  };
  const subscribe = async (page_id) => {
    setErr(""); setBusy(page_id + "sub");
    try { await api("fb.subscribe", { page_id }); load(); } catch (e) { setErr(e.message); } finally { setBusy(""); }
  };
  const sync = async (page_id) => {
    setErr(""); setBusy(page_id + "sync");
    try { const r = await api("fb.syncForms", { page_id }); setMsg(`Zsynchronizowano ${r.synced} formularzy.`); load(); } catch (e) { setErr(e.message); } finally { setBusy(""); }
  };

  return (
    <>
      <div className="topbar">
        <div><h1>Facebook</h1><div className="sub">Połączone strony, subskrypcja leadgen i synchronizacja formularzy</div></div>
      </div>

      {msg && <div className="ok" style={{ marginBottom: 14 }}>{msg}</div>}
      {err && <div className="err" style={{ marginBottom: 14 }}>{err}</div>}

      {admin && (
        <div className="panel" style={{ marginBottom: 18 }}>
          <h3>Połącz konto Facebook</h3>
          <p className="muted small" style={{ marginTop: 0 }}>
            Wklej <b>User Access Token</b> z Graph API Explorer (uprawnienia: <code>pages_show_list</code>, <code>leads_retrieval</code>,
            <code> pages_manage_metadata</code>, <code>pages_read_engagement</code>). System sam wymieni go na token długoterminowy
            i pobierze wszystkie strony wraz z ich tokenami.
          </p>
          <div className="row" style={{ gap: 10 }}>
            <input placeholder="EAAB… user access token" value={token} onChange={(e) => setTokenVal(e.target.value)} />
            <button className="btn primary" onClick={connect} disabled={!token || busy === "connect"}>{busy === "connect" ? <span className="spin" /> : "Połącz"}</button>
          </div>
        </div>
      )}

      <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
        <table className="tbl">
          <thead><tr><th>Strona</th><th>ID</th><th>Token</th><th>Webhook leadgen</th><th>Formularze</th><th></th></tr></thead>
          <tbody>
            {pages.map((p) => (
              <tr key={p.page_id}>
                <td><b>{p.name || "—"}</b></td>
                <td className="small muted">{p.page_id}</td>
                <td><span className={"badge " + (p.token_valid ? "done" : "failed")}>{p.token_valid ? "ważny" : "brak"}</span></td>
                <td><span className={"badge " + (p.subscribed ? "done" : "skipped")}>{p.subscribed ? "aktywny" : "nieaktywny"}</span></td>
                <td className="small muted">{p.last_synced_at ? new Date(p.last_synced_at).toLocaleDateString("pl-PL") : "—"}</td>
                <td>{admin && (
                  <div className="row" style={{ gap: 6 }}>
                    {!p.subscribed && <button className="btn sm" onClick={() => subscribe(p.page_id)}>{busy === p.page_id + "sub" ? <span className="spin" /> : "Subskrybuj"}</button>}
                    <button className="btn sm ghost" onClick={() => sync(p.page_id)}>{busy === p.page_id + "sync" ? <span className="spin" /> : "Synchronizuj formularze"}</button>
                  </div>
                )}</td>
              </tr>
            ))}
            {pages.length === 0 && loading && Array.from({ length: 5 }).map((_, i) => (
              <tr key={"s" + i}>{Array.from({ length: 6 }).map((_, c) => <td key={c}><div className="skel skel-line" style={{ width: c === 0 ? "70%" : "45%" }} /></td>)}</tr>
            ))}
            {pages.length === 0 && !loading && <tr><td colSpan="6" className="muted" style={{ textAlign: "center", padding: 30 }}>Brak połączonych stron</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
