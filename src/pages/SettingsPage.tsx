// 设置：明暗、主题皮肤（5 套）、番茄钟与 GrokBot（含颜色/动作/表情自定义）、MCP 集成、附件维护、数据说明

import * as React from "react";
import { Link } from "react-router-dom";
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
import { ArrowRight, Bot, Braces, Eye, EyeOff, Paperclip, SquareKanban, Timer, Wifi } from "lucide-react";
import { toast } from "sonner";
import { gcOrphanAttachments, migrateInlineImages } from "@/lib/attachments";
import { DEFAULT_MCP_TOKEN, mcpGetConfig, mcpSetConfig } from "@/lib/mcp";
import { McpAccessPanel } from "@/components/settings/McpAccessPanel";
import { useSkin, SKINS, useDisplaySize, DISPLAY_SIZES } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { toolPaths, type ToolPath } from "@/lib/git";
import { PET_SCALES } from "@/lib/petState";
import { applyPetThemePreset, resetPetPosition, resolvePetTheme, setPetThemeColor, setPetPrefs, usePetPrefs } from "@/lib/petStore";
// GrokBot 模块包：设置页直接枚举包内置的表情/状态/动作来做"试玩"预览
import {
  BUILTIN_ACTIONS,
  BUILTIN_EXPRESSIONS,
  BUILTIN_GROUPS,
  BUILTIN_STATES,
  THEME_PRESETS,
  VIEW_BOX,
  ringToPath,
  type GrokBotEngine,
  type GrokBotTheme,
} from "@/grokbot";
import { GrokBotPet } from "@/grokbot/react";
import { Checkbox } from "@/components/ui/checkbox";
import { DEFAULT_LAN_PORT, lanGetSettings, lanSetSettings, lanStatus, lanStop, type LanShareSettings, type LanStatus } from "@/lib/lan";
import { useAppStore } from "@/lib/store";
import { dbCheckVersion, type VersionReport } from "@/lib/version";

export function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const [skin, setSkin] = useSkin();
  // GrokBot 偏好与浮层共享同一份状态（lib/petStore.ts）
  const petPrefs = usePetPrefs();
  // 设置页预览实例：直接对引擎调 setExpression/playAction，所见即所得
  const previewEngine = React.useRef<GrokBotEngine | null>(null);
  const [previewState, setPreviewState] = React.useState("idle");
  // 预览主题：避免在 25 个表情缩略图的 map 里反复解析同一份配色
  const previewTheme = React.useMemo(
    () => resolvePetTheme(petPrefs),
    [petPrefs.themePreset, petPrefs.theme],
  );
  const [displaySize, setDisplaySize] = useDisplaySize();
  const [mcpEnabled, setMcpEnabled] = React.useState(true);
  const [mcpReadonly, setMcpReadonly] = React.useState(false);
  const [mcpToken, setMcpToken] = React.useState(DEFAULT_MCP_TOKEN);
  const [mcpShowToken, setMcpShowToken] = React.useState(false);
  const [mcpSaving, setMcpSaving] = React.useState(false);
  // ── 局域网共享：设置（app_meta 持久化）+ 服务运行状态 ──────────
  const projects = useAppStore((s) => s.projects);
  const [lanEnabled, setLanEnabled] = React.useState(false);
  const [lanPort, setLanPort] = React.useState(String(DEFAULT_LAN_PORT));
  const [lanToken, setLanToken] = React.useState("");
  const [lanProjects, setLanProjects] = React.useState<string[]>([]);
  const [lanShowToken, setLanShowToken] = React.useState(false);
  const [lanSaving, setLanSaving] = React.useState(false);
  const [lan, setLan] = React.useState<LanStatus | null>(null);
  const [tools, setTools] = React.useState<ToolPath[]>([]);
  const [toolError, setToolError] = React.useState("");
  React.useEffect(() => {
    let alive = true;
    void toolPaths().then(value => { if (alive) setTools(value); })
      .catch(error => { if (alive) setToolError(String(error)); });
    return () => { alive = false; };
  }, []);
  const [version, setVersion] = React.useState<VersionReport | null>(null);

  React.useEffect(() => {
    mcpGetConfig()
      .then((s) => {
        setMcpEnabled(s.enabled);
        setMcpReadonly(s.readonly);
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
      await mcpSetConfig({ enabled: mcpEnabled, readonly: mcpReadonly, token: mcpToken.trim() || DEFAULT_MCP_TOKEN });
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

  // 局域网设置读取：进入设置页时拉一次配置与运行状态
  React.useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const settings = await lanGetSettings();
        if (!alive) return;
        setLanEnabled(settings.enabled);
        setLanPort(String(settings.port));
        setLanToken(settings.token);
        setLanProjects(settings.projectIds);
      } catch { /* 读取失败保留默认值 */ }
      try {
        const status = await lanStatus();
        if (alive) setLan(status);
      } catch { /* 状态读取失败不影响配置展示 */ }
    })();
    return () => { alive = false; };
  }, []);

  // 运行中时轮询在线设备数（5s；页面隐藏不轮询）
  React.useEffect(() => {
    if (!lan?.running) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void lanStatus().then(setLan).catch(() => {});
    }, 5000);
    return () => window.clearInterval(timer);
  }, [lan?.running]);

  const toggleLanProject = (id: string, checked: boolean) => {
    setLanProjects((list) => (checked ? Array.from(new Set([...list, id])) : list.filter((item) => item !== id)));
  };

  const regenerateLanToken = () => {
    const raw = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "") : String(Date.now());
    setLanToken(raw.slice(0, 24));
  };

  const saveLan = async () => {
    const port = Number.parseInt(lanPort, 10);
    if (!Number.isFinite(port) || port < 1024 || port > 65535) {
      toast.error("端口需在 1024 ~ 65535 之间");
      return;
    }
    setLanSaving(true);
    try {
      const next: LanShareSettings = { enabled: lanEnabled, port, token: lanToken.trim(), projectIds: lanProjects };
      const status = await lanSetSettings(next);
      setLan(status);
      if (status.error) toast.error(status.error);
      else toast.success(status.running ? "局域网共享已开启" : "局域网共享设置已保存");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setLanSaving(false);
    }
  };

  const stopLan = async () => {
    try {
      setLan(await lanStop());
      toast.success("局域网共享已停止");
    } catch (error) {
      toast.error(String(error));
    }
  };

  const copyLanUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("访问地址已复制");
    } catch {
      toast.error("复制失败，请手动选择复制");
    }
  };

  return (
    <div className="tk-content-cap h-full w-full overflow-y-auto bg-background p-6">
      <h1 className="mb-4 text-xl font-semibold">设置</h1>
      <div className="grid w-full gap-5">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><SquareKanban className="h-4 w-4 text-primary" />工作流</CardTitle>
            <CardDescription>管理任务模板、本地提醒、备份恢复与 AI 待确认变更。</CardDescription>
          </CardHeader>
          <CardContent><Button asChild variant="outline"><Link to="/settings/workflow">管理工作流<ArrowRight className="h-4 w-4" /></Link></Button></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Braces className="h-4 w-4 text-primary" />自定义字段</CardTitle>
            <CardDescription>定义自定义字段（类型 / 值来源 / 卡片展示）与自动脚本（事件触发 → 写值），并可对存量任务补写取值。</CardDescription>
          </CardHeader>
          <CardContent><Button asChild variant="outline"><Link to="/settings/fields">管理字段与自动脚本<ArrowRight className="h-4 w-4" /></Link></Button></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>外观</CardTitle>
            <CardDescription>明暗模式 × 主题皮肤 × 展示尺寸（三者正交叠加）</CardDescription>
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
            {/* 展示尺寸：小 / 大 / 撑满 三档密度（间距 + 控件尺寸 + 标题字号 + 内容区宽度），
                与明暗、皮肤正交叠加；三档取值集中在 index.css 的 :root[data-display-size] 令牌块。 */}
            <div className="space-y-2">
              <span className="text-sm font-medium">展示尺寸</span>
              <div className="flex flex-wrap gap-2">
                {DISPLAY_SIZES.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setDisplaySize(s.id)}
                    className={cn(
                      "rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
                      displaySize === s.id && "border-primary bg-accent",
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
              <Timer className="h-4 w-4 text-primary" />
              番茄钟与 GrokBot
            </CardTitle>
            <CardDescription>
              番茄钟是独立计时器（不绑定任务），时长与长休节奏在番茄钟页面调整；这里管理桌面宠物 GrokBot 的显示方式。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* ── 预览 + 显示开关 ─────────────────────────────── */}
            <div className="flex flex-wrap items-start gap-5">
              {/* 设置页自带一个预览实例：改配色/表情/动作立即看到效果，不依赖浮层是否开启 */}
              <div className="flex h-[132px] w-[132px] shrink-0 items-center justify-center rounded-xl border bg-muted/30">
                <GrokBotPet
                  size={108}
                  state={previewState}
                  theme={previewTheme}
                  contextMenu={false}
                  onReady={(engine) => {
                    previewEngine.current = engine;
                  }}
                />
              </div>
              <div className="min-w-[260px] flex-1 space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <span className="text-sm font-medium">显示 GrokBot</span>
                    <p className="text-xs text-muted-foreground">在窗口右下角显示宠物；隐藏后可在这里重新开启。</p>
                  </div>
                  <Switch checked={petPrefs.enabled} onCheckedChange={(checked) => setPetPrefs({ enabled: checked })} />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <span className="text-sm font-medium">自动气泡</span>
                    <p className="text-xs text-muted-foreground">完成专注或任务时自动说一句；关闭后仅点击时显示。</p>
                  </div>
                  <Switch
                    checked={petPrefs.bubbleEnabled}
                    onCheckedChange={(checked) => setPetPrefs({ bubbleEnabled: checked })}
                  />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <span className="text-sm font-medium">待机漂浮</span>
                    <p className="text-xs text-muted-foreground">静止时轻微上下浮动；系统「减少动态效果」开启时自动停用。</p>
                  </div>
                  <Switch checked={petPrefs.float} onCheckedChange={(checked) => setPetPrefs({ float: checked })} />
                </div>
                <div className="space-y-2">
                  <span className="text-sm font-medium">宠物大小</span>
                  <div className="flex flex-wrap gap-2">
                    {PET_SCALES.map((scale) => (
                      <button
                        key={scale}
                        type="button"
                        onClick={() => setPetPrefs({ scale })}
                        className={cn(
                          "rounded-md border px-3 py-2 text-sm transition-colors hover:bg-accent",
                          petPrefs.scale === scale && "border-primary bg-accent",
                        )}
                      >
                        {scale === 1 ? "标准" : scale < 1 ? "小" : "大"}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* ── 颜色自定义 ───────────────────────────────────── */}
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">配色</span>
                {THEME_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => applyPetThemePreset(preset.id)}
                    className={cn(
                      "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors hover:bg-accent",
                      petPrefs.themePreset === preset.id && "border-primary bg-accent",
                    )}
                  >
                    <span className="h-3 w-3 rounded-full" style={{ background: preset.theme.body }} />
                    {preset.label}
                  </button>
                ))}
                {petPrefs.themePreset === "custom" && (
                  <span className="rounded-md border border-primary/40 bg-primary/10 px-2 py-1 text-xs text-primary">
                    自定义
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-4">
                {PET_COLOR_FIELDS.map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Input
                      type="color"
                      aria-label={label}
                      className="h-8 w-12 cursor-pointer p-0.5"
                      value={toHexColor(previewTheme[key])}
                      onChange={(event) => setPetThemeColor(key, event.target.value)}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                颜色以 CSS 变量下发，模块包里的全部外观（主体 / 柔光 / 投影 / 气泡）都能改；改任一项即切换为「自定义」。
              </p>
            </div>

            {/* ── 动作 / 表情自定义 ────────────────────────────── */}
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">状态</span>
                <select
                  className="h-8 rounded-md border bg-background px-2 text-xs"
                  value={previewState}
                  onChange={(event) => setPreviewState(event.target.value)}
                >
                  {BUILTIN_GROUPS.map((group) => (
                    <optgroup key={group.id} label={group.label ?? group.id}>
                      {group.states.map((id) => (
                        <option key={id} value={id}>
                          {petStateLabel(id)}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <span className="text-xs text-muted-foreground">每个状态自带表情池、动作与换表情节奏</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">动作</span>
                {BUILTIN_ACTIONS.map((action) => (
                  <Button
                    key={action.id}
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => previewEngine.current?.playAction(action.id)}
                  >
                    {action.label ?? action.id}
                  </Button>
                ))}
              </div>
              <div className="space-y-2">
                <span className="text-sm font-medium">表情</span>
                <div className="grid max-h-44 grid-cols-[repeat(auto-fill,minmax(38px,1fr))] gap-1.5 overflow-y-auto rounded-lg border p-2">
                  {BUILTIN_EXPRESSIONS.map((expression) => (
                    <button
                      key={expression.id}
                      type="button"
                      title={expression.label ?? expression.id}
                      aria-label={expression.label ?? expression.id}
                      onClick={() => previewEngine.current?.setExpression(expression.id)}
                      className="flex aspect-square items-center justify-center rounded-md border transition-colors hover:bg-accent"
                    >
                      <svg viewBox={VIEW_BOX} className="h-7 w-7" aria-hidden="true">
                        <path d={ringToPath(expression.eyes[0])} fill={previewTheme.body} />
                        <path d={ringToPath(expression.eyes[1])} fill={previewTheme.body} />
                      </svg>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={resetPetPosition}>
                重置宠物位置
              </Button>
              <Button asChild variant="outline">
                <Link to="/pomodoro">
                  打开番茄钟<ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
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
            <div className="flex items-center justify-between gap-4">
              <div>
                <span className="text-sm font-medium">MCP 只读模式</span>
                <p className="text-xs text-muted-foreground">
                  开启后 AI 只能读：写工具（建/切分支、保存状态、提提案）从工具列表隐藏且调用被拒。
                  只读只由本设置决定（已不再支持 MCP_TODO_READONLY 环境变量与 --readonly 参数，传了会直接拒绝启动）；
                  保存后下一个请求即生效，无需重启 mcp-server。
                </p>
              </div>
              <Switch checked={mcpReadonly} onCheckedChange={setMcpReadonly} aria-label="MCP 只读模式" />
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
                多个 AI 建议各发一把「接入 Token」（见下方 HTTP 传输区），管理 Key 只留给自己用。
              </p>
            </div>
            <McpAccessPanel />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wifi className="h-4 w-4 text-primary" />
              局域网共享
            </CardTitle>
            <CardDescription>
              勾选项目后，同一局域网内的其他设备用浏览器打开下方地址，即可查看该项目的待办面板并创建 / 分配 / 完成 / 删除任务；
              任意设备（含本机）的改动都会实时同步到其它已连接设备。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <span className="text-sm font-medium">启用局域网共享服务</span>
                <p className="text-xs text-muted-foreground">只有被勾选的项目会暴露给局域网，未勾选项目的数据不会被发送。</p>
              </div>
              <Switch checked={lanEnabled} onCheckedChange={setLanEnabled} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="lan-port">监听端口</Label>
                <Input id="lan-port" inputMode="numeric" value={lanPort} onChange={(event) => setLanPort(event.target.value)} className="font-mono" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lan-token">访问令牌</Label>
                <div className="flex gap-2">
                  <Input
                    id="lan-token"
                    type={lanShowToken ? "text" : "password"}
                    value={lanToken}
                    onChange={(event) => setLanToken(event.target.value)}
                    className="font-mono"
                    placeholder="留空 = 局域网内免验证"
                  />
                  <Button type="button" variant="outline" size="icon" aria-label="显示或隐藏访问令牌" onClick={() => setLanShowToken((value) => !value)}>
                    {lanShowToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </Button>
                  <Button type="button" variant="outline" onClick={regenerateLanToken}>重新生成</Button>
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <span className="text-sm font-medium">共享项目</span>
              {projects.filter((project) => !project.archived).length === 0 ? (
                <p className="text-xs text-muted-foreground">还没有可共享的项目。</p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {projects.filter((project) => !project.archived).map((project) => (
                    <label key={project.id} className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm">
                      <Checkbox
                        checked={lanProjects.includes(project.id)}
                        onCheckedChange={(checked) => toggleLanProject(project.id, checked === true)}
                      />
                      <span className="truncate">{project.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={saveLan} disabled={lanSaving}>{lanSaving ? "保存中…" : "保存并应用"}</Button>
              {lan?.running && <Button variant="outline" onClick={stopLan}>停止服务</Button>}
            </div>
            {lan && (
              <div className="space-y-2 rounded-lg border bg-muted/30 p-3 text-sm">
                <div className="flex items-center gap-2">
                  <span className={cn("h-2 w-2 rounded-full", lan.running ? "bg-emerald-500" : "bg-muted-foreground")} />
                  <span>{lan.running ? "运行中 · " + lan.clientCount + " 台设备在线" : "未运行"}</span>
                </div>
                {lan.error && <p role="alert" className="text-destructive">{lan.error}</p>}
                {lan.urls.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">其他设备在浏览器打开（把地址发给对方；第一个通常是本机主网卡，虚拟网卡地址可忽略）：</p>
                    {lan.urls.map((url) => (
                      <div key={url} className="flex items-center gap-2">
                        <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 font-mono text-xs">{url}</code>
                        <Button type="button" size="sm" variant="ghost" onClick={() => void copyLanUrl(url)}>复制</Button>
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-xs text-muted-foreground">首次开启时若系统弹出防火墙提示，请允许该应用访问专用网络，否则局域网设备无法连接。</p>
              </div>
            )}
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
            <p>• Git 操作依赖本机 Git ≥ 2.20；GitLab / GitHub 接口使用系统 curl。</p>
            {tools.map(tool => <div key={tool.name} className="rounded-lg border p-3">
              <p className="font-medium text-foreground">{tool.name} · {tool.available ? "已定位" : "路径不可用"}</p>
              <code className="block break-all text-xs">{tool.path}</code>
              <p className="mt-1 text-xs">来源：{tool.source}；仅检查路径，未验证运行结果。</p>
            </div>)}
            {toolError && <p role="alert" className="text-destructive">工具路径读取失败：{toolError}</p>}
            <p className="text-xs">可通过 TODO_KANBAN_GIT_PATH / TODO_KANBAN_CURL_PATH 环境变量指定绝对路径；设置后需重启应用。macOS 在 PATH 中找不到工具时会查询系统及 Homebrew 常用目录。</p>
            <div>
              • 软件版本 <Badge variant="secondary">{version?.softwareVersion ?? "2.0.0"}</Badge>（泳道看板） 当前主题皮肤：
              <Badge variant="outline" className="ml-1">{SKINS.find((s) => s.id === skin)?.name}</Badge>
              展示尺寸：<Badge variant="outline" className="ml-1">{DISPLAY_SIZES.find((s) => s.id === displaySize)?.name}</Badge>
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

// ── GrokBot 设置页：颜色项与取值工具 ─────────────────────────────

/** 设置页暴露的 4 个颜色项（其余 5 个走 createGrokBot API / 直接写 CSS 变量） */
const PET_COLOR_FIELDS: readonly (readonly [keyof GrokBotTheme, string])[] = [
  ["body", "主体"],
  ["eye", "眼睛"],
  ["bubbleBg", "气泡背景"],
  ["bubbleText", "气泡文字"],
];

/** 状态 id → 中文名（下拉展示用） */
function petStateLabel(id: string): string {
  return BUILTIN_STATES.find((state) => state.id === id)?.label ?? id;
}

/**
 * 转成 <input type="color"> 能吃的 #rrggbb。
 * 主题里的气泡背景是 rgba(...)，直接塞给颜色输入会被浏览器重置成 #000000，
 * 所以这里统一解析： #rrggbb / #rgb / rgb() / rgba() 都能转，解析不了则回退白色。
 */
function toHexColor(value: string): string {
  const input = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(input)) return input;
  if (/^#[0-9a-f]{3}$/.test(input)) {
    return "#" + input[1] + input[1] + input[2] + input[2] + input[3] + input[3];
  }
  const match = input.match(/^rgba?\(([^)]+)\)$/);
  if (match) {
    const parts = match[1].split(",").map((part) => Number.parseFloat(part));
    if (parts.length >= 3 && parts.slice(0, 3).every((part) => Number.isFinite(part))) {
      const hex = parts
        .slice(0, 3)
        .map((part) => Math.max(0, Math.min(255, Math.round(part))).toString(16).padStart(2, "0"))
        .join("");
      return "#" + hex;
    }
  }
  return "#ffffff";
}

