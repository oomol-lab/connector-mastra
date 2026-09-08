import { afterEach, describe, expect, it, vi } from "vitest";
import { Connector } from "@oomol-lab/connector";
import { OomolToolProvider } from "../src/index";
import { gateway, hosted, hostedRoutes } from "./helpers";

const healthy = () => hostedRoutes({ "GET /health": () => null });

describe("OomolToolProvider.getHealth — the gateway's unauthenticated GET /health", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("probes /health at the gateway ORIGIN (not under /v1), without an Authorization header", async () => {
    const { provider, gw } = hosted(healthy());
    expect(await provider.getHealth()).toEqual({ ok: true, details: { url: "https://connector.oomol.com/health", status: 200 } });
    const call = gw.of("GET /health")[0]!;
    expect(call.url.toString()).toBe("https://connector.oomol.com/health");
    expect(call.headers["authorization"]).toBeUndefined();
    expect(call.headers["accept"]).toBe("application/json");
  });

  it("derives the origin from a custom baseUrl", async () => {
    const gw = gateway(healthy());
    const provider = new OomolToolProvider({ apiKey: "api-test", baseUrl: "https://staging.example.com/v1/", fetch: gw.fetch });
    await provider.getHealth();
    expect(gw.of("GET /health")[0]!.url.toString()).toBe("https://staging.example.com/health");
  });

  it("reports a non-2xx answer as not ok with the status, and never throws on a network failure", async () => {
    const down = hosted(hostedRoutes({ "GET /health": () => new Response("nope", { status: 503 }) }));
    expect(await down.provider.getHealth()).toEqual({
      ok: false,
      message: "GET /health responded 503",
      details: { url: "https://connector.oomol.com/health", status: 503 },
    });

    const exploding = hosted({
      "GET /health": () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(await exploding.provider.getHealth()).toEqual({
      ok: false,
      message: "ECONNREFUSED",
      details: { url: "https://connector.oomol.com/health" },
    });

    const weird = hosted({
      "GET /health": () => {
        throw "socket hang up";
      },
    });
    expect((await weird.provider.getHealth()).message).toBe("socket hang up");
  });

  it("with an existing Connector, probes the production origin through global fetch unless told otherwise", async () => {
    const gw = gateway(healthy());
    vi.stubGlobal("fetch", gw.fetch);
    const connector = new Connector({ apiKey: "api-test", fetch: gw.fetch, maxRetries: 0 });
    const provider = new OomolToolProvider({ connector });
    expect((await provider.getHealth()).ok).toBe(true);
    expect(gw.of("GET /health")[0]!.url.toString()).toBe("https://connector.oomol.com/health");

    const staged = new OomolToolProvider({ connector, baseUrl: "http://gateway.internal:8080/v1", fetch: gw.fetch, timeoutMs: 1_000 });
    await staged.getHealth();
    expect(gw.of("GET /health")[1]!.url.toString()).toBe("http://gateway.internal:8080/health");
  });

  it("rejects an unparsable baseUrl up front", () => {
    expect(() => new OomolToolProvider({ apiKey: "api-test", baseUrl: "not a url" })).toThrow(TypeError);
  });
});
