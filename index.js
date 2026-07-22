require('dotenv').config();
const { Client, GatewayIntentBits, AuditLogEvent, PermissionFlagsBits, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const mongoose = require('mongoose');
const AntiNukeConfig = require('./models/AntiNukeConfig');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildLogs
    ]
});

// Action Tracker Memory Map (User_Id -> Timestamp Array)
const actionTrackers = new Map();

// Helper to Check & Enforce Rate Limits
async function processNukeAction(guild, executorId, actionType, maxLimit, reason) {
    if (executorId === client.user.id || executorId === guild.ownerId) return; // Ignore Bot & Owner

    const config = await AntiNukeConfig.findOne({ guildId: guild.id });
    if (!config || !config.enabled) return;

    // Check Whitelist
    if (config.whitelistedUsers.includes(executorId)) return;

    const now = Date.now();
    const trackerKey = `${guild.id}_${executorId}_${actionType}`;
    const timestamps = actionTrackers.get(trackerKey) || [];

    // Keep timestamps from the last 10 seconds only
    const validTimestamps = timestamps.filter(t => now - t < 10000);
    validTimestamps.push(now);
    actionTrackers.set(trackerKey, validTimestamps);

    // If Threshold Exceeded -> PUNISHMENT TRIGGERED!
    if (validTimestamps.length >= (config[maxLimit] || 2)) {
        actionTrackers.delete(trackerKey); // Reset Tracker

        const member = await guild.members.fetch(executorId).catch(() => null);
        if (!member || !member.bannable) return;

        // 1. Strip All Roles Immediately
        await member.roles.set([]).catch(() => null);

        // 2. Ban the Nuker
        await member.ban({ reason: `🚨 Anti-Nuke Triggered: Mass ${reason}` }).catch(() => null);

        // 3. Send Alert Log
        if (config.logChannelId) {
            const logChan = guild.channels.cache.get(config.logChannelId);
            if (logChan) {
                const embed = new EmbedBuilder()
                    .setTitle('🚨 ANTI-NUKE SYSTEM TRIGGERED!')
                    .setDescription(`\`\`\`text\n⚠️ NUKER NEUTRALIZED\n--------------------\nUser    : ${member.user.tag} (${member.id})\nReason  : Mass ${reason} limit exceeded!\nAction  : Roles Stripped & Banned Permanently.\n\`\`\``)
                    .setColor('#FF0000')
                    .setTimestamp();
                await logChan.send({ embeds: [embed] }).catch(() => null);
            }
        }
    }
}

client.once('ready', async () => {
    console.log(`🛡️ Anti-Nuke Engine active as ${client.user.tag}`);
    if (process.env.MONGO_URI) await mongoose.connect(process.env.MONGO_URI);

    // Register Commands
    const commands = [
        new SlashCommandBuilder().setName('antinuke').setDescription('Anti-nuke configuration')
            .addSubcommand(s => s.setName('setup').setDescription('Set log channel').addChannelOption(c => c.setName('channel').setDescription('Log channel').setRequired(true)))
            .addSubcommand(s => s.setName('whitelist').setDescription('Whitelist user').addUserOption(u => u.setName('user').setDescription('Target user').setRequired(true)))
    ].map(c => c.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
});

// ================= ANTI-CHANNEL DELETE =================
client.on('channelDelete', async (channel) => {
    try {
        const audit = await channel.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.ChannelDelete }).catch(() => null);
        const entry = audit?.entries.first();
        if (entry && entry.executor) {
            await processNukeAction(channel.guild, entry.executor.id, 'channelDelete', 'maxChannelDelete', 'Channel Deletion');
        }
    } catch (e) { console.error(e); }
});

// ================= ANTI-ROLE DELETE =================
client.on('roleDelete', async (role) => {
    try {
        const audit = await role.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.RoleDelete }).catch(() => null);
        const entry = audit?.entries.first();
        if (entry && entry.executor) {
            await processNukeAction(role.guild, entry.executor.id, 'roleDelete', 'maxRoleDelete', 'Role Deletion');
        }
    } catch (e) { console.error(e); }
});

// ================= ANTI-MASS BAN =================
client.on('guildBanAdd', async (ban) => {
    try {
        const audit = await ban.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.MemberBanAdd }).catch(() => null);
        const entry = audit?.entries.first();
        if (entry && entry.executor) {
            await processNukeAction(ban.guild, entry.executor.id, 'memberBan', 'maxBans', 'Member Ban');
        }
    } catch (e) { console.error(e); }
});

// ================= COMMAND INTERACTION =================
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'antinuke') return;
    if (interaction.user.id !== interaction.guild.ownerId) {
        return await interaction.reply({ content: '❌ Only Server Owner can manage Anti-Nuke settings!', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    if (sub === 'setup') {
        const chan = interaction.options.getChannel('channel');
        await AntiNukeConfig.findOneAndUpdate({ guildId }, { logChannelId: chan.id }, { upsert: true });
        return await interaction.reply({ content: `✅ Anti-Nuke Logs configured in ${chan}` });
    }

    if (sub === 'whitelist') {
        const target = interaction.options.getUser('user');
        await AntiNukeConfig.findOneAndUpdate({ guildId }, { $addToSet: { whitelistedUsers: target.id } }, { upsert: true });
        return await interaction.reply({ content: `🛡️ **${target.tag}** added to Anti-Nuke Whitelist!` });
    }
});

client.login(process.env.DISCORD_TOKEN);
