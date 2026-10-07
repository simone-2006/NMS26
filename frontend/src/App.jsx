import { useCallback, useEffect, useState } from "react";
import { addDevice, getAlerts, getDevices, getSummary } from "./api.js";
import { Network } from "lucide-react";

export default function App() {
  const [summary, setSummary] = useState(null);
  const [devices, setDevices] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    const [nextSummary, nextDevices, nextAlerts] = await Promise.all([
      getSummary(),
      getDevices(),
      getAlerts(),
    ]);
    setError("");
    setSummary(nextSummary);
    setDevices(nextDevices);
    setAlerts(nextAlerts);
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

  async function onAdd(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await addDevice({ name: name.trim(), host: host.trim(), checks: ["ping"] });
      setName("");
      setHost("");
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  // console.log(summary)


  return (
    <div className="p-4 bg-bg">
      {/* Title */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1 text-brand text-2xl font-bold">
            <Network></Network>
            <h1 className="">NMS26 LAN Management System</h1>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`inline-block w-3 h-3 rounded-full border-2 border-white ${error ? "bg-text-error" : "bg-text-success"} transition-colors duration-150`}
              title={error ? error : "Sistema attivo"}
            ></span>
            <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${error ? "bg-bg-error text-text-error" : "bg-bg-success text-text-success"} transition-colors duration-150`}>
              {error ? error : "Service working"}
            </span>
          </div>

        </div>
        <p className="text-text-secondary text-sm"> View, add and manage your network devices </p>
      </div>

      <div className="mt-4 bg-bg-secondary rounded-lg p-4 flex flex-col gap-4">
        <div className="text-lg font-bold text-text mb-2">Summary</div>
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1 flex flex-col items-center">
            <span className="text-text text-sm">Total</span>
            <span className="text-2xl font-bold text-text">{summary?.total ?? "–"}</span>
          </div>
          <div className="flex-1 flex flex-col items-center">
            <span className="text-text text-sm">Online</span>
            <span className="text-2xl font-bold text-text-success">{summary?.online ?? "–"}</span>
          </div>
          <div className="flex-1 flex flex-col items-center">
            <span className="text-text text-sm">Offline</span>
            <span className="text-2xl font-bold text-text-error">{summary?.offline ?? "–"}</span>
          </div>
          <div className="flex-1 flex flex-col items-center">
            <span className="text-text text-sm">Unknown</span>
            <span className="text-2xl font-bold text-text">{summary?.unknown ?? "–"}</span>
          </div>
        </div>
        <div className="mt-2 flex items-center justify-center text-text text-sm">
          <span className="font-medium">Average latency:</span>&nbsp;
          <span className="font-bold">{summary?.avg_latency_ms ?? "–"} ms</span>
        </div>
      </div>
      <div className="mt-6 bg-bg-secondary rounded-lg p-4">
        <div className="text-lg font-bold text-text mb-2">Devices</div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm text-left">
            <thead>
              <tr className="border-b border-bg">
                <th className="py-2 px-4 font-semibold text-text-secondary">Name</th>
                <th className="py-2 px-4 font-semibold text-text-secondary">Host</th>
                <th className="py-2 px-4 font-semibold text-text-secondary">Status</th>
                <th className="py-2 px-4 font-semibold text-text-secondary">Latency (ms)</th>
                <th className="py-2 px-4 font-semibold text-text-secondary">Loss (%)</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.name} className="border-b last:border-b-0 border-bg">
                  <td className="py-2 px-4">{d.name}</td>
                  <td className="py-2 px-4">{d.host}</td>
                  <td className="py-2 px-4">
                    <span className={`inline-block w-3 h-3 rounded-full mr-2 
                      ${
                        d.status === "UP"
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
  );
}
