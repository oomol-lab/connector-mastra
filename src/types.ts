/**
 * Public construction types.
 */

import type { ClientConfig, Connector, OpenConnector, OpenConnectorConfig } from "@oomol-lab/connector";

/**
 * Options shared by both providers. The allowlists follow the same semantics as Mastra's own
 * `BaseToolProviderOptions`, so a config written for `ComposioToolProvider` reads the same here.
 */
export interface OomolToolProviderOptions {
  /**
   * Keep only the toolkits (OOMOL services) whose slug matches one of these patterns — an exact
   * slug (`"gmail"`) or a prefix wildcard (`"google*"`). Omit to expose every service the gateway
   * knows.
   */
  allowedToolkits?: readonly string[];
  /**
   * Per-toolkit tool allowlist, keyed by toolkit slug. Patterns match tool slugs — exact
   * (`"gmail.search_threads"`) or prefix wildcard (`"gmail.search_*"`). A toolkit absent from the
   * map is left unfiltered; an explicit empty array hides all of its tools.
   */
  allowedTools?: Readonly<Record<string, readonly string[]>>;
  /**
   * Attach each action's `outputSchema` to the resolved tool so Mastra validates what the action
   * returned. Off by default: a strict output schema turns any provider response that drifts from
   * it into a tool error the LLM sees, even though the call succeeded.
   */
  validateOutput?: boolean;
  /**
   * Where the backend sends the browser once an `authorize` flow finishes, with `status`
   * (`success` / `error`) and `service` appended. Omit and the backend renders its own result page,
   * which is fine because Mastra learns the outcome from `getAuthStatus`, not from the redirect.
   * Set it to land the user back in your app. Scheme must be `https:`, `http:`, or `oomol:`.
   */
  authorizeReturnUri?: string;
}

/**
 * Config for {@link OomolToolProvider} (hosted gateway). Either pass the same fields you would give
 * `new Connector({...})` — `apiKey` is required — or hand over an existing `Connector` (a
 * `using()`-scoped one works too). With an existing connector, `baseUrl` / `fetch` / `timeoutMs`
 * only steer the `getHealth` probe (the connector already carries its own); `baseUrl` defaults to
 * the production gateway.
 */
export type OomolToolProviderConfig = OomolToolProviderOptions &
  (({ connector: Connector } & Pick<ClientConfig, "baseUrl" | "fetch" | "timeoutMs">) | ClientConfig);

/**
 * Config for {@link OomolOpenToolProvider} (self-hosted runtime). Either pass the same fields you
 * would give `new OpenConnector({...})` — every field is optional, so `{}` targets
 * `http://localhost:3000` without a token — or hand over an existing `OpenConnector`.
 */
export type OomolOpenToolProviderConfig = OomolToolProviderOptions & ({ connector: OpenConnector } | OpenConnectorConfig);
