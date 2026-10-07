async function send(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

export const getSummary = () => send("/api/summary");
export const getDevices = () => send("/api/devices");
export const getAlerts = (limit = 50, device) => {
  const q = new URLSearchParams({ limit: String(limit) });
  if (device) q.set("device", device);
  return send(`/api/alerts?${q}`);
};
export const getLatency = (name, hours = 6) =>
  send(`/api/devices/${encodeURIComponent(name)}/latency?hours=${hours}`);

export const getLatencyRange = (name, start, every) =>
  send(
    `/api/devices/${encodeURIComponent(name)}/latency?start=${encodeURIComponent(start)}&every=${encodeURIComponent(every)}`,
  );

export const addDevice = (device) =>
  send("/api/devices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(device),
  });

export const updateDevice = (id, device) =>
  send(`/api/devices/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(device),
  });

export const deleteDevices = (ids) =>
  send("/api/devices", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
