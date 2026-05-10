#!/bin/bash
# polyDcopier installer/updater for AlmaLinux 9 (Vultr Frankfurt).
# Idempotent: safe to re-run. Designed to survive Vultr Reinstall by
# putting all stateful data on the /data persistent disk.
#
# Reliability features:
#   * systemd: Restart=always, RestartSec=2 — auto-recovery on crash
#   * Hourly SQLite backup to /data/backups (24 hourly + 7 daily kept)
#   * Health-check cron: pokes Telegram getMe every 2 min, logs failures
#   * /opt/polydcopier/deploy.sh — one-line `git pull && systemctl restart`
#     for future code updates with ~5s downtime instead of 7-min reinstall

set -e
LOG=/var/log/polydcopier-bootstrap.log
exec >> "$LOG" 2>&1
echo
echo "=== install.sh starting at $(date) ==="

# ── secrets baked in (single-tenant, this server only) ────────────────
TELEGRAM_BOT_TOKEN='8189990519:AAHCYmBlMKhMt4OZR6-9wf3M6BsNwludSd4'
ALCHEMY_WS_URL='wss://polygon-mainnet.g.alchemy.com/v2/dcRmd_D2RzKAiZzbpNEuk'
WALLETCONNECT_PROJECT_ID='ef04f3da5b82606d59be04a2c1b605ba'
MASTER_KEY='10cf88259de58bc6fe4fc1beb9cd7ac1e4ac711c28024d66d9d2cd0ddff7d7f4'
PUBLIC_URL='https://polydcopier.onrender.com'   # connect page host (until we move it to Vultr)
GH_REPO='https://github.com/dharamdesai03-eng/polydcopier.git'
APP_DIR=/opt/polydcopier
DATA_DIR=/data
DB_PATH="${DATA_DIR}/bot.db"
BACKUP_DIR="${DATA_DIR}/backups"

# ── 1. Persistent disk sanity check ───────────────────────────────────
mkdir -p "${DATA_DIR}" "${BACKUP_DIR}" "${DATA_DIR}/logs"
chmod 0750 "${DATA_DIR}"
echo "[+] data dir ready: $(df -h ${DATA_DIR} | tail -1)"

# ── 2. System packages ────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "[+] installing Node 20"
  curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
  dnf install -y nodejs gcc gcc-c++ make git python3 cronie sqlite jq
fi
systemctl enable --now crond

# ── 3. Clone or update the repo ───────────────────────────────────────
if [ -d "${APP_DIR}/.git" ]; then
  echo "[+] repo exists — pulling"
  cd "${APP_DIR}"
  git fetch --all
  git reset --hard origin/main
else
  echo "[+] cloning repo"
  git clone "${GH_REPO}" "${APP_DIR}"
  cd "${APP_DIR}"
fi

# ── 4. Migrate any existing DB into /data on first run ────────────────
if [ -f "${APP_DIR}/data/bot.db" ] && [ ! -f "${DB_PATH}" ]; then
  echo "[+] migrating existing local DB into /data"
  cp -av "${APP_DIR}/data/bot.db"* "${DATA_DIR}/"
fi

# ── 5. Environment file ───────────────────────────────────────────────
cat >/etc/polydcopier.env <<EOF
NODE_ENV=production
PORT=3000
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
ALCHEMY_WS_URL=${ALCHEMY_WS_URL}
WALLETCONNECT_PROJECT_ID=${WALLETCONNECT_PROJECT_ID}
MASTER_KEY=${MASTER_KEY}
PUBLIC_URL=${PUBLIC_URL}
DB_PATH=${DB_PATH}
PAPER_TRADE=0
EOF
chmod 0600 /etc/polydcopier.env
echo "[+] env file written"

# ── 6. npm install ────────────────────────────────────────────────────
cd "${APP_DIR}"
echo "[+] running npm install (this takes ~3 min for native sqlite compile)"
npm install --production

# ── 7. systemd unit with auto-restart ─────────────────────────────────
cat >/etc/systemd/system/polydcopier.service <<'EOF'
[Unit]
Description=polyDcopier Telegram bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/polydcopier
EnvironmentFile=/etc/polydcopier.env
ExecStart=/usr/bin/node src/index.js
StandardOutput=append:/data/logs/bot.log
StandardError=append:/data/logs/bot.err.log

# auto-recover on any exit
Restart=always
RestartSec=2
StartLimitBurst=20
StartLimitIntervalSec=300

# graceful shutdown
KillSignal=SIGTERM
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable polydcopier
systemctl restart polydcopier
echo "[+] systemd unit installed and (re)started"

# ── 8. /opt/polydcopier/deploy.sh — one-line code updates ─────────────
cat >"${APP_DIR}/deploy.sh" <<'EOF'
#!/bin/bash
# Pull latest code from GitHub and restart the bot. ~5 sec downtime, DB preserved.
set -e
cd /opt/polydcopier
echo "[deploy] $(date)"
git fetch --all
git reset --hard origin/main
npm install --production --no-audit --no-fund
systemctl restart polydcopier
sleep 2
systemctl is-active polydcopier && echo "[deploy] OK" || (echo "[deploy] FAIL"; journalctl -u polydcopier -n 30 --no-pager; exit 1)
EOF
chmod +x "${APP_DIR}/deploy.sh"
echo "[+] deploy.sh ready — future updates: 'ssh root@45.32.159.173 /opt/polydcopier/deploy.sh'"

# ── 9. Hourly backup cron ─────────────────────────────────────────────
cat >/usr/local/bin/polydcopier-backup.sh <<EOF
#!/bin/bash
# Hourly SQLite consistent backup — keeps last 24 hourly + last 7 daily.
set -e
DB=${DB_PATH}
DIR=${BACKUP_DIR}
mkdir -p "\$DIR/hourly" "\$DIR/daily"
[ -f "\$DB" ] || exit 0

H=\$(date +%H)
sqlite3 "\$DB" ".backup '\$DIR/hourly/bot-\$H.db'"

# Daily snapshot at 03:00 UTC
if [ "\$H" = "03" ]; then
  D=\$(date +%u)  # 1=Mon ... 7=Sun
  cp "\$DIR/hourly/bot-\$H.db" "\$DIR/daily/bot-\$D.db"
fi
EOF
chmod +x /usr/local/bin/polydcopier-backup.sh

cat >/etc/cron.d/polydcopier-backup <<EOF
# polyDcopier — hourly DB backup
5 * * * * root /usr/local/bin/polydcopier-backup.sh >> /data/logs/backup.log 2>&1
EOF
echo "[+] hourly backups configured → /data/backups"

# Run one immediately so we have a snapshot on first deploy
/usr/local/bin/polydcopier-backup.sh || true

# ── 10. Health-check cron — alerts if bot polling stops ───────────────
cat >/usr/local/bin/polydcopier-healthcheck.sh <<EOF
#!/bin/bash
# Pokes Telegram getMe and the local Express healthz. If either fails twice
# in a row, attempt a restart. Logs everything for forensic review.
LOG=/data/logs/health.log
STATE=/data/.health-fail-count
mkdir -p \$(dirname "\$LOG")

ok=true

# 1. Local Express server health
curl -fsS --max-time 5 http://127.0.0.1:3000/healthz >/dev/null 2>&1 || ok=false

# 2. Telegram polling sanity (we own the bot, so getMe must succeed)
curl -fsS --max-time 5 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" >/dev/null 2>&1 || ok=false

if \$ok; then
  echo "\$(date -u +%FT%TZ) OK" >> "\$LOG"
  rm -f "\$STATE"
else
  prev=\$(cat "\$STATE" 2>/dev/null || echo 0)
  next=\$((prev + 1))
  echo "\$next" > "\$STATE"
  echo "\$(date -u +%FT%TZ) FAIL count=\$next" >> "\$LOG"
  if [ "\$next" -ge 2 ]; then
    echo "\$(date -u +%FT%TZ) RESTART triggered after \$next consecutive fails" >> "\$LOG"
    systemctl restart polydcopier
    rm -f "\$STATE"
  fi
fi
EOF
chmod +x /usr/local/bin/polydcopier-healthcheck.sh

cat >/etc/cron.d/polydcopier-healthcheck <<'EOF'
# polyDcopier — health check every 2 min
*/2 * * * * root /usr/local/bin/polydcopier-healthcheck.sh
EOF
echo "[+] health check configured — auto-restart on 4-min outage"

# ── 11. Log rotation so /data/logs doesn't fill the disk ──────────────
cat >/etc/logrotate.d/polydcopier <<'EOF'
/data/logs/*.log {
  daily
  rotate 14
  compress
  missingok
  notifempty
  copytruncate
}
EOF

echo
echo "=== install.sh finished at $(date) ==="
echo
echo "Bot status:"
systemctl status polydcopier --no-pager || true
echo
echo "Quick commands:"
echo "  systemctl status polydcopier      # is the bot running?"
echo "  journalctl -u polydcopier -f      # tail bot logs"
echo "  /opt/polydcopier/deploy.sh        # pull + restart with ~5s downtime"
echo "  ls /data/backups/hourly/          # see backup files"
echo "  cat /data/logs/health.log | tail  # see health check history"
