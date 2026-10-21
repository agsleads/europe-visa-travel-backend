import { query } from "@/db/pool";
import type { CreateNotification, ListNotificationsQuery, Notification, NotificationType } from "@/domain/notification.schema";

/** Data access for CRM notifications. Every per-row operation is scoped by owner. */

interface NotificationRow {
  id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  message: string;
  link: string | null;
  read_at: Date | null;
  created_at: Date;
}

const COLUMNS = "id, user_id, type, title, message, link, read_at, created_at";

function toNotification(row: NotificationRow): Notification {
  return {
    id: Number(row.id),
    userId: row.user_id,
    type: row.type,
    title: row.title,
    message: row.message,
    link: row.link,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export interface NotificationRepository {
  /** Creates one per recipient that exists as a CRM user; others are skipped. */
  createMany(input: CreateNotification): Promise<Notification[]>;
  list(query: ListNotificationsQuery): Promise<{ items: Notification[]; unreadCount: number }>;
  find(id: number, userId: string): Promise<Notification | null>;
  setRead(id: number, userId: string, read: boolean): Promise<Notification | null>;
  markAllRead(userId: string): Promise<number>;
  delete(id: number, userId: string): Promise<boolean>;
}

export const notificationRepository: NotificationRepository = {
  async createMany({ recipients, type, title, message, link }) {
    /* Inserting from crm_users rather than from the raw id list means an
       unknown or since-deleted recipient is dropped instead of failing the
       whole batch on the foreign key. */
    const { rows } = await query<NotificationRow>(
      `INSERT INTO crm_notifications (user_id, type, title, message, link)
       SELECT u.id, $2, $3, $4, $5 FROM crm_users u WHERE u.id = ANY($1::varchar[])
       RETURNING ${COLUMNS}`,
      [recipients, type, title, message, link],
    );
    return rows.map(toNotification);
  },

  async list({ userId, unread, limit }) {
    const [items, count] = await Promise.all([
      query<NotificationRow>(
        `SELECT ${COLUMNS} FROM crm_notifications
          WHERE user_id = $1 AND (NOT $2::boolean OR read_at IS NULL)
          ORDER BY created_at DESC, id DESC
          LIMIT $3`,
        [userId, unread, limit],
      ),
      query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM crm_notifications WHERE user_id = $1 AND read_at IS NULL",
        [userId],
      ),
    ]);
    return { items: items.rows.map(toNotification), unreadCount: Number(count.rows[0]?.count ?? 0) };
  },

  async find(id, userId) {
    const { rows } = await query<NotificationRow>(
      `SELECT ${COLUMNS} FROM crm_notifications WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    return rows[0] ? toNotification(rows[0]) : null;
  },

  async setRead(id, userId, read) {
    // COALESCE keeps the original read time when a read notification is marked read again.
    const { rows } = await query<NotificationRow>(
      `UPDATE crm_notifications
          SET read_at = CASE WHEN $3 THEN COALESCE(read_at, NOW()) ELSE NULL END
        WHERE id = $1 AND user_id = $2
        RETURNING ${COLUMNS}`,
      [id, userId, read],
    );
    return rows[0] ? toNotification(rows[0]) : null;
  },

  async markAllRead(userId) {
    const { rowCount } = await query(
      "UPDATE crm_notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL",
      [userId],
    );
    return rowCount ?? 0;
  },

  async delete(id, userId) {
    const { rowCount } = await query("DELETE FROM crm_notifications WHERE id = $1 AND user_id = $2", [id, userId]);
    return (rowCount ?? 0) > 0;
  },
};
