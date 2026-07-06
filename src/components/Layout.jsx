import { NavLink } from "react-router-dom";
import { useAuth } from "../auth.jsx";

const NAV = [
  { to: "/", ico: "▚", label: "Pulpit", end: true },
  { to: "/leads", ico: "☰", label: "Leady" },
  { to: "/routing", ico: "⚙", label: "Sortowanie" },
  { to: "/facebook", ico: "◎", label: "Facebook" },
  { to: "/settings", ico: "✦", label: "Ustawienia" },
  { to: "/users", ico: "◈", label: "Użytkownicy", admin: true },
];

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img src="/logo.webp" className="logo-img" alt="Fastline" />
          <div><b>FASTLINE<br />LEADS BRIGHT</b><span>Lead automation</span></div>
        </div>
        {NAV.filter((n) => !n.admin || user.role === "admin").map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}>
            <span className="ico">{n.ico}</span>{n.label}
          </NavLink>
        ))}
        <div className="spacer" />
        <div className="userbox">
          <b>{user.username}</b>
          <span className="small">{user.role === "admin" ? "Administrator" : "Operator"}</span>
          <div className="btn ghost sm" style={{ marginTop: 10 }} onClick={logout}>Wyloguj</div>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
