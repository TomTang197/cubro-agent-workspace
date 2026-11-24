import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { agentFor, teamOf, when, type Notice } from "../api";
import { useApi } from "../useApi";

const seenKey = (user: string) => `cubro-notices-seen:${user}`;

/** What happened to your team's drafts while you were away: urgent ones waiting, and what colleagues approved or sent back. */
export default function Bell({ user }: { user: string }) {
  const { data, reload } = useApi<Notice[]>(`/notifications?agent=${agentFor(user)}&for=${encodeURIComponent(user)}`);
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(() => localStorage.getItem(seenKey(user)) ?? "");
  const box = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  useEffect(() => { setSeen(localStorage.getItem(seenKey(user)) ?? ""); setOpen(false); }, [user]);
  // Kept fresh as people move around, and every half minute while the workspace sits open.
  useEffect(() => { reload(); }, [pathname]);
  useEffect(() => { const t = window.setInterval(reload, 30_000); return () => window.clearInterval(t); }, [reload]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown); window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [open]);
  const notices = data ?? [];
  const fresh = notices.filter((n) => n.at > seen).length;
  const toggle = () => {
    // Opening the list is reading it: what is new now stays marked until it is closed.
    if (open && notices[0]) { localStorage.setItem(seenKey(user), notices[0].at); setSeen(notices[0].at); }
    setOpen(!open);
  };
  return (
    <div className="bell" ref={box}>
      <button type="button" className="ghost tool" onClick={toggle} aria-expanded={open} aria-label={fresh ? `Notifications, ${fresh} new` : "Notifications"} title="Notifications">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9Z" /><path d="M10 20a2.2 2.2 0 0 0 4 0" /></svg>
        {fresh > 0 && <span className="badge">{fresh > 9 ? "9+" : fresh}</span>}
      </button>
      {open && (
        <div className="bell-list" role="dialog" aria-label="Notifications">
          <div className="bell-head"><b>Notifications</b><span className="small muted">{teamOf(user)}'s drafts, last 7 days</span></div>
          {notices.length === 0 && <p className="muted pad">Nothing new. You will see it here when a colleague approves or sends back one of your team's drafts.</p>}
          {notices.map((n) => (
            <Link key={n.id} to={n.to} className={`notice ${n.at > seen ? "new" : ""}`} onClick={toggle}>
              <span className={`dot ${n.tone ?? ""}`} aria-hidden="true" />
              <span><span>{n.text}</span><span className="small muted">{when(n.at)}</span></span>
            </Link>
          ))}
          <Link className="bell-foot" to="/activity" onClick={toggle}>See everything in the activity record</Link>
        </div>
      )}
    </div>
  );
}
