import dayjs from "dayjs";
import type { Dayjs } from "dayjs";

import type { Completion } from "./api";

/**
 * ISO 周起点：周一 00:00（本地时间）。
 * 手写周一锚点（dayjs .day()：周日=0…周六=6），跨年周靠纯日期运算天然正确。
 */
export function weekStartOf(date: Dayjs): Dayjs {
  return date.startOf("day").subtract((date.day() + 6) % 7, "day");
}

/** 周标题：8月24日–8月30日（跨年自然呈现，如 12月29日–1月4日） */
export function formatWeekRange(weekStart: Dayjs): string {
  return `${weekStart.format("M月D日")}–${weekStart.add(6, "day").format("M月D日")}`;
}

/** 该周完成记录（M4-1 起数据源为 completions）：done_at 落在 [周一, 下周一)，按完成时间正序 */
export function completedInWeek(
  completions: Completion[],
  weekStart: Dayjs,
): Completion[] {
  const weekEnd = weekStart.add(7, "day");
  return completions
    .map((completion) => ({
      completion,
      doneAt: dayjs(completion.doneAt),
    }))
    .filter(({ doneAt }) => !doneAt.isBefore(weekStart) && doneAt.isBefore(weekEnd))
    .sort((first, second) => first.doneAt.valueOf() - second.doneAt.valueOf())
    .map(({ completion }) => completion);
}

/**
 * 周报纯文本（docs/01 5.4 节）：首行「本周完成：」，其后每行「· 标题」。
 * 不带日期、不筛选任务类型。
 */
export function buildReportText(weekCompletions: Completion[]): string {
  return [
    "本周完成：",
    ...weekCompletions.map((completion) => `· ${completion.title}`),
  ].join("\n");
}
