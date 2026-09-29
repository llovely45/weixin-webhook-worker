const FREQUENCIES = new Set(["once", "daily", "monthly", "yearly"]);
const DEFAULT_TIMEZONE = "Asia/Shanghai";
const FORMATTERS = new Map();

function formatterFor(timezone) {
  let formatter = FORMATTERS.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    FORMATTERS.set(timezone, formatter);
  }
  return formatter;
}

function localParts(timestamp, timezone) {
  const values = Object.fromEntries(
    formatterFor(timezone).formatToParts(new Date(timestamp))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
  };
}

function localMinuteValue(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}

function sameLocalMinute(left, right) {
  return left.year === right.year && left.month === right.month && left.day === right.day &&
    left.hour === right.hour && left.minute === right.minute;
}

function timezoneOffsets(naiveUtc, timezone) {
  const offsets = new Set();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const sample = Math.floor((naiveUtc + hours * 60 * 60_000) / 60_000) * 60_000;
    offsets.add(localMinuteValue(localParts(sample, timezone)) - sample);
  }
  return offsets;
}

function resolveLocalMinute(parts, timezone, offsets) {
  const naiveUtc = localMinuteValue(parts);
  const matches = [];
  for (const offset of offsets) {
    const candidate = naiveUtc - offset;
    if (sameLocalMinute(localParts(candidate, timezone), parts)) matches.push(candidate);
  }
  return matches.length ? Math.min(...matches) : null;
}

function parseLocalDateTime(value) {
  if (typeof value !== "string") throw new Error("invalid_reminder_time");
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value);
  if (!match) throw new Error("invalid_reminder_time");
  const [, yearValue, monthValue, dayValue, hourValue, minuteValue] = match;
  const parts = {
    year: Number(yearValue),
    month: Number(monthValue),
    day: Number(dayValue),
    hour: Number(hourValue),
    minute: Number(minuteValue),
  };
  const calendarCheck = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (
    parts.year < 1970 || parts.month < 1 || parts.month > 12 ||
    calendarCheck.getUTCFullYear() !== parts.year ||
    calendarCheck.getUTCMonth() + 1 !== parts.month || calendarCheck.getUTCDate() !== parts.day ||
    parts.hour > 23 || parts.minute > 59
  ) {
    throw new Error("invalid_reminder_time");
  }
  return parts;
}

function addLocalMinutes(parts, amount) {
  const date = new Date(localMinuteValue(parts) + amount * 60_000);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
  };
}

function resolveScheduledTime(parts, timezone) {
  const offsets = timezoneOffsets(localMinuteValue(parts), timezone);
  const exact = resolveLocalMinute(parts, timezone, offsets);
  if (exact !== null) return exact;

  // If a daylight-saving jump removes this local time, move it to the first
  // valid wall-clock minute after the gap. Ambiguous times use the earlier one.
  for (let minutes = 1; minutes <= 180; minutes += 1) {
    const adjusted = addLocalMinutes(parts, minutes);
    const resolved = resolveLocalMinute(adjusted, timezone, offsets);
    if (resolved !== null) return resolved;
  }
  throw new Error("invalid_reminder_time");
}

export function buildReminderSchedule(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("invalid_reminder_schedule");
  }
  const allowed = new Set(["at", "frequency", "timezone"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error("invalid_reminder_schedule");

  const frequency = input.frequency === undefined ? "once" : input.frequency;
  if (typeof frequency !== "string" || !FREQUENCIES.has(frequency)) {
    throw new Error("invalid_reminder_frequency");
  }
  const timezone = input.timezone === undefined ? DEFAULT_TIMEZONE : input.timezone;
  if (typeof timezone !== "string" || !timezone || timezone.length > 100) {
    throw new Error("invalid_reminder_timezone");
  }

  const parts = parseLocalDateTime(input.at);
  try {
    formatterFor(timezone);
  } catch {
    throw new Error("invalid_reminder_timezone");
  }

  return {
    nextRunAt: resolveScheduledTime(parts, timezone),
    frequency,
    timezone,
    anchorYear: parts.year,
    anchorMonth: parts.month,
    anchorDay: parts.day,
    localHour: parts.hour,
    localMinute: parts.minute,
  };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function buildDate(year, month, day, hour, minute, timezone) {
  return resolveScheduledTime({ year, month, day, hour, minute }, timezone);
}

function nextMonth(year, month) {
  const date = new Date(Date.UTC(year, month, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

export function nextReminderOccurrence(reminder, after = Date.now()) {
  const current = localParts(after, reminder.timezone);
  const { localHour: hour, localMinute: minute, timezone } = reminder;

  if (reminder.frequency === "daily") {
    for (let delta = 0; delta <= 2; delta += 1) {
      const date = new Date(Date.UTC(current.year, current.month - 1, current.day + delta));
      const candidate = buildDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute, timezone);
      if (candidate > after) return candidate;
    }
  } else if (reminder.frequency === "monthly") {
    let year = current.year;
    let month = current.month;
    for (let delta = 0; delta <= 2; delta += 1) {
      const day = Math.min(reminder.anchorDay, daysInMonth(year, month));
      const candidate = buildDate(year, month, day, hour, minute, timezone);
      if (candidate > after) return candidate;
      ({ year, month } = nextMonth(year, month));
    }
  } else if (reminder.frequency === "yearly") {
    for (let delta = 0; delta <= 2; delta += 1) {
      const year = current.year + delta;
      const day = Math.min(reminder.anchorDay, daysInMonth(year, reminder.anchorMonth));
      const candidate = buildDate(year, reminder.anchorMonth, day, hour, minute, timezone);
      if (candidate > after) return candidate;
    }
  }

  throw new Error("reminder_next_occurrence_unavailable");
}

export function formatReminderLocalTime(timestamp, timezone) {
  const parts = localParts(timestamp, timezone);
  const pad = (value) => String(value).padStart(2, "0");
  return `${String(parts.year).padStart(4, "0")}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function formatReminderAnchor(reminder) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${String(reminder.anchorYear).padStart(4, "0")}-${pad(reminder.anchorMonth)}-${pad(reminder.anchorDay)}T${pad(reminder.localHour)}:${pad(reminder.localMinute)}`;
}
