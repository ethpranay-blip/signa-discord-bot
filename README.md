# Signa Discord Bot + Web Portal

A complete Discord and browser integration for **Signa** (app.getsigna.ai) — the AI trading intelligence platform that runs 45+ academic-grounded quantitative agents nightly and produces graded, tiered signals for US equities.

This bundle gives you:

- **`bot.js`** — a Node.js bot that posts daily digests, Tier-3 high-conviction alerts, watchlist scans, dark-pool anomalies, regime changes, and a pre-market brief to Discord.
- **`portal/index.html`** — a single-file web portal with no build step, no server. Opens in any browser, stores your key locally, refreshes every 5 minutes.
- **`signa-client.js`** — a tested wrapper around every confirmed Signa endpoint. Run it standalone to verify your key + connection.

---

## Prerequisites

- **Node.js 18+** (uses native `fetch`, ES modules, top-level await)
- A **Signa account** at app.getsigna.ai with an active API key (the bot's exclusive / Founding-tier endpoints — `/api/v1/signal-index`, `/api/v1/scan`, `/api/v1/enhanced-signal` — require Founding plan; everything else is Member-tier)
- A **Discord server** where you have *Manage Webhooks* permission

---

## Step 1 — Get your Signa API key

1. Log in at **app.getsigna.ai**
2. In the left sidebar (bottom), click **Dashboard → API Keys**
3. Click **+ New API Key**
4. Copy the `cmts_…` token immediately — Signa only shows it once

> Keep this key secret. The bot stores it in `.env`; the portal stores it in your browser's `localStorage` and never sends it anywhere except `app.getsigna.ai`.

---

## Step 2 — Create Discord webhooks

1. Open your Discord server
2. **Server Settings → Integrations → Webhooks**
3. Click **New Webhook**
4. Name it `Signa Bot`, pick the channel where digests should land (e.g. `#signals`), click **Copy Webhook URL**
5. *(Optional but recommended)* Repeat for a second webhook in a more focused channel (e.g. `#alerts`) — this is where Tier-3 high-conviction alerts will go. Without it, all alerts go to the main channel.

---

## Step 3 — Configure

```bash
cp .env.example .env
```

Open `.env` and fill in at minimum:

```ini
SIGNA_API_KEY=cmts_your_actual_key
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/…
WATCHLIST=NVDA,AAPL,MSFT,GOOGL,AMZN,SPY,QQQ,META,TSLA
```

All other variables have sensible defaults. See `.env.example` for the full list.

---

## Step 4 — Install and test

```bash
npm install

# Confirm every Signa endpoint is reachable with your key
node signa-client.js
```

If everything passes you'll see:

```
=== Summary ===
Passed: 14/14
All endpoints reachable — ready to run `node bot.js`
```

If anything fails, the test runner prints the exact error per endpoint — usually a 401 (wrong key), 403 (plan tier too low for that endpoint), or a network issue.

Then start the bot:

```bash
node bot.js
```

You'll see the cron schedule, account verification, and a `🟢 Signa Bot Online` post in your Discord channel.

---

## Step 5 — Web portal

```bash
# macOS
open portal/index.html

# Linux
xdg-open portal/index.html

# Windows
start portal/index.html
```

Or just double-click the file. Paste your API key when prompted and click **Connect**. The key is stored in `localStorage` only.

The portal pulls live data from `app.getsigna.ai` directly. **CORS note:** if Signa does not permit browser-origin requests for your account, the portal will show a CORS error and you should rely on the bot instead. The bot calls server-to-server and is unaffected.

---

## Schedule (all times America/New_York, weekdays)

| Job              | Time          | What it posts                                                             |
| ---------------- | ------------- | ------------------------------------------------------------------------- |
| Nightly digest   | 21:30 ET      | Signal index, regime, top buys/avoids, dark pool, earnings, watchlist     |
| Tier-3 alert     | with digest   | Posted to alerts channel only when Tier-3 signals exist                   |
| Midday sweep     | 12:30 ET      | Tier-3 only check (silent if none)                                        |
| Pre-market brief | 09:00 ET      | Today's earnings (watchlist starred) + active signals from yesterday      |
| Dark-pool sweep  | every 30 min, 9–16 ET | Posts only on net-aggressor flip or 10× buy/sell imbalance        |
| Regime change    | with digest   | Posts when the regime crosses RISK_ON / TRANSITIONAL / RISK_OFF           |

The Signa pipeline itself runs at **21:05 ET** — the digest is scheduled at 21:30 to give it time to land.

---

## Deployment

### Local always-on

```bash
nohup node bot.js > signa.log 2>&1 &
```

### PM2 (recommended)

```bash
npm install -g pm2
pm2 start bot.js --name signa-bot --time
pm2 save
pm2 startup     # follow the printed instructions to enable on boot
```

Logs: `pm2 logs signa-bot`. Restart: `pm2 restart signa-bot`.

### Railway

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

Add your env vars in the Railway dashboard under *Variables*.

### Render

Create a **Background Worker** service, point it at this repo, build command `npm install`, start command `node bot.js`, paste env vars in the dashboard.

---

## Customizing

- **Add a slash-command bot** — `bot.js` exports `lookupTicker(ticker)` which fetches enhanced signal + quote + dark pool for a single ticker and posts a deep-dive embed. Wire it to a Discord interaction handler if you want `/lookup NVDA`.
- **Different watchlists per channel** — duplicate `bot.js`, change `DISCORD_WEBHOOK_URL` and `WATCHLIST` per instance.
- **More sensitivity** on dark-pool alerts — tweak the imbalance multiplier in `runDarkpoolCheck` (default 10×) and the cron in Job 4.
- **Add more agents to on-demand calls** — `runAgent(agentId, ticker)` in `signa-client.js` accepts any of: `bollinger-band`, `momentum-factor`, `faber-taa`, `canslim-scanner`, `value-gate`, `turtle-trader`, `trend-engine`, `sector-rotation`, `rsi-divergence`, `macd-signal`, `low-vol-factor`, `quality-minus-junk`, `insider-cluster`, `pre-fomc-drift`, `unusual-options-flow`, `variance-swap-carry`, `finbert-sentiment`, `fintwit-sentiment`, `investor-personas`, `finmem`, `multi-llm-consensus`, `prism-journal`, `geopolitical-macro`.

---

## Troubleshooting

**`401 Unauthorized` from Signa**
Your API key is wrong or expired. Generate a new one at **app.getsigna.ai/dashboard/api-keys** and update `.env`. Restart the bot.

**`403 Forbidden`**
The endpoint requires a higher plan tier than your account. The Founding-only endpoints are `/api/v1/signal-index`, `/api/v1/scan`, `/api/v1/enhanced-signal`. If you're on Member, the bot will still work — you'll just see those particular calls fail in the test suite.

**`429 Too Many Requests`**
The client already keeps you well under the 2000 req/min Founding limit (it self-throttles to 100/min and retries on 429 with exponential backoff). If you still see this, you may have multiple bot instances running — check with `ps aux | grep node` or `pm2 list`.

**Discord posts: `50035 Invalid Form Body`**
Means an embed exceeded Discord's hard limits (6000 chars total, 25 fields, 4096-char description). The formatter already truncates on the way out, but if you've heavily customized embeds, shorten field values to under 1024 chars and titles to under 256.

**No signals showing tonight**
The Signa pipeline runs at **21:05 ET** Mon–Fri. Before that time, `getScoredSignals()` returns yesterday's data or empty. Check `getMe()` to confirm your account, then call `/api/signals/run?scored=true&limit=10` directly to verify there are scored rows.

**Portal shows CORS errors**
Signa's server may not allow browser-origin requests for your account. Two options: (1) use the bot only — it's server-to-server; (2) put a tiny CORS-allowing proxy in front of `app.getsigna.ai` and point the portal at it. The bot itself is unaffected.

**Cron jobs never fire**
`node-cron` jobs are tied to the process. If you ran `node bot.js` from a terminal and closed it, jobs stopped too. Use `nohup` or PM2 (see Deployment).

---

## File map

```
signa-discord-bot/
├── package.json          # dependencies + scripts
├── .env.example          # env var template
├── signa-client.js       # API wrapper + `node signa-client.js` test suite
├── formatter.js          # all Discord embed builders
├── bot.js                # entry point — cron, posting, validation
├── portal/
│   └── index.html        # standalone web portal
└── README.md             # this file
```

---

## Disclaimer

Signa signals are observations, not instructions to trade. This bot relays them; it does not interpret them. Position sizing, risk management, and execution are entirely on you.
