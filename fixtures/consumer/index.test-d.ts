// Type-level acceptance against the BUILT declarations (dist/*.d.mts), resolved the way a real
// consumer resolves the package. Guards the public config shapes and the ToolProvider contract.
import { expectAssignable, expectError, expectType } from "tsd";
import type { AuthFlowStatus, ToolProvider, ToolProviderHealth } from "@mastra/core/tool-provider";
import { Connector, OpenConnector } from "@oomol-lab/connector";
import { OomolOpenToolProvider, OomolToolProvider } from "@oomol-lab/connector-mastra";
import type { OomolOpenToolProviderConfig, OomolToolProviderConfig } from "@oomol-lab/connector-mastra";

// Both providers satisfy Mastra's ToolProvider contract.
expectAssignable<ToolProvider>(new OomolToolProvider({ apiKey: "api-x" }));
expectAssignable<ToolProvider>(new OomolOpenToolProvider());

// Hosted: `ClientConfig` fields pass straight through, or an existing Connector is accepted.
new OomolToolProvider({ apiKey: "api-x", team: "acme", connectionName: "work", timeoutMs: 5_000, allowedToolkits: ["gmail"] });
new OomolToolProvider({ connector: new Connector({ apiKey: "api-x" }), allowedTools: { gmail: ["gmail.search_*"] } });
new OomolToolProvider({ connector: new Connector({ apiKey: "api-x" }).using({ connectionName: "work" }) });

// Hosted: `apiKey` (or a connector) is required; the wrong kind of value is rejected.
expectError(new OomolToolProvider({}));
expectError(new OomolToolProvider({ allowedToolkits: ["gmail"] }));
expectError(new OomolToolProvider({ apiKey: 123 }));
expectError(new OomolToolProvider({ apiKey: "api-x", validateOutput: "yes" }));

// Self-hosted: everything optional; `OpenConnectorConfig` fields pass straight through.
new OomolOpenToolProvider({});
new OomolOpenToolProvider({ baseUrl: "http://localhost:3000", runtimeToken: "oct_x", validateOutput: true });
new OomolOpenToolProvider({ connector: new OpenConnector() });
expectError(new OomolOpenToolProvider({ runtimeToken: 1 }));

// Both providers expose a health probe; its result is Mastra's health shape.
expectType<Promise<ToolProviderHealth>>(new OomolToolProvider({ apiKey: "api-x" }).getHealth());
expectType<Promise<ToolProviderHealth>>(new OomolOpenToolProvider().getHealth());
// With an existing Connector, only the probe-steering fields are accepted alongside it.
new OomolToolProvider({ connector: new Connector({ apiKey: "api-x" }), baseUrl: "https://staging.example.com/v1", timeoutMs: 1_000 });

// The OAuth flow: start one, then poll it by the handle it returns.
expectType<Promise<{ url: string; authId: string }>>(
  new OomolToolProvider({ apiKey: "api-x" }).authorize({ toolkit: "gmail", connectionId: "c1" }),
);
expectType<Promise<AuthFlowStatus>>(new OomolToolProvider({ apiKey: "api-x" }).getAuthStatus("cr_1"));
expectType<Promise<AuthFlowStatus>>(new OomolOpenToolProvider().getAuthStatus("cr_1"));
new OomolToolProvider({ apiKey: "api-x", authorizeReturnUri: "https://app.example.com/done" });
// The self-hosted runtime needs its ADMIN token for the connect routes, not the runtime token.
new OomolOpenToolProvider({ runtimeToken: "oct_x", adminToken: "admin-secret" });
expectError(new OomolOpenToolProvider({ adminToken: 1 }));
expectError(new OomolToolProvider({ apiKey: "api-x", authorizeReturnUri: 1 }));

// Config aliases are exported for wrapping code.
const hostedConfig: OomolToolProviderConfig = { apiKey: "api-x" };
const openConfig: OomolOpenToolProviderConfig = {};
void hostedConfig;
void openConfig;
