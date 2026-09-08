/**
 * A programmable fake of the OOMOL gateway / runtime behind the SDK's public `fetch` injection.
 * Routes are keyed `"<METHOD> <pathname>"`; a handler returns the envelope `data` (wrapped in the
 * SDK's success envelope) or a full `Response` for custom statuses.
 */
import { Connector, OpenConnector } from "@oomol-lab/connector";
import { OomolOpenToolProvider, OomolToolProvider } from "../src/index";
import type { OomolToolProviderOptions } from "../src/index";

export interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: unknown;
}

export type Route = (call: Call) => unknown | Response;
export type Routes = Record<string, Route>;

export function ok(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, message: "OK", data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function fail(errorCode: string, status: number, message = errorCode): Response {
  return new Response(JSON.stringify({ success: false, message, data: null, errorCode }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export interface Gateway {
  fetch: typeof fetch;
  calls: Call[];
  /** Calls matching a route key. */
  of(routeKey: string): Call[];
}

export function gateway(routes: Routes): Gateway {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const call: Call = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const route = routes[`${call.method} ${call.url.pathname}`];
    if (!route) return fail("not_found", 404, `no route for ${call.method} ${call.url.pathname}`);
    const result = await route(call);
    return result instanceof Response ? result : ok(result);
  };
  return {
    fetch: fetchImpl,
    calls,
    of: (routeKey) => calls.filter((c) => `${c.method} ${c.url.pathname}` === routeKey),
  };
}

// --- fixtures (wire shapes: apps use `alias`, which the SDK renames to `connectionName`) ---

export const PROVIDERS = [
  { service: "gmail", displayName: "Gmail", iconUrl: "https://icons.oomol.com/gmail.png", homepageUrl: null, categories: [], authTypes: ["oauth"] },
  { service: "slack", displayName: "Slack", iconUrl: null, homepageUrl: null, categories: [], authTypes: ["oauth"] },
  { service: "github", displayName: "GitHub", iconUrl: "https://icons.oomol.com/github.png", homepageUrl: null, categories: [], authTypes: ["oauth", "api_key"] },
];

export const SEARCH_THREADS = {
  id: "gmail.search_threads",
  service: "gmail",
  name: "Search threads",
  description: "Search Gmail threads",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  outputSchema: { type: "object", properties: { threads: { type: "array" } }, required: ["threads"] },
};
export const SEND_EMAIL = {
  id: "gmail.send_email",
  service: "gmail",
  name: "Send email",
  inputSchema: { type: "object", properties: { to: { type: "string" } } },
  outputSchema: { type: "object" },
};
export const POST_MESSAGE = {
  id: "slack.post_message",
  service: "slack",
  name: "Post message",
  description: "Post a message to a Slack channel",
  inputSchema: { type: "object", properties: { channel: { type: "string" }, text: { type: "string" } } },
  outputSchema: { type: "object" },
};
export const CREATE_ISSUE = {
  id: "github.create_issue",
  service: "github",
  name: "Create issue",
  description: "Open a GitHub issue",
  inputSchema: { type: "object", properties: { title: { type: "string" } } },
  outputSchema: { type: "object" },
};

export const ACTIONS: Record<string, unknown[]> = {
  gmail: [SEARCH_THREADS, SEND_EMAIL],
  slack: [POST_MESSAGE],
  github: [CREATE_ISSUE],
};

/** What `POST /v1/connections/{service}/connect` answers: a started OAuth attempt. */
export const START = {
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=st_1",
  stateHandle: "st_1",
  connectionRequestId: "cr_1",
  status: "initiated",
  expiresAt: "2026-09-08T00:10:00.000Z",
};

/** What `GET /v1/connection-requests/{id}` answers while (or after) the user completes it. */
export function attempt(overrides: Record<string, unknown> = {}) {
  return {
    connectionRequestId: "cr_1",
    service: "gmail",
    status: "initiated",
    appId: null,
    errorCode: null,
    errorMessage: null,
    expiresAt: "2026-09-08T00:10:00.000Z",
    createdAt: 1_767_323_045_000,
    updatedAt: 1_767_323_045_000,
    ...overrides,
  };
}

export const APPS = [
  { id: "app-gmail-work", service: "gmail", status: "active", alias: "work", createdAt: 1767323045000 },
  { id: "app-gmail-old", service: "gmail", status: "reauth_required", alias: "old" },
  { id: "app-slack-default", service: "slack", status: "active", alias: null },
];

/** Catalog + apps routes for the hosted gateway (`/v1/...`). */
export function hostedRoutes(overrides: Routes = {}): Routes {
  return {
    "GET /v1/providers": () => PROVIDERS,
    "GET /v1/actions": (call) => ACTIONS[call.url.searchParams.get("service") ?? ""] ?? [],
    "GET /v1/actions/gmail.search_threads": () => SEARCH_THREADS,
    "GET /v1/apps": () => APPS,
    "POST /v1/actions/gmail.search_threads": (call) => ({ threads: [], echo: (call.body as { input: unknown }).input }),
    "POST /v1/actions/slack.post_message": () => ({ ok: true }),
    "POST /v1/connections/gmail/connect": () => START,
    "GET /v1/connection-requests/cr_1": () => attempt(),
    ...overrides,
  };
}

const HOSTED_BASE = "https://connector.oomol.com/v1";

/** A hosted provider over the fake gateway, built through the public config path. */
export function hosted(routes: Routes = hostedRoutes(), options: OomolToolProviderOptions = {}) {
  const gw = gateway(routes);
  const provider = new OomolToolProvider({ apiKey: "api-test", fetch: gw.fetch, maxRetries: 0, ...options });
  return { provider, gw };
}

/** A hosted provider over an existing `Connector` (the `{ connector }` config path). */
export function hostedWithConnector(routes: Routes = hostedRoutes(), options: OomolToolProviderOptions = {}) {
  const gw = gateway(routes);
  const connector = new Connector({ apiKey: "api-test", fetch: gw.fetch, maxRetries: 0, baseUrl: HOSTED_BASE });
  const provider = new OomolToolProvider({ connector, ...options });
  return { provider, connector, gw };
}

/** A self-hosted provider over the fake runtime (`http://localhost:3000/v1/...`). */
export function open(
  routes: Routes = hostedRoutes(),
  options: OomolToolProviderOptions & { runtimeToken?: string; adminToken?: string } = {},
) {
  const gw = gateway(routes);
  const provider = new OomolOpenToolProvider({ fetch: gw.fetch, maxRetries: 0, ...options });
  return { provider, gw };
}

export function openWithConnector(routes: Routes = hostedRoutes(), options: OomolToolProviderOptions = {}) {
  const gw = gateway(routes);
  const connector = new OpenConnector({ fetch: gw.fetch, maxRetries: 0 });
  const provider = new OomolOpenToolProvider({ connector, ...options });
  return { provider, connector, gw };
}
