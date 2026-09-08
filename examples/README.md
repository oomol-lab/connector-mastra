# Examples

Runnable, type-checked examples. Each needs a real OOMOL API key:

```sh
OOMOL_API_KEY=api-... bun run examples/agent.ts
```

| File | Covers |
| --- | --- |
| [`agent.ts`](./agent.ts) | Code-configured agent: `listTools` browsing, `resolveTools` with a named connection, the resulting `tools` map on a Mastra `Agent` |
| [`connect.ts`](./connect.ts) | The OAuth flow by hand: `authorize` to start it, `getAuthStatus` to poll it, `listConnections` to learn the real connection id, `resolveToolsVNext` to use it |

Wiring the provider into the Mastra editor is a one-liner; see the README at the repo root.
