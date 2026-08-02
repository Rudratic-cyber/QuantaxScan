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
