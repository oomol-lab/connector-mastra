import { describe, expect, it } from "vitest";
import {
  isNotFound,
  mapLimit,
  matchesAny,
  memoizeAsync,
  paginate,
  toAuthFlowStatus,
  toConnectionStatus,
  toolkitOf,
} from "../src/internal";

describe("matchesAny", () => {
  it("matches an exact slug", () => {
    expect(matchesAny("gmail", ["slack", "gmail"])).toBe(true);
    expect(matchesAny("gmail", ["slack"])).toBe(false);
  });

  it("matches a prefix wildcard, and only a trailing one", () => {
    expect(matchesAny("google_calendar", ["google*"])).toBe(true);
    expect(matchesAny("gmail.search_threads", ["gmail.search_*"])).toBe(true);
    expect(matchesAny("gmail.send_email", ["gmail.search_*"])).toBe(false);
    expect(matchesAny("anything", ["*"])).toBe(true);
    expect(matchesAny("gmail", [])).toBe(false);
  });
});

describe("toolkitOf", () => {
  it("takes everything before the first dot", () => {
    expect(toolkitOf("gmail.search_threads")).toBe("gmail");
    expect(toolkitOf("a.b.c")).toBe("a");
  });

  it("returns the slug itself when there is no dot or it leads", () => {
    expect(toolkitOf("gmail")).toBe("gmail");
    expect(toolkitOf(".weird")).toBe(".weird");
  });
});

describe("paginate", () => {
  const items = ["a", "b", "c", "d", "e"];

  it("returns everything with hasMore=false when perPage is undefined", () => {
    expect(paginate(items, undefined, undefined)).toEqual({ data: items, pagination: { page: 1, hasMore: false } });
    expect(paginate(items, 3, undefined).pagination).toEqual({ page: 3, hasMore: false });
  });

  it("slices pages and reports hasMore accurately", () => {
    expect(paginate(items, 1, 2)).toEqual({ data: ["a", "b"], pagination: { page: 1, perPage: 2, hasMore: true } });
    expect(paginate(items, 3, 2)).toEqual({ data: ["e"], pagination: { page: 3, perPage: 2, hasMore: false } });
    expect(paginate(items, 4, 2)).toEqual({ data: [], pagination: { page: 4, perPage: 2, hasMore: false } });
    expect(paginate(items, 1, 5).pagination.hasMore).toBe(false);
  });

  it("normalizes a bad page / perPage instead of slicing negatively", () => {
    expect(paginate(items, 0, 2)).toEqual({ data: ["a", "b"], pagination: { page: 1, perPage: 2, hasMore: true } });
    expect(paginate(items, -3, 2).pagination.page).toBe(1);
    expect(paginate(items, 1.7, 0)).toEqual({ data: ["a"], pagination: { page: 1, perPage: 1, hasMore: true } });
    expect(paginate([], 1, 10)).toEqual({ data: [], pagination: { page: 1, perPage: 10, hasMore: false } });
  });
});

describe("toConnectionStatus", () => {
  it("treats a missing status as active (a listed connection is usable)", () => {
    expect(toConnectionStatus(undefined)).toBe("active");
    expect(toConnectionStatus(null)).toBe("active");
  });

  it("maps the known vocabulary case-insensitively", () => {
    expect(toConnectionStatus("active")).toBe("active");
    expect(toConnectionStatus("CONNECTED")).toBe("active");
    expect(toConnectionStatus("pending")).toBe("pending");
    expect(toConnectionStatus("initiated")).toBe("pending");
    expect(toConnectionStatus("reauth_required")).toBe("failed");
    expect(toConnectionStatus("error")).toBe("failed");
    expect(toConnectionStatus("expired")).toBe("failed");
  });

  it("never pins an unknown or non-string status", () => {
    expect(toConnectionStatus("paused")).toBe("inactive");
    expect(toConnectionStatus(42)).toBe("inactive");
    expect(toConnectionStatus({})).toBe("inactive");
  });
});

describe("mapLimit", () => {
  it("keeps input order and caps concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const result = await mapLimit([30, 10, 20, 5], 2, async (ms) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, ms));
      inFlight--;
      return ms * 2;
    });
    expect(result).toEqual([60, 20, 40, 10]);
    expect(peak).toBe(2);
  });

  it("handles an empty list and a limit above the item count", async () => {
    expect(await mapLimit([], 4, async (x: number) => x)).toEqual([]);
    expect(await mapLimit([1], 8, async (x) => x + 1)).toEqual([2]);
  });

  it("propagates a rejection", async () => {
    await expect(mapLimit([1, 2], 2, async (x) => {
      if (x === 2) throw new Error("boom");
      return x;
    })).rejects.toThrow("boom");
  });
});

describe("memoizeAsync", () => {
  it("caches a successful result", async () => {
    let n = 0;
    const get = memoizeAsync(async () => ++n);
    expect(await get()).toBe(1);
    expect(await get()).toBe(1);
    expect(n).toBe(1);
  });

  it("retries after a failure instead of caching the rejection", async () => {
    let n = 0;
    const get = memoizeAsync(async () => {
      n++;
      if (n === 1) throw new Error("first");
      return n;
    });
    await expect(get()).rejects.toThrow("first");
    expect(await get()).toBe(2);
    expect(await get()).toBe(2);
    expect(n).toBe(2);
  });
});

describe("isNotFound", () => {
  it("recognizes a ConnectorError-shaped 404 by duck typing", () => {
    expect(isNotFound({ name: "ConnectorError", status: 404 })).toBe(true);
    expect(isNotFound({ name: "ConnectorError", status: 500 })).toBe(false);
    expect(isNotFound({ name: "TypeError", status: 404 })).toBe(false);
    expect(isNotFound(null)).toBe(false);
    expect(isNotFound("nope")).toBe(false);
  });
});

describe("toAuthFlowStatus", () => {
  it("maps the backend's attempt statuses onto Mastra's three states", () => {
    expect(toAuthFlowStatus("initiated")).toBe("pending");
    expect(toAuthFlowStatus("connected")).toBe("completed");
    expect(toAuthFlowStatus("failed")).toBe("failed");
    // No fourth state for "the window closed before the user finished".
    expect(toAuthFlowStatus("expired")).toBe("failed");
  });

  it("is case-insensitive", () => {
    expect(toAuthFlowStatus("CONNECTED")).toBe("completed");
    expect(toAuthFlowStatus("Initiated")).toBe("pending");
  });

  it("fails closed on anything that is not a known status word", () => {
    // Reporting `pending` here would leave the editor polling an attempt that can never settle.
    expect(toAuthFlowStatus("something_new")).toBe("failed");
    expect(toAuthFlowStatus(undefined)).toBe("failed");
    expect(toAuthFlowStatus(null)).toBe("failed");
    expect(toAuthFlowStatus(42)).toBe("failed");
  });
});
