/** 产品内统一展示时区（中国标准时间） */
export const APP_TIME_ZONE = "Asia/Shanghai";

const LOCALE = "zh-CN";

const DATETIME_OPTIONS: Intl.DateTimeFormatOptions = {
  timeZone: APP_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
};

const DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  timeZone: APP_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
};

function parseDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** 日期 + 时间（Asia/Shanghai），如 2026/07/02 17:05 */
export function formatDateTimeShanghai(
  value: string | Date | null | undefined,
  fallback = "未记录",
): string {
  const parsed = parseDate(value);
  if (!parsed) {
    if (typeof value === "string" && value.trim()) return value.trim();
    return fallback;
  }
  return parsed.toLocaleString(LOCALE, DATETIME_OPTIONS);
}

/** 仅日期（Asia/Shanghai） */
export function formatDateShanghai(
  value: string | Date | null | undefined,
  fallback = "未设置",
): string {
  const parsed = parseDate(value);
  if (!parsed) {
    if (typeof value === "string" && value.trim()) return value.trim();
    return fallback;
  }
  return parsed.toLocaleDateString(LOCALE, DATE_OPTIONS);
}
