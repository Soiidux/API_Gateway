/**
 * Drizzle table definitions for the payment-service.
 *
 * Two tables owned by this service:
 *   - accounts:  one row per user, holding their current balance. Auto-created
 *                on the first deposit (on-conflict upsert), never pre-seeded.
 *   - transactions: append-only ledger of DEPOSIT/WITHDRAW events. The balance
 *                is derived by re-applying these, but we store it on accounts
 *                so reads are O(1) rather than a sum per request.
 *
 * Additionally this service VERIFIES a customer exists against
 * user-service's `users` table (same physical gateway_db), but it uses a
 * raw SQL check for that (see controllers) rather than a Drizzle schema
 * mirror — so the migration generated here NEVER touches users, which
 * user-service owns.
 *
 * Whenever this file changes you must run `npm run db:generate` to
 * produce a new versioned migration in drizzle/ (see drizzle.config.ts).
 */
import { index, pgTable, text, timestamp, uuid, numeric } from "drizzle-orm/pg-core";

export const accounts = pgTable("accounts", {
  userId: text("user_id").primaryKey(),
  balance: numeric("balance", { precision: 10, scale: 2 }).notNull().default("0"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// The composite index on (user_id, created_at) is what makes /my's
// paginated history cheap. Without it, every call sorted this user's ENTIRE
// transaction list to return the newest 50 rows — work that grows forever as
// the ledger does. Postgres can use a composite btree for `WHERE user_id = ?
// ORDER BY created_at DESC LIMIT 50` without a separate sort step.
export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    type: text("type").notNull(), // "DEPOSIT" | "WITHDRAW"
    amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("transactions_user_created_idx").on(t.userId, t.createdAt),
  ],
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;

/** Table list for the Drizzle client (keeps schema reference typed). */
export const schema = { accounts, transactions } as const;