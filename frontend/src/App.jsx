import { useCallback, useEffect, useRef, useState } from "react";
import { addDevice, deleteDevices, getAlerts, getDevices, getLatency, getSummary, updateDevice } from "./api.js";
import { MoreVertical, Network, Pen, Plus, Trash, X, Expand } from "lucide-react";

function RowMenu({ device, onEdit, onDelete }) {
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
            onClick={console.log("Expand details")}
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

  function openAdd() {
    setActionError("");
    setEditing(null);
    setName("");
    setHost("");
    setPanel("add");
  }

  function openEdit(device) {
    setActionError("");
    setEditing(device.name);
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

  async function onDeleteOne(device) {
    if (!window.confirm(`Eliminare ${device.name}?`)) return;
    setSaving(true);
    setActionError("");
    try {
      await deleteDevices([device.name]);
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(device.name);
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
                    <td className="py-2 px-4">
                      <RowMenu device={d} onEdit={openEdit} onDelete={onDeleteOne} />
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
        className={`shrink-0 overflow-hidden bg-bg-secondary transition-[width] duration-200 ${panel ? "w-80 border-l border-border" : "w-0"}`}
      >
        <div className="w-80 p-4">
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
        </div>
      </aside>
    </div>
  );
}
