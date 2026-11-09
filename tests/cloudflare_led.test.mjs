// Run with Node.js 24: node --test tests/cloudflare_led.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { ledStatus, ledCommand, setLed, confirmLed } from '../infra/cloudflare/src/led-control.js';

function database() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../infra/cloudflare/led.sql', import.meta.url), 'utf8'));
  function prepare(query, values = []) {
    return {
      bind: (...args) => prepare(query, args),
      first: async () => sql.prepare(query).get(...values) ?? null,
      all: async () => ({ results: sql.prepare(query).all(...values) }),
    };
  }
  return { sql, prepare };
}

test('LED starts off with no claimed hardware confirmation; migration is repeatable', async () => {
  const db = database();
  try {
    assert.deepEqual(await ledCommand(db), { revision: 0, on: 0 });
    const s = await ledStatus(db);
    assert.equal(s.online, false);
    assert.equal(s.applied_on, null);
    assert.equal(s.pending, true);
    await setLed(db, { on: true, revision: 0 });
    db.sql.exec(readFileSync(new URL('../infra/cloudflare/led.sql', import.meta.url), 'utf8'));
    assert.equal((await ledCommand(db)).on, 1);
  } finally { db.sql.close(); }
});

test('explicit desired state persists; old or mismatched acknowledgements never confirm a newer command', async () => {
  const db = database();
  try {
    const on = await setLed(db, { on: true, revision: 0 });
    assert.equal(on.pending, true);
    assert.equal(on.applied_on, null);
    await confirmLed(db, { on: 1, revision: 1 });
    assert.equal((await ledStatus(db)).pending, false);
    const off = await setLed(db, { on: false, revision: 1 });
    await assert.rejects(confirmLed(db, { on: 1, revision: 1 }), { status: 409 });
    await assert.rejects(confirmLed(db, { on: 1, revision: off.revision }), { status: 409 });
    assert.equal((await ledStatus(db)).pending, true);
    await confirmLed(db, { on: 0, revision: off.revision });
    await confirmLed(db, { on: 0, revision: off.revision }); // acknowledgement retry
    assert.equal((await ledStatus(db)).pending, false);
    db.sql.exec('UPDATE led_control SET confirmed_at = 1');
    assert.equal((await ledStatus(db)).online, false);
    assert.equal((await ledStatus(db)).desired_on, false);
  } finally { db.sql.close(); }
});

test('two browsers cannot silently overwrite each other; retry cannot toggle state', async () => {
  const db = database();
  try {
    const results = await Promise.allSettled([
      setLed(db, { on: true, revision: 0 }), setLed(db, { on: false, revision: 0 }),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
    await assert.rejects(setLed(db, { on: true, revision: 0 }), { status: 409 });
    assert.deepEqual(await ledCommand(db), { revision: 1, on: 1 });
  } finally { db.sql.close(); }
});

test('reject malformed controls and confirmations', async () => {
  const db = database();
  try {
    for (const body of [null, {}, { on: 1, revision: 0 }, { on: true, revision: -1 },
      { on: false, revision: 0.5 }, { on: true, revision: 2147483647 }]) {
      await assert.rejects(setLed(db, body), { status: 422 });
    }
    for (const body of [null, {}, { on: true, revision: 0 }, { on: 2, revision: 0 },
      { on: 0, revision: 2147483648 }]) {
      await assert.rejects(confirmLed(db, body), { status: 422 });
    }
  } finally { db.sql.close(); }
});
