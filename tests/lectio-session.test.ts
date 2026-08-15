import { beforeEach, describe, expect, it, vi } from "vitest";

const browserMock = vi.hoisted(() => ({
  tabs: {
    query: vi.fn(),
    sendMessage: vi.fn()
  }
}));

vi.mock("webextension-polyfill", () => ({ default: browserMock }));

import {
  fetchLectioPageViaTab,
  LectioSessionTabError,
  parseLectioPageRequest,
  responseFromLectioFetch
} from "../src/core/lectio-session";

describe("Safari Lectio session bridge", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts only bounded same-school Lectio fetch requests", () => {
    const current = "https://www.lectio.dk/lectio/23/forside.aspx?elevid=42";
    expect(parseLectioPageRequest({
      type: "LECTIO_FETCH_PAGE",
      url: "https://www.lectio.dk/lectio/23/SkemaNy.aspx?elevid=42",
      cache: "no-store"
    }, current)).toBeDefined();
    expect(parseLectioPageRequest({
      type: "LECTIO_FETCH_PAGE",
      url: "https://www.lectio.dk/lectio/24/SkemaNy.aspx?elevid=42",
      cache: "no-store"
    }, current)).toBeUndefined();
    expect(parseLectioPageRequest({
      type: "LECTIO_FETCH_PAGE",
      url: "https://evil.example/lectio/23/SkemaNy.aspx",
      cache: "no-store"
    }, current)).toBeUndefined();
  });

  it("routes Safari reads through a tab from the matching school", async () => {
    browserMock.tabs.query.mockResolvedValue([
      { id: 1, url: "https://www.lectio.dk/lectio/24/forside.aspx" },
      { id: 2, url: "https://www.lectio.dk/lectio/23/forside.aspx" }
    ]);
    browserMock.tabs.sendMessage.mockResolvedValue({
      status: 200,
      ok: true,
      type: "basic",
      url: "https://www.lectio.dk/lectio/23/SkemaNy.aspx?elevid=42",
      html: "<html>schedule</html>"
    });

    await expect(fetchLectioPageViaTab(
      "https://www.lectio.dk/lectio/23/SkemaNy.aspx?elevid=42",
      "no-store"
    )).resolves.toMatchObject({ ok: true, html: "<html>schedule</html>" });
    expect(browserMock.tabs.sendMessage).toHaveBeenCalledWith(2, expect.objectContaining({
      type: "LECTIO_FETCH_PAGE"
    }));
  });

  it("reports an actionable error when no matching Lectio tab is open", async () => {
    browserMock.tabs.query.mockResolvedValue([]);
    await expect(fetchLectioPageViaTab(
      "https://www.lectio.dk/lectio/23/SkemaNy.aspx?elevid=42",
      "no-store"
    )).rejects.toBeInstanceOf(LectioSessionTabError);
  });

  it("rejects a response larger than the Lectio safety limit", async () => {
    await expect(responseFromLectioFetch(new Response("A".repeat(2_000_001)))).rejects.toThrow(
      "too large"
    );
  });
});
