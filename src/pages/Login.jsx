import { useState } from "react";
import { useAuth } from "../auth.jsx";

export default function Login() {
  const { login } = useAuth();
  const [username, setU] = useState("");
  const [password, setP] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr(""); setBusy(true);
    try { await login(username.trim(), password); }
    catch (e) { setErr(e.message || "Błąd logowania"); }
    finally { setBusy(false); }
  };

  return (
    <div className="login-wrap">
      <form className="panel login-card" onSubmit={submit}>
        <div className="brand">
          <img src="/logo.webp" className="logo-img" alt="Fastline" />
          <div><b>FASTLINE<br />LEADS BRIGHT</b><span>Panel logowania</span></div>
        </div>
        {err && <div className="err" style={{ marginBottom: 14 }}>{err}</div>}
        <label className="fld">
          <span className="lbl">Login</span>
          <input value={username} onChange={(e) => setU(e.target.value)} autoFocus autoComplete="username" />
        </label>
        <label className="fld">
          <span className="lbl">Hasło</span>
          <input type="password" value={password} onChange={(e) => setP(e.target.value)} autoComplete="current-password" />
        </label>
        <button className="btn primary" style={{ width: "100%", justifyContent: "center" }} disabled={busy}>
          {busy ? <span className="spin" /> : "Zaloguj się"}
        </button>
      </form>
    </div>
  );
}
