// drizzle-kit configuration (FR-A-061, FR-A-062). The migrations in `drizzle/` are generated from
// `src/db/schema.ts` with `drizzle-kit generate --name <slug>`, reviewed, and then never edited
// (data-model 8.1). `pnpm schema:snapshot` and `pnpm schema:check` (scripts/) own everything else.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  // Migration files are SQL with `--> statement-breakpoint` between statements, which is what the
  // runtime migrator splits on; a trigger body contains semicolons and must stay one statement.
  breakpoints: true,
  // Print the SQL and ask before anything destructive: a data-losing change is decided by a person.
  verbose: true,
  strict: true,
});
