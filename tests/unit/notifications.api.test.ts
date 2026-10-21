import type express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "@/api/app";
import { createNotificationService } from "@/services/notification.service";
import { createFakeNotificationRepository } from "../helpers/fakeNotificationRepository";

const API_KEY = process.env.API_KEY as string;

describe("/api/v1/notifications", () => {
  let repository: ReturnType<typeof createFakeNotificationRepository>;
  let app: express.Express;

  beforeEach(() => {
    repository = createFakeNotificationRepository();
    app = createApp({ notificationService: createNotificationService(repository) });
  });

  const auth = (req: request.Test) => req.set("x-api-key", API_KEY);
  const send = (overrides: Record<string, unknown> = {}) =>
    auth(request(app).post("/api/v1/notifications")).send({
      recipients: ["usr_sarah"],
      type: "lead_assigned",
      title: "New lead assigned to you",
      message: "Aisha Rahman (France) was assigned to you by Admin.",
      link: "/leads/42",
      ...overrides,
    });
  const inbox = (userId = "usr_sarah", query = "") =>
    auth(request(app).get(`/api/v1/notifications?userId=${userId}${query}`));

  it("creates one per known recipient, de-duplicated, skipping unknown users", async () => {
    const response = await send({ recipients: ["usr_sarah", "usr_admin", "usr_sarah", "usr_ghost"] });

    expect(response.status).toBe(201);
    expect(response.body.data.map((n: { userId: string }) => n.userId).sort()).toEqual(["usr_admin", "usr_sarah"]);
    expect(response.body.data[0]).toMatchObject({ read: false, readAt: null, link: "/leads/42" });
  });

  it("validates type, text and link, refusing off-site links", async () => {
    for (const link of ["https://evil.example", "//evil.example", "javascript:alert(1)"]) {
      await expect(send({ link })).resolves.toMatchObject({ status: 422 });
    }
    await expect(send({ type: "party" })).resolves.toMatchObject({ status: 422 });
    await expect(send({ title: "" })).resolves.toMatchObject({ status: 422 });
    await expect(send({ recipients: [] })).resolves.toMatchObject({ status: 422 });
    await expect(send({ link: null })).resolves.toMatchObject({ status: 201 });
  });

  it("lists a user's inbox newest first with the unread count, and filters to unread", async () => {
    await send({ title: "First" });
    await send({ title: "Second" });
    await send({ recipients: ["usr_admin"], title: "Not Sarah's" });

    const all = await inbox();
    expect(all.body.data.map((n: { title: string }) => n.title)).toEqual(["Second", "First"]);
    expect(all.body.unreadCount).toBe(2);

    await auth(request(app).patch(`/api/v1/notifications/${all.body.data[0].id}?userId=usr_sarah`)).send({ read: true });
    const unread = await inbox("usr_sarah", "&unread=true");
    expect(unread.body.data.map((n: { title: string }) => n.title)).toEqual(["First"]);
    expect(unread.body.unreadCount).toBe(1);
  });

  it("requires userId to list", async () => {
    await expect(auth(request(app).get("/api/v1/notifications"))).resolves.toMatchObject({ status: 422 });
  });

  it("marks read and unread, keeping the first read time", async () => {
    const id = (await send()).body.data[0].id;
    const path = `/api/v1/notifications/${id}?userId=usr_sarah`;

    const first = await auth(request(app).patch(path)).send({ read: true });
    const again = await auth(request(app).patch(path)).send({ read: true });
    expect(again.body.data.readAt).toBe(first.body.data.readAt);

    const unread = await auth(request(app).patch(path)).send({ read: false });
    expect(unread.body.data).toMatchObject({ read: false, readAt: null });
  });

  it("marks all read for one user only", async () => {
    await send();
    await send();
    await send({ recipients: ["usr_admin"] });

    const response = await auth(request(app).post("/api/v1/notifications/read-all")).send({ userId: "usr_sarah" });
    expect(response.body.data.updated).toBe(2);
    expect((await inbox("usr_admin")).body.unreadCount).toBe(1);
  });

  it("gets and deletes, and treats another user's notification as not found", async () => {
    const id = (await send()).body.data[0].id;

    await expect(auth(request(app).get(`/api/v1/notifications/${id}?userId=usr_sarah`))).resolves.toMatchObject({ status: 200 });
    await expect(auth(request(app).get(`/api/v1/notifications/${id}?userId=usr_admin`))).resolves.toMatchObject({ status: 404 });
    await expect(auth(request(app).patch(`/api/v1/notifications/${id}?userId=usr_admin`)).send({ read: true })).resolves.toMatchObject({ status: 404 });
    await expect(auth(request(app).delete(`/api/v1/notifications/${id}?userId=usr_admin`))).resolves.toMatchObject({ status: 404 });

    await expect(auth(request(app).delete(`/api/v1/notifications/${id}?userId=usr_sarah`))).resolves.toMatchObject({ status: 204 });
    expect(repository.rows).toHaveLength(0);
  });

  it("requires the API key on every route", async () => {
    const routes: [string, string][] = [
      ["get", "/api/v1/notifications?userId=usr_sarah"],
      ["post", "/api/v1/notifications"],
      ["post", "/api/v1/notifications/read-all"],
      ["get", "/api/v1/notifications/1?userId=usr_sarah"],
      ["patch", "/api/v1/notifications/1?userId=usr_sarah"],
      ["delete", "/api/v1/notifications/1?userId=usr_sarah"],
    ];
    for (const [method, path] of routes) {
      const response = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[method]!(path);
      expect(response.status, `${method.toUpperCase()} ${path}`).toBe(401);
    }
  });
});
