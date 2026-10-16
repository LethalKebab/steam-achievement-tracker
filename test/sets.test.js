/**
 * Achievement sets: reading Steam's two replies, deciding what a player is shown, and what a game adds
 * to the completed count
 * ------------------------------------------------
 * Run with: node --test
 *
 * Steam calls them `groups`. A game's reply to `GetGameAchievements` lists every group with the
 * name, size and DLC app it belongs to; the account's reply to `GetUserAchievements` lists the
 * groups **this account can earn**, with how far along each one is. `lib/sets.js` is the pure half
 * of the feature — no network, no database — so everything that can go wrong in reading a reply or
 * in choosing what to draw or count is checked here.
 *
 * The fixtures are trimmed copies of real replies (Crusader Kings III, DREDGE and Left 4 Dead 2),
 * not shapes made up to suit the code: a reply with every optional field present would pass a
 * parser that cannot cope with one that leaves them out.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseGameSets, parseUserSets, buildSetRows, displaySets, completedUnits, groupSetsByGame, groupMissing,
} from '../lib/sets.js';

const group = (id, name, extra = {}) => ({
  groupid: id, localized_name: name, dlcappid: 0, order: 0, archived: false, developeronly: false,
  ispublic: true, total_achievements: 10, completion_achievements: 10, ...extra,
});
const reply = (groups) => ({ response: { achievements: [], schema_version: 32, groups } });

// ---------------------------------------------------------------------------
// GetGameAchievements
// ---------------------------------------------------------------------------

describe('parseGameSets', () => {
  test('reads a set: its id, name, size, DLC app and the flags that decide whether it is shown', () => {
    const { sets } = parseGameSets(reply([
      group(0, '', { total_achievements: 56, completion_achievements: 56 }),
      group(2, 'Royal Court', { dlcappid: 1303182, total_achievements: 20, completion_achievements: 19, order: 3, archived: true }),
    ]));
    assert.deepEqual(sets[0], {
      id: 0, name: '', dlcAppid: null, position: 0, total: 56, need: 56, archived: false, visible: true,
    });
    assert.deepEqual(sets[1], {
      id: 2, name: 'Royal Court', dlcAppid: '1303182', position: 3, total: 20, need: 19, archived: true, visible: true,
    });
  });

  test('a DLC app of 0 is "not a DLC set", and a real one is kept as a string like every other appid here', () => {
    const { sets } = parseGameSets(reply([group(1, 'Infected', { dlcappid: 0 }), group(2, 'Pack', { dlcappid: 2561440 })]));
    assert.equal(sets[0].dlcAppid, null);
    assert.equal(sets[1].dlcAppid, '2561440');
  });

  test('a game with no sets is one group, id 0, holding everything — which is a reply, not an error', () => {
    const parsed = parseGameSets(reply([group(0, '', { total_achievements: 101, completion_achievements: 101 })]));
    assert.equal(parsed.sets.length, 1);
    assert.equal(parsed.sets[0].id, 0);
  });

  test('a set the developer keeps to itself, or marks public: false, is read as not visible', () => {
    const { sets } = parseGameSets(reply([
      group(1, 'Playtest', { developeronly: true }),
      group(2, 'Draft', { ispublic: false }),
      group(3, 'Open'),
    ]));
    assert.deepEqual(sets.map((s) => s.visible), [false, false, true]);
  });

  test('a flag the reply leaves out is not read as a reason to hide the set', () => {
    // Steam's JSON drops fields it considers default. Hiding on absence would remove a legitimate set
    // from a reply that merely omitted `ispublic`; hiding is for an explicit statement
    const bare = { groupid: 4, localized_name: 'Survival', total_achievements: 9, completion_achievements: 9 };
    assert.equal(parseGameSets(reply([bare])).sets[0].visible, true);
  });

  test('a missing completion count falls back to the set size, and missing sizes to 0', () => {
    const { sets } = parseGameSets(reply([
      { groupid: 1, localized_name: 'A', total_achievements: 12 },
      { groupid: 2, localized_name: 'B' },
    ]));
    assert.equal(sets[0].need, 12, 'with nothing archived, what completes a set is the whole set');
    assert.equal(sets[1].total, 0);
    assert.equal(sets[1].need, 0);
  });

  test('an entry that is not a set is skipped and the rest are kept', () => {
    const { sets } = parseGameSets(reply([
      null, 'x', {}, { groupid: 'two' }, { groupid: -1 }, { groupid: 1.5 }, group(7, 'Kept'),
    ]));
    assert.deepEqual(sets.map((s) => s.id), [7]);
  });

  test('a group id repeated in one reply keeps its first entry', () => {
    const { sets } = parseGameSets(reply([group(1, 'First'), group(1, 'Second'), group(2, 'Other')]));
    assert.deepEqual(sets.map((s) => [s.id, s.name]), [[1, 'First'], [2, 'Other']],
      'the id is a primary key, and a second row for it would fail the whole write');
  });

  test('a number past what Steam sends is not a set or a count, so it never reaches the database', () => {
    // node:sqlite stores 2^53 and over without complaint and throws when the row is read back, and
    // the Dashboard reads every set in one query: one such value would stop the page loading
    const big = 2 ** 53;
    const { sets } = parseGameSets(reply([
      group(big, 'Huge id'),
      group(1, 'Huge counts', { total_achievements: big, completion_achievements: 2 ** 60, order: 2 ** 40, dlcappid: 2 ** 40 }),
      group(2, 'Past 32 bits', { total_achievements: 0x100000000 }),
    ]));
    assert.deepEqual(sets.map((s) => s.id), [1, 2]);
    assert.deepEqual([sets[0].total, sets[0].need, sets[0].position, sets[0].dlcAppid], [0, 0, 0, null]);
    assert.equal(sets[1].total, 0);
  });

  test('a reply cannot carry more sets than the guard allows, or a name longer than it', () => {
    const many = Array.from({ length: 500 }, (_, i) => group(i, 'S' + i));
    assert.ok(parseGameSets(reply(many)).sets.length <= 200, 'one broken reply would bloat every Dashboard load');
    assert.equal(parseGameSets(reply([group(1, 'x'.repeat(5000))])).sets[0].name.length, 200);
  });

  test('an unusable reply is null, so the caller can tell it from "this game has no sets"', () => {
    assert.equal(parseGameSets(null), null);
    assert.equal(parseGameSets(undefined), null);
    assert.equal(parseGameSets({}), null, 'no response object at all');
    assert.equal(parseGameSets({ response: 'nope' }), null);
    assert.equal(parseGameSets({ response: { groups: 'nope' } }), null, 'groups present but not a list');
    assert.equal(parseGameSets({ response: { groups: {} } }), null);
  });

  test('a reply that names no set is an empty list rather than null; what that means is for the caller to decide', () => {
    assert.deepEqual(parseGameSets({ response: {} }), { sets: [], members: new Map() });
    assert.deepEqual(parseGameSets(reply([])), { sets: [], members: new Map() });
  });
});

// ---------------------------------------------------------------------------
// GetUserAchievements
// ---------------------------------------------------------------------------

describe('parseUserSets', () => {
  const userReply = (groups) => ({ response: { achievements: [], groups } });

  test('keys the account\'s progress by set id', () => {
    const m = parseUserSets(userReply([
      { groupid: 0, is_achievable: true, completed_achievements: 46, is_completed: false, time_completed: 0 },
      { groupid: 2, is_achievable: true, completed_achievements: 20, is_completed: true, time_completed: 1700000000 },
    ]));
    assert.deepEqual(m.get(0), { achievable: true, done: 46, completed: false, completedAt: null });
    assert.deepEqual(m.get(2), { achievable: true, done: 20, completed: true, completedAt: 1700000000 });
  });

  test('a time of 0, or none, is "not completed yet" and never a date in 1970', () => {
    const m = parseUserSets(userReply([
      { groupid: 1, is_achievable: true, time_completed: 0 },
      { groupid: 2, is_achievable: true },
    ]));
    assert.equal(m.get(1).completedAt, null);
    assert.equal(m.get(2).completedAt, null);
  });

  test('a flag the reply leaves out reads as false, and a missing count as 0', () => {
    const m = parseUserSets(userReply([{ groupid: 5 }]));
    assert.deepEqual(m.get(5), { achievable: false, done: 0, completed: false, completedAt: null });
  });

  test('an entry that is not a set is skipped', () => {
    const m = parseUserSets(userReply([null, { groupid: 'x' }, { groupid: 3, is_achievable: true }]));
    assert.deepEqual([...m.keys()], [3]);
  });

  test('a repeated id keeps its first entry, and a count or a time past what Steam sends is not one', () => {
    const m = parseUserSets(userReply([
      { groupid: 1, is_achievable: true, completed_achievements: 3 },
      { groupid: 1, is_achievable: false, completed_achievements: 9 },
      { groupid: 2, is_achievable: true, completed_achievements: 2 ** 60, time_completed: 2 ** 55 },
    ]));
    assert.deepEqual([m.get(1).achievable, m.get(1).done], [true, 3]);
    assert.deepEqual([m.get(2).done, m.get(2).completedAt], [0, null]);
  });

  test('a reply without a list of groups is null — not an account that can earn nothing', () => {
    // Reading that as an empty map would write "cannot earn any of these" over every set of the game
    assert.equal(parseUserSets(null), null);
    assert.equal(parseUserSets({}), null);
    assert.equal(parseUserSets({ response: {} }), null);
    assert.equal(parseUserSets({ response: { groups: 'nope' } }), null);
  });

  test('a list that is present and empty is an answer', () => {
    assert.equal(parseUserSets(userReply([])).size, 0);
  });
});

// ---------------------------------------------------------------------------
// Assembling the rows that get stored
// ---------------------------------------------------------------------------

describe('buildSetRows', () => {
  const en = parseGameSets(reply([
    group(0, '', { total_achievements: 40, completion_achievements: 40 }),
    group(1, 'The Pale Reach', { dlcappid: 2561440, total_achievements: 8, completion_achievements: 8 }),
    group(2, 'The Iron Rig', { dlcappid: 2561450, total_achievements: 12, completion_achievements: 12 }),
  ])).sets;
  const cn = parseGameSets(reply([group(0, ''), group(1, '皓寒之渚'), group(2, '钢铁钻井')])).sets;
  const progress = parseUserSets({ response: { groups: [
    { groupid: 0, is_achievable: true, completed_achievements: 40, is_completed: true, time_completed: 1700000000 },
    { groupid: 1, is_achievable: true, completed_achievements: 3, is_completed: false },
  ] } });

  test('one row per set, carrying both names, the structure and this account\'s progress', () => {
    const rows = buildSetRows({ en, cn, progress });
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[1], {
      setId: 1, nameEn: 'The Pale Reach', nameCn: '皓寒之渚', dlcAppid: '2561440', position: 0,
      total: 8, need: 8, archived: false, visible: true,
      achievable: true, done: 3, completed: false, completedAt: null,
    });
    assert.equal(rows[0].completedAt, 1700000000);
  });

  test('a set missing from the account\'s answer is one it cannot earn — not "unknown", and not zero progress', () => {
    const rows = buildSetRows({ en, cn, progress });
    assert.deepEqual(
      [rows[2].achievable, rows[2].done, rows[2].completed, rows[2].completedAt],
      [false, 0, false, null],
      'a DLC the account does not own is absent from the reply, and that absence is the fact being recorded'
    );
  });

  test('the structure comes from the English reply; the Chinese one only supplies names', () => {
    const rows = buildSetRows({ en, cn: [...cn, parseGameSets(reply([group(9, '只在中文里')])).sets[0]], progress });
    assert.deepEqual(rows.map((r) => r.setId), [0, 1, 2], 'a set only the other reply names is not invented');
  });

  test('a set the Chinese reply lacks is stored with an empty Chinese name', () => {
    const rows = buildSetRows({ en, cn: cn.slice(0, 2), progress });
    assert.equal(rows[2].nameCn, '');
    assert.equal(rows[2].nameEn, 'The Iron Rig');
  });
});

// ---------------------------------------------------------------------------
// What a player is shown
// ---------------------------------------------------------------------------

describe('displaySets', () => {
  /** A stored row, as the table returns it */
  const row = (id, extra = {}) => ({
    set_id: id, name_en: '', name_cn: '', dlc_appid: null, position: 0, total: 10, need: 10,
    archived: 0, visible: 1, achievable: 1, done: 0, completed: 0, completed_at: null, ...extra,
  });

  test('a game with fewer than two sets to show has none to show', () => {
    assert.equal(displaySets([], 'en'), null);
    assert.equal(displaySets(undefined, 'en'), null);
    assert.equal(displaySets([row(0)], 'en'), null, 'one set is the whole game, and the row already says that');
    assert.equal(displaySets([row(0), row(1, { total: 0, need: 0 })], 'en'), null, 'the second is empty');
  });

  test('the order is the developer\'s position and then the id, which is Steam\'s own and puts the base game first', () => {
    const shown = displaySets([
      row(3, { name_en: 'Survival', position: 3 }),
      row(4, { name_en: 'General', position: 0 }),
      row(1, { name_en: 'Infected', position: 1 }),
      row(0, { total: 5, need: 5 }),
    ], 'en');
    assert.deepEqual(shown.map((s) => s.id), [0, 4, 1, 3]);
    assert.equal(shown[0].base, true);
    assert.equal(shown[1].base, false);
  });

  test('equal positions fall back to the id, whatever order the rows arrive in', () => {
    const shown = displaySets([row(2, { position: 1 }), row(1, { position: 1 }), row(3, { position: 1 })], 'en');
    assert.deepEqual(shown.map((s) => s.id), [1, 2, 3]);
  });

  test('a developer who moves the base game gets it where they put it, as on Steam\'s page', () => {
    const shown = displaySets([row(0, { position: 5 }), row(1, { position: 0, name_en: 'Mode' })], 'en');
    assert.deepEqual(shown.map((s) => s.id), [1, 0]);
  });

  test('a set the base game left empty is not drawn (Left 4 Dead 2 puts everything in four others)', () => {
    const shown = displaySets([
      row(0, { total: 0, need: 0 }),
      row(1, { name_en: 'Infected', position: 1, total: 15, need: 15 }),
      row(2, { name_en: 'Versus', position: 2, total: 4, need: 4 }),
      row(3, { name_en: 'Survival', position: 3, total: 9, need: 9 }),
      row(4, { name_en: 'General', position: 0, total: 73, need: 73 }),
    ], 'en');
    assert.deepEqual(shown.map((s) => s.name), ['General', 'Infected', 'Versus', 'Survival']);
    assert.equal(shown.some((s) => s.base), false);
  });

  test('the name follows the interface language and falls back to the other when one is empty', () => {
    const rows = [row(0), row(1, { name_en: 'The Pale Reach', name_cn: '皓寒之渚' }), row(2, { name_en: 'Royal Court', name_cn: '' })];
    assert.deepEqual(displaySets(rows, 'zh').map((s) => s.name), ['', '皓寒之渚', 'Royal Court']);
    assert.deepEqual(displaySets(rows, 'en').map((s) => s.name), ['', 'The Pale Reach', 'Royal Court']);
    const onlyCn = [row(0), row(1, { name_en: '', name_cn: '只有中文' })];
    assert.equal(displaySets(onlyCn, 'en')[1].name, '只有中文');
  });

  test('sets the player cannot see are not shown: developer-only ones, and archived ones nobody there has touched', () => {
    const shown = displaySets([
      row(0),
      row(1, { name_en: 'Playtest', visible: 0 }),
      row(2, { name_en: 'Old season', archived: 1, done: 0 }),
      row(3, { name_en: 'Old season I played', archived: 1, done: 4 }),
    ], 'en');
    assert.deepEqual(shown.map((s) => s.id), [0, 3]);
  });

  test('a DLC set is marked, and one the account does not own is not earnable and shows no progress', () => {
    const shown = displaySets([
      row(0, { done: 5 }),
      row(1, { name_en: 'Owned DLC', dlc_appid: '111', done: 2 }),
      row(2, { name_en: 'Unowned DLC', dlc_appid: '222', achievable: 0, done: 7 }),
    ], 'en');
    assert.equal(shown[1].dlc, true);
    assert.equal(shown[1].earnable, true);
    assert.equal(shown[0].dlc, false);
    assert.equal(shown[2].earnable, false);
    assert.equal(shown[2].done, 0, 'whatever a stale row says, an unearnable set has no progress to draw');
  });

  test('a set is complete when Steam says so, not when the arithmetic does', () => {
    // Steam keeps a completed set completed after the developer adds to it, so 9 of 10 can be complete
    const shown = displaySets([
      row(0, { done: 40, need: 40, completed: 0 }),
      row(1, { name_en: 'Grown', done: 9, need: 10, completed: 1, completed_at: 1710000000 }),
    ], 'en');
    assert.equal(shown[0].complete, false);
    assert.equal(shown[1].complete, true);
    assert.equal(shown[1].completedAt, 1710000000 * 1000, 'epoch milliseconds, ready for a Date');
    assert.equal(shown[0].completedAt, null);
  });

  test('a column holding something that is not a number is drawn as one, since the page writes it into markup', () => {
    const shown = displaySets([row(0, { done: '<b>', need: 'x', completed_at: 'y' }), row(1, { name_en: 'X' })], 'en');
    assert.deepEqual([shown[0].done, shown[0].need, shown[0].completedAt], [0, 0, null]);
  });

  test('what is drawn per set is exactly these nine fields, so the page and the server agree on the shape', () => {
    const [s] = displaySets([row(0, { done: 3, need: 10 }), row(1, { name_en: 'X' })], 'en');
    assert.deepEqual(Object.keys(s).sort(), ['base', 'complete', 'completedAt', 'dlc', 'done', 'earnable', 'id', 'name', 'need'].sort());
    assert.equal(s.done, 3);
    assert.equal(s.need, 10);
  });
});

// ---------------------------------------------------------------------------
// What a game adds to the completed count
// ---------------------------------------------------------------------------

describe('completedUnits', () => {
  /** A stored row, as the table returns it */
  const row = (id, extra = {}) => ({
    set_id: id, name_en: '', name_cn: '', dlc_appid: null, position: 0, total: 10, need: 10,
    archived: 0, visible: 1, achievable: 1, done: 0, completed: 0, completed_at: null, ...extra,
  });
  const game = (achieved, total) => ({ achieved, total });

  test('a game without sets is one unit when everything in it is unlocked, and none otherwise', () => {
    assert.equal(completedUnits(game(8, 8), undefined), 1);
    assert.equal(completedUnits(game(8, 8), []), 1, 'an empty list is the same as none stored');
    assert.equal(completedUnits(game(7, 8), undefined), 0);
    assert.equal(completedUnits(game(0, 0), undefined), 0, 'a game with nothing to unlock is not a finished one');
    assert.equal(completedUnits(game(null, null), undefined), 0, 'a game Steam has no achievements for is not one either');
  });

  test('a game with sets is one unit per completed set — DREDGE with all three finished is three', () => {
    const rows = [row(0, { completed: 1 }), row(1, { completed: 1 }), row(2, { completed: 1 })];
    assert.equal(completedUnits(game(60, 60), rows), 3);
  });

  test('a game short of 100% still counts the sets it finished — Crusader Kings III is one', () => {
    // 75 of 198 on the flat list, because it holds three DLC sets this account does not own. One set
    // of the five it can earn is finished, and that is what the profile counts
    const rows = [
      row(0, { total: 56, need: 56, done: 46 }), row(2, { total: 20, need: 20, done: 20, completed: 1 }),
      row(8, { achievable: 0 }), row(9, { achievable: 0 }),
    ];
    assert.equal(completedUnits(game(75, 198), rows), 1);
  });

  test('Steam says whether a set is finished, not the arithmetic', () => {
    // A set Steam keeps finished after the developer adds to it can read 9 of 10, and 40 of 40 can be
    // unfinished when the flag has not arrived. Each is asserted alone: counted together in one list
    // the two mistakes cancel, and swapping the flag for the arithmetic would still read 1
    assert.equal(completedUnits(game(49, 60), [row(0, { done: 9, need: 10, completed: 1 })]), 1);
    assert.equal(completedUnits(game(40, 40), [row(0, { done: 40, need: 40, completed: 0 })]), 0);
  });

  test('a set the developer keeps to themselves, or one with nothing in it, is not a unit', () => {
    const rows = [
      row(0, { completed: 1 }),
      row(1, { completed: 1, visible: 0 }),
      row(2, { completed: 1, total: 0, need: 0 }),
    ];
    assert.equal(completedUnits(game(10, 10), rows), 1);
  });

  test('a game whose sets are stored is judged by them, not by the flat count beside them', () => {
    // 60 of 60 on the flat list; the stored reading says no set is finished yet. Two answers to one
    // question is how the figure comes to disagree with the strip drawn on the same row
    assert.equal(completedUnits(game(60, 60), [row(0), row(1)]), 0);
  });

  test('a game Steam has stopped answering for adds nothing, whatever sets it once stored', () => {
    // markNoAchievements clears the game's numbers and leaves its set rows, so without a check the
    // sets would go on counting beside a row that reads N/A
    const rows = [row(0, { completed: 1 }), row(1, { completed: 1 })];
    assert.equal(completedUnits({ achieved: null, total: null, has_achievements: 0 }, rows), 0);
    assert.equal(completedUnits({ achieved: 20, total: 20, has_achievements: 1 }, rows), 2);
  });
});

describe('groupSetsByGame', () => {
  test('one list per game, in the order the rows arrive', () => {
    const grouped = groupSetsByGame([
      { appid: '1', set_id: 0 }, { appid: '1', set_id: 1 }, { appid: '2', set_id: 0 },
    ]);
    assert.deepEqual([...grouped.keys()], ['1', '2']);
    assert.deepEqual(grouped.get('1').map((r) => r.set_id), [0, 1]);
    assert.equal(grouped.get('3'), undefined, 'a game with no rows is absent, not an empty list');
  });

  test('no rows is an empty map', () => {
    assert.equal(groupSetsByGame([]).size, 0);
  });
});

// ---------------------------------------------------------------------------
// Which set each achievement is in
// ---------------------------------------------------------------------------

describe('parseGameSets: the set of each achievement', () => {
  const ach = (name, groupid, extra = {}) => ({ internal_name: name, internal_key: 1, groupid, ...extra });
  const replyWith = (groups, achievements) => ({ response: { achievements, schema_version: 32, groups } });
  const TWO = [group(0, ''), group(1, 'Pack', { dlcappid: 2561440 })];

  test('reads the set of each achievement by its internal name', () => {
    const { members } = parseGameSets(replyWith(TWO, [ach('A', 0), ach('B', 1), ach('C', 1)]));
    assert.ok(members instanceof Map);
    assert.deepEqual([...members], [['A', 0], ['B', 1], ['C', 1]]);
  });

  test('an achievement with no group id is in the base set, as any field Steam leaves out is its default', () => {
    const { members } = parseGameSets(replyWith(TWO, [ach('A', undefined)]));
    assert.deepEqual([...members], [['A', 0]]);
  });

  test('an achievement in a set the reply does not list is left out, since there is nothing to file it under', () => {
    const { members } = parseGameSets(replyWith(TWO, [ach('A', 0), ach('X', 7)]));
    assert.deepEqual([...members.keys()], ['A']);
  });

  test('a name seen twice keeps its first set', () => {
    const { members } = parseGameSets(replyWith(TWO, [ach('A', 1), ach('A', 0)]));
    assert.deepEqual([...members], [['A', 1]]);
  });

  test('a name or an id that cannot be Steam\'s is dropped, and the rest of the list is still read', () => {
    const { members } = parseGameSets(replyWith(TWO, [
      ach('', 0), ach(null, 0), ach(42, 0), ach('x'.repeat(201), 0),
      ach('NEG', -1), ach('FRAC', 0.5), ach('HUGE', 2 ** 40), ach('STR', '1'),
      null, 'not an object', ach('OK', 1),
    ]));
    assert.deepEqual([...members], [['OK', 1]]);
  });

  test('a reply with no achievements, or a list that is not one, has no members and is still a reply', () => {
    for (const achievements of [undefined, [], 'x', { A: 0 }]) {
      const parsed = parseGameSets(replyWith(TWO, achievements));
      assert.equal(parsed.members.size, 0, JSON.stringify(achievements));
      assert.equal(parsed.sets.length, 2, 'the sets are read whatever the list holds');
    }
  });

  test('a list longer than any game has records none, so a broken reply cannot fill the table', () => {
    const many = Array.from({ length: 10001 }, (_, i) => ach('N' + i, 0));
    const parsed = parseGameSets(replyWith(TWO, many));
    assert.equal(parsed.members.size, 0);
    assert.equal(parsed.sets.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Where a game's unfinished achievements go
// ---------------------------------------------------------------------------

describe('groupMissing', () => {
  /** A set as `displaySets` returns it */
  const drawn = (id, name, extra = {}) => ({
    id, base: id === 0, name, dlc: false, earnable: true, done: 0, need: 10, complete: false, completedAt: null, ...extra,
  });
  const item = (name, setId) => ({ name, setId });

  test('is null when the game draws no sets, or when no achievement says which set it is in', () => {
    assert.equal(groupMissing([item('A', 0)], null), null);
    assert.equal(groupMissing([item('A', 0)], []), null);
    assert.equal(groupMissing([item('A', null), item('B', null)], [drawn(0, ''), drawn(1, 'P')]), null,
      'nothing to file under: the list stays flat rather than becoming one group');
    assert.equal(groupMissing([], [drawn(0, ''), drawn(1, 'P')]), null);
  });

  test('lists each set that has something left, in the strip\'s order, with how many', () => {
    const grouping = groupMissing(
      [item('A', 1), item('B', 0), item('C', 1)],
      [drawn(0, ''), drawn(1, 'Pack'), drawn(2, 'Finished')]
    );
    assert.deepEqual(grouping.groups, [
      { id: 0, base: true, name: '', dlc: false, earnable: true, count: 1 },
      { id: 1, base: false, name: 'Pack', dlc: false, earnable: true, count: 2 },
    ]);
  });

  test('counts what can be earned on its own, and what the account cannot earn apart from it', () => {
    const grouping = groupMissing(
      [item('A', 0), item('B', 0), item('C', 0), item('D', 8), item('E', 8)],
      [drawn(0, ''), drawn(8, 'Khans', { earnable: false, dlc: true })]
    );
    assert.equal(grouping.earnableCount, 3);
    assert.equal(grouping.notOwnedCount, 2);
    assert.deepEqual(grouping.groups.map((g) => [g.id, g.earnable, g.count]), [[0, true, 3], [8, false, 2]]);
  });

  test('an achievement in no drawn set is still something left to earn, and has no group of its own', () => {
    const grouping = groupMissing(
      [item('A', 0), item('X', null), item('Y', 9)],
      [drawn(0, ''), drawn(1, 'Pack')]
    );
    assert.deepEqual(grouping.groups.map((g) => g.id), [0]);
    assert.equal(grouping.earnableCount, 3, 'the one in a set that is not drawn, and the one with no set, are not lost');
    assert.equal(grouping.notOwnedCount, 0);
  });

  test('a set that holds only what is left of it counts there and nowhere else', () => {
    const grouping = groupMissing([item('A', 8)], [drawn(0, ''), drawn(8, 'Khans', { earnable: false })]);
    assert.equal(grouping.earnableCount, 0);
    assert.equal(grouping.notOwnedCount, 1);
    assert.deepEqual(grouping.groups.map((g) => g.id), [8]);
  });
});
