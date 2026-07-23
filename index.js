require('dotenv').config();
const { Client, GatewayIntentBits, AuditLogEvent, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
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

// Spam tracking memory map: userId -> { count, lastTime, warned }
const spamTracker = new Map();

// Helper: Dispatch live logs to Selected Channel + Server Owner's DM
async function sendLiveLogs(guild, title, description, color = '#FF0000') {
    try {
        const config = await GuildConfig.findOne({ guildId: guild.id });
        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(description)
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
        console.error('Logging Error:', e);
    }
}

// Check if user/bot is whitelisted or owner
async function isWhitelisted(guildId, userId, ownerId) {
    if (userId === ownerId || userId === client.user.id) return true;
    const config = await GuildConfig.findOne({ guildId });
    return config && config.whitelistedUsers && config.whitelistedUsers.includes(userId);
}


client.once('ready', async () => {
    console.log(`🛡️ Sentinel Security Bot Online as ${client.user.tag}`);
    if (process.env.MONGO_URI) await mongoose.connect(process.env.MONGO_URI);
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
            // Kick unauthorized bot immediately
            await member.kick('Sentinel: Unauthorized Bot Addition').catch(() => null);

            // Strip roles from the player who added it, keep only default safe role if configured
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

// Generic handler for unauthorized actions
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
                    // Strip all roles from human admin/player immediately
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
            // Log clean actions
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
}


// ================= 3. ANTI-SPAM & MASS PING PROGRESSIVE PENALTY =================
client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;

    // Check for mass pings or rapid spam
    if (message.mentions.everyone || message.mentions.users.size > 4 || message.content.length > 500) {
        const userId = message.author.id;
        const ownerId = message.guild.ownerId;
        
        if (userId === ownerId) return; // Owner immune

        const now = Date.now();
        let userSpam = spamTracker.get(userId) || { count: 0, lastTime: now };

        // Reset count if 30 seconds passed
        if (now - userSpam.lastTime > 30000) {
            userSpam.count = 0;
        }

        userSpam.count += 1;
        userSpam.lastTime = now;
        spamTracker.set(userId, userSpam);

        const member = await message.guild.members.fetch(userId).catch(() => null);
        if (!member) return;

        if (userSpam.count === 1) {
            // 1st Time: Warning
            await message.reply({ content: `⚠️ **Warning:** Please do not spam or mass mention in this server!` }).catch(() => null);
            await sendLiveLogs(message.guild, '⚠️ Anti-Spam Warning', `\`\`\`text\nUser : ${message.author.tag}\nOffense: 1st Warning (Spam/Ping)\n\`\`\``, '#FFA500');
        } 
        else if (userSpam.count === 2) {
            // 2nd Time: Delete message + 15s Mute (Timeout)
            await message.delete().catch(() => null);
            await member.timeout(15 * 1000, 'Sentinel Anti-Spam: 2nd Offense').catch(() => null);
            await sendLiveLogs(message.guild, '🔇 Anti-Spam Timeout (15s)', `\`\`\`text\nUser : ${message.author.tag}\nPenalty: Message Deleted + 15s Timeout\n\`\`\``);
        } 
        else if (userSpam.count >= 3) {
            // 3rd Time: Delete message + 1m Mute (Timeout)
            await message.delete().catch(() => null);
            await member.timeout(60 * 1000, 'Sentinel Anti-Spam: 3rd Offense').catch(() => null);
            userSpam.count = 0; // Reset after heavy penalty
            await sendLiveLogs(message.guild, '🔇 Anti-Spam Timeout (1m)', `\`\`\`text\nUser : ${message.author.tag}\nPenalty: Message Deleted + 1 Minute Timeout\n\`\`\``);
        }
    }
});


// ================= 4. EXCLUSIVE OWNER DM CONTROL SYSTEM =================
client.on('messageCreate', async (message) => {
    if (message.guild) return; // Only listen in DMs
    if (message.author.bot) return;

    const ownerId = message.author.id;

    // Check if this user is owner of ANY server where the bot is present
    const managedGuilds = client.guilds.cache.filter(g => g.ownerId === ownerId);
    if (managedGuilds.size === 0) {
        return message.reply('❌ You are not the **Server Owner** of any server managed by this bot.');
    }

    const args = message.content.trim().split(/ +/);
    const cmd = args.shift().toLowerCase();

    // Select target server if multiple (using guild ID prefix or default first)
    let targetGuild = managedGuilds.first();

    if (cmd === '!setup') {
        // Usage: !setup <guild_id> <log_channel_id> <default_safe_role_id>
        const guildId = args[0];
        const logChanId = args[1];
        const safeRoleId = args[2];

        if (!guildId) return message.reply('❌ Usage: `!setup <guild_id> <log_channel_id> <safe_role_id>`');

        targetGuild = client.guilds.cache.get(guildId);
        if (!targetGuild || targetGuild.ownerId !== ownerId) {
            return message.reply('❌ Invalid Guild ID or you are not the owner of that server.');
        }

        let config = await GuildConfig.findOne({ guildId });
        if (!config) config = new GuildConfig({ guildId });

        if (logChanId) config.logChannelId = logChanId;
        if (safeRoleId) config.defaultSafeRoleId = safeRoleId;
        await config.save();

        return message.reply(`✅ Successfully updated security settings for **${targetGuild.name}**! Logs channel: \`${logChanId}\`, Safe Role: \`${safeRoleId}\``);
    }

    if (cmd === '!whitelist') {
        // Usage: !whitelist <guild_id> add/remove @user
        const guildId = args[0];
        const action = args[1];
        const mention = message.mentions.users.first() || args[2];

        if (!guildId || !action || !mention) {
            return message.reply('❌ Usage: `!whitelist <guild_id> add/remove @user_id`');
        }

        targetGuild = client.guilds.cache.get(guildId);
        if (!targetGuild || targetGuild.ownerId !== ownerId) {
            return message.reply('❌ Invalid Guild ID.');
        }

        let config = await GuildConfig.findOne({ guildId });
        if (!config) config = new GuildConfig({ guildId });
        if (!config.whitelistedUsers) config.whitelistedUsers = [];

        const targetId = typeof mention === 'string' ? mention : mention.id;

        if (action === 'add') {
            if (!config.whitelistedUsers.includes(targetId)) {
                config.whitelistedUsers.push(targetId);
                await config.save();
                return message.reply(`✅ Added user \`${targetId}\` to whitelist for **${targetGuild.name}**.`);
            } else {
                return message.reply(`⚠️ User is already whitelisted.`);
            }
        } else if (action === 'remove') {
            config.whitelistedUsers = config.whitelistedUsers.filter(id => id !== targetId);
            await config.save();
            return message.reply(`✅ Removed user \`${targetId}\` from whitelist for **${targetGuild.name}**.`);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
