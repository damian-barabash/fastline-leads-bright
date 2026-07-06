import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./auth.jsx";
import Layout from "./components/Layout.jsx";
import Login from "./pages/Login.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Leads from "./pages/Leads.jsx";
import Routing from "./pages/Routing.jsx";
import Facebook from "./pages/Facebook.jsx";
import Users from "./pages/Users.jsx";
import Settings from "./pages/Settings.jsx";

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return <div style={{ display: "grid", placeItems: "center", height: "100vh" }}><span className="spin" /></div>;
  }
  if (!user) return <Login />;

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/leads" element={<Leads />} />
        <Route path="/routing" element={<Routing />} />
        <Route path="/facebook" element={<Facebook />} />
        <Route path="/settings" element={<Settings />} />
        {user.role === "admin" && <Route path="/users" element={<Users />} />}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
