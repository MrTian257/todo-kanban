// 设置：明暗、主题皮肤（5 套）、侧边导航、数据说明

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
import { useSkin, SKINS } from "@/lib/theme";
import { cn } from "@/lib/utils";

export function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const [skin, setSkin] = useSkin();

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