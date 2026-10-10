// 番茄阶段结束提醒：用 GrokBot 表情弹出，替代原来的纯文字 toast。
//
// 为什么自己实现弹窗：系统通知（desktop_notify）只能显示标题与正文，渲染不了 GrokBot 的
// SVG 表情，而需求就是"用 Grok 表情提示"。因此应用内用一个卡片承载表情 + 文案 + 操作，
// 系统通知仍然保留——窗口不在前台时只有它能提醒到用户（见 pomodoroStore 的 systemNotify）。

import * as React from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GrokBotPet } from "@/grokbot/react";
import { resolvePetTheme, usePetPrefs } from "@/lib/petStore";
import {
  dismissPomodoroAlert,
  startNextPhaseFromAlert,
  usePomodoroAlert,
  usePomodoroConfig,
  type PomodoroAlertKind,
} from "@/lib/pomodoroStore";

/** 自动收起时长：够看清表情与文案，又不至于长期占屏 */
const AUTO_DISMISS_MS = 15_000;

/**
 * 提醒类型 → GrokBot 状态（用模块包的内置状态，与宠物浮层共用同一套表情）。
 * 三个 id 都来自 BUILTIN_STATES：celebrate / waking / surprised。
 */
const GROK_STATE_BY_ALERT: Record<PomodoroAlertKind, string> = {
  focus_done: "celebrate",
  break_done: "waking",
  restored: "surprised",
};

export function PomodoroAlert() {
  const alert = usePomodoroAlert();
  const config = usePomodoroConfig();
  const petPrefs = usePetPrefs();
  // 跟随用户在设置页选的配色，弹窗里的表情与浮层宠物保持一致
  const theme = React.useMemo(
    () => resolvePetTheme(petPrefs),
    [petPrefs.themePreset, petPrefs.theme],
  );

  // 自动收起：id 变化即重置计时（同一阶段不会重复弹，也就不会重复计时）
  const alertId = alert?.id ?? null;
  React.useEffect(() => {
    if (!alertId) return;
    const timer = window.setTimeout(() => dismissPomodoroAlert(), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [alertId]);

  if (!alert) return null;

  return (
    <div className="tk-pomodoro-alert" role="alert">
      <div className="tk-pomodoro-alert-face">
        {/* 弹窗里的 GrokBot 只做展示：不可交互、不漂浮、不注册右键 */}
        <GrokBotPet
          size={64}
          state={GROK_STATE_BY_ALERT[alert.kind]}
          theme={theme}
          float={false}
          interactive={false}
          contextMenu={false}
        />
      </div>
      <div className="tk-pomodoro-alert-body">
        <p className="tk-pomodoro-alert-title">{alert.title}</p>
        <p className="tk-pomodoro-alert-text">{alert.body}</p>
        <div className="tk-pomodoro-alert-actions">
          {/* autoStartNext 开启时下一轮已经在跑，不需要手动接续 */}
          {alert.nextPhase !== null && !config.autoStartNext && (
            <Button type="button" size="sm" onClick={() => startNextPhaseFromAlert()}>
              开始下一轮
            </Button>
          )}
          <Button type="button" size="sm" variant="outline" onClick={() => dismissPomodoroAlert()}>
            知道了
          </Button>
        </div>
      </div>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="tk-pomodoro-alert-close"
        aria-label="收起提醒"
        onClick={() => dismissPomodoroAlert()}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
