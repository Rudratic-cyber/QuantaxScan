import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * Build a `CHECK (column IN (...))` expression from a const tuple of allowed
 * values. Deliberately a `text` + `CHECK` rather than a Postgres `ENUM`
 * type: narrowing an enum type requires recreating it, while narrowing a
 * `CHECK` derived from the same const tuple is a one-line diff — see
 * `@workspace/collectors`'s `enums.ts`, the single source of truth these
 * values are always imported from.
 */
export function oneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  // A CHECK constraint is DDL: its expression must be constant SQL, not a
  // runtime bind parameter. `sql\`${v}\`` for a plain string produces a `$n`
  // placeholder, which is invalid inside `CREATE TABLE ... CHECK (...)` —
  // there is nothing to bind it against. Inline each value as an escaped
  // SQL string literal instead.
  const literal = values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
  return sql`${column} in (${sql.raw(literal)})`;
}

/**
 * Build a `CHECK (column IS NULL OR column >= min)` expression.
 *
 * Same trap as `oneOf()`, and it catches numbers too: `sql\`${0}\`` produces a
 * `$n` bind parameter, which is invalid in DDL. The bound is inlined with
 * `sql.raw()` over a validated integer.
 *
 * NULL passes on purpose. A `CHECK` is satisfied by NULL, and every column this
 * is used on is nullable *because* null means "not supplied" — see
 * `src/classification.ts`.
 */
export function nullableAtLeast(column: AnyPgColumn, min: number): SQL {
  if (!Number.isInteger(min)) throw new Error(`nullableAtLeast needs an integer bound, got ${String(min)}`);
  return sql`${column} is null or ${column} >= ${sql.raw(String(min))}`;
}
