<div align="center">

# @oomol-lab/connector-mastra

[![npm](https://img.shields.io/npm/v/@oomol-lab/connector-mastra.svg)](https://www.npmjs.com/package/@oomol-lab/connector-mastra)
[![CI](https://img.shields.io/github/actions/workflow/status/oomol-lab/connector-mastra/ci.yml?branch=main&label=CI)](https://github.com/oomol-lab/connector-mastra/actions/workflows/ci.yml)
[![types](https://img.shields.io/npm/types/@oomol-lab/connector-mastra.svg)](https://www.npmjs.com/package/@oomol-lab/connector-mastra)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

</div>

**Your OOMOL connections as Mastra tools.** A [Mastra](https://mastra.ai) `ToolProvider` over the [OOMOL Connector](https://github.com/oomol-lab/connector-sdk): every action the gateway models (`gmail.search_threads`, `slack.post_message`, `github.create_issue`, …) shows up in the Mastra editor's tool picker and can be handed to a code-configured agent. Connecting an account runs through the editor too; tokens, refresh, and credential storage stay on the gateway, exactly as with the SDK.

```ts
import { MastraEditor } from "@mastra/editor";
import { OomolToolProvider } from "@oomol-lab/connector-mastra";

const editor = new MastraEditor({
  toolProviders: {
    oomol: new OomolToolProvider({ apiKey: process.env.OOMOL_API_KEY! }),
  },
});
```

Two providers ship in the package, mirroring the SDK's two personal clients:

| Provider | Talks to | Construct with |
| --- | --- | --- |
| `OomolToolProvider` | the hosted gateway (`Connector`) | the same fields as `new Connector({...})`, or `{ connector }` |
| `OomolOpenToolProvider` | the open-source, self-hosted runtime (`OpenConnector`) | the same fields as `new OpenConnector({...})`, or `{ connector }` |

## Install

```sh
npm install @oomol-lab/connector-mastra @mastra/core   # or: bun add / pnpm add / yarn add
```

`@mastra/core` is a peer dependency (types only, `^1.64`). The package itself depends on nothing but `@oomol-lab/connector`; it imports no Mastra code at runtime and needs no Zod. Node ≥ 20.

You need an OOMOL Connector API key (`api-…`): <https://console.oomol.com/api-key>. Connect the accounts you want agents to use in the console as well; the provider lists and uses connections, it does not create them.

## In the editor

Register the provider under any key; that key is what the editor stores on agents:

```ts
const editor = new MastraEditor({
  toolProviders: {
    oomol: new OomolToolProvider({
      apiKey: process.env.OOMOL_API_KEY!,
      allowedToolkits: ["gmail", "slack", "github"],       // optional narrowing
      allowedTools: { gmail: ["gmail.search_*"] },        // optional, per toolkit
    }),
  },
});
```

In the picker, **toolkits** are OOMOL services and **tools** are OOMOL actions. Pinning a connection onto an agent uses the connections that already exist on your account (`apps.list()` in the SDK), and "Connect" runs a real OAuth flow through the gateway, so a missing account can be added without leaving the editor. See [Connecting an account](#connecting-an-account) for what that flow needs. "Disconnect" stays hidden: removing a connection is done in the OOMOL console.

## In code

Skip the editor and hand tools straight to an agent:

```ts
import { Agent } from "@mastra/core/agent";
import { OomolToolProvider } from "@oomol-lab/connector-mastra";

const oomol = new OomolToolProvider({ apiKey: process.env.OOMOL_API_KEY! });

// Runs on the client's default connection, or name one of yours.
const tools = await oomol.resolveTools(["gmail.search_threads", "slack.post_message"], undefined, {
  connectionName: "work",
});

const agent = new Agent({
  id: "inbox-assistant",
  name: "Inbox assistant",
  instructions: "Triage the user's inbox.",
  model: "openai/gpt-4o-mini",
  tools,
});
```

`resolveTools` accepts the same per-tool description overrides Mastra's other providers do (`{ "gmail.search_threads": { description: "…" } }` as the second argument). See [`examples/`](./examples) for a runnable version.

## Self-hosted runtime

```ts
import { OomolOpenToolProvider } from "@oomol-lab/connector-mastra";

new OomolOpenToolProvider();                                            // http://localhost:3000, no token
new OomolOpenToolProvider({ baseUrl: "https://connector.internal", runtimeToken: "oct_…" });
new OomolOpenToolProvider({ runtimeToken: "oct_…", adminToken: "…" });   // adminToken is for `authorize` only
new OomolOpenToolProvider({ connector: existingOpenConnector });
```

Same surface as the hosted provider; `getHealth()` is backed by the runtime's `/v1/health` probe (token-aware) instead of the gateway's root `/health`.

**`authorize` is admin-scoped on a self-hosted runtime**, and what it needs depends on how you configured that runtime. One with no authentication at all accepts it unauthenticated. Once runtime tokens are enforced an `adminToken` becomes mandatory: without one the runtime answers 403 (`Configure an admin token to manage connections`), and with one configured a runtime token (`oct_…`) is refused with 401. The SDK sends `adminToken` on the connect routes and `runtimeToken` everywhere else, so pass both when your runtime enforces auth.

## Options

Both providers accept, on top of the SDK config they pass through:

| Option | Default | Effect |
| --- | --- | --- |
| `allowedToolkits` | all | Keep only toolkits (services) whose slug matches: exact `"gmail"` or prefix wildcard `"google*"`. Enforced on `resolveTools` too, not just discovery. |
| `allowedTools` | all | Per-toolkit tool allowlist, keyed by toolkit slug, patterns over tool slugs (`"gmail.search_*"`). An absent toolkit is unfiltered; `[]` hides it entirely. |
| `validateOutput` | `false` | Attach each action's `outputSchema` so Mastra validates tool results. Off by default: a strict schema turns a provider response that drifts from it into a tool error, even though the call succeeded. |
| `authorizeReturnUri` | — | Where the browser lands after an `authorize` flow completes, with `status` and `service` appended. Omit and the backend renders its own result page, which loses nothing: Mastra learns the outcome from `getAuthStatus`, not from the redirect. |

The allowlist semantics are Mastra's own (`BaseToolProviderOptions`), so a config written for `ComposioToolProvider` reads the same here.

## How Mastra's contract maps onto the SDK

| Mastra `ToolProvider` | Backed by | Notes |
| --- | --- | --- |
| `listToolkits` / `listToolkitsVNext` | `catalog.providers()` | slug = service, name = displayName, icon = iconUrl |
| `listTools` / `listToolsVNext` | `catalog.actions(service)` | One call with a `toolkit`; a bounded fan-out over every allowed toolkit without. `search` is a case-insensitive substring match; paging is in memory. |
| `getToolSchema` | `catalog.action(slug).inputSchema` | `null` on 404, any other failure is rethrown |
| `resolveTools` / `resolveToolsVNext` | `catalog.actions` + `execute` | Tools carry the action's JSON Schema verbatim; Mastra validates input with it. `execute` forwards Mastra's `abortSignal`. |
| `listConnections` | `apps.list()` | `connectionId` is the backend's connection `id`; status mapped to Mastra's four states. `userId(s)` are ignored: the account is personal. |
| `getConnectionStatus` | `apps.list()` | One call answers every tuple |
| `authorize` | `connect.oauth(toolkit)` | Returns the provider's authorization URL plus the attempt handle as `authId`. Management-scoped, see below. |
| `getAuthStatus` | `connect.getAttempt(authId)` | `initiated` maps to `pending`, `connected` to `completed`; everything else, `expired` included, to `failed`. An unknown handle reads as `failed`, not an error. |
| `getHealth` | hosted: `GET /health` at the gateway origin (unauthenticated liveness); self-hosted: `health()` | Never throws; answers reachability, not key validity |
| `capabilities` | — | `multipleConnectionsPerToolkit: true`, `batchConnectionStatus: true`, `reauthorizeReusesConnectionId: false`, `supportsRevoke: false` |

A pinned `connectionId` is resolved to the SDK's `connectionName` lazily on the tool's first execution and cached on success, so a stale pin fails that one tool call with a clear message instead of failing agent hydration, and a connection that appears later is picked up without re-resolving.

### Connecting an account

`authorize` starts an OAuth flow and `getAuthStatus` polls it; the editor's connection picker drives both for you. [`examples/connect.ts`](./examples/connect.ts) runs the same three steps by hand.

Two things about this flow are worth knowing before you debug it.

**The id you get back is not the id you pass in.** OOMOL mints the connection, and its id, only when the callback lands, and it accepts no caller-supplied id at flow start. So `authorize` ignores `opts.connectionId` and the real id arrives afterwards through `listConnections`, which is where Mastra reads it from. `capabilities.reauthorizeReusesConnectionId` is `false` to declare exactly that. Acting on `completed` immediately is safe: the backend writes the connection row and flips the attempt in one transaction, so the connection is already listed and `active` the moment the status says so.

A side effect of that gap: Mastra keys the label and scope it records at authorize time on the returned `authId`, then joins them back by the connection id `listConnections` reports. Ours differ, so a label typed while connecting is not kept. Pinning, execution and status are unaffected. Set the label on the connection afterwards.

**Authorizing needs more permission than running tools.** On the hosted gateway the key's user must be `creator` or `admin` of the effective team; a plain member is refused with a 403 before the request lands. On a self-hosted runtime it is admin-scoped, see [Self-hosted runtime](#self-hosted-runtime). Running actions needs neither.

### Deliberately not implemented

`listConnectionFields` and `revokeConnection` have no counterpart in the personal `Connector` / `OpenConnector` surface: the provider's connection-field declarations live on a backend route the SDK does not map, and the SDK has no delete call, since connections are removed in the OOMOL console. Both methods are **absent** rather than stubbed, which is the signal the Mastra editor uses to hide the matching affordances. An absent `listConnectionFields` also means the picker never collects extra fields, so `AuthorizeOpts.config` arrives empty in practice; pass it yourself and it is forwarded as the backend's per-attempt `extra`.

The project-scoped `ProjectConnector` (connect accounts on behalf of your end-users) is out of scope for this package.

## Development

```sh
bun install
bun run check   # lint + typecheck + build + tests at 100% coverage + type-level acceptance
```

## License

MIT
