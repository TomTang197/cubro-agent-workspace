import type { Store } from "../store.js";
import { ConnectorError, SYSTEMS, type Env, type FetchLike } from "./config.js";
import { createLiveClickUp, createLiveInforLn, createLiveM365, createLiveSalesforce } from "./live/index.js";
import { createMockConnectors } from "./mock/index.js";
import type { Connectors, SystemId } from "./types.js";

/** Whether a system is switched to its real API (CONNECTOR_<SYSTEM>=live) or runs on sample data. */
export const isLive = (system: SystemId, env: Env) => env[SYSTEMS[system].switchKey]?.trim().toLowerCase() === "live";

/** The password staff sign in to the workspace with (WORKSPACE_PASSWORD). Without one, anyone who can reach the address can open it. */
export const workspacePassword = (env: Env) => env.WORKSPACE_PASSWORD?.trim() || undefined;

/** A real system is not read or written to while the workspace is open to anyone: every call fails with the reason until a password is set. */
function locked<T extends object>(system: SystemId): T {
  const refuse = async () => { throw new ConnectorError(system, "Not connected: the workspace has no sign-in password yet. Set WORKSPACE_PASSWORD on the server and restart, so that only staff can read these records and approve work."); };
  return new Proxy({}, { get: () => refuse }) as T;
}

/** Notes on the workspace the first time a real system answers a read or a write, so what is saved from then on stays behind the password. A status check alone does not count. */
function marking<T extends object>(connector: T, store: Store): T {
  return new Proxy(connector, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || prop === "status") return value;
      return async (...args: unknown[]) => {
        const out = await value.apply(target, args);
        if (!store.state.heldLive) { store.state.heldLive = true; store.save(); }
        return out;
      };
    },
  });
}

export function createConnectors(store: Store, env: Env = process.env, fetchImpl: FetchLike = fetch): Connectors {
  const mock = createMockConnectors(store, env);
  const live = <T extends object>(system: SystemId, make: () => T, sample: T) => (!isLive(system, env) ? sample : workspacePassword(env) ? marking(make(), store) : locked<T>(system));
  return {
    m365: live("m365", () => createLiveM365(env, fetchImpl), mock.m365),
    salesforce: live("salesforce", () => createLiveSalesforce(env, fetchImpl), mock.salesforce),
    clickup: live("clickup", () => createLiveClickUp(env, fetchImpl), mock.clickup),
    inforln: live("inforln", () => createLiveInforLn(env, fetchImpl), mock.inforln),
  };
}
export type { Connectors } from "./types.js";
