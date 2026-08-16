/**
 * Augments Express's Request type with the payload attached by
 * requireAuth middleware (src/middlewares/requireAuth.ts).
 */
declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string; role: string };
    }
  }
}

export {};