// 番茄钟设置：时长 / 长休节奏 / 自动接续 / 通知与提示音。
// 输入框用「本地文本态 + 失焦提交」：直接受控到毫秒会在输入过程中被钳制回填，体验很差。

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { DEFAULT_CONFIG, MAX_PHASE_MS, MIN_PHASE_MS } from "@/lib/pomodoro";
import {
  setPomodoroConfig,
  testPomodoroNotification,
  usePomodoroConfig,
} from "@/lib/pomodoroStore";

/** 分钟输入：失焦或回车时提交并回显钳制后的值 */
function MinuteField({
  id,
  label,
  hint,
  valueMs,
  onCommit,
}: {
  id: string;
  label: string;
  hint: string;
  valueMs: number;
  onCommit: (ms: number) => void;
}) {
  const toText = (ms: number) => String(Math.round(ms / 60_000));
  const [text, setText] = React.useState(toText(valueMs));
  React.useEffect(() => setText(toText(valueMs)), [valueMs]);
  const commit = () => {
    const minutes = Number(text);
    if (!Number.isFinite(minutes)) {
      setText(toText(valueMs));
      return;
    }
    const ms = Math.min(MAX_PHASE_MS, Math.max(MIN_PHASE_MS, Math.round(minutes * 60_000)));
    onCommit(ms);
    setText(toText(ms));
  };
  return (
    <div className="tk-pomodoro-field">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min={1}
        max={180}
        step={1}
        className="w-24"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
      <span className="tk-pomodoro-field-hint">{hint}</span>
    </div>
  );
}

export function PomodoroSettings() {
  const config = usePomodoroConfig();
  const [testing, setTesting] = React.useState(false);

  const runTest = async () => {
    setTesting(true);
    try {
      await testPomodoroNotification();
      toast.success("测试通知已发送");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="tk-panel tk-pomodoro-settings" aria-labelledby="pomodoro-settings-heading">
      <div className="tk-focus-section-heading">
        <h2 id="pomodoro-settings-heading">番茄钟设置</h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setPomodoroConfig(DEFAULT_CONFIG);
            toast.success("已恢复默认时长");
          }}
        >
          恢复默认
        </Button>
      </div>

      <div className="tk-pomodoro-form">
        <MinuteField
          id="pomodoro-focus"
          label="专注时长"
          hint="分钟（1 ~ 180）"
          valueMs={config.focusMs}
          onCommit={(ms) => setPomodoroConfig({ focusMs: ms })}
        />
        <MinuteField
          id="pomodoro-short"
          label="短休时长"
          hint="分钟（1 ~ 180）"
          valueMs={config.shortBreakMs}
          onCommit={(ms) => setPomodoroConfig({ shortBreakMs: ms })}
        />
        <MinuteField
          id="pomodoro-long"
          label="长休时长"
          hint="分钟（1 ~ 180）"
          valueMs={config.longBreakMs}
          onCommit={(ms) => setPomodoroConfig({ longBreakMs: ms })}
        />
        <MinuteField
          id="pomodoro-every"
          label="长休节奏"
          hint="每完成几轮专注后长休（1 ~ 12）"
          valueMs={config.longBreakEvery * 60_000}
          onCommit={(ms) => setPomodoroConfig({ longBreakEvery: Math.round(ms / 60_000) })}
        />

        <div className="tk-pomodoro-toggle">
          <div>
            <span className="text-sm font-medium">自动接续下一阶段</span>
            <p className="text-xs text-muted-foreground">阶段结束后自动开始下一段（关闭时停在待开始状态）。</p>
          </div>
          <Switch
            checked={config.autoStartNext}
            onCheckedChange={(checked) => setPomodoroConfig({ autoStartNext: checked })}
          />
        </div>
        <div className="tk-pomodoro-toggle">
          <div>
            <span className="text-sm font-medium">系统通知</span>
            <p className="text-xs text-muted-foreground">阶段结束时发系统通知；权限未授予时只显示应用内提示。</p>
          </div>
          <Switch checked={config.notify} onCheckedChange={(checked) => setPomodoroConfig({ notify: checked })} />
        </div>
        <div className="tk-pomodoro-toggle">
          <div>
            <span className="text-sm font-medium">提示音</span>
            <p className="text-xs text-muted-foreground">阶段结束时播放两声短音（内置合成，无音频文件）。</p>
          </div>
          <Switch checked={config.sound} onCheckedChange={(checked) => setPomodoroConfig({ sound: checked })} />
        </div>
        <div className="tk-pomodoro-toggle">
          <div>
            <span className="text-sm font-medium">测试通知</span>
            <p className="text-xs text-muted-foreground">首次使用需要授权；失败时请检查系统通知设置。</p>
          </div>
          <Button type="button" variant="outline" size="sm" disabled={testing} onClick={() => void runTest()}>
            {testing ? "发送中…" : "发送测试通知"}
          </Button>
        </div>
      </div>
    </section>
  );
}
