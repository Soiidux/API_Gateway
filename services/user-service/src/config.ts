/**
 * All environment-dependent values for the user-service.
 *
 * Defaults point at localhost for laptop dev (matching the compose
 * credentials); Docker overrides them via the container's environment
 * (see docker-compose.yml).
 */
import "dotenv/config";

const config = {
  PORT: parseInt(process.env.PORT || "3001", 10),
  INSTANCE_ID: process.env.INSTANCE_ID || "0",
  JWT_SECRET: process.env.JWT_SECRET || "gateway_secret_is_super_secure",
  DATABASE_URL:
    process.env.DATABASE_URL ?? "postgres://gateway_user:gateway_secure_password@localhost:5432/gateway_db",

  /**
   * Token lifetime, in seconds. Also drives the revocation record's TTL.
   *
   * WHY THIS IS SHORT (1 hour, down from 7 days): a JWT is self-contained —
   * nobody consults server state to decide whether it's valid, which is what
   * makes it fast and what also makes it unrevocable. A stolen token is
   * therefore worth whatever remains of its lifetime, and that's the real
   * exposure number.
   *
   * The deny-list closes the "user logs out" case, but it cannot help against
   * a token that leaks and whose owner never notices. That case is bounded
   * only by this number, so it should be the smallest value that doesn't make
   * the product annoying. One hour is that tradeoff for an admin tool: a leak
   * is worth at most an hour, and a session lasts a working morning.
   *
   * Read it in one place and used in two (token minting and the revocation
   * TTL) so they can't drift apart — a deny-list record that outlives the
   * tokens it protects is wasted memory, and one that expires sooner leaves
   * revoked tokens unrevoked.
   */
  TOKEN_TTL: parseInt(process.env.TOKEN_TTL || "3600", 10),

  // Revocation store. Read on every authenticated request by the gateway, and
  // written on logout here.
  REDIS_URL: process.env.REDIS_URL || "redis://localhost:6379",
};

export default config;