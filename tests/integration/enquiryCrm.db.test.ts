import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePool, query } from "@/db/pool";
import { migrate } from "@/db/migrate";
import type { ListEnquiriesQuery } from "@/domain/enquiry.schema";
import { enquiryRepository } from "@/repositories/enquiry.repository";
import { createEnquiryService } from "@/services/enquiry.service";
import { toCreateEnquiry } from "../helpers/fakeRepository";

/**
 * The CRM half of the schema against real PostgreSQL: the sort expressions,
 * the derived follow-up column, the stats aggregates, the row-locked
 * reassignment and the cascades. Skipped unless TEST_DATABASE_URL is set; see
 * enquiries.db.test.ts for how to run it.
 */
const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeDb("enquiry CRM (PostgreSQL)", () => {
  const service = createEnquiryService(enquiryRepository);
  const ALEX = { id: "usr_1", name: "Alex Morgan" };
  const SARAH = { id: "usr_3", name: "Sarah Chen" };
  const MARCUS = { id: "usr_4", name: "Marcus Johnson" };

  const list = (overrides: Partial<ListEnquiriesQuery> = {}) =>
    service.list({ sort: "createdAt", order: "desc", limit: 20, offset: 0, ...overrides });

  beforeAll(async () => {
    await migrate(path.join(__dirname, "../../src/db/migrations"));
  }, 30_000);

  beforeEach(async () => {
    await query("TRUNCATE enquiries RESTART IDENTITY CASCADE");
  });

  afterAll(async () => {
    await closePool();
  });

  it("writes a 'created' activity in the same statement as the enquiry", async () => {
    const created = await service.create(toCreateEnquiry());
    const activities = await service.activities(created.id);

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ type: "created", description: "Enquiry received from website" });
    expect(created).toMatchObject({ status: "new", priority: "medium", assignedTo: null });
  });

  it("assigns, reassigns and unassigns with accurate history", async () => {
    const { id } = await service.create(toCreateEnquiry());

    await service.assign(id, SARAH, ALEX);
    const reassigned = await service.assign(id, MARCUS, ALEX);
    expect(reassigned.assignedTo).toEqual(MARCUS);
    expect(reassigned.assignedAt).toBeInstanceOf(Date);

    const unassigned = await service.assign(id, null, ALEX);
    expect(unassigned.assignedTo).toBeNull();
    expect(unassigned.assignedAt).toBeNull();

    const descriptions = (await service.activities(id)).map((a) => a.description);
    expect(descriptions.slice(0, 3)).toEqual([
      "Unassigned from Marcus Johnson",
      "Reassigned from Sarah Chen to Marcus Johnson",
      "Assigned to Sarah Chen",
    ]);
  });

  it("bulk-assigns in one transaction and skips rows the target already owns", async () => {
    const a = await service.create(toCreateEnquiry({ email: "a@example.com" }));
    const b = await service.create(toCreateEnquiry({ email: "b@example.com" }));
    await service.assign(a.id, SARAH, ALEX);

    const result = await service.bulkAssign([a.id, b.id, 9999], SARAH, ALEX);

    expect(result).toEqual({ updated: 1, unchanged: 1, notFound: [9999] });
    expect((await list({ assignedTo: SARAH.id })).pagination.total).toBe(2);
  });

  it("rejects a half-written assignment at the database level", async () => {
    const { id } = await service.create(toCreateEnquiry());
    await expect(
      query("UPDATE enquiries SET assigned_to_id = 'usr_9' WHERE id = $1", [id]),
    ).rejects.toThrow(/enquiries_assignee_pair_check/);
  });

  it("logs contact and stamps last_contact_at", async () => {
    const { id } = await service.create(toCreateEnquiry());
    const updated = await service.logContact(id, "whatsapp", SARAH);

    expect(updated.lastContactAt).toBeInstanceOf(Date);
    expect((await service.activities(id))[0]).toMatchObject({
      type: "whatsapp",
      actor: SARAH,
    });
  });

  it("derives next follow-up from the earliest open one and sorts on it", async () => {
    const a = await service.create(toCreateEnquiry({ email: "a@example.com", name: "Anna" }));
    const b = await service.create(toCreateEnquiry({ email: "b@example.com", name: "Ben" }));
    await service.create(toCreateEnquiry({ email: "c@example.com", name: "Cara" }));

    const inOneDay = new Date(Date.now() + 86_400_000);
    const inTwoDays = new Date(Date.now() + 2 * 86_400_000);
    const first = await service.addFollowUp(a.id, { title: "Call", dueAt: inOneDay }, SARAH);
    await service.addFollowUp(a.id, { title: "Email", dueAt: inTwoDays }, SARAH);
    await service.addFollowUp(b.id, { title: "Call", dueAt: inTwoDays }, SARAH);

    expect((await service.getById(a.id)).nextFollowUpAt?.getTime()).toBe(inOneDay.getTime());

    // Completing the earliest moves the derived value to the next open one.
    await service.setFollowUpCompleted(a.id, first.id, true, SARAH);
    expect((await service.getById(a.id)).nextFollowUpAt?.getTime()).toBe(inTwoDays.getTime());

    // Rows with no follow-up sink to the bottom in either direction.
    const asc = await list({ sort: "nextFollowUpAt", order: "asc" });
    const desc = await list({ sort: "nextFollowUpAt", order: "desc" });
    expect(asc.items.at(-1)!.name).toBe("Cara");
    expect(desc.items.at(-1)!.name).toBe("Cara");
  });

  it("sorts priority and status in business order, not alphabetically", async () => {
    for (const [email, priority] of [
      ["l@example.com", "low"],
      ["u@example.com", "urgent"],
      ["m@example.com", "medium"],
    ] as const) {
      const { id } = await service.create(toCreateEnquiry({ email }));
      await service.update(id, { priority }, SARAH);
    }

    const byPriority = await list({ sort: "priority", order: "desc" });
    expect(byPriority.items.map((e) => e.priority)).toEqual(["urgent", "medium", "low"]);
  });

  it("filters by priority, destination, visa type and date range", async () => {
    const paris = await service.create(toCreateEnquiry({ email: "p@example.com", destination: "France" }));
    await service.create(toCreateEnquiry({ email: "r@example.com", destination: "Italy", visaType: "Business" }));
    await service.update(paris.id, { priority: "high" }, SARAH);
    await query("UPDATE enquiries SET created_at = '2026-01-15T10:00:00Z' WHERE id = $1", [paris.id]);

    expect((await list({ priority: "high" })).items.map((e) => e.id)).toEqual([paris.id]);
    expect((await list({ destination: "Italy" })).pagination.total).toBe(1);
    expect((await list({ visaType: "Business" })).pagination.total).toBe(1);
    // A bare `to` date includes that whole day.
    const january = await list({ from: new Date("2026-01-01"), to: new Date("2026-01-15") });
    expect(january.items.map((e) => e.id)).toEqual([paris.id]);
  });

  it("searches phone and visa type as well as the original fields", async () => {
    await service.create(toCreateEnquiry({ email: "x@example.com", phone: "+44 7700 900123", visaType: "Student" }));

    expect((await list({ q: "900123" })).pagination.total).toBe(1);
    expect((await list({ q: "student" })).pagination.total).toBe(1);
  });

  it("computes dashboard stats over the filtered set", async () => {
    const a = await service.create(toCreateEnquiry({ email: "a@example.com", destination: "France" }));
    const b = await service.create(toCreateEnquiry({ email: "b@example.com", destination: "France" }));
    await service.create(toCreateEnquiry({ email: "c@example.com", destination: "Spain" }));
    await service.bulkAssign([a.id, b.id], SARAH, ALEX);
    await service.update(a.id, { status: "converted" }, SARAH);
    await service.update(b.id, { status: "contacted" }, SARAH);
    await service.addFollowUp(b.id, { title: "Chase", dueAt: new Date(Date.now() + 3_600_000) }, SARAH);

    const all = await service.stats();
    expect(all).toMatchObject({
      total: 3,
      assigned: 2,
      unassigned: 1,
      openFollowUps: 1,
      last7Days: 3,
      byStatus: { new: 1, contacted: 1, converted: 1 },
      byPriority: { medium: 3 },
      byDestination: [
        { destination: "France", total: 2, converted: 1 },
        { destination: "Spain", total: 1, converted: 0 },
      ],
      byAssignee: [{ assignedTo: SARAH, total: 2, contacted: 2, converted: 1, lost: 0 }],
    });
    expect(all.monthly).toHaveLength(6);
    expect(all.monthly.at(-1)).toMatchObject({ total: 3, converted: 1 });

    const sarahs = await service.stats({ assignedTo: SARAH.id });
    expect(sarahs).toMatchObject({ total: 2, unassigned: 0, openFollowUps: 1 });
  });

  it("scopes cross-enquiry follow-ups and activity to one rep", async () => {
    const mine = await service.create(toCreateEnquiry({ email: "a@example.com", name: "Mine" }));
    const theirs = await service.create(toCreateEnquiry({ email: "b@example.com", name: "Theirs" }));
    await service.assign(mine.id, SARAH, ALEX);
    await service.assign(theirs.id, MARCUS, ALEX);
    const due = new Date(Date.now() + 3_600_000);
    await service.addFollowUp(mine.id, { title: "Mine", dueAt: due }, SARAH);
    await service.addFollowUp(theirs.id, { title: "Theirs", dueAt: due }, MARCUS);

    const followUps = await service.allFollowUps({ assignedTo: SARAH.id, open: true, limit: 20 });
    expect(followUps.map((f) => [f.title, f.enquiryName])).toEqual([["Mine", "Mine"]]);

    const activity = await service.recentActivities({ assignedTo: SARAH.id, limit: 50 });
    expect(new Set(activity.map((a) => a.enquiryId))).toEqual(new Set([mine.id]));
  });

  it("maintains note updated_at through the trigger", async () => {
    const { id } = await service.create(toCreateEnquiry());
    const note = await service.addNote(id, "First draft", SARAH);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const edited = await service.updateNote(id, note.id, "Second draft");

    expect(edited.updatedAt.getTime()).toBeGreaterThan(note.updatedAt.getTime());
    expect(edited.author).toEqual(SARAH);
  });

  it("purges a lost enquiry together with its notes, follow-ups and activity", async () => {
    const { id } = await service.create(toCreateEnquiry());
    await service.addNote(id, "Gone soon", SARAH);
    await service.addFollowUp(id, { title: "Never", dueAt: new Date() }, SARAH);
    await service.update(id, { status: "lost" }, SARAH);
    await query("UPDATE enquiries SET created_at = NOW() - INTERVAL '400 days'");

    expect(await service.purge(365)).toBe(1);
    for (const table of ["enquiry_notes", "enquiry_follow_ups", "enquiry_activities"]) {
      const { rows } = await query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${table}`);
      expect(rows[0]!.count, table).toBe("0");
    }
  });

  it("keeps converted enquiries through the retention purge", async () => {
    const { id } = await service.create(toCreateEnquiry());
    await service.update(id, { status: "converted" }, SARAH);
    await query("UPDATE enquiries SET created_at = NOW() - INTERVAL '400 days'");

    expect(await service.purge(365)).toBe(0);
  });
});
