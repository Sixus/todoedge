import dayjs, { Dayjs } from "dayjs";

import type { Task } from "./api";

type TaskBucket = 0 | 1 | 2 | 3;

function getBucket(task: Task, now: Dayjs, todayStart: Dayjs, tomorrowStart: Dayjs): TaskBucket {
  if (task.done) {
    return 3;
  }

  if (!task.remindAt) {
    return 2;
  }

  const remindAt = dayjs(task.remindAt);
  if (remindAt.isBefore(now)) {
    return 0;
  }

  if (!remindAt.isBefore(todayStart) && remindAt.isBefore(tomorrowStart)) {
    return 1;
  }

  return 2;
}

function compareDates(first: string, second: string): number {
  const difference = dayjs(first).valueOf() - dayjs(second).valueOf();
  return Number.isNaN(difference) ? 0 : difference;
}

/**
 * 分区内排序：双方都有手动顺序（sort_order，拖拽时全分区写入）就按手动序；
 * 任一方没有（如新建任务）则回退默认规则，避免打乱未拖拽清单的既有顺序。
 */

/** 按本地时间规则生成清单顺序，原数组不会被修改。 */
export function sortTasks(tasks: Task[], now = dayjs()): Task[] {
  const todayStart = now.startOf("day");
  const tomorrowStart = todayStart.add(1, "day");

  return [...tasks].sort((first, second) => {
    const firstBucket = getBucket(first, now, todayStart, tomorrowStart);
    const secondBucket = getBucket(second, now, todayStart, tomorrowStart);

    if (firstBucket !== secondBucket) {
      return firstBucket - secondBucket;
    }

    // 手动顺序只在同分区内生效（待办/已完成互不越界，docs/05 用户反馈）
    const manualOrder =
      first.sortOrder !== null && second.sortOrder !== null
        ? first.sortOrder - second.sortOrder
        : null;
    if (manualOrder !== null && manualOrder !== 0) {
      return manualOrder;
    }

    if (firstBucket === 0 || firstBucket === 1) {
      const firstRemindAt = first.remindAt ?? first.createdAt;
      const secondRemindAt = second.remindAt ?? second.createdAt;
      const reminderOrder = compareDates(firstRemindAt, secondRemindAt);
      if (reminderOrder !== 0) {
        return reminderOrder;
      }
    } else {
      const createdOrder = compareDates(first.createdAt, second.createdAt);
      if (createdOrder !== 0) {
        return createdOrder;
      }
    }

    return first.id - second.id;
  });
}
