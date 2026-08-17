import { describe, it, expect } from "vitest";
import type { Request } from "express";
import buildCacheKey from "./cacheKey.js";

function fakeReq(overrides: Partial<Request> = {}): Request {
  return {
    method: "GET",
    originalUrl: "/api/v1/users/getAll",
    headers: {},
    ...overrides,
  } as Request;
}

describe("buildCacheKey", () => {
  it("includes method and URL", () => {
    const key = buildCacheKey(fakeReq({ method: "POST", originalUrl: "/api/v1/users/register" }));
    expect(key).toBe("cache:anon:POST:/api/v1/users/register");
  });

  it("uses anon bucket when not authenticated", () => {
    expect(buildCacheKey(fakeReq())).toBe("cache:anon:GET:/api/v1/users/getAll");
  });

  it("scopes by user id when authenticated", () => {
    const req = fakeReq({ headers: { "x-user-id": "u123" } });
    expect(buildCacheKey(req)).toBe("cache:u123:GET:/api/v1/users/getAll");
  });

  it("produces distinct keys for two different users", () => {
    const a = buildCacheKey(fakeReq({ headers: { "x-user-id": "alice" } }));
    const b = buildCacheKey(fakeReq({ headers: { "x-user-id": "bob" } }));
    expect(a).not.toBe(b);
  });

  it("keeps query strings in the key", () => {
    const req = fakeReq({ originalUrl: "/api/v1/users/getAll?limit=5" });
    expect(buildCacheKey(req)).toBe("cache:anon:GET:/api/v1/users/getAll?limit=5");
  });
});