const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, AttachmentBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { GuildStore, OrderTicket } = require('./db');

const handleInteractions = async (interaction) => {
    const guildId = interaction.guild?.id;
    if (!guildId) return;

    // =================================================================
    // 1. SLASH COMMANDS HANDLER DIRECT CORE ROUTER
    // =================================================================
    if (interaction.isChatInputCommand()) {
        const { commandName, options } = interaction;
        const subCommand = options.getSubcommand(false);

        if (commandName === 'store') {
            // --- CMD: CONFIGURATIONS POPUP TRIGGER ---
            if (subCommand === 'configurations') {
                const configModal = new ModalBuilder()
                    .setCustomId('modal_store_configs')
                    .setTitle('Step 1: Base Store Configurations');

                configModal.addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('cfg_name').setLabel('Server Store Name').setRequired(true).setStyle(TextInputStyle.Short)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('cfg_role').setLabel('Admin Staff Role ID').setRequired(true).setStyle(TextInputStyle.Short)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('cfg_logs').setLabel('Logs Channel ID').setRequired(true).setStyle(TextInputStyle.Short)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('cfg_items').setLabel('Items (Format: Cat:item-price || Cat2:item-price)').setPlaceholder('e.g., Ranks:frost-100inr, mega-200inr || Keys:mythic-50inr').setRequired(true).setStyle(TextInputStyle.Paragraph)
                    )
                );
                return await interaction.showModal(configModal);
            }

            // --- CMD: PANEL DEPLOY TRIGGER ---
            if (subCommand === 'panel') {
                const panelModal = new ModalBuilder()
                    .setCustomId('modal_store_panel')
                    .setTitle('Step 2: Embed Panel Deployment');

                panelModal.addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('pnl_title').setLabel('Embed Panel Title').setRequired(true).setStyle(TextInputStyle.Short)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('pnl_desc').setLabel('Embed Panel Description').setRequired(true).setStyle(TextInputStyle.Paragraph)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('pnl_banner').setLabel('Embed Banner URL (Optional)').setRequired(false).setStyle(TextInputStyle.Short)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('pnl_chan').setLabel('Destination Channel ID').setRequired(true).setStyle(TextInputStyle.Short)
                    )
                );
                return await interaction.showModal(panelModal);
            }

            // --- CMD: CONSOLE EXECUTION TRIGGER ---
            if (subCommand === 'execution') {
                const execModal = new ModalBuilder()
                    .setCustomId('modal_store_execution')
                    .setTitle('Step 3: Console Commands Mapping');

                execModal.addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('exe_console').setLabel('Game Console Channel ID').setRequired(true).setStyle(TextInputStyle.Short)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('exe_cmds').setLabel('Command Rules (Format: item:cmd || item2:cmd)').setPlaceholder('e.g., frost:give {name} frost 1 || mythic:key give {name} mythic 1').setRequired(true).setStyle(TextInputStyle.Paragraph)
                    )
                );
                return await interaction.showModal(execModal);
            }
        }
    }

    // =================================================================
    // 2. MODAL SUBMISSIONS INTERCEPTOR (DATA PROCESSING)
    // =================================================================
    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'modal_store_configs') {
            await interaction.deferReply({ ephemeral: true });
            
            const serverName = interaction.fields.getTextInputValue('cfg_name');
            const adminRoleId = interaction.fields.getTextInputValue('cfg_role');
            const logsChannelId = interaction.fields.getTextInputValue('cfg_logs');
            const bulkInput = interaction.fields.getTextInputValue('cfg_items');
            
            const categories = [];
            const items = [];

            try {
                const categoryBlocks = bulkInput.split('||');

                categoryBlocks.forEach(block => {
                    const parts = block.split(':');
                    if (parts.length < 2) return;

                    const categoryName = parts[0].trim();
                    const itemsRaw = parts[1].split(',');

                    if (!categories.includes(categoryName) && categoryName) {
                        categories.push(categoryName);
                    }

                    itemsRaw.forEach(itemRaw => {
                        const itemParts = itemRaw.split('-');
                        if (itemParts.length < 2) return;

                        const itemName = itemParts[0].trim();
                        const itemPrice = parseInt(itemParts[1].replace(/[^0-9]/g, ''), 10);

                        if (itemName && !isNaN(itemPrice)) {
                            items.push({
                                category: categoryName,
                                name: itemName,
                                price: itemPrice,
                                command: '' 
                            });
                        }
                    });
                });

                await GuildStore.findOneAndUpdate(
                    { guildId },
                    { serverName, adminRoleId, logsChannelId, categories, items },
                    { upsert: true, new: true }
                );

                return await interaction.editReply({ content: '✅ **Step 1/3 Complete!** Categories and items configurations successfully parse updated into DB.' });

            } catch (parseError) {
                console.error(parseError);
                return await interaction.editReply({ content: '❌ **Parsing Failed!** Form input details strictly check karo.' });
            }
        }

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
            if (!targetChannel) return await interaction.editReply({ content: '❌ Invalid Destination Target Channel ID!' });

            const embed = new EmbedBuilder()
                .setTitle(panelTitle)
                .setDescription(panelDescription)
                .setColor('#5865F2')
                .setTimestamp();

            if (panelBanner && panelBanner.startsWith('http')) {
                embed.setImage(panelBanner);
            }

            if (!store.categories || store.categories.length === 0) {
                return await interaction.editReply({ content: '❌ Categories array empty. Run configurations layout first.' });
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

        if (interaction.customId === 'modal_store_execution') {
            await interaction.deferReply({ ephemeral: true });

            const consoleChannelId = interaction.fields.getTextInputValue('exe_console');
            const mappingsRaw = interaction.fields.getTextInputValue('exe_cmds').split('||').map(m => m.trim());

            const store = await GuildStore.findOne({ guildId });
            if (!store) return await interaction.editReply({ content: '❌ No storefront database file registered.' });

            store.consoleChannelId = consoleChannelId;

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
            return await interaction.editReply({ content: '⚙️ **Step 3/3 Complete!** Game server console routes matrix mapping active.' });
        }

        if (interaction.customId.startsWith('modal_player_checkout_')) {
            await interaction.deferReply({ ephemeral: true });
            const itemUniqueId = interaction.customId.replace('modal_player_checkout_', '');
            const buyerIGN = interaction.fields.getTextInputValue('player_ign');

            const store = await GuildStore.findOne({ guildId });
            const item = store?.items.find(i => i._id.toString() === itemUniqueId);

            if (!item) return await interaction.editReply({ content: '❌ Asset package expired or deleted.' });

            const ticketRoom = await interaction.guild.channels.create({
                name: `order-${interaction.user.username}`,
                type: 0, 
                permissionOverwrites: [
                    { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                    ...(store.adminRoleId ? [{ id: store.adminRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }] : [])
                ]
            });

            await OrderTicket.create({
                guildId,
                channelId: ticketRoom.id,
                buyerId: interaction.user.id,
                buyerIGN,
                itemName: item.name,
                itemPrice: item.price,
                itemCategory: item.category
            });

            const embed = new EmbedBuilder()
                .setTitle('📥 NEW INBOUND ORDER METADATA')
                .setDescription(`Verify item payments and execute processing using actions panel dashboard below.`)
                .setColor('#FFCC00')
                .addFields(
                    { name: '👤 Buyer Account', value: `${interaction.user}`, inline: true },
                    { name: '🎮 In-Game Username', value: `\`${buyerIGN}\``, inline: true },
                    { name: '📦 Selected Package', value: `**${item.name}** (${item.category})`, inline: false },
                    { name: '💰 Total Value', value: `\`${item.price} INR\``, inline: true }
                )
                .setTimestamp();

            const controlRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('btn_order_approve').setLabel('Approve Order').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('btn_order_reject').setLabel('Reject Order').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('btn_order_delete').setLabel('Delete Room').setStyle(ButtonStyle.Secondary)
            );

            await ticketRoom.send({ content: `${interaction.user} | <@&${store.adminRoleId}>`, embeds: [embed], components: [controlRow] });
            return await interaction.editReply({ content: `🎯 Checkout room generated: ${ticketRoom}` });
        }
    }

    // =================================================================
    // 3. DROP-DOWN SELECT MENUS MANAGER
    // =================================================================
    if (interaction.isStringSelectMenu()) {
        const store = await GuildStore.findOne({ guildId });
        if (!store) return;

        if (interaction.customId === 'store_category_select') {
            const chosenCat = interaction.values[0].replace('store_cat_', '');
            const filteredItems = store.items.filter(i => i.category === chosenCat);

            if (filteredItems.length === 0) {
                return await interaction.reply({ content: '❌ No active items listed under this department yet.', ephemeral: true });
            }

            const itemOptions = filteredItems.map(i => ({
                label: `${i.name} - ${i.price} INR`,
                value: `store_itm_${i._id.toString()}`
            }));

            const rowItems = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('store_item_select')
                    .setPlaceholder('📦 Choose your desired item to buy...')
                    .addOptions(itemOptions)
            );

            return await interaction.reply({ content: `📁 Showing results inside cluster: **${chosenCat}**`, components: [rowItems], ephemeral: true });
        }

        if (interaction.customId === 'store_item_select') {
            const itemDbId = interaction.values[0].replace('store_itm_', '');
            const targetItem = store.items.find(i => i._id.toString() === itemDbId);

            const buyRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`btn_trigger_checkout_${itemDbId}`)
                    .setLabel(`Order: ${targetItem.name} (${targetItem.price} INR)`)
                    .setStyle(ButtonStyle.Primary)
            );

            return await interaction.reply({ content: `🛒 Ready to buy **${targetItem.name}**? Click checkout button below to launch terminal.`, components: [buyRow], ephemeral: true });
        }
    }

    // =================================================================
    // 4. ACTIONS PANEL BUTTONS HANDLER (FIXED FOR DELETE ROOM REMAINING)
    // =================================================================
    if (interaction.isButton()) {
        const store = await GuildStore.findOne({ guildId });
        
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

        const ticket = await OrderTicket.findOne({ channelId: interaction.channel.id });
        if (!ticket) return;

        if (store.adminRoleId && !interaction.member.roles.cache.has(store.adminRoleId) && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return await interaction.reply({ content: '❌ Unauthorized Staff Clearance Required.', ephemeral: true });
        }

        if (interaction.customId === 'btn_order_approve') {
            await interaction.deferReply();
            
            const storeItem = store.items.find(i => i.name.toLowerCase() === ticket.itemName.toLowerCase());
            
            if (store.consoleChannelId && storeItem && storeItem.command) {
                const consoleChan = interaction.guild.channels.cache.get(store.consoleChannelId);
                if (consoleChan) {
                    const functionalCommand = storeItem.command.replace(/{name}/g, ticket.buyerIGN);
                    await consoleChan.send({ content: functionalCommand });
                }
            }

            const buyerUser = await interaction.client.users.fetch(ticket.buyerId).catch(() => null);
            if (buyerUser) {
                await buyerUser.send({
                    content: `📦 **Order Dispatch Notice [${store.serverName || 'Store'}]:** Hey! Your digital item purchase request for **${ticket.itemName}** has been verified and successfully approved! 🎉`
                }).catch(() => null);
            }

            await interaction.editReply({ content: `✅ **Order Approved!** Automation scripts fired command payloads.` });
            
            // Kept Delete Room open and active
            const updatedRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('btn_order_delete').setLabel('Delete Room').setStyle(ButtonStyle.Secondary)
            );
            return await interaction.message.edit({ components: [updatedRow] });
        }

        if (interaction.customId === 'btn_order_reject') {
            await interaction.deferReply();

            const buyerUser = await interaction.client.users.fetch(ticket.buyerId).catch(() => null);
            if (buyerUser) {
                await buyerUser.send({
                    content: `❌ **Order Rejection Notice [${store.serverName || 'Store'}]:** Hello. Your transaction request asset allocation for **${ticket.itemName}** has been declined.`
                }).catch(() => null);
            }

            await interaction.editReply({ content: `🚫 **Order Rejected.** Buyer user notified.` });
            
            // Kept Delete Room open and active
            const updatedRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('btn_order_delete').setLabel('Delete Room').setStyle(ButtonStyle.Secondary)
            );
            return await interaction.message.edit({ components: [updatedRow] });
        }

        if (interaction.customId === 'btn_order_delete') {
            await interaction.reply({ content: '🗑️ Generating secure text logs transcripts... Closing channel permanently in 5 seconds.' });

            const textBuffer = [];
            const collectedMessa
