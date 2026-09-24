// React 适配层（可选）。核心引擎不依赖 React，只有这个文件需要。
//
// 为什么把 React 隔离开：宿主可能是 Vue / Svelte / 原生，核心必须能直接吃；
// 迁移到没有 React 的项目时，删掉本文件与 index.ts 里对它的引用即可。

import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { createGrokBot, GrokBotEngine } from "./core/engine";
import type { GrokBotOptions, GrokBotTheme } from "./types";

export interface GrokBotPetProps
  extends Omit<GrokBotOptions, "mount" | "initialState" | "initialExpression" | "size" | "className"> {
  /** 挂载容器 class（宿主用它做定位：fixed/absolute + left/top 等） */
  className?: string;
  style?: CSSProperties;
  /** 渲染尺寸（px），默认 160 */
  size?: number;
  /** 受控状态：变化时切换；不传则由引擎按自身节奏调度 */
  state?: string;
  /** 受控表情 */
  expression?: string;
  /** 引擎就绪回调：拿实例做命令式调用（say / playAction / lookAt …） */
  onReady?: (engine: GrokBotEngine) => void;
}

export function GrokBotPet(props: GrokBotPetProps) {
  const { className, style, size = 160, state, expression, theme, float = true, onReady, ...options } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<GrokBotEngine | null>(null);
  // 用 ref 保存最新 props：引擎回调是一次性注册的，直接闭包会永远读到首帧的值
  const live = useRef({ options, onReady, state, expression });
  live.current = { options, onReady, state, expression };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const engine = createGrokBot({
      ...live.current.options,
      mount: host,
      size,
      float,
      initialState: live.current.state,
      initialExpression: live.current.expression,
      // 回调统一经 ref 转发：引擎只在创建时读一次 options，
      // 直接透传会把首帧闭包永久固化（典型症状：气泡文案一直用启动时的计数）。
      onClick: () => live.current.options.onClick?.(),
      onDoubleClick: () => live.current.options.onDoubleClick?.(),
      onContextMenu: (event) => live.current.options.onContextMenu?.(event),
      onDragMove: (dx, dy, event) => live.current.options.onDragMove?.(dx, dy, event),
      onDragEnd: () => live.current.options.onDragEnd?.(),
      onStateChange: (id) => live.current.options.onStateChange?.(id),
      onExpressionChange: (id) => live.current.options.onExpressionChange?.(id),
      onPointerMove: (event) => live.current.options.onPointerMove?.(event),
    });
    engineRef.current = engine;
    live.current.onReady?.(engine);
    return () => {
      engineRef.current = null;
      engine.destroy();
    };
    // 只在挂载/卸载时创建与销毁：引擎自带 rAF 与定时器，跟随 props 重建会不断打断形变与手势
  }, []);

  useEffect(() => {
    if (state) engineRef.current?.setState(state);
  }, [state]);

  useEffect(() => {
    if (expression) engineRef.current?.setExpression(expression);
  }, [expression]);

  useEffect(() => {
    engineRef.current?.setSize(size);
  }, [size]);

  useEffect(() => {
    engineRef.current?.setFloat(float);
  }, [float]);

  // 主题用序列化值做依赖：宿主内联对象字面量时引用每帧都变，直接依赖会无限重建样式
  const themeKey = theme ? JSON.stringify(theme) : "";
  useEffect(() => {
    if (theme) engineRef.current?.setTheme(theme as Partial<GrokBotTheme>);
  }, [themeKey]);

  return <div ref={hostRef} className={className} style={style} />;
}
