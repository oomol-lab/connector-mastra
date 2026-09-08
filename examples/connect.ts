/**
 * Connecting an account through the provider — the OAuth flow Mastra's editor drives for you,
 * run by hand so you can see its three steps.
 *
 * In the editor you never write this: the connection picker calls `authorize`, opens the URL,
 * polls `getAuthStatus`, then refetches `listConnections`. This file is that same sequence, useful
 * for a headless onboarding flow of your own or for debugging a provider that will not connect.
 *
 *   OOMOL_API_KEY=api-... bun run examples/connect.ts
 *
 * Permission note: connecting is a MANAGEMENT operation, and the bar is higher than running tools.
 * The hosted gateway needs the key's user to be `creator` or `admin` of the effective team.
 */
import { OomolToolProvider } from "@oomol-lab/connector-mastra";

const oomol = new OomolToolProvider({
  apiKey: process.env.OOMOL_API_KEY!,
  // Optional. Where the browser lands once the callback completes; omit and the backend renders
  // its own result page, which is fine because the outcome is read from `getAuthStatus` anyway.
  authorizeReturnUri: "https://app.example.com/oauth/done",
});

const TOOLKIT = "gmail";

// 0. Remember what already exists. `authId` is an attempt handle, not a connection id, and the
//    list comes back in the backend's own order, so the only reliable way to name the connection
//    this run created is to diff the ids around the flow.
const before = new Set(
  (await oomol.listConnections({ toolkit: TOOLKIT })).items.map((c) => c.connectionId),
);

// 1. Start the flow. `connectionId` is required by Mastra's signature but ignored here: the
//    backend mints the connection, and its id, only after the user finishes.
const { url, authId } = await oomol.authorize({ toolkit: TOOLKIT, connectionId: "unused" });
console.log("send the user here:", url);
console.log("poll handle:", authId);

// 2. Poll until it settles. Mastra does this for you in the editor.
let status = await oomol.getAuthStatus(authId);
const deadline = Date.now() + 10 * 60_000; // the backend's authorization window
while (status === "pending" && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  status = await oomol.getAuthStatus(authId);
}
console.log("settled as:", status);

if (status !== "completed") {
  // `failed` covers a declined consent screen, a superseded attempt, AND an expired window —
  // Mastra has no separate state for "the user walked away".
  console.log("not connected; nothing was stored");
  process.exit(0);
}

// 3. Read the connection back. THIS is where the real id comes from — not from `authId`, which is
//    the attempt handle. It is the id you pin onto an agent and pass to `resolveToolsVNext`.
const { items } = await oomol.listConnections({ toolkit: TOOLKIT });
const connected = items.filter((c) => c.status === "active");
console.log("active connections:", connected.map((c) => c.connectionId));

// 4. Use it. The provider turns the pinned id into the connection the SDK executes against.
//    Anything but a connection that appeared during this flow would be someone else's account.
const added = connected.filter((c) => !before.has(c.connectionId));
if (added.length !== 1) {
  console.log(`expected exactly one new connection, got ${added.length}; pin one of the ids above by hand`);
  process.exit(0);
}

const tools = await oomol.resolveToolsVNext({
  toolSlugs: [`${TOOLKIT}.search_threads`],
  toolMeta: { [`${TOOLKIT}.search_threads`]: { toolkit: TOOLKIT } },
  toolkit: TOOLKIT,
  connectionId: added[0]!.connectionId,
});
console.log("resolved tools:", Object.keys(tools));
