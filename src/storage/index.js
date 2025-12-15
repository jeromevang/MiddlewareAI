/**
 * Storage Module
 * Re-exports storage functionality (FAISS and SQLite)
 */

const { FAISSIndexManager } = require('../faiss_storage.js');
const { SQLiteCacheManager } = require('../sqlite_cache.js');

module.exports = {
    FAISSIndexManager,
    SQLiteCacheManager
};
