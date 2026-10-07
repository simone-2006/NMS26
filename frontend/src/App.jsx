import { useCallback, useEffect, useState } from "react";
import { addDevice, getAlerts, getDevices, getSummary } from "./api.js";

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

  return (
    <>
      <h1 className="text-red-600 font-bold">NMS26</h1>
      <p>{error}</p>

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
      </form> */}

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
    </>
  );
}
