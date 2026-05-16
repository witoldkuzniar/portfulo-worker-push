// Quiet-hours evaluation (Phase D).
//
// `notification_preferences` carries a daily window in the user's
// local timezone:
//   quiet_hours_enabled  — master on/off
//   quiet_hours_start    — "HH:mm:ss" (local)
//   quiet_hours_end      — "HH:mm:ss" (local)
//   timezone             — IANA name (e.g. "Europe/Warsaw")
//
// We evaluate at push time: convert the current instant to the
// user's local clock, parse the window's hour+minute, decide if
// "now" falls inside. The window is allowed to wrap midnight
// (22:00 → 08:00) — the canonical "evening to morning" pattern.

import type { NotificationPreferencesRow } from "./types";

/** Returns true if pushes should be suppressed for this user right
 *  now because of their quiet hours setting. False otherwise.
 *
 *  Permissive on malformed data: if the timezone is unknown to the
 *  runtime, or the time strings don't parse, we DON'T silence —
 *  the user explicitly opted in to notifications and we'd rather
 *  err on the side of delivery than on the side of silence. */
export function inQuietHours(prefs: NotificationPreferencesRow, now: Date = new Date()): boolean {
  if (!prefs.quiet_hours_enabled) return false;
  if (!prefs.quiet_hours_start || !prefs.quiet_hours_end) return false;

  const start = parseTimeOfDay(prefs.quiet_hours_start);
  const end   = parseTimeOfDay(prefs.quiet_hours_end);
  if (start === null || end === null) return false;

  // Equal start + end = "no window" (per the SQL comment + product
  // intent). User shouldn't accidentally silence themselves forever
  // by leaving both pickers at the default.
  if (start === end) return false;

  const minutesNow = currentMinutesInTimezone(now, prefs.timezone);
  if (minutesNow === null) return false;

  if (start < end) {
    // Same-day window (e.g. 13:00 → 17:00 — odd but valid).
    return minutesNow >= start && minutesNow < end;
  }
  // Wrap-around window — the common case (22:00 → 08:00).
  return minutesNow >= start || minutesNow < end;
}

/** "HH:mm[:ss]" → minutes since midnight, or null on parse failure. */
function parseTimeOfDay(s: string): number | null {
  const parts = s.split(":");
  if (parts.length < 2) return null;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

/** Convert a UTC Date to "minutes since midnight" in the user's
 *  timezone. Workers' V8 runtime ships full Intl support; we lean
 *  on Intl.DateTimeFormat to do the timezone math rather than
 *  importing a library. Returns null when the timezone string
 *  isn't recognised. */
function currentMinutesInTimezone(now: Date, timezone: string): number | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour:   "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? NaN);
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? NaN);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h * 60 + m;
  } catch {
    return null;
  }
}
