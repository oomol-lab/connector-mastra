/**
 * Small pure helpers shared by the providers. Kept dependency-free and individually testable.
 */

import type { AuthFlowStatus, ExistingConnection } from "@mastra/core/tool-provider";

/**
 * Match `slug` against an allowlist: exact entry, or a `prefix*` wildcard. Mirrors the matcher
 * Mastra's `BaseToolProvider` uses, so allowlists behave identically across providers.
 */
export function matchesAny(slug: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === slug) return true;
    if (pattern.endsWith("*") && slug.startsWith(pattern.slice(0, -1))) return true;
  }
  return false;
}

/** The toolkit (OOMOL service) a tool slug belongs to: everything before the first `.`. */
export function toolkitOf(slug: string): string {
  const i = slug.indexOf(".");
  return i > 0 ? slug.slice(0, i) : slug;
}

/** One page of an in-memory list. `perPage` undefined ⇒ everything, `hasMore: false`. */
export function paginate<T>(
  items: readonly T[],
  page: number | undefined,
  perPage: number | undefined,
): { data: T[]; pagination: { page: number; perPage?: number; hasMore: boolean } } {
  const p = Math.max(1, Math.floor(page ?? 1));
  if (perPage === undefined) return { data: [...items], pagination: { page: p, hasMore: false } };
  const size = Math.max(1, Math.floor(perPage));
  const start = (p - 1) * size;
  return {
    data: items.slice(start, start + size),
    pagination: { page: p, perPage: size, hasMore: start + size < items.length },
  };
}

const ACTIVE = new Set(["active", "connected"]);
const PENDING = new Set(["pending", "initiated", "initializing"]);
const FAILED = new Set(["failed", "error", "expired", "revoked", "reauth_required", "invalid"]);

/**
 * Map a connection status as the gateway / runtime reports it onto Mastra's four states. A missing
 * status counts as active (a listed connection is usable); an unknown word is `inactive` so it is
 * never pinned by mistake.
 */
export function toConnectionStatus(status: unknown): ExistingConnection["status"] {
  if (status === undefined || status === null) return "active";
  if (typeof status !== "string") return "inactive";
  const s = status.toLowerCase();
  if (ACTIVE.has(s)) return "active";
  if (PENDING.has(s)) return "pending";
  if (FAILED.has(s)) return "failed";
  return "inactive";
}

const AUTH_PENDING = new Set(["initiated", "pending"]);
const AUTH_COMPLETED = new Set(["connected", "completed"]);

/**
 * Map an OOMOL authorization-attempt status onto Mastra's three-state auth flow.
 *
 * Everything that is neither pending nor connected is `failed`, `expired` included: the user never
 * finished, and Mastra has no fourth state to say so. Unknown status words fail rather than stay
 * pending, because a poller told `pending` about an attempt that will never settle spins until the
 * editor gives up, which is a worse outcome than an honest failure.
 */
export function toAuthFlowStatus(status: unknown): AuthFlowStatus {
  if (typeof status !== "string") return "failed";
  const s = status.toLowerCase();
  if (AUTH_COMPLETED.has(s)) return "completed";
  if (AUTH_PENDING.has(s)) return "pending";
  return "failed";
}

/** `Promise.all` with at most `limit` tasks in flight; results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Memoize an async lookup, caching only success: a failed attempt is retried on the next call,
 * so a connection that appears later is picked up without re-resolving the tools.
 */
export function memoizeAsync<T>(fn: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => {
    cached ??= fn().catch((err: unknown) => {
      cached = undefined;
      throw err;
    });
    return cached;
  };
}

/** Duck-typed "the gateway said 404" check — works across duplicate copies of the SDK. */
export function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "ConnectorError" &&
    (err as { status?: unknown }).status === 404
  );
}
