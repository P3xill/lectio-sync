import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { LectioParserError, parseLectioActivityDetails, parseLectioSchedule } from "../src/core/parser";

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("parseLectioSchedule", () => {
  it("parses confirmed, cancelled, and changed Lectio modules", async () => {
    const result = parseLectioSchedule(await fixture("schedule.html"));
    expect(result.structuralMarkers).toBeGreaterThan(0);
    expect(result.events).toHaveLength(3);
    expect(result.events[0]).toMatchObject({
      sourceId: "absid:1001",
      title: "3x Mathematics",
      start: "2026-08-10T08:15:00",
      end: "2026-08-10T09:00:00",
      className: "3x MA",
      location: "201",
      teacher: "AB",
      homework: "Read chapter 2",
      status: "confirmed"
    });
    expect(result.events[1]).toMatchObject({ sourceId: "aftaleid:2002", status: "cancelled", title: "English" });
    expect(result.events[2]).toMatchObject({ sourceId: "proeveholdid:3003", status: "changed", title: "Exam team" });
  });

  it("accepts a structurally valid empty week", async () => {
    expect(parseLectioSchedule(await fixture("empty-schedule.html")).events).toEqual([]);
  });

  it("classifies login HTML as authentication required", async () => {
    const html = await fixture("login.html");
    expect(() => parseLectioSchedule(html)).toThrowError(
      expect.objectContaining<Partial<LectioParserError>>({ code: "AUTH_REQUIRED" })
    );
  });

  it("classifies a redirect URL as authentication required before parsing", () => {
    expect(() => parseLectioSchedule("<html></html>", "https://broker.unilogin.dk/auth/realms/broker"))
      .toThrowError(expect.objectContaining<Partial<LectioParserError>>({ code: "AUTH_REQUIRED" }));
  });

  it("rejects unrelated or changed markup instead of returning an empty schedule", () => {
    expect(() => parseLectioSchedule("<html><body>Maintenance</body></html>"))
      .toThrowError(expect.objectContaining<Partial<LectioParserError>>({ code: "UNEXPECTED_PAGE" }));
  });

  it("skips malformed bricks without a stable source id or time", () => {
    const html = '<table class="s2skema"><tr><td data-date="2026-08-10"><a class="s2skemabrik">Bad</a></td></tr></table>';
    expect(parseLectioSchedule(html).events).toEqual([]);
  });

  it("rejects activity links outside the exact Lectio host", () => {
    const html = '<table class="s2skema"><tr><td data-date="2026-08-10"><a class="s2skemabrik" href="https://evil.example/activity?absid=10" data-tooltip="10/8-2026 08:00 til 09:00"><span class="s2skemabrikcontent">Math</span></a></td></tr></table>';
    expect(parseLectioSchedule(html).events).toEqual([]);
  });

  it("extracts a current Lectio tooltip title and multiline note", () => {
    const html = `<table class="s2skema"><tr><td data-date="2026-08-10">
      <a class="s2skemabrik" href="/lectio/23/aktivitet/aktivitetforside2.aspx?absid=1001"
        data-tooltip="Ændret!&#10;Slavesystemet&#10;10/8-2026 08:00 til 09:00&#10;Hold: 3x HI&#10;Lærer: MR&#10;Lokale: 25&#10;&#10;Lektier:&#10;Læs kapitel 1&#10;&#10;Note:&#10;Første linje&#10;Anden linje">
        <span class="s2skemabrikcontent">3x HI • MR • 25</span>
      </a></td></tr></table>`;
    expect(parseLectioSchedule(html).events[0]).toMatchObject({
      title: "Slavesystemet",
      homework: "Læs kapitel 1",
      note: "Første linje\nAnden linje"
    });
  });
});

describe("parseLectioActivityDetails", () => {
  it("extracts the activity title and note without copying lesson materials", async () => {
    const result = parseLectioActivityDetails(await fixture("activity-detail.html"));
    expect(result).toMatchObject({
      title: "Oldtidskundskab – Hvad er det?",
      note: "Kære 3x så er det blevet tid old! Jeg glæder mig til at møde jer alle! Vi kører en introduktion til faget i dag."
    });
    expect(result.note).not.toContain("Afsnit");
  });

  it("supports labelled Lectio activity fields", () => {
    const html = '<main><dl><dt>Titel</dt><dd>Introduktion</dd><dt>Note</dt><dd>Velkommen til faget.</dd></dl><h2>Lektier</h2><p>Kapitel 1</p></main>';
    expect(parseLectioActivityDetails(html)).toMatchObject({ title: "Introduktion", note: "Velkommen til faget." });
  });

  it("supports the current aktivitetforside heading and note textarea", () => {
    const html = `<main>
      <div class="s2skemabrikcontent OnlyDesktop">ma 12/1 1. modul - 1x HI • MR • 25 - <span class="s2skemabrik-std-title">Vikingetogter</span></div>
      <textarea id="s_m_Content_Content_tocAndToolbar_ActNoteTB_tb" class="activity-note">Spørgsmål til pararbejde i timen.</textarea>
      <h1>Lektier</h1><p>VIKINGETIDEN læseplan.docx</p>
    </main>`;
    expect(parseLectioActivityDetails(html)).toMatchObject({
      title: "Vikingetogter",
      note: "Spørgsmål til pararbejde i timen."
    });
  });

  it("fails closed on login and unrelated pages", async () => {
    const login = await fixture("login.html");
    expect(() => parseLectioActivityDetails(login))
      .toThrowError(expect.objectContaining<Partial<LectioParserError>>({ code: "AUTH_REQUIRED" }));
    expect(() => parseLectioActivityDetails("<html><body>Maintenance</body></html>"))
      .toThrowError(expect.objectContaining<Partial<LectioParserError>>({ code: "UNEXPECTED_PAGE" }));
  });
});
