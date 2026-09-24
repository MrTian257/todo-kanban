# grokbot —— 可迁移的表情宠物模块包

一个**自包含、零依赖**的果冻球表情宠物：SVG 主体 + 两根眼睛轮廓做弹簧形变，支持**颜色自定义 / 动作自定义 / 表情自定义**。

- 核心（`index.ts` / `core/` / `data/`）只用标准 DOM API，**不依赖 React、不 import 宿主代码**；
- React 宿主用 `react.tsx` 里的 `<GrokBotPet />`（只有它会引入 React）；
- 整套样式由引擎注入 `<head>`，不需要单独引 CSS 文件，也不会污染宿主样式（所有选择器与关键帧都带实例作用域前缀）。

## 目录结构

```
grokbot/
├── index.ts            # 核心入口（零框架依赖）
├── react.tsx           # React 适配层（可选）
├── types.ts            # 全部类型契约
├── core/
│   ├── engine.ts       # DOM 构建 + rAF 渲染循环 + 交互 + 状态调度
│   ├── morph.ts        # 纯函数：弹簧插值 / 眨眼 / 拟 3D 投影
│   └── styles.ts       # 作用域隔离的样式生成与注入
└── data/
    ├── shape.ts        # 主体轮廓 + 视线球心/半径
    ├── expressions.ts  # 25 组表情点集（自动生成，勿手改）
    ├── states.ts       # 39 个状态元数据（表情池 / 动作 / 节奏 / 眨眼）
    ├── actions.ts      # 6 个内置果冻动作
    └── theme.ts        # 默认配色 + 6 套预设
```

## 快速开始

### 原生（任何框架 / 无框架）

```ts
import { createGrokBot } from "./grokbot";

const bot = createGrokBot({
  mount: document.getElementById("pet-host")!,
  size: 180,
  initialState: "idle",
});

bot.say("你好呀，我是 GrokBot");
bot.setState("excited");     // 切状态：换表情 + 播动作 + 重排节奏
bot.setExpression("e2");     // 只切表情
bot.playAction("bounce");    // 只播动作
bot.setTheme({ body: "#7c5ce5" });
bot.setTurn(-20);            // 拟 3D 转头
bot.destroy();               // 卸载（清定时器 / rAF / 注入样式）
```

### React

```tsx
import { GrokBotPet } from "./grokbot/react";

<GrokBotPet
  className="fixed bottom-6 right-6"
  size={96}
  state={mood}                 // 受控状态；不传则由引擎自己调度
  theme={{ body: "#5b7fe5" }}
  onClick={() => setBubble(true)}
  onDragMove={(dx, dy) => setPos({ x: x0 + dx, y: y0 + dy })}
  onReady={(engine) => engine.say("就位")}
/>
```

## 定制一：颜色

三种粒度，按需选：

1. **整套预设**：`THEME_PRESETS`（经典蓝 / 星尘紫 / 苔藓绿 / 落日橙 / 石墨灰 / 极简墨）；
2. **局部覆盖**：`createGrokBot({ theme: { body: "#e08a3c" } })` 或运行时 `bot.setTheme({...})`，
   与内置主题**合并**，只写要改的项；
3. **纯 CSS 覆盖**：颜色全部以 CSS 变量下发（`--gb-body` / `--gb-eye` / `--gb-shadow` / `--gb-bubble-bg` …），
   宿主可以在自己的样式表里直接改，优先级高于引擎注入的变量。

`GrokBotTheme` 字段：`body` 主体、`highlight` 顶部柔光、`eye` 眼睛、`eyeGlow` 眼睛发光、
`shadow` 投影、`bubbleBg/Text/Border` 气泡、`accent` 强调色。

## 定制二：动作

一个动作 = 名字 + 作用目标（`body` 整体 / `eyes` 只动眼睛）+ 关键帧 + 时长。

```ts
bot.registerAction({
  id: "wiggle",
  label: "扭一扭",
  target: "body",
  durationMs: 700,
  keyframes: "0%,100% { transform: rotate(0); } 30% { transform: rotate(-12deg); } 70% { transform: rotate(10deg); }",
});
bot.playAction("wiggle");
```

说明：

- `keyframes` 只写规则体，引擎会按实例包成 `@keyframes gb-xxxx-wiggle`，不会和宿主同名动画打架；
- 也可以只给 `className`，复用宿主样式表里的既有类；
- `durationMs` 到点后自动摘掉 class，同名动作可连续重放（内部会强制 reflow）；
- 系统开启「减少动态效果」时 `playAction` 直接静默返回。

内置动作：`bounce` 弹跳、`tilt` 歪头、`scan` 扫视（作用在眼睛）、`turn` 转身、`pulse` 呼吸脉冲、`glitch` 抖动。

## 定制三：表情

一个表情 = 左右两眼各一圈轮廓点：

```ts
import type { GrokBotExpression } from "./grokbot";

const wink: GrokBotExpression = {
  id: "wink",
  label: "眨眼笑",
  eyes: [leftRing, rightRing],   // 各 48 个 [x, y]
};
bot.registerExpression(wink);
bot.setExpression("wink");
```

约束（很重要）：

- 坐标系 = SVG `viewBox` `"-28 -28 285 285"`，与内置点集同系；
- 切换的两个表情必须**圈数相同、每圈点数相同**（引擎按同索引插值，点数不同会错位）；
  内置点集是 2 圈 × 48 点，建议直接用其中一个点集做描边/微调的起点；
- 若要整体替换，用 `createGrokBot({ expressions: [...] })`（同 id 覆盖内置）；
- 新表情要在状态里用得上，需要把它的 id 加进某个状态的 `expressions` 池。

## 定制四：状态与节奏

`GrokBotState` 决定"这段时间怎么表现"：

```ts
bot.registerState({
  id: "coding",
  label: "写代码",
  expressions: ["e7", "e16"],   // 表情池（随机轮换）
  action: "scan",               // 进入时播的动作
  cadence: [1800, 3200],        // 多久换一次表情 [min,max] ms
  blink: [2800, 5500],          // 眨眼间隔；null = 不眨眼
});
```

内置 39 个状态（睡眠 / 待机 / 思考 / 兴奋 / 庆祝 / 加载 …），分组见 `BUILTIN_GROUPS`。

## 数据结构：为什么是"点集"而不是图片

表情形变靠的是**两组轮廓点之间的插值**（弹簧物理，切换时有轻微回弹），不是逐帧贴图——
所以任何两个表情之间都能平滑过渡，且整套表情的体积只有几十 KB、可无限缩放不失真。

## API 速查

| 成员 | 说明 |
| --- | --- |
| `createGrokBot(options)` | 创建实例并挂载；返回 `GrokBotEngine` |
| `engine.getElement()` | 根节点（可自行加定位样式） |
| `engine.setState(id)` / `setExpression(id)` / `playAction(id)` | 状态 / 表情 / 动作 |
| `engine.say(text, ms?)` / `hideBubble()` | 气泡 |
| `engine.lookAt(x, y)` / `setGaze(x,y)` / `resetGaze()` | 视线 |
| `engine.setTurn(deg)` | 拟 3D 转头角度 |
| `engine.setTheme(partial)` / `getTheme()` | 颜色 |
| `engine.setSize(px)` / `setFloat(on)` / `setInteractive(on)` | 表现开关 |
| `engine.registerExpression/State/Action(...)` | 运行时扩展 |
| `engine.listExpressions/States/Actions/Groups()` | 枚举（做设置页/调试面板用） |
| `engine.destroy()` | 彻底卸载 |
| 回调 | `onClick` / `onDoubleClick` / `onContextMenu` / `onDragMove` / `onDragEnd` / `onPointerMove` / `onStateChange` / `onExpressionChange` |

## 迁移到其他项目

1. **整目录拷贝**：把 `grokbot/` 复制过去即可，它不 import 任何宿主代码、没有第三方依赖；
2. 只用核心就删掉 `react.tsx`（以及 `index.ts` 里没有的引用——核心入口本来就没导出 React 组件）；
3. 需要 TS 类型：直接带上 `types.ts`；不需要路径别名，内部全是相对路径；
4. 打包成 npm 包：加一个 `package.json`（`main: index.ts` / `exports: { ".": "./index.ts", "./react": "./react.tsx" }`）即可；
5. 非 TS 项目：用任意 esbuild/tsc 把 `index.ts` 编成 ESM 再引。

## 已知边界

- 需要 DOM；SSR 环境下不要在服务端调用 `createGrokBot`（React 组件在 `useEffect` 里创建，天然安全）；
- 引擎有一个常驻 rAF 循环，但**静止时不写 DOM**（帧签名比对），空闲开销接近 0；
- 同页面可挂多个实例：作用域 class、关键帧名、clipPath id 都按实例隔离；
- 系统「减少动态效果」开启时：不播动作、不漂浮，但表情与颜色切换照常。

## 出处

表情形变核心（两眼轮廓点集 + 弹簧插值 + 拟 3D 球面投影）移植自 GrokBot 参考实现，
参考实现自述其形变算法源自官方 **LaoA-GrokBot**；本模块在其基础上重写为
「数据驱动 + 可注册」的模块包（点集抽成数据、动作/状态抽成可注册表、样式作用域隔离）。
