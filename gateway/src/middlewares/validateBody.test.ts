import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import validateBody from "./validateBody.js";
import type { NextFunction, Request, Response } from "express";

const schema = z.object({
  userId: z.string(),
  email: z.email(),
});

function makeStubs(path = "/register") {
  const req = { path, body: {} } as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next };
}

describe("validateBody", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls next() and passes parsed data for a valid body", async () => {
    const { req, res, next } = makeStubs();
    req.body = { userId: "u1", email: "u1@demo.com" };

    await validateBody({ "/register": schema })(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.json).not.toHaveBeenCalled();
    expect(req.body).toEqual({ userId: "u1", email: "u1@demo.com" });
  });

  it("returns 400 for an invalid body", async () => {
    const { req, res, next } = makeStubs();
    req.body = { userId: "u1", email: "not-an-email" };

    await validateBody({ "/register": schema })(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, status: 400 }),
    );
  });

  it("passes through when no schema is registered for the route", async () => {
    const { req, res, next } = makeStubs();
    req.body = { anything: "goes" };

    await validateBody({})(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("accepts a valid login body", async () => {
    const { req, res, next } = makeStubs("/login");
    req.body = { email: "u1@demo.com", password: "hunter2" };
    const loginSchema = z.object({ email: z.email(), password: z.string() });

    await validateBody({ "/login": loginSchema })(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.json).not.toHaveBeenCalled();
  });

  it("rejects a login body with a missing password", async () => {
    const { req, res, next } = makeStubs("/login");
    req.body = { email: "u1@demo.com" };
    const loginSchema = z.object({ email: z.email(), password: z.string() });

    await validateBody({ "/login": loginSchema })(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, status: 400 }),
    );
  });
});