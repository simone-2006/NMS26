import { useRef, useState } from "react";

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

function shortName(name, limit) {
  if (!name || name.length <= limit) return name || "";
  return `${name.slice(0, limit - 1)}…`;
}

const ZOOMS = [0.35, 0.5, 0.65, 0.8, 1, 1.25, 1.6, 2, 2.5, 3.2];

const MIN_CHORD = 62;
const INNER_R = 96;
const RING_GAP = 88;
const LABEL_PAD = 78;

function ringCapacity(radius) {
  const ratio = Math.min(0.9, MIN_CHORD / (2 * radius));
  return Math.max(6, Math.floor(Math.PI / Math.asin(ratio)));
}

function planRings(count) {
  if (count <= 0) return [];
  const radii = [INNER_R];
  while (radii.reduce((sum, radius) => sum + ringCapacity(radius), 0) < count) {
    radii.push(radii[radii.length - 1] + RING_GAP);
  }
  const caps = radii.map(ringCapacity);
  const counts = Array(radii.length).fill(0);
  let left = count;
  const fair = Math.ceil(count / radii.length);
  for (let i = 0; i < radii.length; i++) {
    const give = Math.min(caps[i], fair, left);
    counts[i] = give;
    left -= give;
  }
  for (let i = radii.length - 1; left > 0 && i >= 0; i--) {
    const extra = Math.min(caps[i] - counts[i], left);
    counts[i] += extra;
    left -= extra;
  }
  return radii
    .map((radius, index) => ({ radius, count: counts[index] }))
    .filter((ring) => ring.count > 0);
}

function layout(devices) {
  const gateway = devices.find(isGateway) || null;
  const rest = devices.filter((device) => device !== gateway);
  const rings = planRings(rest.length);

  const outer = rings.length ? rings[rings.length - 1].radius : 48;
  const size = Math.max(440, Math.ceil((outer + LABEL_PAD) * 2));
  const cx = size / 2;
  const cy = size / 2;
  let cursor = 0;
  const placed = rings.flatMap((ring, ringIndex) => {
    const start = -Math.PI / 2 + (ringIndex % 2 ? Math.PI / ring.count : 0);
    const limit = ring.count >= 16 ? 11 : ring.count >= 10 ? 13 : 16;
    return Array.from({ length: ring.count }, (_, index) => {
      const angle = start + (index / ring.count) * Math.PI * 2;
      const device = rest[cursor++];
      return {
        device,
        angle,
        x: cx + Math.cos(angle) * ring.radius,
        y: cy + Math.sin(angle) * ring.radius,
        limit,
        outer: ringIndex === rings.length - 1,
        stagger: index % 2 === 1,
      };
    });
  });

  return { width: size, height: size, cx, cy, gateway, placed, rings };
}

function labelAt(x, y, angle, outer, stagger) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const out = outer && stagger ? 36 : 16;
  if (cos > 0.38) return { x: x + out, y: y - 1, anchor: "start", line: 12 };
  if (cos < -0.38) return { x: x - out, y: y - 1, anchor: "end", line: 12 };
  if (sin < 0) return { x, y: y - out - 18, anchor: "middle", line: 12 };
  return { x, y: y + out + 14, anchor: "middle", line: 12 };
}

function clampPan(px, py, zoom, width, height) {
  const spareX = Math.max(0, (width - width / zoom) / 2) + 48;
  const spareY = Math.max(0, (height - height / zoom) / 2) + 48;
  return {
    x: Math.min(spareX, Math.max(-spareX, px)),
    y: Math.min(spareY, Math.max(-spareY, py)),
  };
}

function ageLabel(iso) {
  if (!iso) return "";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 45) return "updated just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `last write ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `last write ${hours} h ago`;
}

function discoveryNote({ kind, source, updatedAt, strangers, seenHint }) {
  const where = kind === "leases" ? "DHCP leases" : "ARP cache";
  const when = ageLabel(updatedAt);
  if (source === "loading") return "Checking which LAN hosts are visible.";
  if (source === "missing" || source === "empty" || (source == null && !(seenHint > 0))) {
    return `No hosts in the ${where}. Devices with a host are still monitored. An empty list means that file has nothing to compare, not that every LAN host is already a device.`;
  }
  if (source === "stale" && strangers === 0) {
    return `The ${where} is not updating${when ? ` (${when})` : ""}. An empty list does not mean every LAN host is already a device.`;
  }
  if (source === "stale") {
    return `The ${where} is not updating${when ? ` (${when})` : ""}, so this list can be incomplete.`;
  }
  if (source === "live" && strangers === 0) return `Every host in the ${where} is already a device.`;
  if (strangers === 0) {
    return "This list is empty, but the LAN file is not a confirmed live view. That does not mean every host is already a device.";
  }
  return "";
}

export default function Radar({ devices, unknown, seen, kind = "arp", source = "loading", updatedAt, onOpen, onAdd }) {
  const map = layout(devices || []);
  const [hover, setHover] = useState(null);
  const [zoomStep, setZoomStep] = useState(2);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef(null);
  const suppressClick = useRef(false);
  const zoom = ZOOMS[zoomStep];
  const shrunk = zoom < 1;
  const viewW = shrunk ? map.width : map.width / zoom;
  const viewH = shrunk ? map.height : map.height / zoom;
  const viewX = shrunk ? 0 : (map.width - viewW) / 2 - pan.x;
  const viewY = shrunk ? 0 : (map.height - viewH) / 2 - pan.y;

  function changeZoom(nextStep) {
    const step = Math.min(ZOOMS.length - 1, Math.max(0, nextStep));
    const nextZoom = ZOOMS[step];
    const crossesFit = (zoom < 1) !== (nextZoom < 1);
    setZoomStep(step);
    setPan((current) => {
      if (crossesFit) return { x: 0, y: 0 };
      if (nextZoom < 1) return current;
      return clampPan(current.x, current.y, nextZoom, map.width, map.height);
    });
  }

  function onPointerDown(event) {
    if (event.button !== 0) return;
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      panX: pan.x,
      panY: pan.y,
      zoom,
      moved: false,
    };
  }

  function onPointerMove(event) {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    if (!drag.moved) {
      setDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    drag.moved = true;
    const rect = event.currentTarget.getBoundingClientRect();
    if (drag.zoom < 1) {
      const parent = event.currentTarget.parentElement.getBoundingClientRect();
      const limit = parent.width * (1 - drag.zoom) / 2;
      const nextX = drag.panX + dx;
      const nextY = drag.panY + dy;
      setPan({
        x: Math.min(limit, Math.max(-limit, nextX)),
        y: Math.min(limit, Math.max(-limit, nextY)),
      });
      return;
    }
    const unit = (map.width / drag.zoom) / rect.width;
    setPan(clampPan(drag.panX + dx * unit, drag.panY + dy * unit, drag.zoom, map.width, map.height));
  }

  function onPointerUp() {
    if (dragRef.current?.moved) suppressClick.current = true;
    dragRef.current = null;
    setDragging(false);
  }

  function onClickCapture(event) {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    event.stopPropagation();
    event.preventDefault();
  }
  const strangers = [...(unknown || [])].sort((a, b) => {
    const left = a.name || "";
    const right = b.name || "";
    if (left && !right) return -1;
    if (!left && right) return 1;
    if (left && right && left !== right) return left.localeCompare(right);
    return compareIp(a.ip, b.ip);
  });
  const ordered = [...map.placed].sort((a, b) => Number(a.device.id === hover) - Number(b.device.id === hover));
  const note = discoveryNote({ kind, source, updatedAt, strangers: strangers.length, seenHint: seen });

  return (
    <div className="mt-4 rounded-lg bg-bg-secondary p-3 sm:mt-6 sm:p-4">
      <div className="mb-3">
        <div className="text-lg font-bold text-text">Radar</div>
        <p className="text-sm text-text-secondary">
          Devices you watch. Hosts on the right come only from the LAN file the collector can read.
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0">
          {devices.length === 0 ? (
            <p className="text-sm text-text-secondary">No devices yet</p>
          ) : (
            <div className="relative w-full z-1000">
              <div className="absolute top-2 right-2 z-10 flex flex-col overflow-hidden rounded-lg border border-border bg-bg-secondary">
                <button
                  type="button"
                  aria-label="Zoom in"
                  disabled={zoomStep === ZOOMS.length - 1}
                  onClick={() => changeZoom(zoomStep + 1)}
                  className="cursor-pointer px-2.5 py-1.5 text-sm font-medium text-text hover:bg-bg disabled:cursor-not-allowed disabled:opacity-40"
                >
                  +
                </button>
                <button
                  type="button"
                  aria-label="Zoom out"
                  disabled={zoomStep === 0}
                  onClick={() => changeZoom(zoomStep - 1)}
                  className="cursor-pointer border-t border-border px-2.5 py-1.5 text-sm font-medium text-text hover:bg-bg disabled:cursor-not-allowed disabled:opacity-40"
                >
                  −
                </button>
              </div>
              <svg
                viewBox={`${viewX} ${viewY} ${viewW} ${viewH}`}
                style={{
                  width: shrunk ? `${zoom * 100}%` : "100%",
                  transform: shrunk ? `translate(${pan.x}px, ${pan.y}px)` : undefined,
                }}
                className={`mx-auto block h-auto touch-none select-none ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onClickCapture={onClickCapture}
              >
                {map.rings.map((ring) => (
                  <circle
                    key={ring.radius}
                    cx={map.cx}
                    cy={map.cy}
                    r={ring.radius}
                    fill="none"
                    stroke="#ECECEC"
                  />
                ))}
                {map.placed.map(({ device, x, y }) => (
                  <line
                    key={`link-${device.id}`}
                    x1={map.cx}
                    y1={map.cy}
                    x2={x}
                    y2={y}
                    stroke="#E4E4E4"
                    strokeWidth="1"
                  />
                ))}
                {map.gateway ? (
                  <Node
                    device={map.gateway}
                    x={map.cx}
                    y={map.cy}
                    label={{ x: map.cx, y: map.cy + 24, anchor: "middle", line: 12 }}
                    name={shortName(map.gateway.name, 16)}
                    active={hover === map.gateway.id}
                    onOpen={onOpen}
                    onHover={setHover}
                  />
                ) : (
                  <circle cx={map.cx} cy={map.cy} r="6" fill="#D3D3D3" />
                )}
                {ordered.map((node) => (
                  <Node
                    key={node.device.id}
                    device={node.device}
                    x={node.x}
                    y={node.y}
                    label={labelAt(node.x, node.y, node.angle, node.outer, node.stagger)}
                    name={hover === node.device.id ? node.device.name : shortName(node.device.name, node.limit)}
                    active={hover === node.device.id}
                    onOpen={onOpen}
                    onHover={setHover}
                  />
                ))}
              </svg>
            </div>
          )}
        </div>
        <div className="min-w-0">
          <div className="lg:sticky lg:top-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
              Not in inventory
              {seen > 0 && source === "live" ? ` · ${seen}` : ""}
            </p>
            {note && (
              <p className="mt-2 text-xs leading-4 text-text-secondary">
                {note}
              </p>
            )}
            {strangers.length > 0 && (
              <ul className="mt-2 flex max-h-[32rem] flex-col gap-1 overflow-auto">
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
    </div>
  );
}

function Node({ device, x, y, label, name, active, onOpen, onHover }) {
  const color = statusColor(device.status);
  const latency = device.latency_ms == null ? "" : `${Number(device.latency_ms).toFixed(0)} ms`;
  const latY = label.y + label.line;
  return (
    <g
      className="cursor-pointer"
      onClick={() => onOpen(device)}
      onMouseEnter={() => onHover(device.id)}
      onMouseLeave={() => onHover(null)}
    >
      <title>{`${device.name}${device.network_name && device.network_name !== device.name ? ` (${device.network_name})` : ""} ${device.status || ""} ${device.current_ip || device.host || ""}`}</title>
      <circle cx={x} cy={y} r="16" fill="transparent" />
      <circle cx={x} cy={y} r={active ? 11 : 9} fill="#FFFFFF" stroke={color} strokeWidth="3" />
      <text
        x={label.x}
        y={label.y}
        textAnchor={label.anchor}
        fontSize={active ? 12 : 11}
        fontWeight={active ? 600 : 400}
        fill="#181818"
        stroke="#FFFFFF"
        strokeWidth="4"
        paintOrder="stroke"
        strokeLinejoin="round"
      >
        {name}
      </text>
      {latency && (
        <text
          x={label.x}
          y={latY}
          textAnchor={label.anchor}
          fontSize="10"
          fill="#4B4B4B"
          stroke="#FFFFFF"
          strokeWidth="4"
          paintOrder="stroke"
          strokeLinejoin="round"
        >
          {latency}
        </text>
      )}
    </g>
  );
}
