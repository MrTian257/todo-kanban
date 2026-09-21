// 设置 · 自定义字段：字段定义 + 自动脚本（从「工作流」拆出的独立设置项）。
// 配置存 workflow_state（revision 乐观锁）；字段值随任务保存，两者版本独立。

import { useEffect } from "react";
import { Link } from "react-router-dom";
import { AutomationsPanel } from "@/components/workflow/AutomationsPanel";
import { FieldDefsPanel } from "@/components/workflow/FieldDefsPanel";
import { isTauri } from "@/lib/storage";
import { loadWorkflow } from "@/lib/workflow";

export function FieldSettingsPage() {
  useEffect(() => { void loadWorkflow().catch(() => undefined); }, []);
  return (
    <div className="tk-page w-full space-y-6 overflow-auto pb-10">
      <Link to="/settings" className="inline-flex text-sm text-muted-foreground hover:text-primary">返回设置</Link>
      <div>
        <h1 className="tk-page-heading">自定义字段</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          在内置字段之外定义自己的属性，并用自动脚本在事件发生时写值；配置与任务数据分开保存，字段值参与变更历史与 MCP 读写。
        </p>
      </div>
      {!isTauri() && <p className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">浏览器可编辑和预览配置；自动脚本执行与补写需要桌面应用。</p>}
      <FieldDefsPanel />
      <AutomationsPanel />
    </div>
  );
}
