// Cubro works in New Zealand time. Dates shown to staff and due dates sent to other systems use it, whatever the server's clock says.
const NZ = "Pacific/Auckland";
const DAY_MS = 86_400_000;

/** The NZ calendar day (YYYY-MM-DD) of an instant. */
export const nzDay = (at: Date | string) => new Date(at).toLocaleDateString("en-CA", { timeZone: NZ });

export const shiftDay = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

function nzOffsetMs(at: Date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: NZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant of a wall-clock time on an NZ day, daylight saving included. */
export function nzTime(day: string, hour: number, minute = 0) {
  const wall = Date.parse(`${day}T00:00:00Z`) + (hour * 60 + minute) * 60_000;
  const guess = new Date(wall - nzOffsetMs(new Date(wall)));
  return new Date(wall - nzOffsetMs(guess));
}

/** ISO instant <-> the value of an <input type="datetime-local"> showing NZ time. */
export function toNzInput(iso: string) {
  const at = new Date(iso);
  return new Date(at.getTime() + nzOffsetMs(at)).toISOString().slice(0, 16);
}
export function fromNzInput(value: string) {
  const [day, time = "00:00"] = value.split("T");
  const [h, m] = time.split(":").map(Number);
  return nzTime(day, h, m).toISOString();
}

const fmt = (day: string, o: Intl.DateTimeFormatOptions) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-NZ", { ...o, timeZone: "UTC" });
/** "Friday, 4 December" */
export const longDay = (day: string) => fmt(day, { weekday: "long", day: "numeric", month: "long" });
/** "Fri, 4 Dec" */
export const shortDay = (day: string) => fmt(day, { weekday: "short", day: "numeric", month: "short" });
/** "9:30 am" */
export const nzClock = (at: Date | string) => new Date(at).toLocaleTimeString("en-NZ", { hour: "numeric", minute: "2-digit", timeZone: NZ });

/** Why a post cannot go out at this time, given the days it makes sense on; undefined when it can. */
export function dateProblem(limits: { notBefore?: string; notAfter?: string }, at: string) {
  const day = nzDay(at);
  if (limits.notAfter && day > limits.notAfter) return `What this post promotes will be over by then. Pick ${shortDay(limits.notAfter)} or earlier, or reject the draft.`;
  if (limits.notBefore && day < limits.notBefore) return `The product in this post is not available until ${shortDay(limits.notBefore)}. Pick that day or later.`;
  return undefined;
}
