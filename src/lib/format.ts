import dayjs, { Dayjs } from "dayjs";
import "dayjs/locale/zh-cn";

dayjs.locale("zh-cn");

/** 概览区日期行：8月31日 周一 */
export function formatOverviewDate(now: Dayjs): string {
  return now.format("M月D日 ddd");
}

/**
 * 任务行时间小字。今天（含过期）只显示 HH:mm；明天加前缀；
 * 更远带日期，日期用 9/16 短格式（用户反馈：全汉字太长）。
 */
export function formatTaskTime(remindAt: string, now: Dayjs): string {
  const remind = dayjs(remindAt);
  if (remind.isSame(now, "day")) {
    return remind.format("HH:mm");
  }
  if (remind.isSame(now.add(1, "day"), "day")) {
    return `明天 ${remind.format("HH:mm")}`;
  }
  return remind.format("M/D HH:mm");
}

/**
 * 新建任务输入框内联显示（替换闹钟按钮）：今天09:00 / 明天08:00 / 后天10:00，
 * 更远用 9/3 8:00 短格式。
 */
export function formatInlineReminder(time: Dayjs, now: Dayjs): string {
  const relative = ["今天", "明天", "后天", "大后天"].find((_, index) =>
    time.isSame(now.add(index, "day"), "day"),
  );
  if (relative) {
    return `${relative}${time.format("HH:mm")}`;
  }
  return `${time.format("M/D")} ${time.format("H:mm")}`;
}

/** 过期 = 提醒时间已过且未完成（01 文档 5.2 节） */
export function isOverdue(remindAt: string, now: Dayjs): boolean {
  return dayjs(remindAt).isBefore(now);
}
