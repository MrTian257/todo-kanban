// 报告 KPI 卡片行：提交数 / 参与人数 / 新增行 / 删除行 / 活跃天数。
// 行数在服务端不支持 with_stats 时显示「—」而不是 0（避免误读为「没写代码」）。

export interface KpiItem {
  key: string;
  label: string;
  /** 数值文本；null 表示不可用（显示「—」） */
  value: number | null;
  unit?: string;
}

export function ReportKpis({ items }: { items: KpiItem[] }) {
  return (
    <div className="tk-report-kpis">
      {items.map((item) => (
        <div className="tk-report-kpi" key={item.key}>
          <div className="tk-report-kpi-value">
            {item.value === null ? "—" : item.value.toLocaleString()}
            {item.value !== null && item.unit ? <span className="tk-report-kpi-unit">{item.unit}</span> : null}
          </div>
          <div className="tk-report-kpi-label">{item.label}</div>
        </div>
      ))}
    </div>
  );
}
