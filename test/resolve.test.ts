import { describe, expect, it } from "vitest";
import { SEARCH_THREADS, fail, hosted, hostedRoutes } from "./helpers";

/** Mastra passes an execution context; only `abortSignal` matters to the provider. */
const ctx = (signal?: AbortSignal) => ({ abortSignal: signal }) as never;

describe("resolveToolsVNext — tool shape", () => {
  it("materializes a Mastra tool per slug: id, description, the action's JSON Schema, an execute", async () => {
    const { provider, gw } = hosted();
    const tools = await provider.resolveToolsVNext({ toolSlugs: ["gmail.search_threads"], toolMeta: {}, connectionId: "", toolkit: "gmail" });
    const tool = tools["gmail.search_threads"]!;
    expect(Object.keys(tools)).toEqual(["gmail.search_threads"]);
    expect(tool.id).toBe("gmail.search_threads");
    expect(tool.description).toBe("Search Gmail threads");
    expect(tool.inputSchema).toEqual(SEARCH_THREADS.inputSchema);
    expect(tool.outputSchema).toBeUndefined();
    expect(typeof tool.execute).toBe("function");
    // One catalog call for the toolkit, nothing executed yet.
    expect(gw.of("GET /v1/actions")).toHaveLength(1);
    expect(gw.of("POST /v1/actions/gmail.search_threads")).toHaveLength(0);
  });

  it("honors the per-agent description override from toolMeta, and falls back to '' with no description at all", async () => {
    const { provider } = hosted();
    const tools = await provider.resolveToolsVNext({
      toolSlugs: ["gmail.search_threads", "gmail.send_email"],
      toolMeta: { "gmail.search_threads": { toolkit: "gmail", description: "Find mail from the boss" } },
      connectionId: "",
      toolkit: "gmail",
    });
    expect(tools["gmail.search_threads"]!.description).toBe("Find mail from the boss");
    expect(tools["gmail.send_email"]!.description).toBe("");
  });

  it("attaches outputSchema only when validateOutput is on", async () => {
    const strict = hosted(undefined, { validateOutput: true });
    const tools = await strict.provider.resolveToolsVNext({ toolSlugs: ["gmail.search_threads"], toolMeta: {}, connectionId: "" });
    expect(tools["gmail.search_threads"]!.outputSchema).toEqual(SEARCH_THREADS.outputSchema);
  });

  it("skips slugs the catalog does not have, and returns {} for no slugs without any request", async () => {
    const { provider, gw } = hosted();
    const tools = await provider.resolveToolsVNext({ toolSlugs: ["gmail.search_threads", "gmail.vanished"], toolMeta: {}, connectionId: "" });
    expect(Object.keys(tools)).toEqual(["gmail.search_threads"]);
    expect(await provider.resolveToolsVNext({ toolSlugs: [], toolMeta: {}, connectionId: "" })).toEqual({});
    expect(gw.calls).toHaveLength(1);
  });

  it("groups slugs by toolkit — one catalog call per toolkit, toolMeta.toolkit preferred over the slug prefix", async () => {
    const { provider, gw } = hosted();
    const tools = await provider.resolveToolsVNext({
      toolSlugs: ["gmail.search_threads", "gmail.send_email", "slack.post_message"],
      toolMeta: { "slack.post_message": { toolkit: "slack" } },
      connectionId: "",
    });
    expect(Object.keys(tools).toSorted()).toEqual(["gmail.search_threads", "gmail.send_email", "slack.post_message"]);
    expect(gw.of("GET /v1/actions").map((c) => c.url.searchParams.get("service")).toSorted()).toEqual(["gmail", "slack"]);
  });
});

/**
 * The allowlists are a fence, not a display filter: an agent config pinned before the allowlist
 * tightened still hands its old slugs to the resolver, so both resolvers re-apply them.
 */
describe("resolveTools / resolveToolsVNext — allowlists", () => {
  it("drops a slug outside allowedTools, on both resolvers", async () => {
    const opts = { allowedTools: { gmail: ["gmail.search_*"] } };
    const slugs = ["gmail.search_threads", "gmail.send_email"];

    const vnext = hosted(undefined, opts);
    expect(Object.keys(await vnext.provider.resolveToolsVNext({ toolSlugs: slugs, toolMeta: {}, connectionId: "" })))
      .toEqual(["gmail.search_threads"]);

    const legacy = hosted(undefined, opts);
    expect(Object.keys(await legacy.provider.resolveTools(slugs))).toEqual(["gmail.search_threads"]);
  });

  it("drops a slug outside allowedToolkits without fetching that toolkit's catalog", async () => {
    const { provider, gw } = hosted(undefined, { allowedToolkits: ["gmail"] });
    const tools = await provider.resolveToolsVNext({
      toolSlugs: ["gmail.search_threads", "slack.post_message"],
      toolMeta: {},
      connectionId: "",
    });
    expect(Object.keys(tools)).toEqual(["gmail.search_threads"]);
    expect(gw.of("GET /v1/actions").map((c) => c.url.searchParams.get("service"))).toEqual(["gmail"]);
  });

  it("trusts the action's own service over a toolMeta.toolkit that claims an allowed one", async () => {
    // toolMeta says "gmail", but `slack.post_message` really belongs to the excluded slack toolkit.
    const { provider } = hosted(undefined, { allowedToolkits: ["gmail"] });
    const tools = await provider.resolveToolsVNext({
      toolSlugs: ["slack.post_message"],
      toolMeta: { "slack.post_message": { toolkit: "gmail" } },
      connectionId: "",
    });
    expect(tools).toEqual({});
  });

  it("returns {} without any request when every slug is fenced off", async () => {
    const { provider, gw } = hosted(undefined, { allowedToolkits: ["github"] });
    expect(await provider.resolveToolsVNext({ toolSlugs: ["gmail.search_threads"], toolMeta: {}, connectionId: "" })).toEqual({});
    expect(gw.calls).toHaveLength(0);
  });
});

describe("resolveToolsVNext — execute", () => {
  it("POSTs the input to the action on the client default connection when connectionId is empty", async () => {
    const { provider, gw } = hosted();
    const tools = await provider.resolveToolsVNext({ toolSlugs: ["gmail.search_threads"], toolMeta: {}, connectionId: "" });
    const out = await tools["gmail.search_threads"]!.execute!({ query: "from:boss" }, ctx());
    expect(out).toEqual({ threads: [], echo: { query: "from:boss" } });
    const exec = gw.of("POST /v1/actions/gmail.search_threads")[0]!;
    expect(exec.body).toEqual({ input: { query: "from:boss" } });
    expect(exec.headers["x-oo-connector-alias"]).toBeUndefined();
    expect(gw.of("GET /v1/apps")).toHaveLength(0);
  });

  it("resolves a pinned connectionId to its connectionName lazily, once, shared by every tool of the call", async () => {
    const { provider, gw } = hosted();
    const tools = await provider.resolveToolsVNext({
      toolSlugs: ["gmail.search_threads", "gmail.send_email"],
      toolMeta: {},
      connectionId: "app-gmail-work",
      toolkit: "gmail",
    });
    expect(gw.of("GET /v1/apps")).toHaveLength(0); // nothing looked up at resolve time
    await tools["gmail.search_threads"]!.execute!({ query: "a" }, ctx());
    await tools["gmail.search_threads"]!.execute!({ query: "b" }, ctx());
    await tools["gmail.send_email"]!.execute!({ to: "x" }, ctx()).catch(() => undefined);
    expect(gw.of("GET /v1/apps")).toHaveLength(1);
    for (const exec of gw.of("POST /v1/actions/gmail.search_threads")) expect(exec.headers["x-oo-connector-alias"]).toBe("work");
  });

  it("a pinned connection with a null name falls back to the default (no alias header)", async () => {
    const { provider, gw } = hosted();
    const tools = await provider.resolveToolsVNext({ toolSlugs: ["slack.post_message"], toolMeta: {}, connectionId: "app-slack-default", toolkit: "slack" });
    await tools["slack.post_message"]!.execute!({ channel: "#x", text: "hi" }, ctx());
    expect(gw.of("POST /v1/actions/slack.post_message")[0]!.headers["x-oo-connector-alias"]).toBeUndefined();
  });

  it("fails the execute (not the resolve) with a clear error when the pinned connection is gone, and retries the lookup next call", async () => {
    let apps: unknown[] = [];
    const { provider, gw } = hosted(hostedRoutes({ "GET /v1/apps": () => apps }));
    const tools = await provider.resolveToolsVNext({ toolSlugs: ["gmail.search_threads"], toolMeta: {}, connectionId: "app-gmail-work", toolkit: "gmail" });
    await expect(tools["gmail.search_threads"]!.execute!({ query: "a" }, ctx())).rejects.toThrow(/connection "app-gmail-work" not found/);
    // The connection shows up later — no re-hydration needed.
    apps = [{ id: "app-gmail-work", service: "gmail", status: "active", alias: "work" }];
    await tools["gmail.search_threads"]!.execute!({ query: "a" }, ctx());
    expect(gw.of("GET /v1/apps")).toHaveLength(2);
    expect(gw.of("POST /v1/actions/gmail.search_threads")[0]!.headers["x-oo-connector-alias"]).toBe("work");
  });

  it("refuses a connection pinned to the wrong toolkit", async () => {
    const { provider } = hosted();
    const tools = await provider.resolveToolsVNext({ toolSlugs: ["gmail.search_threads"], toolMeta: {}, connectionId: "app-slack-default", toolkit: "gmail" });
    await expect(tools["gmail.search_threads"]!.execute!({ query: "a" }, ctx())).rejects.toThrow(/belongs to "slack", not "gmail"/);
  });

  it("without a toolkit hint, any toolkit's connection id is accepted (legacy-style callers)", async () => {
    const { provider, gw } = hosted();
    const tools = await provider.resolveToolsVNext({ toolSlugs: ["gmail.search_threads"], toolMeta: {}, connectionId: "app-gmail-work" });
    await tools["gmail.search_threads"]!.execute!({ query: "a" }, ctx());
    expect(gw.of("POST /v1/actions/gmail.search_threads")[0]!.headers["x-oo-connector-alias"]).toBe("work");
  });

  it("forwards Mastra's abortSignal to the SDK call", async () => {
    const controller = new AbortController();
    controller.abort();
    const { provider } = hosted();
    const tools = await provider.resolveToolsVNext({ toolSlugs: ["gmail.search_threads"], toolMeta: {}, connectionId: "" });
    await expect(tools["gmail.search_threads"]!.execute!({ query: "a" }, ctx(controller.signal))).rejects.toThrow();
  });

  it("tolerates being called with no context at all", async () => {
    const { provider } = hosted();
    const tools = await provider.resolveToolsVNext({ toolSlugs: ["gmail.search_threads"], toolMeta: {}, connectionId: "" });
    await expect(tools["gmail.search_threads"]!.execute!({ query: "a" }, undefined as never)).resolves.toMatchObject({ threads: [] });
  });

  it("lets a gateway failure surface as the SDK's typed error", async () => {
    const { provider } = hosted(hostedRoutes({ "POST /v1/actions/gmail.search_threads": () => fail("scope_missing", 403) }));
    const tools = await provider.resolveToolsVNext({ toolSlugs: ["gmail.search_threads"], toolMeta: {}, connectionId: "" });
    await expect(tools["gmail.search_threads"]!.execute!({ query: "a" }, ctx())).rejects.toMatchObject({ name: "ConnectorError", code: "scope_missing" });
  });
});

describe("resolveTools (legacy)", () => {
  it("resolves on the default connection and maps toolConfigs descriptions", async () => {
    const { provider, gw } = hosted();
    const tools = await provider.resolveTools(["gmail.search_threads", "gmail.send_email"], {
      "gmail.search_threads": { description: "Boss mail only" },
      "gmail.send_email": {},
    });
    expect(tools["gmail.search_threads"]!.description).toBe("Boss mail only");
    expect(tools["gmail.send_email"]!.description).toBe("");
    await tools["gmail.search_threads"]!.execute!({ query: "a" }, ctx());
    expect(gw.of("POST /v1/actions/gmail.search_threads")[0]!.headers["x-oo-connector-alias"]).toBeUndefined();
    expect(gw.of("GET /v1/apps")).toHaveLength(0);
  });

  it("honors a `connectionName` option without any lookup", async () => {
    const { provider, gw } = hosted();
    const tools = await provider.resolveTools(["gmail.search_threads"], undefined, { connectionName: "work" });
    await tools["gmail.search_threads"]!.execute!({ query: "a" }, ctx());
    expect(gw.of("POST /v1/actions/gmail.search_threads")[0]!.headers["x-oo-connector-alias"]).toBe("work");
    expect(gw.of("GET /v1/apps")).toHaveLength(0);
  });

  it("ignores a non-string connectionName and a null toolConfig entry", async () => {
    const { provider, gw } = hosted();
    const tools = await provider.resolveTools(["gmail.search_threads"], { "gmail.search_threads": undefined as never }, { connectionName: 42 });
    await tools["gmail.search_threads"]!.execute!({ query: "a" }, ctx());
    expect(gw.of("POST /v1/actions/gmail.search_threads")[0]!.headers["x-oo-connector-alias"]).toBeUndefined();
  });
});
