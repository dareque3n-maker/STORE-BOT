const mongoose = require('mongoose');

const backupSnapshotSchema = new mongoose.Schema({
    guildId: { type: String, required: true },
    restoreId: { type: String, required: true, unique: true },
    timestamp: { type: Date, default: Date.now },
    categories: Array,
    channels: Array
});

module.exports = mongoose.model('BackupSnapshot', backupSnapshotSchema);
