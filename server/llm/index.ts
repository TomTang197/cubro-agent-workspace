// Drafting model. With GEMINI_API_KEY set, drafts are written by Google Gemini (OPENAI_API_KEY: an
// OpenAI-compatible model); otherwise the deterministic template drafts are used so the workspace runs offline.
// A provider throws when the model call fails; the agent then keeps the template draft and says so in the run.
export interface LlmProvider {
  name: string;
  polish(input: { task: string; draft: string; context: string; tone: string }): Promise<string>;
}

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
  return {
    name: `Google Gemini (${model})`,
    async polish(input) {
      const json = (await postJson("Gemini", `${baseUrl}/interactions`, { "x-goog-api-key": apiKey, "api-revision": "2026-05-20" },
        { model, system_instruction: system(input.tone), input: prompt(input), store: false })) as { status?: string; steps?: { type?: string; content?: { type?: string; text?: string }[] }[] };
      // "incomplete" (cut off at the token limit) and the other statuses carry partial or no text.
      if (json.status !== "completed") throw new Error(`Gemini did not finish the draft (status ${json.status ?? "missing"})`);
      const out = json.steps?.filter((s) => s.type === "model_output").at(-1);
      const text = out?.content?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim();
      if (!text) throw new Error("Gemini returned no text");
      return text;
    },
  };
}

export function openAiProvider(apiKey: string, env: Env = process.env): LlmProvider {
  const model = env.OPENAI_MODEL || "gpt-4o-mini";
  const baseUrl = (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  return {
    name: `OpenAI-compatible (${model})`,
    async polish(input) {
      const json = (await postJson("Model", `${baseUrl}/chat/completions`, { authorization: `Bearer ${apiKey}` },
        { model, messages: [{ role: "system", content: system(input.tone) }, { role: "user", content: prompt(input) }] })) as { choices?: { message?: { content?: string } }[] };
      const text = json.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error("Model returned no text");
      return text;
    },
  };
}

export function createLlm(env: Env = process.env): LlmProvider {
  if (env.GEMINI_API_KEY) return geminiProvider(env.GEMINI_API_KEY, env);
  if (env.OPENAI_API_KEY) return openAiProvider(env.OPENAI_API_KEY, env);
  return templateProvider;
}
