import { fromNzInput, nzClock, nzDay, shortDay, toNzInput } from "../../server/agents/nzTime";
import { when, type ApprovalItem } from "../api";

type Item = ApprovalItem;
type Post = Extract<ApprovalItem["payload"], { type: "social_post" }>;
export interface SocialEdits { text: string; hashtags: string; scheduledFor: string }

export const socialEdits = (p: Post): SocialEdits => ({ text: p.text, hashtags: p.hashtags.join(" "), scheduledFor: toNzInput(p.scheduledFor) });
const tagList = (s: string) => [...new Set(s.split(/[\s,]+/).map((t) => t.replace(/#/g, "")).filter(Boolean).map((t) => `#${t}`))];

/** The fields a reviewer changed, ready to save; empty when nothing changed. */
export function socialPatch(p: Post, e: SocialEdits) {
  const patch: Partial<Post> = {};
  if (e.text !== p.text) patch.text = e.text;
  if (tagList(e.hashtags).join(" ") !== p.hashtags.join(" ")) patch.hashtags = tagList(e.hashtags);
  if (e.scheduledFor && e.scheduledFor !== toNzInput(p.scheduledFor)) patch.scheduledFor = fromNzInput(e.scheduledFor);
  return patch;
}

/** Why a post cannot be approved as it stands, if anything. */
export function socialProblem(e: SocialEdits) {
  if (!e.text.trim()) return "The post has no text. Write something, or reject the draft.";
  if (!e.scheduledFor) return "Pick a date and time for the post.";
  if (new Date(fromNzInput(e.scheduledFor)) < new Date()) return "The planned date has passed. Pick a new date and time, or reject the draft.";
  return undefined;
}

export function SocialMeta({ p }: { p: Post }) {
  return (
    <div className="meta-grid">
      <div><span>Channel</span><b>{p.channel}</b></div>
      <div><span>Campaign</span><b>{p.campaign ?? "Not part of a campaign"}</b></div>
      <div><span>Image</span><b>{p.assetName ? <a href={p.assetUrl} target="_blank" rel="noreferrer">{p.assetName}</a> : "None picked. Add one before publishing."}</b></div>
    </div>
  );
}

export function SocialFields({ p, edits, onChange, pending }: { p: Post; edits: SocialEdits; onChange: (e: SocialEdits) => void; pending: boolean }) {
  const set = (k: keyof SocialEdits) => (ev: { target: { value: string } }) => onChange({ ...edits, [k]: ev.target.value });
  if (!pending) return (
    <>
      <label className="field"><span>Post</span><textarea rows={8} value={p.text} disabled /></label>
      <div className="chips">{p.hashtags.map((h) => <span className="chip" key={h}>{h}</span>)}</div>
    </>
  );
  return (
    <>
      <label className="field"><span>Post <em className="muted">— change anything before approving</em></span>
        <textarea rows={8} value={edits.text} onChange={set("text")} /></label>
      <p className="small muted field-hint">{edits.text.length} characters</p>
      <div className="pair">
        <label className="field"><span>Hashtags <em className="muted">— separate with spaces</em></span><input value={edits.hashtags} onChange={set("hashtags")} placeholder="#Cubro #HealthcareNZ" /></label>
        <label className="field"><span>Publish on <em className="muted">— NZ time</em></span><input type="datetime-local" value={edits.scheduledFor} min={toNzInput(new Date().toISOString())} onChange={set("scheduledFor")} />
          {edits.scheduledFor && <small className="muted">{shortDay(nzDay(fromNzInput(edits.scheduledFor)))}, {nzClock(fromNzInput(edits.scheduledFor))}</small>}</label>
      </div>
    </>
  );
}

/** What approving does, or did, in plain words. Approval never posts to the social channel itself. */
export function SocialFootnote({ item, edits }: { item: Item; edits: SocialEdits }) {
  const p = item.payload as Post;
  if (item.status === "rejected") return <p className="small muted">Rejected. This post will not be published.</p>;
  if (item.status === "approved") return <p className="small muted">Approved for {when(p.scheduledFor)}. It is a task in the Marketing list in ClickUp; the team publishes it to {p.channel} from there.</p>;
  const on = edits.scheduledFor ? shortDay(nzDay(fromNzInput(edits.scheduledFor))) : "the day you pick";
  return <p className="small muted">Approving adds a task to the Marketing list in ClickUp, due {on}, and tells the team on Teams. Nothing is posted to {p.channel} automatically: the team publishes it from the task.</p>;
}
