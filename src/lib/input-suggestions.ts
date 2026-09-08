// 全局输入建议控制（需求：移除 WebView/Tauri 默认的输入建议，由程序单独控制）
//
// 覆盖两类引擎级「输入建议」：
//   - autocomplete：WebView2/Chromium 表单自动填充与历史值下拉（input/textarea）
//   - spellcheck：拼写检查（红色波浪线 + 纠错建议，含 contenteditable 富文本，如 Markdown 备注）
//
// 规则（全部程序可控）：
//   - 默认：对页面中所有命中字段强制 autocomplete="off" / spellcheck="false"，
//     并通过 MutationObserver 覆盖后续动态创建的节点（React 受控组件重渲染也不会回退）。
//   - 开启方式一（组件层）：JSX 显式传 autoComplete="on" / spellCheck={true} —— 属性存在即尊重程序取值。
//   - 开启方式二（容器级）：元素或任意祖先加 data-autocomplete="on" / data-spellcheck="on"，
//     该范围内由本模块注入的默认值会被回收（程序自设的属性保留）。
//   - 程序显式设置的 autocomplete="off" / spellcheck="false" 永远保留，不会被改写。
//
// 注：应用层建议（如 datalist、自定义下拉）不受影响，本模块只关闭引擎默认行为。

interface AttributePolicy {
  attr: string;
  /** 本策略适用的元素选择器 */
  selector: string;
  optInDataAttr: string;
  forcedValue: string;
  /** 记录本策略由模块注入的属性（区别于程序显式设置的），容器 opt-in 时只回收自己注入的值 */
  forced: WeakSet<HTMLElement>;
}

const POLICIES: AttributePolicy[] = [
  {
    attr: "autocomplete",
    selector: "input, textarea",
    optInDataAttr: "data-autocomplete",
    forcedValue: "off",
    forced: new WeakSet(),
  },
  {
    attr: "spellcheck",
    selector: 'input, textarea, [contenteditable="true" i], [contenteditable="plaintext-only" i], [contenteditable=""]',
    optInDataAttr: "data-spellcheck",
    forcedValue: "false",
    forced: new WeakSet(),
  },
];

/** 所有策略涉及的字段范围（用于遍历同步） */
const FIELD_SELECTOR = [...new Set(POLICIES.flatMap((p) => p.selector.split(",")))].join(",");

/** 对单个元素同步各条策略（不适用本策略的元素自动跳过） */
function syncField(el: HTMLElement): void {
  for (const policy of POLICIES) {
    if (!el.matches(policy.selector)) continue;
    const own = el.getAttribute(policy.attr);
    if (own === null) {
      if (el.closest(`[${policy.optInDataAttr}="on"]`)) continue; // 容器显式开启：不注入
      el.setAttribute(policy.attr, policy.forcedValue);
      policy.forced.add(el);
      continue;
    }
    // 属性已存在：程序显式取值，一律尊重；但若容器 opt-in 生效且值是我们注入的，则回收
    if (el.closest(`[${policy.optInDataAttr}="on"]`) && own === policy.forcedValue && policy.forced.has(el)) {
      el.removeAttribute(policy.attr);
      policy.forced.delete(el);
    }
  }
  // 表单级默认值一并关闭（元素级属性仍优先于表单级，opt-in 不受影响）
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const form = el.form;
    if (form && !form.hasAttribute("autocomplete") && !form.closest('[data-autocomplete="on"]')) {
      form.setAttribute("autocomplete", "off");
    }
  }
}

/** 同步一个节点自身（若命中字段）及其全部后代字段 */
function syncTree(node: HTMLElement): void {
  syncField(node);
  node.querySelectorAll<HTMLElement>(FIELD_SELECTOR).forEach(syncField);
}

let installed = false;

/** 全局安装：在 main.tsx 调一次，幂等；返回清理函数（断开监听） */
export function installInputSuggestionControl(): () => void {
  if (installed) return () => {};
  installed = true;

  syncTree(document.body);

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") {
        const target = record.target;
        if (!(target instanceof HTMLElement)) continue;
        if (target.matches(FIELD_SELECTOR)) {
          // autocomplete/spellcheck 属性被移除（如 React 卸载属性）→ 重新兜底
          syncField(target);
        } else if (target.hasAttribute("data-autocomplete") || target.hasAttribute("data-spellcheck")) {
          // 容器 opt-in 开关变化 → 重新同步容器范围内全部字段
          syncTree(target);
        }
        continue;
      }
      record.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement) syncTree(node);
      });
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["autocomplete", "spellcheck", "data-autocomplete", "data-spellcheck"],
  });

  return () => {
    observer.disconnect();
    installed = false;
  };
}
