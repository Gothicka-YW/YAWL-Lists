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
  buildDataBackupPayload,
  parseDataBackupPayloadText
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

test('backup payload includes custom tabs and list data', () => {
  const source = makeState({
    general: [{ key: 'general:1:a', id: 1, name: 'General Item', note: '1m' }],
    custom_trade: [{ key: 'custom_trade:2:a', id: 2, name: 'Custom Trade Item', note: 'swap' }],
    settings: {
      theme: 'ocean',
      imageSource: 'auto',
      allowCopyText: true,
      customTabs: [{ key: 'custom_trade', label: 'Trade' }],
      tabOrder: ['general', 'custom_trade'],
      hiddenTabs: ['hats'],
      lastSavedAt: 12345
    }
  });

  const payload = buildDataBackupPayload(source);

  assert.equal(payload.kind, 'yo_boards_backup');
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.settings.theme, 'ocean');
  assert.equal(payload.settings.imageSource, 'auto');
  assert.equal(payload.settings.allowCopyText, true);
  assert.deepEqual(payload.settings.customTabs, [{ key: 'custom_trade', label: 'Trade' }]);

  assert.ok(Array.isArray(payload.lists.general));
  assert.equal(payload.lists.general.length, 1);
  assert.ok(Array.isArray(payload.lists.custom_trade));
  assert.equal(payload.lists.custom_trade.length, 1);
  assert.equal(payload.lists.custom_trade[0].name, 'Custom Trade Item');
});

test('backup parser rejects unsupported schema versions', () => {
  const unsupported = JSON.stringify({
    kind: 'yo_boards_backup',
    schemaVersion: 2,
    settings: {},
    lists: {}
  });

  assert.throws(
    () => parseDataBackupPayloadText(unsupported),
    /schema version 2 is not supported/i
  );
});

test('backup parser restores built-in and custom lists safely', () => {
  const rawBackup = {
    kind: 'yo_boards_backup',
    schemaVersion: 1,
    exportedAt: '2026-05-05T10:15:00.000Z',
    settings: {
      theme: 'unknown-theme',
      imageSource: 'not-valid',
      allowCopyText: 1,
      customTabs: [{ key: 'custom_collectors', label: 'Collectors' }],
      tabOrder: ['wl', 'custom_collectors'],
      hiddenTabs: ['hats']
    },
    lists: {
      general: [{ id: 10, name: 'General A' }],
      custom_collectors: [
        { id: 20, name: 'Custom A' },
        { key: 'dup-key', id: 21, name: 'Custom B' },
        { key: 'dup-key', id: 22, name: 'Custom C' }
      ],
      custom_ignored: [{ id: 999, name: 'Should Not Restore' }]
    }
  };

  const parsed = parseDataBackupPayloadText(JSON.stringify(rawBackup));
  const restored = parsed.state;

  assert.equal(parsed.schemaVersion, 1);
  assert.equal(restored.settings.theme, 'classic');
  assert.equal(restored.settings.imageSource, 'cdn');
  assert.equal(restored.settings.allowCopyText, true);
  assert.deepEqual(restored.settings.customTabs, [{ key: 'custom_collectors', label: 'Collectors' }]);
  assert.ok(restored.settings.tabOrder.includes('custom_collectors'));
  assert.ok(restored.settings.hiddenTabs.includes('hats'));

  assert.ok(Array.isArray(restored.general));
  assert.equal(restored.general.length, 1);

  assert.ok(Array.isArray(restored.custom_collectors));
  assert.equal(restored.custom_collectors.length, 3);
  const keys = restored.custom_collectors.map((entry) => entry.key);
  assert.equal(new Set(keys).size, keys.length);

  assert.equal(restored.custom_ignored, undefined);
});

test('backup round-trip preserves tab order and hidden tabs', () => {
  const source = makeState({
    general: [{ key: 'general:1:a', id: 1, name: 'General Item' }],
    custom_trade: [{ key: 'custom_trade:2:a', id: 2, name: 'Trade Item' }],
    settings: {
      theme: 'ocean',
      imageSource: 'auto',
      allowCopyText: true,
      customTabs: [{ key: 'custom_trade', label: 'Trade' }],
      tabOrder: ['wl', 'custom_trade', 'pde', 'slots'],
      hiddenTabs: ['hats', 'custom_trade'],
      lastSavedAt: 54321
    }
  });

  const payload = buildDataBackupPayload(source);
  const parsed = parseDataBackupPayloadText(JSON.stringify(payload));
  const restored = parsed.state;

  assert.deepEqual(restored.settings.tabOrder, ['wl', 'custom_trade', 'pde', 'slots']);
  assert.deepEqual(restored.settings.hiddenTabs, ['hats', 'custom_trade']);
  assert.deepEqual(restored.settings.customTabs, [{ key: 'custom_trade', label: 'Trade' }]);
  assert.ok(Array.isArray(restored.custom_trade));
  assert.equal(restored.custom_trade.length, 1);
});
