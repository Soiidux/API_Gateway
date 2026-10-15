/**
 * Drizzle table definition for the user-service.
 *
 * Stores real registered users. Passwords are stored ONLY as a bcrypt
 * hash (`password_hash`), never as plaintext. `id` and `email` have
 * unique constraints so a duplicate registration can be rejected with
 * 409.
 *
 * EMAIL UNIQUENESS IS CASE-INSENSITIVE (deliberate). A plain UNIQUE on
 * `text` is case-SENSITIVE in Postgres, so `Alice@x.com` and `alice@x.com`
 * would happily become two separate accounts for one human — and worse, both
 * would pass login, splitting one person's identity in half.
 *
 * The fix is a UNIQUE index over LOWER(email), which expresses the real rule:
 * "one account per email address, whatever case it was typed in". It has to be
 * an index rather than normalising on write (storing a lowercased copy)
 * because normalisation on write only helps if every reader also compares the
 * normalised form; the expression index enforces it in the database, where
 * nothing can bypass it.
 *
 * Registered via the extra config callback (Drizzle's array form) because a
 * `uniqueIndex` has no column-level equivalent on `text`. The raw `unique()`
 * on the column is kept as well — belt and braces, and it preserves the
 * simpler constraint name in error messages.
 *
 * NOTE: `email` is still stored with its original casing so the address is
 * displayed back to the user exactly as they typed it. Only the *comparison*
 * is case-insensitive.
 *
 * Whenever this file changes you must run `npm run db:generate` to
 * produce a new versioned migration in drizzle/ (see drizzle.config.ts).
 */
import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    name: text("name"),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One account per email regardless of case. `email` is NOT NULL, so the
    // IS NOT NULL predicate is unnecessary; a plain expression index on
    // LOWER(email) is the whole requirement.
    uniqueIndex("users_email_lower_uidx").on(sql`LOWER(${t.email})`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

/** Table list for the Drizzle client (keeps schema reference typed). */
export const schema = { users } as const;