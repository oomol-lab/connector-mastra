/**
 * Integration with the REAL Mastra runtime pieces (devDependency only): the stored-config fan-out
 * that hydrates editor-configured agents, and `createTool`'s JSON Schema validation. Guards the
 * contract this package is written against, not just its own logic.
 */
import { describe, expect, it } from "vitest";
import { resolveStoredToolProviders } from "@mastra/core/tool-provider";
import { createTool } from "@mastra/core/tools";
import { hosted, hostedRoutes } from "./helpers";

describe("Mastra runtime fan-out (resolveStoredToolProviders)", () => {
  it("hydrates an editor-style agent config: one pinned connection keeps natural slugs", async () => {
    const { provider, gw } = hosted();
    const tools = await resolveStoredToolProviders(
      {
        oomol: {
          tools: { "gmail.search_threads": { toolkit: "gmail" }, "slack.post_message": { toolkit: "slack" } },
          connections: {
            gmail: [{ kind: "author", toolkit: "gmail", connectionId: "app-gmail-work" }],
            slack: [{ kind: "author", toolkit: "slack", connectionId: "app-slack-default" }],
          },
        },
      },
      () => provider,
    );
    expect(Object.keys(tools).toSorted()).toEqual(["gmail.search_threads", "slack.post_message"]);
    expect(tools["gmail.search_threads"]!.id).toBe("gmail.search_threads");

    await tools["gmail.search_threads"]!.execute!({ query: "from:boss" }, {} as never);
    expect(gw.of("POST /v1/actions/gmail.search_threads")[0]!.headers["x-oo-connector-alias"]).toBe("work");
  });

  it("fans out over two pinned connections of one toolkit with Mastra's __LABEL suffix", async () => {
    const { provider, gw } = hosted();
    const tools = await resolveStoredToolProviders(
      {
        oomol: {
          tools: { "gmail.search_threads": { toolkit: "gmail" } },
          connections: {
            gmail: [
              { kind: "author", toolkit: "gmail", connectionId: "app-gmail-work", label: "Work" },
              { kind: "author", toolkit: "gmail", connectionId: "app-gmail-old", label: "Old" },
            ],
          },
        },
      },
      () => provider,
    );
    expect(Object.keys(tools).toSorted()).toEqual(["gmail.search_threads__OLD", "gmail.search_threads__WORK"]);
    expect(tools["gmail.search_threads__WORK"]!.description).toContain("Search Gmail threads");

    await tools["gmail.search_threads__WORK"]!.execute!({ query: "a" }, {} as never);
    await tools["gmail.search_threads__OLD"]!.execute!({ query: "b" }, {} as never);
    const aliases = gw.of("POST /v1/actions/gmail.search_threads").map((c) => c.headers["x-oo-connector-alias"]);
    expect(aliases).toEqual(["work", "old"]);
    // Each connection resolved its own name exactly once.
    expect(gw.of("GET /v1/apps")).toHaveLength(2);
  });
});

describe("Mastra tool validation with the gateway's JSON Schema", () => {
  it("createTool accepts the resolved tool as-is and validates input against the action schema", async () => {
    const { provider, gw } = hosted();
    const resolved = await provider.resolveTools(["gmail.search_threads"]);
    const tool = createTool(resolved["gmail.search_threads"] as never);

    const bad = await tool.execute!({ nope: 1 } as never, {} as never);
    expect(bad).toMatchObject({ error: true, message: expect.stringContaining("must have required property 'query'") });
    expect(gw.of("POST /v1/actions/gmail.search_threads")).toHaveLength(0);

    const good = await tool.execute!({ query: "from:boss" } as never, {} as never);
    expect(good).toEqual({ threads: [], echo: { query: "from:boss" } });
  });

  it("with validateOutput, a response that drifts from outputSchema becomes a tool error", async () => {
    const { provider } = hosted(hostedRoutes({ "POST /v1/actions/gmail.search_threads": () => ({ nothing: "here" }) }), {
      validateOutput: true,
    });
    const resolved = await provider.resolveTools(["gmail.search_threads"]);
    const tool = createTool(resolved["gmail.search_threads"] as never);
    const result = await tool.execute!({ query: "x" } as never, {} as never);
    expect(result).toMatchObject({ error: true, message: expect.stringContaining("must have required property 'threads'") });
  });
});
