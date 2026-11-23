import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AGENT_NAMES, day, nzd, type SavingsEntry } from "../api";
import { useApi } from "../useApi";

export default function Savings() {
  const { data } = useApi<{ entries: SavingsEntry[]; rates: Record<string, number> }>("/savings");
  const [agent, setAgent] = useState("");
  const entries = useMemo(() => (data?.entries ?? []).filter((e) => !agent || e.agent === agent), [data, agent]);
  const cumulative = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const e of entries) byDay.set(e.date, (byDay.get(e.date) ?? 0) + e.dollarsSaved);
    let run = 0;
    return [...byDay.entries()].sort().map(([date, v]) => ({ date, total: Math.round((run += v)) }));
  }, [entries]);
  const hours = entries.reduce((n, e) => n + e.minutesSaved, 0) / 60;
  const dollars = entries.reduce((n, e) => n + e.dollarsSaved, 0);
  const manual = entries.reduce((n, e) => n + e.manualMinutes, 0) / 60;

  function exportCsv() {
    const rows = [["Date", "Agent", "Work", "Manual minutes", "With agent minutes", "Minutes saved", "Hourly rate NZD", "Saved NZD"], ...entries.map((e) => [e.date, AGENT_NAMES[e.agent], e.description, e.manualMinutes, e.agentAssistedMinutes, e.minutesSaved, e.hourlyRate, e.dollarsSaved])];
    const blob = new Blob([rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "cubro-agent-savings.csv"; a.click();
  }

  return (
    <>
      <div className="page-head"><div><h1>Time & money saved</h1><p className="muted">Each approved draft is compared with how long the same job takes by hand, priced at the team's hourly cost (set in Settings).</p></div>
        <button className="btn" onClick={exportCsv}>Export CSV</button></div>
      <div className="toolbar"><select value={agent} onChange={(e) => setAgent(e.target.value)}><option value="">All agents</option><option value="social-media">Social Media Planner</option><option value="supplier-outreach">Supplier Outreach</option></select></div>
      <div className="kpis">
        <div className="kpi"><span>Hours saved</span><strong>{hours.toFixed(1)} h</strong><small>of {manual.toFixed(1)} h manual work</small></div>
        <div className="kpi"><span>Money saved</span><strong>{nzd(dollars)}</strong><small>at {data ? Object.entries(data.rates).map(([k, v]) => `${nzd(v)}/h ${k === "social-media" ? "marketing" : "purchasing"}`).join(", ") : ""}</small></div>
        <div className="kpi"><span>Jobs done with an agent</span><strong>{entries.length}</strong><small>{entries.length ? Math.round((hours * 60) / entries.length) : 0} min saved each</small></div>
      </div>
      <section className="card"><h2>Cumulative savings (NZD)</h2>
        <div style={{ height: 220 }}><ResponsiveContainer><AreaChart data={cumulative}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#0000001a" /><XAxis dataKey="date" tickFormatter={(d) => day(d).replace(/ \d{4}$/, "")} fontSize={12} /><YAxis fontSize={12} width={50} /><Tooltip formatter={(v: number) => nzd(v)} labelFormatter={day} /><Area dataKey="total" stroke="#317CFF" fill="#317CFF22" /></AreaChart></ResponsiveContainer></div>
      </section>
      <section className="card flush scroll">
        <table className="table"><thead><tr><th>Date</th><th>Agent</th><th>Work</th><th className="num">By hand</th><th className="num">With agent</th><th className="num">Saved</th><th className="num">NZD</th></tr></thead>
          <tbody>{entries.slice(0, 200).map((e) => <tr key={e.id}><td>{day(e.date)}</td><td>{AGENT_NAMES[e.agent]}</td><td>{e.description}</td><td className="num">{e.manualMinutes} min</td><td className="num">{e.agentAssistedMinutes} min</td><td className="num">{e.minutesSaved} min</td><td className="num">{nzd(e.dollarsSaved)}</td></tr>)}</tbody></table>
      </section>
    </>
  );
}
