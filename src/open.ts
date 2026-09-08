/**
 * `OomolOpenToolProvider` — the open-source, self-hosted OOMOL Connector runtime as a Mastra tool
 * provider. Same surface as the hosted provider, plus `getHealth` (the runtime has a health probe).
 */

import type { ToolProviderHealth, ToolProviderInfo } from "@mastra/core/tool-provider";
import { OpenConnector } from "@oomol-lab/connector";
import { OomolToolProviderBase } from "./provider";
import type { OomolOpenToolProviderConfig } from "./types";

const INFO: ToolProviderInfo = {
  id: "oomol-open",
  name: "OOMOL Connector (self-hosted)",
  description: "Actions on the connections of the open-source OOMOL Connector runtime you host",
};

/**
 * Mastra tool provider over a self-hosted OOMOL Connector runtime.
 *
 * ```ts
 * const editor = new MastraEditor({
 *   toolProviders: { oomol: new OomolOpenToolProvider({ baseUrl: "http://localhost:3000" }) },
 * });
 * ```
 *
 * Accepts the same fields as `new OpenConnector({...})` (all optional), or an existing
 * `OpenConnector` via `{ connector }`.
 */
export class OomolOpenToolProvider extends OomolToolProviderBase<OpenConnector> {
  constructor(config: OomolOpenToolProviderConfig = {}) {
    super("connector" in config ? config.connector : new OpenConnector(config), config, INFO);
  }

  /** `GET /v1/health` — reachability + auth probe of the runtime. Never throws. */
  async getHealth(): Promise<ToolProviderHealth> {
    try {
      const health = await this.connector.health();
      const details = { runtime: health.runtime };
      return health.ok ? { ok: true, details } : { ok: false, message: `Runtime "${health.runtime}" reports not ok`, details };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
