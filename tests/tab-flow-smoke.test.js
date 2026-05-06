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
  applyHideBuiltinTabState,
  applyRestoreHiddenTabState,
  applyCreateCustomTabState,
  buildDeleteCustomTabPrompt,
  applyDeleteCustomTabState
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

test('smoke: hide + restore tab flow mutates hidden tabs safely', () => {
  const state = makeState();

  const firstHide = applyHideBuiltinTabState(state, 'hats');
  assert.equal(firstHide, true);
  assert.deepEqual(state.settings.hiddenTabs, ['hats']);

  const secondHide = applyHideBuiltinTabState(state, 'hats');
  assert.equal(secondHide, false);
  assert.deepEqual(state.settings.hiddenTabs, ['hats']);

  const restored = applyRestoreHiddenTabState(state, 'hats');
  assert.equal(restored, true);
  assert.deepEqual(state.settings.hiddenTabs, []);

  const restoreMissing = applyRestoreHiddenTabState(state, 'hats');
  assert.equal(restoreMissing, false);
});

test('smoke: create custom tab flow adds tab/list/filter and blocks duplicates', () => {
  const state = makeState();
  const sectionFilters = {};

  const created = applyCreateCustomTabState(state, sectionFilters, 'custom_trade', '  Trade Hub  ');
  assert.equal(created, true);
  assert.deepEqual(state.settings.customTabs, [{ key: 'custom_trade', label: 'Trade Hub' }]);
  assert.ok(Array.isArray(state.custom_trade));
  assert.equal(state.custom_trade.length, 0);
  assert.equal(sectionFilters.custom_trade, '');

  const duplicate = applyCreateCustomTabState(state, sectionFilters, 'custom_trade', 'Duplicate');
  assert.equal(duplicate, false);
  assert.equal(state.settings.customTabs.length, 1);

  const invalid = applyCreateCustomTabState(state, sectionFilters, 'custom_new', '   ');
  assert.equal(invalid, false);
  assert.equal(state.settings.customTabs.length, 1);
});

test('smoke: delete custom tab flow removes tab data/order/filter and reports count', () => {
  const state = makeState({
    custom_alpha: [{ id: 1 }, { id: 2 }],
    custom_beta: [{ id: 3 }],
    settings: {
      customTabs: [
        { key: 'custom_alpha', label: 'Alpha' },
        { key: 'custom_beta', label: 'Beta' }
      ],
      tabOrder: ['general', 'custom_alpha', 'custom_beta'],
      hiddenTabs: [],
      lastSavedAt: 99
    }
  });
  const sectionFilters = {
    custom_alpha: 'alpha',
    custom_beta: 'beta'
  };

  const msg = buildDeleteCustomTabPrompt('Alpha', 2);
  assert.equal(msg.includes('2 items'), true);

  const deleted = applyDeleteCustomTabState(state, sectionFilters, 'custom_alpha');
  assert.equal(deleted.changed, true);
  assert.equal(deleted.itemCount, 2);
  assert.equal(deleted.tabLabel, 'Alpha');

  assert.deepEqual(state.settings.customTabs, [{ key: 'custom_beta', label: 'Beta' }]);
  assert.deepEqual(state.settings.tabOrder, ['general', 'custom_beta']);
  assert.equal(state.custom_alpha, undefined);
  assert.equal(sectionFilters.custom_alpha, undefined);

  const missing = applyDeleteCustomTabState(state, sectionFilters, 'custom_missing');
  assert.equal(missing.changed, false);
});
