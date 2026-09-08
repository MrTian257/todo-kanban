// 设置：明暗、主题皮肤（5 套）、侧边导航、MCP 集成、数据说明

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Bot, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { DEFAULT_MCP_TOKEN, mcpGetConfig, mcpSetConfig } from "@/lib/mcp";
import { useSkin, SKINS } from "@/lib/theme";
import { cn } from "@/lib/utils";

export function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const [skin, setSkin] = useSkin();
  const [mcpEnabled, setMcpEnabled] = React.useState(true);
  const [mcpToken, setMcpToken] = React.useState(DEFAULT_MCP_TOKEN);
  const [mcpShowToken, setMcpShowToken] = React.useState(false);
  const [mcpSaving, setMcpSaving] = React.useState(false);

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

  return (
    <div className="h-full w-full overflow-y-auto bg-background p-6">
      <h1 className="mb-4 text-xl font-semibold">设置</h1>
      <div className="max-w-2xl space-y-4">
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
            <CardTitle>侧边导航</CardTitle>
            <CardDescription>工作台：今日焦点 / Todo List / 项目资料；底部为明暗切换与设置入口。</CardDescription>
          </CardHeader>
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
            <CardTitle>数据说明</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>• 数据存储：桌面端 SQLite（位置由程序运行目录 <code>db-config.txt</code> 指示文件指定）。</p>
            <p>• 浏览器预览模式无本地存储（演示数据只读），完整功能仅桌面端。</p>
            <p>• Git 操作依赖本机 <code>git</code>（PATH，版本 ≥ 2.20）；GitLab 远端增强可选系统 <code>curl</code>。</p>
            <p>
              • 版本 <Badge variant="secondary">2.0.0</Badge>（泳道看板） 当前主题皮肤：
              <Badge variant="outline" className="ml-1">{SKINS.find((s) => s.id === skin)?.name}</Badge>
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}