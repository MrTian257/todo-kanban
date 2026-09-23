// 零依赖 SVG 环形图（参考「前端团队 Git 周报」的画法，改用固定色板 + 应用主题字体）。
// 无数据时画一个占位灰环，避免除零与空 SVG。

export interface DonutSlice {
  key: string;
  label: string;
  count: number;
  color: string;
}

interface Props {
  title: string;
  /** 右上角小字说明（例如「按提交类型」） */
  hint?: string;
  slices: DonutSlice[];
  /** 圆心副标题（默认「提交数」） */
  unitLabel?: string;
}

const SIZE = 180;
const CENTER = SIZE / 2;
const RADIUS = 62;
const STROKE = 26;

/** 极坐标 → 直角坐标（-90° 起点，顺时针） */
function point(angleDeg: number, radius: number): [number, number] {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return [CENTER + radius * Math.cos(rad), CENTER + radius * Math.sin(rad)];
}

export function ReportDonut({ title, hint, slices, unitLabel = "提交数" }: Props) {
  const visible = slices.filter((slice) => slice.count > 0);
  const total = visible.reduce((sum, slice) => sum + slice.count, 0);
  let angle = 0;

  return (
    <section className="tk-report-card" aria-label={title}>
      <div className="tk-report-card-head">
        <h3>{title}</h3>
        {hint ? <span className="tk-report-hint">{hint}</span> : null}
      </div>
      {total === 0 ? (
        <div className="tk-report-empty">当前周期暂无数据</div>
      ) : (
        <div className="tk-report-donut">
          <svg viewBox={"0 0 " + SIZE + " " + SIZE} width={SIZE} height={SIZE} role="img" aria-label={title}>
            {visible.map((slice) => {
              const fraction = slice.count / total;
              const end = angle + fraction * 360;
              const [x0, y0] = point(angle, RADIUS);
              const [x1, y1] = point(end, RADIUS);
              const large = end - angle > 180 ? 1 : 0;
              const path = "M" + x0 + "," + y0 + " A" + RADIUS + "," + RADIUS + " 0 " + large + " 1 " + x1 + "," + y1;
              angle = end;
              return (
                <path
                  key={slice.key}
                  d={path}
                  fill="none"
                  stroke={slice.color}
                  strokeWidth={STROKE}
                  strokeLinecap="butt"
                >
                  <title>{slice.label + " · " + slice.count}</title>
                </path>
              );
            })}
            <text x={CENTER} y={CENTER - 2} textAnchor="middle" className="tk-report-donut-value">
              {total}
            </text>
            <text x={CENTER} y={CENTER + 18} textAnchor="middle" className="tk-report-donut-unit">
              {unitLabel}
            </text>
          </svg>
          <ul className="tk-report-legend">
            {visible.map((slice) => (
              <li key={slice.key}>
                <span className="tk-report-swatch" style={{ background: slice.color }} aria-hidden />
                <span className="tk-report-legend-label">{slice.label}</span>
                <span className="tk-report-legend-count">{slice.count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
