import type { CreateNotification, ListNotificationsQuery } from "@/domain/notification.schema";
import { NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { notificationRepository, type NotificationRepository } from "@/repositories/notification.repository";

export function createNotificationService(repository: NotificationRepository = notificationRepository) {
  async function requireOwned(id: number, userId: string) {
    const notification = await repository.find(id, userId);
    // Someone else's notification gets the same 404 as a missing one.
    if (!notification) throw new NotFoundError(`No notification ${id} for this user.`);
    return notification;
  }

  return {
    async create(input: CreateNotification) {
      const created = await repository.createMany(input);
      logger.info(
        { type: input.type, requested: input.recipients.length, created: created.length },
        "CRM notifications created",
      );
      return created;
    },

    list(query: ListNotificationsQuery) {
      return repository.list(query);
    },

    get(id: number, userId: string) {
      return requireOwned(id, userId);
    },

    async setRead(id: number, userId: string, read: boolean) {
      const updated = await repository.setRead(id, userId, read);
      if (!updated) throw new NotFoundError(`No notification ${id} for this user.`);
      return updated;
    },

    markAllRead(userId: string) {
      return repository.markAllRead(userId);
    },

    async remove(id: number, userId: string) {
      if (!(await repository.delete(id, userId))) throw new NotFoundError(`No notification ${id} for this user.`);
    },
  };
}

export type NotificationService = ReturnType<typeof createNotificationService>;
