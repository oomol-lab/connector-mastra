/**
 * The shared `ToolProvider` implementation. Both public providers are this class over a
 * different client: the hosted `Connector` or the self-hosted `OpenConnector`.
 *
 * Design notes:
 * - Mastra's interface is implemented STRUCTURALLY (`implements ToolProvider` over type-only
 *   imports), so `@mastra/core` is a types-only peer and the built bundle imports nothing from it.
 * - Resolved tools carry the action's JSON Schema as-is (`inputSchema`); Mastra accepts plain
 *   JSON Schema and validates input with it. No Zod, no conversion step.
 * - Tool slug == OOMOL action id (`gmail.search_threads`); toolkit slug == service (`gmail`).
 * - Connection id == the backend's connection `id` from `apps.list()`. A pinned connection is
 *   looked up by id (lazily, on first execute, cached on success) and turned into the
 *   `connectionName` the SDK sends.
 * - `authorize` / `getAuthStatus` drive the SDK's `connect` namespace: OAuth is started by the
 *   provider and polled to completion by Mastra. The other two auth-adjacent methods
 *   (`listConnectionFields`, `revokeConnection`) have no SDK counterpart and stay deliberately
 *   ABSENT — the editor hides those affordances when the method is missing.
 */

import type { PublicSchema } from "@mastra/core/schema";
import type {
  AuthFlowStatus,
  AuthorizeOpts,
  ListConnectionsOpts,
  ListConnectionsResult,
  ListToolkitsResult,
  ListToolProviderToolsOptions,
  ListToolsOpts,
  ListToolsResult,
  ResolveToolProviderToolsOptions,
  ResolveToolsOpts,
  ToolProvider,
  ToolProviderCapabilities,
  ToolProviderInfo,
  ToolProviderListResult,
  ToolProviderToolInfo,
  ToolProviderToolkit,
  ToolProviderToolMeta,
} from "@mastra/core/tool-provider";
import type { ToolAction } from "@mastra/core/tools";
import type { ConnectedApp, ProviderMetadata } from "@oomol-lab/connector";
import {
  isNotFound,
  mapLimit,
  matchesAny,
  memoizeAsync,
  paginate,
  toAuthFlowStatus,
  toConnectionStatus,
  toolkitOf,
} from "./internal";
import type { OomolToolProviderOptions } from "./types";

/** Action metadata as both the hosted gateway and the self-hosted runtime describe it. */
export interface ActionLike {
  id: string;
  service: string;
  name: string;
  description?: string;
  /** JSON Schema for the action input. */
  inputSchema: Record<string, unknown>;
  /** JSON Schema for the action output. */
  outputSchema: Record<string, unknown>;
}

/** A started OAuth authorization, as `connect.oauth` returns it. */
export interface AttemptStartLike {
  /** Where to send the user's browser. */
  authorizationUrl: string;
  /** The poll handle. This is what we hand back to Mastra as `authId`. */
  connectionRequestId: string;
}

/** One authorization attempt read back mid-flight, as `connect.getAttempt` returns it. */
export interface AttemptLike {
  status: string;
  /** The connection this attempt created once connected, else `null`. */
  appId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/** The slice of the SDK's `connect` namespace the provider drives. */
export interface ConnectLike {
  oauth(
    service: string,
    input?: { returnUri?: string; extra?: Record<string, unknown> },
  ): Promise<AttemptStartLike>;
  getAttempt(connectionRequestId: string): Promise<AttemptLike>;
}

/** The slice of a `Connector` / `OpenConnector` the provider drives. */
export interface ConnectorLike {
  execute(actionId: string, input: any, options?: { connectionName?: string; signal?: AbortSignal }): Promise<unknown>;
  readonly catalog: {
    action(actionId: string): Promise<ActionLike>;
    actions(service: string): Promise<ActionLike[]>;
    providers(): Promise<ProviderMetadata[]>;
  };
  readonly apps: {
    list(): Promise<ConnectedApp[]>;
  };
  readonly connect: ConnectLike;
}

type LegacyToolConfigs = Parameters<ToolProvider["resolveTools"]>[1];
type MastraTool = ToolAction<any, any, any>;
/** Yields the `connectionName` to send with an execute call (`undefined` ⇒ the client default). */
type ConnectionResolver = () => Promise<string | undefined>;

/** Parallel catalog fan-out cap (listing tools across every toolkit, resolving across toolkits). */
const CATALOG_CONCURRENCY = 6;
/** `listConnections` page-size bounds, per Mastra's guidance (default 50, max 200). */
const CONNECTIONS_DEFAULT_PER_PAGE = 50;
const CONNECTIONS_MAX_PER_PAGE = 200;

const DEFAULT_CONNECTION: ConnectionResolver = () => Promise.resolve(undefined);

function assertConnectorLike(value: unknown): asserts value is ConnectorLike {
  const c = value as Partial<ConnectorLike> | null | undefined;
  if (
    !c ||
    typeof c.execute !== "function" ||
    typeof c.catalog?.actions !== "function" ||
    typeof c.catalog.providers !== "function" ||
    typeof c.catalog.action !== "function" ||
    typeof c.apps?.list !== "function" ||
    typeof c.connect?.oauth !== "function" ||
    typeof c.connect.getAttempt !== "function"
  ) {
    throw new TypeError(
      "[oomol] `connector` must be a Connector / OpenConnector instance from @oomol-lab/connector >= 1.2 " +
        "(an object with `execute`, `catalog`, `apps` and `connect`)",
    );
  }
}

function toToolkit(p: ProviderMetadata): ToolProviderToolkit {
  const toolkit: ToolProviderToolkit = { slug: p.service, name: p.displayName };
  if (p.iconUrl) toolkit.icon = p.iconUrl;
  return toolkit;
}

function toToolInfo(a: ActionLike): ToolProviderToolInfo {
  const tool: ToolProviderToolInfo = { slug: a.id, name: a.name, toolkit: a.service };
  if (a.description !== undefined) tool.description = a.description;
  return tool;
}

function matchesSearch(tool: ToolProviderToolInfo, needle: string): boolean {
  return [tool.slug, tool.name, tool.description ?? ""].some((text) => text.toLowerCase().includes(needle));
}

/** The gateway's JSON Schema, typed as one of the schema shapes Mastra accepts verbatim. */
function asSchema(json: Record<string, unknown>): PublicSchema<any> {
  return json as unknown as PublicSchema<any>;
}

export class OomolToolProviderBase<C extends ConnectorLike = ConnectorLike> implements ToolProvider {
  readonly info: ToolProviderInfo;
  readonly capabilities: ToolProviderCapabilities = {
    // The gateway keeps several named connections per service; execute selects one by name.
    multipleConnectionsPerToolkit: true,
    // One `apps.list()` answers every `(connectionId, toolkit)` tuple at once.
    batchConnectionStatus: true,
    // Each authorization mints a NEW connection on the backend, which assigns its own id. The id
    // Mastra hands to `authorize` therefore cannot survive the flow, and this flag says so.
    reauthorizeReusesConnectionId: false,
    // The SDK has no delete call; hides the "Disconnect" affordance in the editor.
    supportsRevoke: false,
  };

  protected readonly connector: C;
  readonly #allowedToolkits: readonly string[];
  readonly #allowedTools: Readonly<Record<string, readonly string[]>>;
  readonly #validateOutput: boolean;
  readonly #authorizeReturnUri: string | undefined;

  constructor(connector: C, options: OomolToolProviderOptions, info: ToolProviderInfo) {
    assertConnectorLike(connector);
    this.connector = connector;
    this.info = info;
    this.#allowedToolkits = options.allowedToolkits ?? [];
    this.#allowedTools = options.allowedTools ?? {};
    this.#validateOutput = options.validateOutput ?? false;
    this.#authorizeReturnUri = options.authorizeReturnUri;
  }

  // --- allowlists ---

  #toolkitAllowed(slug: string): boolean {
    return this.#allowedToolkits.length === 0 || matchesAny(slug, this.#allowedToolkits);
  }

  #toolAllowed(action: ActionLike): boolean {
    const patterns = this.#allowedTools[action.service];
    return patterns === undefined || matchesAny(action.id, patterns);
  }

  // --- discovery ---

  /** Toolkits = OOMOL providers (`catalog.providers()`), narrowed by `allowedToolkits`. */
  async listToolkitsVNext(): Promise<ListToolkitsResult> {
    const providers = await this.connector.catalog.providers();
    return { data: providers.filter((p) => this.#toolkitAllowed(p.service)).map(toToolkit) };
  }

  async listToolkits(): Promise<ToolProviderListResult<ToolProviderToolkit>> {
    return this.listToolkitsVNext();
  }

  /**
   * Tools = OOMOL actions (`catalog.actions(service)`). With `toolkit` that is one call; without
   * it, every allowed toolkit is fetched (bounded parallelism). `search` is a case-insensitive
   * substring match over slug / name / description; paging happens in memory.
   */
  async listToolsVNext(opts: ListToolsOpts = {}): Promise<ListToolsResult> {
    if (opts.toolkit !== undefined && !this.#toolkitAllowed(opts.toolkit)) {
      return paginate([], opts.page, opts.perPage);
    }
    const toolkits =
      opts.toolkit !== undefined ? [opts.toolkit] : (await this.listToolkitsVNext()).data.map((t) => t.slug);
    const perToolkit = await mapLimit(toolkits, CATALOG_CONCURRENCY, (tk) => this.connector.catalog.actions(tk));
    const needle = opts.search?.trim().toLowerCase();
    const tools = perToolkit
      .flat()
      .filter((a) => this.#toolAllowed(a))
      .map(toToolInfo)
      .filter((t) => !needle || matchesSearch(t, needle));
    return paginate(tools, opts.page, opts.perPage);
  }

  async listTools(options?: ListToolProviderToolsOptions): Promise<ToolProviderListResult<ToolProviderToolInfo>> {
    return this.listToolsVNext(options);
  }

  /** The action's input JSON Schema (`catalog.action(slug).inputSchema`); `null` when the gateway answers 404. */
  async getToolSchema(toolSlug: string): Promise<Record<string, unknown> | null> {
    try {
      return (await this.connector.catalog.action(toolSlug)).inputSchema;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  // --- runtime ---

  /**
   * Legacy resolver (code-configured agents). Runs on the client's default connection unless
   * `options.connectionName` names one.
   */
  async resolveTools(
    toolSlugs: string[],
    toolConfigs?: LegacyToolConfigs,
    options?: ResolveToolProviderToolsOptions,
  ): Promise<Record<string, MastraTool>> {
    const toolMeta: Record<string, ToolProviderToolMeta> = {};
    for (const [slug, cfg] of Object.entries(toolConfigs ?? {})) toolMeta[slug] = { description: cfg?.description };
    const name = options?.connectionName;
    const connection: ConnectionResolver = typeof name === "string" ? () => Promise.resolve(name) : DEFAULT_CONNECTION;
    return this.#materialize(toolSlugs, toolMeta, connection);
  }

  /**
   * VNext resolver (editor-configured agents; called once per pinned connection). A non-empty
   * `connectionId` is resolved to its `connectionName` on first execute; an empty one means the
   * client default.
   */
  async resolveToolsVNext(opts: ResolveToolsOpts): Promise<Record<string, MastraTool>> {
    const connection = opts.connectionId ? this.#connectionById(opts.connectionId, opts.toolkit) : DEFAULT_CONNECTION;
    return this.#materialize(opts.toolSlugs, opts.toolMeta, connection);
  }

  #connectionById(connectionId: string, toolkit: string | undefined): ConnectionResolver {
    return memoizeAsync(async () => {
      const apps = await this.connector.apps.list();
      const app = apps.find((a) => a.id === connectionId);
      if (!app) throw new Error(`[oomol] connection "${connectionId}" not found — was it removed in the OOMOL console?`);
      if (toolkit !== undefined && app.service !== toolkit) {
        throw new Error(`[oomol] connection "${connectionId}" belongs to "${app.service}", not "${toolkit}"`);
      }
      return app.connectionName ?? undefined;
    });
  }

  async #materialize(
    slugs: string[],
    toolMeta: Readonly<Record<string, ToolProviderToolMeta | undefined>>,
    connection: ConnectionResolver,
  ): Promise<Record<string, MastraTool>> {
    if (slugs.length === 0) return {};
    const byToolkit = new Map<string, true>();
    for (const slug of slugs) byToolkit.set(toolMeta[slug]?.toolkit ?? toolkitOf(slug), true);
    const catalogs = await mapLimit([...byToolkit.keys()], CATALOG_CONCURRENCY, (tk) => this.connector.catalog.actions(tk));
    const actions = new Map(catalogs.flat().map((a) => [a.id, a] as const));
    const tools: Record<string, MastraTool> = {};
    for (const slug of slugs) {
      const action = actions.get(slug);
      // A slug the catalog no longer has is skipped, matching how Mastra's bundled providers behave.
      if (action) tools[slug] = this.#toTool(action, toolMeta[slug]?.description, connection);
    }
    return tools;
  }

  #toTool(action: ActionLike, descriptionOverride: string | undefined, connection: ConnectionResolver): MastraTool {
    const slug = action.id;
    const tool: MastraTool = {
      id: slug,
      description: descriptionOverride ?? action.description ?? "",
      inputSchema: asSchema(action.inputSchema),
      execute: async (input, context) =>
        this.connector.execute(slug, input, { connectionName: await connection(), signal: context?.abortSignal }),
    };
    if (this.#validateOutput) tool.outputSchema = asSchema(action.outputSchema);
    return tool;
  }

  // --- authorization ---

  /**
   * Start an OAuth authorization for a toolkit and hand Mastra the URL to open plus the handle to
   * poll. Nothing is stored until the user finishes in the browser and the callback lands.
   *
   * `opts.connectionId` is deliberately ignored. The backend mints the connection, and its id, only
   * once the callback completes, and it accepts no caller-supplied id at flow start. That is
   * exactly what `capabilities.reauthorizeReusesConnectionId: false` declares, so Mastra learns the
   * real id afterwards from `listConnections`. `opts.toolName` is ignored too: OOMOL authorizes a
   * whole service, never a single action.
   *
   * `opts.config` is forwarded as the backend's per-attempt `extra` (its connect-only OAuth
   * client-config overrides). In practice it arrives empty, because `listConnectionFields` is
   * absent and so the picker collects nothing.
   *
   * One consequence of the id only existing afterwards: Mastra keys the label/scope row it writes
   * here on the returned `authId`, then joins it back by the connection id `listConnections`
   * reports. Those differ for us, so a label typed at authorize time does not survive. Pins,
   * execution and status all work regardless — set the label on the connection afterwards.
   */
  async authorize(opts: AuthorizeOpts): Promise<{ url: string; authId: string }> {
    const input: { returnUri?: string; extra?: Record<string, unknown> } = {};
    if (this.#authorizeReturnUri !== undefined) input.returnUri = this.#authorizeReturnUri;
    if (opts.config !== undefined) input.extra = opts.config;
    const start = await this.connector.connect.oauth(opts.toolkit, input);
    return { url: start.authorizationUrl, authId: start.connectionRequestId };
  }

  /**
   * Poll one authorization by the `authId` {@link authorize} returned.
   *
   * A handle the backend no longer knows reads as `failed`, not as an error: attempts stay readable
   * for 24h past expiry, so a 404 means the flow is long over, and answering `pending` would leave
   * the editor polling something that can never settle.
   *
   * `completed` is safe to act on immediately. Mastra refetches {@link listConnections} the moment
   * it sees that status, and the backend writes the connection row and flips the attempt in ONE
   * transaction, so the new connection is already listed and `active` by the time we say so.
   */
  async getAuthStatus(authId: string): Promise<AuthFlowStatus> {
    try {
      return toAuthFlowStatus((await this.connector.connect.getAttempt(authId)).status);
    } catch (err) {
      if (isNotFound(err)) return "failed";
      throw err;
    }
  }

  // --- connections ---

  /**
   * Existing connections for a toolkit (`apps.list()` filtered by service). The account is
   * personal, so `userId` / `userIds` are ignored — every caller sees the same connections.
   */
  async listConnections(opts: ListConnectionsOpts): Promise<ListConnectionsResult> {
    const perPage = Math.min(opts.perPage ?? CONNECTIONS_DEFAULT_PER_PAGE, CONNECTIONS_MAX_PER_PAGE);
    const apps = await this.connector.apps.list();
    const items = apps.filter((a) => a.service === opts.toolkit).map(toExistingConnection);
    const { data, pagination } = paginate(items, opts.page, perPage);
    return { items: data, pagination };
  }

  /** One `apps.list()` answers every tuple: connected ⇔ found, same toolkit, status active. */
  async getConnectionStatus(opts: {
    items: Array<{ connectionId: string; toolkit: string }>;
  }): Promise<Record<string, { connected: boolean }>> {
    if (opts.items.length === 0) return {};
    const apps = await this.connector.apps.list();
    const byId = new Map(apps.map((a) => [a.id, a] as const));
    const result: Record<string, { connected: boolean }> = {};
    for (const { connectionId, toolkit } of opts.items) {
      const app = byId.get(connectionId);
      result[connectionId] = {
        connected: app !== undefined && app.service === toolkit && toConnectionStatus(app.status) === "active",
      };
    }
    return result;
  }
}

function toExistingConnection(app: ConnectedApp): ListConnectionsResult["items"][number] {
  const item: ListConnectionsResult["items"][number] = { connectionId: app.id, status: toConnectionStatus(app.status) };
  const createdAt = toIsoTimestamp(app.createdAt);
  if (createdAt !== undefined) item.createdAt = createdAt;
  return item;
}

/**
 * The hosted gateway reports `createdAt` as epoch milliseconds, the self-hosted runtime omits it;
 * Mastra wants an ISO string. Anything unparsable is dropped rather than passed through.
 */
function toIsoTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return undefined;
}
