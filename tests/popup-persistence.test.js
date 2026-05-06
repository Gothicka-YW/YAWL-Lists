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
  defaultState,
  getTabsFullOrder,
  getEffectiveTabOrder,
  pickPreferredSettings,
  mergePersistedListState,
  setStateForTests
} = require('../popup.js');

function makeState(overrides){
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

test('defaultState provides complete built-in and settings defaults', () => {
  const s = defaultState();

  for(const tab of listConfigApi.BUILTIN_TABS){
    assert.ok(Array.isArray(s[tab.key]), `expected array list for ${tab.key}`);
  }

  assert.deepEqual(s.settings, {
    theme: 'classic',
    imageSource: 'cdn',
    allowCopyText: false,
    customTabs: [],
    tabOrder: [],
    hiddenTabs: [],
    lastSavedAt: 0
  });
});

test('tab order helpers honor saved order and hidden tabs', () => {
  setStateForTests(makeState({
    settings: {
      theme: 'classic',
      imageSource: 'cdn',
      allowCopyText: false,
      customTabs: [
        { key: 'custom_alpha', label: 'Alpha' },
        { key: 'custom_beta', label: 'Beta' }
      ],
      tabOrder: ['wl', 'custom_alpha', 'hats', 'custom_beta'],
      hiddenTabs: ['hats'],
      lastSavedAt: 10
    },
    custom_alpha: [{ id: 1, name: 'A' }],
    custom_beta: [{ id: 2, name: 'B' }]
  }));

  const fullOrder = getTabsFullOrder();
  assert.deepEqual(fullOrder.slice(0, 4), ['wl', 'custom_alpha', 'hats', 'custom_beta']);
  assert.ok(fullOrder.includes('general'));

  const effective = getEffectiveTabOrder();
  assert.ok(!effective.includes('hats'));
  assert.ok(effective.includes('custom_alpha'));
  assert.ok(effective.includes('custom_beta'));
});

test('last-known-state settings arbitration prefers newest timestamp', () => {
  const older = {
    theme: 'classic',
    imageSource: 'cdn',
    allowCopyText: false,
    customTabs: [{ key: 'custom_old', label: 'Old' }],
    tabOrder: ['general', 'custom_old'],
    hiddenTabs: [],
    lastSavedAt: 100
  };
  const newer = {
    theme: 'dark',
    imageSource: 'auto',
    allowCopyText: true,
    customTabs: [],
    tabOrder: ['wl'],
    hiddenTabs: ['hats'],
    lastSavedAt: 200
  };

  const picked = pickPreferredSettings(older, newer);
  assert.equal(picked.theme, 'dark');
  assert.equal(picked.imageSource, 'auto');
  assert.equal(picked.allowCopyText, true);
  assert.equal(picked.lastSavedAt, 200);
});

test('save/load merge helper keeps richer lists and merges custom tab defs', () => {
  const localState = makeState({
    general: [{ id: 1 }, { id: 2 }],
    custom_alpha: [{ id: 3 }, { id: 4 }],
    settings: {
      customTabs: [{ key: 'custom_alpha', label: 'Alpha' }],
      tabOrder: ['general', 'custom_alpha'],
      hiddenTabs: [],
      lastSavedAt: 400
    }
  });

  const legacySyncState = makeState({
    general: [{ id: 1 }],
    custom_beta: [{ id: 9 }],
    settings: {
      customTabs: [{ key: 'custom_beta', label: 'Beta' }],
      tabOrder: ['custom_beta'],
      hiddenTabs: ['hats'],
      lastSavedAt: 300
    }
  });

  const preferredSettings = {
    theme: 'ocean',
    imageSource: 'info',
    allowCopyText: true,
    customTabs: [{ key: 'custom_alpha', label: 'Alpha' }],
    tabOrder: ['general', 'custom_alpha'],
    hiddenTabs: [],
    lastSavedAt: 500
  };

  const fallbackSettings = {
    customTabs: [{ key: 'custom_gamma', label: 'Gamma' }],
    tabOrder: ['custom_gamma'],
    hiddenTabs: []
  };

  const merged = mergePersistedListState(localState, legacySyncState, preferredSettings, fallbackSettings);

  assert.deepEqual(merged.general.map((x) => x.id), [1, 2]);
  assert.deepEqual(merged.custom_alpha.map((x) => x.id), [3, 4]);
  assert.deepEqual(merged.custom_beta.map((x) => x.id), [9]);
  assert.ok(Array.isArray(merged.custom_gamma));
  assert.equal(merged.custom_gamma.length, 0);

  assert.deepEqual(
    merged.settings.customTabs.map((tab) => tab.key),
    ['custom_alpha', 'custom_beta', 'custom_gamma']
  );
  assert.equal(merged.settings.theme, 'ocean');
  assert.equal(merged.settings.imageSource, 'info');
  assert.equal(merged.settings.allowCopyText, true);
  assert.equal(merged.settings.lastSavedAt, 500);
});
