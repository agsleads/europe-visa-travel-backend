import type express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "@/api/app";
import { createUserService } from "@/services/user.service";
import { createFakeUserRepository, validUserPayload } from "../helpers/fakeUserRepository";

const API_KEY = process.env.API_KEY as string;

/** The CRM user directory, driven through the real app with only the repository faked. */
describe("/api/v1/users", () => {
  let repository: ReturnType<typeof createFakeUserRepository>;
  let app: express.Express;

  beforeEach(() => {
    repository = createFakeUserRepository();
    app = createApp({ userService: createUserService(repository) });
  });

  const auth = (req: request.Test) => req.set("x-api-key", API_KEY);
  const create = (overrides: Record<string, unknown> = {}) =>
    auth(request(app).post("/api/v1/users")).send(validUserPayload(overrides));

  it("creates a user, normalising the email and never returning the password", async () => {
    const response = await create({ email: "  Sarah.Chen@Example.COM " });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      id: expect.stringMatching(/^usr_[a-z2-7]{16}$/),
      email: "sarah.chen@example.com",
      role: "user",
      status: "active",
      lastActiveAt: null,
    });
    expect(JSON.stringify(response.body)).not.toMatch(/password|scrypt/i);
    expect(repository.rows[0]!.passwordHash).toMatch(/^scrypt\$/);
  });

  it("rejects a duplicate email regardless of case, naming the field", async () => {
    await create();
    const response = await create({ username: "other", email: "SARAH.CHEN@example.com" });
    expect(response.status).toBe(409);
    expect(response.body.error.details.fieldErrors).toHaveProperty("email");
  });

  it("rejects a duplicate username regardless of case, naming the field", async () => {
    await create();
    const response = await create({ username: "Sarah", email: "different@example.com" });
    expect(response.status).toBe(409);
    expect(response.body.error.details.fieldErrors).toEqual({ username: "That username is already taken." });
  });

  it("lower-cases the username, rejects an invalid one, and allows no phone", async () => {
    const ok = await create({ username: "Sarah.Chen", phone: "" });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ username: "sarah.chen", phone: null });

    const bad = await create({ username: "no spaces!", email: "x@example.com" });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.fieldErrors).toHaveProperty("username");
  });

  it("validates fields and password strength", async () => {
    const response = await create({ email: "nope", phone: "abc", password: "short", role: "owner" });

    expect(response.status).toBe(422);
    expect(Object.keys(response.body.error.details.fieldErrors).sort()).toEqual(["email", "password", "phone", "role"]);
  });

  it("lists with search, role and status filters", async () => {
    await create();
    await create({ username: "alex", email: "alex@example.com", name: "Alex Morgan", role: "admin" });
    await create({ username: "liam", email: "liam@example.com", name: "Liam Reid", status: "inactive" });

    const names = async (query: string) =>
      (await auth(request(app).get(`/api/v1/users${query}`))).body.data.map((u: { name: string }) => u.name).sort();

    expect(await names("")).toEqual(["Alex Morgan", "Liam Reid", "Sarah Chen"]);
    expect(await names("?role=admin")).toEqual(["Alex Morgan"]);
    expect(await names("?status=inactive")).toEqual(["Liam Reid"]);
    expect(await names("?q=SARAH")).toEqual(["Sarah Chen"]);
  });

  it("gets, updates and deletes a user", async () => {
    const { id } = (await create()).body.data;

    await expect(auth(request(app).get(`/api/v1/users/${id}`))).resolves.toMatchObject({ status: 200 });
    const updated = await auth(request(app).patch(`/api/v1/users/${id}`)).send({ name: "Sarah Chen-Lee", jobTitle: "" });
    expect(updated.body.data).toMatchObject({ name: "Sarah Chen-Lee", jobTitle: null });

    await expect(auth(request(app).delete(`/api/v1/users/${id}`))).resolves.toMatchObject({ status: 204 });
    await expect(auth(request(app).get(`/api/v1/users/${id}`))).resolves.toMatchObject({ status: 404 });
  });

  it("rejects an empty update and an unsafe avatar", async () => {
    const { id } = (await create()).body.data;
    await expect(auth(request(app).patch(`/api/v1/users/${id}`)).send({})).resolves.toMatchObject({ status: 422 });
    await expect(
      auth(request(app).patch(`/api/v1/users/${id}`)).send({ avatarUrl: "javascript:alert(1)" }),
    ).resolves.toMatchObject({ status: 422 });
    await expect(
      auth(request(app).patch(`/api/v1/users/${id}`)).send({ avatarUrl: "data:image/png;base64,iVBORw0KGgo=" }),
    ).resolves.toMatchObject({ status: 200 });
  });

  describe("the last active admin", () => {
    it("cannot be deleted, deactivated or demoted", async () => {
      const { id } = (await create({ role: "admin" })).body.data;

      await expect(auth(request(app).delete(`/api/v1/users/${id}`))).resolves.toMatchObject({
        status: 409,
        body: { error: { code: "last_admin" } },
      });
      await expect(auth(request(app).patch(`/api/v1/users/${id}`)).send({ status: "inactive" })).resolves.toMatchObject({ status: 409 });
      await expect(auth(request(app).patch(`/api/v1/users/${id}`)).send({ role: "user" })).resolves.toMatchObject({ status: 409 });
    });

    it("can be removed once another active admin exists", async () => {
      const { id } = (await create({ role: "admin" })).body.data;
      await create({ username: "second", email: "second@example.com", role: "admin" });
      await expect(auth(request(app).delete(`/api/v1/users/${id}`))).resolves.toMatchObject({ status: 204 });
    });
  });

  describe("authentication and passwords", () => {
    it("authenticates by username as well as email", async () => {
      await create();
      const response = await auth(request(app).post("/api/v1/users/authenticate")).send({ login: "Sarah", password: "Secret123" });
      expect(response.status).toBe(200);
      expect(response.body.data.username).toBe("sarah");
    });

    it("authenticates with the right password and stamps last activity", async () => {
      await create();
      const response = await auth(request(app).post("/api/v1/users/authenticate")).send({
        login: "SARAH.CHEN@example.com",
        password: "Secret123",
      });
      expect(response.status).toBe(200);
      expect(response.body.data.lastActiveAt).toEqual(expect.any(String));
    });

    it("gives the same 401 for a wrong password and an unknown email", async () => {
      await create();
      const wrong = await auth(request(app).post("/api/v1/users/authenticate")).send({ login: "sarah", password: "Nope12345" });
      const unknown = await auth(request(app).post("/api/v1/users/authenticate")).send({ login: "ghost", password: "Nope12345" });
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(wrong.body.error.message).toBe(unknown.body.error.message);
    });

    it("refuses a deactivated account with 403", async () => {
      await create({ status: "inactive" });
      const response = await auth(request(app).post("/api/v1/users/authenticate")).send({ login: "sarah.chen@example.com", password: "Secret123" });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("account_inactive");
    });

    it("lets an admin reset a password", async () => {
      const { id } = (await create()).body.data;
      await expect(auth(request(app).put(`/api/v1/users/${id}/password`)).send({ password: "Newpass123" })).resolves.toMatchObject({ status: 204 });
      const login = await auth(request(app).post("/api/v1/users/authenticate")).send({ login: "sarah", password: "Newpass123" });
      expect(login.status).toBe(200);
    });

    it("requires the current password for a self-service change", async () => {
      const { id } = (await create()).body.data;
      const change = (currentPassword: string) =>
        auth(request(app).post(`/api/v1/users/${id}/password/change`)).send({ currentPassword, newPassword: "Changed123" });

      await expect(change("WrongOne1")).resolves.toMatchObject({ status: 400, body: { error: { code: "invalid_password" } } });
      await expect(change("Secret123")).resolves.toMatchObject({ status: 204 });
    });
  });

  it("requires the API key on every route", async () => {
    const routes: [string, string][] = [
      ["get", "/api/v1/users"],
      ["post", "/api/v1/users"],
      ["post", "/api/v1/users/authenticate"],
      ["get", "/api/v1/users/usr_x"],
      ["patch", "/api/v1/users/usr_x"],
      ["delete", "/api/v1/users/usr_x"],
      ["put", "/api/v1/users/usr_x/password"],
      ["post", "/api/v1/users/usr_x/password/change"],
    ];
    for (const [method, path] of routes) {
      const response = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[method]!(path);
      expect(response.status, `${method.toUpperCase()} ${path}`).toBe(401);
    }
  });
});
