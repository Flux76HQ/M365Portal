// The database of the server (FR-A-060 to FR-A-066): the connection, the Phase A schema, the
// transaction wrapper and the mapping of SQLite failures. Import from here; the files behind it are
// one concern each. The migration wrapper and the backup (`migrate.ts`, `backup.ts`) are imported
// directly by the start path: nothing else may run migrations.
export * from './errors.js';
export * from './open.js';
export * from './schema.js';
export * from './tx.js';
