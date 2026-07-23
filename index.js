require('dotenv').config();
const { Client, GatewayIntentBits, AuditLogEvent, EmbedBuilder, SlashCommandBuilder, REST, Routes, PermissionFlagsBits } = require('discord.js');
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

const spamTracker = new Map();
const lastMessageTracker = new Map();

// ================= LIVE CONSOLE DUAL LOGGER =================
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

        if (config && config.logChannelId) {
            const logChan = guild.channels.cache.get(config.logChannelId);
            if (logChan) await logChan.send({ embeds: [embed] }).catch(() => null);
        }

        const owner = await guild.fetchOwner().catch(() => null);
        if (owner) {
            await owner.send({ embeds: [embed] }).catch(() => null);
        }
    } catch (e) {
        console.error('Logging Error:', e);
    }
}

async function isWhitelisted(guildId, userId, ownerId) {
    if (userId === ownerId || userId === client.user.id) return true;
    const config = await GuildConfig.findOne({ guildId });
    return config && config.whitelistedUsers && config.whitelistedUsers.includes(userId);
}


// ================= AGGRESSIVE PRE-EMPTIVE LOCKDOWN =================
// Ye function har 5 second mein unwhitelisted roles se saari dangerous powers chheen leta hai
async function enforceStrictLockdown(guild) {
    try {
        const ownerId = guild.ownerId;
        const config = await GuildConfig.findOne({ guildId: guild.id });
        const whitelisted = config ? config.whitelistedUsers : [];

        guild.roles.cache.forEach(async (role) => {
            if (role.managed || role.id === guild.id) return;

            if (role.permissions.has(PermissionFlagsBits.Administrator) ||
                role.permissions.has(PermissionFlagsBits.ManageChannels) ||
                role.permissions.has(PermissionFlagsBits.ManageRoles) ||
                role.permissions.has(PermissionFlagsBits.BanMembers)) {

                const hasTrustedMember = role.members.some(m => m.id === ownerId || whitelisted.includes(m.id));

                if (!hasTrustedMember) {
                    await role.setPermissions(role.permissions.remove([
                        PermissionFlagsBits.Administrator,
                        PermissionFlagsBits.ManageChannels,
                        PermissionFlagsBits.ManageRoles,
                        PermissionFlagsBits.BanMembers,
                        PermissionFlagsBits.KickMembers,
                        PermissionFlagsBits.ManageGuild
                    ])).catch(() => null);
                }
            }
        });
    } catch (e) {
        console.error('Lockdown Error:', e);
    }
}

setInterval(() => {
    client.guilds.cache.forEach(guild => enforceStrictLockdown(guild));
}, 5 * 1000); // Har 5 second mein tight lock


// ================= READY & COMMANDS =================
client.once('clientReady', async () => {
    console.log(`🛡️ Sentinel Hardcore Bot Active as ${client.user.tag}`);
    if (process.env.MONGO_URI) await mongoose.connect(process.env.MONGO_URI);

    client.guilds.cache.forEach(guild => enforceStrictLockdown(guild));

    const commands = [
        new SlashCommandBuilder()
            .setName('antinuke')
            .setDescription('Sentinel Security Management (Owner Only)')
            .addSubcommand(sub =>
                sub.setName('setup')
                    .setDescription('Configure log channel & safe role')
                    .addChannelOption(opt => opt.setName('channel').setDescription('Log channel').setRequired(true))
                    .addRoleOption(opt => opt.setName('saferole').setDescription('Default safe role').setRequired(true))
            )
            .addSubcommand(sub =>
                sub.setName('whitelist')
                    .setDescription('Manage strict whitelist')
                    .addStringOption(opt => opt.setName('action').setDescription('Add/Remove').setRequired(true)
                        .addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }))
                    .addUserOption(opt => opt.setName('target').setDescription('User or Bot').setRequired(true))
            )
    ].map(c => c.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
});


// ================= LIVE CONSOLE CHAT STREAM & SPAM =================
client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;

    const userId = message.author.id;
    const ownerId = message.guild.ownerId;

    await sendConsoleLog(message.guild, 'CHAT STREAM', {
        'Author': `${message.author.tag} (${userId})`,
        'Channel': `#${message.channel.name}`,
        'Content': message.content || '[Attachment/Embed]'
    }, '#00FF00');

    if (userId === ownerId) return;

    const now = Date.now();
    let userSpam = spamTracker.get(userId) || { count: 0, lastTime: now };
    let lastMsg = lastMessageTracker.get(userId);

    // Duplicate message spam check (15s timeout)
    if (lastMsg && lastMsg.content === message.content && (now - lastMsg.timestamp < 10000)) {
        await message.delete().catch(() => null);
        const member = await message.guild.members.fetch(userId).catch(() => null);
        if (member) await member.timeout(15 * 1000, 'Sentinel: Duplicate spam').catch(() => null);
        await sendConsoleLog(message.guild, 'SPAM BLOCKED', { 'User': message.author.tag, 'Penalty': 'Deleted + 15s Timeout' });
        return;
    }
    lastMessageTracker.set(userId, { content: message.content, timestamp: now });

    // Mass Ping Check
    if (message.mentions.everyone || message.mentions.users.size > 2) {
        if (now - userSpam.lastTime > 20000) userSpam.count = 0;
        userSpam.count += 1;
        userSpam.lastTime = now;
        spamTracker.set(userId, userSpam);

        const member = await message.guild.members.fetch(userId).catch(() => null);
        if (!member) return;

        if (userSpam.count === 1) {
            await message.reply({ content: `⚠️ **Warning:** Please avoid mass pings!` }).catch(() => null);
            await sendConsoleLog(message.guild, 'PING WARNING', { 'User': message.author.tag, 'Offense': '1st Warning' }, '#FFA500');
        } else if (userSpam.count >= 2) {
            await message.delete().catch(() => null);
            await member.timeout(30 * 1000, 'Sentinel Ping Spam').catch(() => null);
            await sendConsoleLog(message.guild, 'PING TIMEOUT', { 'User': message.author.tag, 'Penalty': 'Deleted + 30s Timeout' });
        }
    }
});


// ================= INSTANT SECURITY GUARDS =================

// 1. Bot Add Protection
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
            await sendConsoleLog(member.guild, 'UNAUTHORIZED BOT KICKED', {
                'Bot': `${member.user.tag}`,
                'Added By': `${entry.executor.tag}`,
                'Punishment': 'Bot Kicked, Adder Roles Stripped'
            });
        }
    } catch (e) { console.error(e); }
});

// 2. Channel/Role Tamper Protection
client.on('channelDelete', async (channel) => {
    await handleTamper(channel.guild, channel.name, 'Channel Delete');
});

client.on('channelUpdate', async (oldC, newC) => {
    if (oldC.name !== newC.name) {
        await handleTamper(newC.guild, newC.name, 'Channel Name Change');
    }
});

client.on('roleDelete', async (role) => {
    await handleTamper(role.guild, role.name, 'Role Delete');
});

async function handleTamper(guild, targetName, actionType) {
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
                    if (member.bannable) await member.ban({ reason: `Sentinel: Tamper ${actionType}` }).catch(() => null);
                } else {
                    await member.roles.set([], `Sentinel: Tamper ${actionType}`).catch(() => null);
                }
            }
            await sendConsoleLog(guild, `UNAUTHORIZED ${actionType.toUpperCase()}`, {
                'Target': targetName,
                'Offender': `${entry.executor.tag} (${executorId})`,
                'Punishment': member?.user.bot ? 'Bot Banned' : 'All Roles Stripped Instantly'
            });
        }
    } catch (e) { console.error(e); }
}


// ================= OWNER CONFIG COMMANDS =================
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.user.id !== interaction.guild.ownerId) {
        return await interaction.reply({ content: '❌ Only the **Server Owner** can manage Sentinel!', ephemeral: true });
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

            await enforceStrictLockdown(interaction.guild);

            await sendConsoleLog(interaction.guild, 'CONFIG UPDATED', {
                'Owner': interaction.user.tag,
                'Log Channel': `#${chan.name}`,
                'Safe Role': `@${safeRole.name}`
            }, '#0099FF');

            return await interaction.reply({ content: `✅ Sentinel setup complete & strict permission lockdown enforced!`, ephemeral: true });
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
                await enforceStrictLockdown(interaction.guild);
                return await interaction.reply({ content: `✅ Added **${target.tag}** to whitelist.`, ephemeral: true });
            } else if (action === 'remove') {
                config.whitelistedUsers = config.whitelistedUsers.filter(id => id !== target.id);
                await config.save();
                await enforceStrictLockdown(interaction.guild);
                return await interaction.reply({ content: `✅ Removed **${target.tag}** from whitelist.`, ephemeral: true });
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
