import { useCallback, useEffect, useState } from "react";
import { addDevice, deleteDevices, getAlerts, getDevices, getLatency, getSummary } from "./api.js";
import { Edit, Expand, Network, Pen, Plus, Trash, X } from "lucide-react";

function LatencySpark({ points, status }) {
  const values = (points ?? []).map((p) => p.ms).filter((v) => v != null);
  const color =
    status === "UP" ? "text-text-success" : status === "DOWN" ? "text-text-error" : "text-text-secondary";
  if (values.length === 0) return <span className="text-text-secondary">–</span>;

  const w = 96;
  const h = 28;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const coords = values.map((v, i) => {
    const x = values.length === 1 ? w / 2 : (i / (values.length - 1)) * w;
    const y = h - 2 - ((v - min) / span) * (h - 4);
    return [x, y];
  });
  const d = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");

  return (
    <svg width={w} height={h} className={color} role="img" aria-label={`${status}, ultime 6 ore`}>
      <title>{`${min.toFixed(0)}–${max.toFixed(0)} ms · ${status}`}</title>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
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
          return [d.name, await getLatency(d.name, 6)];
        } catch {
          return [d.name, []];
        }
      }),
    );
    const alive = new Set(nextDevices.map((d) => d.name));
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

  function toggleSelected(deviceName) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(deviceName)) next.delete(deviceName);
      else next.add(deviceName);
      return next;
    });
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

  async function onDelete() {
    if (selected.size === 0) return;
    const names = [...selected];
    if (!window.confirm(`Eliminare ${names.length} device?`)) return;
    setSaving(true);
    setActionError("");
    try {
      await deleteDevices(names);
      setSelected(new Set());
      await refresh();
    } catch (err) {
      setActionError(String(err));
    } finally {
      setSaving(false);
    }
  }

  // console.log(summary)


  return (
    <div className="flex min-h-screen bg-bg">
      <div className="min-w-0 flex-1 p-4">
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
                onClick={() => { setActionError(""); setPanel("add"); }}
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
                  <th className="py-2 px-4 font-semibold text-text-secondary">Loss (%)</th>
                  <th className="py-2 px-4 font-semibold text-text-secondary">Last 6h</th>
                  <th className="py-2 px-4 font-semibold text-text-secondary">Last ping</th>
                  <th className="py-2 px-4 font-semibold text-text-secondary">Actions</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.name} className="border-b last:border-b-0 border-bg">
                    <td className="py-2 px-4">
                      <input
                        type="checkbox"
                        checked={selected.has(d.name)}
                        onChange={() => toggleSelected(d.name)}
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
                    <td className="py-2 px-4">{d.loss_pct ?? "–"}</td>
                    <td className="py-2 px-4">
                      <LatencySpark points={history[d.name]} status={d.status} />
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
                    <td className="flex items-center gap-2 justify-center">
                      <button
                        type="button"
                        className="flex items-center gap-1 cursor-pointer hover:bg-bg px-2 py-1 rounded-lg border border-border text-xs"
                      >
                        <Pen size={12} />
                      </button>
                      <button
                        type="button"
                        className="flex items-center gap-1 cursor-pointer hover:bg-bg px-2 py-1 rounded-lg border border-border text-xs"
                      >
                        <Expand size={12} />
                      </button>
                    </td>

                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>







        {/* <h2>Riepilogo</h2>
      <pre>{summary ? JSON.stringify(summary, null, 2) : "…"}</pre> */}

        {/* <h2>Aggiungi device</h2>
      <form onSubmit={onAdd}>
        <label>
          Nome <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>{" "}
        <label>
          Host <input value={host} onChange={(e) => setHost(e.target.value)} required />
        </label>{" "}
        <button type="submit" disabled={saving}>Aggiungi</button>
      </form>  */}

        {/* <h2>Device</h2>
      <table>
        <thead>
          <tr>
            <th>Nome</th>
            <th>Host</th>
            <th>Stato</th>
            <th>Latenza ms</th>
            <th>Loss %</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((d) => (
            <tr key={d.name}>
              <td>{d.name}</td>
              <td>{d.host}</td>
              <td>{d.status}</td>
              <td>{d.latency_ms ?? "—"}</td>
              <td>{d.loss_pct ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table> */}

        {/* <h2>Alert</h2>
      <ul>
        {alerts.map((a, i) => (
          <li key={`${a.t}-${a.device}-${i}`}>
            {a.t}  {a.device}  {a.state}
          </li>
        ))}
      </ul> */}
      </div>

      <aside
        className={`shrink-0 overflow-hidden bg-bg-secondary transition-[width] duration-200 ${panel ? "w-80 border-l border-border" : "w-0"}`}
      >
        <div className="w-80 p-4">
          {panel === "add" && (
            <>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold text-text">Add device</h2>
                <button type="button" onClick={() => setPanel(null)} aria-label="Chiudi" className="cursor-pointer text-text-secondary">
                  <X size={16} />
                </button>
              </div>
              <form onSubmit={onAdd} className="flex flex-col gap-3">
                <label className="flex flex-col gap-1 text-sm text-text">
                  Name
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    className="border border-border rounded-lg px-2 py-1"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm text-text">
                  Host
                  <input
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    required
                    className="border border-border rounded-lg px-2 py-1"
                  />
                </label>
                <button
                  type="submit"
                  disabled={saving}
                  className="cursor-pointer rounded-lg border border-border px-2 py-1 text-sm hover:bg-bg disabled:opacity-40"
                >
                  Add
                </button>
              </form>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
