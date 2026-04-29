(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
    return;
  }
  root.YoBoardsListConfig = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  const BUILTIN_TABS = [
    { key: 'general', label: 'General', filterPlaceholder: 'Filter general items...', filterAriaLabel: 'Filter general list', exportTitle: 'General', panelType: 'generic' },
    { key: 'hair', label: 'Hair', filterPlaceholder: 'Filter hair...', filterAriaLabel: 'Filter hair list', exportTitle: 'Hair', panelType: 'generic' },
    { key: 'hats', label: 'Hats', filterPlaceholder: 'Filter hats...', filterAriaLabel: 'Filter hats list', exportTitle: 'Hats', panelType: 'generic' },
    { key: 'hhs', label: 'HHs', filterPlaceholder: 'Filter HHs...', filterAriaLabel: 'Filter HHs list', exportTitle: 'HHs', panelType: 'generic' },
    { key: 'pde', label: 'PDE', filterPlaceholder: 'Filter PDE...', filterAriaLabel: 'Filter PDE list', exportTitle: 'PDE', panelType: 'generic' },
    { key: 'slots', label: 'Slots', filterPlaceholder: 'Filter Slots...', filterAriaLabel: 'Filter Slots list', exportTitle: 'Slots', panelType: 'generic' },
    { key: 'zynga', label: 'Zynga', filterPlaceholder: 'Filter Zynga items...', filterAriaLabel: 'Filter Zynga list', exportTitle: 'Zynga', panelType: 'generic' },
    { key: 'furns', label: 'Furns', filterPlaceholder: 'Filter furniture...', filterAriaLabel: 'Filter furniture list', exportTitle: 'Furns', panelType: 'generic' },
    { key: 'npcs', label: 'NPCs', filterPlaceholder: 'Filter NPC items...', filterAriaLabel: 'Filter NPC list', exportTitle: 'NPCs', panelType: 'generic' },
    { key: 'pc', label: 'PC', filterPlaceholder: 'Filter PC items...', filterAriaLabel: 'Filter PC list', exportTitle: 'PC', panelType: 'pricecheck' },
    { key: 'wl', label: 'WL', filterPlaceholder: 'Filter WL items...', filterAriaLabel: 'Filter WL list', exportTitle: 'WL', panelType: 'generic' },
    { key: 'wtb', label: 'WTB', filterPlaceholder: 'Filter WTB items...', filterAriaLabel: 'Filter WTB list', exportTitle: 'WTB', panelType: 'generic' }
  ];

  const DEFAULT_TAB_KEY = BUILTIN_TABS[0]?.key || 'general';
  const SPECIAL_PC_TAB_KEY = 'pc';
  const LEGACY_TAB_KEY_MAP = {
    wish: 'wl',
    npc: 'npcs',
    sell: 'general',
    sellSets: 'general',
    buy: 'wtb',
    pdeSlots: 'pde',
    furns: 'furns',
    pricecheck: 'pc',
    fantasy: 'general'
  };

  function createBuiltinListState(source){
    const src = (source && typeof source === 'object') ? source : {};
    const out = {};
    for(const tab of BUILTIN_TABS){
      out[tab.key] = Array.isArray(src[tab.key]) ? src[tab.key] : [];
    }
    return out;
  }

  function createSectionFilterState(){
    const out = {};
    for(const tab of BUILTIN_TABS) out[tab.key] = '';
    return out;
  }

  function getBuiltinTabDef(key){
    return BUILTIN_TABS.find((tab)=> tab.key === key) || null;
  }

  function getBuiltinTabKeys(){
    return BUILTIN_TABS.map((tab)=> tab.key);
  }

  function cloneEntryForSection(entry, targetSection, makeKey){
    const safe = (entry && typeof entry === 'object') ? { ...entry } : {};
    const existingKey = String(safe.key || '').trim();
    if(existingKey.includes(':')){
      safe.key = targetSection + existingKey.slice(existingKey.indexOf(':'));
    }else if(Number(safe.id) > 0){
      safe.key = typeof makeKey === 'function' ? makeKey(targetSection, safe.id) : `${targetSection}:${safe.id}`;
    }
    return safe;
  }

  function normalizeBuiltinTabKey(key){
    const raw = String(key || '').trim();
    if(!raw) return '';
    if(getBuiltinTabDef(raw)) return raw;
    return LEGACY_TAB_KEY_MAP[raw] || '';
  }

  function normalizeBuiltinKeyList(values){
    const list = Array.isArray(values) ? values : [];
    const out = [];
    for(const value of list){
      const key = normalizeBuiltinTabKey(value) || String(value || '').trim();
      if(!key || out.includes(key)) continue;
      out.push(key);
    }
    return out;
  }

  function sourceHasLegacyBuiltinKeys(source){
    const src = (source && typeof source === 'object') ? source : {};
    if(Object.keys(LEGACY_TAB_KEY_MAP).some((key)=> Array.isArray(src[key]))) return true;
    const settings = src.settings && typeof src.settings === 'object' ? src.settings : src;
    const tabOrder = Array.isArray(settings.tabOrder) ? settings.tabOrder : [];
    const hiddenTabs = Array.isArray(settings.hiddenTabs) ? settings.hiddenTabs : [];
    return [...tabOrder, ...hiddenTabs].some((key)=> !!LEGACY_TAB_KEY_MAP[String(key || '').trim()]);
  }

  function migrateBuiltinListsFromSource(source, makeKey){
    const src = (source && typeof source === 'object') ? source : {};
    const migrated = createBuiltinListState();

    for(const key of getBuiltinTabKeys()){
      if(Array.isArray(src[key])){
        migrated[key] = src[key].map((entry)=> cloneEntryForSection(entry, key, makeKey));
      }
    }

    for(const [legacyKey, nextKey] of Object.entries(LEGACY_TAB_KEY_MAP)){
      if(!Array.isArray(src[legacyKey]) || !nextKey) continue;
      const migratedEntries = src[legacyKey].map((entry)=> cloneEntryForSection(entry, nextKey, makeKey));
      migrated[nextKey] = [...(migrated[nextKey] || []), ...migratedEntries];
    }

    return migrated;
  }

  return {
    BUILTIN_TABS,
    DEFAULT_TAB_KEY,
    SPECIAL_PC_TAB_KEY,
    LEGACY_TAB_KEY_MAP,
    createBuiltinListState,
    createSectionFilterState,
    getBuiltinTabDef,
    getBuiltinTabKeys,
    cloneEntryForSection,
    normalizeBuiltinTabKey,
    normalizeBuiltinKeyList,
    sourceHasLegacyBuiltinKeys,
    migrateBuiltinListsFromSource
  };
});