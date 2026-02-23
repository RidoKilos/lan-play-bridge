# lan-play-bridge

Matchmaking server and PC launcher for playing Switch games online via [switch-lan-play](https://github.com/spacemeowx2/switch-lan-play). Two players share a room code on the web, configure their Switches, and the lan-play client tunnels local wireless traffic between them over the internet.

Live instance: [frlg.online](https://frlg.online)

---

## How it works

```
Switch A ──► PC A (launcher) ──► relay server ◄── PC B (launcher) ◄── Switch B
```

1. Players join the same room code on the web app
2. Each gets an assigned IP in the `10.13.x.x` range
3. They configure their Switch network settings manually to that IP
4. The launcher on each PC runs `lan-play`, which tunnels Switch traffic to the relay
5. Both Switches believe they're on the same local network

The matchmaking server (this repo) only coordinates room state — it never touches game traffic. Game traffic goes through a separate `switch-lan-play` relay process on port 11451.

---

## Stack

| Part | Tech |
|---|---|
| Matchmaking server | Node.js, Express, Socket.io |
| Frontend | Vanilla HTML/CSS/JS (single-page) |
| Launcher | Node.js, packaged with `pkg` |
| Relay | [switch-lan-play](https://github.com/spacemeowx2/switch-lan-play) |

---

## Self-hosting

### 1. Matchmaking server

```bash
git clone https://github.com/your-user/lan-play-bridge
cd lan-play-bridge/server
npm install
node server.js
```

Serves the frontend from `../public` on port 3000 (override with `PORT` env var).

### 2. switch-lan-play relay

```bash
# Download the binary for your platform
wget https://github.com/spacemeowx2/switch-lan-play/releases/latest/download/lan-play-linux
chmod +x lan-play-linux
sudo ./lan-play-linux --relay-server-addr 0.0.0.0:11451
```

Run it as a systemd service for persistence. See `nginx/frlg.online.conf` for a reverse proxy example.

### 3. Point the launcher at your relay

```bash
cd launcher
npm install
node launcher.js --relay yourserver.example.com:11451
```

---

## Building the launcher binary

Requires [pkg](https://github.com/vercel/pkg).

```bash
cd launcher
npm install
npm run package:win    # → dist/lan-play-bridge-launcher.exe
npm run package:mac    # → dist/lan-play-bridge-launcher-macos
npm run package:linux  # → dist/lan-play-bridge-launcher-linux
```

The generic binary always requires `--relay`. To bake a relay address into a pre-configured binary, create `launcher/config.js` before packaging:

```js
// launcher/config.js  (never commit this)
module.exports = {
  relay: 'yourserver.example.com:11451',
};
```

`pkg` will bundle it into the binary automatically.

---

## License

GPL-3.0 — consistent with switch-lan-play.
