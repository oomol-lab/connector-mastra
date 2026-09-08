import { describe, expect, it } from "vitest";
import { ACTIONS, CREATE_ISSUE, POST_MESSAGE, SEARCH_THREADS, SEND_EMAIL, fail, hosted, hostedRoutes } from "./helpers";

describe("listToolkits / listToolkitsVNext", () => {
  it("maps OOMOL providers to toolkits (slug=service, name=displayName, icon only when present)", async () => {
    const { provider } = hosted();
    const { data } = await provider.listToolkitsVNext();
    expect(data).toEqual([
      { slug: "gmail", name: "Gmail", icon: "https://icons.oomol.com/gmail.png" },
      { slug: "slack", name: "Slack" },
      { slug: "github", name: "GitHub", icon: "https://icons.oomol.com/github.png" },
    ]);
    expect("icon" in data[1]!).toBe(false);
  });

  it("legacy listToolkits returns the same page", async () => {
    const { provider } = hosted();
    expect(await provider.listToolkits()).toEqual(await provider.listToolkitsVNext());
  });

  it("applies allowedToolkits (exact and prefix wildcard)", async () => {
    const exact = hosted(undefined, { allowedToolkits: ["slack"] });
    expect((await exact.provider.listToolkits()).data.map((t) => t.slug)).toEqual(["slack"]);
    const wild = hosted(undefined, { allowedToolkits: ["g*"] });
    expect((await wild.provider.listToolkits()).data.map((t) => t.slug)).toEqual(["gmail", "github"]);
  });
});

describe("listTools / listToolsVNext", () => {
  it("lists one toolkit's actions with a single catalog call", async () => {
    const { provider, gw } = hosted();
    const result = await provider.listToolsVNext({ toolkit: "gmail" });
    expect(result).toEqual({
      data: [
        { slug: "gmail.search_threads", name: "Search threads", description: "Search Gmail threads", toolkit: "gmail" },
        { slug: "gmail.send_email", name: "Send email", toolkit: "gmail" },
      ],
      pagination: { page: 1, hasMore: false },
    });
    expect(gw.of("GET /v1/providers")).toHaveLength(0);
    expect(gw.of("GET /v1/actions").map((c) => c.url.searchParams.get("service"))).toEqual(["gmail"]);
    expect("description" in result.data[1]!).toBe(false);
  });

  it("without a toolkit, fans out over every allowed toolkit", async () => {
    const { provider, gw } = hosted(undefined, { allowedToolkits: ["gmail", "slack"] });
    const { data } = await provider.listToolsVNext();
    expect(data.map((t) => t.slug)).toEqual(["gmail.search_threads", "gmail.send_email", "slack.post_message"]);
    expect(gw.of("GET /v1/providers")).toHaveLength(1);
    expect(gw.of("GET /v1/actions").map((c) => c.url.searchParams.get("service")).toSorted()).toEqual(["gmail", "slack"]);
  });

  it("returns an empty page for a toolkit outside allowedToolkits without touching the catalog", async () => {
    const { provider, gw } = hosted(undefined, { allowedToolkits: ["gmail"] });
    expect(await provider.listToolsVNext({ toolkit: "slack", page: 2, perPage: 10 })).toEqual({
      data: [],
      pagination: { page: 2, perPage: 10, hasMore: false },
    });
    expect(gw.calls).toHaveLength(0);
  });

  it("applies allowedTools per toolkit; toolkits absent from the map are unfiltered", async () => {
    const { provider } = hosted(undefined, { allowedTools: { gmail: ["gmail.search_*"], slack: [] } });
    const { data } = await provider.listToolsVNext();
    expect(data.map((t) => t.slug)).toEqual(["gmail.search_threads", "github.create_issue"]);
  });

  it("search is a case-insensitive substring match over slug, name and description", async () => {
    const { provider } = hosted();
    expect((await provider.listToolsVNext({ search: "ISSUE" })).data.map((t) => t.slug)).toEqual(["github.create_issue"]);
    expect((await provider.listToolsVNext({ search: "slack channel" })).data.map((t) => t.slug)).toEqual(["slack.post_message"]);
    expect((await provider.listToolsVNext({ toolkit: "gmail", search: "send_email" })).data.map((t) => t.slug)).toEqual(["gmail.send_email"]);
    expect((await provider.listToolsVNext({ search: "   " })).data).toHaveLength(4);
    expect((await provider.listToolsVNext({ search: "nothing-matches" })).data).toEqual([]);
  });

  it("paginates in memory with an honest hasMore", async () => {
    const { provider } = hosted();
    const p1 = await provider.listToolsVNext({ page: 1, perPage: 3 });
    expect(p1.data.map((t) => t.slug)).toEqual(["gmail.search_threads", "gmail.send_email", "slack.post_message"]);
    expect(p1.pagination).toEqual({ page: 1, perPage: 3, hasMore: true });
    const p2 = await provider.listToolsVNext({ page: 2, perPage: 3 });
    expect(p2.data.map((t) => t.slug)).toEqual(["github.create_issue"]);
    expect(p2.pagination).toEqual({ page: 2, perPage: 3, hasMore: false });
  });

  it("legacy listTools delegates with the same options", async () => {
    const { provider } = hosted();
    expect(await provider.listTools({ toolkit: "slack" })).toEqual(await provider.listToolsVNext({ toolkit: "slack" }));
    expect((await provider.listTools()).data).toHaveLength(4);
  });

  it("tolerates a toolkit whose action list is empty", async () => {
    const { provider } = hosted(hostedRoutes({ "GET /v1/actions": () => [] }));
    expect((await provider.listToolsVNext({ toolkit: "gmail" })).data).toEqual([]);
  });

  it("keeps the fixtures honest: every fixture action is reachable through the fan-out", async () => {
    const { provider } = hosted();
    const { data } = await provider.listToolsVNext();
    expect(data.map((t) => t.slug).toSorted()).toEqual(
      [SEARCH_THREADS, SEND_EMAIL, POST_MESSAGE, CREATE_ISSUE].map((a) => a.id).toSorted(),
    );
    expect(Object.values(ACTIONS).flat()).toHaveLength(4);
  });
});

describe("getToolSchema", () => {
  it("returns the action's input JSON Schema", async () => {
    const { provider, gw } = hosted();
    expect(await provider.getToolSchema("gmail.search_threads")).toEqual(SEARCH_THREADS.inputSchema);
    expect(gw.of("GET /v1/actions/gmail.search_threads")).toHaveLength(1);
  });

  it("returns null when the gateway answers 404", async () => {
    const { provider } = hosted();
    expect(await provider.getToolSchema("gmail.nope")).toBeNull();
  });

  it("rethrows any other failure (a 500 is not 'no schema')", async () => {
    const { provider } = hosted(hostedRoutes({ "GET /v1/actions/gmail.search_threads": () => fail("internal_error", 500) }));
    await expect(provider.getToolSchema("gmail.search_threads")).rejects.toMatchObject({ name: "ConnectorError", status: 500 });
  });
});
