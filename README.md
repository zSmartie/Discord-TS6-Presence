# Discord TeamSpeak Presence Bot

This project runs a Discord bot that mirrors live TeamSpeak 6 voice activity into a dedicated Discord channel.

It is built for one specific use case: a channel that is only used for this bot. On startup, the bot clears that channel and posts a fresh status embed.

## What it shows

- Active users, grouped by TeamSpeak channel
- User voice state (unmuted, muted, deafened)
- TS6 streaming state
- Away state
- Time connected in voice
- Recently left users (last 30 minutes)

## Requirements

- Node.js 20+
- TeamSpeak Server 6 with query SSH enabled
- Discord bot token
- Discord channel ID for a dedicated bot-output channel

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create your environment file:

```bash
cp .env.example .env
```

PowerShell:

```powershell
copy .env.example .env
```

3. Fill in `.env`.

4. Build and start:

```bash
npm run build
npm start
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | Yes | Your Discord bot token |
| `DISCORD_CHANNEL_ID` | Yes | Channel where the status embed is posted |
| `TS_HOST` | Yes | TeamSpeak host/IP |
| `TS_QUERY_PORT` | Yes | TeamSpeak query SSH port (default `10022`) |
| `TS_SERVER_PORT` | Yes | TeamSpeak voice port (default `9987`) |
| `TS_QUERY_USERNAME` | Yes | Query username (usually `serveradmin`) |
| `TS_QUERY_PASSWORD` | Yes | Query password |
| `TS_QUERY_NICKNAME` | No | Nickname used by query session |
| `TS_MUTED_EMOJI` | No | Emoji used for muted users (supports custom `<:name:id>`) |
| `REFRESH_INTERVAL_SECONDS` | No | Poll interval in seconds (default `30`) |

## Discord permissions

The bot needs these permissions in the target channel:

- View Channel
- Send Messages
- Read Message History
- Embed Links
- Manage Messages

`Manage Messages` is required for startup cleanup and temporary join pulse deletion.

## TeamSpeak 6 query SSH (systemd)

If your TeamSpeak service is `teamspeak6.service`, enable query SSH in the service override:

```bash
sudo systemctl edit teamspeak6.service
```

Example:

```ini
[Service]
ExecStart=
Environment="TSSERVER_QUERY_ADMIN_PASSWORD=CHANGE_ME"
ExecStart=/home/teamspeak/teamspeak-server_linux_amd64/tsserver --accept-license --query-ssh-enable --query-ssh-port=10022 --query-ssh-ip=127.0.0.1
```

Apply:

```bash
sudo systemctl daemon-reload
sudo systemctl restart teamspeak6.service
sudo ss -ltnp | grep ':10022\b'
```

## Run bot as a service

Create `/etc/systemd/system/discord-ts-bot.service`:

```ini
[Unit]
Description=Discord TeamSpeak Presence Bot
After=network-online.target teamspeak6.service
Wants=network-online.target
Requires=teamspeak6.service

[Service]
Type=simple
User=teamspeak
Group=teamspeak
WorkingDirectory=/home/teamspeak/discord-bot
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable discord-ts-bot.service
sudo systemctl start discord-ts-bot.service
sudo systemctl status discord-ts-bot.service --no-pager
```

Logs:

```bash
journalctl -u discord-ts-bot.service -f
```

## Troubleshooting

- `Missing Permissions`: channel permissions are missing (usually `Embed Links` or `Manage Messages`).
- `server maxclient reached (1027)`: TeamSpeak server is full and query cannot join.
- `connect ECONNREFUSED ...:10022`: query SSH is not listening.
- Custom emoji not rendering: use full `<:name:id>` format and ensure bot has access to that emoji source server.

## Development

```bash
npm run dev
```

```bash
npm run build
```