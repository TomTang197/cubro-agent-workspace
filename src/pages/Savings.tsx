import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AGENT_IDS, TEAMS, decisionLabel as decision, periodStart, savingsCsv, summarise } from "../../server/savings";
import { AGENT_NAMES, day, hm, money, shortDay, type AgentId, type SavingsEntry, type SavingsLine } from "../api";
import { useApi } from "../useApi";

interface SavingsData {
  entries: SavingsEntry[];
  rates: Record<AgentId, number>;
  today: string;
  pilotStart: string;
  assumptions: { editMinutes: number; jobs: { agent: AgentId; job: string; manualMinutes: number; reviewMinutes: number }[] };
}

const PERIODS = [{ id: "7", label: "Last 7 days" }, { id: "30", label: "Last 30 days" }, { id: "all", label: "Since pilot start" }];
const PAGE = 50;
const rateText = (l: SavingsLine) => (l.hourlyRates.length ? l.hourlyRates.map((r) => `$${r}`).join(", ") + "/h" : "—");

export default function Savings() {
  const { data, error } = useApi<SavingsData>("/savings");
  const [params, setParams] = useSearchParams();
  const agent = AGENT_IDS.find((a) => a === params.get("agent")) ?? "";
  const period = PERIODS.find((p) => p.id === params.get("period"))?.id ?? "all";
  const [showAll, setShowAll] = useState(false);
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); if (v && v !== "all") p.set(k, v); else p.delete(k); setParams(p, { replace: true }); setShowAll(false); };

  const from = data ? (period === "all" ? data.pilotStart : periodStart(data.today, Number(period))) : "";
  const inPeriod = useMemo(() => (data?.entries ?? []).filter((e) => e.date >= from), [data, from]);
  const entries = useMemo(() => inPeriod.filter((e) => !agent || e.agent === agent), [inPeriod, agent]);
  const total = useMemo(() => summarise(entries), [entries]);
  const lines = useMemo(() => AGENT_IDS.filter((a) => !agent || a === agent).map((a) => ({ agent: a, ...summarise(inPeriod.filter((e) => e.agent === a)) })), [inPeriod, agent]);
  const cumulative = useMemo(() => {
    const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));
    // Each point is the same sum as the headline would be on that day.
    return sorted.flatMap((e, i) => (sorted[i + 1]?.date === e.date ? [] : [{ date: e.date, total: summarise(sorted.slice(0, i + 1)).dollarsSaved }]));
  }, [entries]);

  if (error) return <div className="error">{error}</div>;
  if (!data) return <div className="muted">Loading…</div>;
  const periodLabel = period === "all" ? `${day(data.pilotStart)} to ${day(data.today)}` : `${day(from)} to ${day(data.today)}`;
  const shown = showAll ? entries : entries.slice(0, PAGE);

  function exportCsv() {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([savingsCsv(entries)], { type: "text/csv;charset=utf-8" }));
    a.download = `cubro-agent-savings${agent ? `-${agent}` : ""}-${from}-to-${data!.today}.csv`;
    a.click();
  }

  return (
    <>
      <div className="page-head"><div><h1>Time & money saved</h1><p className="muted">Every draft a person approved or rejected, compared with doing the same job by hand. These are estimates from the standard times below, not timesheets.</p></div>
        <button className="btn nowrap" onClick={exportCsv} disabled={!entries.length}>Export {entries.length} rows to Excel (CSV)</button></div>
      <div className="toolbar">
        <div className="seg">{PERIODS.map((p) => <button key={p.id} className={period === p.id ? "on" : ""} onClick={() => set("period", p.id)}>{p.label}</button>)}</div>
        <select aria-label="Agent" value={agent} onChange={(e) => set("agent", e.target.value)}><option value="">All agents</option>{AGENT_IDS.map((a) => <option key={a} value={a}>{AGENT_NAMES[a]}</option>)}</select>
        <span className="muted small">{periodLabel}</span>
      </div>
      <div className="kpis">
        <div className="kpi"><span>Time saved</span><strong>{hm(total.minutesSaved)}</strong><small>{hm(total.manualMinutes)} by hand, {hm(total.reviewMinutes + total.rejectedMinutes)} with the agents</small></div>
        <div className="kpi"><span>Money saved</span><strong>{money(total.dollarsSaved)}</strong><small>{lines.length > 1 ? "each agent's time saved × its team's hourly cost" : "time saved × the team's hourly cost"} ({rateText(total)})</small></div>
        <div className="kpi"><span>Drafts approved</span><strong>{total.approved}</strong><small>{total.approved ? `${Math.round((total.manualMinutes - total.reviewMinutes) / total.approved)} min saved per approved draft, before rejected drafts` : "none in this period"}; {total.rejected} rejected</small></div>
      </div>

      <section className="card flush"><h2 className="pad-head">How it adds up</h2>
        <div className="scroll"><table className="table"><thead><tr><th>Agent</th><th className="num">Approved</th><th className="num">Same jobs by hand</th><th className="num">Reviewing & editing</th><th className="num">Rejected drafts</th><th className="num">Time saved</th><th className="num">Hourly cost</th><th className="num">Money saved</th></tr></thead>
          <tbody>{lines.map((l) => <tr key={l.agent}><td>{AGENT_NAMES[l.agent]} <span className="muted small">({TEAMS[l.agent]})</span></td><td className="num">{l.approved}</td><td className="num">{hm(l.manualMinutes)}</td><td className="num">{hm(-l.reviewMinutes)}</td><td className="num">{l.rejected ? `${hm(-l.rejectedMinutes)} (${l.rejected})` : "—"}</td><td className="num">{hm(l.minutesSaved)}</td><td className="num">{rateText(l)}</td><td className="num">{money(l.dollarsSaved)}</td></tr>)}</tbody>
          {lines.length > 1 && <tfoot><tr><td>Total</td><td className="num">{total.approved}</td><td className="num">{hm(total.manualMinutes)}</td><td className="num">{hm(-total.reviewMinutes)}</td><td className="num">{total.rejected ? `${hm(-total.rejectedMinutes)} (${total.rejected})` : "—"}</td><td className="num">{hm(total.minutesSaved)}</td><td className="num" /><td className="num">{money(total.dollarsSaved)}</td></tr></tfoot>}
        </table></div>
        <p className="muted small pad-foot">Time saved = the same jobs by hand − reviewing and editing − time spent on drafts that were rejected. Money saved = time saved × hourly cost.</p>
      </section>

      <div className="grid2">
        <section className="card"><h2>Money saved so far (NZD)</h2>
          {cumulative.length ? <div style={{ height: 220 }}><ResponsiveContainer><AreaChart data={cumulative}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#0000001a" /><XAxis dataKey="date" tickFormatter={shortDay} fontSize={12} minTickGap={24} /><YAxis fontSize={12} width={56} tickFormatter={(v: number) => `$${v.toLocaleString("en-NZ")}`} /><Tooltip formatter={(v: number) => [money(v), "Saved up to this day"]} labelFormatter={day} /><Area isAnimationActive={false} dataKey="total" stroke="#317CFF" fill="#317CFF22" /></AreaChart></ResponsiveContainer></div> : <p className="muted">Nothing was approved or rejected in this period.</p>}
        </section>
        <section className="card"><h2>Standard times used</h2>
          <div className="scroll"><table className="table plain-table"><thead><tr><th>Job</th><th className="num">By hand</th><th className="num">Reviewing a draft</th><th className="num">Hourly cost now</th></tr></thead>
            <tbody>{data.assumptions.jobs.map((j) => <tr key={j.agent}><td>{j.job}</td><td className="num">{j.manualMinutes} min</td><td className="num">{j.reviewMinutes} min</td><td className="num">${data.rates[j.agent]}/h {TEAMS[j.agent]}</td></tr>)}</tbody></table></div>
          <ul className="plain small">
            <li>If the reviewer edits a draft, {data.assumptions.editMinutes} more minutes are counted.</li>
            <li>A rejected draft saves nothing, and its review time is taken off the total.</li>
            <li>Each job is priced at the hourly cost on the day it was decided. Change the cost in <Link to="/settings">Settings</Link>; it applies from then on.</li>
            <li>The cost of running the agents themselves is not included.</li>
          </ul>
        </section>
      </div>

      <section className="card flush">
        <div className="scroll"><table className="table"><thead><tr><th>Date</th><th>Work</th><th>Decision</th><th className="num">By hand</th><th className="num">With agent</th><th className="num">Saved</th><th className="num">Hourly cost</th><th className="num">NZD</th></tr></thead>
          <tbody>{shown.map((e) => <tr key={e.id}><td className="nowrap">{day(e.date)}</td><td>{e.approvalId ? <Link to={`/approvals/${e.approvalId}?status=all`}>{e.description}</Link> : e.description}<div className="muted small">{AGENT_NAMES[e.agent]}{e.reviewer ? ` · reviewed by ${e.reviewer}` : ""}</div></td><td><span className={`pill plain ${e.outcome === "rejected" ? "bad" : e.edited ? "warn" : "ok"}`}>{decision(e)}</span></td><td className="num">{e.manualMinutes ? `${e.manualMinutes} min` : "—"}</td><td className="num">{e.agentAssistedMinutes} min</td><td className="num">{hm(e.minutesSaved)}</td><td className="num">${e.hourlyRate}/h</td><td className="num">{money(e.dollarsSaved)}</td></tr>)}</tbody>
          {entries.length > 0 && <tfoot><tr><td colSpan={3}>Total of all {entries.length} rows</td><td className="num">{hm(total.manualMinutes)}</td><td className="num">{hm(total.reviewMinutes + total.rejectedMinutes)}</td><td className="num">{hm(total.minutesSaved)}</td><td className="num" /><td className="num">{money(total.dollarsSaved)}</td></tr></tfoot>}
        </table></div>
        {entries.length === 0 && <p className="muted pad">Nothing was approved or rejected in this period.</p>}
        {entries.length > 0 && <p className="muted small pad-foot">Each row is rounded to the cent. The total is the total time saved × hourly cost, so it can differ by a cent or two from adding up the rows.</p>}
        {entries.length > PAGE && <p className="pad-foot"><button className="btn" onClick={() => setShowAll(!showAll)}>{showAll ? `Show only the latest ${PAGE}` : `Show all ${entries.length} rows`}</button> <span className="muted small">Showing {shown.length} of {entries.length}. The total and the export always cover all of them.</span></p>}
      </section>
    </>
  );
}
