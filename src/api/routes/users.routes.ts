import { Router } from "express";

import { asyncHandler } from "@/api/middleware/asyncHandler";
import { apiKeyAuth } from "@/api/middleware/apiKeyAuth";
import { validate } from "@/api/middleware/validate";
import {
  authenticateSchema,
  changePasswordSchema,
  createUserSchema,
  listUsersSchema,
  setPasswordSchema,
  updateUserSchema,
  userIdSchema,
  type CreateUser,
  type ListUsersQuery,
  type UpdateUser,
  type User,
} from "@/domain/user.schema";
import { createUserService, type UserService } from "@/services/user.service";

/** Explicit, so a column added later is never published by accident. No password hash, ever. */
function present(user: User) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    domain: user.domain,
    status: user.status,
    jobTitle: user.jobTitle,
    avatarUrl: user.avatarUrl,
    lastActiveAt: user.lastActiveAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

type IdParams = { id: string };

/**
 * /api/v1/users — the CRM's user directory.
 *
 * Server-to-server like the enquiry endpoints: the CRM's server holds the API
 * key and calls these after it has decided the signed-in person may. Which
 * CRM user may do what (only admins manage users) is the CRM's decision; this
 * service enforces data rules — unique emails, the last active admin.
 */
export function usersRouter(service: UserService = createUserService()): Router {
  const router = Router();

  /** POST /authenticate — `{ login, password }` (username or email) → the user, or 401/403. */
  router.post(
    "/authenticate",
    apiKeyAuth,
    validate(authenticateSchema),
    asyncHandler(async (req, res) => {
      const { login, password } = req.body as { login: string; password: string };
      res.json({ data: present(await service.authenticate(login, password)) });
    }),
  );

  router.get(
    "/",
    apiKeyAuth,
    validate(listUsersSchema, "query"),
    asyncHandler(async (req, res) => {
      const users = await service.list(req.query as unknown as ListUsersQuery);
      res.json({ data: users.map(present) });
    }),
  );

  router.post(
    "/",
    apiKeyAuth,
    validate(createUserSchema),
    asyncHandler(async (req, res) => {
      const user = await service.create(req.body as CreateUser);
      res.status(201).location(`/api/v1/users/${user.id}`).json({ data: present(user) });
    }),
  );

  router.get(
    "/:id",
    apiKeyAuth,
    validate(userIdSchema, "params"),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as IdParams;
      res.json({ data: present(await service.get(id)) });
    }),
  );

  router.patch(
    "/:id",
    apiKeyAuth,
    validate(userIdSchema, "params"),
    validate(updateUserSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as IdParams;
      res.json({ data: present(await service.update(id, req.body as UpdateUser)) });
    }),
  );

  router.delete(
    "/:id",
    apiKeyAuth,
    validate(userIdSchema, "params"),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as IdParams;
      await service.remove(id);
      res.status(204).end();
    }),
  );

  /** PUT /:id/password — admin reset, `{ password }`. */
  router.put(
    "/:id/password",
    apiKeyAuth,
    validate(userIdSchema, "params"),
    validate(setPasswordSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as IdParams;
      await service.setPassword(id, (req.body as { password: string }).password);
      res.status(204).end();
    }),
  );

  /** POST /:id/password/change — self-service, `{ currentPassword, newPassword }`. */
  router.post(
    "/:id/password/change",
    apiKeyAuth,
    validate(userIdSchema, "params"),
    validate(changePasswordSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as IdParams;
      const { currentPassword, newPassword } = req.body as { currentPassword: string; newPassword: string };
      await service.changePassword(id, currentPassword, newPassword);
      res.status(204).end();
    }),
  );

  return router;
}
