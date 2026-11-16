#!/bin/bash
# One-time (and idempotent) VM setup, run ON the VM with sudo from a directory holding this repo's
# worker/vm files: sudo bash install.sh <ssh public key>...
# Creates the frame-data service user (owns the KV/cache state), the framedeploy user that
# deploys log in as (may only restart the service), the directories, the systemd unit and
# /usr/local/bin/frame-data-release. Base secrets go in /etc/frame-data/secrets.env (see README).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)

id frame-data >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin frame-data
id framedeploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash framedeploy
usermod -aG frame-data framedeploy

# setgid so releases framedeploy unpacks are group frame-data, readable by the service.
install -d -m 2755 -o framedeploy -g frame-data /opt/frame-data /opt/frame-data/releases /opt/frame-data/runtime
install -d -m 750 -o frame-data -g frame-data /var/lib/frame-data
install -d -m 750 -o root -g frame-data /etc/frame-data
[ -f /etc/frame-data/secrets.env ] || install -m 640 -o root -g frame-data /dev/null /etc/frame-data/secrets.env

install -m 755 "$here/release.sh" /usr/local/bin/frame-data-release
install -m 644 "$here/frame-data.service" /etc/systemd/system/frame-data.service
cat > /etc/sudoers.d/framedeploy <<'EOF'
framedeploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart frame-data, /usr/bin/journalctl -u frame-data -n 30 --no-pager
EOF
chmod 440 /etc/sudoers.d/framedeploy
visudo -cf /etc/sudoers.d/framedeploy >/dev/null

install -d -m 700 -o framedeploy -g framedeploy ~framedeploy/.ssh
for key in "$@"; do
  grep -qxF "$key" ~framedeploy/.ssh/authorized_keys 2>/dev/null || echo "$key" >> ~framedeploy/.ssh/authorized_keys
done
[ -f ~framedeploy/.ssh/authorized_keys ] && chown framedeploy:framedeploy ~framedeploy/.ssh/authorized_keys && chmod 600 ~framedeploy/.ssh/authorized_keys

systemctl daemon-reload
systemctl enable frame-data >/dev/null 2>&1
echo "frame-data: VM set up"
