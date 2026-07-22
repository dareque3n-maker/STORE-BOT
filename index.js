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

const instantDeleteTracker = new Map();

// ================= ROLLING BACKUP ENGINE =================
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
        const backupId = 'emg_' + Date.now(); // Unique Emergency ID

        let config = await AntiNukeConfig.findOne({ guildId: guild.id });
        if (!config) config = new AntiNukeConfig({ guildId: guild.id });

        if (!config.backups) config.backups = [];
        config.backups.push({ backupId, timestamp: new Date(), data: backupData });

        // Keep last 10 backups safe so they never expire instantly
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

// Every 30 seconds regular rolling backup
setInterval(() => {
    client.guilds.cache.forEach(guild => takeRollingBackup(guild));
}, 30 * 1000);


// ================= ULTRA-FAST INSTANT NUKE DEFENSE =================
client.on('channelDelete', async (channel) => {
    try {
        const guildId = channel.guild.id;
        const now = Date.now();
        
        const audit = await channel.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.ChannelDelete }).catch(() => null);
        const entry = audit?.entries.first();
        
        if (!entry || !entry.executor) return;
        const executorId = entry.executor.id;

        if (executorId === client.user.id || executorId === channel.guild.ownerId) return;

        const config = await AntiNukeConfig.findOne({ guildId: guildId });
        if (!config || !config.enabled || config.whitelistedUsers.includes(executorId)) return;

        const key = `${guildId}_${executorId}`;
        const userDeletions = instantDeleteTracker.get(key) || [];
        const validDeletions = userDeletions.filter(t => now - t < 10000); 
        validDeletions.push(now);
        instantDeleteTracker.set(key, validDeletions);

        if (validDeletions.length >= 2) {
            instantDeleteTracker.delete(key);
            
            const member = await channel.guild.members.fetch(executorId).catch(() => null);
            if (member && member.bannable) {
                await member.roles.set([]).catch(() => null);
                await member.ban({ reason: `🚨 Anti-Nuke: Mass Channel Deletion Speed Trigger` }).catch(() => null);
            }

            // Nuke detect hote hi turant ek fresh permanent emergency backup lo!
            const emergencyId = await takeRollingBackup(channel.guild);

            const embed = new EmbedBuilder()
                .setTitle('🚨 LIGHTNING FAST ANTI-NUKE TRIGGERED!')
                .setDescription('```text\nNuker   : ' + entry.executor.tag + '\nAction  : Mass Channel Deletion\nStatus  : Banned & Neutralized\n```\n**👇 Copy & Paste this restore command:**\n``' + `/restore id:${emergencyId}` + '``')
                .setColor('#FF0000')
                .setTimestamp();

            if (config.logChannelId) {
                const logChan = channel.guild.channels.cache.get(config.logChannelId);
                if (logChan) await logChan.send({ embeds: [embed] }).catch(() => null);
            }

            const owner = await channel.guild.fetchOwner().catch(() => null);
            if (owner) {
                await owner.send({ embeds: [embed] }).catch(() => null);
            }
        }
    } catch (err) {
        console.error('Instant Defense Error (Channel):', err);
    }
});


// ================= SLASH COMMANDS =================
client.once('ready', async () => {
    console.log(`🛡️ Anti-Nuke Bot Active as ${client.user.tag}`);
    if (process.env.MONGO_URI) await mongoose.connect(process.env.MONGO_URI);

    client.guilds.cache.forEach(guild => takeRollingBackup(guild));

    const commands = [
        new SlashCommandBuilder().setName('antinuke').setDescription('Setup Anti-Nuke config')
            .addSubcommand(s => s.setName('setup').setDescription('Setup log channel').addChannelOption(c => c.setName('channel').setDescription('Logs channel').setRequired(true))),
        
        new SlashCommandBuilder().setName('restore').setDescription('Restore server state from pre-nuke backup (Owner Only)')
            .addStringOption(o => o.setName('id').setDescription('Backup ID').setRequired(true))
    ].map(c => c.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
});


// ================= COMMAND HANDLING =================
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.user.id !== interaction.guild.ownerId) {
        return await interaction.reply({ content: '❌ Only the **Server Owner** can use this command!', ephemeral: true });
    }

    if (interaction.commandName === 'antinuke') {
        const chan = interaction.options.getChannel('channel');
        await AntiNukeConfig.findOneAndUpdate({ guildId: interaction.guild.id }, { logChannelId: chan.id }, { upsert: true });
        return await interaction.reply({ content: `✅ Anti-Nuke Log channel successfully set to ${chan}` });
    }

    if (interaction.commandName === 'restore') {
        await interaction.deferReply({ ephemeral: true });
        const backupId = interaction.options.getString('id');
        const config = await AntiNukeConfig.findOne({ guildId: interaction.guild.id });
        
        const targetBackup = config?.backups?.find(b => b.backupId === backupId);
        if (!targetBackup) {
            return await interaction.editReply({ content: '❌ Invalid Backup ID! Make sure you copied the latest ID.' });
        }

        await interaction.editReply({ content: `🔄 Restoring server structure from snapshot...` });

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
                      
