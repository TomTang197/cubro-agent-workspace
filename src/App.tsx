import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { TEAMS, adminMenu, api, getUser, guideSeen, setUser } from "./api";
import { useApi } from "./useApi";
import Guide from "./components/Guide";
import Admin from "./pages/Admin";
import Overview from "./pages/Overview";
import Approvals from "./pages/Approvals";
import Agents from "./pages/Agents";
import Savings from "./pages/Savings";
import Systems from "./pages/Systems";
import SettingsPage from "./pages/Settings";
import NotFound from "./pages/NotFound";

const NAV = [
  { to: "/", label: "Today", end: true },
  { to: "/approvals", label: "Drafts to check" },
  { to: "/agents", label: "Assistants" },
  { to: "/savings", label: "Time & money saved" },
];
// Pages for whoever looks after the workspace. They stay out of the menu until someone asks for them.
const ADMIN = [
  { to: "/admin", label: "Admin" },
  { to: "/systems", label: "Connected systems" },
  { to: "/settings", label: "Settings" },
];

export default function App() {
  const [user, setU] = useState(getUser());
  const [menu, setMenu] = useState(false);
  const shell = useRef<HTMLDivElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const { pathname } = useLocation();
  const [guide, setGuide] = useState(!guideSeen.get());
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string>();
  const { data: workspace } = useApi<{ demo: boolean }>("/workspace");
  const inAdmin = ADMIN.some((n) => pathname.startsWith(n.to));
  const closeGuide = () => { guideSeen.set(true); setGuide(false); };
  // One click puts the demo back to its start: the sample data and the first-open guide.
  const restart = async () => {
    setRestarting(true); setRestartError(undefined);
    try { await api("/reset", { method: "POST" }); guideSeen.set(false); location.href = "/"; }
    catch (e) { setRestartError(e instanceof Error ? e.message : String(e)); setRestarting(false); }
  };
  useEffect(() => {
    const page = [...NAV, ...ADMIN].find((n) => ("end" in n && n.end ? pathname === n.to : pathname.startsWith(n.to)));
    document.title = `${page?.label ?? "Page not found"} · Cubro Agent Workspace`;
  }, [pathname]);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 1180px)");
    const onChange = () => { if (!narrow.matches) setMenu(false); };
    narrow.addEventListener("change", onChange);
    return () => narrow.removeEventListener("change", onChange);
  }, []);
  useEffect(() => {
    shell.current?.querySelectorAll(":scope > .topbar, :scope > .demo-bar, :scope > .content, :scope > .site-footer").forEach((el) => el.toggleAttribute("inert", menu));
    if (menu) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      (drawer.current?.querySelector<HTMLElement>("nav a.active") ?? drawer.current?.querySelector<HTMLElement>("nav a"))?.focus();
    } else if (opener.current) {
      opener.current.focus();
      opener.current = null;
    }
  }, [menu]);
  const pick = (name: string) => { setUser(name); setU(name); };
  const nav = [
    ...NAV.map((n) => <NavLink key={n.to} to={n.to} end={n.end} onClick={() => setMenu(false)}>{n.label}</NavLink>),
    ...(adminMenu.get() || inAdmin ? [<NavLink key="/admin" to="/admin" className={inAdmin ? "active" : ""} onClick={() => setMenu(false)}>Admin</NavLink>] : []),
  ];
  const howItWorks = (cls: string) => <button type="button" className={cls} onClick={() => { setMenu(false); setGuide(true); }}>How it works</button>;
  return (
    <div className="shell" ref={shell}>
      {menu && <div className="backdrop" onClick={() => setMenu(false)} aria-hidden="true" />}
      <header className="topbar">
        <div className="topbar-inner">
          <button className="ghost menu-btn" onClick={() => setMenu(!menu)} aria-label="Menu" aria-expanded={menu}>☰</button>
          <NavLink to="/" className="brand" onClick={() => setMenu(false)} aria-label="Cubro Agent Workspace, Today"><img src="/cubro-logo.png" alt="Cubro" /><span>Agent Workspace</span></NavLink>
          <nav className="top-nav">{nav}</nav>
          <div className="top-tools">
            {howItWorks("link how")}
            <label className="who-label" title="There is no login in the pilot. Pick your name so your approvals and agent runs are recorded under it.">
              <span className="muted small">Working as</span>
              <StaffSwitcher id="staff-switcher" user={user} onPick={pick} />
            </label>
          </div>
          <button className="ghost who" onClick={() => setMenu(true)} title="Switch staff member">{user}</button>
        </div>
      </header>
      <aside ref={drawer} className={`sidebar ${menu ? "open" : ""}`} aria-hidden={!menu}>
        <div className="brand"><img src="/cubro-logo.png" alt="Cubro" /><span>Agent Workspace</span><button className="ghost menu-close" onClick={() => setMenu(false)} aria-label="Close menu">✕</button></div>
        <nav>{nav}{howItWorks("link how")}</nav>
        <div className="sidebar-foot">
          <label className="muted small" htmlFor="staff-switcher-menu">You are working as</label>
          <StaffSwitcher id="staff-switcher-menu" user={user} onPick={pick} />
          <span className="muted small">There is no login in the pilot. Pick your name so your approvals and agent runs are recorded under it.</span>
        </div>
      </aside>
      {workspace?.demo && (
        <div className="demo-bar" role="note">
          <span><b>Demo</b> · Sample data. Nothing you approve here reaches a real supplier, customer or social channel.</span>
          <button type="button" className="link" onClick={restart} disabled={restarting} title="Puts the sample data back to how it started, for everyone, and shows the guide again">{restarting ? "Starting again…" : "Start the demo again"}</button>
          {restartError && <span className="bad-text" role="alert">Couldn't start again: {restartError}</span>}
        </div>
      )}
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
          <Route path="/admin" element={<Admin demo={!!workspace?.demo} onRestart={restart} restarting={restarting} />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <footer className="site-footer">
        <div className="footer-inner">
          <span>Cubro Agent Workspace · Pilot on simulated Microsoft 365, Salesforce, ClickUp and Infor LN</span>
          <span className="row gap wrap footer-links">
            <Link to="/admin">Admin</Link>
            <a href="https://app.devin.ai/sessions/584ae2a3f3cc425babc4499f85b04048" target="_blank" rel="noreferrer">Request a change</a>
          </span>
        </div>
      </footer>
      {guide && <Guide name={user} onClose={closeGuide} />}
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
