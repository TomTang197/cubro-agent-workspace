import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type SearchHit } from "../api";
import { kindLabel, useRecordLink } from "./Record";
import { mayLeave } from "../leaving";

/** One box for all four systems: type a supplier, an order number or a customer and open it. */
export default function Search() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const nav = useNavigate();
  const recordLink = useRecordLink();
  const term = q.trim();

  useEffect(() => {
    if (term.length < 2) { setHits(undefined); setError(undefined); return; }
    let current = true;
    const t = window.setTimeout(() => {
      api<SearchHit[]>(`/search?q=${encodeURIComponent(term)}`)
        .then((found) => { if (current) { setHits(found); setAt(0); setError(undefined); } })
        .catch((e) => current && setError(e instanceof Error ? e.message : String(e)));
    }, 180);
    return () => { current = false; window.clearTimeout(t); };
  }, [term]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if ((e.key === "/" && !typing) || (e.key === "k" && (e.ctrlKey || e.metaKey))) { e.preventDefault(); input.current?.focus(); }
    };
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("keydown", onKey); window.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onDown); };
  }, []);

  const go = (h: SearchHit) => {
    const to = h.kind === "draft" ? `/approvals/${h.id}?status=all&view=list&agent=all` : recordLink(h.kind, h.id);
    if (!mayLeave(to)) return;
    setOpen(false); setQ(""); input.current?.blur();
    nav(to);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { setOpen(false); input.current?.blur(); }
    if (!hits?.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setAt((at + 1) % hits.length); }
    if (e.key === "ArrowUp") { e.preventDefault(); setAt((at - 1 + hits.length) % hits.length); }
    if (e.key === "Enter") { e.preventDefault(); go(hits[at]); }
  };
  const show = open && term.length >= 2;
  return (
    <div className="search" ref={box} role="search">
      <input ref={input} type="search" value={q} placeholder="Search suppliers, orders, customers" aria-label="Search suppliers, order numbers, customers and products in all four systems" aria-expanded={show} aria-controls="search-results" role="combobox" aria-autocomplete="list"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={onKeyDown} />
      {show && (
        <div className="search-results" id="search-results" role="listbox">
          {error && <p className="error">{error}</p>}
          {!hits && !error && <p className="muted pad">Searching Microsoft 365, Salesforce, ClickUp and Infor LN…</p>}
          {hits?.length === 0 && <p className="muted pad">Nothing found for “{term}”. Try a supplier or customer name, or an order number such as PO41741.</p>}
          {hits?.map((h, i) => (
            <div key={`${h.kind}:${h.id}`}>
              {(i === 0 || hits[i - 1].kind !== h.kind) && <div className="search-group">{h.kind === "draft" ? "Drafts" : `${kindLabel(h.kind)}s`}</div>}
              <button type="button" role="option" aria-selected={i === at} className={`search-hit ${i === at ? "at" : ""}`} onMouseEnter={() => setAt(i)} onClick={() => go(h)}>
                <span><b>{h.title}</b><span className="small muted">{h.subtitle}</span></span>
                <span className="from">{h.system}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
