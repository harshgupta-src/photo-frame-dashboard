# frame-data on the Azure VM

The `frame-data` Worker (`worker/src`) serves the dashboard and its API: events, photos, walks, meals, recipes,
reminders and Copilot. It runs on the household Azure VM (`harsh-ha.eastus.cloudapp.azure.com`) under
[Miniflare](https://github.com/cloudflare/workers-sdk/tree/main/packages/miniflare), which embeds workerd,
the open-source Workers runtime. The same code that ran on Cloudflare runs there unchanged.

**Why:** on Cloudflare's free plan each request gets 10 ms of CPU. Parsing the iCloud calendars and shared album
(`/events`, `/photos`, `/dog`) regularly went over that, and Cloudflare killed those requests with `exceededCpu`.
Home Assistant's `PUT /walks/plan` (which also reads the calendars) failed the same way, so walk replans
failed (Nov 14–15, 2026). The VM has no CPU limit.

```
clients ──▶ frame-data.<account>.workers.dev  (proxy.js: streams the request through, ~0 CPU)
              └──▶ https://harsh-ha.eastus.cloudapp.azure.com/frame-data/*   (Caddy, handle_path)
                    └──▶ 127.0.0.1:8791  frame-data.service → server.mjs → Miniflare/workerd
                          KV + Cache API: /var/lib/frame-data   dashboard: dist/ (ASSETS)
```

No client URL changed. The frames, the iPhone app, the HA rest_commands, Shortcuts and the Copilot pushers
all still use `workers.dev`.

## Deploying

| Command (from `dashboard/`) | What it does |
| --- | --- |
| `npm run deploy` | Builds, bundles the Worker with wrangler (no upload) and ships it to the VM over SSH. Then notifies the frames. CI runs it on every push to `main`. |
| `npm run deploy:proxy` | Deploys `proxy.js` as the Cloudflare Worker `frame-data`. Only needed if the proxy or the VM URL changes. |
| `npm run deploy:cloudflare` | **Fallback.** Puts the full Worker back on Cloudflare, with its old secrets and KV (see below). |

On the VM, `frame-data-release` (`release.sh`) handles each deploy:
1. Unpacks it into `/opt/frame-data/releases/<time>`.
2. Reuses or installs `node_modules` (`/opt/frame-data/runtime/<lock hash>`).
3. Points `/opt/frame-data/current` at the new release and restarts `frame-data`.
4. Waits for a 401 from `/walks/plan`. If it doesn't come, switches back to the previous release.

It keeps the last 5 releases. Deploys log in as `framedeploy`, which may only run that release and restart or
read the logs of `frame-data`. Two keys may log in: `~/.ssh/ha_azure_vm` on the Mac, and the CI key in the
repo secret `FRAME_DATA_SSH_KEY`.

**Secrets:**
- The VM keeps the full set in `/etc/frame-data/secrets.env` (root:frame-data 640).
- Each release can add or override entries with the non-`VITE_` entries of `.env.local`, plus `worker/.dev.vars` when deploying from the Mac.
- To change a base secret, edit that file with sudo and run `sudo systemctl restart frame-data`.
- Values can't contain `'` or newlines.

## Operating it

- Logs: `journalctl -u frame-data -f`.
- Status: `systemctl status frame-data`.
- Restart: `sudo systemctl restart frame-data`.
- Roll back by hand: `sudo ln -sfn /opt/frame-data/releases/<older> /opt/frame-data/current && sudo systemctl restart frame-data`.
- The KV data is SQLite and blob files under `/var/lib/frame-data/kv`. Back it up with the service stopped.
- The VM has 1 vCPU and 0.9 GB RAM, plus a 2 GB swapfile. The service is capped at `MemoryMax=500M`.
- Miniflare is pinned in `package.json`. Its compatibility date is capped by the version, so `server.mjs` uses `2026-07-30`.

**Setting up from scratch:** copy `install.sh`, `release.sh` and `frame-data.service` to the VM. Run
`sudo bash install.sh '<deploy public key>'...`. Write `/etc/frame-data/secrets.env` (KEY='value' lines). Add the
Caddy route before the catch-all `handle`, then `npm run deploy`:

```
handle_path /frame-data/* {
	reverse_proxy 127.0.0.1:8791 {
		flush_interval -1
	}
}
```

## Falling back to Cloudflare

`npm run deploy:cloudflare` redeploys the full Worker to Cloudflare. Its secrets were kept while the proxy
was deployed, so it works at once, with two caveats:
- It reads Cloudflare KV, which stopped being updated at the switch (2026-11-16). Walk plans, logs and Copilot transcripts written since then live only on the VM.
- It is back under the 10 ms CPU limit.

Run `npm run deploy:proxy` to return to the VM.
