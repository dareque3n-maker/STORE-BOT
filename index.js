require('dotenv').config();
const { Client, GatewayIntentBits, AuditLogEvent, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const mongoose = require('mongoose');
const GuildConfig = require('./models/GuildConfig');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent
    ]
});

// Spam & Repeat Message Tracking Maps
const spamTracker = new Map();
const lastMessageTracker = new Map(); // userId -> { content, timestamp }

// ================= CONSOLE-STYLE LIVE DUAL LOGGER =================
async function sendConsoleLog(guild, category, detailsObj, color = '#00FFFF') {
    try {
        const config = await GuildConfig.findOne({ guildId: guild.id });
        
        let logText = `[CONSOLE EVENT: ${category.toUpperCase()}]\n`;
        for (const [key, val] of Object.entries(detailsObj)) {
            logText += `> ${key.padEnd(16)} : ${val}\n`;
        }

        const embed = new EmbedBuilder()
            .setTitle(`📡 Live Console Stream // ${category}`)
            .setDescription(`\`\`\`text\n${logText}\`\`\``)
            .setColor(color)
            .setTimestamp();

        // 1. Send to Server Log Channel
        if (config && config.logChannelId) {
            const logChan = guild.channels.cache.get(config.logChannelId);
            if (logChan) await logChan.send({ embeds: [embed] }).catch(() => null);
        }

        // 2. Send to Server Owner DM
        const owner = await guild.fetchOwner().catch(() => null);
        if (owner) {
            await owner.send({ embeds: [embed] }).catch(() => null);
        }
    } catch (e) {
        console.error('Console Logging Error:', e);
    }
}

async function isWhitelisted(guildId, userId, ownerId) {
    if (userId === ownerId || userId === client.user.id) return true;
    const config = await GuildConfig.findOne({ guildId });
    return config && config.whitelistedUsers && config.whitelistedUsers.includes(userId);
}


// ================= SLASH COMMANDS REGISTRATION =================
client.once('clientReady', async () => {
    console.log(`🛡️ Sentinel Console-Security Bot Active as ${client.user.tag}`);
    if (process.env.MONGO_URI) await mongoose.connect(process.env.MONGO_URI);

    const commands = [
        new SlashCommandBuilder()
            .setName('antinuke')
            .setDescription('Sentinel Security Management (Owner Only)')
            .addSubcommand(sub =>
                sub.setName('setup')
                    .setDescription('Configure live console log channel & safe role')
                    .addChannelOption(opt => opt.setName('channel').setDescription('Log channel').setRequired(true))
                    .addRoleOption(opt => opt.setName('saferole').setDescription('Default safe role for punished users').setRequired(true))
            )
            .addSubcommand(sub =>
                sub.setName('whitelist')
                    .setDescription('Manage strict whitelist')
                    .addStringOption(opt => opt.setName('action').setDescription('Add or Remove').setRequired(true)
                        .addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }))
                    .addUserOption(opt => opt.setName('target').setDescription('User or Bot to whitelist').setRequired(true))
            )
    ].map(c => c.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
});


// ================= 1. LIVE CHAT & CONSOLE STREAM (MESSAGES) =================
client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;

    const userId = message.author.id;
    const ownerId = message.guild.ownerId;

    // Stream every message to console logs
    await sendConsoleLog(message.guild, 'CHAT MESSAGE', {
        'Author': `${message.author.tag} (${userId})`,
        'Channel': `#${message.channel.name}`,
        'Content': message.content || '[Embed / Attachment]'
    }, '#00FF00');

    // --- SPAM & REPEAT MESSAGE CHECK ---
    if (userId === ownerId) return;

    const now = Date.now();
    let userSpam = spamTracker.get(userId) || { count: 0, lastTime: now };
    let lastMsg = lastMessageTracker.get(userId);

    // Check for exact duplicate message repetition
    if (lastMsg && lastMsg.content === message.content && (now - lastMsg.timestamp < 10000)) {
        await message.delete().catch(() => null);
        const member = await message.guild.members.fetch(userId).catch(() => null);
        if (member) {
            await member.timeout(15 * 1000, 'Sentinel: Repeating same message spam').catch(() => null);
        }
        await sendConsoleLog(message.guild, 'ANTI-SPAM PENALTY', {
            'Offender': `${message.author.tag}`,
            'Violation': 'Repeated Duplicate Message',
            'Punishment': 'Message Deleted + 15s Timeout'
        }, '#FF0000');
        return;
    }
    lastMessageTracker.set(userId, { content: message.content, timestamp: now });

    // Check for Mass Ping / Mentions
    if (message.mentions.everyone || message.mentions.users.size > 2 || message.content.length > 400) {
        if (now - userSpam.lastTime > 20000) userSpam.count = 0;
        userSpam.count += 1;
        userSpam.lastTime = now;
        spamTracker.set(userId, userSpam);

        const member = await message.guild.members.fetch(userId).catch(() => null);
        if (!member) return;

        if (userSpam.count === 1) {
            await message.reply({ content: `⚠️ **Warning:** Please do not spam or mass mention!` }).catch(() => null);
            await sendConsoleLog(message.guild, 'ANTI-SPAM WARNING', { 'User': message.author.tag, 'Offense': '1st Ping/Spam Warning' }, '#FFA500');
        } else if (userSpam.count === 2) {
            await message.delete().catch(() => null);
            await member.timeout(15 * 1000, 'Sentinel Spam #2').catch(() => null);
            await sendConsoleLog(message.guild, 'ANTI-SPAM TIMEOUT', { 'User': message.author.tag, 'Penalty': 'Deleted + 15s Timeout' });
        } else if (userSpam.count >= 3) {
            await message.delete().catch(() => null);
            await member.timeout(60 * 1000, 'Sentinel Spam #3').catch(() => null);
            userSpam.count = 0;
            await sendConsoleLog(message.guild, 'ANTI-SPAM TIMEOUT (1m)', { 'User': message.author.tag, 'Penalty': 'Deleted + 1m Timeout' });
        }
    }
});

// Message Delete & Edit Live Console Logging
client.on('messageDelete', async (message) => {
    if (!message.guild || message.author?.bot) return;
    await sendConsoleLog(message.guild, 'MESSAGE DELETED', {
        'Author': message.author ? message.author.tag : 'Unknown',
        'Channel': `#${message.channel.name}`,
        'Content': message.content || '[Cached Content Missing]'
    }, '#FFA500');
});

client.on('messageUpdate', async (oldMsg, newMsg) => {
    if (!newMsg.guild || newMsg.author?.bot) return;
    if (oldMsg.content === newMsg.content) return;
    await sendConsoleLog(message.guild, 'MESSAGE EDITED', {
        'Author': newMsg.author.tag,
        'Channel': `#${newMsg.channel.name}`,
        'Old Content': oldMsg.content || 'None',
        'New Content': newMsg.content || 'None'
    }, '#FFFF00');
});


// ================= 2. PRE-EMPTIVE HARDCORE SHIELD & MODERATION GUARD =================

// Bot Add Guard
client.on('guildMemberAdd', async (member) => {
    try {
        if (!member.user.bot) return;
        const audit = await member.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.BotAdd }).catch(() => null);
        const entry = audit?.entries.first();
        if (!entry || !entry.executor) return;

        const allowed = await isWhitelisted(member.guild.id, entry.executor.id, member.guild.ownerId);
        if (!allowed) {
            await member.kick('Sentinel: Unauthorized Bot').catch(() => null);
            const adder = await member.guild.members.fetch(entry.executor.id).catch(() => null);
            if (adder) {
                const config = await GuildConfig.findOne({ guildId: member.guild.id });
                await adder.roles.set(config?.defaultSafeRoleId ? [config.defaultSafeRoleId] : [], 'Sentinel Bot Add Punishment').catch(() => null);
            }
            await sendConsoleLog(member.guild, 'UNAUTHORIZED BOT BLOCKED', { 'Bot': member.user.tag, 'Added By': entry.executor.tag, 'Action': 'Bot Kicked, Adder Roles Stripped' });
        }
    } catch (e) { console.error(e); }
});

// Channel Changes (Name change, Delete trigger, Settings update)
client.on('channelUpdate', async (oldChannel, newChannel) => {
    await handleChannelTamper(newChannel.guild, newChannel, 'Channel Settings/Name Modified');
});

client.on('channelDelete', async (channel) => {
    await handleChannelTamper(channel.guild, channel, 'Channel Deleted');
});

async function handleChannelTamper(guild, channel, actionName) {
    try {
        const audit = await guild.fetchAuditLogs({ limit: 1 }).catch(() => null);
        const entry = audit?.entries.first();
        if (!entry || !entry.executor) return;

        const executorId = entry.executor.id;
        const allowed = await isWhitelisted(guild.id, executorId, guild.ownerId);

        if (!allowed && executorId !== client.user.id) {
            const member = await guild.members.fetch(executorId).catch(() => null);
            if (member) {
                if (member.user.bot) {
                    if (member.bannable) await member.ban({ reason: `Sentinel: Tampering with ${actionName}` }).catch(() => null);
                } else {
                    // Instantly strip all roles
                    await member.roles.set([], `Sentinel: Tampering with ${actionName}`).catch(() => null);
                }
            }
            await sendConsoleLog(guild, `UNAUTHORIZED ${actionName.toUpperCase()}`, {
                'Channel': `#${channel.name}`,
                'Tampered By': `${entry.executor.tag} (${executorId})`,
                'Punishment': member?.user.bot ? 'Bot Banned' : 'All Roles Stripped Instantly'
            });
        }
    } catch (e) { console.error(e); }
}

// Role Deletions / Modifications / Admin Actions (Kick, Ban, Timeout detection)
client.on('guildAuditLogEntryCreate', async (entry, guild) => {
    try {
        const { action, executorId } = entry;
        if (!executorId || await isWhitelisted(guild.id, executorId, guild.ownerId) || executorId === client.user.id) return;

        // Detect Kick, Ban, or Timeout issued by unauthorized admin/player
        if (action === AuditLogEvent.MemberKick || action === AuditLogEvent.MemberBanAdd || action === AuditLogEvent.MemberUpdate) {
            const member = await guild.members.fetch(executorId).catch(() => null);
            if (member && !member.user.bot) {
                await member.roles.set([], 'Sentinel: Unauthorized Moderation Action (Kick/Ban/Timeout)').catch(() => null);
                await sendConsoleLog(guild, 'UNAUTHORIZED MOD ACTION', {
                    'Action': AuditLogEvent[action] || 'Mod Action',
                    'Executed By': `${member.user.tag}`,
                    'Punishment': 'All Roles Stripped Instantly'
                });
            }
        }
    } catch (e) { console.error(e); }
});


// ================= 3. OWNER COMMAND HANDLER =================
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.user.id !== interaction.guild.ownerId) {
        return await interaction.reply({ content: '❌ Only the **Server Owner** can manage Sentinel Security!', ephemeral: true });
    }

    if (interaction.commandName === 'antinuke') {
        const sub = interaction.options.getSubcommand();
        let config = await GuildConfig.findOne({ guildId: interaction.guild.id });
        if (!config) config = new GuildConfig({ guildId: interaction.guild.id });

        if (sub === 'setup') {
            const chan = interaction.options.getChannel('channel');
            const safeRole = interaction.options.getRole('saferole');

            config.logChannelId = chan.id;
            config.defaultSafeRoleId = safeRole.id;
            await config.save();

            await sendConsoleLog(interaction.guild, 'SETTINGS UPDATED', {
                'Owner': interaction.user.tag,
                'Log Channel': `#${chan.name}`,
                'Safe Role': `@${safeRole.name}`
            }, '#0099FF');

            return await interaction.reply({ content: `✅ Live Console Log Channel set to ${chan} & Safe Role set to @${safeRole.name}!`, ephemeral: true });
        }

        if (sub === 'whitelist') {
            const action = interaction.options.getString('action');
            const target = interaction.options.getUser('target');

            if (!config.whitelistedUsers) config.whitelistedUsers = [];

            if (action === 'add') {
                if (!config.whitelistedUsers.includes(target.id)) {
                    config.whitelistedUsers.push(target.id);
                    await config.save();
                }
                return await interaction.reply({ content: `✅ Added **${target.tag}** to whitelist.`, ephemeral: true });
            } else if (action === 'remove') {
                config.whitelistedUsers = config.whitelistedUsers.filter(id => id !== target.id);
                await config.save();
                return await interaction.reply({ content: `✅ Removed **${target.tag}** from whitelist.`, ephemeral: true });
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
            
