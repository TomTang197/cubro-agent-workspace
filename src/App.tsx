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
  const pick = (name: string) => { setUser(name); setU(name); };
  const nav = NAV.map((n) => <NavLink key={n.to} to={n.to} end={n.end} onClick={() => setMenu(false)}>{n.label}</NavLink>);
  return (
    <div className="shell">
      {menu && <div className="backdrop" onClick={() => setMenu(false)} aria-hidden="true" />}
      <header className="topbar">
        <div className="topbar-inner">
          <button className="ghost menu-btn" onClick={() => setMenu(!menu)} aria-label="Menu" aria-expanded={menu}>☰</button>
          <NavLink to="/" className="brand" aria-label="Cubro Agent Workspace, Overview"><img src="/cubro-logo.png" alt="Cubro" /><span>Agent Workspace</span></NavLink>
          <nav className="top-nav">{nav}</nav>
          <div className="top-tools">
            <label className="who-label" title="There is no login in the pilot. Pick your name so your approvals and agent runs are recorded under it.">
              <span className="muted small">Working as</span>
              <StaffSwitcher id="staff-switcher" user={user} onPick={pick} />
            </label>
          </div>
          <button className="ghost who" onClick={() => setMenu(true)} title="Switch staff member">{user}</button>
        </div>
      </header>
      <aside className={`sidebar ${menu ? "open" : ""}`} aria-hidden={!menu}>
        <div className="brand"><img src="/cubro-logo.png" alt="Cubro" /><span>Agent Workspace</span><button className="ghost menu-close" onClick={() => setMenu(false)} aria-label="Close menu">✕</button></div>
        <nav>{nav}</nav>
        <div className="sidebar-foot">
          <label className="muted small" htmlFor="staff-switcher-menu">You are working as</label>
          <StaffSwitcher id="staff-switcher-menu" user={user} onPick={pick} />
          <span className="muted small">There is no login in the pilot. Pick your name so your approvals and agent runs are recorded under it.</span>
        </div>
      </aside>
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
      <footer className="site-footer">
        <div className="footer-inner">
          <span>Cubro Agent Workspace · Pilot on simulated Microsoft 365, Salesforce, ClickUp and Infor LN</span>
          <a href="https://app.devin.ai/sessions/584ae2a3f3cc425babc4499f85b04048" target="_blank" rel="noreferrer">Request a change</a>
        </div>
      </footer>
    </div>
  );
}

function StaffSwitcher({ id, user, onPick }: { id: string; user: string; onPick: (name: string) => void }) {
  return (
    <select id={id} value={user} onChange={(e) => onPick(e.target.value)}>
      {Object.entries(TEAMS).map(([team, names]) => <optgroup key={team} label={team}>{names.map((s) => <option key={s}>{s}</option>)}</optgroup>)}
    </select>
  );
}
