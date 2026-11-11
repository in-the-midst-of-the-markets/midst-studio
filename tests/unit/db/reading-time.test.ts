import { describe, expect, test } from "bun:test";
import {
  formatRunningTime,
  formatRunningTimeRounded,
  formatUptime,
  formatUptimeToTheHour,
} from "@/lib/db/utils/reading-time";

describe("formatUptime", () => {
  test("prints days, hours and minutes", () => {
    // 90,061 seconds is the PostgreSQL overview fixture: 1 day, 1 hour and 1 minute.
    expect(formatUptime(90061)).toBe("1d 1h 1m");
    expect(formatUptime(90061.9)).toBe("1d 1h 1m");
    expect(formatUptime(3720)).toBe("1h 2m");
    expect(formatUptime(125)).toBe("2m");
    expect(formatUptime(0)).toBe("0m");
  });

  test("stops a day at the hour", () => {
    expect(formatUptimeToTheHour(86400)).toBe("1d 0h");
    expect(formatUptimeToTheHour(3720)).toBe("1h 2m");
    expect(formatUptimeToTheHour(125)).toBe("2m");
    expect(formatUptimeToTheHour(0)).toBe("0m");
  });
});

describe("formatRunningTime", () => {
  test("prints milliseconds, seconds, minutes and hours", () => {
    expect(formatRunningTime(500.6)).toBe("500.6ms");
    expect(formatRunningTime(5000)).toBe("5.0s");
    expect(formatRunningTime(65000)).toBe("1m 5s");
    expect(formatRunningTime(3720000)).toBe("1h 2m");
    expect(formatRunningTime(7260000)).toBe("2h 1m");
  });

  test("rounds only a fractional millisecond", () => {
    expect(formatRunningTimeRounded(500)).toBe("500ms");
    expect(formatRunningTimeRounded(500.6)).toBe("501ms");
    expect(formatRunningTimeRounded(999.6)).toBe("1000ms");
    expect(formatRunningTimeRounded(5000)).toBe("5.0s");
    expect(formatRunningTimeRounded(120000)).toBe("2m 0s");
  });
});
