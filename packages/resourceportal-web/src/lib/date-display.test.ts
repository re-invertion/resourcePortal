import { describe, expect, it } from "vitest";
import { CONSOLE_TIME_ZONE, exactConsoleDate, relativeConsoleDate } from "./date-display";

describe("§14 console timestamps", () => {
  it("uses one fixed timezone regardless of browser locale", () => {
    expect(CONSOLE_TIME_ZONE).toBe("Europe/Warsaw");
    expect(exactConsoleDate("2026-01-20T12:00:00.000Z")).toContain("13:00");
    expect(exactConsoleDate("2026-07-20T12:00:00.000Z")).toContain("14:00");
    expect(exactConsoleDate("2026-07-20T12:00:00.000Z")).toContain("(Europe/Warsaw)");
  });
  it("uses a safe placeholder for invalid or missing timestamps", () => {
    expect(exactConsoleDate(undefined)).toBe("—");
    expect(exactConsoleDate("<invalid date>")).toBe("—");
    expect(relativeConsoleDate("not-a-date")).toBe("—");
  });
  it("provides relative time without suppressing exact date", () => {
    const now = Date.parse("2026-11-22T16:00:00Z");
    expect(relativeConsoleDate("2026-11-22T15:55:00Z", now)).toMatch(/5 min/);
    expect(relativeConsoleDate("2026-11-22T16:05:00Z", now)).toMatch(/in 5 min/);
  });
});
