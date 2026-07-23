require('dotenv').config();
const { Client, GatewayIntentBits, AuditLogEvent, EmbedBuilder } = require('discord.js');
const mongoose = require('mongoose');
const GuildConfig = require('./models/GuildConfig');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ]
});

const spamTracker = new Map();

async function sendLiveLogs(guild, title, description, color = '#FF0000') {
    try {
        const config = await GuildConfig.findOne({ guildId: guild.id });
        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(description)
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


client.once('ready', async () => {
    console.log(`🛡️ Sentinel Security Bot Online as ${client.user.tag}`);
    if (process.env.MONGO_URI) await mongoose.connect(process.env.MONGO_URI);

    // 🧹 WIPE OUT ALL OLD CACHED SLASH COMMANDS FROM DISCORD
    try {
        const guildIds = client.guilds.cache.map(g => g.id);
        for (const guildId of guildIds) {
            await client.application.commands.set([], guildId);
        }
        await client.application.commands.set([]);
        console.log('✨ All old cached slash commands wiped successfully!');
    } catch (e) {
        console.error('Command wipe error:', e);
    }
});


// ================= 1. ZERO-TOLERANCE BOT GUARD =================
client.on('guildMemberAdd', async (member) => {
    try {
        if (!member.user.bot) return;

        const audit = await member.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.BotAdd }).catch(() => null);
        const entry = audit?.entries.first();
        if (!entry || !entry.executor) return;

        const executorId = entry.executor.id;
        const allowed = await isWhitelisted(member.guild.id, executorId, member.guild.ownerId);

        if (!allowed) {
            await member.kick('Sentinel: Unauthorized Bot Addition').catch(() => null);

            const adder = await member.guild.members.fetch(executorId).catch(() => null);
            if (adder) {
                const config = await GuildConfig.findOne({ guildId: member.guild.id });
                const safeRoleId = config ? config.defaultSafeRoleId : null;
                const newRoles = safeRoleId ? [safeRoleId] : [];
                await adder.roles.set(newRoles, 'Sentinel: Added unauthorized bot').catch(() => null);
            }

            await sendLiveLogs(
                member.guild,
                '🚨 UNAUTHORIZED BOT BLOCKED & ADDER PUNISHED',
                `\`\`\`text\nBot Added : ${member.user.tag}\nAdded By  : ${entry.executor.tag}\nAction    : Bot Kicked, Adder Roles Stripped\n\`\`\``
            );
        }
    } catch (e) {
        console.error('BotAdd Guard Error:', e);
    }
});


// ================= 2. ADMIN & PLAYER PROTECTION GUARD =================
client.on('channelDelete', async (channel) => {
    handleUnauthorizedAction(channel.guild, channel.name, 'Channel Delete', AuditLogEvent.ChannelDelete);
});

client.on('channelCreate', async (channel) => {
    handleUnauthorizedAction(channel.guild, channel.name, 'Channel Create', AuditLogEvent.ChannelCreate, true);
});

client.on('roleDelete', async (role) => {
    handleUnauthorizedAction(role.guild, role.name, 'Role Delete', AuditLogEvent.RoleDelete);
});

async function handleUnauthorizedAction(guild, targetName, actionType, auditEventType, isCreation = false) {
    try {
        const audit = await guild.fetchAuditLogs({ limit: 1, type: auditEventType }).catch(() => null);
        const entry = audit?.entries.first();
        if (!entry || !entry.executor) return;

        const executorId = entry.executor.id;
        const allowed = await isWhitelisted(guild.id, executorId, guild.ownerId);

        if (!allowed && executorId !== client.user.id) {
            const member = await guild.members.fetch(executorId).catch(() => null);
            if (member) {
                if (member.user.bot) {
                    if (member.bannable) await member.ban({ reason: `Sentinel: Unauthorized ${actionType}` }).catch(() => null);
                } else {
                    await member.roles.set([], `Sentinel: Unauthorized ${actionType}`).catch(() => null);
                }
            }

            if (isCreation) {
                const chan = guild.channels.cache.find(c => c.name === targetName);
                if (chan) await chan.delete('Sentinel: Unauthorized Creation').catch(() => null);
            }

            await sendLiveLogs(
                guild,
                `🛡️ UNAUTHORIZED ${actionType.toUpperCase()} BLOCKED`,
                `\`\`\`text\nTarget    : ${targetName}\nAction By : ${entry.executor.tag}\nResponse  : Offender Neutralized / Roles Stripped\n\`\`\``
            );
        } else {
            await sendLiveLogs(
                guild,
                `📝 Action Log: ${actionType}`,
                `\`\`\`text\nTarget    : ${targetName}\nExecuted By: ${entry.executor.tag}\n\`\`\``,
                '#00FF00'
            );
        }
    } catch (e) {
        console.error('Action Guard Error:', e);
    }
});


// ================= 3. ANTI-SPAM & MASS PING =================
client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;

    if (message.mentions.everyone || message.mentions.users.size > 4 || message.content.length > 500) {
        const userId = message.author.id;
        const ownerId = message.guild.ownerId;
        if (userId === ownerId) return;

        const now = Date.now();
        let userSpam = spamTracker.get(userId) || { count: 0, lastTime: now };

        if (now - userSpam.lastTime > 30000) userSpam.count = 0;

        userSpam.count += 1;
        userSpam.lastTime = now;
        spamTracker.set(userId, userSpam);

        const member = await message.guild.members.fetch(userId).catch(() => null);
        if (!member) return;

        if (userSpam.count === 1) {
            await message.reply({ content: `⚠️ **Warning:** Please do not spam or mass mention!` }).catch(() => null);
            await sendLiveLogs(message.guild, '⚠️ Anti-Spam Warning', `\`\`\`text\nUser : ${message.author.tag}\nOffense: 1st Warning\n\`\`\``, '#FFA500');
        } 
        else if (userSpam.count === 2) {
            await message.delete().catch(() => null);
            await member.timeout(15 * 1000, 'Sentinel Anti-Spam: 2nd Offense').catch(() => null);
            await sendLiveLogs(message.guild, '🔇 Anti-Spam Timeout (15s)', `\`\`\`text\nUser : ${message.author.tag}\nPenalty: Message Deleted + 15s Timeout\n\`\`\``);
        } 
        else if (userSpam.count >= 3) {
            await message.delete().catch(() => null);
            await member.timeout(60 * 1000, 'Sentinel Anti-Spam: 3rd Offense').catch(() => null);
            userSpam.count = 0;
            await sendLiveLogs(message.guild, '🔇 Anti-Spam Timeout (1m)', `\`\`\`text\nUser : ${message.author.tag}\nPenalty: Message Deleted + 1m Timeout\n\`\`\``);
        }
    }
});


// ================= 4. EXCLUSIVE OWNER DM CONTROL SYSTEM =================
client.on('messageCreate', async (message) => {
    if (message.guild) return; // Only process in DMs
    if (message.author.bot) return;

    const ownerId = message.author.id;
    const managedGuilds = client.guilds.cache.filter(g => g.ownerId === ownerId);

    if (managedGuilds.size === 0) {
        return message.reply('❌ You are not the **Server Owner** of any server managed by this bot.');
    }

    const args = message.content.trim().split(/ +/);
    const cmd = args.shift().toLowerCase();

    if (cmd === '!setup') {
        // Usage in DM: !setup <guild_id> <log_channel_id> <safe_role_id>
        const guildId = args[0];
        const logChanId = args[1];
        const safeRoleId = args[2];

        if (!guildId) return message.reply('❌ Usage: `!setup <guild_id> <log_channel_id> <safe_role_id>`');

        const targetGuild = client.guilds.cache.get(guildId);
        if (!targetGuild || targetGuild.ownerId !== ownerId) {
            return message.reply('❌ Invalid Guild ID or you are not the owner of that server.');
        }

        let config = await GuildConfig.findOne({ guildId });
        if (!config) config = new GuildConfig({ guildId });

        if (logChanId) config.logChannelId = logChanId;
        if (safeRoleId) config.defaultSafeRoleId = safeRoleId;
        await config.save();

        return message.reply(`✅ Successfully updated settings for **${targetGuild.name}**!\nLog Channel ID: \`${logChanId}\`\nSafe Role ID: \`${safeRoleId}\``);
    }

    if (cmd === '!whitelist') {
        // Usage in DM: !whitelist <guild_id> add/remove <user_id>
        const guildId = args[0];
        const action = args[1];
        const targetId = args[2];

        if (!guildId || !action || !targetId) {
            return message.reply('❌ Usage: `!whitelist <guild_id> add/remove <user_id>`');
        }

        const targetGuild = client.guilds.cache.get(guildId);
        if (!targetGuild || targetGuild.ownerId !== ownerId) {
            return message.reply('❌ Invalid Guild ID.');
        }

        let config = await GuildConfig.findOne({ guildId });
        if (!config) config = new GuildConfig({ guildId });
        if (!config.whitelistedUsers) config.whitelistedUsers = [];

        if (action === 'add') {
            if (!config.whitelistedUsers.includes(targetId)) {
                config.whitelistedUsers.push(targetId);
                await config.save();
                return message.reply(`✅ Added user ID \`${targetId}\` to whitelist for **${targetGuild.name}**.`);
            } else {
                return message.reply(`⚠️ User is already whitelisted.`);
            }
        } else if (action === 'remove') {
            config.whitelistedUsers = config.whitelistedUsers.filter(id => id !== targetId);
            await config.save();
            return message.reply(`✅ Removed user ID \`${targetId}\` from whitelist for **${targetGuild.name}**.`);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
    
