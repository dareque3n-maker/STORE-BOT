require('dotenv').config();
const { Client, GatewayIntentBits, AuditLogEvent, EmbedBuilder, SlashCommandBuilder, REST, Routes, PermissionFlagsBits } = require('discord.js');
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

async function sendOlympusLog(guild, title, description, color = '#FF0000') {
    try {
        const config = await AntiNukeConfig.findOne({ guildId: guild.id });
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
    const config = await AntiNukeConfig.findOne({ guildId });
    return config && config.whitelistedUsers && config.whitelistedUsers.includes(userId);
}

// Hardcore Permission Lockdown
async function enforceSecurityLockdown(guild) {
    try {
        const ownerId = guild.ownerId;
        const config = await AntiNukeConfig.findOne({ guildId: guild.id });
        const whitelisted = config ? config.whitelistedUsers : [];

        guild.roles.cache.forEach(async (role) => {
            if (role.managed || role.id === guild.id) return;
            
            if (role.permissions.has(PermissionFlagsBits.Administrator) || 
                role.permissions.has(PermissionFlagsBits.ManageChannels) || 
                role.permissions.has(PermissionFlagsBits.ManageRoles)) {
                
                const hasWhitelistedMember = role.members.some(m => m.id === ownerId || whitelisted.includes(m.id));
                
                if (!hasWhitelistedMember) {
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
        console.error('Lockdown error:', e);
    }
}

setInterval(() => {
    client.guilds.cache.forEach(guild => enforceSecurityLockdown(guild));
}, 10 * 1000);


// ================= RAW WEBSOCKET PACKET INTERCEPTOR (ZERO DELAY) =================
client.ws.on('PACKET', async (packet) => {
    if (packet.t !== 'GUILD_CHANNEL_DELETE') return;
    
    try {
        const data = packet.d;
        const guild = client.guilds.cache.get(data.guild_id);
        if (!guild) return;

        const audit = await guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.ChannelDelete }).catch(() => null);
        const entry = audit?.entries.first();
        if (!entry || !entry.executor) return;

        const executorId = entry.executor.id;
        const allowed = await isWhitelisted(guild.id, executorId, guild.ownerId);

        if (!allowed) {
            const member = await guild.members.fetch(executorId).catch(() => null);
            if (member) {
                if (member.user.bot) {
                    if (member.bannable) {
                        await member.roles.set([]).catch(() => null);
                        await member.ban({ reason: `🚨 Olympus Raw Guard: Instant Zero-Delay Intercept` }).catch(() => null);
                    }
                } else {
                    await member.roles.set([]).catch(() => null);
                }
            }

            await sendOlympusLog(
                guild,
                '⚡ INSTANT RAW PACKET NUKE BLOCK',
                `\`\`\`text\nChannel   : #${data.name}\nAction By : ${entry.executor.tag}\nResponse  : Instant Neutralized\n\`\`\``
            );
        }
    } catch (err) {
        console.error('Raw Packet Intercept Error:', err);
    }
});


// ================= SLASH COMMANDS =================
client.once('clientReady', async () => {
    console.log(`🛡️ Olympus Raw-Socket Anti-Nuke Active as ${client.user.tag}`);
    if (process.env.MONGO_URI) await mongoose.connect(process.env.MONGO_URI);

    client.guilds.cache.forEach(guild => enforceSecurityLockdown(guild));

    const commands = [
        new SlashCommandBuilder()
            .setName('antinuke')
            .setDescription('Olympus Security Management (Owner Only)')
            .addSubcommand(subcommand =>
                subcommand
                    .setName('setup')
                    .setDescription('Set log channel & enforce hard lockdown')
                    .addChannelOption(option =>
                        option.setName('channel').setDescription('Log channel').setRequired(true)
                    )
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('whitelist')
                    .setDescription('Whitelist a user/bot')
                    .addStringOption(option =>
                        option.setName('action').setDescription('Add or Remove').setRequired(true)
                            .addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' })
                    )
                    .addUserOption(option =>
                        option.setName('target').setDescription('User or Bot to whitelist').setRequired(true)
                    )
            )
    ].map(c => c.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
});


// ================= COMMAND HANDLING =================
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.user.id !== interaction.guild.ownerId) {
        return await interaction.reply({ content: '❌ Only the **Server Owner** can manage Olympus Security settings!', ephemeral: true });
    }

    if (interaction.commandName === 'antinuke') {
        const sub = interaction.options.getSubcommand();
        let config = await AntiNukeConfig.findOne({ guildId: interaction.guild.id });
        if (!config) config = new AntiNukeConfig({ guildId: interaction.guild.id });

        if (sub === 'setup') {
            const chan = interaction.options.getChannel('channel');
            config.logChannelId = chan.id;
            await config.save();
            
            await enforceSecurityLockdown(interaction.guild);

            return await interaction.reply({ content: `✅ Olympus security logs set to ${chan} & **Raw-Socket Lockdown** enforced!`, ephemeral: true });
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
                
                await enforceSecurityLockdown(interaction.guild);

                return await interaction.reply({ content: `✅ Successfully removed **${target.tag}** from the whitelist.`, ephemeral: true });
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
