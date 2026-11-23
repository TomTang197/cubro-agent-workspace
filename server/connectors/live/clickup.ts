// ClickUp through API v2, signed in with a personal API token.
import { baseStatus, failedStatus, jsonSetting, ConnectorError, type Env, type FetchLike } from "../config.js";
import type { ClickUpConnector, ClickUpTask } from "../types.js";
import { createHttp, requireSettings } from "./http.js";

const API = "https://api.clickup.com/api/v2";
const MAX_PAGES = 20;
const PRIORITY: Record<NonNullable<ClickUpTask["priority"]>, number> = { urgent: 1, high: 2, normal: 3, low: 4 };

interface CuTask {
  id: string; name: string; description?: string; text_content?: string; url?: string; due_date?: string | null;
  status?: { status?: string; type?: string }; assignees?: { username?: string; email?: string }[]; tags?: { name: string }[]; priority?: { priority?: string } | null;
}

/** ClickUp statuses are named per workspace; the workspace only needs these four stages. */
export function taskStatus(s?: { status?: string; type?: string }): ClickUpTask["status"] {
  const name = (s?.status ?? "").toLowerCase();
  if (s?.type === "closed" || s?.type === "done" || /complete|closed|done/.test(name)) return "complete";
  if (/review|approval/.test(name)) return "review";
  if (/progress|doing|active/.test(name)) return "in progress";
  return "to do";
}

/** ClickUp stores due dates as epoch milliseconds; the workspace uses the New Zealand calendar date. */
const dueDate = (ms?: string | null) => (ms ? new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Auckland" }).format(new Date(Number(ms))) : null);
const dueMs = (iso: string | null | undefined) => (iso ? new Date(`${iso.slice(0, 10)}T05:00:00Z`).getTime() : null);

export function createLiveClickUp(env: Env, fetchImpl: FetchLike = fetch): ClickUpConnector {
  const http = createHttp("clickup", fetchImpl);
  const call = <T>(path: string, init: { method?: string; body?: unknown } = {}) => {
    requireSettings("clickup", env);
    return http.json<T>(`${API}${path}`, { ...init, headers: { authorization: env.CLICKUP_API_TOKEN! } });
  };
  const lists = () => jsonSetting<Partial<Record<ClickUpTask["list"], string>>>("clickup", env, "CLICKUP_LISTS");
  const listId = (list: ClickUpTask["list"]) => {
    const id = lists()[list];
    if (!id) throw new ConnectorError("clickup", `No list ID is set for the ${list} list in CLICKUP_LISTS.`);
    return id;
  };
  const toTask = (t: CuTask, list: ClickUpTask["list"]): ClickUpTask => ({
    id: t.id, name: t.name, description: t.text_content ?? t.description ?? "", list, status: taskStatus(t.status), assignees: (t.assignees ?? []).map((a) => a.username ?? a.email ?? ""),
    due_date: dueDate(t.due_date), tags: (t.tags ?? []).map((x) => x.name), url: t.url ?? `https://app.clickup.com/t/${t.id}`,
    priority: (["urgent", "high", "normal", "low"] as const).find((p) => p === t.priority?.priority),
  });
  /** Finds which configured list a task belongs to, for calls that only return the task. */
  const listOf = (t: CuTask & { list?: { id?: string } }, fallback: ClickUpTask["list"] = "Operations") =>
    (Object.entries(lists()).find(([, id]) => id === t.list?.id)?.[0] as ClickUpTask["list"] | undefined) ?? fallback;

  return {
    async status() {
      try {
        const entries = Object.entries(lists());
        if (!entries.length) requireSettings("clickup", env);
        const counts = await Promise.all(entries.map(async ([name, id]) => [`${name} tasks`, Number((await call<{ task_count?: number | string }>(`/list/${encodeURIComponent(id!)}`)).task_count) || 0] as const));
        return { ...baseStatus("clickup", "live", env), connected: true, detail: `Connected to ClickUp lists ${entries.map(([n]) => n).join(", ")}`, records: Object.fromEntries(counts) };
      } catch (e) { return failedStatus("clickup", "live", env, e); }
    },
    async listTasks(list) {
      requireSettings("clickup", env);
      const wanted = (Object.keys(lists()) as ClickUpTask["list"][]).filter((l) => !list || l === list);
      if (list && !wanted.length) listId(list);
      const out = await Promise.all(wanted.map(async (l) => {
        const tasks: ClickUpTask[] = [];
        for (let page = 0; page < MAX_PAGES; page++) {
          const res = await call<{ tasks: CuTask[]; last_page?: boolean }>(`/list/${encodeURIComponent(listId(l))}/task?page=${page}&include_closed=true&subtasks=true`);
          tasks.push(...res.tasks.map((t) => toTask(t, l)));
          if (res.last_page || !res.tasks.length) break;
        }
        return tasks;
      }));
      return out.flat();
    },
    async createTask(input) {
      const users = jsonSetting<Record<string, number | string>>("clickup", env, "CLICKUP_USERS");
      const assignees = input.assignees.map((a) => Number(users[a])).filter(Boolean);
      const created = await call<CuTask>(`/list/${encodeURIComponent(listId(input.list))}/task`, { method: "POST", body: {
        name: input.name, description: input.description, tags: input.tags, assignees, due_date: dueMs(input.due_date) ?? undefined,
        priority: input.priority ? PRIORITY[input.priority] : undefined, status: input.status && input.status !== "to do" ? input.status : undefined,
      } });
      // Report the task as the workspace asked for it; ClickUp's reply omits assignee names when none could be mapped.
      return { ...toTask(created, input.list), status: input.status ?? "to do", assignees: input.assignees, due_date: input.due_date, tags: input.tags, description: input.description };
    },
    async updateTask(id, patch) {
      const body: Record<string, unknown> = {};
      if (patch.status) body.status = patch.status;
      if (patch.description !== undefined) body.description = patch.description;
      if (patch.due_date !== undefined) body.due_date = dueMs(patch.due_date);
      const updated = await call<CuTask & { list?: { id?: string } }>(`/task/${encodeURIComponent(id)}`, { method: "PUT", body });
      return toTask(updated, listOf(updated));
    },
  };
}
