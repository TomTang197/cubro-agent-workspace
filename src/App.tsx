import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { RECORD_KINDS, TEAMS, adminMenu, agentFor, getUser, guideSeen, restartDemo, setUser, teamOf, type ApprovalItem } from "./api";
import { useApi } from "./useApi";
import Bell from "./components/Bell";
import Guide from "./components/Guide";
import { RecordPanel } from "./components/Record";
import Search from "./components/Search";
import Activity from "./pages/Activity";
import Records from "./pages/Records";
import Admin from "./pages/Admin";
import Overview from "./pages/Overview";
import Approvals from "./pages/Approvals";
import Agents from "./pages/Agents";
import Savings from "./pages/Savings";
import Systems from "./pages/Systems";
import SettingsPage from "./pages/Settings";
import NotFound from "./pages/NotFound";

type Item = { to: string; label: string; icon: keyof typeof ICONS; end?: boolean };
// The menu is grouped by what staff come here to do: their own work, looking something up, and how the team is going.
const MENU: { group: string; items: Item[] }[] = [
  { group: "My work", items: [{ to: "/", label: "Today", icon: "today", end: true }, { to: "/approvals", label: "Drafts to check", icon: "drafts" }] },
  { group: "Look up", items: RECORD_KINDS.map((k) => ({ to: `/records/${k.kind}`, label: k.label, icon: k.kind })) },
  { group: "Team", items: [{ to: "/agents", label: "Assistants", icon: "assistants" }, { to: "/activity", label: "Activity", icon: "activity" }, { to: "/savings", label: "Time & money saved", icon: "savings" }] },
];
const NAV = MENU.flatMap((g) => g.items);
// Pages for whoever looks after the workspace. They stay out of the menu until someone asks for them.
const ADMIN = [
  { to: "/admin", label: "Admin" },
  { to: "/systems", label: "Connected systems" },
  { to: "/settings", label: "Settings" },
];
const ICONS = {
  today: "M4 11.5 12 5l8 6.5V20h-5v-5H9v5H4z",
  drafts: "M5 4h14v16H5zM8.5 9h7M8.5 12.5h7M8.5 16h4",
  supplier: "M3 20V9l6 3V9l6 3V5h6v15zM7 16h2M12 16h2M17 16h1",
  order: "M4 7.5 12 3l8 4.5v9L12 21l-8-4.5zM4 7.5l8 4.5 8-4.5M12 12v9",
  customer: "M4 20V6l8-3v17M12 9l8 2v9M2.5 20h19M7 9v.01M7 13v.01M16 14v.01",
  product: "M3 17V7M3 13h18v4M21 17v2M3 17v2M7 13v-2.5h6.5A3.5 3.5 0 0 1 17 13",
  assistants: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18.5 16.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z",
  activity: "M12 7v5l3.5 2M21 12a9 9 0 1 1-2.6-6.3M21 4v4.5h-4.5",
  savings: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  admin: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19 12l2-1.2-1.5-3-2.2.6-1.6-1.2L15.3 5h-3.4l-.5 2.2-1.6 1.2-2.2-.6-1.5 3L8 12l-1.9 1.2 1.5 3 2.2-.6 1.6 1.2.5 2.2h3.4l.4-2.2 1.6-1.2 2.2.6 1.5-3z",
};
const Icon = ({ name }: { name: keyof typeof ICONS }) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICONS[name]} /></svg>;
const NARROW = "(max-width: 1023px)";

export default function App() {
  const [user, setU] = useState(getUser());
  const [menu, setMenu] = useState(false);
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  const main = useRef<HTMLDivElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const { pathname } = useLocation();
  const [guide, setGuide] = useState(!guideSeen.get());
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string>();
  const { data: workspace } = useApi<{ demo: boolean }>("/workspace");
  // How many of the picked person's team's drafts are waiting, shown beside the menu item.
  const { data: waiting, reload: recount } = useApi<ApprovalItem[]>(`/approvals?status=pending&agent=${agentFor(user)}`);
  const inAdmin = ADMIN.some((n) => pathname.startsWith(n.to));
  const closeGuide = () => { guideSeen.set(true); setGuide(false); };
  // One click puts the demo back to its start: the sample data and the first-open guide.
  const restart = async () => {
    setRestarting(true); setRestartError(undefined);
    try { await restartDemo(); location.href = "/"; }
    catch (e) { setRestartError(e instanceof Error ? e.message : String(e)); setRestarting(false); }
  };
  useEffect(() => {
    const page = [...NAV, ...ADMIN].find((n) => ("end" in n && n.end ? pathname === n.to : pathname.startsWith(n.to)));
    document.title = `${page?.label ?? "Page not found"} · Cubro Agent Workspace`;
    recount();
  }, [pathname]);
  useEffect(() => { const t = window.setInterval(recount, 30_000); return () => window.clearInterval(t); }, [recount]);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const onChange = () => { setNarrow(mq.matches); if (!mq.matches) setMenu(false); };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  useEffect(() => {
    main.current?.toggleAttribute("inert", menu);
    if (menu) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      (drawer.current?.querySelector<HTMLElement>("nav a.active") ?? drawer.current?.querySelector<HTMLElement>("nav a"))?.focus();
    } else if (opener.current) {
      opener.current.focus();
      opener.current = null;
    }
  }, [menu]);
  const pick = (name: string) => { setUser(name); setU(name); };
  const link = (n: Item) => (
    <NavLink key={n.to} to={n.to} end={n.end} onClick={() => setMenu(false)}>
      <Icon name={n.icon} /><span>{n.label}</span>
      {n.to === "/approvals" && !!waiting?.length && <span className="badge" title={`${waiting.length} waiting for ${teamOf(user)}`}>{waiting.length}</span>}
    </NavLink>
  );
  const showGuide = () => { setMenu(false); setGuide(true); };
  return (
    <div className="shell">
      {menu && <div className="backdrop" onClick={() => setMenu(false)} aria-hidden="true" />}
      <aside ref={drawer} className={`sidebar ${menu ? "open" : ""}`} aria-hidden={narrow && !menu}>
        <div className="brand-row">
          <NavLink to="/" className="brand" onClick={() => setMenu(false)} aria-label="Cubro Agent Workspace, Today"><img src="/cubro-logo.png" alt="Cubro" /><span>Agent Workspace</span></NavLink>
          <button className="ghost menu-close" onClick={() => setMenu(false)} aria-label="Close menu">✕</button>
        </div>
        <nav aria-label="Workspace">
          {MENU.map((g) => <div className="nav-group" key={g.group}><span>{g.group}</span>{g.items.map(link)}</div>)}
          {(adminMenu.get() || inAdmin) && <div className="nav-group"><span>Looking after it</span><NavLink to="/admin" className={inAdmin ? "active" : ""} onClick={() => setMenu(false)}><Icon name="admin" /><span>Admin</span></NavLink></div>}
        </nav>
        <div className="sidebar-foot">
          <div className="who-menu">
            <label className="small" htmlFor="staff-switcher-menu">You are working as</label>
            <StaffSwitcher id="staff-switcher-menu" user={user} onPick={pick} />
            <span className="small">There is no login in the pilot. Pick your name so your approvals and agent runs are recorded under it.</span>
          </div>
          <button type="button" className="link how" onClick={showGuide}>How it works</button>
          <span className="foot-links">
            <Link to="/admin" onClick={() => setMenu(false)}>Admin</Link>
            <a href="https://app.devin.ai/sessions/584ae2a3f3cc425babc4499f85b04048" target="_blank" rel="noreferrer">Request a change</a>
          </span>
        </div>
      </aside>
      <div className="main" ref={main}>
        <header className="topbar">
          <button className="ghost menu-btn" onClick={() => setMenu(!menu)} aria-label="Menu" aria-expanded={menu}>☰</button>
          <Search />
          <div className="top-tools">
            <Bell user={user} />
            <button type="button" className="ghost tool how" onClick={showGuide} title="How it works: three steps" aria-label="How it works">?</button>
            <label className="who-label" title="There is no login in the pilot. Pick your name so your approvals and agent runs are recorded under it.">
              <span className="muted small">Working as</span>
              <StaffSwitcher id="staff-switcher" user={user} onPick={pick} />
            </label>
            <button className="ghost who" onClick={() => setMenu(true)} title="Switch staff member" aria-label={`Working as ${user}. Switch staff member`}><span className="initials" aria-hidden="true">{user.split(" ").map((w) => w[0]).join("")}</span><span className="who-name">{user.split(" ")[0]}</span></button>
          </div>
        </header>
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
            <Route path="/records/:kind" element={<Records />} />
            <Route path="/records/:kind/:id" element={<Records />} />
            <Route path="/activity" element={<Activity />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/savings" element={<Savings />} />
            <Route path="/systems" element={<Systems />} />
            <Route path="/systems/:system" element={<Systems />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/admin" element={<Admin demo={!!workspace?.demo} onRestart={restart} restarting={restarting} />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>
      </div>
      <RecordPanel />
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
