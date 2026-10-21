import { Router } from "express";

import { asyncHandler } from "@/api/middleware/asyncHandler";
import { apiKeyAuth } from "@/api/middleware/apiKeyAuth";
import { validate } from "@/api/middleware/validate";
import {
  createNotificationSchema,
  listNotificationsSchema,
  notificationIdSchema,
  ownerQuerySchema,
  readAllSchema,
  updateNotificationSchema,
  type CreateNotification,
  type ListNotificationsQuery,
  type Notification,
} from "@/domain/notification.schema";
import { createNotificationService, type NotificationService } from "@/services/notification.service";

function present(notification: Notification) {
  return {
    id: notification.id,
    userId: notification.userId,
    type: notification.type,
    title: notification.title,
    message: notification.message,
    link: notification.link,
    read: notification.readAt !== null,
    readAt: notification.readAt?.toISOString() ?? null,
    createdAt: notification.createdAt.toISOString(),
  };
}

type IdParams = { id: number };
type Owner = { userId: string };

/**
 * /api/v1/notifications — CRM users' in-app notifications.
 *
 * Server-to-server like the rest of the API: the CRM's server holds the key.
 * Every route on an existing notification takes `?userId=` and only touches a
 * notification owned by that user.
 */
export function notificationsRouter(service: NotificationService = createNotificationService()): Router {
  const router = Router();

  /** POST /read-all — `{ userId }`. Before `/:id`. */
  router.post(
    "/read-all",
    apiKeyAuth,
    validate(readAllSchema),
    asyncHandler(async (req, res) => {
      const { userId } = req.body as Owner;
      res.json({ data: { updated: await service.markAllRead(userId) } });
    }),
  );

  /** GET /?userId=&unread=true&limit= — a user's notifications, newest first, with the unread count. */
  router.get(
    "/",
    apiKeyAuth,
    validate(listNotificationsSchema, "query"),
    asyncHandler(async (req, res) => {
      const { items, unreadCount } = await service.list(req.query as unknown as ListNotificationsQuery);
      res.json({ data: items.map(present), unreadCount });
    }),
  );

  /** POST / — `{ recipients, type, title, message, link? }`, one notification per recipient. */
  router.post(
    "/",
    apiKeyAuth,
    validate(createNotificationSchema),
    asyncHandler(async (req, res) => {
      const created = await service.create(req.body as CreateNotification);
      res.status(201).json({ data: created.map(present) });
    }),
  );

  router.get(
    "/:id",
    apiKeyAuth,
    validate(notificationIdSchema, "params"),
    validate(ownerQuerySchema, "query"),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as IdParams;
      const { userId } = req.query as unknown as Owner;
      res.json({ data: present(await service.get(id, userId)) });
    }),
  );

  /** PATCH /:id?userId= — `{ read }`. */
  router.patch(
    "/:id",
    apiKeyAuth,
    validate(notificationIdSchema, "params"),
    validate(ownerQuerySchema, "query"),
    validate(updateNotificationSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as IdParams;
      const { userId } = req.query as unknown as Owner;
      const { read } = req.body as { read: boolean };
      res.json({ data: present(await service.setRead(id, userId, read)) });
    }),
  );

  router.delete(
    "/:id",
    apiKeyAuth,
    validate(notificationIdSchema, "params"),
    validate(ownerQuerySchema, "query"),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as IdParams;
      const { userId } = req.query as unknown as Owner;
      await service.remove(id, userId);
      res.status(204).end();
    }),
  );

  return router;
}
