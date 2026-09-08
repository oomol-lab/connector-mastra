import { describe, expect, it } from "vitest";
import type { ToolProvider } from "@mastra/core/tool-provider";
import { OomolOpenToolProvider, OomolToolProvider } from "../src/index";
import { hosted, hostedWithConnector, open, openWithConnector } from "./helpers";

describe("OomolToolProvider — construction", () => {
  it("passes Connector config straight through (apiKey → bearer, team → header)", async () => {
    const { provider, gw } = hosted(undefined, {});
    await provider.listToolkits();
    const call = gw.of("GET /v1/providers")[0]!;
    expect(call.headers["authorization"]).toBe("Bearer api-test");
    expect(call.url.origin).toBe("https://connector.oomol.com");
  });

  it("forwards the rest of ClientConfig (team, connectionName) to the underlying client", async () => {
    const { provider, gw } = hosted(undefined, {});
    void provider;
    const teamed = new OomolToolProvider({ apiKey: "api-test", fetch: gw.fetch, maxRetries: 0, team: "acme", connectionName: "work" });
    const tools = await teamed.resolveTools(["gmail.search_threads"]);
    await tools["gmail.search_threads"]!.execute!({ query: "x" }, {} as never);
    const exec = gw.of("POST /v1/actions/gmail.search_threads")[0]!;
    expect(exec.headers["x-oo-team-name"]).toBe("acme");
    expect(exec.headers["x-oo-connector-alias"]).toBe("work");
  });

  it("accepts an existing Connector via { connector } and never constructs its own", async () => {
    const { provider, gw } = hostedWithConnector();
    await provider.listToolkits();
    expect(gw.of("GET /v1/providers")).toHaveLength(1);
    expect(gw.calls[0]!.headers["authorization"]).toBe("Bearer api-test");
  });

  it("rejects a `connector` that is not a Connector-shaped object with a clear TypeError", () => {
    expect(() => new OomolToolProvider({ connector: {} as never })).toThrow(TypeError);
    expect(() => new OomolToolProvider({ connector: null as never })).toThrow(/must be a Connector/);
    expect(() => new OomolToolProvider({ connector: { execute() {}, apps: { list() {} } } as never })).toThrow(/must be a Connector/);
    expect(
      () => new OomolToolProvider({ connector: { execute() {}, catalog: { actions() {}, providers() {} }, apps: { list() {} } } as never }),
    ).toThrow(/must be a Connector/);
    expect(
      () => new OomolToolProvider({ connector: { execute() {}, catalog: { actions() {}, providers() {}, action() {} }, apps: {} } as never }),
    ).toThrow(/must be a Connector/);
  });

  it("surfaces the SDK's own config validation (missing apiKey)", () => {
    expect(() => new OomolToolProvider({ apiKey: "" })).toThrow(/apiKey/);
  });

  it("exposes stable provider metadata and capability flags", () => {
    const { provider } = hosted();
    expect(provider.info).toEqual({
      id: "oomol",
      name: "OOMOL Connector",
      description: expect.stringContaining("OOMOL Connector gateway"),
    });
    expect(provider.capabilities).toEqual({
      multipleConnectionsPerToolkit: true,
      batchConnectionStatus: true,
      reauthorizeReusesConnectionId: false,
      supportsRevoke: false,
    });
  });

  it("leaves the two methods the SDK cannot back ABSENT (so the editor hides them)", () => {
    const provider: ToolProvider = hosted().provider;
    // The provider's connection fields live on a backend route the SDK does not map, and the SDK
    // has no delete call, so both stay absent rather than being stubbed with a lie.
    expect(provider.listConnectionFields).toBeUndefined();
    expect(provider.revokeConnection).toBeUndefined();
    // …while everything that IS backed is present, the OAuth flow included.
    for (const method of ["listToolkits", "listToolkitsVNext", "listTools", "listToolsVNext", "getToolSchema", "resolveTools", "resolveToolsVNext", "listConnections", "getConnectionStatus", "getHealth", "authorize", "getAuthStatus"] as const) {
      expect(typeof provider[method]).toBe("function");
    }
  });
});

describe("OomolOpenToolProvider — construction", () => {
  it("defaults to the local runtime with no auth header", async () => {
    const { provider, gw } = open();
    await provider.listToolkits();
    const call = gw.of("GET /v1/providers")[0]!;
    expect(call.url.origin).toBe("http://localhost:3000");
    expect(call.headers["authorization"]).toBeUndefined();
  });

  it("is constructible with no argument at all", () => {
    expect(() => new OomolOpenToolProvider()).not.toThrow();
  });

  it("passes OpenConnector config straight through (runtimeToken → bearer)", async () => {
    const { provider, gw } = open(undefined, { runtimeToken: "oct_test" });
    await provider.listToolkits();
    expect(gw.calls[0]!.headers["authorization"]).toBe("Bearer oct_test");
  });

  it("accepts an existing OpenConnector via { connector }", async () => {
    const { provider, gw } = openWithConnector();
    await provider.listToolkits();
    expect(gw.of("GET /v1/providers")).toHaveLength(1);
  });

  it("has its own provider metadata and the same capability flags", () => {
    const { provider } = open();
    expect(provider.info.id).toBe("oomol-open");
    expect(provider.info.name).toContain("self-hosted");
    expect(provider.capabilities.supportsRevoke).toBe(false);
    expect(typeof provider.getHealth).toBe("function");
  });
});
