import { useState } from "react";
import { Link } from "react-router-dom";
import { adminMenu } from "../api";

export default function Admin({ demo, onRestart, restarting }: { demo: boolean; onRestart: () => void; restarting: boolean }) {
  const [pinned, setPinned] = useState(adminMenu.get());
  return (
    <>
      <div className="page-head"><div><h1>Admin</h1><p className="muted">For whoever looks after the workspace. Day-to-day work (reading drafts and approving them) never needs these pages, so they stay out of the menu.</p></div></div>
      <div className="grid2">
        <section className="card"><h2>Settings</h2>
          <p>Pause an assistant, change who owns it, how many drafts it writes, the tone of voice, and what an hour of each team's time costs.</p>
          <Link className="btn" to="/settings">Open Settings</Link>
        </section>
        <section className="card"><h2>Connected systems</h2>
          <p>What the assistants can read in Microsoft 365, Salesforce, ClickUp and Infor LN, and whether each one is live or running on sample data.</p>
          <Link className="btn" to="/systems">Open Connected systems</Link>
        </section>
        <section className="card"><h2>Demo</h2>
          {demo ? <>
            <p>This workspace runs on sample data, so nothing approved here leaves it. Starting again puts every draft, approval, saving and setting back to how it began, for everyone, and shows the three-step guide on this computer again.</p>
            <button className="btn" onClick={onRestart} disabled={restarting}>{restarting ? "Starting again…" : "Start the demo again"}</button>
          </> : <p>At least one system is live, so this is not a demo: approvals reach real people. The sample data can still be restored from Settings.</p>}
        </section>
        <section className="card"><h2>This computer</h2>
          <label className="check switch"><input type="checkbox" checked={pinned} onChange={(e) => { adminMenu.set(e.target.checked); setPinned(e.target.checked); }} /> <span><b>Keep Admin in the menu on this computer</b> <span className="muted">· otherwise it is reached from the link at the bottom of every page.</span></span></label>
          <p className="small muted">Nobody signs in under their own name in the pilot, so these pages are tucked away, not locked. Anyone who can open the workspace can open them.</p>
        </section>
      </div>
    </>
  );
}
