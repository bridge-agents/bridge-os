/**
 * Line, area and bar, drawn as SVG.
 *
 * A charting library would be a dependency to audit and ship on three desktop
 * platforms, for three chart types over a fortnight of daily points. This is
 * the whole renderer, and it inherits theme tokens like everything else.
 */
export interface Point {
  label: string;
  value: number;
}

const WIDTH = 600;
const HEIGHT = 160;
const PAD = 8;

function niceMax(values: number[]): number {
  const peak = Math.max(...values, 0);
  if (peak <= 0) return 1;
  // Round up to something a person would draw an axis at.
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  return Math.ceil(peak / magnitude) * magnitude;
}

export function Chart({
  points,
  chartType = "line",
  unit,
}: {
  points: Point[];
  chartType?: "line" | "bar" | "area";
  unit?: string;
}) {
  if (points.length === 0) {
    return <p className="py-6 text-center text-sm text-text-faint">No data yet.</p>;
  }

  const max = niceMax(points.map((point) => point.value));
  const usable = HEIGHT - PAD * 2;
  const step = points.length > 1 ? (WIDTH - PAD * 2) / (points.length - 1) : 0;
  const x = (index: number) => PAD + index * step;
  const y = (value: number) => PAD + usable - (value / max) * usable;

  const line = points.map((point, index) => `${x(index)},${y(point.value)}`).join(" ");
  const area = `${PAD},${PAD + usable} ${line} ${x(points.length - 1)},${PAD + usable}`;

  const formatPeak = (value: number) =>
    unit === "usd" ? `$${value.toFixed(2)}` : value.toLocaleString();

  const first = points[0]?.label ?? "";
  const last = points.at(-1)?.label ?? "";
  const total = points.reduce((sum, point) => sum + point.value, 0);

  return (
    <figure className="flex flex-col gap-1.5">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="h-40 w-full"
        role="img"
        aria-label={`${chartType} chart, ${points.length} points, peak ${formatPeak(max)}, total ${formatPeak(total)}`}
      >
        <title>{`${points.length} points from ${first} to ${last}`}</title>

        {/* Baseline: the drawing's datum. */}
        <line
          x1={PAD}
          y1={PAD + usable}
          x2={WIDTH - PAD}
          y2={PAD + usable}
          stroke="var(--bridge-border)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />

        {chartType === "bar" ? (
          points.map((point, index) => {
            const barWidth = Math.max((WIDTH - PAD * 2) / points.length - 3, 2);
            const height = (point.value / max) * usable;
            return (
              <rect
                key={point.label}
                x={PAD + index * ((WIDTH - PAD * 2) / points.length) + 1.5}
                y={PAD + usable - height}
                width={barWidth}
                height={Math.max(height, point.value > 0 ? 1 : 0)}
                fill="var(--bridge-accent)"
                opacity={0.85}
              />
            );
          })
        ) : (
          <>
            {chartType === "area" && (
              <polygon points={area} fill="var(--bridge-accent)" opacity={0.14} />
            )}
            <polyline
              points={line}
              fill="none"
              stroke="var(--bridge-accent)"
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
      </svg>

      <figcaption className="flex justify-between font-mono text-[10px] text-text-faint">
        <span>{first}</span>
        <span>peak {formatPeak(max)}</span>
        <span>{last}</span>
      </figcaption>
    </figure>
  );
}
