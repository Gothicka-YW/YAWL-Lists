const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BUILTIN_TABS,
  DEFAULT_TAB_KEY,
  SPECIAL_PC_TAB_KEY,
  LEGACY_TAB_KEY_MAP,
  createBuiltinListState,
  createSectionFilterState,
  getBuiltinTabDef,
  getBuiltinTabKeys,
  normalizeBuiltinTabKey,
  normalizeBuiltinKeyList,
  sourceHasLegacyBuiltinKeys,
  migrateBuiltinListsFromSource
} = require('../list-config.js');

test('built-in tab config matches expected order and keys', () => {
  const keys = BUILTIN_TABS.map((tab) => tab.key);
  assert.deepEqual(keys, ['general', 'hair', 'hats', 'hhs', 'pde', 'slots', 'zynga', 'furns', 'npcs', 'pc', 'wl', 'wtb']);
  assert.equal(DEFAULT_TAB_KEY, 'general');
  assert.equal(SPECIAL_PC_TAB_KEY, 'pc');
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(getBuiltinTabDef('pc')?.panelType, 'pricecheck');
  assert.deepEqual(getBuiltinTabKeys(), keys);
});

test('default list state and filter state cover every built-in tab', () => {
  const listState = createBuiltinListState();
  const filterState = createSectionFilterState();

  for (const tab of BUILTIN_TABS) {
    assert.ok(Array.isArray(listState[tab.key]), `expected array for ${tab.key}`);
    assert.equal(filterState[tab.key], '');
  }
});

test('legacy key normalization maps old keys to new built-in keys', () => {
  assert.equal(normalizeBuiltinTabKey('wish'), 'wl');
  assert.equal(normalizeBuiltinTabKey('npc'), 'npcs');
  assert.equal(normalizeBuiltinTabKey('pricecheck'), 'pc');
  assert.equal(normalizeBuiltinTabKey('general'), 'general');
  assert.equal(normalizeBuiltinTabKey('unknown'), '');

  assert.deepEqual(
    normalizeBuiltinKeyList(['wish', 'wl', 'pricecheck', 'pc', 'npc', 'npc', 'custom_1']),
    ['wl', 'pc', 'npcs', 'custom_1']
  );
});

test('legacy-key detection checks list buckets and settings arrays', () => {
  assert.equal(sourceHasLegacyBuiltinKeys({ wish: [{ id: 1 }] }), true);
  assert.equal(sourceHasLegacyBuiltinKeys({ settings: { tabOrder: ['wish', 'pc'], hiddenTabs: [] } }), true);
  assert.equal(sourceHasLegacyBuiltinKeys({ settings: { tabOrder: ['wl', 'pc'], hiddenTabs: ['general'] } }), false);
});

test('migration helper preserves data and remaps legacy sections safely', () => {
  const source = {
    wish: [{ id: 10, key: 'wish:10:old', name: 'Wish Item' }],
    npc: [{ id: 11, key: 'npc:11:old', name: 'NPC Item' }],
    sell: [{ id: 12, key: 'sell:12:old', name: 'Sell Item' }],
    sellSets: [{ id: 13, key: 'sellSets:13:old', name: 'Set Item' }],
    buy: [{ id: 14, key: 'buy:14:old', name: 'Buy Item' }],
    pdeSlots: [{ id: 15, key: 'pdeSlots:15:old', name: 'PDE Item' }],
    furns: [{ id: 16, key: 'furns:16:old', name: 'Furn Item' }],
    pricecheck: [{ id: 17, key: 'pricecheck:17:old', name: 'PC Item' }],
    fantasy: [{ id: 18, name: 'Fantasy Item' }],
    general: [{ id: 19, key: 'general:19:new', name: 'Existing General Item' }],
    wl: [{ id: 20, key: 'wl:20:new', name: 'Existing WL Item' }]
  };

  const migrated = migrateBuiltinListsFromSource(source, (section, id) => `gen:${section}:${id}`);

  assert.equal(migrated.wl.length, 2);
  assert.equal(migrated.wl[0].key, 'wl:20:new');
  assert.equal(migrated.wl[1].key, 'wl:10:old');

  assert.equal(migrated.npcs.length, 1);
  assert.equal(migrated.npcs[0].key, 'npcs:11:old');

  assert.equal(migrated.wtb.length, 1);
  assert.equal(migrated.wtb[0].key, 'wtb:14:old');

  assert.equal(migrated.pde.length, 1);
  assert.equal(migrated.pde[0].key, 'pde:15:old');

  assert.equal(migrated.pc.length, 1);
  assert.equal(migrated.pc[0].key, 'pc:17:old');

  assert.equal(migrated.furns.length, 1);
  assert.equal(migrated.furns[0].key, 'furns:16:old');

  assert.equal(migrated.general.length, 4);
  assert.deepEqual(
    migrated.general.map((entry) => entry.name),
    ['Existing General Item', 'Sell Item', 'Set Item', 'Fantasy Item']
  );
  assert.equal(migrated.general[3].key, 'gen:general:18');
});

test('legacy map stays aligned with expected old keys', () => {
  assert.deepEqual(LEGACY_TAB_KEY_MAP, {
    wish: 'wl',
    npc: 'npcs',
    sell: 'general',
    sellSets: 'general',
    buy: 'wtb',
    pdeSlots: 'pde',
    pricecheck: 'pc',
    fantasy: 'general'
  });
});