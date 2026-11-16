#!/bin/bash
# Runs ON the VM as framedeploy (the deploy SSH user). Reads a release tarball on stdin
# (built by worker/scripts/deploy-vm.mjs), unpacks it into a new release, reuses or installs its
# node_modules, switches /opt/frame-data/current over, restarts the service and checks it answers.
# If the check fails it switches back to the previous release.
set -euo pipefail
ROOT=/opt/frame-data
rel=$ROOT/releases/$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$rel"
tar -xzf - -C "$rel"
chmod 750 "$rel"; chmod 640 "$rel/secrets.env"

lock=$(sha256sum "$rel/package-lock.json" | cut -c1-16)
mods=$ROOT/runtime/$lock
if [ ! -d "$mods/node_modules" ]; then
  mkdir -p "$mods"
  cp "$rel/package.json" "$rel/package-lock.json" "$mods/"
  (cd "$mods" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
fi
ln -sfn "$mods/node_modules" "$rel/node_modules"

prev=$(readlink -f $ROOT/current || true)
ln -sfn "$rel" $ROOT/current.new && mv -T $ROOT/current.new $ROOT/current
sudo /usr/bin/systemctl restart frame-data

healthy() {
  for _ in $(seq 1 30); do
    sleep 2
    # Unauthenticated requests get a 401 from the Worker itself, which proves workerd is serving it.
    [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8791/walks/plan)" = 401 ] && return 0
  done
  return 1
}
if healthy; then
  echo "frame-data: $(basename "$rel") is live"
else
  echo "frame-data: $(basename "$rel") failed its health check" >&2
  sudo /usr/bin/journalctl -u frame-data -n 30 --no-pager >&2 || true
  if [ -n "$prev" ] && [ -d "$prev" ]; then
    ln -sfn "$prev" $ROOT/current.new && mv -T $ROOT/current.new $ROOT/current
    sudo /usr/bin/systemctl restart frame-data
    echo "frame-data: rolled back to $(basename "$prev")" >&2
  fi
  exit 1
fi

# Keep the last 5 releases and the runtimes they use.
ls -1dt $ROOT/releases/* | tail -n +6 | xargs -r rm -rf
for m in $ROOT/runtime/*; do
  used=0
  for r in $ROOT/releases/*; do [ "$(readlink "$r/node_modules")" = "$m/node_modules" ] && used=1; done
  [ $used = 1 ] || rm -rf "$m"
done
