export type ActivityDay = {
  date: string;
  count: number;
};

export type ActivityLevel = 0 | 1 | 2 | 3 | 4;

export type HeatCell = {
  date: string;
  count: number;
  inRange: boolean;
  level: ActivityLevel;
};

export type HeatWeek = {
  monthLabel: string;
  days: HeatCell[];
};

export type ActivityCalendar = {
  weeks: HeatWeek[];
  total: number;
  label: string;
  years: number[];
};

const MONTH_LABELS = ["", "1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];

export function shanghaiToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return next.toISOString().slice(0, 10);
}

function weekdayMondayZero(iso: string): number {
  const [year, month, day] = iso.split("-").map(Number);
  const sundayZero = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return sundayZero === 0 ? 6 : sundayZero - 1;
}

function mondayOnOrBefore(iso: string): string {
  return addDays(iso, -weekdayMondayZero(iso));
}

function sundayOnOrAfter(iso: string): string {
  return addDays(iso, 6 - weekdayMondayZero(iso));
}

export function activityLevel(count: number, max: number): ActivityLevel {
  if (count <= 0) return 0;
  if (max <= 1) return 4;
  const ratio = count / max;
  if (ratio >= 0.75) return 4;
  if (ratio >= 0.5) return 3;
  if (ratio >= 0.25) return 2;
  return 1;
}

export function listActivityYears(days: ActivityDay[], today = shanghaiToday()): number[] {
  const current = Number(today.slice(0, 4));
  const years = new Set<number>([current]);
  for (const day of days) {
    const year = Number(day.date.slice(0, 4));
    if (year >= 2000 && year <= current + 1) years.add(year);
  }
  return [...years].sort((a, b) => b - a);
}

export function buildActivityCalendar(
  days: ActivityDay[],
  selectedYear: number,
  today = shanghaiToday(),
): ActivityCalendar {
  const currentYear = Number(today.slice(0, 4));
  const trailing = selectedYear === currentYear;
  const end = trailing ? sundayOnOrAfter(today) : sundayOnOrAfter(`${selectedYear}-12-31`);
  const start = trailing ? addDays(mondayOnOrBefore(today), -52 * 7) : mondayOnOrBefore(`${selectedYear}-01-01`);
  const counts = new Map(days.map((day) => [day.date, day.count]));

  const cells: Array<Omit<HeatCell, "level">> = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
    const inRange = trailing
      ? cursor >= start && cursor <= today
      : cursor >= `${selectedYear}-01-01` && cursor <= `${selectedYear}-12-31` && cursor <= today;
    cells.push({
      date: cursor,
      count: inRange ? counts.get(cursor) ?? 0 : 0,
      inRange,
    });
  }

  const max = cells.reduce((peak, cell) => (cell.inRange ? Math.max(peak, cell.count) : peak), 0);
  const leveled: HeatCell[] = cells.map((cell) => ({
    ...cell,
    level: cell.inRange ? activityLevel(cell.count, max) : 0,
  }));

  const weeks: HeatWeek[] = [];
  let previousMonth = "";
  for (let index = 0; index < leveled.length; index += 7) {
    const weekDays = leveled.slice(index, index + 7);
    const month = weekDays[0]?.date.slice(5, 7) ?? "";
    const monthLabel = month !== previousMonth ? MONTH_LABELS[Number(month)] ?? "" : "";
    previousMonth = month;
    weeks.push({ monthLabel, days: weekDays });
  }

  const total = leveled.reduce((sum, cell) => (cell.inRange ? sum + cell.count : sum), 0);
  return {
    weeks,
    total,
    label: trailing ? "最近一年" : `${selectedYear}年`,
    years: listActivityYears(days, today),
  };
}
