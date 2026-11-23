import { useState } from "react";
import { Link } from "react-router-dom";
import { api, when, type AgentId, type AgentRun } from "../api";
import { useApi } from "../useApi";

interface AgentInfo { id: AgentId; name: string; description: string; team: string; reads: string[]; writes: string[]; enabled: boolean; schedule: string; owner: string; runs: AgentRun[] }

export default function Agents() {
  const { data, reload } = useApi<AgentInfo[]>("/agents");
  const [busy, setBusy] = useState<string>();
  const [last, setLast] = useState<AgentRun>();
  async function run(id: AgentId) {
    setBusy(id);
    try { setLast(await api<AgentRun>(`/agents/${id}/run`, { method: "POST" })); reload(); } finally { setBusy(undefined); }
  }
  return (
    <>
      <div className="page-head"><div><h1>Agents</h1><p className="muted">Each agent reads from the company's systems, drafts work, and waits for a person to approve it.</p></div></div>
      {last && <div className="banner">Run finished: {last.summary}. {last.itemsCreated > 0 && <Link to={`/approvals?agent=${last.agent}`}>Review them</Link>}</div>}
      {data?.map((a) => (
        <section className="card" key={a.id}>
          <div className="row between wrap"><div><h2>{a.name}</h2><p className="muted small">{a.team} · owner {a.owner} · scheduled {a.schedule}</p></div>
            <button className="btn primary" disabled={!!busy} onClick={() => run(a.id)}>{busy === a.id ? "Running…" : "Run now"}</button></div>
          <p>{a.description}</p>
          <div className="grid2 tight">
            <div><b className="small">Reads from</b><ul className="plain">{a.reads.map((r) => <li key={r}>{r}</li>)}</ul></div>
            <div><b className="small">On approval, writes to</b><ul className="plain">{a.writes.map((r) => <li key={r}>{r}</li>)}</ul></div>
          </div>
          <h3>Recent runs</h3>
          <table className="table"><thead><tr><th>When</th><th>Triggered by</th><th>Result</th><th>Steps</th></tr></thead>
            <tbody>{a.runs.slice(0, 8).map((r) => <tr key={r.id}><td>{when(r.startedAt)}</td><td>{r.triggeredBy}</td><td>{r.summary}</td><td className="small muted">{r.steps.length ? r.steps.map((s) => `${s.system}: ${s.detail}`).join(" · ") : "—"}</td></tr>)}</tbody></table>
        </section>
      ))}
    </>
  );
}
