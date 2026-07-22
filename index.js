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
        GatewayIntentBits.MessageContent
    ]
});

const actionTrackers = new Map();
const spamTracker = new Map();

// ================= 1. AUTOMATED BACKUP ENGINE (Every 2 Mins) =================
async function takeServerBackup(guild) {
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

        // Categories, Text, aur Voice channels sabka data parent name ke sath save hoga
        const channels = guild.channels.cache.map(c => ({
            name: c.name,
            type: c.type, // 4 = Category, 0 = Text, 2 = Voice
            parentId: c.parent ? c.parent.name : null,
            position: c.position,
            permissionOverwrites: c.permissionOverwrites.cache.map(p => ({
                id: p.id,
                type: p.type,
                allow: p.allow.bitfield.toString(),
                deny: p.deny.bitfield.toString()
            }))
        }));

        const backupData = { roles, channels };
        const backupId = 'bk_' + Date.now();

        let config = await AntiNukeConfig.findOne({ guildId: guild.id });
        if (!config) config = new AntiNukeConfig({ guildId: guild.id });

        config.backups.push({ backupId, timestamp: new Date(), data: backupData });

        // Keep only last 5 backups to avoid clutter/load
        if (config.backups.length > 5) {
            config.backups.shift(); 
        }

        await config.save();
    } catch (e) {
        console.error('Backup error:', e);
    }
}

// Background loop for 2 min backups
setInterval(() => {
    client.guilds.cache.forEach(guild => takeServerBackup(guild));
}, 2 * 60 * 1000);


// ================= 2. NUKE & SPAM PROTECTION CORE =================
async function triggerNukeDefense(guild, executorId, reason) {
    if (executorId === client.user.id || executorId === guild.ownerId) return;

    const config = await AntiNukeConfig.findOne({ guildId: guild.id });
    if (!config || !config.enabled || config.whitelistedUsers.includes(executorId)) return;

    const member = await guild.members.fetch(executorId).catch(() => null);
    if (!member || !member.bannable) return;

    // Neutralize Nuker instantly
    await member.roles.set([]).catch(() => null);
    await member.ban({ reason: `🚨 Anti-Nuke: ${reason}` }).catch(() => null);

    // Get latest backup for recovery
    const latestBackup = config.backups[config.backups.length - 1];
    const recoveryCode = latestBackup ? latestBackup.backupId : 'No Backup Found';

    const embed = new EmbedBuilder()
        .setTitle('🚨 SERVER UNDER ATTACK - NUKER NEUTRALIZED!')
        .setDescription(`\`\`\`text\nNuker   : ${member.user.tag}\nAction  : ${reason}\nStatus  : Banned & Roles Stripped\nRecovery ID : ${recoveryCode}\n\`\`\`\n⚠️ Server Owner can use \`/restore id:${recoveryCode}\` to roll back changes!`)
        .setColor('#FF0000')
        .setTimestamp();

    // Send to Logs Channel
    if (config.logChannelId) {
        const logChan = guild.channels.cache.get(config.logChannelId);
        if (logChan) await logChan.send({ embeds: [embed] }).catch(() => null);
    }

    // Send direct DM to Server Owner
    const owner = await guild.fetchOwner().catch(() => null);
    if (owner) {
        await owner.send({ embeds: [embed] }).catch(() => null);
    }
}


// ================= EVENT LISTENERS =================

// Channel Delete Protection (with small delay for audit logs)
client.on('channelDelete', async (channel) => {
    setTimeout(async () => {
        const audit = await channel.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.ChannelDelete }).catch(() => null);
        const entry = audit?.entries.first();
        if (entry?.executor) await triggerNukeDefense(channel.guild, entry.executor.id, 'Mass Channel Deletion');
    }, 600);
});

// Role Delete Protection
client.on('roleDelete', async (role) => {
    setTimeout(async () => {
        const audit = await role.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.RoleDelete }).catch(() => null);
        const entry = audit?.entries.first();
        if (entry?.executor) await triggerNukeDefense(role.guild, entry.executor.id, 'Role Deletion');
    }, 600);
});

// Chat Spam Detection
client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;
    const now = Date.now();
    const key = `${message.guild.id}_${message.author.id}`;
    const userSpam = spamTracker.get(key) || [];
    
    const valid = userSpam.filter(t => now - t < 5000); // 5 sec window
    valid.push(now);
    spamTracker.set(key, valid);

    if (valid.length >= 6) { // 6 messages in 5 seconds = Spam Nuke
        spamTracker.delete(key);
        await triggerNukeDefense(message.guild, message.author.id, 'Chat Spam Flooding');
    }
});


// ================= SLASH COMMANDS =================
client.once('ready', async () => {
    console.log(`🛡️ Ultimate Anti-Nuke & Backup Bot active as ${client.user.tag}`);
    if (process.env.MONGO_URI) await mongoose.connect(process.env.MONGO_URI);

    const commands = [
        new SlashCommandBuilder().setName('antinuke').setDescription('Anti-nuke config')
            .addSubcommand(s => s.setName('setup').setDescription('Setup log channel').addChannelOption(c => c.setName('channel').setDescription('Logs channel').setRequired(true))),
        
        new SlashCommandBuilder().setName('restore').setDescription('Restore server from backup (Owner Only)')
            .addStringOption(o => o.setName('id').setDescription('Backup ID sent to DM/Logs').setRequired(true))
    ].map(c => c.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // Only Server Owner check for critical commands
    if (interaction.user.id !== interaction.guild.ownerId) {
        return await interaction.reply({ content: '❌ Only the **Server Owner** can use this command!', ephemeral: true });
    }

    if (interaction.commandName === 'antinuke') {
        const chan = interaction.options.getChannel('channel');
        await AntiNukeConfig.findOneAndUpdate({ guildId: interaction.guild.id }, { logChannelId: chan.id }, { upsert: true });
        return await interaction.reply({ content: `✅ Anti-Nuke Log channel set to ${chan}` });
    }

    if (interaction.commandName === 'restore') {
        await interaction.deferReply({ ephemeral: true });
        const backupId = interaction.options.getString('id');
        const config = await AntiNukeConfig.findOne({ guildId: interaction.guild.id });
        
        const targetBackup = config?.backups.find(b => b.backupId === backupId);
        if (!targetBackup) {
            return await interaction.editReply({ content: '❌ Invalid Backup ID or backup expired!' });
        }

        await interaction.editReply({ content: '🔄 Restoring server roles, categories and channels from backup...' });

        // 1. Recreating Roles
        for (const rData of targetBackup.data.roles) {
            await interaction.guild.roles.create({
                name: rData.name,
                color: rData.color,
                permissions: rData.permissions,
                hoist: rData.hoist
            }).catch(() => null);
        }

        // 2. Recreating Categories First (Type 4)
        const categoryMap = new Map();
        for (const cData of targetBackup.data.channels.filter(c => c.type === 4)) {
            const createdCat = await interaction.guild.channels.create({
                name: cData.name,
                type: 4,
                position: cData.position
            }).catch(() => null);
            
            if (createdCat) categoryMap.set(cData.name, createdCat.id);
        }

        // 3. Recreating Text & Voice Channels and linking them to their Categories
        for (const cData of targetBackup.data.channels.filter(c => c.type !== 4)) {
            let parentId = null;
            if (cData.parentId && categoryMap.has(cData.parentId)) {
                parentId = categoryMap.get(cData.parentId);
            }

            await interaction.guild.channels.create({
                name: cData.name,
                type: cData.type,
                parent: parentId,
                position: c.position
            }).catch(() => null);
        }

        return await interaction.followUp({ content: '✅ Server successfully restored with proper categories and channels!' });
    }
});

client.login(process.env.DISCORD_TOKEN);
                
