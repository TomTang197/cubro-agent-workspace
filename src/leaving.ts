/** A page with unsaved edits registers a check here, so the search, the record panel and the menu ask before they navigate away from it. */
let check: (() => boolean) | undefined;

/** `stay` returns true when the person chose to stay with their edits. */
export function askBeforeLeaving(stay?: () => boolean) { check = stay; }

const page = (to: string) => { const u = new URL(to, location.href); u.searchParams.delete("record"); u.searchParams.sort(); return `${u.pathname}?${u.searchParams}`; };

/** False when the link would throw unsaved edits away and the person chose to stay. Opening or closing a record on the right keeps the page, so it never asks. */
export function mayLeave(to: string) { return page(to) === page(location.href) || !check?.(); }
