<!-- Language Selector -->
<p align="right">
  <a href="#en">🇬🇧 English</a> |
  <a href="#it">🇮🇹 Italiano</a>
</p>

<a id="en"></a>
# NMS26

LAN monitor. Maintains a device inventory, checks them via ICMP ping, and displays status, latency, and up/down event history.

The web interface is available at [http://localhost:26173](http://localhost:26173). The API is at [http://localhost:26800](http://localhost:26800), Grafana at [http://localhost:26300](http://localhost:26300), and InfluxDB at [http://localhost:26886](http://localhost:26886).

## Quick Start

```bash
cp .env.example .env
cp config/devices.example.yml config/devices.yml
docker compose up -d --build
```

In `.env`, make sure to change at least `INFLUX_PASSWORD` and `INFLUX_TOKEN` before the first startup: InfluxDB uses them during initial setup. Devices are configured in `config/devices.yml`, starting from the example template. The UI reads and writes them via the API. This file, along with `config/arp-cache.txt` and `config/lan-names.txt`, is listed in `.gitignore`: your LAN inventory should not be committed to the repository.

The frontend is mounted directly from disk and auto-reloads. The API and collector are built into the image: after modifying their code, run `docker compose up -d --build api collector`.

## Architecture

| Service | Role |
|---|---|
| frontend | User Interface: inventory list, charts, event history |
| api | Reads/writes `config/devices.yml`, queries InfluxDB |
| collector | Performs periodic pings and records status, latency, and current IP |
| influxdb | Time-series database |
| grafana | Pre-configured dashboard connected to the bucket |

Status and latency are tied to the device ID, not its IP address. Even if the IP address changes, historical data remains associated with the same device.

## Devices

Each device requires a name and a target. The target must be specified using **only one** of the following:

**Host.** A static IP or hostname (`192.168.178.1`, `camera.lan`). The collector pings this target every cycle. Hostnames work if local DNS (typically your router) resolves them to the current IP address. If resolution fails, the device goes DOWN.

**MAC (with Host left empty).** Used for devices with dynamic IP addresses lacking reliable DNS hostnames. In each cycle, the collector searches DHCP leases for the MAC address and pings only the newly discovered IP. Previous IP addresses are not reused.

If both Host and MAC are specified, Host takes precedence for pinging. The MAC is not used to look up the address in this case.

**Current IP** is read-only. It displays the IPv4 address used during the last check: it matches Host when Host is an IP, shows the resolved IP when Host is a hostname, and shows the lease IP when the device is MAC-only. If a MAC-only device is missing from DHCP leases, Current IP remains blank.

For fixed devices, setting up a DHCP reservation on your router and adding its IP to the Host field is the simplest approach.

## States

| State | Meaning |
|---|---|
| Loading | Newly added device; no checks completed yet |
| UP | Responding; requires `UP_AFTER_OKS` consecutive successful pings |
| DOWN | Unresponsive; occurs after `DOWN_AFTER_FAILS` consecutive failed pings on the resolved IP |
| Unresolved | MAC-only device with no confirmed IP during the current cycle. This is not treated as a DOWN state |

Initial transitions to UP do not trigger notifications. Alerts are dispatched when a device transitions to DOWN, or recovers to UP following a DOWN state. If `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are left empty, notification messages are written to collector logs only.

## MAC-Only Devices

Running inside Docker, the collector cannot access the host machine's ARP table directly, as its network scope is restricted to container neighbors. On a Windows PC connected to the target LAN, running `scripts/export-arp.ps1` queries local Windows neighbors (and scans the subnet for missing targets) to generate `config/arp-cache.txt`. The collector re-reads this file on every cycle.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/export-arp.ps1
```

Keep this script running alongside Docker. Alternatively, router DHCP leases remain the preferred source: mount your `dnsmasq` lease file and configure the corresponding variable:

```yaml
# collector.volumes in docker-compose.yml
- /var/lib/misc/dnsmasq.leases:/leases/dnsmasq.leases:ro
```

```bash
DHCP_LEASES_PATH=/leases/dnsmasq.leases
```

The system parses standard `dnsmasq` lease formats (expiration, MAC, IP, hostname, client-id) and ignores expired leases. Without this file or `config/arp-cache.txt`, the collector can only observe its container network's ARP table, leaving MAC-only devices in an Unresolved state.

## Environment Variables

Copied from `.env.example`.

| Variable | Description |
|---|---|
| `INFLUX_USER`, `INFLUX_PASSWORD` | Initial InfluxDB credentials |
| `INFLUX_ORG`, `INFLUX_BUCKET`, `INFLUX_TOKEN` | Organization, bucket, and API access token for services |
| `INFLUX_URL` | Container-internal InfluxDB address (`http://influxdb:8086`) |
| `CHECK_INTERVAL` | Interval between ping cycles (in seconds) |
| `PING_COUNT` | Number of ICMP packets sent per check cycle |
| `DOWN_AFTER_FAILS` | Consecutive failed checks before transitioning to DOWN |
| `UP_AFTER_OKS` | Consecutive successful checks before transitioning to UP |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Telegram notification settings (leave empty for log-only output) |
| `DHCP_LEASES_PATH` | Path to container-mounted `dnsmasq` lease file. Disables host ARP lookup when set |
| `ARP_CACHE_PATH` | Path to `mac ip` mapping file. Defaults to `/config/arp-cache.txt` |

## Security & Networking

Authentication is not implemented. The API provides read/write access to device lists, and InfluxDB authenticates using `.env` tokens. Keep this system isolated to local host environments or trusted local networks. Do not expose or forward ports `26173` (UI), `26800` (API), `26300` (Grafana), or `26886` (InfluxDB) to the public Internet.

---

<a id="it"></a>
# NMS26

Monitor della LAN. Tiene l'elenco dei dispositivi, li controlla con ping ICMP e mostra stato, latenza e storico dei cambi up/down.

L'interfaccia è su [http://localhost:26173](http://localhost:26173). L'API è su [http://localhost:26800](http://localhost:26800), Grafana su [http://localhost:26300](http://localhost:26300), InfluxDB su [http://localhost:26886](http://localhost:26886).

## Avvio

```bash
cp .env.example .env
cp config/devices.example.yml config/devices.yml
docker compose up -d --build
```

Nel `.env` vanno cambiati almeno `INFLUX_PASSWORD` e `INFLUX_TOKEN` prima del primo avvio: InfluxDB li usa solo in fase di setup. I dispositivi stanno in `config/devices.yml`, a partire dall'esempio. L'interfaccia li legge e li scrive tramite l'API. Quel file, insieme a `config/arp-cache.txt` e `config/lan-names.txt`, è nel `.gitignore`: l'inventario della LAN non va nel repository.

Il frontend è montato dal disco e si aggiorna da solo. API e collector sono nell'immagine: dopo una modifica al loro codice serve `docker compose up -d --build api collector`.

## Come è fatto

| Servizio  | Ruolo                                                          |
| --------- | -------------------------------------------------------------- |
| frontend  | Interfaccia: elenco, grafici, storico                          |
| api       | Lettura e scrittura di `config/devices.yml`, query su InfluxDB |
| collector | Ping periodico e scrittura di stato, latenza e IP corrente     |
| influxdb  | Serie temporali                                                |
| grafana   | Dashboard già collegata al bucket                              |

Lo stato e la latenza sono associati all'id del dispositivo, non all'indirizzo IP. Se l'IP cambia, lo storico resta dello stesso dispositivo.

## Dispositivi

Ogni dispositivo ha un nome e un bersaglio. Il bersaglio è uno solo dei due.

**Host.** IP fisso oppure un nome (`192.168.178.1`, `camera.lan`). Il collector pinga quel valore a ogni ciclo. Un nome funziona se il DNS, di solito il router, lo risolve sull'indirizzo attuale. Se il nome non si risolve, il dispositivo va down.

**MAC, con Host vuoto.** Per un indirizzo che cambia e non ha un nome affidabile. A ogni ciclo il collector cerca il MAC nei lease DHCP e pinga solo l'IP trovato in quel momento. Non riusa un IP precedente.

Se sono compilati entrambi, viene pingato l'Host. Il MAC non serve a trovare l'indirizzo.

**Current IP** non si inserisce. È l'indirizzo IPv4 usato nell'ultimo controllo: coincide con l'Host quando l'Host è già un IP, è l'indirizzo risolto quando l'Host è un nome, ed è l'IP del lease quando il dispositivo ha solo il MAC. Se il MAC non è nel lease, Current IP è vuoto.

Per un indirizzo stabile la strada più semplice è una prenotazione DHCP sul router e l'IP nel campo Host.

## Stati

| Stato      | Significato                                                                              |
| ---------- | ---------------------------------------------------------------------------------------- |
| Loading    | Appena aggiunto, nessun controllo confermato                                             |
| UP         | Risponde, dopo `UP_AFTER_OKS` ping riusciti di fila                                      |
| DOWN       | Non risponde, dopo `DOWN_AFTER_FAILS` ping falliti di fila sull'indirizzo appena risolto |
| Unresolved | Ha solo il MAC e in questo ciclo non c'è un IP confermato. Non è un down                 |

Il primo passaggio a UP non manda una notifica. La notifica parte quando torna UP dopo un DOWN, e quando va DOWN. Con `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID` vuoti, il messaggio resta nel log del collector.

## Dispositivi con solo MAC

Il collector, dentro Docker, non vede la tabella ARP della LAN: la sua rete contiene solo gli altri container. Sul PC che sta in LAN, `scripts/export-arp.ps1` legge i vicini Windows (e, se un MAC dell'elenco manca, interroga la subnet) e scrive `config/arp-cache.txt`. Il collector lo rilegge a ogni ciclo.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/export-arp.ps1
```

Lo script va lasciato aperto insieme a Docker. I lease del router, se li hai, restano la fonte preferita: monta il file di dnsmasq e imposta la variabile.

```yaml
# collector.volumes in docker-compose.yml
- /var/lib/misc/dnsmasq.leases:/leases/dnsmasq.leases:ro
```

```bash
DHCP_LEASES_PATH=/leases/dnsmasq.leases
```

Il formato letto è quello di dnsmasq: scadenza, MAC, IP, nome, client-id. I lease scaduti si ignorano. Senza quel file e senza `config/arp-cache.txt`, il collector vede solo l'ARP del container e un MAC resta Unresolved.

## Variabili

Copiate da `.env.example`.

| Variabile                                     | Uso                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------- |
| `INFLUX_USER`, `INFLUX_PASSWORD`              | Account iniziale di InfluxDB                                                            |
| `INFLUX_ORG`, `INFLUX_BUCKET`, `INFLUX_TOKEN` | Organizzazione, bucket e token usati da API, collector e Grafana                        |
| `INFLUX_URL`                                  | URL di InfluxDB visto dai container (`http://influxdb:8086`)                            |
| `CHECK_INTERVAL`                              | Secondi tra un ciclo di ping e il successivo                                            |
| `PING_COUNT`                                  | Pacchetti ICMP per controllo                                                            |
| `DOWN_AFTER_FAILS`                            | Fallimenti consecutivi prima di DOWN                                                    |
| `UP_AFTER_OKS`                                | Successi consecutivi prima di UP                                                        |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`      | Notifiche. Vuoti: solo log                                                              |
| `DHCP_LEASES_PATH`                            | File lease dnsmasq dentro il container. Se è impostato, l'ARP dell'host non viene usato |
| `ARP_CACHE_PATH`                              | File `mac ip` letto dal collector. Default: `/config/arp-cache.txt`                     |

## Rete

Non c'è login. L'API può leggere e riscrivere l'elenco dei dispositivi, e InfluxDB risponde con il token del `.env`. Va tenuto sulla macchina che lo esegue, oppure su una LAN di cui ti fidi. Non inoltrare verso Internet le porte `26173` (interfaccia), `26800` (API), `26300` (Grafana) e `26886` (InfluxDB).