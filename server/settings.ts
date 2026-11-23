import type { AgentId, Settings } from "./store.js";

export const CHANNELS = ["LinkedIn", "Facebook", "Instagram"] as const;
const AGENT_IDS: AgentId[] = ["social-media", "supplier-outreach"];

export type SettingsErrors = Record<string, string>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const inRange = (v: unknown, min: number, max: number, whole = true) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max && (!whole || Number.isInteger(v));
const hasText = (v: unknown) => typeof v === "string" && v.trim().length > 0;

/** Plain-language problems with a settings object, keyed by field path. Empty when it is safe to save. */
export function validateSettings(s: Settings): SettingsErrors {
  const e: SettingsErrors = {};
  for (const id of AGENT_IDS) {
    if (!inRange(s.hourlyRates[id], 1, 500, false)) e[`hourlyRates.${id}`] = "Enter an hourly cost between $1 and $500.";
    if (typeof s.agents[id].enabled !== "boolean") e[`agents.${id}.enabled`] = "Choose on or paused.";
    if (!hasText(s.agents[id].owner)) e[`agents.${id}.owner`] = "Choose who owns this agent.";
    if (!hasText(s.agents[id].schedule)) e[`agents.${id}.schedule`] = "Say when this agent runs.";
  }
  if (!inRange(s.social.postsPerRun, 1, 30)) e["social.postsPerRun"] = "Enter a whole number of posts from 1 to 30.";
  if (!inRange(s.social.horizonDays, 1, 90)) e["social.horizonDays"] = "Enter a whole number of days from 1 to 90.";
  if (!hasText(s.social.tone)) e["social.tone"] = "Describe the tone of voice in a few words.";
  if (!Array.isArray(s.social.channels) || !s.social.channels.length || s.social.channels.some((c) => !CHANNELS.includes(c))) e["social.channels"] = "Tick at least one channel.";
  if (!inRange(s.supplier.overdueGraceDays, 0, 60)) e["supplier.overdueGraceDays"] = "Enter a whole number of days from 0 to 60.";
  if (!inRange(s.supplier.lowStockCoverageWeeks, 1, 52)) e["supplier.lowStockCoverageWeeks"] = "Enter a whole number of weeks from 1 to 52.";
  if (!inRange(s.supplier.maxEmailsPerRun, 1, 50)) e["supplier.maxEmailsPerRun"] = "Enter a whole number of emails from 1 to 50.";
  if (!hasText(s.supplier.sender)) e["supplier.sender"] = "Enter the name supplier emails are signed with.";
  return e;
}

/** Copy the known fields of an untrusted patch onto a clone of the current settings; unknown fields are dropped. */
export function mergeSettings(current: Settings, patch: unknown): Settings {
  const next = structuredClone(current);
  if (!isObj(patch)) return next;
  const copy = (target: object, src: unknown) => { if (isObj(src)) for (const k of Object.keys(target)) if (src[k] !== undefined) (target as Record<string, unknown>)[k] = src[k]; };
  copy(next.hourlyRates, patch.hourlyRates);
  copy(next.social, patch.social);
  copy(next.supplier, patch.supplier);
  if (isObj(patch.agents)) for (const id of AGENT_IDS) copy(next.agents[id], patch.agents[id]);
  if (Array.isArray(next.social.channels)) next.social.channels = CHANNELS.filter((c) => next.social.channels.includes(c));
  return next;
}
