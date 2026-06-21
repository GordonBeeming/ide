export type DateTimeFormatId =
  | "localShort"
  | "localMedium"
  | "localLong"
  | "isoDateTime"
  | "yyyyMmDdHhMm"
  | "ddMmYyyyHhMm"
  | "mmDdYyyyHhMm"
  | "dateOnly"
  | "timeOnly";

export type RecentRelativeThresholdId =
  | "never"
  | "oneDay"
  | "twoDays"
  | "oneWeek"
  | "twoWeeks"
  | "oneMonth";

export interface DateTimeFormatOption {
  id: DateTimeFormatId;
  label: string;
  sample: string;
}

export interface RecentRelativeThresholdOption {
  id: RecentRelativeThresholdId;
  label: string;
}

export const defaultDateTimeFormat: DateTimeFormatId = "localMedium";
export const defaultRecentRelativeThreshold: RecentRelativeThresholdId = "oneWeek";

const sampleDate = new Date(Date.UTC(2026, 5, 21, 11, 30));

export const dateTimeFormatOptions: DateTimeFormatOption[] = [
  { id: "localShort", label: "Short date and time", sample: formatDate(sampleDate, "localShort") },
  { id: "localMedium", label: "Medium date and time", sample: formatDate(sampleDate, "localMedium") },
  { id: "localLong", label: "Long date and time", sample: formatDate(sampleDate, "localLong") },
  { id: "isoDateTime", label: "ISO-like", sample: formatDate(sampleDate, "isoDateTime") },
  { id: "yyyyMmDdHhMm", label: "YYYY-MM-DD HH:mm", sample: formatDate(sampleDate, "yyyyMmDdHhMm") },
  { id: "ddMmYyyyHhMm", label: "DD/MM/YYYY HH:mm", sample: formatDate(sampleDate, "ddMmYyyyHhMm") },
  { id: "mmDdYyyyHhMm", label: "MM/DD/YYYY HH:mm", sample: formatDate(sampleDate, "mmDdYyyyHhMm") },
  { id: "dateOnly", label: "Date only", sample: formatDate(sampleDate, "dateOnly") },
  { id: "timeOnly", label: "Time only", sample: formatDate(sampleDate, "timeOnly") },
];

export const recentRelativeThresholdOptions: RecentRelativeThresholdOption[] = [
  { id: "never", label: "Never" },
  { id: "oneDay", label: "Up to 1 day" },
  { id: "twoDays", label: "Up to 2 days" },
  { id: "oneWeek", label: "Up to 1 week" },
  { id: "twoWeeks", label: "Up to 2 weeks" },
  { id: "oneMonth", label: "Up to 1 month" },
];

export function sanitizeDateTimeFormat(value: unknown): DateTimeFormatId {
  return typeof value === "string" && isDateTimeFormatId(value)
    ? value
    : defaultDateTimeFormat;
}

export function sanitizeRecentRelativeThreshold(value: unknown): RecentRelativeThresholdId {
  return typeof value === "string" && isRecentRelativeThresholdId(value)
    ? value
    : defaultRecentRelativeThreshold;
}

export function formatDateTime(
  timestampMs: number | undefined,
  format: DateTimeFormatId,
  recentRelativeThreshold: RecentRelativeThresholdId = defaultRecentRelativeThreshold,
) {
  if (timestampMs === undefined) return "";
  if (shouldFormatRelative(timestampMs, recentRelativeThreshold)) {
    return relativeTimeLabel(timestampMs);
  }
  return formatDate(new Date(timestampMs), format);
}

export function formatDateTimeAbsolute(timestampMs: number | undefined) {
  if (timestampMs === undefined) return "Unknown";
  return new Date(timestampMs).toLocaleString();
}

function isDateTimeFormatId(value: string): value is DateTimeFormatId {
  return dateTimeFormatIds.has(value as DateTimeFormatId);
}

function isRecentRelativeThresholdId(value: string): value is RecentRelativeThresholdId {
  return recentRelativeThresholdIds.has(value as RecentRelativeThresholdId);
}

const dateTimeFormatIds = new Set<DateTimeFormatId>([
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

const recentRelativeThresholdIds = new Set<RecentRelativeThresholdId>([
  "never",
  "oneDay",
  "twoDays",
  "oneWeek",
  "twoWeeks",
  "oneMonth",
]);

const recentRelativeThresholdMs: Record<RecentRelativeThresholdId, number> = {
  never: 0,
  oneDay: 1000 * 60 * 60 * 24,
  twoDays: 1000 * 60 * 60 * 24 * 2,
  oneWeek: 1000 * 60 * 60 * 24 * 7,
  twoWeeks: 1000 * 60 * 60 * 24 * 14,
  oneMonth: 1000 * 60 * 60 * 24 * 30,
};

function formatDate(date: Date, format: DateTimeFormatId) {
  switch (format) {
    case "localShort":
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: "short",
        timeStyle: "short",
      }).format(date);
    case "localMedium":
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
    case "localLong":
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: "long",
        timeStyle: "short",
      }).format(date);
    case "isoDateTime":
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    case "yyyyMmDdHhMm":
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    case "ddMmYyyyHhMm":
      return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    case "mmDdYyyyHhMm":
      return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    case "dateOnly":
      return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
    case "timeOnly":
      return new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(date);
  }
}

function shouldFormatRelative(
  timestampMs: number,
  recentRelativeThreshold: RecentRelativeThresholdId,
) {
  const thresholdMs = recentRelativeThresholdMs[recentRelativeThreshold];
  if (thresholdMs <= 0) return false;
  return Math.abs(Date.now() - timestampMs) <= thresholdMs;
}

function relativeTimeLabel(timestampMs: number) {
  const diffMs = timestampMs - Date.now();
  const absMs = Math.abs(diffMs);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 1000 * 60 * 60 * 24 * 365],
    ["month", 1000 * 60 * 60 * 24 * 30],
    ["week", 1000 * 60 * 60 * 24 * 7],
    ["day", 1000 * 60 * 60 * 24],
    ["hour", 1000 * 60 * 60],
    ["minute", 1000 * 60],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, unitMs] of units) {
    if (absMs >= unitMs) {
      return formatter.format(Math.round(diffMs / unitMs), unit);
    }
  }
  return "just now";
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}
