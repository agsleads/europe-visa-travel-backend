import { z } from "zod";

/**
 * The CRM user directory: the admins and consultants who work enquiries.
 */

export const USER_ROLES = ["admin", "user"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ["active", "inactive"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

const noControlChars = (v: string) => !/[\r\n\t\f\v\0]/.test(v);

const text = (max: number, required: string) =>
  z
    .string()
    .trim()
    .min(1, required)
    .max(max, `Please keep this under ${max} characters.`)
    .refine(noControlChars, "Please remove any line breaks from this field.");

const email = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Email is required.")
  .max(254, "That email address is too long.")
  .pipe(z.string().email("Enter a valid email address."));

/** Optional: "" and null both mean "no phone number". */
const phone = z
  .union([z.string(), z.null()])
  .transform((v) => (v ?? "").trim())
  .refine((v) => v === "" || /^\+?[\d\s().-]{7,30}$/.test(v), "Enter a valid phone number.")
  .transform((v) => (v === "" ? null : v));

const username = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Username must be at least 3 characters.")
  .max(50, "Username must be at most 50 characters.")
  .regex(/^[a-z0-9._-]+$/, "Use only letters, numbers, dots, underscores and hyphens.");

/** 8+ characters with upper case, lower case and a digit. Capped well above any real password. */
export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters.")
  .max(200, "Password is too long.")
  .regex(/[A-Z]/, "Include at least one uppercase letter.")
  .regex(/[a-z]/, "Include at least one lowercase letter.")
  .regex(/\d/, "Include at least one number.");

const jobTitle = z
  .string()
  .trim()
  .max(100, "Job title is too long.")
  .refine(noControlChars, "Please remove any line breaks from this field.")
  .transform((v) => (v === "" ? null : v));

/** A data URL for an uploaded image, an https URL, or null to remove it. */
const avatarUrl = z.union([
  z
    .string()
    .max(60_000, "That image is too large.")
    .refine(
      (v) => /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v) || /^https:\/\/\S+$/.test(v),
      "Avatar must be a PNG, JPEG or WebP image, or an https URL.",
    ),
  z.null(),
]);

export const createUserSchema = z.object({
  username,
  name: text(100, "Name is required.").pipe(z.string().min(2, "Name must be at least 2 characters.")),
  email,
  phone: phone.optional().default(null),
  role: z.enum(USER_ROLES).default("user"),
  status: z.enum(USER_STATUSES).default("active"),
  jobTitle: jobTitle.optional().default(""),
  password: passwordSchema,
});

export type CreateUser = z.output<typeof createUserSchema>;

export const updateUserSchema = z
  .object({
    username,
    name: text(100, "Name is required.").pipe(z.string().min(2, "Name must be at least 2 characters.")),
    email,
    phone,
    role: z.enum(USER_ROLES),
    status: z.enum(USER_STATUSES),
    jobTitle,
    avatarUrl,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field to update.", path: ["_"] });

export type UpdateUser = z.output<typeof updateUserSchema>;

export const listUsersSchema = z.object({
  q: z
    .string()
    .trim()
    .max(100, "Search terms are limited to 100 characters.")
    .optional()
    .transform((v) => (v ? v : undefined)),
  role: z.enum(USER_ROLES).optional(),
  status: z.enum(USER_STATUSES).optional(),
});

export type ListUsersQuery = z.output<typeof listUsersSchema>;

export const userIdSchema = z.object({
  id: z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid user id."),
});

/** Admin reset: sets a new password without knowing the old one. */
export const setPasswordSchema = z.object({ password: passwordSchema });

/** Self-service change: the current password must be proven. */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password.").max(200),
  newPassword: passwordSchema,
});

/** `login` is a username or an email address. */
export const authenticateSchema = z.object({
  login: z.string().trim().toLowerCase().min(1, "Enter your username or email.").max(254),
  password: z.string().min(1, "Password is required.").max(200),
});

/** A user as returned to callers. The password hash never leaves the repository. */
export interface User {
  id: string;
  username: string;
  name: string;
  email: string;
  phone: string | null;
  role: UserRole;
  status: UserStatus;
  jobTitle: string | null;
  avatarUrl: string | null;
  lastActiveAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
