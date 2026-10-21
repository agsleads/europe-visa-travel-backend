import { z } from "zod";

/**
 * In-app notifications for CRM users.
 *
 * Every operation on an existing notification is scoped by `userId` as well as
 * id: a notification can only be read, changed or deleted on behalf of the
 * user it belongs to.
 */

export const NOTIFICATION_TYPES = [
  "lead_assigned",
  "status_changed",
  "follow_up_due",
  "user_added",
  "lead_converted",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

const userId = z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid user id.");

const singleLine = (max: number, required: string) =>
  z
    .string()
    .trim()
    .min(1, required)
    .max(max, `Please keep this under ${max} characters.`)
    .refine((v) => !/[\r\n\t\f\v\0]/.test(v), "Please remove any line breaks from this field.");

/** An in-app path. Never absolute or protocol-relative, so it can't lead off-site. */
const link = z
  .string()
  .trim()
  .max(300, "Link is too long.")
  .regex(/^\/(?!\/)[^\s]*$/, "Link must be an in-app path such as /leads/42.");

export const createNotificationSchema = z.object({
  /** One notification is created per recipient. Unknown user ids are skipped. */
  recipients: z
    .array(userId)
    .min(1, "Add at least one recipient.")
    .max(100, "At most 100 recipients at a time.")
    .transform((ids) => [...new Set(ids)]),
  type: z.enum(NOTIFICATION_TYPES),
  title: singleLine(150, "Title is required."),
  message: singleLine(500, "Message is required."),
  link: link.nullish().transform((v) => v ?? null),
});

export type CreateNotification = z.output<typeof createNotificationSchema>;

export const listNotificationsSchema = z.object({
  userId,
  /** `true` returns unread notifications only. */
  unread: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type ListNotificationsQuery = z.output<typeof listNotificationsSchema>;

export const notificationIdSchema = z.object({
  id: z.coerce.number().int().positive("Notification id must be a positive integer."),
});

/** The owner, required on every per-notification route. */
export const ownerQuerySchema = z.object({ userId });

export const updateNotificationSchema = z.object({ read: z.boolean() });

export const readAllSchema = z.object({ userId });

export interface Notification {
  id: number;
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  link: string | null;
  readAt: Date | null;
  createdAt: Date;
}
