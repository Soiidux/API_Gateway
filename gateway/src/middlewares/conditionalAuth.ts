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
      const token = getBearerToken(req);
      if (!token) {
        const responsePayload: ApiResponse<null> = generateApiResponse<null>(null, "Unauthorized", 401);
        return res.status(responsePayload.status).json(responsePayload);
      }

      //Decode the token
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