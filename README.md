# Mini NMS

Mini-Zabbix/PRTG personale: ping, SNMP, alert Telegram, dashboard Grafana. Tutto in Docker.

## Avvio
```bash
cp .env.example .env      # compila token e password
# modifica config/devices.yml con i tuoi device
docker compose up -d --build
```
- Frontend: http://localhost:5173
- Grafana: http://localhost:3000
- API: http://localhost:8000/docs
- InfluxDB: http://localhost:8086

## Architettura
```
Device ←ping/SNMP→ Collector → InfluxDB → API FastAPI → Frontend (Vite)
                       ↓            ↓
                  Telegram       Grafana
```

## Roadmap
- [x] Ping + latenza/loss + alert UP/DOWN
- [ ] SNMP: traffico, CPU/RAM
- [ ] Agent server (psutil) e Docker monitoring
- [ ] Syslog receiver
- [ ] Auto-discovery, retention/downsampling

## Scelte progettuali
(da completare: perché InfluxDB, macchina a stati per gli alert, ecc.)
