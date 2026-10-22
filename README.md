# fomo tradingbot

Copy-trade [pump.fun](https://pump.fun) traders (or any Solana wallet). Paste a trader's pump.fun profile link, hit **Copy**, and every buy and sell they make is mirrored into your wallet within seconds.

> Unofficial tool — not affiliated with Fomo Labs or pump.fun. Copy trading memecoins is extremely risky. Not financial advice.

**Website:** https://fomo-tradingbot.vercel.app

| Download | What it is |
| --- | --- |
| [FomoTradingbot-Setup.exe](https://github.com/rimidalvsulrod/fomo-tradingbot/releases/latest/download/FomoTradingbot-Setup.exe) | Desktop app (one-click install, updates itself). Add wallets to copy, manage copies, see positions. Can run the bot itself. |
| [FomoTradingbotServer.exe](https://github.com/rimidalvsulrod/fomo-tradingbot/releases/latest/download/FomoTradingbotServer.exe) | Headless 24/7 engine for a spare PC. Updates itself. Pair the desktop app with it using a 6-digit code. |

## Quick start

1. Run **FomoTradingbot-Setup.exe** (SmartScreen: *More info → Run anyway*; it isn't code-signed). It installs in one click and updates itself from then on.
2. **Add trader** → paste a trader's pump.fun profile link (on pump.fun, click a name in any coin's trades). Solana wallets and Solscan/GMGN/Birdeye links work too. You'll see their recent on-chain trades.
3. **Copy trader** → give them a name and choose a fixed SOL size or a % of their size.
4. You start in **paper mode**: fills are simulated with live Jupiter quotes. When you're happy, go to **Settings → Trading wallet**, import or create a dedicated wallet, fund it, and switch to **Live**.

### Run it 24/7 on another PC

1. Copy **FomoTradingbotServer.exe** to the spare PC and run it. Allow Windows Firewall access.
2. Desktop app → **Settings → Find servers** → **Pair** → type the code shown in the server window.
3. In the server window press **S** to start with Windows. It keeps the PC awake while it runs.

Both PCs must be on the same network for discovery and pairing. Server keys: `S` startup, `P` new pairing code, `T` show access token, `I` status, `O` data folder, `Q` quit. Flags: `--port 7420`, `--data <dir>`, `--allow-sleep`.

## How it works

- **Signals:** the engine watches each copied wallet on-chain (RPC polling + websocket log triggers) and parses each transaction's balance changes into buy/sell legs — DEX-agnostic, works for pump.fun, Raydium, Meteora, Jupiter routes, etc.
- **Execution:** swaps go through Jupiter Ultra (fallback: Jupiter Swap API + your RPC). Sells mirror the trader's sold fraction of their bag.
- **Risk:** per-trader sizing, max per trade, daily SOL limit, reserve, max positions, buy-once-per-token, take-profit/stop-loss, stale-signal and dust filters.
- **No logins:** traders are added by pump.fun profile link or wallet address. Wallet pages show recent trades read straight from the blockchain.
- **Keys:** the wallet key is AES-256-GCM encrypted at rest with a machine-local key. Wallet imports to a remote server are encrypted with a key derived from the pairing token.

Tip: the public Solana RPC is rate-limited. A free Helius/QuickNode RPC URL and a free Jupiter API key (Settings → Execution) make copying faster and more reliable.

## Develop

```bash
npm install
npm start              # desktop app (dev)
npm run server         # server in the terminal
npm test               # engine self-test against mainnet (paper trades)
npm run build          # dist/FomoTradingbotServer.exe + dist/FomoTradingbot.exe
```

Layout: `engine/` (copy-trading engine + HTTP/WS API), `server/` (24/7 console app), `desktop/` (Electron app), `web/` (Vercel site), `scripts/` (builds and tests).

MIT License.

## Release

```bash
npm run build
gh release create vX.Y.Z dist/FomoTradingbot-Setup.exe dist/FomoTradingbot-Setup.exe.blockmap dist/latest.yml dist/FomoTradingbotServer.exe
```

Installed apps and running servers pick up the new release automatically.
