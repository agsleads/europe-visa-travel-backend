/** A lead business this service handles; CRM admins and users belong to one. */
export interface Domain {
  key: string;
  name: string;
  description: string | null;
}
