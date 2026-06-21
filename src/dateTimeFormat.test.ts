import { describe, expect, it, vi } from "vitest";
import {
  dateTimeFormatOptions,
  defaultDateTimeFormat,
  defaultRecentRelativeThreshold,
  formatDateTime,
  recentRelativeThresholdOptions,
  sanitizeDateTimeFormat,
  sanitizeRecentRelativeThreshold,
} from "./dateTimeFormat";

describe("date and time formats", () => {
  it("exposes common date and time display options", () => {
    expect(dateTimeFormatOptions.map((option) => option.id)).toEqual([
      "localShort",
      "localMedium",
      "localLong",
      "isoDateTime",
      "yyyyMmDdHhMm",
      "ddMmYyyyHhMm",
      "mmDdYyyyHhMm",
      "dateOnly",
      "timeOnly",
    ]);
    expect(defaultDateTimeFormat).toBe("localMedium");
  });

  it("exposes a small set of recent-relative thresholds", () => {
    expect(recentRelativeThresholdOptions.map((option) => option.id)).toEqual([
      "never",
      "oneDay",
      "twoDays",
      "oneWeek",
      "twoWeeks",
      "oneMonth",
    ]);
    expect(defaultRecentRelativeThreshold).toBe("oneWeek");
  });

  it("sanitizes unknown persisted values back to the default", () => {
    expect(sanitizeDateTimeFormat("yyyyMmDdHhMm")).toBe("yyyyMmDdHhMm");
    expect(sanitizeDateTimeFormat("relative")).toBe(defaultDateTimeFormat);
    expect(sanitizeDateTimeFormat("bogus")).toBe(defaultDateTimeFormat);
    expect(sanitizeDateTimeFormat(undefined)).toBe(defaultDateTimeFormat);
    expect(sanitizeRecentRelativeThreshold("twoDays")).toBe("twoDays");
    expect(sanitizeRecentRelativeThreshold("bogus")).toBe(defaultRecentRelativeThreshold);
  });

  it("formats fixed numeric date and time shapes", () => {
    const date = new Date(2026, 5, 21, 21, 30).getTime();

    expect(formatDateTime(date, "yyyyMmDdHhMm", "never")).toBe("2026-06-21 21:30");
    expect(formatDateTime(date, "ddMmYyyyHhMm", "never")).toBe("21/06/2026 21:30");
    expect(formatDateTime(date, "mmDdYyyyHhMm", "never")).toBe("06/21/2026 21:30");
  });

  it("formats relative dates", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 21, 21, 30));

    expect(formatDateTime(new Date(2026, 5, 21, 20, 30).getTime(), "localMedium")).toBe(
      "1 hour ago",
    );
    expect(
      formatDateTime(new Date(2026, 5, 18, 20, 30).getTime(), "localMedium", "twoDays"),
    ).not.toBe("3 days ago");
    expect(
      formatDateTime(new Date(2026, 5, 18, 20, 30).getTime(), "yyyyMmDdHhMm", "never"),
    ).toBe(
      "2026-06-18 20:30",
    );

    vi.useRealTimers();
  });
});
