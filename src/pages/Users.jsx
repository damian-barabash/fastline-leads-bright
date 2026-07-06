import { useEffect, useState } from "react";
import { api } from "../api.js";

export default function Users() {
  const [rows, setRows] = useState([]);
  const [add, setAdd] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const load = async () => { try { const r = await api("users.list"); setRows(r.rows); } finally { setLoading(false); } };
  useEffect(() => { load(); }, []);

  const create = async () => {
    setErr("");
    try { await api("users.create", add); setAdd(null); load(); }
    catch (e) { setErr(e.message); }
  };
  const toggle = async (u) => { await api("users.update", { id: u.id, active: !u.active }); load(); };
  const setRole = async (u, role) => { await api("users.update", { id: u.id, role }); load(); };
  const resetPw = async (u) => { const p = prompt(`Nowe hasło dla ${u.username}:`); if (p) { await api("users.update", { id: u.id, password: p }); alert("Hasło zmienione"); } };
  const del = async (u) => { if (confirm(`Usunąć ${u.username}?`)) { await api("users.delete", { id: u.id }); load(); } };

  return (
    <>
      <div className="topbar">
        <div><h1>Użytkownicy</h1><div className="sub">Dostęp do panelu</div></div>
        <button className="btn primary" onClick={() => setAdd({ username: "", password: "", role: "operator" })}>+ Dodaj użytkownika</button>
      </div>

      <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
        <table className="tbl">
          <thead><tr><th>Login</th><th>Rola</th><th>Status</th><th>Utworzono</th><th></th></tr></thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id} style={{ opacity: u.active ? 1 : 0.5 }}>
                <td><b>{u.username}</b></td>
                <td>
                  <select value={u.role} onChange={(e) => setRole(u, e.target.value)} style={{ width: 140, padding: "6px 10px" }}>
                    <option value="admin">Administrator</option>
                    <option value="operator">Operator</option>
                  </select>
                </td>
                <td><span className={"badge " + (u.active ? "done" : "skipped")}>{u.active ? "aktywny" : "wyłączony"}</span></td>
                <td className="small muted">{new Date(u.created_at).toLocaleDateString("pl-PL")}</td>
                <td>
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn sm ghost" onClick={() => toggle(u)}>{u.active ? "Wyłącz" : "Włącz"}</button>
                    <button className="btn sm ghost" onClick={() => resetPw(u)}>Hasło</button>
                    <button className="btn sm ghost" onClick={() => del(u)}>🗑</button>
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && loading && Array.from({ length: 3 }).map((_, i) => (
              <tr key={"s" + i}>{Array.from({ length: 5 }).map((_, c) => <td key={c}><div className="skel skel-line" style={{ width: c === 0 ? "60%" : "40%" }} /></td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>

      {add && (
        <div className="overlay" onClick={() => setAdd(null)}>
          <div className="panel modal" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
            <div className="row between"><h3>Nowy użytkownik</h3><button className="btn sm ghost" onClick={() => setAdd(null)}>✕</button></div>
            {err && <div className="err" style={{ marginBottom: 12 }}>{err}</div>}
            <label className="fld"><span className="lbl">Login</span><input value={add.username} onChange={(e) => setAdd({ ...add, username: e.target.value })} /></label>
            <label className="fld"><span className="lbl">Hasło</span><input value={add.password} onChange={(e) => setAdd({ ...add, password: e.target.value })} /></label>
            <label className="fld"><span className="lbl">Rola</span>
              <select value={add.role} onChange={(e) => setAdd({ ...add, role: e.target.value })}>
                <option value="operator">Operator (podgląd)</option>
                <option value="admin">Administrator (pełny dostęp)</option>
              </select></label>
            <div className="row" style={{ justifyContent: "flex-end", gap: 10 }}>
              <button className="btn ghost" onClick={() => setAdd(null)}>Anuluj</button>
              <button className="btn primary" onClick={create} disabled={!add.username || !add.password}>Utwórz</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
