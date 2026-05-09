#!/bin/bash
# polyDcopier - one-line installer
set -e
LOG=/var/log/polydcopier-install.log
exec >> "$LOG" 2>&1
echo "install starting at $(date)"
if command -v dnf >/dev/null 2>&1; then PKG=dnf; elif command -v apt-get >/dev/null 2>&1; then PKG=apt; else echo unsupported; exit 1; fi
if [ "$PKG" = "dnf" ]; then
  curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
  dnf install -y nodejs git gcc gcc-c++ make python3 firewalld
  systemctl enable --now firewalld 2>/dev/null || true
  firewall-cmd --permanent --add-port=3000/tcp 2>/dev/null || true
  firewall-cmd --reload 2>/dev/null || true
else
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs git build-essential python3 ufw
  ufw allow 3000/tcp || true
fi
mkdir -p /opt
cd /opt
rm -rf polydcopier
git clone https://github.com/dharamdesai03-eng/polydcopier.git
cd polydcopier
mkdir -p data
cat > /opt/polydcopier/.env <<'ENVEOF'
PORT=3000
NODE_ENV=production
TELEGRAM_BOT_TOKEN=8189990519:AAHCYmBlMKhMt4OZR6-9wf3M6BsNwludSd4
ALCHEMY_WS_URL=wss://polygon-mainnet.g.alchemy.com/v2/dcRmd_D2RzKAiZzbpNEuk
WALLETCONNECT_PROJECT_ID=ef04f3da5b82606d59be04a2c1b605ba
MASTER_KEY=10cf88259de58bc6fe4fc1beb9cd7ac1e4ac711c28024d66d9d2cd0ddff7d7f4
PUBLIC_URL=http://45.32.159.173:3000
DB_PATH=/opt/polydcopier/data/bot.db
PAPER_TRADE=0
ENVEOF
chmod 600 /opt/polydcopier/.env
npm install --omit=dev --no-audit --no-fund
cat > /etc/systemd/system/polydcopier.service <<'SVCEOF'
[Unit]
Description=polyDcopier
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
WorkingDirectory=/opt/polydcopier
EnvironmentFile=/opt/polydcopier/.env
ExecStart=/usr/bin/node /opt/polydcopier/src/index.js
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
SVCEOF
systemctl daemon-reload
systemctl enable --now polydcopier
sleep 5
systemctl status polydcopier --no-pager
echo install done
