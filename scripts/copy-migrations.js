/*
 * Copies the .sql migrations into dist/.
 *
 * tsc only emits what it compiles, so the migration files — the one part of
 * the build that is not TypeScript — are otherwise missing from the artifact
 * and `npm run migrate:prod` finds an empty directory and reports "no pending
 * migrations" against a database with no tables. Silent, and discovered on the
 * first request after a deploy.
 */
const { cpSync, existsSync, mkdirSync } = require("node:fs");
const path = require("node:path");

const from = path.join(__dirname, "..", "src", "db", "migrations");
const to = path.join(__dirname, "..", "dist", "db", "migrations");

if (!existsSync(from)) {
  console.error(`No migrations directory at ${from}`);
  process.exit(1);
}

mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true, filter: (src) => !src.endsWith(".ts") });
console.log(`Copied migrations to ${path.relative(process.cwd(), to)}`);
