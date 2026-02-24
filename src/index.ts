import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { ChannelType, Client, EmbedBuilder, GatewayIntentBits, TextChannel } from "discord.js";
import dotenv from "dotenv";
import { Client as SshClient } from "ssh2";

dotenv.config();

type Config = {
  discordToken: string;
  discordChannelId: string;
  tsHost: string;
  tsQueryPort: number;
  tsServerPort: number;
  tsUsername: string;
  tsPassword: string;
  tsNickname: string;
  tsMutedEmoji: string;
  refreshSeconds: number;
};

type ActiveClient = {
  clid: string;
  uid: string;
  name: string;
  channelId: string;
  channelName: string;
  inputMuted: boolean;
  outputMuted: boolean;
  away: boolean;
  streaming: boolean;
  connectedMs: number | null;
};

type ServerSnapshot = {
  serverName: string;
  clients: ActiveClient[];
};

type RecentlyLeftEntry = {
  name: string;
  leftAt: number;
};

const config = readConfig();
const discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });
let statusMessageId: string | null = null;
let lastPublishedSignature: string | null = null;
let lastPublishedAt = 0;
let queryClient: TeamSpeakSshQuery | null = null;
let lastClientIds: Set<string> | null = null;
const recentlyLeft = new Map<string, RecentlyLeftEntry>();
const lastKnownNames = new Map<string, string>();
const RECENTLY_LEFT_WINDOW_MS = 30 * 60 * 1000;

function readConfig(): Config {
  const required = [
    "DISCORD_TOKEN",
    "DISCORD_CHANNEL_ID",
    "TS_HOST",
    "TS_QUERY_PORT",
    "TS_SERVER_PORT",
    "TS_QUERY_USERNAME",
    "TS_QUERY_PASSWORD"
  ] as const;

  for (const key of required) {
    if (!process.env[key] || process.env[key]?.trim() === "") {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  return {
    discordToken: process.env.DISCORD_TOKEN as string,
    discordChannelId: process.env.DISCORD_CHANNEL_ID as string,
    tsHost: process.env.TS_HOST as string,
    tsQueryPort: Number(process.env.TS_QUERY_PORT),
    tsServerPort: Number(process.env.TS_SERVER_PORT),
    tsUsername: process.env.TS_QUERY_USERNAME as string,
    tsPassword: process.env.TS_QUERY_PASSWORD as string,
    tsNickname: process.env.TS_QUERY_NICKNAME ?? "Discord-TS-Bridge",
    tsMutedEmoji: process.env.TS_MUTED_EMOJI ?? "\u{1F508}",
    refreshSeconds: Number(process.env.REFRESH_INTERVAL_SECONDS ?? "30")
  };
}

function decodeQueryValue(value: string): string {
  return value
    .replace(/\\s/g, " ")
    .replace(/\\p/g, "|")
    .replace(/\\\\/g, "\\")
    .replace(/\\\//g, "/")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t");
}

function parsePairs(record: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const pair of record.split(" ")) {
    if (!pair) {
      continue;
    }

    const eqIndex = pair.indexOf("=");
    if (eqIndex === -1) {
      out[pair] = "";
      continue;
    }

    const key = pair.slice(0, eqIndex);
    const value = pair.slice(eqIndex + 1);
    out[key] = decodeQueryValue(value);
  }

  return out;
}

function parseClientList(payloadLine: string, channelNameById: Map<string, string>): ActiveClient[] {
  if (!payloadLine || payloadLine.startsWith("error ")) {
    return [];
  }

  const clients = payloadLine.split("|").map(parsePairs);

  return clients
    .filter((client) => client.client_type === "0")
    .map((client) => {
      const channelId = client.cid ?? "";
      const connectedRaw = client.client_connected_time ?? "";
      const connectedMs = connectedRaw ? Number(connectedRaw) : null;

      return {
        clid: client.clid ?? "",
        uid: client.client_unique_identifier ?? client.clid ?? "",
        name: client.client_nickname ?? "Unknown",
        channelId,
        channelName: channelNameById.get(channelId) ?? "Unknown channel",
        inputMuted: client.client_input_muted === "1" || client.client_input_hardware === "0",
        outputMuted: client.client_output_muted === "1" || client.client_output_hardware === "0",
        away: client.client_away === "1",
        streaming: client.client_is_streaming === "1" || client.client_is_recording === "1",
        connectedMs: Number.isFinite(connectedMs) ? connectedMs : null
      };
    })
    .filter((client) => client.name.length > 0 && client.clid.length > 0 && client.uid.length > 0);
}

function findClientListPayload(lines: string[]): string {
  return lines.find((line) => line.includes("clid=") && line.includes("client_type=")) ?? "";
}

function parseChannelList(lines: string[]): Map<string, string> {
  const payload = lines.find((line) => line.includes("cid=") && line.includes("channel_name=")) ?? "";
  const channelMap = new Map<string, string>();

  if (!payload) {
    return channelMap;
  }

  for (const rawChannel of payload.split("|")) {
    const channel = parsePairs(rawChannel);
    if (channel.cid && channel.channel_name) {
      channelMap.set(channel.cid, channel.channel_name);
    }
  }

  return channelMap;
}

function parseServerName(lines: string[]): string {
  const payload = lines.find((line) => line.includes("virtualserver_name=")) ?? "";
  if (!payload) {
    return "TeamSpeak";
  }
  const record = parsePairs(payload);
  return record.virtualserver_name || "TeamSpeak";
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms < 0) {
    return "unknown";
  }

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function formatAgo(sinceMs: number): string {
  if (sinceMs < 0) {
    return "just now";
  }

  const totalSeconds = Math.floor(sinceMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s ago`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m ago`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m ago`;
}

function effectiveAudioState(client: ActiveClient): "deafened" | "muted" | "unmuted" {
  if (client.outputMuted) {
    return "deafened";
  }
  if (client.inputMuted) {
    return "muted";
  }
  return "unmuted";
}

function signatureForClients(clients: ActiveClient[]): string {
  return clients
    .map((client) =>
      [client.uid, client.name, client.channelId, effectiveAudioState(client), client.away ? "1" : "0", client.streaming ? "1" : "0"].join("|")
    )
    .sort((a, b) => a.localeCompare(b))
    .join("\n");
}

class TeamSpeakSshQuery {
  private conn: SshClient;
  private stream: NodeJS.WritableStream & NodeJS.ReadableStream;
  private buffer = "";
  private pendingDataResolver: (() => void) | null = null;

  private constructor(conn: SshClient, stream: NodeJS.WritableStream & NodeJS.ReadableStream) {
    this.conn = conn;
    this.stream = stream;
    (this.stream as NodeJS.ReadableStream).on("data", (chunk: Buffer | string) => {
      this.buffer += chunk.toString();
      if (this.pendingDataResolver) {
        const resolve = this.pendingDataResolver;
        this.pendingDataResolver = null;
        resolve();
      }
    });
  }

  static async connect(host: string, port: number, username: string, password: string): Promise<TeamSpeakSshQuery> {
    const conn = new SshClient();

    const ready = once(conn, "ready");
    conn.connect({
      host,
      port,
      username,
      password,
      readyTimeout: 10000,
      hostVerifier: () => true
    });

    await ready;

    const stream = await new Promise<NodeJS.WritableStream & NodeJS.ReadableStream>((resolve, reject) => {
      conn.shell((error, shellStream) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(shellStream as NodeJS.WritableStream & NodeJS.ReadableStream);
      });
    });

    return new TeamSpeakSshQuery(conn, stream);
  }

  private async waitForMoreData(previousLength: number, timeoutMs = 7000): Promise<void> {
    if (this.buffer.length > previousLength) {
      return;
    }

    await Promise.race([
      new Promise<void>((resolve) => {
        this.pendingDataResolver = resolve;
      }),
      delay(timeoutMs).then(() => {
        throw new Error("Timed out waiting for TeamSpeak query response");
      })
    ]);
  }

  private async readUntilErrorLine(): Promise<string[]> {
    const lines: string[] = [];

    while (true) {
      const observedLength = this.buffer.length;
      const idxN = this.buffer.indexOf("\n");
      const idxR = this.buffer.indexOf("\r");
      const idx = idxN === -1 ? idxR : idxR === -1 ? idxN : Math.min(idxN, idxR);

      if (idx !== -1) {
        let consume = idx + 1;
        const first = this.buffer[idx];
        const second = this.buffer[idx + 1];
        if ((first === "\r" && second === "\n") || (first === "\n" && second === "\r")) {
          consume = idx + 2;
        }

        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(consume);

        if (line.length > 0) {
          lines.push(line);
        }

        if (line.startsWith("error id=")) {
          return lines;
        }

        continue;
      }

      await this.waitForMoreData(observedLength);
    }
  }

  async command(commandText: string): Promise<string[]> {
    this.stream.write(`${commandText}\r\n`);
    const lines = await this.readUntilErrorLine();

    const errorLine = [...lines].reverse().find((line) => line.includes("error id=")) ?? "";
    const error = parsePairs(errorLine);
    if (error.id !== "0") {
      const msg = error.msg ?? "Unknown TeamSpeak query error";
      throw new Error(`TeamSpeak query command failed (${error.id}): ${msg}`);
    }

    return lines.slice(0, -1);
  }

  close(): void {
    this.stream.end();
    this.conn.end();
  }
}

async function fillConnectedTimes(query: TeamSpeakSshQuery, clients: ActiveClient[]): Promise<ActiveClient[]> {
  for (const client of clients) {
    try {
      const infoLines = await query.command(`clientinfo clid=${client.clid}`);
      const payload = infoLines.find((line) => line.includes("client_type=")) ?? infoLines[0] ?? "";
      const info = parsePairs(payload);
      const raw = info.connection_connected_time ?? info.client_connected_time ?? "";
      const ms = raw ? Number(raw) : NaN;
      if (Number.isFinite(ms) && ms >= 0) {
        client.connectedMs = ms;
      }
      client.streaming = info.client_is_streaming === "1" || info.client_is_recording === "1";
    } catch {
      // Keep previous value (or unknown) if one client info lookup fails.
    }
  }

  return clients;
}

async function fetchServerSnapshot(): Promise<ServerSnapshot> {
  if (!queryClient) {
    queryClient = await TeamSpeakSshQuery.connect(config.tsHost, config.tsQueryPort, config.tsUsername, config.tsPassword);
    await queryClient.command(`use port=${config.tsServerPort} nickname=${config.tsNickname}`);
  }

  const serverInfoLines = await queryClient.command("serverinfo");
  const serverName = parseServerName(serverInfoLines);
  const channelLines = await queryClient.command("channellist -topic");
  const channelNameById = parseChannelList(channelLines);
  const lines = await queryClient.command("clientlist -uid -away -voice -times");
  const clients = parseClientList(findClientListPayload(lines), channelNameById);
  return {
    serverName,
    clients: await fillConnectedTimes(queryClient, clients)
  };
}

function renderStatusEmbed(serverName: string, clients: ActiveClient[]): EmbedBuilder {
  const now = Date.now();
  const recent = [...recentlyLeft.values()]
    .filter((entry) => now - entry.leftAt <= RECENTLY_LEFT_WINDOW_MS)
    .sort((a, b) => b.leftAt - a.leftAt);

  const title = `${serverName} | Status (${clients.length} online)`;
  const embed = new EmbedBuilder()
    .setColor(clients.length === 0 ? 0x5865f2 : 0x57f287)
    .setTitle(title)
    .setFooter({ text: "Live voice status" });

  if (clients.length === 0) {
    embed.setDescription("\u{1FAE5} **Nobody connected**\n_Quiet right now. Waiting for users..._");
  } else {
    const byChannel = new Map<string, ActiveClient[]>();
    for (const client of clients) {
      const list = byChannel.get(client.channelName) ?? [];
      list.push(client);
      byChannel.set(client.channelName, list);
    }

    const channels = [...byChannel.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, 25);
    for (const [channelName, channelClients] of channels) {
      const sortedClients = [...channelClients].sort((a, b) => a.name.localeCompare(b.name));
      const rows: string[] = [];
      let currentLength = 0;

      for (const [index, client] of sortedClients.entries()) {
        const state = effectiveAudioState(client);
        const voiceIcon = state === "deafened" ? "\u{1F507}" : state === "muted" ? config.tsMutedEmoji : "\u{1F3A4}";
        const away = client.away ? " \u{1F4A4}" : "";
        const streamMarker = client.streaming ? "\u{1F4FA} " : "";
        const branch = index === sortedClients.length - 1 ? "└─" : "├─";
        const row = `${branch} ${voiceIcon} ${client.name} · ${streamMarker}\`${formatDuration(client.connectedMs)}\`${away}`;

        if (currentLength + row.length + 1 > 950) {
          rows.push("...");
          break;
        }

        rows.push(row);
        currentLength += row.length + 1;
      }

      embed.addFields({
        name: `\u{1F4CD} ${channelName} (${channelClients.length})`,
        value: rows.join("\n") || "-",
        inline: true
      });
    }

    if (byChannel.size > 25) {
      embed.addFields({
        name: "\u{2795} More channels",
        value: `+${byChannel.size - 25} not shown`,
        inline: true
      });
    }
  }

  if (recent.length > 0) {
    const lines: string[] = [];
    let currentLength = 0;

    for (const entry of recent) {
      const line = `• ${entry.name} · ${formatAgo(now - entry.leftAt)}`;
      if (currentLength + line.length + 1 > 950) {
        lines.push("...");
        break;
      }
      lines.push(line);
      currentLength += line.length + 1;
    }

    embed.addFields({
      name: "\u{1F6AA} Recently left (30m)",
      value: lines.join("\n"),
      inline: false
    });
  }

  return embed;
}

async function sendJoinPulse(textChannel: TextChannel, joinedNames: string[]): Promise<void> {
  if (joinedNames.length === 0) {
    return;
  }

  const msg = await textChannel.send(
    joinedNames.length === 1
      ? `+ ${joinedNames[0]} joined TeamSpeak`
      : `+ ${joinedNames.length} users joined TeamSpeak`
  );

  try {
    await delay(1500);
    await msg.delete();
  } catch {
    // Ignore delete errors.
  }
}

async function clearStatusChannel(): Promise<void> {
  const channel = await discordClient.channels.fetch(config.discordChannelId);

  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error("DISCORD_CHANNEL_ID is not a valid text channel");
  }

  const textChannel = channel as TextChannel;

  while (true) {
    const batch = await textChannel.messages.fetch({ limit: 100 });
    if (batch.size === 0) {
      break;
    }

    const fresh = batch.filter((msg) => Date.now() - msg.createdTimestamp < 14 * 24 * 60 * 60 * 1000);
    const old = batch.filter((msg) => Date.now() - msg.createdTimestamp >= 14 * 24 * 60 * 60 * 1000);

    if (fresh.size > 0) {
      await textChannel.bulkDelete(fresh, true);
    }

    for (const message of old.values()) {
      try {
        await message.delete();
      } catch {
        // Ignore undeletable messages and keep purging.
      }
    }

    if (batch.size < 100) {
      break;
    }
  }

  statusMessageId = null;
  lastPublishedSignature = null;
  lastPublishedAt = 0;
  lastClientIds = null;
  recentlyLeft.clear();
  lastKnownNames.clear();
}

async function updateDiscordMessage(serverName: string, clients: ActiveClient[], joinedNames: string[]): Promise<void> {
  const channel = await discordClient.channels.fetch(config.discordChannelId);

  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error("DISCORD_CHANNEL_ID is not a valid text channel");
  }

  const textChannel = channel as TextChannel;
  const embed = renderStatusEmbed(serverName, clients);

  if (!statusMessageId) {
    const msg = await textChannel.send({ embeds: [embed] });
    statusMessageId = msg.id;
  } else {
    try {
      const previous = await textChannel.messages.fetch(statusMessageId);
      await previous.edit({ embeds: [embed] });
    } catch {
      const msg = await textChannel.send({ embeds: [embed] });
      statusMessageId = msg.id;
    }
  }

  await sendJoinPulse(textChannel, joinedNames);
}

async function syncLoop(): Promise<void> {
  const forcedRefreshMs = 30_000;

  while (true) {
    try {
      const snapshot = await fetchServerSnapshot();
      const clients = snapshot.clients.sort((a, b) => a.name.localeCompare(b.name));
      const signature = signatureForClients(clients);
      const now = Date.now();
      const currentIds = new Set(clients.map((client) => client.uid));
      const previousIds = lastClientIds;
      const joinedNames =
        previousIds === null
          ? []
          : clients.filter((client) => !previousIds.has(client.uid)).map((client) => client.name);

      for (const client of clients) {
        lastKnownNames.set(client.uid, client.name);
      }

      if (previousIds) {
        for (const prevId of previousIds) {
          if (!currentIds.has(prevId)) {
            recentlyLeft.set(prevId, {
              name: lastKnownNames.get(prevId) ?? "Unknown",
              leftAt: now
            });
          }
        }
      }

      for (const id of [...recentlyLeft.keys()]) {
        const record = recentlyLeft.get(id);
        if (!record) {
          continue;
        }
        if (currentIds.has(id) || now - record.leftAt > RECENTLY_LEFT_WINDOW_MS) {
          recentlyLeft.delete(id);
        }
      }

      if (signature !== lastPublishedSignature || now - lastPublishedAt >= forcedRefreshMs) {
        await updateDiscordMessage(snapshot.serverName, clients, joinedNames);
        lastPublishedSignature = signature;
        lastPublishedAt = now;
        process.stdout.write(`[sync] Published update (${clients.length} online)\n`);
      }

      lastClientIds = currentIds;
    } catch (error) {
      if (queryClient) {
        queryClient.close();
        queryClient = null;
      }
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[sync] ${reason}\n`);
    }

    await delay(config.refreshSeconds * 1000);
  }
}

discordClient.once("clientReady", async () => {
  process.stdout.write(`Discord logged in as ${discordClient.user?.tag}\n`);
  await clearStatusChannel();
  process.stdout.write("[startup] Cleared status channel messages\n");
  await syncLoop();
});

discordClient.login(config.discordToken).catch((error) => {
  process.stderr.write(`Failed to login to Discord: ${String(error)}\n`);
  process.exit(1);
});
