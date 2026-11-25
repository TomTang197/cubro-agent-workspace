// Drafting model. With GEMINI_API_KEY set, drafts are written by Google Gemini (OPENAI_API_KEY: an
// OpenAI-compatible model); otherwise the deterministic template drafts are used so the workspace runs offline.
// A provider throws when the model call fails; the agent then keeps the template draft and says so in the run.
export interface LlmProvider {
  name: string;
  polish(input: { task: string; draft: string; context: string; tone: string }): Promise<string>;
  /** Answers `instructions` about a text it is given, to read what the text says rather than to write one. The built-in templates cannot. */
  read?(input: { instructions: string; text: string }): Promise<string>;
  /** Today's calls to the model and how many of them failed, for a provider with a daily limit. */
  usage?(): ModelUsage;
}

export interface ModelUsage { day: string; drafts: number; reads: number; failed: number; lastError?: string }

type Env = Record<string, string | undefined>;
const TIMEOUT_MS = 45_000;

const system = (tone: string) => `You write for Cubro, a New Zealand healthcare equipment supplier. Tone: ${tone}. Use New Zealand English.
You get a task, why the draft is needed, and a fact sheet written as a plain draft. Write the final text in your own words.
Use only the facts in the fact sheet: keep every name, number, date, order reference, item line and the sign-off exactly as given, and add no claims, prices or promises.
Return only the text itself: no subject line, no hashtags, no markdown, no commentary.`;
const prompt = (i: { task: string; draft: string; context: string }) => `Task: ${i.task}\n\nWhy this draft is needed:\n${i.context}\n\nFact sheet:\n${i.draft}`;

export const templateProvider: LlmProvider = {
  name: "Built-in templates (no model key set)",
  async polish({ draft }) { return draft; },
};

async function postJson(label: string, url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  const json = (await res.json().catch(() => ({}))) as { error?: { code?: string | number; message?: string } };
  if (!res.ok) throw new Error(`${label} error ${res.status}${json.error?.code ? ` ${json.error.code}` : ""}${json.error?.message ? `: ${json.error.message}` : ""}`.slice(0, 200));
  return json;
}

// Google Gemini through the Interactions API (https://ai.google.dev/gemini-api/docs/interactions).
export function geminiProvider(apiKey: string, env: Env = process.env): LlmProvider {
  const model = env.GEMINI_MODEL || "gemini-4-hydrogen";
  const baseUrl = (env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  const ask = async (instructions: string, input: string, what: string) => {
    const json = (await postJson("Gemini", `${baseUrl}/interactions`, { "x-goog-api-key": apiKey, "api-revision": "2026-05-20" },
      { model, system_instruction: instructions, input, store: false })) as { status?: string; steps?: { type?: string; content?: { type?: string; text?: string }[] }[] };
    // "incomplete" (cut off at the token limit) and the other statuses carry partial or no text.
    if (json.status !== "completed") throw new Error(`Gemini did not finish ${what} (status ${json.status ?? "missing"})`);
    const out = json.steps?.filter((s) => s.type === "model_output").at(-1);
    const text = out?.content?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim();
    if (!text) throw new Error("Gemini returned no text");
    return text;
  };
  return { name: `Google Gemini (${model})`, polish: (input) => ask(system(input.tone), prompt(input), "the draft"), read: (input) => ask(input.instructions, input.text, "reading the text") };
}

export function openAiProvider(apiKey: string, env: Env = process.env): LlmProvider {
  const model = env.OPENAI_MODEL || "gpt-4o-mini";
  const baseUrl = (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const ask = async (instructions: string, input: string) => {
    const json = (await postJson("Model", `${baseUrl}/chat/completions`, { authorization: `Bearer ${apiKey}` },
      { model, messages: [{ role: "system", content: instructions }, { role: "user", content: input }] })) as { choices?: { message?: { content?: string } }[] };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("Model returned no text");
    return text;
  };
  return { name: `OpenAI-compatible (${model})`, polish: (input) => ask(system(input.tone), prompt(input)), read: (input) => ask(input.instructions, input.text) };
}

export const DEFAULT_DAILY_DRAFT_LIMIT = 100;
/** Emails the model reads for their key facts per day. Each email is read once, so this is how many different emails are opened. */
export const DEFAULT_DAILY_READ_LIMIT = 300;

// Caps model calls per UTC day, because the run endpoint has no sign-in of its own and every call spends the key's quota.
// Failed calls count too. The count lives in memory, so resetting the workspace data does not clear it.
// Reading an email is counted apart from writing, so opening emails never uses up the drafts.
export function withDailyLimit(provider: LlmProvider, perDay: number, now: () => Date = () => new Date(), readsPerDay = DEFAULT_DAILY_READ_LIMIT, log: (line: string) => void = console.warn): LlmProvider {
  let day = "", used = 0, read = 0, failed = 0, lastError: string | undefined, warnedLimit = new Set<string>();
  const newDay = () => { const today = now().toISOString().slice(0, 10); if (today !== day) { day = today; used = 0; read = 0; failed = 0; lastError = undefined; warnedLimit = new Set(); } };
  const limited = (what: string, limit: number) => {
    const message = `daily limit of ${limit} ${what} reached`;
    if (!warnedLimit.has(what)) { warnedLimit.add(what); log(`[model] ${provider.name}: ${message}; the rest of today falls back to the built-in rules`); }
    return new Error(message);
  };
  // Every failed call is logged and counted, so errors from the model leave a trace even where the page shows none.
  const call = async <T>(kind: string, ask: () => Promise<T>) => {
    try { return await ask(); } catch (e) {
      failed++;
      lastError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      log(`[model] ${provider.name} ${kind} failed (${failed} failed today): ${lastError}`);
      throw e;
    }
  };
  return {
    name: provider.name,
    async polish(input) {
      newDay();
      if (used >= perDay) throw limited("model-written drafts", perDay);
      used++;
      return call("draft", () => provider.polish(input));
    },
    ...(provider.read && {
      async read(input) {
        newDay();
        if (read >= readsPerDay) throw limited("emails read by the model", readsPerDay);
        read++;
        return call("read", () => provider.read!(input));
      },
    }),
    usage() { newDay(); return { day, drafts: used, reads: read, failed, ...(lastError && { lastError }) }; },
  };
}

export function createLlm(env: Env = process.env): LlmProvider {
  const provider = env.GEMINI_API_KEY ? geminiProvider(env.GEMINI_API_KEY, env) : env.OPENAI_API_KEY ? openAiProvider(env.OPENAI_API_KEY, env) : null;
  if (!provider) return templateProvider;
  const whole = (v: string | undefined, fallback: number) => { const n = Number(v); return v?.trim() && Number.isInteger(n) && n >= 0 ? n : fallback; };
  return withDailyLimit(provider, whole(env.LLM_DAILY_DRAFT_LIMIT, DEFAULT_DAILY_DRAFT_LIMIT), undefined, whole(env.LLM_DAILY_READ_LIMIT, DEFAULT_DAILY_READ_LIMIT));
}
