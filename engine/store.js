'use strict';
// Tiny JSON store with debounced atomic writes.
const fs = require('fs');
const path = require('path');

class Store {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.timer = null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.data = this._load();
  }

  _load() {
    const base = JSON.parse(JSON.stringify(this.defaults));
    for (const f of [this.file, this.file + '.bak']) {
      try {
        const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
        return deepMerge(base, raw);
      } catch { /* try next */ }
    }
    return base;
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 250);
  }

  flush() {
    clearTimeout(this.timer);
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + '.bak');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[store] write failed', e.message);
    }
  }
}

function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = k in base ? deepMerge(base[k], over[k]) : over[k];
  return out;
}

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

module.exports = { Store, deepMerge };
