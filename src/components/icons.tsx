// 线性 SVG 图标，观感对齐视觉基准中的 Fluent 20 regular 细线图标。
interface IconProps {
  className?: string;
}

function base(className?: string) {
  return {
    className,
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.8,
    viewBox: "0 0 24 24",
  };
}

/** ⏰ 设提醒（输入框内；M2-3 接弹层选择器） */
export function ClockIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7.5 12 12 15 13.8" />
    </svg>
  );
}

/** ＋ 添加任务 */
export function PlusIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

/** ☑ 已完成入口（底栏，M3-1 接周报视图） */
export function CompletedIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <rect height="4" rx="1" width="8" x="8" y="2" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="m9 14 2 2 4-4" />
    </svg>
  );
}

/** ⚙ 设置入口（底栏，M2-4 接设置小窗） */
export function SettingsIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/** 勾选框内的对勾 */
export function CheckIcon({ className }: IconProps) {
  return (
    <svg {...base(className)} strokeWidth={3}>
      <polyline points="5.5 12.5 9.8 16.8 18.5 7.5" />
    </svg>
  );
}

/** 行尾删除 ×（hover 出现；点击后变红色垃圾桶做二次确认） */
export function XIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}

/** 删除二次确认状态的红色垃圾桶 */
export function TrashIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="m6 7 1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

/** 行内编辑任务（标题 + 提醒时间） */
export function EditIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M17 3.5a2.6 2.6 0 0 1 3.7 3.7L7.5 20.4 2.5 21.8l1.4-5L17 3.5Z" />
    </svg>
  );
}
