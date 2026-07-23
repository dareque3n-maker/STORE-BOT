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

// ================= DUAL LOGS WITH INTERACTIVE OWNER DM PANEL =================
async function sendInteractivePanel(guild, offender, actionTitle, detailsObj) {
    try {
        const config = await GuildConfig.findOne({ guildId: guild.id });
        
        let logText = `[SECURITY EVENT]\n`;
        for (const [key, val] of Object.entries(detailsObj)) {
            logText += `> ${key.padEnd(14)} : ${val}\n`;
        }

        const embed = new EmbedBuilder()
            .setTitle(`🚨 ${actionTitle}`)
            .setDescription(`\`\`\`text\n${logText}\`\`\``)
            .setColor('#FF0000')
            .setTimestamp();

        // 1. Send to Server Log Channel (Simple Log)
        if (config && config.logChannelId) {
            const logChan = guild.channels.cache.get(config.logChannelId);
            if (logChan) await logChan.send({ embeds: [embed] }).catch(() => null);
        }

        // 2. Send to Server Owner DM with Interactive Action Buttons
        const owner = await guild.fetchOwner().catch(() => null);
        if (owner && offender) {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`punish_kick_${guild.id}_${offender.id}`).setLabel('Kick').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`punish_ban_${guild.id}_${offender.id}`).setLabel('Ban').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`punish_timeout_${guild.id}_${offender.id}`).setLabel('Timeout (5m)').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`punish_strip_${guild.id}_${offender.id}`).setLabel('Strip Roles Only').setStyle(ButtonStyle.Primary)
            );

            await owner.send({ embeds: [embed], components: [row] }).catch(() => null);
        }
    } catch (e) {
        console.error('Interactive Panel Error:', e);
    }
}

async function isWhitelisted(guildId, userId, ownerId) {
    if (userId === ownerId || userId === client.user.id) return true;
    const config = await GuildConfig.findOne({ guildId });
    return config && config.whitelistedUsers && config.whitelistedUsers.includes(userId);
}


// ================= AUTO-STRIP DANGEROUS PERMISSIONS FROM NON-WHITELISTED =================
async function enforceLockdown(guild) {
    try {
        const ownerId = guild.ownerId;
        const config = await GuildConfig.findOne({ guildId: guild.id });
        const whitelisted = config ? config.whitelistedUsers : [];

        guild.roles.cache.forEach(async (role) => {
            if (role.managed || role.id === guild.id) return;

            if (role.permissions.has(PermissionFlagsBits.Administrator) ||
                role.permissions.has(PermissionFlagsBits.ManageChannels) ||
                role.permissions.has(PermissionFlagsBits.ManageRoles)) {

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
    } catch (e) { console.error(e); }
}

setInterval(() => {
    client.guilds.cache.forEach(guild => enforceLockdown(guild));
}, 10 * 1000);


// ================= COMMANDS & READY =================
client.once('clientReady', async () => {
    console.log(`🛡️ Sentinel Interactive Bot Active as ${client.user.tag}`);
    if (process.env.MONGO_URI) await mongoose.connect(process.env.MONGO_URI);

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


// ================= LIVE TRACKING: ROLES, KICKS, BANS & TAMPERING =================
client.on('guildAuditLogEntryCreate', async (entry, guild) => {
    try {
        const { action, executorId, target } = entry;
        if (!executorId || executorId === client.user.id) return;

        const allowed = await isWhitelisted(guild.id, executorId, guild.ownerId);
        if (allowed) return; // Whitelisted loghi

        const offender = await guild.members.fetch(executorId).catch(() => null);
        if (!offender || offender.user.bot) return;

        // 1. Role Given or Removed by Non-Whitelisted Admin
        if (action === AuditLogEvent.MemberRoleUpdate) {
            await offender.roles.set([], 'Sentinel: Unauthorized Role Assignment/Removal').catch(() => null);
            await sendInteractivePanel(guild, offender, 'UNAUTHORIZED ROLE MODIFICATION', {
                'Offender': `${offender.user.tag} (${executorId})`,
                'Action': 'Changed member roles without whitelist',
                'Penalty Applied': 'All roles stripped automatically'
            });
        }

        // 2. Unauthorized Kick / Ban / Timeout issued
        if (action === AuditLogEvent.MemberKick || action === AuditLogEvent.MemberBanAdd || action === AuditLogEvent.MemberUpdate) {
            await offender.roles.set([], 'Sentinel: Unauthorized Moderation Action').catch(() => null);
            await sendInteractivePanel(guild, offender, 'UNAUTHORIZED MODERATION ACTION', {
                'Offender': `${offender.user.tag} (${executorId})`,
                'Action Type': AuditLogEvent[action],
                'Penalty Applied': 'All roles stripped automatically'
            });
        }
    } catch (e) { console.error(e); }
});

// Channel Tamper / Delete Tracking
client.on('channelDelete', async (channel) => {
    await handleTamper(channel.guild, channel.name, 'Channel Delete');
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
                    if (member.bannable) await member.ban({ reason: `Sentinel: ${actionType}` }).catch(() => null);
                } else {
                    await member.roles.set([], `Sentinel: ${actionType}`).catch(() => null);
                }
            }
            await sendInteractivePanel(guild, member, `UNAUTHORIZED ${actionType.toUpperCase()}`, {
                'Target': targetName,
                'Offender': `${entry.executor.tag} (${executorId})`,
                'Action': member?.user.bot ? 'Bot Banned' : 'Admin Roles Stripped'
            });
        }
    } catch (e) { console.error(e); }
}


// ================= HANDLE OWNER DM BUTTON CLICKS (INTERACTIVE PANEL) =================
client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton()) {
        const parts = interaction.customId.split('_');
        const actionType = parts[1]; // punish_kick -> kick
        const guildId = parts[2];
        const targetUserId = parts[3];

        const guild = client.guilds.cache.get(guildId);
        if (!guild || interaction.user.id !== guild.ownerId) {
            return await interaction.reply({ content: '❌ You are not authorized or guild not found.', ephemeral: true });
        }

        const targetMember = await guild.members.fetch(targetUserId).catch(() => null);

        if (!targetMember) {
            return await interaction.update({ content: `⚠️ Target member is no longer in the server.`, components: [] });
        }

        try {
            if (actionType === 'kick') {
                await targetMember.kick('Sentinel Owner DM Panel: Kicked').catch(() => null);
                await interaction.update({ content: `✅ Successfully **Kicked** ${targetMember.user.tag} from ${guild.name}.`, components: [] });
            } else if (actionType === 'ban') {
                await targetMember.ban({ reason: 'Sentinel Owner DM Panel: Banned' }).catch(() => null);
                await interaction.update({ content: `✅ Successfully **Banned** ${targetMember.user.tag} from ${guild.name}.`, components: [] });
            } else if (actionType === 'timeout') {
                await targetMember.timeout(5 * 60 * 1000, 'Sentinel Owner DM Panel: Timeout').catch(() => null);
                await interaction.update({ content: `✅ Successfully gave **5 minutes Timeout** to ${targetMember.user.tag}.`, components: [] });
            } else if (actionType === 'strip') {
                await targetMember.roles.set([], 'Sentinel Owner DM Panel: Strip Roles').catch(() => null);
                await interaction.update({ content: `✅ Successfully **Stripped All Roles** from ${targetMember.user.tag}.`, components: [] });
            }
        } catch (e) {
            await interaction.reply({ content: `❌ Failed to execute action: Missing permissions.`, ephemeral: true });
        }
        return;
    }

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

            await enforceLockdown(interaction.guild);
            return await interaction.reply({ content: `✅ Sentinel setup complete! Interactive DM panels active.`, ephemeral: true });
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
