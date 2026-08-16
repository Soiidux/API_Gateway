/**
 * Drizzle table definition for the user-service.
 *
 * Stores real registered users. Passwords are stored ONLY as a bcrypt
 * hash (`password_hash`), never as plaintext. `id` and `email` have
 * unique constraints so a duplicate registration can be rejected with
 * 409.
 *
 * Whenever this file changes you must run `npm run db:generate` to
 * produce a new versioned migration in drizzle/ (see drizzle.config.ts).
 */
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

/** Table list for the Drizzle client (keeps schema reference typed). */
export const schema = { users } as const;