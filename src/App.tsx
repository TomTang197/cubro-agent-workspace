import { useEffect, useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { TEAMS, getUser, setUser } from "./api";
import Overview from "./pages/Overview";
import Approvals from "./pages/Approvals";
import Agents from "./pages/Agents";
import Savings from "./pages/Savings";
import Systems from "./pages/Systems";
import SettingsPage from "./pages/Settings";
import NotFound from "./pages/NotFound";

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
  const { pathname } = useLocation();
  useEffect(() => {
    const page = NAV.find((n) => (n.end ? pathname === n.to : pathname.startsWith(n.to)));
    document.title = `${page?.label ?? "Page not found"} · Cubro Agent Workspace`;
  }, [pathname]);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);
  return (
    <div className="shell">
      {menu && <div className="backdrop" onClick={() => setMenu(false)} aria-hidden="true" />}
      <aside className={`sidebar ${menu ? "open" : ""}`}>
        <div className="brand"><span className="logo">C</span><div><strong>Cubro</strong><small>Agent Workspace</small></div><button className="ghost menu-close" onClick={() => setMenu(false)} aria-label="Close menu">✕</button></div>
        <nav>{NAV.map((n) => <NavLink key={n.to} to={n.to} end={n.end} onClick={() => setMenu(false)}>{n.label}</NavLink>)}</nav>
        <div className="sidebar-foot">
          <label className="muted small" htmlFor="staff-switcher">You are working as</label>
          <select id="staff-switcher" value={user} onChange={(e) => { setUser(e.target.value); setU(e.target.value); }}>
            {Object.entries(TEAMS).map(([team, names]) => <optgroup key={team} label={team}>{names.map((s) => <option key={s}>{s}</option>)}</optgroup>)}
          </select>
          <span className="muted small">There is no login in the pilot. Pick your name so your approvals and agent runs are recorded under it.</span>
          <a className="muted small" href="https://app.devin.ai/sessions/584ae2a3f3cc425babc4499f85b04048" target="_blank" rel="noreferrer">Request a change</a>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="ghost menu-btn" onClick={() => setMenu(!menu)} aria-label="Menu" aria-expanded={menu}>☰</button>
          <button className="ghost who" onClick={() => setMenu(true)} title="Switch staff member">{user}</button>
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
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
