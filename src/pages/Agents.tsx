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
      <div className="page-head"><div><h1>Assistants</h1><p className="muted">An assistant reads from the company's systems, writes drafts, and waits for a person to approve them. During the pilot an assistant only works when someone presses “Ask for drafts”; the planned times are not switched on yet. Whatever it drafts lands in Drafts to check.</p></div></div>
      {error && <div className="error">{error}</div>}
      {!data && !error && <div className="muted">Loading…</div>}
      {data?.map((a) => (
        <section className="card" key={a.id}>
          <div className="row between wrap agent-head"><div><h2>{a.name} {!a.enabled && <span className="pill warn">Paused</span>}</h2><p className="muted small">{a.team} · owner {a.owner} · {a.enabled ? `planned for ${a.schedule}` : "paused"}</p></div>
            <button className="btn primary" disabled={!!busy || !a.enabled} onClick={() => run(a.id)}>{busy === a.id ? "Drafting…" : "Ask for drafts"}</button></div>
          {!a.enabled && <p className="small muted">This assistant is paused. {a.owner} looks after it and can switch it back on in <Link to="/settings">Settings</Link>.</p>}
          {last?.agent === a.id && <div className="banner" role="status">Finished: {last.summary}. {last.itemsCreated > 0 && <Link to={`/approvals?agent=${a.id}`}>Check them</Link>}</div>}
          {failed?.agent === a.id && <div className="error" role="alert">That didn't finish: {failed.message}</div>}
          <p>{a.description}</p>
          <div className="grid2 tight">
            <div><b className="small">Reads from</b><ul className="plain">{a.reads.map((r) => <li key={r}>{r}</li>)}</ul></div>
            <div><b className="small">On approval, writes to</b><ul className="plain">{a.writes.map((r) => <li key={r}>{r}</li>)}</ul></div>
          </div>
          <h3>What it did recently</h3>
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
