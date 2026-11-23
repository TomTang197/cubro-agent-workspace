// Shared HTTP plumbing for the live connectors: JSON requests with clear errors, and OAuth tokens that are fetched once and reused.
import { ConnectorError, missingSettings, type Env, type FetchLike } from "../config.js";
import type { SystemId } from "../types.js";

const TIMEOUT_MS = 20_000;

export interface Http {
  /** Sends a request and returns the parsed JSON body (undefined when the response has none). */
  json<T>(url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown; form?: Record<string, string> }): Promise<T>;
}

export function createHttp(system: SystemId, fetchImpl: FetchLike): Http {
  return {
    async json<T>(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; form?: Record<string, string> } = {}) {
      const headers: Record<string, string> = { accept: "application/json", ...init.headers };
      let body: string | undefined;
      if (init.form) { headers["content-type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(init.form).toString(); }
      else if (init.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(init.body); }
      let res: Response;
      try {
        res = await fetchImpl(url, { method: init.method ?? "GET", headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (e) {
        throw new ConnectorError(system, `could not reach ${new URL(url).host} (${e instanceof Error ? e.message : String(e)}).`);
      }
      const text = await res.text();
      if (!res.ok) {
        const hint = res.status === 401 ? " The credentials were rejected." : res.status === 403 ? " The account does not have permission for this." : res.status === 404 ? " The address or ID was not found." : res.status === 429 ? " The system is rate limiting requests; try again shortly." : "";
        throw new ConnectorError(system, `${new URL(url).host} answered ${res.status}.${hint} ${text.replace(/\s+/g, " ").slice(0, 240)}`.trim(), res.status);
      }
      if (!text) return undefined as T;
      try { return JSON.parse(text) as T; } catch { throw new ConnectorError(system, `${new URL(url).host} did not answer with JSON.`); }
    },
  };
}

/** Fails early, naming the settings IT still has to provide. */
export function requireSettings(system: SystemId, env: Env) {
  const missing = missingSettings(system, env);
  if (missing.length) throw new ConnectorError(system, `Not set up yet. Missing: ${missing.map((s) => `${s.label} (${s.key})`).join(", ")}.`);
}

/** Caches an OAuth access token until shortly before it expires. */
export function tokenCache(fetchToken: () => Promise<{ access_token: string; expires_in?: number | string }>) {
  let token: { value: string; expires: number } | undefined;
  return {
    async get() {
      if (!token || Date.now() > token.expires) {
        const t = await fetchToken();
        token = { value: t.access_token, expires: Date.now() + (Number(t.expires_in) || 1800) * 1000 - 60_000 };
      }
      return token.value;
    },
    clear() { token = undefined; },
  };
}

export const trimSlash = (s: string) => s.replace(/\/+$/, "");
