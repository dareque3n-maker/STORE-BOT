const { EmbedBuilder } = require('discord.js');

module.exports = async (client, title, description, color = '#FF0000') => {
    try {
        const embed = new EmbedBuilder()
            .setTitle(`🚨 Anti-Nuke Alert: ${title}`)
            .setDescription(description)
            .setColor(color)
            .setTimestamp();

        // 1. Send to Log Channel in Server
        const logChannelId = process.env.LOG_CHANNEL_ID;
        if (logChannelId) {
            const channel = await client.channels.fetch(logChannelId).catch(() => null);
            if (channel) channel.send({ embeds: [embed] });
        }

        // 2. Send to Server Owner DM
        const ownerId = process.env.OWNER_ID;
        if (ownerId) {
            const owner = await client.users.fetch(ownerId).catch(() => null);
            if (owner) owner.send({ embeds: [embed] }).catch(() => {});
        }
    } catch (error) {
        console.error("Error in logger:", error);
    }
};
