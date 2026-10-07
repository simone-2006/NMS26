import { useCallback, useEffect, useRef, useState } from "react";
import { Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  TimeScale,
  Tooltip,
} from "chart.js";
import "chartjs-adapter-date-fns";
import { addDevice, deleteDevices, getAlerts, getDevices, getLatency, getLatencyRange, getSummary, updateDevice } from "./api.js";
import { MoreVertical, Network, Pen, Plus, Trash, X, Expand, Calendar } from "lucide-react";
import Input from "./components/ui/Input.jsx";
import { IPInput } from "./components/ui/Input.jsx";

ChartJS.register(TimeScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler);

const DETAIL_RANGES = [
  { id: "15m", label: "15 min" },
  { id: "1h", label: "1 hour" },
  { id: "today", label: "Today" },
  { id: "week", label: "This week" },
  { id: "year", label: "Last year" },
  { id: "all", label: "All" },
];

function detailQuery(id) {
  const now = new Date();
  const pack = (from, every) => ({ start: from.toISOString(), every, from, to: now });
  if (id === "15m") return pack(new Date(now - 15 * 60 * 1000), "30s");
  if (id === "1h") return pack(new Date(now - 60 * 60 * 1000), "30s");
  if (id === "today") return pack(new Date(now.getFullYear(), now.getMonth(), now.getDate()), "1m");
  if (id === "week") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    return pack(start, "15m");
  }
  if (id === "year") {
    const start = new Date(now);
    start.setFullYear(start.getFullYear() - 1);
    return pack(start, "1h");
  }
  return { start: "-10y", every: "1d", from: null, to: now };
}

function everyToMs(every) {
  const match = /^(\d+)(s|m|h|d)$/.exec(every);
  if (!match) return 60 * 1000;
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
  return Number(match[1]) * unit;
}

function LatencyChart({ points, rangeId }) {
  const { from, to, every } = detailQuery(rangeId);
  const samples = (points ?? [])
    .filter((p) => p.ms != null && p.t)
    .map((p) => ({ t: new Date(p.t).getTime(), ms: Number(p.ms) }))
    .sort((a, b) => a.t - b.t);

  const end = to?.getTime() ?? Date.now();
  const start = from?.getTime() ?? samples[0]?.t ?? end - 86_400_000;
  const values = samples.map((p) => p.ms);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const yPad = (max - min) * 0.08 || 1;

  return (
    <div className="h-64">
      <Line
        data={{
          datasets: [
            {
              data: samples.map((p) => ({ x: p.t, y: p.ms })),
              borderColor: "#0084FF",
              backgroundColor: "rgba(0, 132, 255, 0.12)",
              fill: true,
              tension: 0.15,
              pointRadius: 0,
              pointHoverRadius: 4,
              borderWidth: 1.5,
              spanGaps: everyToMs(every) * 3,
            },
          ],
        }}
        options={{
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                title: (items) => new Date(items[0].parsed.x).toLocaleString("it-IT"),
                label: (item) => `${item.parsed.y.toFixed(1)} ms`,
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
              min: values.length ? Math.max(0, min - yPad) : 0,
              max: values.length ? max + yPad : 1,
              ticks: { color: "#4B4B4B" },
              grid: { color: "#D3D3D3" },
              title: { display: true, text: "ms", color: "#4B4B4B" },
            },
          },
        }}
      />
      {samples.length === 0 && <p className="text-sm text-text-secondary">No data in this range</p>}
    </div>
  );
}

function RowMenu({ device, onEdit, onDelete, onExpand }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = btnRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, left: rect.right });
    setOpen(true);
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={toggle}
        aria-label={`Azioni ${device.name}`}
        className="cursor-pointer rounded-lg border-border p-1 text-text-secondary hover:bg-bg"
      >
        <MoreVertical size={14} />
      </button>
      {open && pos && (
        <div
          className="fixed z-20 min-w-36 rounded-lg border border-border bg-bg-secondary py-1 text-xs"
          style={{ top: pos.top, left: pos.left, transform: "translateX(-100%)" }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left hover:bg-bg"
            onClick={() => { setOpen(false); onEdit(device); }}
          >
            <Pen size={12} /> Edit
          </button>
          <button
            type="button"
            className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left hover:bg-bg"
            onClick={() => { setOpen(false); onExpand(device); }}
          >
            <Expand size={12} /> Expand
          </button>
          <button
            type="button"
            className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-text-error hover:bg-bg"
            onClick={() => { setOpen(false); onDelete(device); }}
          >
            <Trash size={12} /> Delete
          </button>
        </div>
      )}
    </>
  );
}

function dayLabel(date) {
  const start = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = (start(new Date()) - start(date)) / 86400000;
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return date.toLocaleDateString("it-IT", { day: "2-digit", month: "short", year: "numeric" });
}

function historyPhrase(state) {
  if (state === "DOWN") return "Went down";
  if (state === "UP") return "Came up";
  return "Became unknown";
}

function LatencySpark({ points, status }) {
  const samples = (points ?? [])
    .filter((p) => p.ms != null && p.t)
    .map((p) => ({ x: new Date(p.t).getTime(), y: Number(p.ms) }));
  if (samples.length === 0) return <span className="text-text-secondary">–</span>;

  const color = status === "UP" ? "#36B37E" : status === "DOWN" ? "#FF2626" : "#4B4B4B";

  return (
    <div className="h-7 w-24">
      <Line
        data={{
          datasets: [
            {
              data: samples,
              borderColor: color,
              borderWidth: 1.5,
              pointRadius: 0,
              tension: 0.15,
            },
          ],
        }}
        options={{
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { enabled: false } },
          scales: {
            x: { type: "time", display: false },
            y: { display: false },
          },
          animation: false,
        }}
      />
    </div>
  );
}

export default function App() {
  const [summary, setSummary] = useState(null);
  const [devices, setDevices] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [history, setHistory] = useState({});
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [saving, setSaving] = useState(false);
  const [panel, setPanel] = useState(null);
  const [detailDevice, setDetailDevice] = useState(null);
  const [detailRange, setDetailRange] = useState("1h");
  const [detailPoints, setDetailPoints] = useState([]);
  const [detailError, setDetailError] = useState("");
  const [editing, setEditing] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [actionError, setActionError] = useState("");

  const refresh = useCallback(async () => {
    const [nextSummary, nextDevices, nextAlerts] = await Promise.all([
      getSummary(),
      getDevices(),
      getAlerts(),
    ]);
    const series = await Promise.all(
      nextDevices.map(async (d) => {
        try {
          return [d.id, await getLatency(d.id, 6)];
        } catch {
          return [d.id, []];
        }
      }),
    );
    const alive = new Set(nextDevices.map((d) => d.id));
    setError("");
    setSummary(nextSummary);
    setDevices(nextDevices);
    setAlerts(nextAlerts);
    setHistory(Object.fromEntries(series));
    setSelected((prev) => new Set([...prev].filter((n) => alive.has(n))));
  }, []);

  useEffect(() => {
    let stop = false;
    const run = () => {
      refresh().catch((err) => {
        if (!stop) setError(String(err));
      });
    };
    run();
    const id = setInterval(run, 15000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [refresh]);

  useEffect(() => {
    if (!panel) return;
    const onKey = (e) => {
      if (e.key === "Escape") setPanel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel]);

  useEffect(() => {
    if (panel !== "details" || !detailDevice) return;
    let stop = false;
    const { start, every } = detailQuery(detailRange);
    setDetailPoints([]);
    setDetailError("");
    getLatencyRange(detailDevice.id, start, every)
      .then((points) => {
        if (!stop) {
          setDetailPoints(points);
          setDetailError("");
        }
      })
      .catch((err) => {
        if (!stop) setDetailError(String(err));
      });
    return () => {
      stop = true;
    };
  }, [panel, detailDevice, detailRange]);

  function toggleSelected(deviceName) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(deviceName)) next.delete(deviceName);
      else next.add(deviceName);
      return next;
    });
  }

  function openAdd() {
    setActionError("");
    setEditing(null);
    setName("");
    setHost("");
    setPanel("add");
  }

  function openDetails(device) {
    setDetailDevice(device);
    setDetailRange("1h");
    setDetailError("");
    setPanel("details");
  }

  function openEdit(device) {
    setActionError("");
    setEditing(device.id);
    setName(device.name);
    setHost(device.host);
    setPanel("edit");
  }

  async function onAdd(e) {
    e.preventDefault();
    setSaving(true);
    setActionError("");
    try {
      await addDevice({ name: name.trim(), host: host.trim(), checks: ["ping"] });
      setName("");
      setHost("");
      setPanel(null);
      await refresh();
    } catch (err) {
      setActionError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function onEdit(e) {
    e.preventDefault();
    setSaving(true);
    setActionError("");
    try {
      await updateDevice(editing, { name: name.trim(), host: host.trim() });
      setName("");
      setHost("");
      setEditing(null);
      setPanel(null);
      await refresh();
    } catch (err) {
      setActionError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (selected.size === 0) return;
    const ids = [...selected];
    if (!window.confirm(`Eliminare ${ids.length} device?`)) return;
    setSaving(true);
    setActionError("");
    try {
      await deleteDevices(ids);
      setSelected(new Set());
      await refresh();
    } catch (err) {
      setActionError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function onDeleteOne(device) {
    if (!window.confirm(`Eliminare ${device.name}?`)) return;
    setSaving(true);
    setActionError("");
    try {
      await deleteDevices([device.id]);
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(device.id);
        return next;
      });
      await refresh();
    } catch (err) {
      setActionError(String(err));
    } finally {
      setSaving(false);
    }
  }

  // console.log(summary)


  return (
    <div className="flex h-screen bg-bg">
      <div className="min-w-0 flex-1 p-4 overflow-auto">
        <div className="bg-bg-secondary rounded-lg p-4 flex flex-col">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-brand font-bold text-2xl">
              <Network />
              <span>NMS26 LAN Management System</span>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`inline-block w-3 h-3 rounded-full border-2 border-white ${error ? "bg-text-error" : "bg-text-success"} transition-colors duration-150`}
                title={error ? error : "Sistema attivo"}
              />
              <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${error ? "bg-bg-error text-text-error" : "bg-bg-success text-text-success"} transition-colors duration-150`}>
                {error ? error : "Service working"}
              </span>
            </div>
          </div>
          <span className="text-text-secondary text-sm">
            View, add and manage your network devices
          </span>
        </div>


        <div className="mt-4 bg-bg-secondary rounded-lg p-4 flex flex-col gap-4">
          <div className="text-lg font-bold text-text mb-2">Summary</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="flex flex-col items-center">
              <span className="text-text text-sm">Total</span>
              <span className="text-2xl font-bold text-text">{summary?.total ?? "–"}</span>
            </div>
            <div className="flex flex-col items-center">
              <span className="text-text text-sm">Online</span>
              <span className="text-2xl font-bold text-text-success">{summary?.online ?? "–"}</span>
            </div>
            <div className="flex flex-col items-center">
              <span className="text-text text-sm">Offline</span>
              <span className="text-2xl font-bold text-text-error">{summary?.offline ?? "–"}</span>
            </div>
            <div className="flex flex-col items-center">
              <span className="text-text text-sm">Unknown</span>
              <span className="text-2xl font-bold text-text">{summary?.unknown ?? "–"}</span>
            </div>
          </div>

          <div className="mt-2 flex items-center justify-center text-text text-sm">
            <span className="font-medium">Average latency:</span>&nbsp;
            <span className="font-bold">{summary?.avg_latency_ms ?? "–"} ms</span>
          </div>
        </div>

        {/* Devices */}
        <div className="mt-6 bg-bg-secondary rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="text-lg font-bold text-text mb-2">Devices</div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={openAdd}
                className="flex items-center gap-1 cursor-pointer hover:bg-bg px-2 py-1 rounded-lg border border-border text-xs"
              >
                <Plus size={12} />
                Add device
              </button>

              {
                selected.size > 0 ?
                  <button
                    type="button"
                    onClick={onDelete}
                    disabled={selected.size === 0 || saving}
                    className={`flex items-center gap-1 cursor-pointer hover:bg-bg px-2 py-1 rounded-lg border border-border text-xs text-text-error disabled:opacity-40 disabled:cursor-not-allowed `}
                  >
                    <Trash size={12} />
                    Delete selected
                  </button>
                  :
                  ""
              }
            </div>

          </div>
          {actionError && <p className="text-text-error text-xs mb-2">{actionError}</p>}

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm text-left">
              <thead>
                <tr className="border-b border-bg">
                  <th className="py-2 px-4 font-semibold text-text-secondary"></th>
                  <th className="py-2 px-4 font-semibold text-text-secondary">Name</th>
                  <th className="py-2 px-4 font-semibold text-text-secondary">Host</th>
                  <th className="py-2 px-4 font-semibold text-text-secondary">Status</th>
                  <th className="py-2 px-4 font-semibold text-text-secondary">Latency (ms)</th>
                  <th className="py-2 px-4 font-semibold text-text-secondary">Loss</th>
                  <th className="py-2 px-4 font-semibold text-text-secondary">Last 6h</th>
                  <th className="py-2 px-4 font-semibold text-text-secondary">Last ping</th>
                  <th className="py-2 px-4 font-semibold text-text-secondary">Actions</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.id} className="border-b last:border-b-0 border-bg">
                    <td className="py-2 px-4">
                      <input
                        type="checkbox"
                        checked={selected.has(d.id)}
                        onChange={() => toggleSelected(d.id)}
                        aria-label={`Seleziona ${d.name}`}
                      />
                    </td>
                    <td className="py-2 px-4">{d.name}</td>
                    <td className="py-2 px-4">{d.host}</td>
                    <td className="py-2 px-4">
                      <span className={`inline-block w-2 h-2 rounded-full mr-2 
                      ${d.status === "UP"
                          ? "bg-text-success"
                          : d.status === "DOWN"
                            ? "bg-text-error"
                            : "bg-text-secondary"
                        } 
                    `}></span>
                      <span className={
                        d.status === "UP"
                          ? "text-text-success font-medium"
                          : d.status === "DOWN"
                            ? "text-text-error font-medium"
                            : "text-text-secondary font-medium"
                      }>
                        {d.status ?? "Unknown"}
                      </span>
                    </td>
                    <td className="py-2 px-4">{d.latency_ms ?? "–"}</td>
                    <td className="py-2 px-4">{d.loss_pct + "%" ?? "–"}</td>
                    <td className="py-2 px-4">
                      <LatencySpark points={history[d.id]} status={d.status} />
                    </td>
                    <td className="py-2 px-4">
                      {d.last_ping ? (() => {
                        const dateObj = new Date(d.last_ping);
                        const now = new Date();
                        const isToday =
                          dateObj.getFullYear() === now.getFullYear() &&
                          dateObj.getMonth() === now.getMonth() &&
                          dateObj.getDate() === now.getDate();

                        return isToday
                          ? dateObj.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
                          : dateObj.toLocaleString("it-IT");
                      })() : "–"}
                    </td>
                    <td className="py-2 px-4">
                      <RowMenu device={d} onEdit={openEdit} onDelete={onDeleteOne} onExpand={openDetails} />
                    </td>

                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>







        <div className="mt-6 bg-bg-secondary rounded-lg p-4">
          <div className="mb-4">
            <div className="text-lg font-bold text-text">History</div>
            <p className="text-sm text-text-secondary">Status changes, newest first</p>
          </div>
          {alerts.length === 0 ? (
            <p className="text-sm text-text-secondary">No status changes yet</p>
          ) : (
            <div className="flex flex-col gap-4">
              {alerts.reduce((groups, a) => {
                const when = new Date(a.t);
                const label = dayLabel(when);
                const last = groups[groups.length - 1];
                if (!last || last.label !== label) groups.push({ label, items: [{ ...a, when }] });
                else last.items.push({ ...a, when });
                return groups;
              }, []).map((group) => (
                <section key={group.label}>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">{group.label}</p>
                  <ol className="ml-1 border-l border-border">
                    {group.items.map((a, i) => (
                      <li key={`${a.t}-${a.device}-${i}`} className="relative pb-3 pl-4 last:pb-0">
                        <span className={`absolute left-0 top-1.5 h-2 w-2 -translate-x-1/2 rounded-full ${a.state === "UP" ? "bg-text-success" : a.state === "DOWN" ? "bg-text-error" : "bg-text-secondary"
                          }`} />
                        <div className="flex items-baseline gap-3">
                          <time className="w-16 shrink-0 text-xs text-text-secondary">
                            {a.when.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                          </time>
                          <p className="text-sm">
                            <span className="font-medium text-text">{a.device}</span>{" "}
                            <span className={
                              a.state === "UP" ? "text-text-success" : a.state === "DOWN" ? "text-text-error" : "text-text-secondary"
                            }>
                              {historyPhrase(a.state)}
                            </span>
                          </p>
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>

      <aside
        className={`shrink-0 overflow-hidden bg-bg-secondary transition-[width] duration-200 ${panel === "details" ? "w-[36rem] border-l border-border" : panel ? "w-80 border-l border-border" : "w-0"}`}
      >
        <div className={`${panel === "details" ? "w-[36rem]" : "w-80"} p-4`}>
          {(panel === "add" || panel === "edit") && (
            <>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold text-text">{panel === "add" ? "Add device" : "Edit device"}</h2>
                <button type="button" onClick={() => setPanel(null)} aria-label="Chiudi" className="cursor-pointer text-text-secondary">
                  <X size={16} />
                </button>
              </div>
              <form onSubmit={panel === "add" ? onAdd : onEdit} className="flex flex-col gap-3">
                <label className="flex flex-col gap-1 text-sm text-text">
                  Name
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  >
                  </Input>
                </label>
                <label className="flex flex-col gap-1 text-sm text-text">
                  Host
                  <IPInput
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    required
                  />
                </label>
                {actionError && <p className="text-xs text-text-error">{actionError}</p>}
                <button
                  type="submit"
                  disabled={saving}
                  className="cursor-pointer rounded-lg border border-border px-2 py-1 text-sm hover:bg-bg disabled:opacity-40"
                >
                  {panel === "add" ? "Add" : "Save"}
                </button>
              </form>
            </>
          )}
          {panel === "details" && detailDevice && (
            <>
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-text">{detailDevice.name}</h2>
                  <p className="text-sm text-text-secondary">{detailDevice.host}</p>
                </div>
                <button type="button" onClick={() => setPanel(null)} aria-label="Chiudi" className="cursor-pointer text-text-secondary">
                  <X size={16} />
                </button>
              </div>

              <div className="mb-4 flex items-center">
                <div className="flex items-center rounded-lg border border-border px-2 py-1 gap-1">
                  <Calendar size={16} className="text-text-secondary mr-3" />

                  <div className="w-px h-3 bg-border" />

                  <select
                    value={detailRange}
                    onChange={e => setDetailRange(e.target.value)}
                    className="bg-transparent outline-none text-xs text-text cursor-pointer"
                  >
                    {DETAIL_RANGES.map(range => (
                      <option key={range.id} value={range.id}>
                        {range.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>


              {detailError ? (
                <p className="text-xs text-text-error">{detailError}</p>
              ) : (
                <LatencyChart points={detailPoints} rangeId={detailRange} />
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
