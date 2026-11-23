import { useEffect, useState } from "react";
import { api, type Settings } from "../api";
import { useApi } from "../useApi";

export default function SettingsPage() {
  const { data } = useApi<Settings>("/settings");
  const [s, setS] = useState<Settings>();
  const [saved, setSaved] = useState("");
  useEffect(() => { if (data) setS(structuredClone(data)); }, [data]);
  if (!s) return <div className="muted">Loading…</div>;
  const save = async () => { setS(await api<Settings>("/settings", { method: "PUT", body: s })); setSaved("Saved"); setTimeout(() => setSaved(""), 2000); };
  const reset = async () => { if (confirm("Reset all sample data and history? This can't be undone.")) { await api("/reset", { method: "POST" }); location.href = "/"; } };
  const num = (v: string) => Number(v) || 0;
  return (
    <>
      <div className="page-head"><div><h1>Settings</h1><p className="muted">How the agents behave and how savings are priced.</p></div><div className="row gap">{saved && <span className="pill ok">{saved}</span>}<button className="btn primary" onClick={save}>Save</button></div></div>
      <div className="grid2">
        <section className="card"><h2>Savings pricing</h2>
          <label className="field"><span>Marketing hourly cost (NZD)</span><input type="number" value={s.hourlyRates["social-media"]} onChange={(e) => setS({ ...s, hourlyRates: { ...s.hourlyRates, "social-media": num(e.target.value) } })} /></label>
          <label className="field"><span>Purchasing hourly cost (NZD)</span><input type="number" value={s.hourlyRates["supplier-outreach"]} onChange={(e) => setS({ ...s, hourlyRates: { ...s.hourlyRates, "supplier-outreach": num(e.target.value) } })} /></label>
          <p className="small muted">Applies to new approvals. Include on-costs (KiwiSaver, ACC, leave) for a fair number.</p>
        </section>
        <section className="card"><h2>Social Media Planner</h2>
          <label className="field"><span>Posts per run</span><input type="number" value={s.social.postsPerRun} onChange={(e) => setS({ ...s, social: { ...s.social, postsPerRun: num(e.target.value) } })} /></label>
          <label className="field"><span>Plan ahead (days)</span><input type="number" value={s.social.horizonDays} onChange={(e) => setS({ ...s, social: { ...s.social, horizonDays: num(e.target.value) } })} /></label>
          <label className="field"><span>Tone of voice</span><textarea rows={2} value={s.social.tone} onChange={(e) => setS({ ...s, social: { ...s.social, tone: e.target.value } })} /></label>
          <div className="field"><span>Channels</span><div className="row gap">{(["LinkedIn", "Facebook", "Instagram"] as const).map((c) => <label key={c} className="check"><input type="checkbox" checked={s.social.channels.includes(c)} onChange={(e) => setS({ ...s, social: { ...s.social, channels: e.target.checked ? [...s.social.channels, c] : s.social.channels.filter((x) => x !== c) } })} /> {c}</label>)}</div></div>
        </section>
        <section className="card"><h2>Supplier Outreach</h2>
          <label className="field"><span>Chase orders this many days after due date</span><input type="number" value={s.supplier.overdueGraceDays} onChange={(e) => setS({ ...s, supplier: { ...s.supplier, overdueGraceDays: num(e.target.value) } })} /></label>
          <label className="field"><span>Flag stock below this many weeks of cover</span><input type="number" value={s.supplier.lowStockCoverageWeeks} onChange={(e) => setS({ ...s, supplier: { ...s.supplier, lowStockCoverageWeeks: num(e.target.value) } })} /></label>
          <label className="field"><span>Max emails per run</span><input type="number" value={s.supplier.maxEmailsPerRun} onChange={(e) => setS({ ...s, supplier: { ...s.supplier, maxEmailsPerRun: num(e.target.value) } })} /></label>
          <label className="field"><span>Emails signed by</span><input value={s.supplier.sender} onChange={(e) => setS({ ...s, supplier: { ...s.supplier, sender: e.target.value } })} /></label>
        </section>
        <section className="card"><h2>Pilot data</h2>
          <p className="small">All four systems are simulated with sample data. To connect a real one, implement its connector in <code>server/connectors/live</code> and set <code>CONNECTOR_M365=live</code> (or SALESFORCE, CLICKUP, INFORLN). Set <code>OPENAI_API_KEY</code> to have a model write the drafts.</p>
          <button className="btn danger" onClick={reset}>Reset sample data</button>
        </section>
      </div>
    </>
  );
}
