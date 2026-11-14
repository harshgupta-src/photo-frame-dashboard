# Home HQ on an iPhone

The phone app is the frame's dashboard itself, installed from Safari as a home-screen web app. It is
the same build from the same Worker, so every deploy reaches the frame and every phone. A phone
picks a new build up when the app comes back to the foreground. It shows the portrait layout scaled
to the phone's width, with every tab and operation the frame has.

Why not a native app: building one needs Xcode, and installing it on more than one person's phone
needs the paid Apple Developer Program (or a rebuild every 7 days). A home-screen app needs neither.

## Install (each phone)

1. In Safari, open `https://frame-data.<your-subdomain>.workers.dev/?key=<READ_KEY>` (the same URL
   the kiosk opens).
2. Share → **Add to Home Screen** → Add. Open Home HQ from the home screen. It runs full screen, in
   portrait.

The Worker gives the installed app a start URL that carries the key, because a home-screen app keeps
cookies apart from Safari's. Anyone with that URL can see the dashboard, so share it like a password.

## Home Assistant (lights and lists)

The frame reaches Home Assistant through the kiosk, with the frame's token. A phone signs in itself,
as the person holding it, over HA's public URL (`VITE_HA_URL` in `.env.local`):

- Tap **Sign in** on the "Connect Home Assistant" banner, or hold the clock in the bottom rail →
  **Home Assistant** → **Sign in**. Log in with your own HA account; HA sends you back to the app.
- If the sign-in page doesn't return to the app, use **Use a token** instead and paste a long-lived
  access token from your HA profile → Security.
- Sign out from the same place. Signing out revokes the session in HA.

The phone may only call what the kiosk allows (`js/haweb.js` mirrors `HA_GET`/`HA_POST` in
`kiosk/.../MainActivity.java`): reading states and calendars, lights and other device services,
and to-do lists. Locks, alarms and HA admin calls are refused before they leave the phone.

### HA setup (once)

HA must allow the dashboard's origin for CORS. On current HA the `http:` settings live in
`/config/.storage/http`, and `http:` in YAML is ignored once they have migrated. With HA stopped:

```sh
ha core stop
cp /config/.storage/http /config/.storage/http.bak-phoneapp
jq '.data.stable.cors_allowed_origins += ["https://frame-data.<your-subdomain>.workers.dev"]' \
  /config/.storage/http.bak-phoneapp > /config/.storage/http
ha core start
```

Check: `curl -si -X OPTIONS -H 'Origin: https://frame-data.<your-subdomain>.workers.dev' -H 'Access-Control-Request-Method: GET' https://<ha-public-url>/api/states`
should answer with `access-control-allow-origin`. To undo, restore the backup the same way.

Nothing else is registered in HA. The app's URL is its OAuth client id, and the sign-in returns to the
same host.
