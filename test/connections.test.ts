import { describe, expect, it } from "vitest";
import { hosted, hostedRoutes } from "./helpers";

describe("listConnections", () => {
  it("lists one toolkit's connections by backend id, with Mastra's status vocabulary", async () => {
    const { provider, gw } = hosted();
    const result = await provider.listConnections({ toolkit: "gmail" });
    expect(result).toEqual({
      items: [
        { connectionId: "app-gmail-work", status: "active", createdAt: "2026-01-02T03:04:05.000Z" },
        { connectionId: "app-gmail-old", status: "failed" },
      ],
      pagination: { page: 1, perPage: 50, hasMore: false },
    });
    expect("createdAt" in result.items[1]!).toBe(false);
    expect(gw.of("GET /v1/apps")).toHaveLength(1);
  });

  it("ignores userId / userIds — the account is personal, every caller sees the same connections", async () => {
    const { provider } = hosted();
    const a = await provider.listConnections({ toolkit: "slack", userId: "alice" });
    const b = await provider.listConnections({ toolkit: "slack", userIds: [] });
    expect(a.items).toEqual([{ connectionId: "app-slack-default", status: "active" }]);
    expect(b.items).toEqual(a.items);
  });

  it("returns an empty page for a toolkit with no connections", async () => {
    const { provider } = hosted();
    expect(await provider.listConnections({ toolkit: "github" })).toEqual({ items: [], pagination: { page: 1, perPage: 50, hasMore: false } });
  });

  it("paginates and clamps perPage to 200", async () => {
    const { provider } = hosted();
    const p1 = await provider.listConnections({ toolkit: "gmail", page: 1, perPage: 1 });
    expect(p1.items.map((c) => c.connectionId)).toEqual(["app-gmail-work"]);
    expect(p1.pagination).toEqual({ page: 1, perPage: 1, hasMore: true });
    const p2 = await provider.listConnections({ toolkit: "gmail", page: 2, perPage: 1 });
    expect(p2.items.map((c) => c.connectionId)).toEqual(["app-gmail-old"]);
    expect(p2.pagination.hasMore).toBe(false);
    expect((await provider.listConnections({ toolkit: "gmail", perPage: 5000 })).pagination.perPage).toBe(200);
  });

  it("normalizes createdAt to ISO: epoch millis (hosted), ISO strings, and drops garbage", async () => {
    const { provider } = hosted(
      hostedRoutes({
        "GET /v1/apps": () => [
          { id: "ms", service: "gmail", alias: "a", createdAt: 1767323045000 },
          { id: "iso", service: "gmail", alias: "b", createdAt: "2026-01-02T03:04:05.000Z" },
          { id: "junk", service: "gmail", alias: "c", createdAt: "yesterday-ish" },
          { id: "nan", service: "gmail", alias: "d", createdAt: Number.NaN },
        ],
      }),
    );
    const { items } = await provider.listConnections({ toolkit: "gmail" });
    expect(items.map((c) => c.createdAt)).toEqual(["2026-01-02T03:04:05.000Z", "2026-01-02T03:04:05.000Z", undefined, undefined]);
  });

  it("treats a connection without a status as active", async () => {
    const { provider } = hosted(hostedRoutes({ "GET /v1/apps": () => [{ id: "x", service: "gmail", alias: "a" }] }));
    expect((await provider.listConnections({ toolkit: "gmail" })).items).toEqual([{ connectionId: "x", status: "active" }]);
  });
});

describe("getConnectionStatus", () => {
  it("answers every tuple from a single apps call", async () => {
    const { provider, gw } = hosted();
    const result = await provider.getConnectionStatus({
      items: [
        { connectionId: "app-gmail-work", toolkit: "gmail" }, // active
        { connectionId: "app-gmail-old", toolkit: "gmail" }, // needs re-auth
        { connectionId: "app-slack-default", toolkit: "gmail" }, // exists, wrong toolkit
        { connectionId: "app-missing", toolkit: "gmail" }, // gone
      ],
    });
    expect(result).toEqual({
      "app-gmail-work": { connected: true },
      "app-gmail-old": { connected: false },
      "app-slack-default": { connected: false },
      "app-missing": { connected: false },
    });
    expect(gw.of("GET /v1/apps")).toHaveLength(1);
  });

  it("returns {} for no items without a request", async () => {
    const { provider, gw } = hosted();
    expect(await provider.getConnectionStatus({ items: [] })).toEqual({});
    expect(gw.calls).toHaveLength(0);
  });
});
