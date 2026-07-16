const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, AttachmentBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { GuildStore, OrderTicket } = require('./db');
const { handleSlashCommands } = require('./commands');

const handleInteractions = async (interaction) => {
    const guildId = interaction.guild?.id;
    if (!guildId) return;

    // Route Slash Commands First
    if (interaction.isChatInputCommand()) {
        return await handleSlashCommands(interaction);
    }

    // =================================================================
    // 1. MODAL SUBMISSIONS INTERCEPTOR (ADMIN SETUP)
    // =================================================================
    if (interaction.isModalSubmit()) {
        // --- MODAL: CONFIGURATIONS ---
        if (interaction.customId === 'modal_store_configs') {
            await interaction.deferReply({ ephemeral: true });
            
            const serverName = interaction.fields.getTextInputValue('cfg_name');
            const adminRoleId = interaction.fields.getTextInputValue('cfg_role');
            const logsChannelId = interaction.fields.getTextInputValue('cfg_logs');
            
            // Clean arrays parsing
            const categories = interaction.fields.getTextInputValue('cfg_cats').split(',').map(c => c.trim());
            const itemsRaw = interaction.fields.getTextInputValue('cfg_items').split(',').map(i => i.trim());
            
            const items = itemsRaw.map(str => {
                const parts = str.split('-');
                return {
                    category: categories[0] || 'General', // Default mapping fallback logic
                    name: parts[0]?.trim(),
                    price: parts[1]?.trim() || 'Free',
                    command: '' // Left blank to be routed via execution engine map later
                };
            });

            await GuildStore.findOneAndUpdate(
                { guildId },
                { serverName, adminRoleId, logsChannelId, categories, items },
                { upsert: true, new: true }
            );

            return await interaction.editReply({ content: '✅ **Step 1/3 Complete!** Base store data, roles, logs and items inventory mapped cleanly into database.' });
        }

        // --- MODAL: PANEL VISUAL DEPLOYMENT ---
        if (interaction.customId === 'modal_store_panel') {
            await interaction.deferReply({ ephemeral: true });

            const panelTitle = interaction.fields.getTextInputValue('pnl_title');
            const panelDescription = interaction.fields.getTextInputValue('pnl_desc');
            const panelBanner = interaction.fields.getTextInputValue('pnl_banner');
            const targetChanId = interaction.fields.getTextInputValue('pnl_chan');

            const store = await GuildStore.findOneAndUpdate(
                { guildId },
                { panelTitle, panelDescription, panelBanner },
                { upsert: true, new: true }
            );

            const targetChannel = interaction.guild.channels.cache.get(targetChanId);
            if (!targetChannel) return await interaction.editReply({ content: '❌ Invalid Destination Target Channel ID provided!' });

            // Generate Front Facing Panel UI Layout
            const embed = new EmbedBuilder()
                .setTitle(panelTitle)
                .setDescription(panelDescription)
                .setColor('#5865F2')
                .setTimestamp();

            if (panelBanner && panelBanner.startsWith('http')) {
                embed.setImage(panelBanner);
            }

            // Create First Category Selection Dropdown mapping
            if (!store.categories || store.categories.length === 0) {
                return await interaction.editReply({ content: '❌ Base categories array is empty. Please run `/store configurations` first.' });
            }

            const catOptions = store.categories.map(cat => ({ label: cat, value: `store_cat_${cat}` }));
            const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('store_category_select')
                    .setPlaceholder('🗂️ Choose a Store Category...')
                    .addOptions(catOptions)
            );

            await targetChannel.send({ embeds: [embed], components: [row] });
            return await interaction.editReply({ content: `🚀 **Step 2/3 Complete!** Store panel deployed inside <#${targetChanId}>.` });
        }

        // --- MODAL: EXECUTION ENGINE ROUTING ---
        if (interaction.customId === 'modal_store_execution') {
            await interaction.deferReply({ ephemeral: true });

            const consoleChannelId = interaction.fields.getTextInputValue('exe_console');
            const mappingsRaw = interaction.fields.getTextInputValue('exe_cmds').split('||').map(m => m.trim());

            const store = await GuildStore.findOne({ guildId });
            if (!store) return await interaction.editReply({ content: '❌ No storefront database file registered for this server. Run configs first.' });

            store.consoleChannelId = consoleChannelId;

            // Update item runtime script templates match maps
            mappingsRaw.forEach(mapping => {
                const parts = mapping.split(':');
                const itemName = parts[0]?.trim();
                const itemCmd = parts[1]?.trim();

                const matchedItem = store.items.find(i => i.name.toLowerCase() === itemName.toLowerCase());
                if (matchedItem) {
                    matchedItem.command = itemCmd;
                }
            });

            await store.save();
            return await interaction.editReply({ content: '⚙️ **Step 3/3 Complete!** Game server console routes and command mapping matrices are now active.' });
        }

        // --- MODAL: PLAYER IN-GAME NAME CAPTURE ---
        if (interaction.customId.startsWith('modal_player_checkout_')) {
            await interaction.deferReply({ ephemeral: true });
            const itemUniqueId = interaction.customId.replace('modal_player_checkout_', '');
            const buyerIGN = interaction.fields.getTextInputValue('player_ign');

            const store = await GuildStore.findOne({ guildId });
            const item = store?.items.find(i => i._id.toString() === itemUniqueId);

            if (!item) return await interaction.editReply({ content: '❌ Core system error: Selected asset package expired or deleted.' });

            // Create Secure Isolation Private Room
            const ticketRoom = await interaction.guild.channels.create({
                name: `order-${interaction.user.username}`,
                type: 0, // Guild Text Channel
                permissionOverwrites: [
                    { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                    ...(store.adminRoleId ? [{ id: store.adminRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }] : [])
                ]
            });

            // Store details tracking context into DB active channels pool
            await OrderTicket.create({
                guildId,
                channelId: ticketRoom.id,
                buyerId: interaction.user.id,
                buyerIGN,
                itemName: item.name,
                itemPrice: item.price,
                itemCategory: item.category
            });

            // Post System Operational Board Inside Room
            const embed = new EmbedBuilder()
                .setTitle('📥 NEW INBOUND ORDER METADATA')
                .setDescription(`Verify item payments and execute processing using actions panel dashboard below.`)
                .setColor('#FFCC00')
                .addFields(
                    { name: '👤 Buyer Account', value: `${interaction.user}`, inline: true },
                    { name: '🎮 In-Game Username', value: `\`${buyerIGN}\``, inline: true },
                    { name: '📦 Selected Package', value: `**${item.name}** (${item.category})`, inline: false },
                    { name: '💰 Total Value', value: `\`${item.price}\``, inline: true }
                )
                .setTimestamp();

            const controlRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('btn_order_approve').setLabel('Approve Order').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('btn_order_reject').setLabel('Reject Order').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('btn_order_delete').setLabel('Delete Room').setStyle(ButtonStyle.Secondary)
            );

            await ticketRoom.send({ content: `${interaction.user} | <@&${store.adminRoleId}>`, embeds: [embed], components: [controlRow] });
            return await interaction.editReply({ content: `🎯 Checkout room generated! Complete details inside operational workspace channel: ${ticketRoom}` });
        }
    }

    // =================================================================
    // 2. DROP-DOWN SELECT MENUS MANAGER (DYNAMIC LAYOUT ENGINE)
    // =================================================================
    if (interaction.isStringSelectMenu()) {
        const store = await GuildStore.findOne({ guildId });
        if (!store) return;

        // User picked store category -> Render items dropdown array
        if (interaction.customId === 'store_category_select') {
            const chosenCat = interaction.values[0].replace('store_cat_', '');
            const filteredItems = store.items.filter(i => i.category === chosenCat);

            if (filteredItems.length === 0) {
                return await interaction.reply({ content: '❌ No active items listed under this structural department yet.', ephemeral: true });
            }

            const itemOptions = filteredItems.map(i => ({
                label: `${i.name} - ${i.price}`,
                value: `store_itm_${i._id.toString()}`
            }));

            const rowItems = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('store_item_select')
                    .setPlaceholder('📦 Choose your desired item to buy...')
                    .addOptions(itemOptions)
            );

            // Re-render components chain updates safely
            return await interaction.reply({ content: `📁 Showing results inside structural cluster: **${chosenCat}**`, components: [rowItems], ephemeral: true });
        }

        // User picked exact item -> Show order confirmation trigger button
        if (interaction.customId === 'store_item_select') {
            const itemDbId = interaction.values[0].replace('store_itm_', '');
            const targetItem = store.items.find(i => i._id.toString() === itemDbId);

            const buyRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`btn_trigger_checkout_${itemDbId}`)
                    .setLabel(`Order: ${targetItem.name} (${targetItem.price})`)
                    .setStyle(ButtonStyle.Primary)
            );

            return await interaction.reply({ content: `🛒 Ready to buy **${targetItem.name}**? Click checkout button below to launch terminal.`, components: [buyRow], ephemeral: true });
        }
    }

    // =================================================================
    // 3. ACTIONS PANEL BUTTONS HANDLER (APPROVAL & AUTOMATION ENGINE)
    // =================================================================
    if (interaction.isButton()) {
        const store = await GuildStore.findOne({ guildId });
        
        // Handle initial player checkout modal popup launch mapping
        if (interaction.customId.startsWith('btn_trigger_checkout_')) {
            const itemObjectId = interaction.customId.replace('btn_trigger_checkout_', '');
            
            const playerModal = new ModalBuilder()
                .setCustomId(`modal_player_checkout_${itemObjectId}`)
                .setTitle('Player Verification Terminal');

            playerModal.addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('player_ign')
                        .setLabel('Enter In-Game Name Username (IGN)')
                        .setRequired(true)
                        .setStyle(TextInputStyle.Short)
                )
            );
            return await interaction.showModal(playerModal);
        }

        // Admin Workflow Operations checks inside order tickets channels
        const ticket = await OrderTicket.findOne({ channelId: interaction.channel.id });
        if (!ticket) return;

        // Security check restriction: ensures operational staff permission matches role maps
        if (store.adminRoleId && !interaction.member.roles.cache.has(store.adminRoleId) && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return await interaction.reply({ content: '❌ Unauthorized Access: Operational Staff Clearance Required.', ephemeral: true });
        }

        // --- BUTTON ACTION: APPROVE ORDER ---
        if (interaction.customId === 'btn_order_approve') {
            await interaction.deferReply();
            
            const storeItem = store.items.find(i => i.name.toLowerCase() === ticket.itemName.toLowerCase());
            
            // Console Execution Bridge logic integration
            if (store.consoleChannelId && storeItem && storeItem.command) {
                const consoleChan = interaction.guild.channels.cache.get(store.consoleChannelId);
                if (consoleChan) {
                    // Replaces internal target user placeholder variable templates with exact player dynamic IGN string
                    const functionalCommand = storeItem.command.replace(/{name}/g, ticket.buyerIGN);
                    await consoleChan.send({ content: functionalCommand });
                }
            }

            // Fire Alert Message direct notification downstream path to Buyer
            const buyerUser = await client.users.fetch(ticket.buyerId).catch(() => null);
            if (buyerUser) {
                await buyerUser.send({
                    content: `📦 **Order Dispatch Notice [${store.serverName}]:** Hey! Your digital item purchase request for **${ticket.itemName}** has been verified and successfully approved! Check in-game assets directly. Thank you! 🎉`
                }).catch(() => null);
            }

            await interaction.editReply({ content: `✅ **Order Approved!** Automation scripts fired command payloads successfully. Channel ready to be deleted.` });
            
            // Disable actions buttons elements to freeze runtime duplication threats
            return await interaction.message.edit({ components: [] });
        }

        // --- BUTTON ACTION: REJECT ORDER ---
        if (interaction.customId === 'btn_order_reject') {
            await interaction.deferReply();

            const buyerUser = await client.users.fetch(ticket.buyerId).catch(() => null);
            if (buyerUser) {
                await buyerUser.send({
                    content: `❌ **Order Rejection Notice [${store.serverName}]:** Hello. Your transaction request asset allocation for **${ticket.itemName}** has been declined by administration staff. Contact support server panels if this is an issue.`
                }).catch(() => null);
            }

            await interaction.editReply({ content: `🚫 **Order Rejected.** Buyer user notified. Freezing control deck values.` });
            return await interaction.message.edit({ components: [] });
        }

        // --- BUTTON ACTION: DELETE ROOM & LOG TRANSCRIPTS ---
        if (interaction.customId === 'btn_order_delete') {
            await interaction.reply({ content: '🗑️ Generating secure text logs transcripts... Closing space arrays permanently in 5 seconds.' });

            // Gather structural messages history
            const textBuffer = [];
            const collectedMessages = await interaction.channel.messages.fetch({ limit: 100 });
            
            [...collectedMessages.values()].reverse().forEach(msg => {
                textBuffer.push(`[${msg.createdAt.toLocaleString()}] ${msg.author.tag}: ${msg.content}`);
            });

            const logAttachment = new AttachmentBuilder(Buffer.from(textBuffer.join('\n'), 'utf-8'), { name: `transcript-${interaction.channel.name}.txt` });

            if (store.logsChannelId) {
                const loggingChannel = interaction.guild.channels.cache.get(store.logsChannelId);
                if (loggingChannel) {
                    const trackingEmbed = new EmbedBuilder()
                        .setTitle('📊 ORDER WORKSPACE ARCHIVED LOGS')
                        .setColor('#36393F')
                        .addFields(
                            { name: 'Room Name', value: `\`${interaction.channel.name}\``, inline: true },
                            { name: 'Purchased Pack', value: `${ticket.itemName}`, inline: true },
                            { name: 'IGN', value: `\`${ticket.buyerIGN}\``, inline: true }
                        )
                        .setTimestamp();
                    await loggingChannel.send({ embeds: [trackingEmbed], files: [logAttachment] }).catch(() => null);
                }
            }

            // Cleanup database track files records object entries
            await OrderTicket.deleteOne({ channelId: interaction.channel.id });
            
            // Delete Channel Room permanently
            setTimeout(() => interaction.channel.delete().catch(() => null), 5000);
        }
    }
};

module.exports = { handleInteractions };
