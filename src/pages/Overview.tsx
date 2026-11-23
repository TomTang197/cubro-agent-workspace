import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { day, hm, money, pct, shortDay, when, type Dashboard } from "../api";
import { useApi } from "../useApi";

export default function Overview() {
  const { data, error } = useApi<Dashboard>("/dashboard");
  if (error) return <div className="error">{error}</div>;
  if (!data) return <div className="muted">Loading…</div>;
  const t = data.totals;
  const week = (w: string) => (w === t.currentWeek ? "This week" : shortDay(w));
  return (
    <>
      <div className="page-head"><div><h1>Overview</h1><p className="muted">Agents are AI assistants that draft routine work from Microsoft 365, Salesforce, ClickUp and Infor LN. Nothing goes out until someone at Cubro approves it, and every approval is logged with the time it saved.</p></div></div>
      <div className="kpis">
        <Link to="/approvals" className="kpi"><span>Waiting for approval</span><strong>{t.pending}</strong><small>{t.highPriority} high priority</small></Link>
        <Link to="/savings?period=30" className="kpi"><span>Time saved, last 30 days</span><strong>{hm(t.last30.minutesSaved)}</strong><small>{hm(t.all.minutesSaved)} since {day(t.pilotStart)}</small></Link>
        <Link to="/savings?period=30" className="kpi"><span>Money saved, last 30 days</span><strong>{money(t.last30.dollarsSaved)}</strong><small>{money(t.all.dollarsSaved)} since {day(t.pilotStart)}</small></Link>
        <Link to="/approvals?status=all" className="kpi"><span>Drafts approved</span><strong>{pct(t.approvalRate)}</strong><small>{t.approved} approved, {t.rejected} rejected</small></Link>
      </div>
      <div className="grid2">
        <section className="card">
          <h2>Hours saved per week</h2>
          <p className="muted small">Weeks start on Monday. After the time spent reviewing drafts, including ones that were rejected.{data.weekly.some((w) => w.week === t.currentWeek) ? " This week is still in progress." : ""}</p>
          <div style={{ height: 240 }}>
            <ResponsiveContainer>
              <BarChart data={data.weekly} stackOffset="sign">
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#0000001a" />
                <XAxis dataKey="week" tickFormatter={week} fontSize={12} />
                <YAxis fontSize={12} width={30} />
                <Tooltip cursor={{ fill: "#0000000a" }} formatter={(v: number) => hm(v * 60)} labelFormatter={(w) => (w === t.currentWeek ? `This week so far (from ${day(w)})` : `Week of ${day(w)}`)} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar isAnimationActive={false} dataKey="supplier-outreach" name="Supplier Outreach" stackId="a" fill="#7919FF" />
                <Bar isAnimationActive={false} dataKey="social-media" name="Social Media Planner" stackId="a" fill="#C3A1FF" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
        <section className="card">
          <h2>Recent activity</h2>
          <ul className="feed">{data.activity.map((a) => <li key={a.id}><span className="muted small">{when(a.at)}</span><span><b>{a.actor}</b> {a.action} — {a.detail}</span></li>)}</ul>
        </section>
      </div>
      <h2 className="section-title">Agents</h2>
      <p className="muted small">Each agent since {day(t.pilotStart)}. The two add up to the totals above.</p>
      <div className="grid2">
        {data.agents.map((a) => (
          <section className="card agent-card" key={a.id}>
            <div className="row between"><h3>{a.name}</h3><span className={`pill ${a.enabled ? "ok" : ""}`}>{a.enabled ? "Active" : "Paused"}</span></div>
            <p className="muted small">{a.team} · owner {a.owner} · {a.enabled ? `planned for ${a.schedule}` : "paused"}</p>
            <p>{a.description}</p>
            <div className="stats">
              <div><strong>{a.pending}</strong><span>pending</span></div>
              <div><strong>{pct(a.approvalRate)}</strong><span>approved</span></div>
              <div><strong>{pct(a.editRate)}</strong><span>needed edits</span></div>
              <div><strong>{hm(a.saved.minutesSaved)}</strong><span>time saved</span></div>
              <div><strong>{money(a.saved.dollarsSaved)}</strong><span>money saved</span></div>
            </div>
            <div className="row gap"><Link className="btn primary" to={`/approvals?agent=${a.id}`}>Review {a.pending} drafts</Link><Link className="btn" to={`/savings?agent=${a.id}`}>See what it saved</Link><Link className="btn" to="/agents">Runs</Link></div>
          </section>
        ))}
      </div>
      <p className="muted small">{data.provider.startsWith("Built-in") ? "During the pilot, drafts are written from built-in templates rather than an AI model." : `Drafts are written by ${data.provider}.`}</p>
    </>
  );
}
