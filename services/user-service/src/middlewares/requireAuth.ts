import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import config from "../config.js";

/**
 * Service-level JWT verification (defense in depth for /getAll).
 *
 * The gateway (conditionalAuth) already checks the token and forwards
 * x-user-id / x-user-role headers. But headers from a proxy are NOT
 * something a service should blindly trust — any attacker can forge
 * them if they reach the service directly (e.g. hitting the instance
 * port inside the docker network). So /getAll ALSO requires a valid
 * Bearer token, verified with the same JWT_SECRET.
 *
 * Attaches the verified payload to `req.auth` for role checks.
 */
export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  const header = req.headers["authorization"];

  const unauthorized = (message: string) => {
    const payload = { success: false, message, status: 401, data: null };
    return res.status(401).json(payload);
  };

  if (!header) return unauthorized("Unauthorized");
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;

  try {
    const decoded = jwt.verify(token, config.JWT_SECRET) as { userId: string; role: string };
    req.auth = decoded;
    return next();
  } catch {
    return unauthorized("Unauthorized");
  }
};