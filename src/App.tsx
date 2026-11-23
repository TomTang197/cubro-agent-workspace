import { useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { STAFF, getUser, setUser } from "./api";
import Overview from "./pages/Overview";
import Approvals from "./pages/Approvals";
import Agents from "./pages/Agents";
import Savings from "./pages/Savings";
import Systems from "./pages/Systems";
import SettingsPage from "./pages/Settings";

const NAV = [
  { to: "/", label: "Overview", end: true },
  { to: "/approvals", label: "Approvals" },
  { to: "/agents", label: "Agents" },
  { to: "/savings", label: "Time & money saved" },
  { to: "/systems", label: "Connected systems" },
  { to: "/settings", label: "Settings" },
];

export default function App() {
  const [user, setU] = useState(getUser());
  const [menu, setMenu] = useState(false);
  return (
    <div className="shell">
      <aside className={`sidebar ${menu ? "open" : ""}`}>
        <div className="brand"><span className="logo">C</span><div><strong>Cubro</strong><small>Agent Workspace</small></div></div>
        <nav>{NAV.map((n) => <NavLink key={n.to} to={n.to} end={n.end} onClick={() => setMenu(false)}>{n.label}</NavLink>)}</nav>
        <div className="sidebar-foot">
          <label className="muted small">Signed in as</label>
          <select value={user} onChange={(e) => { setUser(e.target.value); setU(e.target.value); }}>{STAFF.map((s) => <option key={s}>{s}</option>)}</select>
          <a className="muted small" href="https://app.devin.ai/sessions/584ae2a3f3cc425babc4499f85b04048" target="_blank" rel="noreferrer">Request a change</a>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="ghost menu-btn" onClick={() => setMenu(!menu)} aria-label="Menu">☰</button>
          <span className="pill mock">Pilot · simulated systems</span>
        </header>
        <main className="content">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/approvals" element={<Approvals />} />
            <Route path="/approvals/:id" element={<Approvals />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/savings" element={<Savings />} />
            <Route path="/systems" element={<Systems />} />
            <Route path="/systems/:system" element={<Systems />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
