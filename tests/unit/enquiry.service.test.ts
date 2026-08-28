import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError, NotFoundError } from "@/lib/errors";
import { createEnquiryService, type EnquiryService } from "@/services/enquiry.service";
import { createFakeRepository, toCreateEnquiry } from "../helpers/fakeRepository";

describe("enquiryService", () => {
  let repository: ReturnType<typeof createFakeRepository>;
  let service: EnquiryService;

  beforeEach(() => {
    repository = createFakeRepository();
    service = createEnquiryService(repository);
  });

  describe("create", () => {
    it("persists the enquiry and allocates a reference", async () => {
      const enquiry = await service.create(toCreateEnquiry());

      expect(enquiry.id).toBeGreaterThan(0);
      expect(enquiry.reference).toMatch(/^EVC-/);
      expect(enquiry.status).toBe("new");
      expect(repository.rows).toHaveLength(1);
    });

    it("records the moment consent was given, for UK GDPR Art. 7(1)", async () => {
      const enquiry = await service.create(toCreateEnquiry());
      expect(enquiry.consent).toBe(true);
      expect(enquiry.consentedAt).toBeInstanceOf(Date);
    });

    /* The reference is random, so collisions are possible; the unique index is
       the authority and a collision must never reach the enquirer. */
    it("retries on a reference collision instead of failing the request", async () => {
      const create = vi.spyOn(repository, "create");
      create.mockImplementationOnce(async () => {
        throw Object.assign(new Error("duplicate key value"), { code: "23505" });
      });

      const enquiry = await service.create(toCreateEnquiry());

      expect(create).toHaveBeenCalledTimes(2);
      expect(enquiry.reference).toMatch(/^EVC-/);
    });

    it("gives up after three collisions rather than looping", async () => {
      vi.spyOn(repository, "create").mockImplementation(async () => {
        throw Object.assign(new Error("duplicate key value"), { code: "23505" });
      });

      await expect(service.create(toCreateEnquiry())).rejects.toBeInstanceOf(AppError);
    });

    it("surfaces a database outage as a 503, not a 500", async () => {
      repository.failNext = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });

      await expect(service.create(toCreateEnquiry())).rejects.toMatchObject({
        status: 503,
        code: "storage_unavailable",
      });
    });

    /* The underlying driver error can carry table names, column names and the
       offending value — which for this table is the enquirer's own data. */
    it("does not leak the driver's message into the thrown error", async () => {
      repository.failNext = new Error('relation "enquiries" does not exist: aisha@example.com');

      await expect(service.create(toCreateEnquiry())).rejects.toMatchObject({
        message: "Could not save the enquiry.",
      });
    });
  });

  describe("reads", () => {
    it("throws NotFound for an unknown id or reference", async () => {
      await expect(service.getById(404)).rejects.toBeInstanceOf(NotFoundError);
      await expect(service.getByReference("EVC-NOPE00")).rejects.toBeInstanceOf(NotFoundError);
    });

    it("finds an enquiry by its reference", async () => {
      const created = await service.create(toCreateEnquiry());
      await expect(service.getByReference(created.reference)).resolves.toMatchObject({
        id: created.id,
      });
    });
  });

  describe("list", () => {
    beforeEach(async () => {
      for (let i = 0; i < 5; i++) {
        await service.create(toCreateEnquiry({ email: `person${i}@example.com` }));
      }
    });

    it("returns pagination metadata alongside the page", async () => {
      const result = await service.list({ limit: 2, offset: 0 });
      expect(result.items).toHaveLength(2);
      expect(result.pagination).toMatchObject({ total: 5, limit: 2, offset: 0, hasMore: true });
    });

    it("reports hasMore: false on the final page", async () => {
      const result = await service.list({ limit: 2, offset: 4 });
      expect(result.items).toHaveLength(1);
      expect(result.pagination.hasMore).toBe(false);
    });

    it("filters by status", async () => {
      const [first] = repository.rows;
      await service.updateStatus(first!.id, "closed");

      await expect(service.list({ status: "closed", limit: 20, offset: 0 })).resolves.toMatchObject(
        { pagination: { total: 1 } },
      );
    });
  });

  describe("updateStatus", () => {
    it("updates a known enquiry", async () => {
      const created = await service.create(toCreateEnquiry());
      await expect(service.updateStatus(created.id, "responded")).resolves.toMatchObject({
        status: "responded",
      });
    });

    it("throws NotFound rather than silently succeeding on an unknown id", async () => {
      await expect(service.updateStatus(999, "closed")).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("purge", () => {
    it("deletes only closed and spam rows past the retention window", async () => {
      const keep = await service.create(toCreateEnquiry());
      const drop = await service.create(toCreateEnquiry({ email: "old@example.com" }));

      const old = new Date(Date.now() - 400 * 86_400_000);
      for (const row of repository.rows) row.createdAt = old;
      // Only the closed one is eligible; an open enquiry is still needed.
      await service.updateStatus(drop.id, "closed");

      expect(await service.purge(365)).toBe(1);
      expect(repository.rows.map((r) => r.id)).toEqual([keep.id]);
    });
  });
});
