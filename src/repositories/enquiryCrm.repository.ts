import type { QueryResultRow } from "pg";

import { pool } from "@/db/pool";
import type {
  ActivityType,
  Actor,
  EnquiryActivity,
  EnquiryFollowUp,
  EnquiryNote,
  ListFollowUpsQuery,
  RecentActivityQuery,
} from "@/domain/enquiry.schema";
import type { Db } from "@/repositories/enquiry.repository";

/**
 * Data access for the CRM records hung off an enquiry: its activity history,
 * notes and follow-ups. Every write accepts a transaction client, so the
 * service can record a change and its activity entry atomically.
 */

function run<T extends QueryResultRow>(db: Db | undefined, text: string, params: unknown[] = []) {
  return (db ?? pool).query<T>(text, params);
}

const actorOf = (id: string | null, name: string | null): Actor => ({ id, name });

interface ActivityRow {
  id: string;
  enquiry_id: string;
  enquiry_name?: string;
  type: ActivityType;
  description: string;
  actor_id: string | null;
  actor_name: string | null;
  created_at: Date;
}

function toActivity(row: ActivityRow): EnquiryActivity {
  return {
    id: Number(row.id),
    enquiryId: Number(row.enquiry_id),
    ...(row.enquiry_name !== undefined && { enquiryName: row.enquiry_name }),
    type: row.type,
    description: row.description,
    actor: actorOf(row.actor_id, row.actor_name),
    createdAt: row.created_at,
  };
}

interface NoteRow {
  id: string;
  enquiry_id: string;
  content: string;
  author_id: string | null;
  author_name: string | null;
  created_at: Date;
  updated_at: Date;
}

function toNote(row: NoteRow): EnquiryNote {
  return {
    id: Number(row.id),
    enquiryId: Number(row.enquiry_id),
    content: row.content,
    author: actorOf(row.author_id, row.author_name),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface FollowUpRow {
  id: string;
  enquiry_id: string;
  enquiry_name?: string;
  title: string;
  due_at: Date;
  completed: boolean;
  completed_at: Date | null;
  created_by_id: string | null;
  created_by_name: string | null;
  created_at: Date;
}

function toFollowUp(row: FollowUpRow): EnquiryFollowUp {
  return {
    id: Number(row.id),
    enquiryId: Number(row.enquiry_id),
    ...(row.enquiry_name !== undefined && { enquiryName: row.enquiry_name }),
    title: row.title,
    dueAt: row.due_at,
    completed: row.completed,
    completedAt: row.completed_at,
    createdBy: actorOf(row.created_by_id, row.created_by_name),
    createdAt: row.created_at,
  };
}

const ACTIVITY_COLUMNS = "a.id, a.enquiry_id, a.type, a.description, a.actor_id, a.actor_name, a.created_at";
const NOTE_COLUMNS = "id, enquiry_id, content, author_id, author_name, created_at, updated_at";
const FOLLOW_UP_COLUMNS =
  "f.id, f.enquiry_id, f.title, f.due_at, f.completed, f.completed_at, f.created_by_id, f.created_by_name, f.created_at";

export interface NewActivity {
  enquiryId: number;
  type: ActivityType;
  description: string;
  actor: Actor;
}

export interface EnquiryCrmRepository {
  addActivities(entries: NewActivity[], db?: Db): Promise<void>;
  listActivities(enquiryId: number): Promise<EnquiryActivity[]>;
  recentActivities(query: RecentActivityQuery): Promise<EnquiryActivity[]>;

  listNotes(enquiryId: number): Promise<EnquiryNote[]>;
  findNote(enquiryId: number, noteId: number): Promise<EnquiryNote | null>;
  createNote(enquiryId: number, content: string, author: Actor, db?: Db): Promise<EnquiryNote>;
  updateNote(enquiryId: number, noteId: number, content: string): Promise<EnquiryNote | null>;
  deleteNote(enquiryId: number, noteId: number): Promise<boolean>;

  listFollowUps(query: { enquiryId?: number } & Partial<ListFollowUpsQuery>): Promise<EnquiryFollowUp[]>;
  findFollowUp(enquiryId: number, followUpId: number, db?: Db): Promise<EnquiryFollowUp | null>;
  createFollowUp(
    enquiryId: number,
    input: { title: string; dueAt: Date },
    createdBy: Actor,
    db?: Db,
  ): Promise<EnquiryFollowUp>;
  setFollowUpCompleted(
    enquiryId: number,
    followUpId: number,
    completed: boolean,
    db?: Db,
  ): Promise<EnquiryFollowUp | null>;
  deleteFollowUp(enquiryId: number, followUpId: number): Promise<boolean>;
}

export const enquiryCrmRepository: EnquiryCrmRepository = {
  async addActivities(entries, db) {
    if (entries.length === 0) return;
    /* One multi-row INSERT via UNNEST rather than a statement per entry: a bulk
       assignment of 200 leads is one round trip, not 200. */
    await run(
      db,
      `INSERT INTO enquiry_activities (enquiry_id, type, description, actor_id, actor_name)
       SELECT * FROM UNNEST($1::bigint[], $2::varchar[], $3::varchar[], $4::varchar[], $5::varchar[])`,
      [
        entries.map((e) => e.enquiryId),
        entries.map((e) => e.type),
        entries.map((e) => e.description.slice(0, 500)),
        entries.map((e) => e.actor.id),
        entries.map((e) => e.actor.name),
      ],
    );
  },

  async listActivities(enquiryId) {
    const { rows } = await run<ActivityRow>(
      undefined,
      `SELECT ${ACTIVITY_COLUMNS} FROM enquiry_activities a
        WHERE a.enquiry_id = $1
        ORDER BY a.created_at DESC, a.id DESC`,
      [enquiryId],
    );
    return rows.map(toActivity);
  },

  async recentActivities({ assignedTo, limit }) {
    const { rows } = await run<ActivityRow>(
      undefined,
      `SELECT ${ACTIVITY_COLUMNS}, e.name AS enquiry_name
         FROM enquiry_activities a
         JOIN enquiries e ON e.id = a.enquiry_id
        WHERE ($1::varchar IS NULL OR e.assigned_to_id = $1)
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $2`,
      [assignedTo ?? null, limit],
    );
    return rows.map(toActivity);
  },

  async listNotes(enquiryId) {
    const { rows } = await run<NoteRow>(
      undefined,
      `SELECT ${NOTE_COLUMNS} FROM enquiry_notes WHERE enquiry_id = $1 ORDER BY created_at DESC, id DESC`,
      [enquiryId],
    );
    return rows.map(toNote);
  },

  async findNote(enquiryId, noteId) {
    const { rows } = await run<NoteRow>(
      undefined,
      `SELECT ${NOTE_COLUMNS} FROM enquiry_notes WHERE enquiry_id = $1 AND id = $2`,
      [enquiryId, noteId],
    );
    return rows[0] ? toNote(rows[0]) : null;
  },

  async createNote(enquiryId, content, author, db) {
    const { rows } = await run<NoteRow>(
      db,
      `INSERT INTO enquiry_notes (enquiry_id, content, author_id, author_name)
       VALUES ($1, $2, $3, $4) RETURNING ${NOTE_COLUMNS}`,
      [enquiryId, content, author.id, author.name],
    );
    return toNote(rows[0]!);
  },

  async updateNote(enquiryId, noteId, content) {
    // Scoped by enquiry as well as id, so a note can only be edited under the
    // enquiry it belongs to — /enquiries/1/notes/99 cannot reach enquiry 2's note.
    const { rows } = await run<NoteRow>(
      undefined,
      `UPDATE enquiry_notes SET content = $3 WHERE enquiry_id = $1 AND id = $2 RETURNING ${NOTE_COLUMNS}`,
      [enquiryId, noteId, content],
    );
    return rows[0] ? toNote(rows[0]) : null;
  },

  async deleteNote(enquiryId, noteId) {
    const { rowCount } = await run(undefined, "DELETE FROM enquiry_notes WHERE enquiry_id = $1 AND id = $2", [
      enquiryId,
      noteId,
    ]);
    return (rowCount ?? 0) > 0;
  },

  async listFollowUps({ enquiryId, assignedTo, open, limit }) {
    /* Open follow-ups first, soonest due first; completed ones after them. */
    const { rows } = await run<FollowUpRow>(
      undefined,
      `SELECT ${FOLLOW_UP_COLUMNS}, e.name AS enquiry_name
         FROM enquiry_follow_ups f
         JOIN enquiries e ON e.id = f.enquiry_id
        WHERE ($1::bigint IS NULL OR f.enquiry_id = $1)
          AND ($2::varchar IS NULL OR e.assigned_to_id = $2)
          AND (NOT $3::boolean OR NOT f.completed)
        ORDER BY f.completed, f.due_at, f.id
        LIMIT $4`,
      [enquiryId ?? null, assignedTo ?? null, open ?? false, limit ?? 100],
    );
    return rows.map(toFollowUp);
  },

  async findFollowUp(enquiryId, followUpId, db) {
    const { rows } = await run<FollowUpRow>(
      db,
      `SELECT ${FOLLOW_UP_COLUMNS} FROM enquiry_follow_ups f WHERE f.enquiry_id = $1 AND f.id = $2`,
      [enquiryId, followUpId],
    );
    return rows[0] ? toFollowUp(rows[0]) : null;
  },

  async createFollowUp(enquiryId, { title, dueAt }, createdBy, db) {
    const { rows } = await run<FollowUpRow>(
      db,
      `INSERT INTO enquiry_follow_ups AS f (enquiry_id, title, due_at, created_by_id, created_by_name)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${FOLLOW_UP_COLUMNS}`,
      [enquiryId, title, dueAt, createdBy.id, createdBy.name],
    );
    return toFollowUp(rows[0]!);
  },

  async setFollowUpCompleted(enquiryId, followUpId, completed, db) {
    const { rows } = await run<FollowUpRow>(
      db,
      `UPDATE enquiry_follow_ups f
          SET completed = $3,
              completed_at = CASE WHEN $3 THEN COALESCE(f.completed_at, NOW()) ELSE NULL END
        WHERE f.enquiry_id = $1 AND f.id = $2
        RETURNING ${FOLLOW_UP_COLUMNS}`,
      [enquiryId, followUpId, completed],
    );
    return rows[0] ? toFollowUp(rows[0]) : null;
  },

  async deleteFollowUp(enquiryId, followUpId) {
    const { rowCount } = await run(
      undefined,
      "DELETE FROM enquiry_follow_ups WHERE enquiry_id = $1 AND id = $2",
      [enquiryId, followUpId],
    );
    return (rowCount ?? 0) > 0;
  },
};
