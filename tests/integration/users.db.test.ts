import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePool, query } from "@/db/pool";
import { migrate } from "@/db/migrate";
import { createUserSchema } from "@/domain/user.schema";
import { userRepository } from "@/repositories/user.repository";
import { createUserService } from "@/services/user.service";
import { validUserPayload } from "../helpers/fakeUserRepository";

/** The users table against real PostgreSQL. Skipped unless TEST_DATABASE_URL is set. */
const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeDb("CRM users (PostgreSQL)", () => {
  const service = createUserService(userRepository);
  const input = (overrides: Record<string, unknown> = {}) => createUserSchema.parse(validUserPayload(overrides));

  beforeAll(async () => {
    await migrate(path.join(__dirname, "../../src/db/migrations"));
  }, 30_000);

  beforeEach(async () => {
    await query("TRUNCATE crm_users CASCADE");
  });

  afterAll(async () => {
    await closePool();
  });

  it("round-trips a user and stores only a scrypt hash", async () => {
    const created = await service.create(input());
    const { rows } = await query<{ password_hash: string }>("SELECT password_hash FROM crm_users");

    expect(await service.get(created.id)).toMatchObject({ email: "sarah.chen@example.com", jobTitle: "Visa Consultant" });
    expect(rows[0]!.password_hash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(rows[0]!.password_hash).not.toContain("Secret123");
  });

  it("enforces unique username and email at the database level, naming the clashing field", async () => {
    await service.create(input());
    await expect(
      query(
        "INSERT INTO crm_users (id, username, name, email, domain, password_hash) VALUES ('usr_dup', 'dup', 'Dup', 'SARAH.CHEN@EXAMPLE.COM', 'evc', 'x')",
      ),
    ).rejects.toThrow(/crm_users_email_unique_idx/);
    await expect(service.create(input({ username: "other", email: "Sarah.Chen@example.com" }))).rejects.toMatchObject({
      status: 409,
      details: { fieldErrors: { email: expect.any(String) } },
    });
    await expect(service.create(input({ email: "new@example.com" }))).rejects.toMatchObject({
      status: 409,
      details: { fieldErrors: { username: "That username is already taken." } },
    });
  });

  it("updates only the given fields, maintains updated_at, and maps an email clash to 409", async () => {
    const sarah = await service.create(input());
    await service.create(input({ username: "other", email: "other@example.com" }));
    await new Promise((resolve) => setTimeout(resolve, 25));

    const updated = await service.update(sarah.id, { phone: "+44 7700 900999" });
    expect(updated).toMatchObject({ phone: "+44 7700 900999", name: "Sarah Chen" });
    expect(updated.updatedAt.getTime()).toBeGreaterThan(sarah.updatedAt.getTime());
    await expect(service.update(sarah.id, { email: "OTHER@example.com" })).rejects.toMatchObject({ status: 409 });
  });

  it("rejects a username that breaks the shape rule at the database level", async () => {
    await expect(
      query("INSERT INTO crm_users (id, username, name, email, domain, password_hash) VALUES ('usr_x', 'Has Space', 'X', 'x@example.com', 'evc', 'x')"),
    ).rejects.toThrow(/crm_users_username_shape_check/);
  });

  it("filters the list in SQL", async () => {
    await service.create(input());
    await service.create(input({ username: "alex", email: "alex@example.com", name: "Alex Morgan", role: "admin" }));

    expect((await service.list({ role: "admin" })).map((u) => u.name)).toEqual(["Alex Morgan"]);
    expect((await service.list({ q: "chen" })).map((u) => u.name)).toEqual(["Sarah Chen"]);
  });

  it("authenticates, changes and resets passwords against stored hashes", async () => {
    const user = await service.create(input({ role: "super_admin", domain: null }));

    await expect(service.authenticate("sarah.chen@example.com", "Secret123")).resolves.toMatchObject({ id: user.id });
    await expect(service.authenticate("sarah.chen@example.com", "Wrong1234")).rejects.toMatchObject({ status: 401 });

    await service.changePassword(user.id, "Secret123", "Changed123");
    await expect(service.authenticate("SARAH", "Changed123")).resolves.toBeTruthy();

    await service.setPassword(user.id, "ResetPass1");
    await expect(service.authenticate("sarah.chen@example.com", "ResetPass1")).resolves.toBeTruthy();
    expect((await service.get(user.id)).lastActiveAt).toBeInstanceOf(Date);
  });

  it("protects the last active super admin", async () => {
    const boss = await service.create(input({ role: "super_admin", domain: null }));
    await expect(service.remove(boss.id)).rejects.toMatchObject({ code: "last_super_admin" });

    await service.create(input({ username: "second", email: "second@example.com", role: "super_admin", domain: null }));
    await expect(service.update(boss.id, { status: "inactive" })).resolves.toMatchObject({ status: "inactive" });
  });

  it("enforces domain rules at the database level and maps an unknown domain to a field error", async () => {
    await expect(
      query("INSERT INTO crm_users (id, username, name, email, role, password_hash) VALUES ('usr_x', 'xadmin', 'X', 'x@example.com', 'admin', 'x')"),
    ).rejects.toThrow(/crm_users_role_domain_check/);
    await expect(service.create(input({ domain: "nowhere" }))).rejects.toMatchObject({
      status: 422,
      details: { fieldErrors: { domain: "That domain doesn't exist." } },
    });

    const rc = await service.create(input({ username: "rcadmin", email: "rc@example.com", role: "admin", domain: "roadcover" }));
    expect((await service.list({ domain: "roadcover" })).map((u) => u.id)).toEqual([rc.id]);
  });

  it("seeds the lead domains", async () => {
    const { rows } = await query<{ key: string }>("SELECT key FROM crm_domains ORDER BY key");
    expect(rows.map((r) => r.key)).toEqual([
      "affordableplan", "autoinsurance", "evc", "finalexpense", "roadcover", "seniorhealth", "socialsecurity",
    ]);
  });
});
