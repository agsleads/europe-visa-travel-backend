import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePool, query } from "@/db/pool";
import { migrate } from "@/db/migrate";
import { createUserSchema } from "@/domain/user.schema";
import { userRepository } from "@/repositories/user.repository";
import { notificationRepository } from "@/repositories/notification.repository";
import { createNotificationService } from "@/services/notification.service";
import { createUserService } from "@/services/user.service";
import { validUserPayload } from "../helpers/fakeUserRepository";

/** Notifications against real PostgreSQL. Skipped unless TEST_DATABASE_URL is set. */
const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeDb("CRM notifications (PostgreSQL)", () => {
  const notifications = createNotificationService(notificationRepository);
  const users = createUserService(userRepository);
  let sarah: string;
  let alex: string;

  const notify = (recipients: string[], title = "New lead assigned to you") =>
    notifications.create({ recipients, type: "lead_assigned", title, message: "A lead was assigned.", link: "/leads/1" });

  beforeAll(async () => {
    await migrate(path.join(__dirname, "../../src/db/migrations"));
  }, 30_000);

  beforeEach(async () => {
    await query("TRUNCATE crm_users CASCADE");
    sarah = (await users.create(createUserSchema.parse(validUserPayload()))).id;
    alex = (await users.create(createUserSchema.parse(validUserPayload({ username: "alex", email: "alex@example.com", role: "admin" })))).id;
  });

  afterAll(async () => {
    await closePool();
  });

  it("inserts only for recipients that exist", async () => {
    const created = await notify([sarah, "usr_ghost", alex]);
    expect(created.map((n) => n.userId).sort()).toEqual([alex, sarah].sort());
  });

  it("lists newest first with an unread count, and scopes by owner", async () => {
    await notify([sarah], "First");
    await notify([sarah], "Second");
    await notify([alex], "Alex's");

    const { items, unreadCount } = await notifications.list({ userId: sarah, unread: false, limit: 50 });
    expect(items.map((n) => n.title)).toEqual(["Second", "First"]);
    expect(unreadCount).toBe(2);

    await expect(notifications.get(items[0]!.id, alex)).rejects.toMatchObject({ status: 404 });
  });

  it("marks one or all read, and keeps the first read time", async () => {
    const [first] = await notify([sarah]);
    await notify([sarah]);

    const read = await notifications.setRead(first!.id, sarah, true);
    const again = await notifications.setRead(first!.id, sarah, true);
    expect(again.readAt?.getTime()).toBe(read.readAt?.getTime());

    expect(await notifications.markAllRead(sarah)).toBe(1);
    expect((await notifications.list({ userId: sarah, unread: true, limit: 50 })).unreadCount).toBe(0);
  });

  it("rejects off-site links at the database level", async () => {
    await expect(
      query(
        "INSERT INTO crm_notifications (user_id, type, title, message, link) VALUES ($1, 'lead_assigned', 't', 'm', '//evil.example')",
        [sarah],
      ),
    ).rejects.toThrow(/crm_notifications_link_check/);
  });

  it("deletes a notification, and removes a user's inbox when the user is deleted", async () => {
    const [mine] = await notify([sarah]);
    await notifications.remove(mine!.id, sarah);
    await notify([sarah]);

    await users.remove(sarah);
    const { rows } = await query<{ count: string }>("SELECT COUNT(*) AS count FROM crm_notifications");
    expect(rows[0]!.count).toBe("0");
  });
});
