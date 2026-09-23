/**
 * Loaded before any test file. Runs before `src/config/env` is imported, so
 * the schema sees a complete environment and no test needs a real .env.
 */
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.API_KEY ??= "test-api-key-0123456789abcdef";
/* A different value from API_KEY on purpose: the lead tests assert that each
   credential opens only its own half of the router, which a shared value would
   make impossible to detect. */
process.env.ROADCOVER_WEBHOOK_SECRET ??= "test-roadcover-secret-0123456789";
/* Distinct from both of the above, for the same reason: the Final Expense tests
   assert that its secret opens only its own intake. */
process.env.FINALEXPENSE_WEBHOOK_SECRET ??= "test-finalexpense-secret-0123456789";
/* Unit tests never open a connection — the value only has to satisfy the env
   schema. Integration tests override it with TEST_DATABASE_URL. */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://localhost:5432/evc_test";
