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

// ================= A-TO-Z DETAILED DUAL LOGGING =================
async function sendDetailedLogs(guild, actionTitle, detailsObject, color = '#FF0000') {
    try {
        const config = await GuildConfig.findOne({ guildId: guild.id });
        
        let desc = '```text\n';
        for (const [key, value] of Object.entries(detailsObject)) {
            desc += `${key.padEnd(14)} : ${value}\n`;
        }
        desc += '```';

        const embed = new EmbedBuilder()
            .setTitle(actionTitle)
            .setDescription(desc)
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

async function isWhitelisted(guildId, userId, ownerId) {
    if (userId === ownerId || userId === client.user.id) return true;
    const config = await GuildConfig.findOne({ guildId });
    return config && config.whitelistedUsers && config.whitelistedUsers.includes(userId);
}


// ================= ULTIMATE PERMISSION LOCKDOWN (PREVENT ACTION) =================
// Ye function unwhitelisted roles/admins se dangerous permissions chheen lega taaki wo kuch hila hi na payein!
async function enforceLockdown(guild) {
    try {
        const ownerId = guild.ownerId;
        const config = await GuildConfig.findOne({ guildId: guild.id });
        const whitelisted = config ? config.whitelistedUsers : [];

        guild.roles.cache.forEach(async (role) => {
            if (role.managed || role.id === guild.id) return;

            // Check if role has dangerous permissions
            if (role.permissions.has(PermissionFlagsBits.Administrator) ||
                role.permissions.has(PermissionFlagsBits.ManageChannels) ||
                role.permissions.has(PermissionFlagsBits.ManageRoles)) {

                // Check if any member with this role is the owner or whitelisted
                const hasTrustedMember = role.members.some(m => m.id === ownerId || whitelisted.includes(m.id));

                if (!hasTrustedMember) {
                    await role.setPermissions(role.permissions.remove([
                        PermissionFlagsBits.Administrator,
                        PermissionFlagsBits.ManageChannels,
                        PermissionFlagsBits.ManageRoles,
                        PermissionFlagsBits.BanMembers,
                        PermissionFlagsBits.KickMembers
                    ])).catch(() => null);
                }
            }
        });
    } catch (e) {
        console.error('Lockdown Error:', e);
    }
}

// Run lockdown every 15 seconds automatically
setInterval(() => {
    client.guilds.cache.forEach(guild => enforceLockdown(guild));
}, 15 * 1000);


// ================= REGISTER SLASH COMMANDS =================
client.once('clientReady', async () => {
    console.log(`🛡️ Sentinel Advanced Bot Online as ${client.user.tag}`);
    if (process.env.MONGO_URI) await mongoose.connect(process.env.MONGO_URI);

    client.guilds.cache.forEach(guild => enforceLockdown(guild));

    const commands = [
        new SlashCommandBuilder()
            .setName('antinuke')
            .setDescription('Sentinel Security Management (Owner Only)')
            .addSubcommand(sub =>
                sub.setName('setup')
                    .setDescription('Configure log channel and default safe role')
                    .addChannelOption(opt => opt.setName('channel').setDescription('Log channel').setRequired(true))
                    .addRoleOption(opt => opt.setName('saferole').setDescription('Default safe role').setRequired(true))
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

            await sendDetailedLogs(
                member.guild,
                '🚨 UNAUTHORIZED BOT ADDED & NEUTRALIZED',
                {
                    'Bot Added': `${member.user.tag} (${member.id})`,
                    'Added By': `${entry.executor.tag} (${entry.executor.id})`,
                    'Bot Status': 'Kicked from Server',
                    'Adder Status': 'Roles Stripped to Safe Role'
                }
            );
        }
    } catch (e) {
        console.error('BotAdd Error:', e);
    }
});


// ================= 2. ADMIN & PLAYER PROTECTION GUARDS =================
client.on('channelDelete', async (channel) => {
    await handleAction(channel.guild, channel.name, 'Channel Delete', AuditLogEvent.ChannelDelete);
});

client.on('channelCreate', async (channel) => {
    await handleAction(channel.guild, channel.name, 'Channel Create', AuditLogEvent.ChannelCreate, true);
});

client.on('roleDelete', async (role) => {
    await handleAction(role.guild, role.name, 'Role Delete', AuditLogEvent.RoleDelete);
});

async function handleAction(guild, targetName, actionType, auditEventType, isCreation = false) {
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
                    // Strip all roles instantly
                    await member.roles.set([], `Sentinel: Unauthorized ${actionType}`).catch(() => null);
                }
            }

            if (isCreation) {
                const chan = guild.channels.cache.find(c => c.name === targetName);
                if (chan) await chan.delete('Sentinel: Unauthorized Creation').catch(() => null);
            }

            await sendDetailedLogs(
                guild,
                `🛡️ UNAUTHORIZED ${actionType.toUpperCase()} BLOCKED`,
                {
                    'Action Type': actionType,
                    'Target Name': targetName,
                    'Offender': `${entry.executor.tag} (${entry.executor.id})`,
                    'Offender Type': member?.user.bot ? 'Bot' : 'Human Admin/Player',
                    'Response': member?.user.bot ? 'Banned' : 'All Roles Stripped'
                }
            );
        } else {
            await sendDetailedLogs(
                guild,
                `📝 Safe Log: ${actionType}`,
                {
                    'Action Type': actionType,
                    'Target Name': targetName,
                    'Executed By': `${entry.executor.tag} (${entry.executor.id})`,
                    'Status': 'Whitelisted / Authorized'
                },
                '#00FF00'
            );
        }
    } catch (e) {
        console.error('Guard Error:', e);
    }
}


// ================= 3. STRICT ANTI-SPAM PROTECTION =================
client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;

    if (message.mentions.everyone || message.mentions.users.size > 3 || message.content.length > 400) {
        const userId = message.author.id;
        const ownerId = message.guild.ownerId;
        if (userId === ownerId) return;

        const now = Date.now();
        let userSpam = spamTracker.get(userId) || { count: 0, lastTime: now };

        if (now - userSpam.lastTime > 20000) userSpam.count = 0;

        userSpam.count += 1;
        userSpam.lastTime = now;
        spamTracker.set(userId, userSpam);

        const member = await message.guild.members.fetch(userId).catch(() => null);
        if (!member) return;

        if (userSpam.count === 1) {
            await message.reply({ content: `⚠️ **Warning:** Please do not spam or mass mention!` }).catch(() => null);
            await sendDetailedLogs(message.guild, '⚠️ Anti-Spam Warning (1st)', {
                'User': `${message.author.tag} (${message.author.id})`,
                'Channel': `#${message.channel.name}`,
                'Offense': '1st Warning Issued'
            }, '#FFA500');
        } 
        else if (userSpam.count === 2) {
            await message.delete().catch(() => null);
            await member.timeout(15 * 1000, 'Sentinel Anti-Spam: 2nd Offense').catch(() => null);
            await sendDetailedLogs(message.guild, '🔇 Anti-Spam Timeout (15s)', {
                'User': `${message.author.tag} (${message.author.id})`,
                'Channel': `#${message.channel.name}`,
                'Penalty': 'Message Deleted + 15s Timeout'
            });
        } 
        else if (userSpam.count >= 3) {
            await message.delete().catch(() => null);
            await member.timeout(60 * 1000, 'Sentinel Anti-Spam: 3rd Offense').catch(() => null);
            userSpam.count = 0;
            await sendDetailedLogs(message.guild, '🔇 Anti-Spam Timeout (1m)', {
                'User': `${message.author.tag} (${message.author.id})`,
                'Channel': `#${message.channel.name}`,
                'Penalty': 'Message Deleted + 1 Minute Timeout'
            });
        }
    }
});


// ================= 4. OWNER COMMAND HANDLER =================
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.user.id !== interaction.guild.ownerId) {
        return await interaction.reply({ content: '❌ Only the **Server Owner** can manage Sentinel Security settings!', ephemeral: true });
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

            await enforceLockdown(interaction.guild);

            await sendDetailedLogs(
                interaction.guild,
                '⚙️ Sentinel Settings Updated',
                {
                    'Updated By': `${interaction.user.tag} (${interaction.user.id})`,
                    'Log Channel': `#${chan.name}`,
                    'Safe Role': `@${safeRole.name}`,
                    'Lockdown': 'Enforced Across All Roles'
                },
                '#0099FF'
            );

            return await interaction.reply({ content: `✅ Sentinel security configured successfully!`, ephemeral: true });
        }

        if (sub === 'whitelist') {
            const action = interaction.options.getString('action');
            const target = interaction.options.getUser('target');

            if (!config.whitelistedUsers) config.whitelistedUsers = [];

            if (action === 'add') {
                if (config.whitelistedUsers.includes(target.id)) {
                    return await interaction.reply({ content: `⚠️ ${target.tag} is already whitelisted.`, ephemeral: true });
                }
                config.whitelistedUsers.push(target.id);
                await config.save();
                await enforceLockdown(interaction.guild);

                await sendDetailedLogs(interaction.guild, '🟢 Whitelist Added', {
                    'Admin': `${interaction.user.tag}`,
                    'Target User': `${target.tag} (${target.id})`,
                    'Status': 'Added & Lockdown Refreshed'
                }, '#00FF00');

                return await interaction.reply({ content: `✅ Successfully added **${target.tag}** to whitelist.`, ephemeral: true });
            } else if (action === 'remove') {
                config.whitelistedUsers = config.whitelistedUsers.filter(id => id !== target.id);
                await config.save();
                await enforceLockdown(interaction.guild);

                await sendDetailedLogs(interaction.guild, '🔴 Whitelist Removed', {
                    'Admin': `${interaction.user.tag}`,
                    'Target User': `${target.tag} (${target.id})`,
                    'Status': 'Removed & Lockdown Refreshed'
                });

                return await interaction.reply({ content: `✅ Successfully removed **${target.tag}** from whitelist.`, ephemeral: true });
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
                       
