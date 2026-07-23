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

const spamTracker = new Map();

// Helper: Dispatch live detailed logs to Server Log Channel + Server Owner's DM simultaneously
async function sendDualLogs(guild, title, description, color = '#FF0000') {
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
        console.error('Dual Logging Error:', e);
    }
}

async function isWhitelisted(guildId, userId, ownerId) {
    if (userId === ownerId || userId === client.user.id) return true;
    const config = await GuildConfig.findOne({ guildId });
    return config && config.whitelistedUsers && config.whitelistedUsers.includes(userId);
}


// ================= REGISTER / CLEAN SLASH COMMANDS ON READY =================
client.once('clientReady', async () => {
    console.log(`🛡️ Sentinel Security Bot Online as ${client.user.tag}`);
    if (process.env.MONGO_URI) await mongoose.connect(process.env.MONGO_URI);

    const commands = [
        new SlashCommandBuilder()
            .setName('antinuke')
            .setDescription('Sentinel Security Management (Owner Only)')
            .addSubcommand(sub =>
                sub.setName('setup')
                    .setDescription('Configure log channel and default safe role')
                    .addChannelOption(opt => opt.setName('channel').setDescription('Log channel for server').setRequired(true))
                    .addRoleOption(opt => opt.setName('saferole').setDescription('Default safe role when unauthorized bot is added').setRequired(true))
            )
            .addSubcommand(sub =>
                sub.setName('whitelist')
                    .setDescription('Manage strict whitelist')
                    .addStringOption(opt => opt.setName('action').setDescription('Add or Remove').setRequired(true)
                        .addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }))
                    .addUserOption(opt => opt.setName('target').setDescription('User or Bot to whitelist').setRequired(true))
            )
    ].map(c => c.toJSON());

    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('✅ Slash commands registered successfully!');
    } catch (e) {
        console.error('Command registration error:', e);
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
            // Kick unauthorized bot
            await member.kick('Sentinel: Unauthorized Bot Addition').catch(() => null);

            // Strip roles from the player who added it, keep only default safe role
            const adder = await member.guild.members.fetch(executorId).catch(() => null);
            if (adder) {
                const config = await GuildConfig.findOne({ guildId: member.guild.id });
                const safeRoleId = config ? config.defaultSafeRoleId : null;
                const newRoles = safeRoleId ? [safeRoleId] : [];
                await adder.roles.set(newRoles, 'Sentinel: Added unauthorized bot').catch(() => null);
            }

            await sendDualLogs(
                member.guild,
                '🚨 UNAUTHORIZED BOT BLOCKED & ADDER PUNISHED',
                `\`\`\`text\nBot Added : ${member.user.tag}\nAdded By  : ${entry.executor.tag}\nAction    : Bot Kicked, Adder Roles Stripped to Safe Role\n\`\`\``
            );
        }
    } catch (e) {
        console.error('BotAdd Guard Error:', e);
    }
});


// ================= 2. ADMIN & PLAYER PROTECTION GUARD =================
client.on('channelDelete', async (channel) => {
    await handleUnauthorizedAction(channel.guild, channel.name, 'Channel Delete', AuditLogEvent.ChannelDelete);
});

client.on('channelCreate', async (channel) => {
    await handleUnauthorizedAction(channel.guild, channel.name, 'Channel Create', AuditLogEvent.ChannelCreate, true);
});

client.on('roleDelete', async (role) => {
    await handleUnauthorizedAction(role.guild, role.name, 'Role Delete', AuditLogEvent.RoleDelete);
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
                    // Strip all roles from human admin/player immediately
                    await member.roles.set([], `Sentinel: Unauthorized ${actionType}`).catch(() => null);
                }
            }

            if (isCreation) {
                const chan = guild.channels.cache.find(c => c.name === targetName);
                if (chan) await chan.delete('Sentinel: Unauthorized Creation').catch(() => null);
            }

            await sendDualLogs(
                guild,
                `🛡️ UNAUTHORIZED ${actionType.toUpperCase()} BLOCKED`,
                `\`\`\`text\nTarget    : ${targetName}\nAction By : ${entry.executor.tag}\nResponse  : Offender Neutralized / All Roles Stripped\n\`\`\``
            );
        } else {
            await sendDualLogs(
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
            await sendDualLogs(message.guild, '⚠️ Anti-Spam Warning', `\`\`\`text\nUser : ${message.author.tag}\nOffense: 1st Warning (Spam)\n\`\`\``, '#FFA500');
        } 
        else if (userSpam.count === 2) {
            await message.delete().catch(() => null);
            await member.timeout(15 * 1000, 'Sentinel Anti-Spam: 2nd Offense').catch(() => null);
            await sendDualLogs(message.guild, '🔇 Anti-Spam Timeout (15s)', `\`\`\`text\nUser : ${message.author.tag}\nPenalty: Message Deleted + 15s Timeout\n\`\`\``);
        } 
        else if (userSpam.count >= 3) {
            await message.delete().catch(() => null);
            await member.timeout(60 * 1000, 'Sentinel Anti-Spam: 3rd Offense').catch(() => null);
            userSpam.count = 0;
            await sendDualLogs(message.guild, '🔇 Anti-Spam Timeout (1m)', `\`\`\`text\nUser : ${message.author.tag}\nPenalty: Message Deleted + 1 Minute Timeout\n\`\`\``);
        }
    }
});


// ================= 4. EXCLUSIVE SERVER OWNER SLASH COMMAND HANDLER =================
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // Strict Ownership restriction: Only server owner can run bot commands
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

            await sendDualLogs(
                interaction.guild,
                '⚙️ Sentinel Settings Updated',
                `\`\`\`text\nUpdated By  : ${interaction.user.tag}\nLog Channel : #${chan.name}\nSafe Role   : @${safeRole.name}\n\`\`\``,
                '#0099FF'
            );

            return await interaction.reply({ content: `✅ Successfully updated security settings! Logs will be sent to ${chan} and your DM.`, ephemeral: true });
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

                await sendDualLogs(
                    interaction.guild,
                    '🟢 Whitelist Added',
                    `\`\`\`text\nAdmin       : ${interaction.user.tag}\nAdded User  : ${target.tag} (${target.id})\n\`\`\``,
                    '#00FF00'
                );

                return await interaction.reply({ content: `✅ Successfully added **${target.tag}** to the strict whitelist.`, ephemeral: true });
            } else if (action === 'remove') {
                config.whitelistedUsers = config.whitelistedUsers.filter(id => id !== target.id);
                await config.save();

                await sendDualLogs(
                    interaction.guild,
                    '🔴 Whitelist Removed',
                    `\`\`\`text\nAdmin       : ${interaction.user.tag}\nRemoved User: ${target.tag} (${target.id})\n\`\`\``,
                    '#FF0000'
                );

                return await interaction.reply({ content: `✅ Successfully removed **${target.tag}** from the whitelist.`, ephemeral: true });
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
                                                                    
