// 设置：明暗、主题皮肤（5 套）、MCP 集成、附件维护、数据说明

import * as React from "react";
import { useTheme } from "next-themes";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Bot, Eye, EyeOff, Paperclip } from "lucide-react";
import { toast } from "sonner";
import { gcOrphanAttachments, migrateInlineImages } from "@/lib/attachments";
import { DEFAULT_MCP_TOKEN, mcpGetConfig, mcpSetConfig } from "@/lib/mcp";
import { useSkin, SKINS } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { dbCheckVersion, type VersionReport } from "@/lib/version";

export function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const [skin, setSkin] = useSkin();
  const [mcpEnabled, setMcpEnabled] = React.useState(true);
  const [mcpToken, setMcpToken] = React.useState(DEFAULT_MCP_TOKEN);
  const [mcpShowToken, setMcpShowToken] = React.useState(false);
  const [mcpSaving, setMcpSaving] = React.useState(false);
  const [version, setVersion] = React.useState<VersionReport | null>(null);

  React.useEffect(() => {
    mcpGetConfig()
      .then((s) => {
        setMcpEnabled(s.enabled);
        setMcpToken(s.token);
      })
      .catch(() => {
        /* 默认值兜底 */
      });
  }, []);

  // 数据版本信息（展示当前数据版本与软件支持范围）
  React.useEffect(() => {
    dbCheckVersion()
      .then(setVersion)
      .catch(() => {
        /* 非 Tauri / 检查失败不阻塞 */
      });
  }, []);

  const saveMcp = async () => {
    setMcpSaving(true);
    try {
      await mcpSetConfig({ enabled: mcpEnabled, token: mcpToken.trim() || DEFAULT_MCP_TOKEN });
      toast.success("MCP 设置已保存");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setMcpSaving(false);
    }
  };

  // 附件维护：迁移历史内嵌图片 / 清理无效附件（均带确认对话框）
  const [migrateOpen, setMigrateOpen] = React.useState(false);
  const [gcOpen, setGcOpen] = React.useState(false);
  const [maintaining, setMaintaining] = React.useState(false);

  const runMigrate = async () => {
    setMaintaining(true);
    try {
      const summary = await migrateInlineImages();
      if (summary.failedTodos.length > 0) {
        toast.warning(
          "已迁移 " + summary.migratedImages + " 张图片；" + summary.failedTodos.length + " 条任务失败（" + summary.failedTodos[0].reason + "）",
        );
      } else {
        toast.success(
          summary.scannedTodos === 0
            ? "未发现内嵌图片，无需迁移"
            : "已迁移 " + summary.migratedImages + " 张图片为附件（" + summary.scannedTodos + " 条任务）",
        );
      }
      setMigrateOpen(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setMaintaining(false);
    }
  };

  const runGc = async () => {
    setMaintaining(true);
    try {
      const summary = await gcOrphanAttachments();
      toast.success(
        summary.removedAttachments === 0
          ? "没有需要清理的附件"
          : "已清理 " + summary.removedAttachments + " 个附件（" + summary.movedFiles + " 个文件移入回收目录）",
      );
      setGcOpen(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setMaintaining(false);
    }
  };

  return (
    <div className="h-full w-full overflow-y-auto bg-background p-6">
      <h1 className="mb-4 text-xl font-semibold">设置</h1>
      <div className="w-full flex flex-wrap space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>外观</CardTitle>
            <CardDescription>明暗模式 × 主题皮肤（正交叠加）</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <span className="text-sm font-medium">明暗模式</span>
              <Select value={theme} onValueChange={(v) => setTheme(v)}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="light">浅色</SelectItem>
                  <SelectItem value="dark">深色</SelectItem>
                  <SelectItem value="system">跟随系统</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <span className="text-sm font-medium">主题皮肤</span>
              <div className="flex flex-wrap gap-2">
                {SKINS.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setSkin(s.id)}
                    className={cn(
                      "rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
                      skin === s.id && "border-primary bg-accent",
                    )}
                  >
                    <div className="font-medium">{s.name}</div>
                    <div className="text-xs text-muted-foreground">{s.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-primary" />
              MCP 集成
            </CardTitle>
            <CardDescription>AI 编程工具经 MCP 把拆分任务登记到本应用（自动标记 AI 创建 / AI 协助）；Token 用于 MCP server 启动认证。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <span className="text-sm font-medium">启用 MCP</span>
                <p className="text-xs text-muted-foreground">默认开启；禁用后 MCP server 启动将被拒绝。</p>
              </div>
              <Switch checked={mcpEnabled} onCheckedChange={setMcpEnabled} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="mcp-token">授权 Token</Label>
              <div className="flex gap-2">
                <Input
                  id="mcp-token"
                  type={mcpShowToken ? "text" : "password"}
                  value={mcpToken}
                  onChange={(e) => setMcpToken(e.target.value)}
                  placeholder={DEFAULT_MCP_TOKEN}
                  className="font-mono"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="显示或隐藏 Token"
                  onClick={() => setMcpShowToken((v) => !v)}
                >
                  {mcpShowToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </Button>
                <Button onClick={saveMcp} disabled={mcpSaving}>
                  {mcpSaving ? "保存中…" : "保存"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                默认全局固定授权 Key：<code className="font-mono">{DEFAULT_MCP_TOKEN}</code>
                ；MCP server 启动需携带此 Token（--token 参数或 MCP_TODO_TOKEN 环境变量）。
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Paperclip className="h-4 w-4 text-primary" />
              附件维护
            </CardTitle>
            <CardDescription>
              任务图片以文件形式存放在运行目录 attachments/&lt;任务ID&gt;/ 下（备注中仅保留 attachment:// 短引用，不再写入数据库）；历史内嵌图片可一键迁移。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={() => setMigrateOpen(true)} disabled={maintaining}>
                迁移历史内嵌图片
              </Button>
              <Button variant="outline" onClick={() => setGcOpen(true)} disabled={maintaining}>
                清理无效附件
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              迁移按任务逐条进行（单条全部成功才生效，失败任务保留原文并提示原因），完成后看板数据自动刷新；
              清理针对关联任务已删除的附件，文件移入 attachments/trash/ 以便找回。
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>数据说明</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>• 开源地址: <code className="font-mono">git clone https://github.com/MrTian257/todo-kanban.git</code></p>
            <div>
              • 数据来源：桌面端 SQLite（固定路径为数据目录 <code>todo-kanban.db</code>（macOS：~/Library/Application Support/com.todo-kanban.app；其他平台：程序目录））；
              当前数据版本 <Badge variant="outline" className="ml-0.5 font-mono">v{version?.dataVersion ?? "…"}</Badge>
              （软件支持 v{version?.appMin ?? 1} ~ v{version?.appMax ?? 8}）。
            </div>
            <p>
              • 数据升级：启动时自动检查数据版本——兼容则先硬备份到运行目录 <code>backup/</code> 再逐级升级；
              数据由更高版本创建或版本过旧时拒绝打开并提示（见设置页顶部错误页）。
            </p>
            <p>• 浏览器预览模式无本地存储（演示数据只读），完整功能仅桌面端。</p>
            <p>• Git 操作依赖本机 <code>git</code>（PATH，版本 ≥ 2.20）；GitLab 远端增强可选系统 <code>curl</code>。</p>
            <div>
              • 软件版本 <Badge variant="secondary">{version?.softwareVersion ?? "2.0.0"}</Badge>（泳道看板） 当前主题皮肤：
              <Badge variant="outline" className="ml-1">{SKINS.find((s) => s.id === skin)?.name}</Badge>
            </div>
            <div className="space-y-1">
              <p>• 依赖版本（未知项显示 —，不再用占位版本号）：</p>
              <p>
                • Tauri {version?.tauriVersion ?? "—"}（桌面端）； <br/>
                • React {React.version}（前端）； <br/>
                • SQLite {version?.sqliteVersion ?? "—"}（桌面端）； <br/>
                • Git {version?.gitVersion ?? "—"}（桌面端）； <br/>
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={migrateOpen} onOpenChange={(open) => { if (!maintaining) setMigrateOpen(open); }}>
        <DialogContent>
          <DialogTitle>迁移历史内嵌图片</DialogTitle>
          <DialogDescription>
            扫描全部任务的描述，把内嵌 base64 图片转为附件文件（单张上限 5 MiB，仅支持 PNG、JPEG、GIF、WebP）。
            逐条任务全部成功才生效，失败任务保留原文。
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setMigrateOpen(false)} disabled={maintaining}>取消</Button>
            <Button onClick={runMigrate} disabled={maintaining}>{maintaining ? "迁移中…" : "开始迁移"}</Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={gcOpen} onOpenChange={(open) => { if (!maintaining) setGcOpen(open); }}>
        <DialogContent>
          <DialogTitle>清理无效附件</DialogTitle>
          <DialogDescription>
            移除关联任务已删除的附件记录，并把对应文件移入 attachments/trash/（不物理删除，可手动找回）。
            请先保存所有正在编辑的任务，避免误清粘贴后尚未保存的图片。
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setGcOpen(false)} disabled={maintaining}>取消</Button>
            <Button onClick={runGc} disabled={maintaining}>{maintaining ? "清理中…" : "开始清理"}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
