import { randomBytes } from "node:crypto";

import type { CreateUser, ListUsersQuery, UpdateUser, User } from "@/domain/user.schema";
import { AppError, NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getDummyHash, hashPassword, verifyPassword } from "@/lib/password";
import { UNIQUE_VIOLATION, USERNAME_INDEX, userRepository, type UserRepository } from "@/repositories/user.repository";

/** `usr_` plus 16 lower-case base32 characters: unguessable and URL-safe. */
export function generateUserId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = randomBytes(16);
  let id = "usr_";
  for (const byte of bytes) id += alphabet[byte % 32];
  return id;
}

/**
 * Turns a unique-index violation into a 409 naming the field that clashed, in
 * the same `details.fieldErrors` shape as a 422 so a form can show it inline.
 */
function conflictFrom(error: unknown): AppError | null {
  const { code, constraint } = error as { code?: string; constraint?: string };
  if (code !== UNIQUE_VIOLATION) return null;
  const [field, message] =
    constraint === USERNAME_INDEX
      ? ["username", "That username is already taken."]
      : ["email", "A user with this email already exists."];
  return new AppError(message, { status: 409, code: "conflict", details: { fieldErrors: { [field]: message } } });
}

/**
 * Business rules for CRM users.
 *
 * The one invariant guarded here is that the workspace always keeps at least
 * one active admin: deleting, deactivating or demoting the last one would
 * leave nobody able to manage users, with no way back short of the database.
 */
export function createUserService(repository: UserRepository = userRepository) {
  async function requireUser(id: string): Promise<User> {
    const user = await repository.findById(id);
    if (!user) throw new NotFoundError(`No user with id ${id}.`);
    return user;
  }

  async function assertNotLastAdmin(user: User, action: string) {
    if (user.role !== "admin" || user.status !== "active") return;
    if ((await repository.countOtherActiveAdmins(user.id)) === 0) {
      throw new AppError(`You can't ${action} the last active admin.`, { status: 409, code: "last_admin" });
    }
  }

  return {
    list(query: ListUsersQuery) {
      return repository.list(query);
    },

    get(id: string) {
      return requireUser(id);
    },

    async create(input: CreateUser): Promise<User> {
      try {
        const user = await repository.create({
          id: generateUserId(),
          username: input.username,
          name: input.name,
          email: input.email,
          phone: input.phone,
          role: input.role,
          status: input.status,
          jobTitle: input.jobTitle,
          passwordHash: await hashPassword(input.password),
        });
        logger.info({ userId: user.id, role: user.role }, "CRM user created");
        return user;
      } catch (error) {
        throw conflictFrom(error) ?? error;
      }
    },

    async update(id: string, patch: UpdateUser): Promise<User> {
      const current = await requireUser(id);
      const demoted = patch.role === "user" && current.role === "admin";
      const deactivated = patch.status === "inactive" && current.status === "active";
      if (demoted || deactivated) await assertNotLastAdmin(current, demoted ? "demote" : "deactivate");

      try {
        const updated = await repository.update(id, patch);
        if (!updated) throw new NotFoundError(`No user with id ${id}.`);
        logger.info({ userId: id, fields: Object.keys(patch) }, "CRM user updated");
        return updated;
      } catch (error) {
        throw conflictFrom(error) ?? error;
      }
    },

    async remove(id: string): Promise<void> {
      await assertNotLastAdmin(await requireUser(id), "delete");
      await repository.delete(id);
      logger.info({ userId: id }, "CRM user deleted");
    },

    /** Admin reset: no proof of the old password. */
    async setPassword(id: string, password: string): Promise<void> {
      await requireUser(id);
      await repository.setPasswordHash(id, await hashPassword(password));
      logger.info({ userId: id }, "CRM user password reset");
    },

    /** Self-service change: the current password must match. */
    async changePassword(id: string, currentPassword: string, newPassword: string): Promise<void> {
      const stored = await repository.findPasswordHash(id);
      if (stored === null) throw new NotFoundError(`No user with id ${id}.`);
      if (!(await verifyPassword(currentPassword, stored))) {
        throw new AppError("Current password is incorrect.", { status: 400, code: "invalid_password" });
      }
      await repository.setPasswordHash(id, await hashPassword(newPassword));
      logger.info({ userId: id }, "CRM user changed password");
    },

    /**
     * Checks a sign-in by username or email. The same error covers an unknown
     * account and a wrong password, and an unknown account is still checked
     * against a real hash, so neither the message nor the timing reveals which
     * accounts exist.
     */
    async authenticate(login: string, password: string): Promise<User> {
      const found = await repository.findCredentials(login);
      const valid = await verifyPassword(password, found?.passwordHash ?? (await getDummyHash()));
      if (!found || !valid) {
        throw new AppError("Incorrect username, email or password.", { status: 401, code: "invalid_credentials" });
      }
      if (found.user.status !== "active") {
        throw new AppError("This account has been deactivated. Contact your administrator.", {
          status: 403,
          code: "account_inactive",
        });
      }
      await repository.touchLastActive(found.user.id);
      return { ...found.user, lastActiveAt: new Date() };
    },
  };
}

export type UserService = ReturnType<typeof createUserService>;
