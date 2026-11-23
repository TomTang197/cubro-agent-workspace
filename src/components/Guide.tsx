import { useEffect, useRef, useState } from "react";

const STEPS = [
  { title: "Ask an assistant for drafts", body: "An assistant reads Cubro's systems and writes first drafts for you: social posts for Marketing, supplier emails for Purchasing. Your Today page has one button that asks for them." },
  { title: "Read the draft", body: "Drafts open one at a time. Each one says why the assistant wrote it and where its facts came from, so you can check it quickly." },
  { title: "Approve, change or send back", body: "Approve it as it is, change the wording first, or send it back so it is not used. Nothing leaves Cubro until a person approves it, and you get a few seconds to undo." },
];

/** The first-open walkthrough: three steps, skippable, and reopened from "How it works". */
export default function Guide({ name, onClose }: { name: string; onClose: () => void }) {
  const [i, setI] = useState(0);
  const main = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { main.current?.focus(); }, [i]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab") return;
      // Keep the keyboard inside the guide while it covers the page.
      const els = [...(box.current?.querySelectorAll<HTMLElement>("button") ?? [])];
      const first = els[0], last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const last = i === STEPS.length - 1;
  return (
    <div className="guide-back">
      <div className="guide" role="dialog" aria-modal="true" aria-labelledby="guide-title" ref={box}>
        <p className="small muted">{i === 0 ? `Welcome, ${name.split(" ")[0]}. This workspace takes three steps.` : "How it works"}</p>
        <ol className="steps" aria-hidden="true">{STEPS.map((s, n) => <li key={s.title} className={n === i ? "now" : n < i ? "done" : ""}><span>{n + 1}</span></li>)}</ol>
        <p className="small muted" aria-live="polite">Step {i + 1} of {STEPS.length}</p>
        <h2 id="guide-title">{STEPS[i].title}</h2>
        <p>{STEPS[i].body}</p>
        <div className="row between wrap guide-foot">
          <button type="button" className="link" onClick={onClose}>{last ? "Close" : "Skip the guide"}</button>
          <span className="row gap">
            {i > 0 && <button type="button" className="btn" onClick={() => setI(i - 1)}>Back</button>}
            <button type="button" className="btn primary" ref={main} onClick={() => (last ? onClose() : setI(i + 1))}>{last ? "Start" : "Next"}</button>
          </span>
        </div>
      </div>
    </div>
  );
}
