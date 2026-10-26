import type { User } from "@/domain/user.schema";
import type { UserRepository } from "@/repositories/user.repository";

/** In-memory users with the Postgres repository's contract, including the case-insensitive unique email. */
export function createFakeUserRepository(): UserRepository & { rows: (User & { passwordHash: string })[] } {
  const rows: (User & { passwordHash: string })[] = [];
  const publicView = ({ passwordHash: _hash, ...user }: User & { passwordHash: string }): User => {
    void _hash;
    return { ...user };
  };
  const byId = (id: string) => rows.find((r) => r.id === id);
  const duplicate = (constraint: string) => Object.assign(new Error("duplicate key value"), { code: "23505", constraint });
  const knownDomains = ["evc", "roadcover", "autoinsurance"];
  const clash = (candidate: { username?: string; email?: string; domain?: string | null }, ignoreId?: string) => {
    // Mirrors the foreign key to crm_domains.
    if (candidate.domain && !knownDomains.includes(candidate.domain)) {
      throw Object.assign(new Error("foreign key violation"), { code: "23503" });
    }
    const others = rows.filter((r) => r.id !== ignoreId);
    if (candidate.username && others.some((r) => r.username === candidate.username)) {
      throw duplicate("crm_users_username_unique_idx");
    }
    if (candidate.email && others.some((r) => r.email.toLowerCase() === candidate.email!.toLowerCase())) {
      throw duplicate("crm_users_email_unique_idx");
    }
  };

  return {
    rows,
    async list({ q, role, status, domain }) {
      const needle = q?.toLowerCase();
      return rows
        .filter((r) => (!role || r.role === role) && (!status || r.status === status) && (!domain || r.domain === domain))
        .filter(
          (r) =>
            !needle ||
            r.name.toLowerCase().includes(needle) ||
            r.email.toLowerCase().includes(needle) ||
            r.username.includes(needle),
        )
        .map(publicView);
    },
    async findById(id) {
      const row = byId(id);
      return row ? publicView(row) : null;
    },
    async findCredentials(login) {
      const needle = login.toLowerCase();
      const row = rows.find((r) => r.username === needle || r.email.toLowerCase() === needle);
      return row ? { user: publicView(row), passwordHash: row.passwordHash } : null;
    },
    async findPasswordHash(id) {
      return byId(id)?.passwordHash ?? null;
    },
    async create(input) {
      clash(input);
      const now = new Date();
      const row = { ...input, avatarUrl: null, lastActiveAt: null, createdAt: now, updatedAt: now };
      rows.push(row);
      return publicView(row);
    },
    async update(id, patch) {
      const row = byId(id);
      if (!row) return null;
      clash(patch, id);
      for (const [key, value] of Object.entries(patch)) if (value !== undefined) Object.assign(row, { [key]: value });
      row.updatedAt = new Date();
      return publicView(row);
    },
    async setPasswordHash(id, passwordHash) {
      const row = byId(id);
      if (!row) return false;
      row.passwordHash = passwordHash;
      return true;
    },
    async touchLastActive(id) {
      const row = byId(id);
      if (row) row.lastActiveAt = new Date();
    },
    async delete(id) {
      const index = rows.findIndex((r) => r.id === id);
      if (index === -1) return false;
      rows.splice(index, 1);
      return true;
    },
    async countOtherActiveSuperAdmins(excludeId) {
      return rows.filter((r) => r.id !== excludeId && r.role === "super_admin" && r.status === "active").length;
    },
  };
}

export function validUserPayload(overrides: Record<string, unknown> = {}) {
  return {
    username: "sarah",
    name: "Sarah Chen",
    email: "sarah.chen@example.com",
    phone: "+44 7700 900123",
    role: "user",
    domain: "evc",
    status: "active",
    jobTitle: "Visa Consultant",
    password: "Secret123",
    ...overrides,
  };
}
