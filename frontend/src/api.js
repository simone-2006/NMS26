async function send(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

export const getSummary = () => send("/api/summary");
export const getDevices = () => send("/api/devices");
export const getAlerts = () => send("/api/alerts");

export const addDevice = (device) =>
  send("/api/devices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(device),
  });
