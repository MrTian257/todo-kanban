import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getWorkflow, saveWorkflow } from "@/lib/workflow";
import { newId } from "@/lib/utils";

/** 任务详情里的提醒设置：同一任务只保留一条提醒，重新设置即覆盖。 */
export function TaskReminder({ todoId }: { todoId: string }) {
  const [at, setAt] = useState("");
  const [busy, setBusy] = useState(false);
  const set = async () => {
    const time = new Date(at).getTime();
    if (!Number.isFinite(time) || time <= Date.now()) {
      toast.error("请选择未来的提醒时间");
      return;
    }
    setBusy(true);
    try {
      const current = getWorkflow();
      await saveWorkflow({
        ...current,
        reminders: [...current.reminders.filter(reminder => reminder.todoId !== todoId), { id: newId(), todoId, at: time, deliveredAt: null }],
      });
      setAt("");
      toast.success(getWorkflow().remindersEnabled ? "提醒已设置" : "提醒已保存，请在工作流页面启用系统通知");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="text-sm" htmlFor={`reminder-${todoId}`}>
        提醒时间
      </label>
      <Input id={`reminder-${todoId}`} type="datetime-local" className="w-auto" value={at} onChange={event => setAt(event.target.value)} />
      <Button type="button" size="sm" variant="outline" disabled={busy || !at} onClick={() => void set()}>
        设置提醒
      </Button>
    </div>
  );
}
