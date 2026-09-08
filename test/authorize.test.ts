/**
 * `authorize` / `getAuthStatus` — the OAuth flow Mastra drives through the SDK's `connect`
 * namespace. The provider starts the flow and hands back a poll handle; Mastra owns the polling.
 */
import { describe, expect, it } from "vitest";
import { attempt, fail, hosted, hostedRoutes, open, START } from "./helpers";

describe("authorize", () => {
  it("starts an OAuth attempt and returns the URL plus the poll handle", async () => {
    const { provider, gw } = hosted();
    const result = await provider.authorize({ toolkit: "gmail", connectionId: "mastra-minted-1" });

    expect(result).toEqual({ url: START.authorizationUrl, authId: START.connectionRequestId });
    const [call] = gw.of("POST /v1/connections/gmail/connect");
    expect(call).toBeDefined();
    // No `returnUri` configured, so the body carries nothing: the backend renders its own page.
    expect(call!.body).toEqual({});
  });

  it("ignores the connectionId Mastra minted, because the backend assigns its own", async () => {
    const { provider, gw } = hosted();
    await provider.authorize({ toolkit: "gmail", connectionId: "mastra-minted-1", toolName: "gmail.send_email" });

    const body = gw.of("POST /v1/connections/gmail/connect")[0]!.body as Record<string, unknown>;
    // Neither the minted id nor the tool name reaches the wire: OOMOL authorizes a whole service
    // and names the connection itself. `reauthorizeReusesConnectionId: false` declares exactly this.
    expect(Object.values(body)).not.toContain("mastra-minted-1");
    expect(Object.values(body)).not.toContain("gmail.send_email");
  });

  it("sends the configured authorizeReturnUri", async () => {
    const { provider, gw } = hosted(hostedRoutes(), { authorizeReturnUri: "https://app.example.com/done" });
    await provider.authorize({ toolkit: "gmail", connectionId: "c1" });

    expect(gw.of("POST /v1/connections/gmail/connect")[0]!.body).toEqual({
      returnUri: "https://app.example.com/done",
    });
  });

  it("forwards `config` as the backend's per-attempt `extra`", async () => {
    const { provider, gw } = hosted();
    await provider.authorize({ toolkit: "gmail", connectionId: "c1", config: { subdomain: "acme" } });

    expect(gw.of("POST /v1/connections/gmail/connect")[0]!.body).toEqual({ extra: { subdomain: "acme" } });
  });

  it("propagates a backend refusal instead of swallowing it", async () => {
    const { provider } = hosted(
      hostedRoutes({ "POST /v1/connections/gmail/connect": () => fail("user_oauth_client_required", 409) }),
    );
    // A service with no OAuth client configured cannot be authorized, and the editor should say so
    // rather than open a URL that does not exist.
    await expect(provider.authorize({ toolkit: "gmail", connectionId: "c1" })).rejects.toMatchObject({
      code: "user_oauth_client_required",
      status: 409,
    });
  });

  it("works on the self-hosted runtime, carrying the admin token", async () => {
    const { provider, gw } = open(hostedRoutes(), { runtimeToken: "oct_runtime", adminToken: "admin-secret" });
    const result = await provider.authorize({ toolkit: "gmail", connectionId: "c1" });

    expect(result.authId).toBe("cr_1");
    // Connection management is admin-scoped on the runtime: it must NOT carry the runtime token.
    expect(gw.of("POST /v1/connections/gmail/connect")[0]!.headers["authorization"]).toBe("Bearer admin-secret");
    // Everything else keeps the runtime token.
    await provider.listToolkitsVNext();
    expect(gw.of("GET /v1/providers")[0]!.headers["authorization"]).toBe("Bearer oct_runtime");
  });
});

describe("getAuthStatus", () => {
  it.each([
    ["initiated", "pending"],
    ["connected", "completed"],
    ["failed", "failed"],
    // The user never finished. Mastra has no fourth state, so an expired window reads as failed.
    ["expired", "failed"],
    // A status word a newer backend might introduce fails rather than polling forever.
    ["something_new", "failed"],
  ])("maps %s to %s", async (backendStatus, expected) => {
    const { provider } = hosted(
      hostedRoutes({ "GET /v1/connection-requests/cr_1": () => attempt({ status: backendStatus }) }),
    );
    await expect(provider.getAuthStatus("cr_1")).resolves.toBe(expected);
  });

  it("reads a handle the backend no longer knows as failed, not as an error", async () => {
    const { provider } = hosted(
      hostedRoutes({ "GET /v1/connection-requests/gone": () => fail("connection_request_not_found", 404) }),
    );
    // Attempts stay readable for 24h past expiry, so a 404 means the flow is long over.
    await expect(provider.getAuthStatus("gone")).resolves.toBe("failed");
  });

  it("rethrows a failure that is not a missing handle", async () => {
    const { provider } = hosted(
      hostedRoutes({ "GET /v1/connection-requests/cr_1": () => fail("internal_error", 500) }),
    );
    await expect(provider.getAuthStatus("cr_1")).rejects.toMatchObject({ status: 500 });
  });

  it("polls by the connectionRequestId, not the one-shot stateHandle", async () => {
    const { provider, gw } = hosted();
    const { authId } = await provider.authorize({ toolkit: "gmail", connectionId: "c1" });
    await provider.getAuthStatus(authId);

    expect(authId).not.toBe(START.stateHandle);
    expect(gw.of(`GET /v1/connection-requests/${START.connectionRequestId}`)).toHaveLength(1);
  });
});

describe("the completed flow hands the real connection back through listConnections", () => {
  it("surfaces the connection the attempt created, under the backend's own id", async () => {
    const { provider } = hosted(
      hostedRoutes({
        "GET /v1/connection-requests/cr_1": () => attempt({ status: "connected", appId: "app-gmail-work" }),
      }),
    );
    expect(await provider.getAuthStatus("cr_1")).toBe("completed");

    // That id is what `listConnections` offers the picker, and what a pin must carry.
    const { items } = await provider.listConnections({ toolkit: "gmail" });
    expect(items.map((c) => c.connectionId)).toContain("app-gmail-work");
  });
});
