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

| Servizio | Ruolo |
|---|---|
| frontend | Interfaccia: elenco, grafici, storico |
| api | Lettura e scrittura di `config/devices.yml`, query su InfluxDB |
| collector | Ping periodico e scrittura di stato, latenza e IP corrente |
| influxdb | Serie temporali |
| grafana | Dashboard già collegata al bucket |

Lo stato e la latenza sono associati all'id del dispositivo, non all'indirizzo IP. Se l'IP cambia, lo storico resta dello stesso dispositivo.

## Dispositivi

Ogni dispositivo ha un nome e un bersaglio. Il bersaglio è uno solo dei due.

**Host.** IP fisso oppure un nome (`192.168.178.1`, `camera.lan`). Il collector pinga quel valore a ogni ciclo. Un nome funziona se il DNS, di solito il router, lo risolve sull'indirizzo attuale. Se il nome non si risolve, il dispositivo va down.

**MAC, con Host vuoto.** Per un indirizzo che cambia e non ha un nome affidabile. A ogni ciclo il collector cerca il MAC nei lease DHCP e pinga solo l'IP trovato in quel momento. Non riusa un IP precedente.

Se sono compilati entrambi, viene pingato l'Host. Il MAC non serve a trovare l'indirizzo.

**Current IP** non si inserisce. È l'indirizzo IPv4 usato nell'ultimo controllo: coincide con l'Host quando l'Host è già un IP, è l'indirizzo risolto quando l'Host è un nome, ed è l'IP del lease quando il dispositivo ha solo il MAC. Se il MAC non è nel lease, Current IP è vuoto.

Per un indirizzo stabile la strada più semplice è una prenotazione DHCP sul router e l'IP nel campo Host.

## Stati

| Stato | Significato |
|---|---|
| Loading | Appena aggiunto, nessun controllo confermato |
| UP | Risponde, dopo `UP_AFTER_OKS` ping riusciti di fila |
| DOWN | Non risponde, dopo `DOWN_AFTER_FAILS` ping falliti di fila sull'indirizzo appena risolto |
| Unresolved | Ha solo il MAC e in questo ciclo non c'è un IP confermato. Non è un down |

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

| Variabile | Uso |
|---|---|
| `INFLUX_USER`, `INFLUX_PASSWORD` | Account iniziale di InfluxDB |
| `INFLUX_ORG`, `INFLUX_BUCKET`, `INFLUX_TOKEN` | Organizzazione, bucket e token usati da API, collector e Grafana |
| `INFLUX_URL` | URL di InfluxDB visto dai container (`http://influxdb:8086`) |
| `CHECK_INTERVAL` | Secondi tra un ciclo di ping e il successivo |
| `PING_COUNT` | Pacchetti ICMP per controllo |
| `DOWN_AFTER_FAILS` | Fallimenti consecutivi prima di DOWN |
| `UP_AFTER_OKS` | Successi consecutivi prima di UP |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Notifiche. Vuoti: solo log |
| `DHCP_LEASES_PATH` | File lease dnsmasq dentro il container. Se è impostato, l'ARP dell'host non viene usato |
| `ARP_CACHE_PATH` | File `mac ip` letto dal collector. Default: `/config/arp-cache.txt` |

## Rete

Non c'è login. L'API può leggere e riscrivere l'elenco dei dispositivi, e InfluxDB risponde con il token del `.env`. Va tenuto sulla macchina che lo esegue, oppure su una LAN di cui ti fidi. Non inoltrare verso Internet le porte `26173` (interfaccia), `26800` (API), `26300` (Grafana) e `26886` (InfluxDB).

## Licenza

MIT. Vedi [LICENSE](LICENSE).
