// ============================================================
// discord-bot.js
// Discord Gateway client for slash commands.
// Phase 3 Task A — first command: /signa <ticker>
// ============================================================

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  MessageFlags
} from 'discord.js';

import { getSignal, getQuote } from './signa-client.js';
import { buildSignaSlashResponse } from './formatter.js';

const APP_ID   = process.env.DISCORD_APPLICATION_ID;
const TOKEN    = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

const SIGNA_API_TIMEOUT_MS = 12_000;

const SIGNA_COMMAND = new SlashCommandBuilder()
  .setName('signa')
  .setDescription('Fetch the latest Signa Action Card for a ticker')
  .addStringOption(opt =>
    opt.setName('ticker')
      .setDescription('Ticker symbol (e.g. AAPL)')
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(10)
  )
  .toJSON();

function ts() {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour12: false
  }) + ' ET';
}

function log(...args)    { console.log(`[${ts()}]`, ...args); }
function logErr(...args) { console.error(`[${ts()}] ❌`, ...args); }

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function registerGuildCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(APP_ID, GUILD_ID),
    { body: [SIGNA_COMMAND] }
  );
  log(`✓ Registered 1 slash command (/signa) for guild ${GUILD_ID}`);
}

// Discord locks reply visibility at deferReply time. To keep success public
// and errors ephemeral, we delete the public deferred reply on error and
// follow up with an ephemeral message instead.
async function sendEphemeralError(interaction, content) {
  try {
    await interaction.deleteReply();
  } catch (err) {
    logErr(`deleteReply failed: ${err.message}`);
  }
  try {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
  } catch (err) {
    logErr(`ephemeral followUp failed: ${err.message}`);
  }
}

async function handleSignaCommand(interaction) {
  const rawTicker = String(interaction.options.getString('ticker') ?? '').trim();
  if (!rawTicker) {
    return sendEphemeralError(interaction, 'Usage: `/signa <ticker>`');
  }
  const ticker = rawTicker.toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) {
    return sendEphemeralError(interaction, `Invalid ticker format: \`${rawTicker}\``);
  }

  try {
    const [actionCard, quote] = await withTimeout(
      Promise.all([getSignal(ticker), getQuote(ticker)]),
      SIGNA_API_TIMEOUT_MS,
      `Signa lookup for ${ticker}`
    );

    if (!actionCard || (typeof actionCard === 'object' && Object.keys(actionCard).length === 0)) {
      return sendEphemeralError(interaction, `No signal data for **${ticker}**.`);
    }

    const payload = buildSignaSlashResponse(ticker, actionCard, quote);
    if (!payload?.embeds?.length) {
      return sendEphemeralError(interaction, `Bad data from Signa for **${ticker}**.`);
    }

    return interaction.editReply({ embeds: payload.embeds });
  } catch (err) {
    const msg = err?.message || String(err);
    if (/timed out/i.test(msg))      return sendEphemeralError(interaction, 'Signa API timeout, try again.');
    if (/404|not found/i.test(msg))  return sendEphemeralError(interaction, `No signal data for **${ticker}**.`);
    logErr(`/signa ${ticker} failed: ${msg}`);
    return sendEphemeralError(interaction, `Signa lookup failed: ${msg.slice(0, 200)}`);
  }
}

export async function startDiscordBot() {
  if (!APP_ID || !TOKEN || !GUILD_ID) {
    logErr('Discord bot disabled: DISCORD_APPLICATION_ID / DISCORD_BOT_TOKEN / DISCORD_GUILD_ID not all set');
    return null;
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once('ready', async () => {
    log(`✓ Discord bot online as ${client.user.tag}`);
    try {
      await registerGuildCommands();
    } catch (err) {
      logErr(`Failed to register slash commands: ${err.message}`);
    }
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'signa') return;

    try {
      await interaction.deferReply();
    } catch (err) {
      logErr(`deferReply failed: ${err.message}`);
      return;
    }
    await handleSignaCommand(interaction);
  });

  client.on('error',      (err) => logErr(`Discord client error: ${err.message}`));
  client.on('shardError', (err) => logErr(`Discord shard error: ${err.message}`));

  await client.login(TOKEN);
  return client;
}
