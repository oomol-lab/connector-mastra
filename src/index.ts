/**
 * `@oomol-lab/connector-mastra` — Mastra `ToolProvider` implementations over the OOMOL Connector.
 *
 * - {@link OomolToolProvider}: the hosted gateway (`Connector`).
 * - {@link OomolOpenToolProvider}: the open-source, self-hosted runtime (`OpenConnector`).
 */

export { OomolToolProvider } from "./hosted";
export { OomolOpenToolProvider } from "./open";
export type { OomolToolProviderOptions, OomolToolProviderConfig, OomolOpenToolProviderConfig } from "./types";
