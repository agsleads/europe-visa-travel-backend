#!/usr/bin/env node
"use strict";

/*
 * Create a CRM user (the accounts that sign in to the admin console).
 *
 * Run it INSIDE the running container, so it uses the same compiled code the
 * API uses -- the same validation rules, the same scrypt parameters and the
 * same id format. A script that hashed passwords its own way would produce
 * rows the login path cannot verify, and the failure would only show up when
 * somebody tried to sign in.
 *
 *   docker exec \
 *     -e CRM_USER_EMAIL=admin@example.com \
 *     -e CRM_USER_PASSWORD='...' \
 *     -e CRM_USER_NAME='Admin' \
 *     -e CRM_USER_ROLE=admin \
 *     europe-visa-travel-backend node scripts/create-crm-user.js
 *
 * The password comes from the environment, never an argument: arguments show
 * up in `ps` and in shell history.
 *
 * Idempotent in the useful sense -- if the username or email already exists
 * it says so and exits non-zero rather than creating a duplicate or quietly
 * resetting someone's password.
 */

const path = require("node:path");

const DIST = process.env.DIST_DIR || path.resolve(__dirname, "..", "dist");

const { createUserSchema } = require(path.join(DIST, "domain/user.schema.js"));
const { createUserService } = require(path.join(DIST, "services/user.service.js"));
const { closePool } = require(path.join(DIST, "db/pool.js"));

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`error: ${name} is required`);
    process.exit(2);
  }
  return value;
}

/** "admin@agsleads.com" -> "admin". Trimmed to the username rules. */
function usernameFromEmail(email) {
  return email
    .split("@")[0]
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, 50);
}

async function main() {
  const email = required("CRM_USER_EMAIL");
  const password = required("CRM_USER_PASSWORD");

  const input = {
    username: process.env.CRM_USER_USERNAME || usernameFromEmail(email),
    name: process.env.CRM_USER_NAME || "Administrator",
    email,
    password,
    role: process.env.CRM_USER_ROLE || "admin",
    status: "active",
    jobTitle: process.env.CRM_USER_JOB_TITLE || "",
  };

  /* Validated with the API's own schema rather than trusted, so a password
     this script accepts is exactly one the console would accept too. */
  const parsed = createUserSchema.safeParse(input);
  if (!parsed.success) {
    console.error("error: invalid input");
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    process.exit(2);
  }

  const service = createUserService();

  try {
    const user = await service.create(parsed.data);
    // The password is never echoed, not even on success.
    console.log("created:");
    console.log(`  id:       ${user.id}`);
    console.log(`  username: ${user.username}`);
    console.log(`  email:    ${user.email}`);
    console.log(`  role:     ${user.role}`);
    console.log(`  status:   ${user.status}`);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error(`error: could not create the user -- ${message}`);
    process.exitCode = 1;
  } finally {
    await closePool().catch(() => {});
  }
}

main().catch((error) => {
  console.error("error:", error && error.message ? error.message : error);
  process.exit(1);
});
