function compareIp(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 4; i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function isGateway(device) {
  return /router/i.test(device.name || "") || String(device.host || "").endsWith(".1");
}

function statusColor(status) {
  if (status === "UP") return "#36B37E";
  if (status === "DOWN") return "#FF2626";
  return "#4B4B4B";
}

function shortName(name) {
  if (!name || name.length <= 16) return name || "";
  return `${name.slice(0, 15)}…`;
}

function layout(devices) {
  const width = 640;
  const height = 320;
  const gateway = devices.find(isGateway) || null;
  const rest = devices.filter((device) => device !== gateway);
  const placed = rest.map((device, index) => {
    const angle = -Math.PI / 2 + (rest.length ? (index / rest.length) * Math.PI * 2 : 0);
    return {
      device,
      x: width / 2 + Math.cos(angle) * 250,
      y: height / 2 + Math.sin(angle) * 100,
    };
  });
  return {
    width,
    height,
    gateway,
    placed,
  };
}

export default function Radar({ devices, unknown, seen, onOpen, onAdd }) {
  const map = layout(devices || []);
  const strangers = [...(unknown || [])].sort((a, b) => {
    const left = a.name || "";
    const right = b.name || "";
    if (left && !right) return -1;
    if (!left && right) return 1;
    if (left && right && left !== right) return left.localeCompare(right);
    return compareIp(a.ip, b.ip);
  });

  return (
    <div className="mt-6 rounded-lg bg-bg-secondary p-4">
      <div className="mb-3">
        <div className="text-lg font-bold text-text">Radar</div>
        <p className="text-sm text-text-secondary">
          Devices you watch, and hosts seen on the LAN that are not in the inventory
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0">
          {devices.length === 0 ? (
            <p className="text-sm text-text-secondary">No devices yet</p>
          ) : (
            <svg viewBox={`0 0 ${map.width} ${map.height}`} className="h-72 w-full">
              {map.placed.map(({ device, x, y }) => (
                <line
                  key={`link-${device.id}`}
                  x1={map.width / 2}
                  y1={map.height / 2}
                  x2={x}
                  y2={y}
                  stroke="#D3D3D3"
                  strokeWidth="1"
                />
              ))}
              {map.gateway ? (
                <Node
                  device={map.gateway}
                  x={map.width / 2}
                  y={map.height / 2}
                  onOpen={onOpen}
                />
              ) : (
                <circle cx={map.width / 2} cy={map.height / 2} r="6" fill="#D3D3D3" />
              )}
              {map.placed.map(({ device, x, y }) => (
                <Node key={device.id} device={device} x={x} y={y} onOpen={onOpen} />
              ))}
            </svg>
          )}
        </div>
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
            Not in inventory
          </p>
          {seen === 0 && (
            <p className="mt-2 text-xs leading-4 text-text-secondary">
              The ARP table is empty. Keep the export script running.
            </p>
          )}
          {seen > 0 && strangers.length === 0 && (
            <p className="mt-2 text-xs leading-4 text-text-secondary">
              Every host in the ARP table is already a device.
            </p>
          )}
          {strangers.length > 0 && (
            <ul className="mt-2 flex max-h-64 flex-col gap-1 overflow-auto">
              {strangers.map((neighbor) => (
                <li key={neighbor.mac} className="flex items-center justify-between gap-2 rounded-md bg-bg px-2 py-1.5">
                  <span className="min-w-0">
                    <span className="block truncate text-xs text-text">{neighbor.name || neighbor.ip}</span>
                    <span className="block truncate font-mono text-[11px] text-text-secondary">
                      {neighbor.name ? `${neighbor.ip}  ${neighbor.mac}` : neighbor.mac}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => onAdd(neighbor)}
                    className="shrink-0 cursor-pointer text-[11px] font-medium text-brand"
                  >
                    Add
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function Node({ device, x, y, onOpen }) {
  const color = statusColor(device.status);
  const latency = device.latency_ms == null ? "" : `${Number(device.latency_ms).toFixed(0)} ms`;
  return (
    <g className="cursor-pointer" onClick={() => onOpen(device)}>
      <title>{`${device.name}${device.network_name && device.network_name !== device.name ? ` (${device.network_name})` : ""} ${device.status || ""} ${device.current_ip || device.host || ""}`}</title>
      <circle cx={x} cy={y} r="10" fill="#FFFFFF" stroke={color} strokeWidth="3" />
      <text x={x} y={y + 28} textAnchor="middle" fontSize="11" fill="#181818">
        {shortName(device.name)}
      </text>
      {latency && (
        <text x={x} y={y + 40} textAnchor="middle" fontSize="10" fill="#4B4B4B">
          {latency}
        </text>
      )}
    </g>
  );
}
