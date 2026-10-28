require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeStreakState, recordStreakAward, statsFor, weekRange, shiftDate,
} = require('./gameController');
const { pool } = require('../config/db');

/** Synthetic employee key; the streak tables have no employees foreign key, so
 *  the persistence tests can run against the real schema and clean up after. */
const EMPLOYEE = 2100000001;

const streak = (lastCompletedDate, currentStreak, longestStreak = currentStreak) => ({
  lastCompletedDate, currentStreak, longestStreak,
});

/* ------------------------------------------------------------------ pure maths */

test('first successful completion ever starts the streak at 1', () => {
  assert.deepEqual(computeStreakState(null, '2026-01-05'), {
    currentStreak: 1, longestStreak: 1, lastCompletedDate: '2026-01-05',
  });
  assert.deepEqual(computeStreakState(streak(null, 0, 0), '2026-01-05'), {
    currentStreak: 1, longestStreak: 1, lastCompletedDate: '2026-01-05',
  });
});

test('completing more games on the same day never increments the streak', () => {
  const result = computeStreakState(streak('2026-01-05', 3, 4), '2026-01-05');
  assert.equal(result.currentStreak, 3);
  assert.equal(result.longestStreak, 4);
  assert.equal(result.lastCompletedDate, '2026-01-05');
});

test('the next consecutive day increments the streak by one', () => {
  const result = computeStreakState(streak('2026-01-05', 3, 3), '2026-01-06');
  assert.deepEqual(result, { currentStreak: 4, longestStreak: 4, lastCompletedDate: '2026-01-06' });
});

test('consecutive-day maths works across month and year boundaries', () => {
  assert.equal(computeStreakState(streak('2026-01-31', 2), '2026-02-01').currentStreak, 3);
  assert.equal(computeStreakState(streak('2025-12-31', 9), '2026-01-01').currentStreak, 10);
  assert.equal(computeStreakState(streak('2024-02-29', 1), '2024-03-01').currentStreak, 2);
});

test('missing one or more days restarts the active streak at 1', () => {
  const oneDayGap = computeStreakState(streak('2026-01-05', 6, 6), '2026-01-07');
  assert.equal(oneDayGap.currentStreak, 1);
  assert.equal(oneDayGap.longestStreak, 6, 'the longest streak is preserved separately');

  const longGap = computeStreakState(streak('2025-11-30', 6, 6), '2026-01-07');
  assert.equal(longGap.currentStreak, 1);
  assert.equal(longGap.longestStreak, 6);
  assert.equal(longGap.lastCompletedDate, '2026-01-07');
});

test('the longest streak only ever grows', () => {
  const result = computeStreakState(streak('2026-01-06', 10, 4), '2026-01-07');
  assert.equal(result.currentStreak, 11);
  assert.equal(result.longestStreak, 11);
});

test('a day-by-day run produces 1, 2, 3, 4, 5', () => {
  let state = null;
  for (let day = 5; day <= 9; day += 1) {
    state = computeStreakState(state, `2026-01-0${day}`);
    assert.equal(state.currentStreak, day - 4);
  }
  assert.equal(state.longestStreak, 5);
});

/* ---------------------------------------------------------------- week window */

test('weekRange returns the Monday to Sunday window holding the date', () => {
  assert.deepEqual(weekRange('2024-01-03'), { start: '2024-01-01', end: '2024-01-07' });
  assert.deepEqual(weekRange('2024-01-07'), { start: '2024-01-01', end: '2024-01-07' });
  assert.deepEqual(weekRange('2024-01-01'), { start: '2024-01-01', end: '2024-01-07' });
});

test('shiftDate moves calendar days without timezone drift', () => {
  assert.equal(shiftDate('2024-03-01', -1), '2024-02-29');
  assert.equal(shiftDate('2024-12-31', 1), '2025-01-01');
  assert.equal(shiftDate('2026-10-28', 0), '2026-10-28');
});

/* ------------------------------------------------------- database persistence */

async function connect(t) {
  try {
    const client = await pool.connect();
    await client.query('DELETE FROM hcm.daily_game_streaks WHERE employee_id = $1', [EMPLOYEE]);
    await client.query('DELETE FROM hcm.daily_game_streak_awards WHERE employee_id = $1', [EMPLOYEE]);
    return client;
  } catch (err) {
    t.skip(`database unavailable: ${err.message}`);
    return null;
  }
}

async function cleanup(client) {
  try { await client.query('ROLLBACK'); } catch { /* no open transaction */ }
  try {
    await client.query('DELETE FROM hcm.daily_game_streaks WHERE employee_id = $1', [EMPLOYEE]);
    await client.query('DELETE FROM hcm.daily_game_streak_awards WHERE employee_id = $1', [EMPLOYEE]);
  } catch { /* best effort */ } finally { client.release(); }
}

/** Runs a persistence scenario with guaranteed cleanup, even when an assertion fails. */
async function withStreakDb(t, scenario) {
  const client = await connect(t);
  if (!client) return;
  try {
    await scenario(client);
  } finally {
    await cleanup(client);
  }
}

async function readStreak(client) {
  const row = (await client.query(
    'SELECT current_streak, longest_streak, last_completed_date::text AS last FROM hcm.daily_game_streaks WHERE employee_id = $1',
    [EMPLOYEE],
  )).rows[0];
  return row || null;
}

test('duplicate completions on the same day award the streak only once', async (t) => {
  await withStreakDb(t, async (client) => {
    const first = await recordStreakAward(client, EMPLOYEE, '2026-01-05', 100);
    assert.deepEqual(first, { awarded: true, currentStreak: 1 });

    const second = await recordStreakAward(client, EMPLOYEE, '2026-01-05', 90);
    const third = await recordStreakAward(client, EMPLOYEE, '2026-01-05', 80);
    assert.equal(second.awarded, false, 'a second game the same day is not a new streak day');
    assert.equal(third.awarded, false);

    const row = await readStreak(client);
    assert.equal(row.current_streak, 1);
    assert.equal(row.last, '2026-01-05', 'dates round-trip without a timezone shift');
  });
});

test('consecutive days increment once per calendar day and persist', async (t) => {
  await withStreakDb(t, async (client) => {
    await recordStreakAward(client, EMPLOYEE, '2026-01-05', 100);
    await recordStreakAward(client, EMPLOYEE, '2026-01-06', 100);
    const third = await recordStreakAward(client, EMPLOYEE, '2026-01-07', 100);
    assert.deepEqual(third, { awarded: true, currentStreak: 3 });

    const row = await readStreak(client);
    assert.equal(row.current_streak, 3);
    assert.equal(row.longest_streak, 3);
    assert.equal(row.last, '2026-01-07');
  });
});

test('a missed day resets the active streak to 1 but keeps the longest streak', async (t) => {
  await withStreakDb(t, async (client) => {
    for (const date of ['2026-01-05', '2026-01-06', '2026-01-07']) {
      await recordStreakAward(client, EMPLOYEE, date, 100);
    }
    const afterGap = await recordStreakAward(client, EMPLOYEE, '2026-01-12', 100);
    assert.deepEqual(afterGap, { awarded: true, currentStreak: 1 });

    const row = await readStreak(client);
    assert.equal(row.current_streak, 1, 'the previous streak does not continue');
    assert.equal(row.longest_streak, 3, 'the longest streak is stored separately');
  });
});

test('statsFor reports the active streak, weekly history and survives a re-read', async (t) => {
  await withStreakDb(t, async (client) => {
    for (const date of ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-10']) {
      await recordStreakAward(client, EMPLOYEE, date, 100);
    }

    const today = '2026-01-10'; // Saturday
    const first = await statsFor(client, EMPLOYEE, today);
    assert.equal(first.currentStreak, 1, 'gap of three days restarted the streak on the 10th');
    assert.equal(first.longestStreak, 3);
    assert.equal(first.lastCompletedDate, today);

    const week = first.week;
    assert.equal(week.length, 7, 'the week always covers Monday to Sunday');
    assert.deepEqual(week.map((day) => day.date), [
      '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-10', '2026-01-11',
    ]);
    assert.deepEqual(week.map((day) => day.completed), [true, true, true, false, false, true, false]);
    assert.deepEqual(week.filter((day) => day.isToday).map((day) => day.date), [today]);

    // A later read (fresh connection state, as after a refresh/re-login) matches.
    const reread = await statsFor(client, EMPLOYEE, today);
    assert.deepEqual(reread.week, week);
    assert.equal(reread.currentStreak, first.currentStreak);

    // After the day passes without a completion the active streak reads 0.
    const later = await statsFor(client, EMPLOYEE, '2026-01-13');
    assert.equal(later.currentStreak, 0, 'an expired streak is no longer displayed');
    assert.equal(later.longestStreak, 3, 'the longest streak survives the expiry');
  });
});
