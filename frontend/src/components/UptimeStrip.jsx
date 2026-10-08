const STATE_COLOR = {
  UP: "bg-text-success",
  DOWN: "bg-text-error",
};

export default function UptimeStrip({ segments, hours = 24, pct }) {
  if (!segments?.length) return <span className="text-text-secondary">–</span>;

  const end = Date.now();
  const start = end - hours * 3_600_000;
  const span = end - start;

  return (
    <div className="flex items-center gap-2">
      <span className="w-10 shrink-0 text-xs tabular-nums text-text">
        {pct == null ? "–" : `${pct}%`}
      </span>
      <div className="flex h-1.5 w-35 overflow-hidden rounded-full bg-bg" title="Last 24 hours">
        {segments.map((seg) => {
          const from = Math.max(new Date(seg.start).getTime(), start);
          const to = Math.min(new Date(seg.end).getTime(), end);
          const width = Math.max(0, ((to - from) / span) * 100);
          if (!width) return null;
          return (
            <span
              key={`${seg.start}-${seg.state}`}
              className={STATE_COLOR[seg.state] || "bg-bg-tertiary"}
              style={{ width: `${width}%` }}
              title={`${seg.state} ${new Date(seg.start).toLocaleString("it-IT")}`}
            />
          );
        })}
      </div>
    </div>
  );
}
