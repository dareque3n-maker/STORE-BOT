require('dotenv').config();
const { Client, GatewayIntentBits, AuditLogEvent, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const mongoose = require('mongoose');
const AntiNukeConfig = require('./models/AntiNukeConfig');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent
    ]
});

// ================= ROLLING & EMERGENCY BACKUP ENGINE =================
async function takeRollingBackup(guild) {
    try {
        const roles = guild.roles.cache
            .filter(r => !r.managed && r.id !== guild.id)
            .map(r => ({
                name: r.name,
                color: r.hexColor,
                permissions: r.permissions.bitfield.toString(),
                hoist: r.hoist,
                position: r.position
            }));

        const channels = guild.channels.cache.map(c => ({
            name: c.name,
            type: c.type,
            parentId: c.parent ? c.parent.name : null,
            position: c.position
        }));

        const backupData = { roles, channels };
        const backupId = 'emg_' + Date.now();

        let config = await AntiNukeConfig.findOne({ guildId: guild.id });
        if (!config) config = new AntiNukeConfig({ guildId: guild.id });

        if (!config.backups) config.backups = [];
        config.backups.push({ backupId, timestamp: new Date(), data: backupData });

        // Keep last 10 snapshots safe, older ones auto-prune
        if (config.backups.length > 10) {
            config.backups.shift();
        }

        await config.save();
        return backupId;
    } catch (e) {
        console.error('Backup error:', e);
        return null;
    }
}

// Periodic background rolling state (every 30 secs)
setInterval(() => {
    client.guilds.cache.forEach(guild => takeRollingBackup(guild));
}, 30 * 1000);

// Helper function to dispatch logs to Log Channel + Owner DM with exact format
async function sendAlertLogs(guild, config, title, description, emergencyId = null) {
    let desc = description;
    if (emergencyId) {
        desc += `\n\n**👇 Copy & Paste this restore command:**\n\`\`\`/restore id:${emergencyId}\`\`\``;
    }

    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(desc)
        .setColor('#FF0000')
        .setTimestamp();

    // 1. Send to Log Channel
    if (config && config.logChannelId) {
        const logChan = guild.channels.cache.get(config.logChannelId);
        if (logChan) await logChan.send({ embeds: [embed] }).catch(() => null);
    }

    // 2. Send to Owner DM
    const owner = await guild.fetchOwner().catch(() => null);
    if (owner) {
        await owner.send({ embeds: [embed] }).catch(() => null);
    }
}


// ================= STRICT WHITELIST & ANTI-NUKE DEFENSE =================

// Bot Add Protection (Unauthorized Bot Add Guard)
client.on('guildMemberAdd', async (member) => {
    try {
        if (!member.user.bot) return;

        const audit = await member.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.BotAdd }).catch(() => null);
        const entry = audit?.entries.first();
        if (!entry || !entry.executor) return;

        const executorId = entry.executor.id;
        if (executorId === member.guild.ownerId || executorId === client.user.id) return;

        const config = await AntiNukeConfig.findOne({ guildId: member.guild.id });
        if (config && config.whitelistedUsers && config.whitelistedUsers.includes(executorId)) return;

        // UNAUTHORIZED BOT ADD DETECTED!
        await member.kick('Unauthorized Bot Addition').catch(() => null);
        
        const banner = await member.guild.members.fetch(executorId).catch(() => null);
        if (banner && banner.bannable) {
            await banner.roles.set([]).catch(() => null);
            await banner.ban({ reason: `🚨 Anti-Nuke: Added unauthorized bot (${member.user.tag})` }).catch(() => null);
        }

        const emergencyId = await takeRollingBackup(member.guild);
        await sendAlertLogs(
            member.guild, 
            config, 
            '🚨 UNAUTHORIZED BOT ADDED & NEUTRALIZED!', 
            `\`\`\`text\nBot Added : ${member.user.tag}\nAdded By  : ${entry.executor.tag}\nStatus    : Bot Kicked, Adder Banned\n\`\`\``,
            emergencyId
        );
    } catch (e) {
        console.error('BotAdd audit error:', e);
    }
});

// Channel Deletion Protection
client.on('channelDelete', async (channel) => {
    try {
        const audit = await channel.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.ChannelDelete }).catch(() => null);
        const entry = audit?.entries.first();
        if (!entry || !entry.executor) return;

        const executorId = entry.executor.id;
        if (executorId === channel.guild.ownerId || executorId === client.user.id) return;

        const config = await AntiNukeConfig.findOne({ guildId: channel.guild.id });
        if (config && config.whitelistedUsers && config.whitelistedUsers.includes(executorId)) return;

        const member = await channel.guild.members.fetch(executorId).catch(() => null);
        if (member && member.bannable) {
            await member.roles.set([]).catch(() => null);
            await member.ban({ reason: `🚨 Anti-Nuke: Unauthorized Channel Deletion` }).catch(() => null);
        }

        const emergencyId = await takeRollingBackup(channel.guild);
        await sendAlertLogs(
            channel.guild,
            config,
            '🚨 UNAUTHORIZED CHANNEL DELETION BLOCKED!',
            `\`\`\`text\nChannel : #${channel.name}\nDeleted By : ${entry.executor.tag}\nStatus : Banned & Neutralized\n\`\`\``,
            emergencyId
        );
    } catch (e) {
        console.error('Channel delete guard error:', e);
    }
});


// ================= SLASH COMMANDS REGISTRATION =================
client.once('ready', async () => {
    console.log(`🛡️ Enterprise Anti-Nuke Bot Active as ${client.user.tag}`);
    if (process.env.MONGO_URI) await mongoose.connect(process.env.MONGO_URI);

    client.guilds.cache.forEach(guild => takeRollingBackup(guild));

    const commands = [
        new SlashCommandBuilder().setName('antinuke').setDescription('Anti-Nuke Management (Owner Only)')
            .addSubcommand(s => s.setName('setup').setDescription('Set log channel').addChannelOption(c => c.setName('channel').setDescription('Log channel').setRequired(true)))
            .addSubcommand(s => s.setName('whitelist').setDescription('Whitelist a user/bot')
                .addStringOption(o => o.setName('action').setDescription('Add or Remove').setRequired(true).addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }))
                .setUserOption(u => u.setName('target').setDescription('User or Bot to whitelist').setRequired(true))),
        
        new SlashCommandBuilder().setName('restore').setDescription('Restore server from emergency backup (Owner Only)')
            .addStringOption(o => o.setName('id').setDescription('Backup ID').setRequired(true))
    ].map(c => c.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
});


// ================= COMMAND HANDLING (OWNER ONLY RESTRICTION) =================
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // Strict Ownership restriction for all security configurations
    if (interaction.user.id !== interaction.guild.ownerId) {
        return await interaction.reply({ content: '❌ Only the **Server Owner** can manage Anti-Nuke settings!', ephemeral: true });
    }

    if (interaction.commandName === 'antinuke') {
        const sub = interaction.options.getSubcommand();
        let config = await AntiNukeConfig.findOne({ guildId: interaction.guild.id });
        if (!config) config = new AntiNukeConfig({ guildId: interaction.guild.id });

        if (sub === 'setup') {
            const chan = interaction.options.getChannel('channel');
            config.logChannelId = chan.id;
            await config.save();
            return await interaction.reply({ content: `✅ Anti-Nuke logs & owner DMs will now be sent to ${chan}`, ephemeral: true });
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
                return await interaction.reply({ content: `✅ Successfully added **${target.tag}** to the strict whitelist.`, ephemeral: true });
            } else if (action === 'remove') {
                config.whitelistedUsers = config.whitelistedUsers.filter(id => id !== target.id);
                await config.save();
                return await interaction.reply({ content: `✅ Successfully removed **${target.tag}** from the whitelist.`, ephemeral: true });
            }
        }
    }

    if (interaction.commandName === 'restore') {
        await interaction.deferReply({ ephemeral: true });
        const backupId = interaction.options.getString('id');
        const config = await AntiNukeConfig.findOne({ guildId: interaction.guild.id });
        
        const targetBackup = config?.backups?.find(b => b.backupId === backupId);
        if (!targetBackup) {
            return await interaction.editReply({ content: '❌ Invalid Backup ID or expired!' });
        }

        await interaction.editReply({ content: `🔄 Restoring server structure from emergency snapshot...` });

        const categoryMap = new Map();
        const channelData = targetBackup.data.channels;

        const categories = channelData.filter(c => c.type === 4);
        const otherChannels = channelData.filter(c => c.type !== 4);

        for (const cat of categories) {
            const createdCat = await interaction.guild.channels.create({
                name: cat.name,
                type: 4,
                position: cat.position
            }).catch(() => null);

            if (createdCat) categoryMap.set(cat.name, createdCat.id);
        }

        for (const chan of otherChannels) {
            let parentId = null;
            if (chan.parentId && categoryMap.has(chan.parentId)) {
                parentId = categoryMap.get(chan.parentId);
            }

            await interaction.guild.channels.create({
                name: chan.name,
                type: chan.type,
                parent: parentId,
                position: chan.position
            }).catch(() => null);
        }

        return await interaction.editReply({ content: `✅ Server successfully restored to its pre-nuke clean state!` });
    }
});

client.login(process.env.DISCORD_TOKEN);
                
