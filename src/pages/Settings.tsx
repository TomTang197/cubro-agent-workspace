import { useEffect, useState } from "react";
import { STAFF, api, type AgentId, type Settings } from "../api";
import { CHANNELS, validateSettings } from "../../server/settings";
import { useApi } from "../useApi";

const AGENT_LABEL: Record<AgentId, string> = { "social-media": "Social Media Planner", "supplier-outreach": "Supplier Outreach" };

export default function SettingsPage() {
  const { data, error: loadError } = useApi<Settings>("/settings");
  const [saved, setSaved] = useState<Settings>();
  const [s, setS] = useState<Settings>();
  const [status, setStatus] = useState<{ kind: "ok" | "bad"; text: string }>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) { setSaved(data); setS(structuredClone(data)); } }, [data]);
  const dirty = !!s && !!saved && JSON.stringify(s) !== JSON.stringify(saved);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  if (loadError) return <div className="error">Settings couldn't be loaded: {loadError}</div>;
  if (!s || !saved) return <div className="muted">Loading…</div>;

  const errors = validateSettings(s);
  const invalid = Object.keys(errors).length > 0;
  const save = async () => {
    setBusy(true); setStatus(undefined);
    try {
      const next = await api<Settings>("/settings", { method: "PUT", body: s });
      setSaved(next); setS(structuredClone(next)); setStatus({ kind: "ok", text: "Saved" });
    } catch (e) { setStatus({ kind: "bad", text: `Not saved: ${e instanceof Error ? e.message : String(e)}` }); }
    finally { setBusy(false); }
  };
  const discard = () => { setS(structuredClone(saved)); setStatus(undefined); };
  const reset = async () => {
    if (!confirm("Start the pilot again from the original sample data?\n\nEvery draft, approval, saving and setting goes back to how it started, for everyone. This can't be undone.")) return;
    try { await api("/reset", { method: "POST" }); location.href = "/"; }
    catch (e) { setStatus({ kind: "bad", text: `Reset failed: ${e instanceof Error ? e.message : String(e)}` }); }
  };
  const edit = (change: (draft: Settings) => void) => { const next = structuredClone(s); change(next); setS(next); setStatus(undefined); };
  const num = (v: string) => (v.trim() === "" ? NaN : Number(v));
  const shown = (n: number) => (Number.isFinite(n) ? n : "");
  const Err = ({ at }: { at: string }) => (errors[at] ? <span className="field-error" role="alert">{errors[at]}</span> : null);
  const agentControls = (id: AgentId) => (
    <>
      <label className="check switch"><input type="checkbox" checked={s.agents[id].enabled} onChange={(e) => edit((d) => { d.agents[id].enabled = e.target.checked; })} /> <span><b>{s.agents[id].enabled ? "On" : "Paused"}</b> <span className="muted">· {s.agents[id].enabled ? `untick to pause ${AGENT_LABEL[id]}` : `tick to switch ${AGENT_LABEL[id]} back on`}. A paused agent drafts nothing new; drafts already waiting can still be approved.</span></span></label>
      <label className="field"><span>Owner</span><select value={s.agents[id].owner} onChange={(e) => edit((d) => { d.agents[id].owner = e.target.value; })}>{[...new Set([...STAFF, s.agents[id].owner])].map((n) => <option key={n}>{n}</option>)}</select><small className="muted">The person to ask about this agent. Shown on the Overview and Agents pages.</small></label>
    </>
  );

  return (
    <>
      <div className="page-head"><div><h1>Settings</h1><p className="muted">How the agents behave and how savings are priced. Changes apply to everyone once you press Save, and to drafts and approvals made after that.</p></div></div>
      <div className="grid2">
        <section className="card"><h2>Social Media Planner</h2>
          {agentControls("social-media")}
          <label className="field"><span>Posts per run</span><input type="number" inputMode="numeric" min={1} max={30} value={shown(s.social.postsPerRun)} onChange={(e) => edit((d) => { d.social.postsPerRun = num(e.target.value); })} /><small className="muted">How many posts it drafts each time it runs.</small><Err at="social.postsPerRun" /></label>
          <label className="field"><span>Plan ahead (days)</span><input type="number" inputMode="numeric" min={1} max={90} value={shown(s.social.horizonDays)} onChange={(e) => edit((d) => { d.social.horizonDays = num(e.target.value); })} /><small className="muted">How far into the future it schedules posts.</small><Err at="social.horizonDays" /></label>
          <label className="field"><span>Tone of voice</span><textarea rows={2} value={s.social.tone} onChange={(e) => edit((d) => { d.social.tone = e.target.value; })} /><Err at="social.tone" /></label>
          <fieldset className="field"><legend>Channels</legend><div className="row gap wrap">{CHANNELS.map((c) => <label key={c} className="check"><input type="checkbox" checked={s.social.channels.includes(c)} onChange={(e) => edit((d) => { d.social.channels = CHANNELS.filter((x) => (x === c ? e.target.checked : d.social.channels.includes(x))); })} /> {c}</label>)}</div><Err at="social.channels" /></fieldset>
        </section>
        <section className="card"><h2>Supplier Outreach</h2>
          {agentControls("supplier-outreach")}
          <label className="field"><span>Chase orders this many days after due date</span><input type="number" inputMode="numeric" min={0} max={60} value={shown(s.supplier.overdueGraceDays)} onChange={(e) => edit((d) => { d.supplier.overdueGraceDays = num(e.target.value); })} /><Err at="supplier.overdueGraceDays" /></label>
          <label className="field"><span>Flag stock below this many weeks of cover</span><input type="number" inputMode="numeric" min={1} max={52} value={shown(s.supplier.lowStockCoverageWeeks)} onChange={(e) => edit((d) => { d.supplier.lowStockCoverageWeeks = num(e.target.value); })} /><Err at="supplier.lowStockCoverageWeeks" /></label>
          <label className="field"><span>Max emails per run</span><input type="number" inputMode="numeric" min={1} max={50} value={shown(s.supplier.maxEmailsPerRun)} onChange={(e) => edit((d) => { d.supplier.maxEmailsPerRun = num(e.target.value); })} /><Err at="supplier.maxEmailsPerRun" /></label>
          <label className="field"><span>Emails signed by</span><input value={s.supplier.sender} onChange={(e) => edit((d) => { d.supplier.sender = e.target.value; })} /><small className="muted">The name the agent puts at the bottom of every supplier email it drafts. Whoever approves an email can sign it with their own name first.</small><Err at="supplier.sender" /></label>
        </section>
        <section className="card"><h2>Savings pricing</h2>
          <label className="field"><span>Marketing hourly cost (NZD)</span><input type="number" inputMode="decimal" min={1} max={500} value={shown(s.hourlyRates["social-media"])} onChange={(e) => edit((d) => { d.hourlyRates["social-media"] = num(e.target.value); })} /><Err at="hourlyRates.social-media" /></label>
          <label className="field"><span>Purchasing hourly cost (NZD)</span><input type="number" inputMode="decimal" min={1} max={500} value={shown(s.hourlyRates["supplier-outreach"])} onChange={(e) => edit((d) => { d.hourlyRates["supplier-outreach"] = num(e.target.value); })} /><Err at="hourlyRates.supplier-outreach" /></label>
          <p className="small muted">What an hour of each team's time costs Cubro. Used to turn time saved into dollars for new approvals; savings already logged keep the rate they were logged at. Include on-costs (KiwiSaver, ACC, leave) for a fair number.</p>
        </section>
        <section className="card"><h2>About this pilot</h2>
          <p className="small">The four connected systems (Microsoft 365, Salesforce, ClickUp and Infor LN) are simulated with made-up sample data, so nothing you approve here reaches a real supplier, customer or social channel.</p>
          <p className="small muted">Connecting the real systems, or having Google Gemini write the drafts (<code>GEMINI_API_KEY</code>), is a job for IT; the steps are in the project README.</p>
          <h3>Start again</h3>
          <p className="small">Puts every draft, approval, saving and setting back to the original sample, for everyone. Useful before a demo; it can't be undone.</p>
          <button className="btn danger" onClick={reset}>Reset sample data</button>
        </section>
      </div>
      <div className={`savebar ${dirty || status ? "show" : ""}`} role="status">
        <span className={status?.kind === "bad" || (dirty && invalid) ? "bad-text" : status?.kind === "ok" && !dirty ? "ok-text" : ""}>
          {dirty ? (invalid ? "Fix the highlighted fields before saving." : status?.kind === "bad" ? status.text : "You have unsaved changes.") : status?.text ?? "No changes to save."}
        </span>
        <span className="row gap"><button className="btn" onClick={discard} disabled={!dirty || busy}>Discard</button><button className="btn primary" onClick={save} disabled={!dirty || invalid || busy}>{busy ? "Saving…" : "Save changes"}</button></span>
      </div>
    </>
  );
}
