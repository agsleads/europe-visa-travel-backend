/**
 * Loaded before any test file. Runs before `src/config/env` is imported, so
 * the schema sees a complete environment and no test needs a real .env.
 */
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.API_KEY ??= "test-api-key-0123456789abcdef";
/* Unit tests never open a connection — the value only has to satisfy the env
   schema. Integration tests override it with TEST_DATABASE_URL. */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://localhost:5432/evc_test";
