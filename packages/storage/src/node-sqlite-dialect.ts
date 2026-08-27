import { DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  CompiledQuery,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type QueryCompiler,
  type QueryResult,
  type TransactionSettings,
} from 'kysely';

/**
 * Kysely dialect over Node's built-in `node:sqlite`.
 *
 * Written rather than taken off the shelf because the alternative --
 * better-sqlite3 -- is a native addon, and `npm install -g paybox` (spec §38)
 * with a native addon means node-gyp fallbacks on any machine without a
 * matching prebuild. That is the single most common "your tool won't install"
 * report for CLI tools, and it is entirely avoidable: node:sqlite has shipped
 * since Node 22.5 and needs no compiler.
 *
 * node:sqlite is synchronous, so every method here resolves immediately. That
 * is fine -- it is an embedded database on the same machine -- but it does mean
 * one connection serves everything, hence the mutex in the driver.
 */

export interface NodeSqliteDialectConfig {
  /** File path, or ':memory:' for tests. */
  database: string;
  onCreateConnection?: (db: DatabaseSync) => void;
}

class NodeSqliteConnection implements DatabaseConnection {
  readonly #db: DatabaseSync;
  readonly #cache = new Map<string, StatementSync>();

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  #prepare(sql: string): StatementSync {
    let statement = this.#cache.get(sql);
    if (!statement) {
      statement = this.#db.prepare(sql);
      this.#cache.set(sql, statement);
    }
    return statement;
  }

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const statement = this.#prepare(compiled.sql);
    const parameters = compiled.parameters.map(toSqliteValue);

    // `readsData` is not exposed, so decide by statement shape. SELECT and
    // anything with RETURNING produce rows; everything else reports counts.
    if (returnsRows(compiled.sql)) {
      const rows = statement.all(...parameters) as R[];
      // node:sqlite returns null-prototype objects; Kysely and JSON.stringify
      // both cope, but spreading them elsewhere is friendlier with a real
      // prototype, so normalise here once.
      return { rows: rows.map((row) => ({ ...row })) as R[] };
    }

    const result = statement.run(...parameters);
    return {
      rows: [],
      numAffectedRows: BigInt(result.changes),
      insertId: BigInt(result.lastInsertRowid),
    };
  }

  async *streamQuery<R>(compiled: CompiledQuery): AsyncIterableIterator<QueryResult<R>> {
    // node:sqlite has no incremental cursor API; the datasets here are local
    // and small, so materialise and yield once.
    yield await this.executeQuery<R>(compiled);
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  close(): void {
    this.#cache.clear();
    this.#db.close();
  }
}

class NodeSqliteDriver implements Driver {
  readonly #config: NodeSqliteDialectConfig;
  #connection: NodeSqliteConnection | null = null;
  /** SQLite gives us one writer; hand the connection out to one caller at a
   *  time so Kysely transactions cannot interleave with ambient queries. */
  #queue: Promise<void> = Promise.resolve();

  constructor(config: NodeSqliteDialectConfig) {
    this.#config = config;
  }

  async init(): Promise<void> {
    const db = new DatabaseSync(this.#config.database);
    // WAL for concurrent readers; NORMAL is the right durability trade for a
    // local emulator. FK enforcement is on so a bad cascade fails loudly.
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
    this.#config.onCreateConnection?.(db);
    this.#connection = new NodeSqliteConnection(db);
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.#queue;
    this.#queue = previous.then(() => gate);
    await previous;
    this.#releaseCurrent = release;
    if (!this.#connection) throw new Error('NodeSqliteDriver used before init().');
    return this.#connection;
  }

  #releaseCurrent: (() => void) | null = null;

  async releaseConnection(): Promise<void> {
    const release = this.#releaseCurrent;
    this.#releaseCurrent = null;
    release?.();
  }

  async beginTransaction(
    connection: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    // BEGIN IMMEDIATE takes the write lock up front. With deferred begins,
    // SQLite only takes it on first write and can then fail with SQLITE_BUSY
    // mid-transaction -- which here would mean a half-applied state change.
    const sql = settings.isolationLevel === 'serializable' ? 'BEGIN EXCLUSIVE' : 'BEGIN IMMEDIATE';
    await connection.executeQuery(CompiledQuery.raw(sql));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('COMMIT'));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('ROLLBACK'));
  }

  async destroy(): Promise<void> {
    this.#connection?.close();
    this.#connection = null;
  }
}

export class NodeSqliteDialect implements Dialect {
  readonly #config: NodeSqliteDialectConfig;

  constructor(config: NodeSqliteDialectConfig) {
    this.#config = config;
  }

  createDriver(): Driver {
    return new NodeSqliteDriver(this.#config);
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}

const ROW_RETURNING = /^\s*(select|pragma|with)\b|returning\b/i;

function returnsRows(sql: string): boolean {
  return ROW_RETURNING.test(sql);
}

/**
 * node:sqlite accepts null | number | bigint | string | Uint8Array only.
 * Booleans and undefined are the two things application code produces by
 * accident, so normalise both rather than surfacing a cryptic bind error.
 */
function toSqliteValue(value: unknown): null | number | bigint | string | Uint8Array {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'string' ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  return JSON.stringify(value);
}
