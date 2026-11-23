import { useState } from "react";
import { Link } from "react-router-dom";
import { api, when, type AgentId, type AgentRun } from "../api";
import { useApi } from "../useApi";

interface AgentInfo { id: AgentId; name: string; description: string; team: string; reads: string[]; writes: string[]; enabled: boolean; schedule: string; owner: string; runs: AgentRun[] }

export default function Agents() {
  const { data, error, reload } = useApi<AgentInfo[]>("/agents");
  const [busy, setBusy] = useState<string>();
  const [last, setLast] = useState<AgentRun>();
  const [failed, setFailed] = useState<{ agent: AgentId; message: string }>();
  async function run(id: AgentId) {
    setBusy(id); setFailed(undefined); setLast(undefined);
    try { setLast(await api<AgentRun>(`/agents/${id}/run`, { method: "POST" })); }
    catch (e) { setFailed({ agent: id, message: e instanceof Error ? e.message : String(e) }); }
    finally { reload(); setBusy(undefined); }
  }
  return (
    <>
      <div className="page-head"><div><h1>Agents</h1><p className="muted">Each agent reads from the company's systems, drafts work, and waits for a person to approve it. During the pilot an agent only runs when someone presses “Run now”; the planned times are not switched on yet. Anything it drafts lands in Approvals.</p></div></div>
      {error && <div className="error">{error}</div>}
      {!data && !error && <div className="muted">Loading…</div>}
      {data?.map((a) => (
        <section className="card" key={a.id}>
          <div className="row between wrap agent-head"><div><h2>{a.name} {!a.enabled && <span className="pill warn">Paused</span>}</h2><p className="muted small">{a.team} · owner {a.owner} · {a.enabled ? `planned for ${a.schedule}` : "paused"}</p></div>
            <button className="btn primary" disabled={!!busy || !a.enabled} onClick={() => run(a.id)}>{busy === a.id ? "Running…" : "Run now"}</button></div>
          {!a.enabled && <p className="small muted">This agent is paused. Turn it back on in <Link to="/settings">Settings</Link> to run it.</p>}
          {last?.agent === a.id && <div className="banner" role="status">Run finished: {last.summary}. {last.itemsCreated > 0 && <Link to={`/approvals?agent=${a.id}`}>Review them</Link>}</div>}
          {failed?.agent === a.id && <div className="error" role="alert">The run didn't finish: {failed.message}</div>}
          <p>{a.description}</p>
          <div className="grid2 tight">
            <div><b className="small">Reads from</b><ul className="plain">{a.reads.map((r) => <li key={r}>{r}</li>)}</ul></div>
            <div><b className="small">On approval, writes to</b><ul className="plain">{a.writes.map((r) => <li key={r}>{r}</li>)}</ul></div>
          </div>
          <h3>Recent runs</h3>
          <div className="scroll">
            <table className="table runs"><thead><tr><th>When</th><th>Started by</th><th>Result</th></tr></thead>
              <tbody>{a.runs.slice(0, 8).map((r) => (
                <tr key={r.id}><td className="nowrap">{when(r.startedAt)}</td><td>{r.triggeredBy}</td>
                  <td>{r.summary}{r.steps.length > 0 && <details className="small"><summary>What it checked</summary><ul className="plain">{r.steps.map((s, i) => <li key={i}><b>{s.system}</b>: {s.detail}</li>)}</ul></details>}</td></tr>
              ))}</tbody></table>
          </div>
        </section>
      ))}
    </>
  );
}
