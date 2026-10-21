import type { Notification } from "@/domain/notification.schema";
import type { NotificationRepository } from "@/repositories/notification.repository";

/** In-memory notifications. `knownUsers` stands in for crm_users: other recipients are skipped. */
export function createFakeNotificationRepository(
  knownUsers: string[] = ["usr_admin", "usr_sarah"],
): NotificationRepository & { rows: Notification[] } {
  const rows: Notification[] = [];
  let nextId = 1;
  const owned = (id: number, userId: string) => rows.find((n) => n.id === id && n.userId === userId);

  return {
    rows,
    async createMany({ recipients, type, title, message, link }) {
      const created = recipients
        .filter((userId) => knownUsers.includes(userId))
        .map((userId) => ({ id: nextId++, userId, type, title, message, link, readAt: null, createdAt: new Date() }));
      rows.push(...created);
      return created.map((n) => ({ ...n }));
    },
    async list({ userId, unread, limit }) {
      const mine = rows.filter((n) => n.userId === userId)
      return {
        items: mine
          .filter((n) => !unread || n.readAt === null)
          .sort((a, b) => b.id - a.id)
          .slice(0, limit)
          .map((n) => ({ ...n })),
        unreadCount: mine.filter((n) => n.readAt === null).length,
      };
    },
    async find(id, userId) {
      const n = owned(id, userId);
      return n ? { ...n } : null;
    },
    async setRead(id, userId, read) {
      const n = owned(id, userId);
      if (!n) return null;
      n.readAt = read ? (n.readAt ?? new Date()) : null;
      return { ...n };
    },
    async markAllRead(userId) {
      const unread = rows.filter((n) => n.userId === userId && n.readAt === null);
      for (const n of unread) n.readAt = new Date();
      return unread.length;
    },
    async delete(id, userId) {
      const index = rows.findIndex((n) => n.id === id && n.userId === userId);
      if (index === -1) return false;
      rows.splice(index, 1);
      return true;
    },
  };
}
