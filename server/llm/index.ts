// Drafting model. With OPENAI_API_KEY set, drafts are rewritten by an OpenAI-compatible model;
// otherwise the deterministic template drafts are used so the workspace runs offline.
export interface LlmProvider {
  name: string;
  polish(input: { task: string; draft: string; context: string; tone: string }): Promise<string>;
}

export const templateProvider: LlmProvider = {
  name: "Built-in templates (no LLM key set)",
  async polish({ draft }) { return draft; },
};

export function openAiProvider(apiKey: string, model = process.env.OPENAI_MODEL ?? "gpt-4o-mini", baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"): LlmProvider {
  return {
    name: `OpenAI-compatible (${model})`,
    async polish({ task, draft, context, tone }) {
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model, temperature: 0.6,
            messages: [
              { role: "system", content: `You draft work for Cubro, a New Zealand healthcare equipment supplier. Tone: ${tone}. Return only the improved text, keep facts, numbers and order references unchanged.` },
              { role: "user", content: `Task: ${task}\n\nContext:\n${context}\n\nDraft:\n${draft}` },
            ],
          }),
        });
        if (!res.ok) return draft;
        const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        return json.choices?.[0]?.message?.content?.trim() || draft;
      } catch {
        return draft;
      }
    },
  };
}

export function createLlm(env = process.env): LlmProvider {
  return env.OPENAI_API_KEY ? openAiProvider(env.OPENAI_API_KEY) : templateProvider;
}
