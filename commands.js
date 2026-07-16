const { SlashCommandBuilder, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');

// 1. Definition for application Slash Commands blueprint structure
const registerSlashCommands = () => {
    const storeCommand = new SlashCommandBuilder()
        .setName('store')
        .setDescription('Manage and configure your server global public storefront.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) // Admin access rule protection
        .addSubcommand(sub =>
            sub.setName('configurations')
                .setDescription('Setup server variables, management roles, logs, inventory categories and listings.')
        )
        .addSubcommand(sub =>
            sub.setName('panel')
                .setDescription('Design your storefront interactive panel layouts and push deployment.')
        )
        .addSubcommand(sub =>
            sub.setName('execution')
                .setDescription('Route network bridges, setup game server console channel maps and asset links.')
        );

    return [storeCommand.toJSON()];
};

// 2. Main Execution Router for Slash Commands Inputs to trigger Modals
const handleSlashCommands = async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'store') return;

    const subcommand = interaction.options.getSubcommand();

    // ================= SUBCOMMAND: CONFIGURATIONS =================
    if (subcommand === 'configurations') {
        const modal = new ModalBuilder()
            .setCustomId('modal_store_configs')
            .setTitle('1/3 Store Configurations');

        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cfg_name').setLabel('Server Name (For DMs Alert Context)').setRequired(true).setStyle(TextInputStyle.Short).setPlaceholder('e.g., SparkleMc')),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cfg_role').setLabel('Admin Role ID (To manage ticket rooms)').setRequired(true).setStyle(TextInputStyle.Short)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cfg_logs').setLabel('Logs Channel ID').setRequired(true).setStyle(TextInputStyle.Short)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cfg_cats').setLabel('Store Categories (Comma separated lists)').setRequired(true).setStyle(TextInputStyle.Paragraph).setPlaceholder('e.g., Ranks, Crate Keys, Kits')),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cfg_items').setLabel('Items & Prices (Name-Price, split by comma)').setRequired(true).setStyle(TextInputStyle.Paragraph).setPlaceholder('Elite-100INR, Mega-200INR, Shine Key-50INR'))
        );

        return await interaction.showModal(modal);
    }

    // ================= SUBCOMMAND: PANEL =================
    if (subcommand === 'panel') {
        const modal = new ModalBuilder()
            .setCustomId('modal_store_panel')
            .setTitle('2/3 Store Visual Deploys');

        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('pnl_title').setLabel('Embed Title Header text').setRequired(true).setStyle(TextInputStyle.Short).setValue('🛒 SERVER STOREFRONT')),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('pnl_desc').setLabel('Embed Description Markdown copy').setRequired(true).setStyle(TextInputStyle.Paragraph).setValue('Select a category from the selection menus below to view active stock listings.')),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('pnl_banner').setLabel('Banner Image Graphic Content CDN link').setRequired(false).setStyle(TextInputStyle.Short)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('pnl_chan').setLabel('Target Destination Deployment Channel ID').setRequired(true).setStyle(TextInputStyle.Short))
        );

        return await interaction.showModal(modal);
    }

    // ================= SUBCOMMAND: EXECUTION =================
    if (subcommand === 'execution') {
        const modal = new ModalBuilder()
            .setCustomId('modal_store_execution')
            .setTitle('3/3 Backend Engine Routing');

        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('exe_console').setLabel('Game Server Console Channel Target ID').setRequired(true).setStyle(TextInputStyle.Short)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('exe_cmds').setLabel('Item Commands Mapping (Item:cmd || Item:cmd)').setRequired(true).setStyle(TextInputStyle.Paragraph).setPlaceholder('Elite:lp user {name} parent set elite || Shine Key:givekey {name} shine 1'))
        );

        return await interaction.showModal(modal);
    }
};

module.exports = { registerSlashCommands, handleSlashCommands };
