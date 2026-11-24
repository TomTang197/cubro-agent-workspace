import { useEffect, useState, type ReactNode } from "react";
import type { Fact, FactKind, FactMark, FactSheet } from "../../server/agents/facts";

export type { FactSheet };
const LABEL: Record<FactKind, string> = { order: "Order", item: "Model", quantity: "Quantity", date: "Date", price: "Price", tracking: "Tracking" };

/**
 * The key facts of an email, loaded beside it: first what the rules find, then again once the model has read it too.
 * `key` names the email and its text, so facts read from other text are never shown. A failure leaves the email as plain text.
 */
export function useFacts<T>(key: string | null, load: (quick: boolean) => Promise<T>, more: (got: T) => boolean) {
  const [got, setGot] = useState<{ key: string; data: T }>();
  useEffect(() => {
    if (!key) return;
    let current = true;
    // A short wait, so typing in a draft asks once it pauses.
    const timer = setTimeout(async () => {
      try {
        const quick = await load(true);
        if (!current) return;
        setGot({ key, data: quick });
        if (!more(quick)) return;
        const full = await load(false);
        if (current) setGot({ key, data: full });
      } catch { /* the email still reads as it did */ }
    }, 150);
    return () => { current = false; clearTimeout(timer); };
  }, [key]);
  return got?.key === key ? got.data : undefined;
}

const title = (m: Pick<FactMark, "kind" | "record">) => `${LABEL[m.kind]}${m.record ? `: ${m.record}` : ""}`;

/** Text with its facts highlighted. The text itself is untouched: a mark that no longer stands on its words is dropped. */
export function Marked({ text, marks }: { text: string; marks?: FactMark[] }) {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of [...(marks ?? [])].sort((a, b) => a.start - b.start)) {
    if (m.start < at || text.slice(m.start, m.end) !== m.text) continue;
    if (m.start > at) out.push(text.slice(at, m.start));
    out.push(<mark key={m.start} className={`fact fact-${m.kind}${m.differs ? " differs" : ""}`} title={title(m)}>{m.text}</mark>);
    at = m.end;
  }
  out.push(text.slice(at));
  return <>{out}</>;
}

/** The facts listed above an email, each with what the order in Infor LN says where the two were compared. */
export function KeyFacts({ sheet, of }: { sheet?: FactSheet; of: string }) {
  if (!sheet?.facts.length) return null;
  const differs = sheet.facts.filter((f) => f.check === "differs").length, checked = sheet.facts.filter((f) => f.check).length;
  const kinds = [...new Set(sheet.facts.map((f) => f.kind))];
  // A value that matches the order gets a tick, with what it matched on hover; one that differs says what the order says.
  const value = (f: Fact, i: number) => (
    <li key={i} className={f.check === "differs" ? "differs" : undefined} title={f.kind === "item" ? f.about : undefined}>
      <mark className={`fact fact-${f.kind}${f.check === "differs" ? " differs" : ""}`}>{f.text}</mark>
      {f.about && f.kind !== "item" && <span className="muted"> {f.about}</span>}
      {f.check === "same" ? <span className="fact-note same" title={f.record} aria-label={`matches: ${f.record}`}> ✓</span>
        : f.record && <span className={`fact-note ${f.check ?? ""}`}>{f.check === "differs" ? " ⚠ " : " · "}{f.record}</span>}
    </li>
  );
  return (
    <aside className="key-facts" aria-label={`Key facts in ${of}`}>
      <p className="key-facts-head"><b>Key facts in {of}</b>
        {differs > 0 ? <span className="pill bad asis">{differs} {differs === 1 ? "differs" : "differ"} from {sheet.order ?? "Infor LN"}</span>
          : checked > 0 && sheet.order ? <span className="pill ok asis">Matches {sheet.order}</span> : null}</p>
      <dl>{kinds.map((k) => <div key={k}><dt>{LABEL[k]}</dt><dd><ul>{sheet.facts.filter((f) => f.kind === k).map(value)}</ul></dd></div>)}</dl>
      <p className="small muted">Shown here only; the email itself is unchanged.{sheet.order ? ` ✓ matches ${sheet.order} in Infor LN.` : ""}{sheet.readBy ? ` Read by the rules and ${sheet.readBy}.` : sheet.more ? " The model is reading it too…" : ""}</p>
    </aside>
  );
}
