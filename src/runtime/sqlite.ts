// Read-only SQLite, for the opencode importer: bun:sqlite on Bun, node:sqlite on Node. node:sqlite is
// built into Node from 22.13 (22.5 behind --experimental-sqlite); on an older Node, opening a database
// fails with a message that says so, and nothing else in prefixlens needs it.

export interface ReadonlyDatabase {
  /** Every row of a query, as plain objects keyed by column name. */
  all<Row>(sql: string, ...params: (string | number)[]): Row[]
  close(): void
}

export const SQLITE_MINIMUM_NODE = "22.13.0"

export async function openReadonly(file: string): Promise<ReadonlyDatabase> {
  if ((globalThis as { Bun?: unknown }).Bun) {
    const { Database } = await import("bun:sqlite")
    const db = new Database(file, { readonly: true })
    return { all: <Row>(sql: string, ...params: (string | number)[]) => db.query(sql).all(...params) as Row[], close: () => db.close() }
  }
  const sqlite = await import("node:sqlite").catch(() => undefined)
  if (!sqlite?.DatabaseSync)
    throw new Error(`reading an opencode database needs SQLite, built into Node ${SQLITE_MINIMUM_NODE} and later (or Bun); this is Node ${process.versions.node}`)
  const db = new sqlite.DatabaseSync(file, { readOnly: true })
  return { all: <Row>(sql: string, ...params: (string | number)[]) => db.prepare(sql).all(...params) as Row[], close: () => db.close() }
}
