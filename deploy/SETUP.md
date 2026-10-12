# Deploying to the Pi behind the Cloudflare tunnel

Assumes `jai-raspi` already runs `cloudflared` (that's what serves
`tap-in.sammpath.dev`) and has Node 20+.

## 1. Get the code onto the Pi

```bash
ssh <pi-user>@jai-raspi
cd ~
git clone https://github.com/notjaisammpath/songless-unlimited.git
cd songless-unlimited
node --version            # need >= 20
node verify.mjs           # sanity-check the catalog
```

No `npm install` — there are zero dependencies.

## 2. Run it as a service

```bash
sudo cp deploy/songless.service /etc/systemd/system/
sudo sed -i "s/PI_USER/$USER/g" /etc/systemd/system/songless.service
sudo systemctl daemon-reload
sudo systemctl enable --now songless
systemctl status songless --no-pager
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/
```

A `200` means it's serving.

## 3. Add the hostname to the existing tunnel

Find the running tunnel's config:

```bash
sudo systemctl cat cloudflared | grep -E 'ExecStart|config'
# usually /etc/cloudflared/config.yml
sudo cat /etc/cloudflared/config.yml
```

Add one ingress rule **above** the catch-all `service: http_status:404`:

```yaml
ingress:
  # ... your existing tap-in rule stays first ...
  - hostname: songless.sammpath.dev
    service: http://127.0.0.1:3000
  - service: http_status:404      # must remain last
```

Then route DNS and restart:

```bash
cloudflared tunnel route dns <tunnel-name-or-uuid> songless.sammpath.dev
sudo systemctl restart cloudflared
```

Order matters — `cloudflared` matches ingress rules top to bottom, and the
404 catch-all swallows everything after it.

## 4. Register the redirect URI with Spotify

In <https://developer.spotify.com/dashboard> → your app → *Edit settings*,
add **both**:

```
http://127.0.0.1:3000/callback          (local dev)
https://songless.sammpath.dev/callback  (hosted)
```

Spotify requires HTTPS for any non-loopback redirect; Cloudflare terminates
TLS, so the public one qualifies.

## 5. Updating later

```bash
cd ~/songless-unlimited && git pull && sudo systemctl restart songless
```

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| 502 from Cloudflare | `songless` service down — `journalctl -u songless -n 50` |
| Tunnel serves 404 | ingress rule is below the `http_status:404` catch-all |
| `INVALID_CLIENT: Invalid redirect URI` | the hosted `/callback` isn't registered in the dashboard |
| Spotify auth works, playback silent | Spotify is playing on another device, or the account isn't Premium |
| `Cannot GET /callback` | Pi is running an old `serve.mjs` without the extensionless-route fallback |
