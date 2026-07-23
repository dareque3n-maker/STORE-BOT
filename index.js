require('dotenv').config();
const { Client, GatewayIntentBits, AuditLogEvent, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, REST, Routes, PermissionFlagsBits } = require('discord.js');
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
const lastMessageTracker = new Map();

// ================= LIVE CONSOLE & DM INTERACTIVE ALERT =================
async function sendSecurityAlert(guild, offender, category, detailsObj) {
    try {
        const config = await GuildConfig.findOne({ guildId: guild.id });
        
        let logText = `[SECURITY ALERT: ${category.toUpperCase()}]\n`;
        for (const [key, val] of Object.entries(detailsObj)) {
            logText += `> ${key.padEnd(16)} : ${val}\n`;
        }

        const embed = new EmbedBuilder()
            .setTitle(`🚨 Security Breach // ${category}`)
            .setDescription(`\`\`\`text\n${logText}\`\`\``)
            .setColor('#FF0000')
            .setTimestamp();

        // 1. Send to Server Log Channel
        if (config && config.logChannelId) {
            const logChan = guild.channels.cache.get(config.logChannelId);
            if (logChan) await logChan.send({ embeds: [embed] }).catch(() => null);
        }

        // 2. Send to Server Owner DM with Interactive Buttons
        const owner = await guild.fetchOwner().catch(() => null);
        if (owner) {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`punish_kick_${guild.id}_${offender ? offender.id : 'unknown'}`).setLabel('Kick').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`punish_ban_${guild.id}_${offender ? offender.id : 'unknown'}`).setLabel('Ban').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`punish_timeout_${guild.id}_${offender ? offender.id : 'unknown'}`).setLabel('Timeout (5m)').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`punish_strip_${guild.id}_${offender ? offender.id : 'unknown'}`).setLabel('Strip Roles').setStyle(ButtonStyle.Primary)
            );

            await owner.send({ embeds: [embed], components: [row] }).catch(() => null);
        }
    } catch (e) {
        console.error('Alert Error:', e);
    }
}

// Simple live console logger for normal chat/events
async function sendLiveConsole(guild, title, detailsObj, color = '#00FF00') {
    try {
        const config = await GuildConfig.findOne({ guildId: guild.id });
        if (!config || !config.logChannelId) return;

        const logChan = guild.channels.cache.get(config.logChannelId);
        if (!logChan) return;

        let logText = ``;
        for (const [key, val] of Object.entries(detailsObj)) {
            logText += `${key}: ${val}\n`;
        }

        const embed = new EmbedBuilder()
            .setTitle(`📡 ${title}`)
            .setDescription(`\`\`\`text\n${logText}\`\`\``)
            .setColor(color)
            .setTimestamp();

        await logChan.send({ embeds: [embed] }).catch(() => null);
    } catch (e) {
        console.error('Live Console Error:', e);
    }
}

async function isWhitelisted(guildId, userId, ownerId) {
    if (userId === ownerId || userId === client.user.id) return true;
    const config = await GuildConfig.findOne({ guildId });
    return config && config.whitelistedUsers && config.whitelistedUsers.includes(userId);
}


// ================= LIVE CHAT & SPAM MONITOR =================
client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;

    const userId = message.author.id;
    const ownerId = message.guild.ownerId;

    // 1. Live Chat Console Stream
    await sendLiveConsole(message.guild, 'Live Chat Stream', {
        'Author': `${message.author.tag} (${userId})`,
        'Channel': `#${message.channel.name}`,
        'Message': message.content || '[Attachment/Embed]'
    }, '#00FFFF');

    if (userId === ownerId) return; // Owner immune to anti-spam

    const now = Date.now();
    let userSpam = spamTracker.get(userId) || { count: 0, lastTime: now };
    let lastMsg = lastMessageTracker.get(userId);

    // 2. Repeat / Duplicate Message Spam Protection (15s Timeout)
    if (lastMsg && lastMsg.content === message.content && (now - lastMsg.timestamp < 8000)) {
        await message.delete().catch(() => null);
        const member = await message.guild.members.fetch(userId).catch(() => null);
        if (member) {
            await member.timeout(15 * 1000, 'Sentinel: Duplicate Spam').catch(() => null);
        }
        await sendSecurityAlert(message.guild, message.member, 'Message Spam / Repeat', {
            'User': `${message.author.tag} (${userId})`,
            'Channel': `#${message.channel.name}`,
            'Violation': 'Repeated identical messages rapidly',
            'Penalty': 'Message Deleted + 15s Timeout'
        });
        return;
    }
    lastMessageTracker.set(userId, { content: message.content, timestamp: now });

    // 3. Mass Mentions / Ping Spam Protection
    if (message.mentions.everyone || message.mentions.users.size > 2 || message.content.length > 450) {
        if (now - userSpam.lastTime > 20000) userSpam.count = 0;
        userSpam.count += 1;
        userSpam.lastTime = now;
        spamTracker.set(userId, userSpam);

        const member = await message.guild.members.fetch(userId).catch(() => null);
        if (!member) return;

        if (userSpam.count === 1) {
            await message.reply({ content: `⚠️ **Warning:** Please avoid mass pings and spam!` }).catch(() => null);
        } else if (userSpam.count >= 2) {
            await message.delete().catch(() => null);
            await member.timeout(30 * 1000, 'Sentinel: Mass Ping Spam').catch(() => null);
            await sendSecurityAlert(message.guild, member, 'Mass Ping / Mention Spam', {
                'User': `${message.author.tag} (${userId})`,
                'Channel': `#${message.channel.name}`,
                'Penalty': 'Message Deleted + 30s Timeout'
            });
        }
    }
});


// ================= SECURITY & TAMPERING GUARDS =================

// Bot Add Detection
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
            await sendSecurityAlert(member.guild, adder, 'Unauthorized Bot Added', {
                'Bot Added': `${member.user.tag} (${member.id})`,
                'Added By': `${entry.executor.tag} (${entry.executor.id})`,
                'Action': 'Bot Kicked, Adder Roles Stripped'
            });
        }
    } catch (e) { console.error(e); }
});

// Role Changes / Assignment Tracking (Logs who gave/removed roles)
client.on('guildMemberUpdate', async (oldMember, newMember) => {
    try {
        const addedRoles = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id));
        const removedRoles = oldMember.roles.cache.filter(r => !newMember.roles.cache.has(r.id));

        if (addedRoles.size > 0 || removedRoles.size > 0) {
            const audit = await newMember.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.MemberRoleUpdate }).catch(() => null);
            const entry = audit?.entries.first();
            
            const executor = entry ? entry.executor : null;
            const roleNames = [...addedRoles.values()].map(r => r.name).join(', ') || [...removedRoles.values()].map(r => r.name).join(', ');
            const actionType = addedRoles.size > 0 ? 'Role Given' : 'Role Removed';

            // Check if unauthorized admin is messing with roles
            if (executor && !await isWhitelisted(newMember.guild.id, executor.id, newMember.guild.ownerId) && executor.id !== client.user.id) {
                const adminMember = await newMember.guild.members.fetch(executor.id).catch(() => null);
                if (adminMember && !adminMember.user.bot) {
                    await adminMember.roles.set([], 'Sentinel: Unauthorized Role Tampering').catch(() => null);
                    await sendSecurityAlert(newMember.guild, adminMember, 'Unauthorized Role Modification', {
                        'Target Member': `${newMember.user.tag}`,
                        'Action': actionType,
                        'Roles Involved': roleNames,
                        'Tampered By': `${executor.tag} (${executor.id})`,
                        'Penalty': 'Offender Roles Stripped'
                    });
                    return;
                }
            }

            // Normal live log
            await sendLiveConsole(newMember.guild, 'Role Update Log', {
                'Target Member': newMember.user.tag,
                'Action': actionType,
                'Roles': roleNames,
                'Modified By': executor ? executor.tag : 'Unknown / System'
            }, '#FFA500');
        }
    } catch (e) { console.error(e); }
});

// Channel Deletion / Tampering
client.on('channelDelete', async (channel) => {
    try {
        const audit = await channel.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.ChannelDelete }).catch(() => null);
        const entry = audit?.entries.first();
        if (!entry || !entry.executor) return;

        const allowed = await isWhitelisted(channel.guild.id, entry.executor.id, channel.guild.ownerId);
        if (!allowed && entry.executor.id !== client.user.id) {
            const offender = await channel.guild.members.fetch(entry.executor.id).catch(() => null);
            if (offender) {
                if (offender.user.bot) {
                    if (offender.bannable) await offender.ban({ reason: 'Sentinel: Channel Delete' }).catch(() => null);
                } else {
                    await offender.roles.set([], 'Sentinel: Channel Delete').catch(() => null);
                }
            }
            await sendSecurityAlert(channel.guild, offender, 'Unauthorized Channel Deletion', {
                'Channel Name': `#${channel.name}`,
                'Deleted By': `${entry.executor.tag} (${entry.executor.id})`,
                'Penalty': offender?.user.bot ? 'Bot Banned' : 'All Roles Stripped'
            });
        }
    } catch (e) { console.error(e); }
});


// ================= OWNER DM BUTTON INTERACTION =================
client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton()) {
        const parts = interaction.customId.split('_');
        const actionType = parts[1]; // kick, ban, timeout, strip
        const guildId = parts[2];
        const targetUserId = parts[3];

        const guild = client.guilds.cache.get(guildId);
        if (!guild || interaction.user.id !== guild.ownerId) {
            return await interaction.reply({ content: '❌ Unauthorized.', ephemeral: true });
        }

        const targetMember = await guild.members.fetch(targetUserId).catch(() => null);
        if (!targetMember) {
            return await interaction.update({ content: `⚠️ Target user not found in server.`, components: [] });
        }

        try {
            if (actionType === 'kick') {
                await targetMember.kick('Sentinel Owner Panel').catch(() => null);
                await interaction.update({ content: `✅ Kicked **${targetMember.user.tag}**.`, components: [] });
            } else if (actionType === 'ban') {
                await targetMember.ban({ reason: 'Sentinel Owner Panel' }).catch(() => null);
                await interaction.update({ content: `✅ Banned **${targetMember.user.tag}**.`, components: [] });
            } else if (actionType === 'timeout') {
                await targetMember.timeout(5 * 60 * 1000, 'Sentinel Owner Panel').catch(() => null);
                await interaction.update({ content: `✅ Timed out **${targetMember.user.tag}** for 5 minutes.`, components: [] });
            } else if (actionType === 'strip') {
                await targetMember.roles.set([], 'Sentinel Owner Panel').catch(() => null);
                await interaction.update({ content: `✅ Stripped all roles from **${targetMember.user.tag}**.`, components: [] });
            }
        } catch (e) {
            await interaction.reply({ content: `❌ Failed to execute action due to permissions.`, ephemeral: true });
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;
    if (interaction.user.id !== interaction.guild.ownerId) {
        return await interaction.reply({ content: '❌ Only the Server Owner can use this!', ephemeral: true });
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

            return await interaction.reply({ content: `✅ Setup complete! Logs will go to ${chan} & Owner DM.`, ephemeral: true });
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


// ================= READY & COMMAND REGISTRATION =================
client.once('clientReady', async () => {
    console.log(`🛡️ Sentinel Ultimate Bot Active as ${client.user.tag}`);
    if (process.env.MONGO_URI) await mongoose.connect(process.env.MONGO_URI);

    const commands = [
        new SlashCommandBuilder()
            .setName('antinuke')
            .setDescription('Sentinel Security Management')
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

client.login(process.env.DISCORD_TOKEN);
                                                           
