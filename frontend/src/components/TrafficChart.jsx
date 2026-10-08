import { useMemo, useState } from "react";
import { Line } from "react-chartjs-2";

function scaleFor(maxBps) {
  if (maxBps >= 1_000_000) return { div: 1_000_000, unit: "Mbps" };
  if (maxBps >= 1_000) return { div: 1_000, unit: "kbps" };
  return { div: 1, unit: "bps" };
}

export default function TrafficChart({ points, range }) {
  const ifaces = useMemo(() => {
    const peak = {};
    for (const point of points || []) {
      if (!point.iface) continue;
      const rate = Math.max(Number(point.in_bps) || 0, Number(point.out_bps) || 0);
      peak[point.iface] = Math.max(peak[point.iface] || 0, rate);
    }
    return Object.entries(peak).sort((a, b) => b[1] - a[1]).map(([name]) => name);
  }, [points]);
  const [picked, setPicked] = useState("");
  const iface = ifaces.includes(picked) ? picked : ifaces[0] || "";
  const samples = (points || [])
    .filter((point) => point.iface === iface && point.t)
    .map((point) => ({
      t: new Date(point.t).getTime(),
      inn: Number(point.in_bps) || 0,
      out: Number(point.out_bps) || 0,
    }))
    .sort((a, b) => a.t - b.t);

  const max = samples.reduce((peak, sample) => Math.max(peak, sample.inn, sample.out), 0);
  const { div, unit } = scaleFor(max || 1);
  const end = range?.to?.getTime() ?? Date.now();
  const start = range?.from?.getTime() ?? samples[0]?.t ?? end - 3_600_000;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-bold text-text">Bandwidth</p>
        {ifaces.length > 1 && (
          <select
            value={iface}
            onChange={(event) => setPicked(event.target.value)}
            className="cursor-pointer rounded-lg border border-border bg-transparent px-2 py-1 text-xs text-text"
            aria-label="Interface"
          >
            {ifaces.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        )}
        {ifaces.length === 1 && (
          <span className="font-mono text-xs text-text-secondary">{iface}</span>
        )}
      </div>
      {samples.length === 0 ? (
        <p className="text-sm text-text-secondary">No bandwidth in this range</p>
      ) : (
        <div className="h-48">
          <Line
            data={{
              datasets: [
                {
                  label: "In",
                  data: samples.map((sample) => ({ x: sample.t, y: sample.inn / div })),
                  borderColor: "#0084FF",
                  backgroundColor: "rgba(0, 132, 255, 0.12)",
                  fill: true,
                  tension: 0.15,
                  pointRadius: 0,
                  borderWidth: 1.5,
                },
                {
                  label: "Out",
                  data: samples.map((sample) => ({ x: sample.t, y: sample.out / div })),
                  borderColor: "#36B37E",
                  tension: 0.15,
                  pointRadius: 0,
                  borderWidth: 1.5,
                },
              ],
            }}
            options={{
              responsive: true,
              maintainAspectRatio: false,
              plugins: {
                legend: { display: true, labels: { boxWidth: 12, color: "#4B4B4B" } },
                tooltip: {
                  callbacks: {
                    title: (items) => new Date(items[0].parsed.x).toLocaleString("it-IT"),
                    label: (item) => `${item.dataset.label} ${item.parsed.y.toFixed(1)} ${unit}`,
                  },
                },
              },
              scales: {
                x: {
                  type: "time",
                  min: start,
                  max: end,
                  ticks: { maxTicksLimit: 6, color: "#4B4B4B" },
                  grid: { color: "#D3D3D3" },
                },
                y: {
                  min: 0,
                  ticks: { color: "#4B4B4B" },
                  grid: { color: "#D3D3D3" },
                  title: { display: true, text: unit, color: "#4B4B4B" },
                },
              },
            }}
          />
        </div>
      )}
    </div>
  );
}
