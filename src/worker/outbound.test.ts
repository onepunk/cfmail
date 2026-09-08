import { describe, expect, it } from "vitest";
import { recipientEmails } from "./outbound";

describe("outbound recipient normalization", () => {
  it("reads both current address objects and legacy address strings", () => {
    expect(recipientEmails(JSON.stringify([
      { name: "Liam", email: "Liam@Example.com" },
      "hello@example.com",
      { name: "Broken" },
    ]))).toEqual(["liam@example.com", "hello@example.com"]);
  });
});
