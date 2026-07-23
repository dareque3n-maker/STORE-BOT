const { EmbedBuilder } = require('discord.js');
const AntiNukeConfig = require('../models/AntiNukeConfig');

module.exports = async (client, guild, title, description, color = '#FF0000') => {
    try {
        const embed = new EmbedBuilder()
            .setTitle(`🚨 Anti-Nuke Security Alert: ${title}`)
            .setDescription(description)
            .setColor(color)
            .setTimestamp();

        // 1. Send to Server Log Channel
        const config = await AntiNukeConfig.findOne({ guildId: guild.id });
        if (config && config.logChannelId) {
            const logChannel = await guild.channels.fetch(config.logChannelId).catch(() => null);
            if (logChannel) logChannel.send({ embeds: [embed] });
        }

        // 2. Send to Server Owner DM
        const owner = await guild.fetchOwner().catch(() => null);
        if (owner) {
            owner.send({ embeds: [embed] }).catch(() => {});
        }
    } catch (error) {
        console.error("Error in logger:", error);
    }
};
