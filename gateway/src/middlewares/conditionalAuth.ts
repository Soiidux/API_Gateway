/**
 * conditionalAuth — JWT + RBAC gate for proxied routes.
 *
 * Runs for every request on a service path and does one of three things:
 *   1. Allows it through untouched if it matches a public route
 *      (e.g. `/register`), or
 *   2. Requires a valid `Authorization: Bearer <token>` signed with
 *      JWT_SECRET, then checks the decoded role against the route's
 *      `roleMap` entry, or — for non-roleMap routes — the service's
 *      `defaultRoles`, or
 *   3. Rejects with 401/403 via generateApiResponse.
 *
 * The verified identity is attached to the request as headers
 * (`x-user-id`, `x-user-role`) and forwarded to the backend service,
 * which re-verifies the JWT itself (auth is enforced at both hops).
 *
 * IMPORTANT GOTCHA: an empty `defaultRoles: []` is NOT "public" — it is
 * "forbidden for everyone", because `[].includes(role)` is always false.
 * Services that should be reachable by any logged-in user must list the
 * roles explicitly (see the payment service's proxy config).
 */

import type { Request, Response, NextFunction } from "express";
import config from "../config.js";
import { getBearerToken } from "../utils/getBearerToken.js";
import generateApiResponse from "../utils/generateApiResponse.js";
import jwt from "jsonwebtoken";


const conditionalAuth = (publicRoutes: string[] = [], roleMap: Record<string, string[]> = {}, defaultRoles: string[] = []) => {
  return (req: Request, res: Response, next: NextFunction) => {

    // Check if the request path is a public route
    if (publicRoutes.some(r => req.path === r || req.path.startsWith(`${r}/`))) {
      return next();
    }

    try {
      //Check if token is present 
      //Check if token is present
      const token = getBearerToken(req);
      if (!token) {
        const responsePayload: ApiResponse<null> = generateApiResponse<null>(null, "Unauthorized", 401);
        return res.status(responsePayload.status).json(responsePayload);
      }

      //Decode the token (throws on missing/expired/bad-signature -> caught below as 401)
      const decoded : { userId: string, role: string } = jwt.verify(token, config.JWT_SECRET) as { userId: string, role: string };

      //Check if the user has the required role
      // 1. Scan the roleMap keys to see if the incoming route matches or starts with a protected path
      const matchingRuleKey = Object.keys(roleMap).find(routeKey => {
              return req.path === routeKey || req.path.startsWith(`${routeKey}/`);
            });
      const requiredRoles = matchingRuleKey ? roleMap[matchingRuleKey] : defaultRoles;
      if (requiredRoles && !requiredRoles.includes(decoded.role)) {
        const responsePayload: ApiResponse<null> = generateApiResponse<null>(null, "Forbidden", 403);
        return res.status(responsePayload.status).json(responsePayload);
      }

      //Attach the userId and role as header
      req.headers["x-user-id"] = decoded.userId;
      req.headers["x-user-role"] = decoded.role;

      next();
      
    } catch (error) {
      console.error(error);
      const responsePayload: ApiResponse<null> = generateApiResponse<null>(null, "Unauthorized", 401);
      return res.status(responsePayload.status).json(responsePayload);
    }
  };
}

export default conditionalAuth;