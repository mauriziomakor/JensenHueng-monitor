const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'processed.json');
const MAX_AGE_DAYS = 7;
const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

function loadDB() {
  if (!fs.existsSync(DB_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function isProcessed(id) {
  const db = loadDB();
  if (!db[id]) return false;
  return (Date.now() - db[id]) <= MAX_AGE_MS;
}

function markProcessed(id) {
  const db = loadDB();
  db[id] = Date.now();
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const key in db) {
    if (db[key] < cutoff) delete db[key];
  }
  saveDB(db);
}

function isWithinDays(dateStr, days = 7) {
  if (!dateStr) return false;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return false;
  return date > new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

module.exports = { isProcessed, markProcessed, isWithinDays };
