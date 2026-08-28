import { describe, expect, it } from "vitest";

import { createEnquirySchema, listEnquiriesSchema } from "@/domain/enquiry.schema";
import { validEnquiryPayload } from "../helpers/fakeRepository";

describe("createEnquirySchema", () => {
  it("accepts a well-formed enquiry and applies the defaults", () => {
    const result = createEnquirySchema.safeParse(validEnquiryPayload());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.source).toBe("website");
    expect(result.data.clientHash).toBeNull();
  });

  it("trims whitespace and lower-cases the email", () => {
    const parsed = createEnquirySchema.parse(
      validEnquiryPayload({ name: "  Aisha Rahman  ", email: "  Aisha@Example.COM " }),
    );
    expect(parsed.name).toBe("Aisha Rahman");
    expect(parsed.email).toBe("aisha@example.com");
  });

  it("normalises an omitted or blank phone number to null", () => {
    expect(createEnquirySchema.parse(validEnquiryPayload({ phone: "" })).phone).toBeNull();
    const { phone: _dropped, ...withoutPhone } = validEnquiryPayload();
    expect(createEnquirySchema.parse(withoutPhone).phone).toBeNull();
  });

  it.each([
    ["a missing name", { name: "" }],
    ["a one-character name", { name: "A" }],
    ["a malformed email", { email: "not-an-email" }],
    ["a message under 10 characters", { message: "too short" }],
    ["a message over 2000 characters", { message: "x".repeat(2001) }],
    ["a name over 100 characters", { name: "x".repeat(101) }],
    ["a malformed phone number", { phone: "abc" }],
  ])("rejects %s", (_label, override) => {
    expect(createEnquirySchema.safeParse(validEnquiryPayload(override)).success).toBe(false);
  });

  /* Header injection: these values end up in an email, where a bare CR/LF
     lets a submitter add their own headers. */
  it("rejects control characters in single-line fields", () => {
    const result = createEnquirySchema.safeParse(
      validEnquiryPayload({ name: "Aisha\r\nBcc: victim@example.com" }),
    );
    expect(result.success).toBe(false);
  });

  it("requires consent and does not coerce a falsy value into true", () => {
    for (const consent of [false, "false", undefined, 0, null]) {
      expect(createEnquirySchema.safeParse(validEnquiryPayload({ consent })).success).toBe(false);
    }
    // The two shapes a real client sends: a JSON boolean and a checkbox value.
    expect(createEnquirySchema.parse(validEnquiryPayload({ consent: "on" })).consent).toBe(true);
    expect(createEnquirySchema.parse(validEnquiryPayload({ consent: true })).consent).toBe(true);
  });

  it("ignores unknown keys rather than persisting them", () => {
    const parsed = createEnquirySchema.parse(
      validEnquiryPayload({ status: "closed", id: 999, isAdmin: true }),
    );
    expect(parsed).not.toHaveProperty("status");
    expect(parsed).not.toHaveProperty("id");
  });
});

describe("listEnquiriesSchema", () => {
  it("defaults to a bounded first page", () => {
    expect(listEnquiriesSchema.parse({})).toMatchObject({ limit: 20, offset: 0 });
  });

  it("coerces numeric query strings", () => {
    expect(listEnquiriesSchema.parse({ limit: "50", offset: "10" })).toMatchObject({
      limit: 50,
      offset: 10,
    });
  });

  it("refuses an unbounded page size", () => {
    expect(listEnquiriesSchema.safeParse({ limit: 5000 }).success).toBe(false);
    expect(listEnquiriesSchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(listEnquiriesSchema.safeParse({ status: "archived" }).success).toBe(false);
  });
});
