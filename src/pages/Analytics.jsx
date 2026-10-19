import { useEffect, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { defaultRange } from "./analytics/shared.jsx";
import Overview from "./analytics/Overview.jsx";
import Calls from "./analytics/Calls.jsx";
import Weekly from "./analytics/Weekly.jsx";
import Missed from "./analytics/Missed.jsx";
import Live from "./analytics/Live.jsx";
import Integration from "./analytics/Integration.jsx";
import CallModal from "./analytics/CallModal.jsx";

// Analityka — rozmowy telefoniczne z Ringostat (dostępne dla wszystkich ról).

const TABS = [
  { key: "overview", label: "Przegląd" },
  { key: "weekly", label: "Raport tygodniowy" },
  { key: "calls", label: "Rozmowy" },
  { key: "missed", label: "Do oddzwonienia" },
  { key: "live", label: "Zespół na żywo" },
  { key: "integration", label: "Integracja" },
];

export default function Analytics() {
  const { tab = "overview" } = useParams();
  const nav = useNavigate();
  const [range, setRange] = useState(defaultRange);
  const [employee, setEmployee] = useState("");
  const [employees, setEmployees] = useState([]);
  const [callsPreset, setCallsPreset] = useState(null);
  const [openId, setOpenId] = useState(null);

  useEffect(() => { setOpenId(null); }, [tab]);
  useEffect(() => { api("rs.employees").then((r) => setEmployees(r.rows)).catch(() => {}); }, []);

  // przejście z kafelków Przeglądu do przefiltrowanej listy
  const openCalls = (preset, target = "calls") => {
    if (preset?.employee !== undefined) { setEmployee(preset.employee); }
    const { employee: _e, ...rest } = preset || {};
    setCallsPreset({ type: "", status: "", onlyAi: false, onlyLead: false, onlyRecording: false, minSec: "", ...rest, _t: Date.now() });
    nav(`/analytics/${target}`);
  };

  const common = { range, setRange, employee, setEmployee, employees };

  return (
    <>
      <div className="topbar">
        <div><h1>Analityka</h1><div className="sub">Rozmowy telefoniczne z Ringostat — raporty, nagrania, wyniki rozmów</div></div>
      </div>
      <div className="tabs">
        {TABS.map((t) => (
          <NavLink key={t.key} to={`/analytics/${t.key}`} className={() => "tab" + (tab === t.key ? " active" : "")}>{t.label}</NavLink>
        ))}
      </div>

      {tab === "overview" && <Overview {...common} openCalls={openCalls} />}
      {tab === "weekly" && <Weekly onOpen={setOpenId} />}
      {tab === "calls" && <Calls {...common} preset={callsPreset} onOpen={setOpenId} />}
      {tab === "missed" && <Missed range={range} setRange={setRange} onOpen={setOpenId} />}
      {tab === "live" && <Live />}
      {tab === "integration" && <Integration />}

      {openId && <CallModal id={openId} onClose={() => setOpenId(null)} onOpen={setOpenId} />}
    </>
  );
}
