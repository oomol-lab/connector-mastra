/**
 * `OomolToolProvider` — the hosted OOMOL Connector gateway as a Mastra tool provider.
 */

import type { ToolProviderHealth, ToolProviderInfo } from "@mastra/core/tool-provider";
import { Connector } from "@oomol-lab/connector";
import { OomolToolProviderBase } from "./provider";
import type { OomolToolProviderConfig } from "./types";

const DEFAULT_BASE_URL = "https://connector.oomol.com/v1";
const DEFAULT_TIMEOUT_MS = 30_000;

const INFO: ToolProviderInfo = {
  id: "oomol",
  name: "OOMOL Connector",
  description: "Actions on your connected accounts (Gmail, Slack, GitHub, Notion, …) via the OOMOL Connector gateway",
};

/**
 * Mastra tool provider over the hosted OOMOL Connector gateway.
 *
 * ```ts
 * const editor = new MastraEditor({
 *   toolProviders: { oomol: new OomolToolProvider({ apiKey: process.env.OOMOL_API_KEY! }) },
 * });
 * ```
 *
 * Accepts the same fields as `new Connector({...})`, or an existing `Connector` via `{ connector }`.
 * Connections (OAuth, credentials) are managed in the OOMOL console; the provider lists and uses
 * them, it does not create them. `getHealth` probes the gateway's unauthenticated `GET /health`.
 */
export class OomolToolProvider extends OomolToolProviderBase<Connector> {
  readonly #probe: { url: string; fetch: typeof fetch; timeoutMs: number };

  constructor(config: OomolToolProviderConfig) {
    super("connector" in config ? config.connector : new Connector(config), config, INFO);
    this.#probe = {
      // `/health` lives at the gateway ORIGIN, outside the `/v1` prefix the SDK talks to.
      url: new URL("/health", config.baseUrl ?? DEFAULT_BASE_URL).toString(),
      fetch: config.fetch ?? ((input, init) => globalThis.fetch(input, init)),
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
  }

  /**
   * `GET /health` on the gateway origin — the unauthenticated liveness probe the gateway keeps
   * outside `/v1`. Answers whether the gateway is reachable, not whether the API key is valid.
   * Never throws.
   */
  async getHealth(): Promise<ToolProviderHealth> {
    const { url, fetch: probe, timeoutMs } = this.#probe;
    try {
      const res = await probe(url, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      const details = { url, status: res.status };
      return res.ok ? { ok: true, details } : { ok: false, message: `GET /health responded ${res.status}`, details };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err), details: { url } };
    }
  }
}
