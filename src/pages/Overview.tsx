import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AGENT_NAMES, DRAFT_NOUN, agentFor, api, day, getUser, hm, money, pct, teamOf, todayNz, when, type ActivityLine, type AgentRun, type ApprovalItem, type Dashboard } from "../api";
import { useApi } from "../useApi";

export default function Overview() {
  const { data, error, reload } = useApi<Dashboard>("/dashboard");
  const { data: drafts, error: draftsError, reload: reloadDrafts } = useApi<ApprovalItem[]>("/approvals?status=all");
  const { data: recent } = useApi<ActivityLine[]>("/activity/record");
  const [busy, setBusy] = useState(false);
  const [ran, setRan] = useState<{ ok: boolean; text: string }>();
  const nav = useNavigate();
  if (error || draftsError) return <div className="error">{error ?? draftsError}</div>;
  if (!data || !drafts) return <div className="muted">Loading…</div>;
  const t = data.totals;

  const me = getUser();
  const mine = agentFor(me);
  const other = mine === "social-media" ? "supplier-outreach" : "social-media";
  const assistant = data.agents.find((a) => a.id === mine)!;
  const waiting = drafts.filter((a) => a.status === "pending" && a.agent === mine).sort((a, b) => Number(b.priority === "high") - Number(a.priority === "high"));
  const urgent = waiting.filter((a) => a.priority === "high").length;
  const elsewhere = drafts.filter((a) => a.status === "pending" && a.agent === other).length;
  const today = todayNz();
  const doneToday = drafts.filter((a) => a.decidedBy === me && a.decidedAt && new Date(a.decidedAt).toLocaleDateString("en-CA", { timeZone: "Pacific/Auckland" }) === today);
  const noun = (n: number, agent = mine) => `${n} ${DRAFT_NOUN[agent][n === 1 ? 0 : 1]}`;
  const hour = Number(new Date().toLocaleString("en-NZ", { hour: "numeric", hour12: false, timeZone: "Pacific/Auckland" }));
  const hello = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  async function getDrafts() {
    setBusy(true); setRan(undefined);
    try {
      const run = await api<AgentRun>(`/agents/${mine}/run`, { method: "POST" });
      if (run.itemsCreated > 0) nav(`/approvals?agent=${mine}`);
      else { setRan({ ok: true, text: `${AGENT_NAMES[mine]} looked and found nothing new to draft: ${run.summary}.` }); reload(); reloadDrafts(); }
    } catch (e) { setRan({ ok: false, text: `That didn't work: ${e instanceof Error ? e.message : String(e)}` }); }
    finally { setBusy(false); }
  }
  const askForMore = <button type="button" className={waiting.length ? "btn" : "btn primary big"} disabled={busy || !assistant.enabled} onClick={getDrafts}>{busy ? "Drafting…" : waiting.length ? "Ask for more drafts" : `Ask for new ${DRAFT_NOUN[mine][1]}`}</button>;
  const step = waiting.length ? 2 : 1;

  return (
    <>
      <div className="page-head"><div><h1>{hello}, {me.split(" ")[0]}</h1><p className="muted">Here is what needs you today. {AGENT_NAMES[mine]} is the assistant that drafts {DRAFT_NOUN[mine][1]} for {teamOf(me)}; nothing goes out until someone at Cubro approves it.</p></div></div>
      <div className="today">
        <div>
        <section className="card todo">
          <p className="small muted">Your to-do for today · {teamOf(me)}</p>
          {waiting.length > 0 ? <>
            <h2>{noun(waiting.length)} {waiting.length === 1 ? "is" : "are"} waiting for you to check</h2>
            <p>{urgent > 0 ? `${urgent} ${urgent === 1 ? "is" : "are"} urgent and come${urgent === 1 ? "s" : ""} first. ` : ""}They open one at a time, about {hm(waiting.reduce((n, a) => n + a.estimate.reviewMinutes, 0))} to read them all.</p>
            <ul className="todo-list">{waiting.slice(0, 3).map((a) => <li key={a.id}><Link to={`/approvals/${a.id}?agent=${mine}`}>{a.title}</Link>{a.priority === "high" && <span className="pill warn">Urgent</span>}</li>)}{waiting.length > 3 && <li className="muted">and {waiting.length - 3} more</li>}</ul>
            <div className="row gap wrap"><Link className="btn primary big" to={`/approvals?agent=${mine}`}>{waiting.length === 1 ? "Check it now" : "Check the first one"}</Link></div>
          </> : <>
            <h2>Nothing is waiting for you</h2>
            {assistant.enabled
              ? <p>You're up to date. Ask {AGENT_NAMES[mine]} to look for anything new; it takes a few seconds and whatever it drafts comes back here for you to check.</p>
              : <p>{AGENT_NAMES[mine]} is paused, so it is not drafting anything new. {assistant.owner} looks after it and can switch it back on in <Link to="/settings">Settings</Link>.</p>}
            {assistant.enabled && <div className="row gap wrap">{askForMore}</div>}
          </>}
          {ran && <div className={ran.ok ? "banner" : "error"} role="status">{ran.text}</div>}
        </section>
        <ol className="steps wide" aria-label="How it works">
          <li className={step === 1 ? "now" : "done"}><span>1</span><div><b>Ask the assistant</b><small>It reads Cubro's systems and writes drafts.</small></div></li>
          <li className={step === 2 ? "now" : ""}><span>2</span><div><b>Read the draft</b><small>One at a time, with the reason it was written.</small></div></li>
          <li><span>3</span><div><b>Approve, change or send back</b><small>Nothing goes out until you approve.</small></div></li>
        </ol>
        <div className="grid2">
          <section className="card"><h2>Done today</h2>
            {doneToday.length === 0 ? <p className="muted">Nothing yet. What you approve or send back today shows up here.</p> : <>
              <p>You approved {doneToday.filter((a) => a.status === "approved").length} and sent back {doneToday.filter((a) => a.status === "rejected").length}.</p>
              <ul className="todo-list">{doneToday.slice(0, 4).map((a) => <li key={a.id}><Link to={`/approvals/${a.id}?status=${a.status}`}>{a.title}</Link><span className={`pill ${a.status === "approved" ? "ok" : "bad"} plain`}>{a.status === "approved" ? "Approved" : "Sent back"}</span></li>)}</ul>
            </>}
          </section>
          <section className="card"><h2>Also waiting</h2>
            {waiting.length > 0 && assistant.enabled && <p>Want more to do? {askForMore}</p>}
            <p>{elsewhere > 0 ? <>{teamOf(me) === "Marketing" ? "Purchasing" : "Marketing"} has {noun(elsewhere, other)} waiting. <Link to={`/approvals?agent=${other}`}>Have a look</Link> if you are covering for them.</> : <span className="muted">The other team has nothing waiting.</span>}</p>
          </section>
        </div>
        </div>
        <div>
          <section className="card">
            <h2>How the pilot is going</h2>
            <div className="kpis compact">
              <Link to="/approvals?agent=all" className="kpi"><span>Drafts waiting, both teams</span><strong>{t.pending}</strong><small>{t.highPriority} urgent</small></Link>
              <Link to="/approvals?status=all" className="kpi"><span>Drafts approved</span><strong>{pct(t.approvalRate)}</strong><small>{t.approved} approved, {t.rejected} sent back</small></Link>
              <Link to="/savings?period=30" className="kpi"><span>Time saved, last 30 days</span><strong>{hm(t.last30.minutesSaved)}</strong><small>{hm(t.all.minutesSaved)} since {day(t.pilotStart)}</small></Link>
              <Link to="/savings?period=30" className="kpi"><span>Money saved, last 30 days</span><strong>{money(t.last30.dollarsSaved)}</strong><small>{money(t.all.dollarsSaved)} since {day(t.pilotStart)}</small></Link>
            </div>
            <p className="small muted">For the whole team. <Link to="/savings">Week by week</Link> · <Link to="/agents">What each assistant did</Link></p>
          </section>
          <section className="card">
            <div className="row between"><h2>Latest activity</h2><Link className="small" to="/activity">See the whole record</Link></div>
            <ul className="feed short">{(recent ?? []).slice(0, 8).map((a) => <li key={a.id}><span className="muted small">{when(a.at)}</span><span><b>{a.actor}</b> {a.kind === "approved" ? "approved" : a.kind === "sent_back" ? "sent back" : a.kind === "asked" ? "asked for drafts:" : "changed"} {a.what}{a.went.length > 0 && <span className="muted"> → {[...new Set(a.went.map((w) => w.system))].join(", ")}</span>}</span></li>)}</ul>
          </section>
        </div>
      </div>
      <p className="muted small">{data.provider.startsWith("Built-in") ? "During the pilot, drafts are written from built-in templates rather than an AI model." : `Drafts are written by ${data.provider}.`}</p>
    </>
  );
}
