import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { day, nzd, pct, when, type Dashboard } from "../api";
import { useApi } from "../useApi";

export default function Overview() {
  const { data, error } = useApi<Dashboard>("/dashboard");
  if (error) return <div className="error">{error}</div>;
  if (!data) return <div className="muted">Loading…</div>;
  const t = data.totals;
  return (
    <>
      <div className="page-head"><div><h1>Overview</h1><p className="muted">Agents are AI assistants that draft routine work from Microsoft 365, Salesforce, ClickUp and Infor LN. Nothing goes out until someone at Cubro approves it, and every approval is logged with the time it saved.</p></div></div>
      <div className="kpis">
        <Link to="/approvals" className="kpi"><span>Waiting for approval</span><strong>{t.pending}</strong><small>{t.highPriority} high priority</small></Link>
        <Link to="/savings" className="kpi"><span>Hours saved, last 30 days</span><strong>{t.hoursSaved30.toFixed(1)} h</strong><small>{t.hoursSaved.toFixed(1)} h since {day(t.pilotStart)}</small></Link>
        <Link to="/savings" className="kpi"><span>Money saved, last 30 days</span><strong>{nzd(t.dollarsSaved30)}</strong><small>{nzd(t.dollarsSaved)} since pilot start</small></Link>
        <div className="kpi"><span>Approval rate</span><strong>{pct(t.approvalRate)}</strong><small>{t.decided} drafts reviewed</small></div>
      </div>
      <div className="grid2">
        <section className="card">
          <h2>Hours saved per week</h2>
          <div style={{ height: 240 }}>
            <ResponsiveContainer>
              <BarChart data={data.weekly}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#0000001a" />
                <XAxis dataKey="week" tickFormatter={(w) => day(w).replace(/ \d{4}$/, "")} fontSize={12} />
                <YAxis fontSize={12} width={30} />
                <Tooltip cursor={{ fill: "#0000000a" }} formatter={(v: number) => `${v} h`} labelFormatter={(w) => `Week of ${day(w)}`} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="supplier-outreach" name="Supplier Outreach" stackId="a" fill="#317CFF" />
                <Bar dataKey="social-media" name="Social Media Planner" stackId="a" fill="#93B8FF" radius={[3, 3, 0, 0]} />
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
      <div className="grid2">
        {data.agents.map((a) => (
          <section className="card agent-card" key={a.id}>
            <div className="row between"><h3>{a.name}</h3><span className={`pill ${a.enabled ? "ok" : ""}`}>{a.enabled ? "Active" : "Paused"}</span></div>
            <p className="muted small">{a.team} · owner {a.owner} · runs {a.schedule}</p>
            <p>{a.description}</p>
            <div className="stats">
              <div><strong>{a.pending}</strong><span>pending</span></div>
              <div><strong>{pct(a.approvalRate)}</strong><span>approved</span></div>
              <div><strong>{pct(a.editRate)}</strong><span>edited first</span></div>
              <div><strong>{a.hoursSaved.toFixed(1)} h</strong><span>saved</span></div>
              <div><strong>{nzd(a.dollarsSaved)}</strong><span>saved</span></div>
            </div>
            <div className="row gap"><Link className="btn primary" to={`/approvals?agent=${a.id}`}>Review {a.pending} drafts</Link><Link className="btn" to="/agents">Runs</Link></div>
          </section>
        ))}
      </div>
      <p className="muted small">{data.provider.startsWith("Built-in") ? "During the pilot, drafts are written from built-in templates rather than an AI model." : `Drafts are written by ${data.provider}.`}</p>
    </>
  );
}
