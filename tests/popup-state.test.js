const test = require('node:test');
const assert = require('node:assert/strict');

const listConfigApi = require('../list-config.js');

globalThis.YoBoardsListConfig = listConfigApi;
if(!globalThis.document){
  globalThis.document = {
    addEventListener(){},
    querySelector(){ return null; }
  };
}

const {
  exportSectionsForScope,
  normalizeSettingsFromStorage,
  normalizeStateFromStorage,
  setStateForTests
} = require('../popup.js');

function makeBaseState(overrides){
  return {
    ...listConfigApi.createBuiltinListState(),
    settings: {
      theme: 'classic',
      imageSource: 'cdn',
      allowCopyText: false,
      customTabs: [],
      tabOrder: [],
      hiddenTabs: [],
      lastSavedAt: 0
    },
    ...(overrides && typeof overrides === 'object' ? overrides : {})
  };
}

test('export scope generation includes custom tabs and handles invalid scopes', () => {
  setStateForTests(makeBaseState({
    settings: {
      theme: 'classic',
      imageSource: 'cdn',
      allowCopyText: false,
      customTabs: [{ key: 'custom_trade', label: 'Trade' }],
      tabOrder: ['general', 'custom_trade'],
      hiddenTabs: [],
      lastSavedAt: 0
    },
    custom_trade: [{ id: 22, name: 'Trade Item' }]
  }));

  const all = exportSectionsForScope('all');
  const keys = all.map((s) => s.key);
  assert.ok(keys.includes('general'));
  assert.ok(keys.includes('custom_trade'));

  const customOnly = exportSectionsForScope('custom_trade');
  assert.deepEqual(customOnly, [{ key: 'custom_trade', title: 'Trade' }]);

  const fallback = exportSectionsForScope('missing_scope');
  assert.deepEqual(fallback, [{ key: 'general', title: 'General' }]);

  const activeFallback = exportSectionsForScope('active');
  assert.deepEqual(activeFallback, [{ key: 'general', title: 'General' }]);
});

test('built-in export scope stays aligned with renamed and split tab set', () => {
  setStateForTests(makeBaseState({
    settings: {
      theme: 'classic',
      imageSource: 'cdn',
      allowCopyText: false,
      customTabs: [{ key: 'custom_trade', label: 'Trade' }],
      tabOrder: ['general', 'pde', 'slots', 'custom_trade'],
      hiddenTabs: [],
      lastSavedAt: 0
    },
    custom_trade: [{ id: 77, name: 'Trade Item' }]
  }));

  const all = exportSectionsForScope('all');
  const builtinSections = all.slice(0, listConfigApi.BUILTIN_TABS.length);

  assert.deepEqual(
    builtinSections.map((section) => section.key),
    listConfigApi.BUILTIN_TABS.map((tab) => tab.key)
  );
  assert.deepEqual(
    builtinSections.map((section) => section.title),
    listConfigApi.BUILTIN_TABS.map((tab) => tab.exportTitle || tab.label)
  );

  const keys = all.map((section) => section.key);
  assert.ok(keys.includes('pde'));
  assert.ok(keys.includes('slots'));
  assert.ok(!keys.includes('pdeSlots'));
});

test('custom tab settings normalization filters and sanitizes stored values', () => {
  const normalized = normalizeSettingsFromStorage({
    theme: 'ocean',
    imageSource: 'auto',
    allowCopyText: 1,
    customTabs: [
      { key: 'custom_alpha', label: '  Alpha  ' },
      { key: 'bad_key', label: 'Not Allowed' },
      { key: 'custom_beta', label: '' },
      { key: 'custom_gamma', label: 'This label is intentionally longer than thirty chars' }
    ],
    tabOrder: ['wish', 'custom_alpha'],
    hiddenTabs: ['npc']
  });

  assert.equal(normalized.theme, 'ocean');
  assert.equal(normalized.imageSource, 'auto');
  assert.equal(normalized.allowCopyText, true);
  assert.deepEqual(normalized.customTabs, [
    { key: 'custom_alpha', label: 'Alpha' },
    { key: 'custom_beta', label: 'Custom' },
    { key: 'custom_gamma', label: 'This label is intentionally lo' }
  ]);
  assert.deepEqual(normalized.tabOrder, ['wl', 'custom_alpha']);
  assert.deepEqual(normalized.hiddenTabs, ['npcs']);
});

test('custom tab state deserialization restores declared tabs and arrays only', () => {
  const normalized = normalizeStateFromStorage({
    settings: {
      customTabs: [
        { key: 'custom_collectors', label: 'Collectors' },
        { key: 'custom_events', label: 'Events' }
      ],
      tabOrder: ['wl', 'custom_collectors', 'custom_events'],
      hiddenTabs: ['hhs']
    },
    custom_collectors: [{ id: 1, name: 'Collector Item' }],
    custom_events: 'not-an-array',
    custom_orphan: [{ id: 999, name: 'Orphan' }]
  });

  assert.ok(Array.isArray(normalized.custom_collectors));
  assert.equal(normalized.custom_collectors.length, 1);

  assert.ok(Array.isArray(normalized.custom_events));
  assert.equal(normalized.custom_events.length, 0);

  assert.equal(normalized.custom_orphan, undefined);
  assert.deepEqual(normalized.settings.customTabs, [
    { key: 'custom_collectors', label: 'Collectors' },
    { key: 'custom_events', label: 'Events' }
  ]);
});
