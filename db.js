const mongoose = require('mongoose');

// Connect to MongoDB
const connectDB = async (uri) => {
    try {
        await mongoose.connect(uri);
        console.log('✅ MongoDB connected successfully!');
    } catch (err) {
        console.error('❌ MongoDB connection error:', err);
        process.exit(1);
    }
};

// 1. Schema for Server Store Configuration
const GuildStoreSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    serverName: { type: String, default: 'My Server' },
    adminRoleId: { type: String, default: '' },
    logsChannelId: { type: String, default: '' },
    consoleChannelId: { type: String, default: '' },
    
    // Panel Customization Layout
    panelTitle: { type: String, default: '🛒 Server Store' },
    panelDescription: { type: String, default: 'Select a category below to view items.' },
    panelBanner: { type: String, default: '' },
    
    // Inventory and Arrays
    categories: [String], 
    items: [{
        category: String,
        name: String,
        price: String,
        command: String
    }]
});

// 2. Schema for Active Orders Tracking
const OrderTicketSchema = new mongoose.Schema({
    guildId: { type: String, required: true },
    channelId: { type: String, required: true, unique: true },
    buyerId: { type: String, required: true },
    buyerIGN: { type: String, required: true },
    itemName: { type: String, required: true },
    itemPrice: { type: String, required: true },
    itemCategory: { type: String, required: true }
});

const GuildStore = mongoose.model('GuildStore', GuildStoreSchema);
const OrderTicket = mongoose.model('OrderTicket', OrderTicketSchema);

module.exports = { connectDB, GuildStore, OrderTicket };
