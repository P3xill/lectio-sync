import { describe, expect, it } from "vitest";
import { schoolIdFromUrl, schoolNameFromDocument, studentIdFromDocument } from "../src/core/account";

describe("schoolIdFromUrl", () => {
  it("extracts a numeric Lectio school id", () => {
    expect(schoolIdFromUrl("https://www.lectio.dk/lectio/23/forside.aspx?elevid=42")).toBe("23");
  });

  it.each([
    "https://evil.example/lectio/23/forside.aspx",
    "https://www.lectio.dk.evil.example/lectio/23/",
    "javascript:alert(1)",
    "not a url",
    "https://www.lectio.dk/lectio/not-numeric/"
  ])("rejects an untrusted or malformed URL: %s", (url) => {
    expect(schoolIdFromUrl(url)).toBeUndefined();
  });
});

describe("Lectio document discovery", () => {
  it("finds a numeric student link while ignoring malformed candidates", () => {
    const document = {
      baseURI: "https://www.lectio.dk/lectio/23/",
      querySelectorAll: () => [
        { href: "not a url" },
        { href: "https://www.lectio.dk/lectio/23/forside.aspx?elevid=text" },
        { href: "https://www.lectio.dk/lectio/23/forside.aspx?elevid=42" }
      ]
    } as unknown as Document;
    expect(studentIdFromDocument(document)).toBe("42");
  });

  it("rejects login titles and bounds a discovered school name", () => {
    expect(schoolNameFromDocument({ title: "Lectio - Log ind" } as Document)).toBeUndefined();
    expect(schoolNameFromDocument({ title: `Lectio – ${"A".repeat(140)}` } as Document)).toHaveLength(120);
    expect(studentIdFromDocument({ baseURI: "https://lectio.dk", querySelectorAll: () => [] } as unknown as Document)).toBeUndefined();
  });
});
