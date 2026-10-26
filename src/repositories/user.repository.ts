import { query } from "@/db/pool";
import type { ListUsersQuery, User, UserRole, UserStatus } from "@/domain/user.schema";

/**
 * Data access for CRM users. The password hash is read only by
 * `findCredentials` and written only by `create` / `setPasswordHash`; every
 * other method selects the public columns, so a hash cannot leak through a
 * serialiser by accident.
 */

interface UserRow {
  id: string;
  username: string;
  name: string;
  email: string;
  phone: string | null;
  role: UserRole;
  domain: string | null;
  status: UserStatus;
  job_title: string | null;
  avatar_url: string | null;
  last_active_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, username, name, email, phone, role, domain, status, job_title, avatar_url, last_active_at, created_at, updated_at`;

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    domain: row.domain,
    status: row.status,
    jobTitle: row.job_title,
    avatarUrl: row.avatar_url,
    lastActiveAt: row.last_active_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewUserRow {
  id: string;
  username: string;
  name: string;
  email: string;
  phone: string | null;
  role: UserRole;
  domain: string | null;
  status: UserStatus;
  jobTitle: string | null;
  passwordHash: string;
}

export type UserPatch = Partial<{
  username: string;
  name: string;
  email: string;
  phone: string | null;
  role: UserRole;
  domain: string | null;
  status: UserStatus;
  jobTitle: string | null;
  avatarUrl: string | null;
}>;

export interface UserRepository {
  list(query: ListUsersQuery): Promise<User[]>;
  findById(id: string): Promise<User | null>;
  /** By username or email, case-insensitively. */
  findCredentials(login: string): Promise<{ user: User; passwordHash: string } | null>;
  findPasswordHash(id: string): Promise<string | null>;
  create(input: NewUserRow): Promise<User>;
  update(id: string, patch: UserPatch): Promise<User | null>;
  setPasswordHash(id: string, passwordHash: string): Promise<boolean>;
  touchLastActive(id: string): Promise<void>;
  delete(id: string): Promise<boolean>;
  /** Active super admins other than `excludeId` — the guard against locking everyone out. */
  countOtherActiveSuperAdmins(excludeId: string): Promise<number>;
}

/** Postgres's unique-violation SQLSTATE; raised here by the username and email indexes. */
export const UNIQUE_VIOLATION = "23505";
export const USERNAME_INDEX = "crm_users_username_unique_idx";
/** Postgres's foreign-key-violation SQLSTATE; raised here by an unknown domain. */
export const FOREIGN_KEY_VIOLATION = "23503";

const PATCH_COLUMNS: Record<keyof UserPatch, string> = {
  username: "username",
  name: "name",
  email: "email",
  phone: "phone",
  role: "role",
  domain: "domain",
  status: "status",
  jobTitle: "job_title",
  avatarUrl: "avatar_url",
};

export const userRepository: UserRepository = {
  async list({ q, role, status, domain }) {
    const { rows } = await query<UserRow>(
      `SELECT ${COLUMNS} FROM crm_users
        WHERE ($1::varchar IS NULL OR role = $1)
          AND ($2::varchar IS NULL OR status = $2)
          AND ($4::varchar IS NULL OR domain = $4)
          AND ($3::text IS NULL OR POSITION($3 IN LOWER(name)) > 0 OR POSITION($3 IN LOWER(email)) > 0
               OR POSITION($3 IN username) > 0)
        ORDER BY created_at DESC, id`,
      [role ?? null, status ?? null, q ? q.toLowerCase() : null, domain ?? null],
    );
    return rows.map(toUser);
  },

  async findById(id) {
    const { rows } = await query<UserRow>(`SELECT ${COLUMNS} FROM crm_users WHERE id = $1`, [id]);
    return rows[0] ? toUser(rows[0]) : null;
  },

  async findCredentials(login) {
    // A username can't contain "@", so the two never collide.
    const { rows } = await query<UserRow & { password_hash: string }>(
      `SELECT ${COLUMNS}, password_hash FROM crm_users WHERE username = LOWER($1) OR LOWER(email) = LOWER($1)`,
      [login],
    );
    const row = rows[0];
    return row ? { user: toUser(row), passwordHash: row.password_hash } : null;
  },

  async findPasswordHash(id) {
    const { rows } = await query<{ password_hash: string }>("SELECT password_hash FROM crm_users WHERE id = $1", [id]);
    return rows[0]?.password_hash ?? null;
  },

  async create(input) {
    const { rows } = await query<UserRow>(
      `INSERT INTO crm_users (id, username, name, email, phone, role, domain, status, job_title, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${COLUMNS}`,
      [input.id, input.username, input.name, input.email, input.phone, input.role, input.domain, input.status, input.jobTitle, input.passwordHash],
    );
    return toUser(rows[0]!);
  },

  async update(id, patch) {
    /* Only columns from a fixed map are interpolated; every value is bound. */
    const entries = (Object.keys(PATCH_COLUMNS) as (keyof UserPatch)[]).filter((key) => patch[key] !== undefined);
    if (entries.length === 0) return userRepository.findById(id);
    const sets = entries.map((key, index) => `${PATCH_COLUMNS[key]} = $${index + 2}`);
    const { rows } = await query<UserRow>(
      `UPDATE crm_users SET ${sets.join(", ")} WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, ...entries.map((key) => patch[key])],
    );
    return rows[0] ? toUser(rows[0]) : null;
  },

  async setPasswordHash(id, passwordHash) {
    const { rowCount } = await query("UPDATE crm_users SET password_hash = $2 WHERE id = $1", [id, passwordHash]);
    return (rowCount ?? 0) > 0;
  },

  async touchLastActive(id) {
    await query("UPDATE crm_users SET last_active_at = NOW() WHERE id = $1", [id]);
  },

  async delete(id) {
    const { rowCount } = await query("DELETE FROM crm_users WHERE id = $1", [id]);
    return (rowCount ?? 0) > 0;
  },

  async countOtherActiveSuperAdmins(excludeId) {
    const { rows } = await query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM crm_users WHERE role = 'super_admin' AND status = 'active' AND id <> $1",
      [excludeId],
    );
    return Number(rows[0]?.count ?? 0);
  },
};
