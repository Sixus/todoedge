import dayjs from "dayjs";
import type { Dayjs } from "dayjs";

/**
 * 中文自然语言提醒时间解析（docs/01 第 4.3 节 / docs/05 任务卡 M2-3）。
 * 规则白名单，白名单外一律返回 null（不引入 NLP 库）：
 * - 相对日：今天 / 明天 / 后天 / 大后天
 * - 星期：周X / 星期X（未来最近的那天；就在今天则下周）
 * - 时段+钟点：上午/早上/中午/下午/晚上 + N点/N点半/N点M分/N:MM
 *   （无时段的 N点（1~11 点）按上午解释，若今天该时刻已过则按下午——
 *     「3点」在上午输入=15:00，「明天9点」=09:00，与验收两条一致）
 * - 相对时长：N分钟后 / N小时后 / N天后
 * - 完整时间：HH:MM、M月d日、M月d日 HH:MM（年份取今年，已过则明年）
 * - 只写日期不写钟点：默认 09:00
 */

export interface ParsedReminder {
  time: Dayjs;
  /** 命中的原文片段（可能含一个空格分隔的两段），需从标题中剥离 */
  matchedText: string;
}

const DURATION_RE = /(\d{1,3})(分钟|小时|天)后/;

const DATE_RE =
  /(今天|明天|后天|大后天|星期[一二三四五六日天]|周[一二三四五六日天]|\d{1,2}月\d{1,2}日)/;

/** 钟点：可选时段 + N点(半|N分)?，或 N:MM（支持全角冒号） */
const CLOCK_RE =
  /(?:(上午|早上|中午|下午|晚上)\s*)?(\d{1,2})\s*点(半|(\d{1,2})分)?|(\d{1,2})[:：](\d{2})/;

const WEEKDAY_BY_CHAR: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 0,
  天: 0,
};

/** 解析失败返回 null，整句按纯标题处理 */
export function parseReminder(text: string, now: Dayjs = dayjs()): ParsedReminder | null {
  const duration = text.match(DURATION_RE);
  if (duration) {
    const amount = Number(duration[1]);
    if (amount < 1) {
      return null;
    }
    const unit = duration[2] === "分钟" ? "minute" : duration[2] === "小时" ? "hour" : "day";
    return { time: now.add(amount, unit), matchedText: duration[0] };
  }

  const dateMatch = text.match(DATE_RE);
  const clockMatch = text.match(CLOCK_RE);
  if (!dateMatch && !clockMatch) {
    return null;
  }

  const day = resolveDay(dateMatch?.[0], now);
  if (!day) {
    return null;
  }

  const clock = resolveClock(clockMatch, now, day, Boolean(dateMatch));
  if (!clock) {
    return null;
  }

  return {
    time: clock.time,
    matchedText: joinMatchedText(text, dateMatch, clockMatch),
  };
}

/** 把命中片段从标题里剥掉，剩下的作为任务标题；剥完为空则由调用方回退整句 */
export function stripReminderText(text: string, matchedText: string): string {
  let stripped = text;
  for (const part of matchedText.split(" ").filter(Boolean)) {
    stripped = stripped.replace(part, " ");
  }
  return stripped.replace(/\s+/g, " ").trim();
}

function resolveDay(dateText: string | undefined, now: Dayjs): Dayjs | null {
  if (!dateText || dateText === "今天") {
    return now.startOf("day");
  }
  if (dateText === "明天") {
    return now.add(1, "day").startOf("day");
  }
  if (dateText === "后天") {
    return now.add(2, "day").startOf("day");
  }
  if (dateText === "大后天") {
    return now.add(3, "day").startOf("day");
  }
  if (/^[周星期]/.test(dateText)) {
    const target = WEEKDAY_BY_CHAR[dateText.slice(-1)];
    // 未来最近的那天；就在今天则下周
    const delta = (target - now.day() + 7) % 7 || 7;
    return now.add(delta, "day").startOf("day");
  }
  const parts = dateText.match(/(\d{1,2})月(\d{1,2})日/);
  if (!parts) {
    return null;
  }
  const month = Number(parts[1]);
  const date = Number(parts[2]);
  if (month < 1 || month > 12 || date < 1 || date > 31) {
    return null;
  }
  // 年份取今年，已过则明年；月日组合非法（如 2月30日）直接失败
  let candidate = now.month(month - 1).date(date).startOf("day");
  if (candidate.isBefore(now.startOf("day"))) {
    candidate = candidate.add(1, "year");
  }
  if (candidate.month() !== month - 1 || candidate.date() !== date) {
    return null;
  }
  return candidate;
}

function resolveClock(
  clockMatch: RegExpMatchArray | null,
  now: Dayjs,
  day: Dayjs,
  hasDate: boolean,
): { time: Dayjs } | null {
  if (!clockMatch) {
    // 只写日期不写钟点：默认 09:00
    return { time: day.hour(9).minute(0) };
  }

  let hour: number;
  let minute: number;
  if (clockMatch[2] !== undefined) {
    hour = Number(clockMatch[2]);
    minute = clockMatch[3] === "半" ? 30 : clockMatch[3] !== undefined ? Number(clockMatch[4]) : 0;
  } else {
    hour = Number(clockMatch[5]);
    minute = Number(clockMatch[6]);
  }
  if (hour > 23 || minute > 59) {
    return null;
  }

  const period = clockMatch[1];
  if (period) {
    if (period === "下午" && hour < 12) {
      hour += 12;
    } else if (period === "晚上") {
      // 晚上12点按午夜 00:00 理解，其余同下午
      hour = hour === 12 ? 0 : hour < 12 ? hour + 12 : hour;
    } else if ((period === "上午" || period === "早上") && hour === 12) {
      hour = 0;
    }
    // 中午按字面（中午12点 = 12:00）
  } else if (
    clockMatch[2] !== undefined &&
    hour >= 1 &&
    hour <= 11 &&
    !hasDate &&
    day.hour(hour).minute(minute).isBefore(now)
  ) {
    // 「N点」无时段：默认按上午；今天的该时刻已过则按下午（「3点」=15:00）。
    // HH:MM 是 24 小时制，不走这个启发式
    hour += 12;
  }

  let time = day.hour(hour).minute(minute);
  // 无日期部分、时间已过（如下午3点在 16 点输入）→ 明天
  if (!hasDate && time.isBefore(now)) {
    time = time.add(1, "day");
  }
  return { time };
}

/** 日期与钟点相邻（中间至多一个空格）时合并为一段原文，否则用单空格连接 */
function joinMatchedText(
  text: string,
  dateMatch: RegExpMatchArray | null,
  clockMatch: RegExpMatchArray | null,
): string {
  if (dateMatch && clockMatch) {
    const dateEnd = dateMatch.index! + dateMatch[0].length;
    const gap = clockMatch.index! - dateEnd;
    if (gap >= 0 && gap <= 1) {
      return text.slice(dateMatch.index!, clockMatch.index! + clockMatch[0].length).trim();
    }
    return `${dateMatch[0]} ${clockMatch[0]}`;
  }
  return (dateMatch ?? clockMatch)![0];
}
