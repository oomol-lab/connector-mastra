/**
 * Code-configured agent — no editor involved. The provider resolves OOMOL actions into Mastra
 * tools; the agent gets them like any other `tools` map.
 *
 * Run with a real API key (and a model provider key Mastra can route to):
 *   OOMOL_API_KEY=api-... OPENAI_API_KEY=sk-... bun run examples/agent.ts
 */
import { Agent } from "@mastra/core/agent";
import { OomolToolProvider } from "@oomol-lab/connector-mastra";

const oomol = new OomolToolProvider({
  apiKey: process.env.OOMOL_API_KEY!,
  // Optional: narrow what the agent can see. Same allowlist semantics as Mastra's own providers.
  allowedToolkits: ["gmail"],
});

// Browse what the gateway offers (this is what the editor's picker calls under the hood).
const { data: gmailTools } = await oomol.listTools({ toolkit: "gmail", perPage: 5 });
console.log("gmail tools:", gmailTools.map((t) => t.slug));

// Materialize executable tools. Runs on the client's default connection unless `connectionName`
// names one of your connections (see `apps.list()` in the SDK, or `listConnections` here).
const tools = await oomol.resolveTools(["gmail.search_threads"], undefined, { connectionName: "work" });

const agent = new Agent({
  id: "inbox-assistant",
  name: "Inbox assistant",
  instructions: "You help the user triage their Gmail inbox. Search before you summarize.",
  model: "openai/gpt-4o-mini",
  tools,
});

const result = await agent.generate("Summarize the unread threads from my boss this week.");
console.log(result.text);
