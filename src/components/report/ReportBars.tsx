// 零依赖横向条形图：用于「每人代码变更量」等成员维度对比。
// 数值最大者占满可用宽度，其余按比例；无数据时给占位提示。

export interface BarItem {
  key: string;
  label: string;
  value: number;
  /** 次要说明（例如「12 提交 / 3 活跃天」） */
  detail?: string;
}

interface Props {
  title: string;
  hint?: string;
  items: BarItem[];
  /** 单位后缀（默认「行」） */
  unit?: string;
  color?: string;
}

export function ReportBars({ title, hint, items, unit = "行", color = "var(--primary)" }: Props) {
  const max = items.reduce((peak, item) => Math.max(peak, item.value), 0);
  return (
    <section className="tk-report-card" aria-label={title}>
      <div className="tk-report-card-head">
        <h3>{title}</h3>
        {hint ? <span className="tk-report-hint">{hint}</span> : null}
      </div>
      {items.length === 0 || max === 0 ? (
        <div className="tk-report-empty">当前周期暂无数据</div>
      ) : (
        <ul className="tk-report-bars">
          {items.map((item) => (
            <li key={item.key}>
              <span className="tk-report-bar-label" title={item.label}>{item.label}</span>
              <span className="tk-report-bar-track">
                <span
                  className="tk-report-bar-fill"
                  style={{ width: Math.max(2, Math.round((item.value / max) * 100)) + "%", background: color }}
                />
              </span>
              <span className="tk-report-bar-value">
                {item.value.toLocaleString()}
                <span className="tk-report-bar-unit">{unit}</span>
              </span>
              {item.detail ? <span className="tk-report-bar-detail">{item.detail}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
