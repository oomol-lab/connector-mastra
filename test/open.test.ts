import { describe, expect, it } from "vitest";
import { fail, hostedRoutes, open } from "./helpers";

const ctx = {} as never;

describe("OomolOpenToolProvider — same surface against the self-hosted runtime", () => {
  it("browses the runtime catalog under /v1 on the configured origin", async () => {
    const { provider, gw } = open();
    const toolkits = await provider.listToolkits();
    expect(toolkits.data.map((t) => t.slug)).toEqual(["gmail", "slack", "github"]);
    const tools = await provider.listTools({ toolkit: "gmail" });
    expect(tools.data.map((t) => t.slug)).toEqual(["gmail.search_threads", "gmail.send_email"]);
    expect(gw.calls.every((c) => c.url.origin === "http://localhost:3000" && c.url.pathname.startsWith("/v1/"))).toBe(true);
  });

  it("executes with the pinned connection's name and the runtime token", async () => {
    const { provider, gw } = open(undefined, { runtimeToken: "oct_test" });
    const tools = await provider.resolveToolsVNext({ toolSlugs: ["gmail.search_threads"], toolMeta: {}, connectionId: "app-gmail-work", toolkit: "gmail" });
    await tools["gmail.search_threads"]!.execute!({ query: "a" }, ctx);
    const exec = gw.of("POST /v1/actions/gmail.search_threads")[0]!;
    expect(exec.headers["authorization"]).toBe("Bearer oct_test");
    expect(exec.headers["x-oo-connector-alias"]).toBe("work");
  });

  it("lists connections and answers status checks", async () => {
    const { provider } = open();
    expect((await provider.listConnections({ toolkit: "gmail" })).items.map((c) => c.connectionId)).toEqual(["app-gmail-work", "app-gmail-old"]);
    expect(await provider.getConnectionStatus({ items: [{ connectionId: "app-slack-default", toolkit: "slack" }] })).toEqual({
      "app-slack-default": { connected: true },
    });
  });
});

describe("OomolOpenToolProvider.getHealth", () => {
  it("reports ok with the runtime id when the probe passes", async () => {
    const { provider } = open(hostedRoutes({ "GET /v1/health": () => ({ ok: true, runtime: "oomol-connect" }) }));
    expect(await provider.getHealth()).toEqual({ ok: true, details: { runtime: "oomol-connect" } });
  });

  it("reports not ok when the runtime says so", async () => {
    const { provider } = open(hostedRoutes({ "GET /v1/health": () => ({ ok: false, runtime: "oomol-connect" }) }));
    expect(await provider.getHealth()).toEqual({
      ok: false,
      message: 'Runtime "oomol-connect" reports not ok',
      details: { runtime: "oomol-connect" },
    });
  });

  it("never throws: an unreachable or unauthorized runtime becomes { ok: false, message }", async () => {
    const denied = open(hostedRoutes({ "GET /v1/health": () => fail("unauthorized", 401, "runtime token required") }));
    expect(await denied.provider.getHealth()).toEqual({ ok: false, message: "runtime token required" });

    const exploding = open({
      "GET /v1/health": () => {
        throw "socket hang up";
      },
    });
    const result = await exploding.provider.getHealth();
    expect(result.ok).toBe(false);
    expect(typeof result.message).toBe("string");
  });
});

describe("OomolOpenToolProvider — bring your own client", () => {
  it("accepts any object with the Connector shape, and stringifies a non-Error health failure", async () => {
    const fake = {
      execute: async () => ({}),
      catalog: { action: async () => ({}), actions: async () => [], providers: async () => [] },
      apps: { list: async () => [] },
      connect: { oauth: async () => ({}), getAttempt: async () => ({}) },
      health: async () => {
        throw "socket hang up";
      },
    };
    const { OomolOpenToolProvider } = await import("../src/index");
    const provider = new OomolOpenToolProvider({ connector: fake as never });
    expect(await provider.getHealth()).toEqual({ ok: false, message: "socket hang up" });
  });
});
