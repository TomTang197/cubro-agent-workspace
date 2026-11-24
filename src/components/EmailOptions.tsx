import { useEffect, useState } from "react";
import type { EmailOption } from "../api";

const FROM: Record<EmailOption["from"], string> = { email: "To answer their email", order: "About the order", supplier: "From the supplier's record" };
const MAX_OWN_LINE = 600;

/**
 * What a supplier email can say, as buttons: one click puts the words in, another takes them out.
 * The last one is the writer's own line, which the assistant tidies before it goes in.
 */
export function EmailOptions({ options, isOn, onToggle, tidy, onOwn, onTyping, children }: {
  options: EmailOption[]; isOn: (o: EmailOption) => boolean; onToggle: (o: EmailOption) => void;
  tidy: (note: string) => Promise<{ text: string; problem?: string }>; onOwn: (text: string) => void;
  /** Told whether a line is typed but not added yet, so the page can ask before it is lost. */
  onTyping?: (typing: boolean) => void; children?: React.ReactNode;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const typing = !!note.trim();
  useEffect(() => onTyping?.(typing), [typing]);
  const groups = (Object.keys(FROM) as EmailOption["from"][]).map((from) => ({ from, list: options.filter((o) => o.from === from) })).filter((g) => g.list.length);
  async function add() {
    setBusy(true); setProblem(undefined);
    try { const out = await tidy(note); onOwn(out.text); setProblem(out.problem); setNote(""); }
    catch (e) { setProblem(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return (
    <div className="options">
      {groups.map((g) => (
        <div className="option-group" key={g.from} role="group" aria-label={FROM[g.from]}>
          <span className="small muted">{FROM[g.from]}</span>
          <div className="option-list">{g.list.map((o) => <button type="button" key={o.id} className={`option ${isOn(o) ? "on" : ""}`} aria-pressed={isOn(o)} title={o.text} onClick={() => onToggle(o)}><i aria-hidden="true">{isOn(o) ? "✓" : "+"}</i>{o.label}</button>)}</div>
        </div>
      ))}
      <div className="option-group">
        <label className="small muted" htmlFor="own-line">Something else, in your own words</label>
        {children}
        <div className="own-line">
          <textarea id="own-line" rows={2} maxLength={MAX_OWN_LINE} value={note} disabled={busy} placeholder="Type it roughly, in any language. The assistant tidies the wording and adds it to the email." onChange={(e) => setNote(e.target.value)} />
          <button type="button" className="btn" disabled={busy || !note.trim()} onClick={add}>{busy ? "Tidying…" : "Tidy it and add"}</button>
        </div>
        {problem && <p className="small bad-text" role="alert">{problem}</p>}
      </div>
    </div>
  );
}
