const { open } = require('lmdb');
const path = require('path');

// Open the database in a persistent directory
const db = open({
  path: path.join(__dirname, 'kascoinjoin-data'),
  compression: true,
  encoding: 'json'
});

module.exports = {
  async put(key, value) {
    await db.put(key, value);
  },
  async get(key) {
    return await db.get(key);
  },
  async remove(key) {
    await db.remove(key);
  },
  getRange() {
    // Returns an iterable of { key, value }
    // LMDB doesn't have a direct getRange, so we use getKeys and get
    const keys = db.getKeys({ start: '', end: '\xff' });
    return Array.from(keys, key => ({ key, value: db.get(key) }));
  }
}; 