import { createUserSchema } from "@/domain/user.schema";
import { closePool } from "@/db/pool";
import { logger } from "@/lib/logger";
import { createUserService } from "@/services/user.service";

/**
 * Creates a CRM super admin. Needed once, to bootstrap: super admins create
 * domain admins from inside the CRM, and admins create their users.
 *
 *   CRM_ADMIN_PASSWORD='…' npx tsx src/db/create-crm-admin.ts <username> <email> "<name>" ["<phone>"]
 *   CRM_ADMIN_PASSWORD='…' node dist/db/create-crm-admin.js <username> <email> "<name>" ["<phone>"]
 *
 * The password comes from the environment rather than an argument so it does
 * not land in shell history or the process list.
 */
async function main() {
  const [username, email, name, phone] = process.argv.slice(2);
  const parsed = createUserSchema.safeParse({
    username,
    email,
    name,
    phone: phone ?? null,
    role: "super_admin",
    domain: null,
    status: "active",
    password: process.env.CRM_ADMIN_PASSWORD ?? "",
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) console.error(`${issue.path.join(".")}: ${issue.message}`);
    console.error('Usage: CRM_ADMIN_PASSWORD=… create-crm-admin <username> <email> "<name>" ["<phone>"]');
    process.exitCode = 1;
    return;
  }
  const user = await createUserService().create(parsed.data);
  console.log(`Created super admin "${user.username}" <${user.email}> (${user.id}).`);
}

if (require.main === module) {
  main()
    .catch((error: unknown) => {
      logger.error({ err: error }, "Could not create the super admin");
      console.error((error as Error).message);
      process.exitCode = 1;
    })
    .finally(() => void closePool());
}
