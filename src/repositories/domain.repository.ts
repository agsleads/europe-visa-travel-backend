import { query } from "@/db/pool";
import type { Domain } from "@/domain/domain.schema";

export interface DomainRepository {
  list(): Promise<Domain[]>;
}

export const domainRepository: DomainRepository = {
  async list() {
    const { rows } = await query<{ key: string; name: string; description: string | null }>(
      "SELECT key, name, description FROM crm_domains ORDER BY name",
    );
    return rows.map((row) => ({ key: row.key, name: row.name, description: row.description }));
  },
};
