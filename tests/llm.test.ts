import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app";
import { createLlm, geminiProvider, templateProvider } from "../server/llm";
import { Store } from "../server/store";

const today = new Date("2026-11-23T00:00:00Z");
const input = { task: "Write a LinkedIn post", draft: "Template text, 12 beds.", context: "New product", tone: "Warm" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const modelOutput = (text: string) => ({ status: "completed", steps: [{ type: "thought" }, { type: "model_output", content: [{ type: "text", text }] }] });
const mockFetch = (impl: (url: string, init: RequestInit) => Response | Promise<Response>) => {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
};

afterEach(() => vi.unstubAllGlobals());

describe("drafting model selection", () => {
  it("uses templates with no key, Gemini with GEMINI_API_KEY, and prefers Gemini over OpenAI", () => {
    expect(createLlm({})).toBe(templateProvider);
    expect(createLlm({ GEMINI_API_KEY: "g" }).name).toBe("Google Gemini (gemini-4-hydrogen)");
    expect(createLlm({ GEMINI_API_KEY: "g", GEMINI_MODEL: "gemini-4-carbon", OPENAI_API_KEY: "o" }).name).toBe("Google Gemini (gemini-4-carbon)");
    expect(createLlm({ OPENAI_API_KEY: "o" }).name).toBe("OpenAI-compatible (gpt-4o-mini)");
  });
});

describe("Gemini provider", () => {
  it("posts the draft to the Interactions API and returns the model's text", async () => {
    const fetch = mockFetch(() => reply(modelOutput("  Written by Gemini, 12 beds.\n")));
    const text = await geminiProvider("secret-key", {}).polish(input);
    expect(text).toBe("Written by Gemini, 12 beds.");
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("secret-key");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("gemini-4-hydrogen");
    expect(body.store).toBe(false);
    expect(body.system_instruction).toContain("Tone: Warm");
    expect(body.input).toContain("Template text, 12 beds.");
    expect(body.generation_config).toBeUndefined();
  });

  it("throws on an API error without leaking the key, on a cut-off answer and on an empty one", async () => {
    mockFetch(() => reply({ error: { code: "invalid_request", message: "API key not valid" } }, 400));
    const err = await geminiProvider("secret-key", {}).polish(input).catch((e: Error) => e);
    expect((err as Error).message).toBe("Gemini error 400 invalid_request: API key not valid");
    mockFetch(() => reply({ ...modelOutput("Cut off mid-sen"), status: "incomplete" }));
    await expect(geminiProvider("secret-key", {}).polish(input)).rejects.toThrow("Gemini did not finish the draft (status incomplete)");
    mockFetch(() => reply({ status: "completed", steps: [] }));
    await expect(geminiProvider("secret-key", {}).polish(input)).rejects.toThrow("Gemini returned no text");
  });
});

describe("agent runs with Gemini", () => {
  const run = (agent: string) => {
    const store = new Store({ today });
    const app = createApp(store, { env: { GEMINI_API_KEY: "secret-key" } });
    return request(app).post(`/api/agents/${agent}/run`).send({}).expect(200).then((res) => ({ res, store }));
  };
  const created = (store: Store, n: number) => store.state.approvals.slice(0, n);

  it("stores the model's text in every new draft", async () => {
    const fetch = mockFetch(() => reply(modelOutput("Gemini wrote this.")));
    const { res, store } = await run("social-media");
    expect(fetch).toHaveBeenCalledTimes(res.body.itemsCreated);
    expect(res.body.provider).toBe("Google Gemini (gemini-4-hydrogen)");
    expect(res.body.steps.find((s: { system: string }) => s.system === "Model").detail).toBe(`${res.body.itemsCreated} drafts written with Google Gemini (gemini-4-hydrogen)`);
    const texts = created(store, res.body.itemsCreated).map((a) => a.payload.type === "social_post" && a.payload.text);
    expect(new Set(texts)).toEqual(new Set(["Gemini wrote this."]));
  });

  it("keeps the template draft and says so when Gemini fails", async () => {
    const template = createApp(new Store({ today }), { llm: templateProvider, env: {} });
    const expected = await request(template).post("/api/agents/supplier-outreach/run").send({}).expect(200);
    mockFetch(() => reply({ error: { code: "rate_limit_exceeded", message: "Quota exceeded" } }, 429));
    const { res, store } = await run("supplier-outreach");
    const n = res.body.itemsCreated;
    expect(n).toBe(expected.body.itemsCreated);
    expect(n).toBeGreaterThan(0);
    expect(res.body.steps.find((s: { system: string }) => s.system === "Model").detail)
      .toBe(`0 of ${n} drafts written with Google Gemini (gemini-4-hydrogen); ${n} kept the built-in template (Gemini error 429 rate_limit_exceeded: Quota exceeded)`);
    for (const a of created(store, n)) expect(a.payload.type === "supplier_email" && a.payload.body).toContain("Kind regards,");
  });
});
