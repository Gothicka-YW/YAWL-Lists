const SYNC_KEY = 'yo_boards_sync_v1';
const LOCAL_KEY = 'yo_boards_local_v1';
const SYNC_SETTINGS_KEY = 'yo_boards_sync_settings_v1';
const LIST_DENSITY_SESSION_KEY = 'yo_boards_list_density_v1';
const LISTS_QUICKSTART_DISMISSED_KEY = 'yo_boards_lists_quickstart_dismissed_v1';
const BACKUP_KIND = 'wtb_wts_backup';
const LEGACY_BACKUP_KIND = 'yo_boards_backup';

const listConfigApi = globalThis.WtbWtsListConfig;
if(!listConfigApi) throw new Error('WtbWtsListConfig is not loaded.');

const {
  BUILTIN_TABS,
  DEFAULT_TAB_KEY,
  SPECIAL_PC_TAB_KEY,
  createBuiltinListState,
  createSectionFilterState,
  getBuiltinTabDef,
  getBuiltinTabKeys,
  normalizeBuiltinKeyList,
  sourceHasLegacyBuiltinKeys,
  migrateBuiltinListsFromSource
} = listConfigApi;

function $(s){return document.querySelector(s);}
function el(t,c){const e=document.createElement(t); if(c) e.className=c; return e;}

function safeNow(){
  try{ return Date.now(); }catch{ return 0; }
}

function getAllListTabDefs(){
  return [
    ...BUILTIN_TABS.map((tab)=> ({ key: tab.key, label: tab.label, exportTitle: tab.exportTitle || tab.label, panelType: tab.panelType || 'generic', isCustom: false })),
    ...getCustomTabs().map((tab)=> ({ key: tab.key, label: tab.label, exportTitle: tab.label, panelType: 'generic', isCustom: true }))
  ];
}

function getListTabLabel(tabKey){
  const builtin = getBuiltinTabDef(tabKey);
  if(builtin?.label) return builtin.label;
  const custom = getCustomTabs().find((tab)=> tab.key === tabKey);
  return custom?.label || String(tabKey || 'list');
}

function replaceSelectOptions(selectEl, options, preferredValue){
  if(!selectEl) return;
  const fallbackValue = options[0]?.value || '';
  const currentValue = typeof preferredValue === 'string' ? preferredValue : String(selectEl.value || '');
  selectEl.innerHTML = '';
  for(const optionDef of options){
    const optionEl = document.createElement('option');
    optionEl.value = optionDef.value;
    optionEl.textContent = optionDef.label;
    selectEl.appendChild(optionEl);
  }
  const nextValue = options.some((optionDef)=> optionDef.value === currentValue) ? currentValue : fallbackValue;
  if(nextValue) selectEl.value = nextValue;
}

function syncBuiltinPanelsFromConfig(){
  for(const tab of BUILTIN_TABS){
    const panel = document.querySelector(`[data-panel="${tab.key}"]`);
    if(!panel) continue;

    if(tab.panelType === 'pricecheck'){
      const panelTitle = panel.querySelector(':scope > h2');
      if(panelTitle) panelTitle.textContent = tab.label;
      const savedListTitle = panel.querySelector('.section-head h2');
      if(savedListTitle) savedListTitle.textContent = `Saved ${tab.label} List`;
    }

    const filterInput = panel.querySelector(`#filter-${CSS.escape(tab.key)}`);
    if(filterInput){
      filterInput.placeholder = tab.filterPlaceholder || `Filter ${tab.label.toLowerCase()} items...`;
      filterInput.setAttribute('aria-label', tab.filterAriaLabel || `Filter ${tab.label} list`);
    }
  }
}

function getListDensity(){
  try{
    const v = sessionStorage.getItem(LIST_DENSITY_SESSION_KEY);
    return (v === 'compact') ? 'compact' : 'comfortable';
  }catch{
    return 'comfortable';
  }
}

function setListDensity(v){
  const next = (v === 'compact') ? 'compact' : 'comfortable';
  if(document?.body){
    if(next === 'compact') document.body.setAttribute('data-list-density', 'compact');
    else document.body.removeAttribute('data-list-density');
  }
  try{ sessionStorage.setItem(LIST_DENSITY_SESSION_KEY, next); }catch{}
}

function defaultState(){
  return {
    ...createBuiltinListState(),
    settings: {
      theme: 'classic',
      imageSource: 'cdn', // 'cdn' | 'info' | 'auto'
      allowCopyText: false,  // allow text selection on item cards
      customTabs: [],         // user-created custom list tabs
      tabOrder: [],           // saved order of all tabs (builtin + custom)
      hiddenTabs: [],         // builtin tab keys hidden by the user
      lastSavedAt: 0          // used to prefer the freshest known settings state
    }
  };
}

let state = defaultState();

let lastPriceCheckItem = null;

// Section filter state (search/filter within each list)
let sectionFilters = createSectionFilterState();

const SYNC_SETTINGS_DEBOUNCE_MS = 900;
let lastSettingsContentFingerprint = '';
let lastSyncedSettingsPayloadJson = '';
let queuedSyncSettings = null;
let syncSettingsDebounceTimer = 0;
let syncSettingsRetryTimer = 0;
let syncSettingsRetryAt = 0;
let syncSettingsWriteInFlight = false;

const ACTIVE_TAB_KEY = 'yo_boards_active_tab_v1';
const TAB_DRAFTS_KEY = 'yo_boards_tab_drafts_v1';

const PRICE_NOTES_KEY = 'yo_boards_price_notes_v1';

function normalizeTagList(input){
  const raw = (typeof input === 'string') ? input : Array.isArray(input) ? input.join(',') : '';
  const parts = raw.split(',').map(t=>String(t||'').trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for(const p of parts){
    const k = p.toLowerCase();
    if(seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

async function loadPriceNotes(){
  const res = await storageGet('local', PRICE_NOTES_KEY);
  if(res.error) return {};
  const v = res.value;
  return (v && typeof v === 'object') ? v : {};
}

async function savePriceNotes(notesById){
  const safe = (notesById && typeof notesById === 'object') ? notesById : {};
  const res = await storageSet('local', PRICE_NOTES_KEY, safe);
  if(!res.ok) console.warn('price notes set failed:', res.error);
}

function safeJsonParse(s){
  try{ return JSON.parse(s); }catch{ return null; }
}

function loadTabDrafts(){
  const raw = (()=>{ try{ return localStorage.getItem(TAB_DRAFTS_KEY) || ''; }catch{ return ''; } })();
  const obj = safeJsonParse(raw);
  return (obj && typeof obj === 'object') ? obj : {};
}

function saveTabDrafts(drafts){
  try{ localStorage.setItem(TAB_DRAFTS_KEY, JSON.stringify(drafts || {})); }catch{}
}

function isListsQuickstartDismissed(){
  try{ return localStorage.getItem(LISTS_QUICKSTART_DISMISSED_KEY) === '1'; }catch{}
  return false;
}

function setListsQuickstartDismissed(isDismissed){
  try{
    if(isDismissed) localStorage.setItem(LISTS_QUICKSTART_DISMISSED_KEY, '1');
    else localStorage.removeItem(LISTS_QUICKSTART_DISMISSED_KEY);
  }catch{}
}

function initListsQuickstartCue(){
  const cueCard = $('#lists-quickstart');
  if(!cueCard) return;

  cueCard.hidden = isListsQuickstartDismissed();

  const dismissBtn = $('#btn-lists-quickstart-dismiss');
  if(!dismissBtn || dismissBtn.dataset.wired === '1') return;
  dismissBtn.dataset.wired = '1';
  dismissBtn.addEventListener('click', ()=>{
    setListsQuickstartDismissed(true);
    cueCard.hidden = true;
  });
}

function isListTab(tabName){
  if(BUILTIN_TABS.some(t => t.key === tabName)) return true;
  return getCustomTabs().some(t => t.key === tabName);
}

function isKnownTab(tabName){
  if(tabName === 'settings') return true;
  if(BUILTIN_TABS.some(t => t.key === tabName)) return true;
  return getCustomTabs().some(t => t.key === tabName);
}

function persistDraftForTab(tabName){
  if(!isListTab(tabName)) return;
  const drafts = loadTabDrafts();
  drafts[tabName] = {
    query: ($('#in-query')?.value || ''),
    note: ($('#in-note')?.value || '')
  };
  saveTabDrafts(drafts);
}

function applyDraftForTab(tabName){
  if(!isListTab(tabName)) return;
  const drafts = loadTabDrafts();
  const d = drafts[tabName] || {};
  const q = $('#in-query');
  const n = $('#in-note');
  if(q) q.value = typeof d.query === 'string' ? d.query : '';
  if(n) n.value = typeof d.note === 'string' ? d.note : '';
}

let currentTab = DEFAULT_TAB_KEY;

function setActiveTab(tabName){
  // Save whatever was being typed for the previous tab.
  persistDraftForTab(currentTab);

  const tabs = Array.from(document.querySelectorAll('.tab[data-tab]'));
  const panels = Array.from(document.querySelectorAll('[data-panel]'));
  tabs.forEach(t => t.classList.toggle('is-active', t.dataset.tab === tabName));
  panels.forEach(p => { p.hidden = p.dataset.panel !== tabName; });
  try{ localStorage.setItem(ACTIVE_TAB_KEY, tabName); }catch{}

  currentTab = tabName;

  // Make Add Item default to the active list tab.
  if(isListTab(tabName)){
    const sel = $('#in-section');
    if(sel) sel.value = tabName;
    applyDraftForTab(tabName);
  }

  updateExportPreviewSummary();
}

function flashDropZoneMessage(message, kind){
  const zone = $('#drop-zone');
  if(!zone) return;

  const baseMessage = zone.dataset.baseMessage || zone.textContent.trim() || 'Drag an item card from yoworld.info to add it.';
  zone.dataset.baseMessage = baseMessage;
  zone.textContent = String(message || baseMessage);
  zone.classList.toggle('is-success', kind === 'success');
  zone.classList.toggle('is-error', kind === 'error');

  clearTimeout(flashDropZoneMessage._timer);
  flashDropZoneMessage._timer = setTimeout(()=>{
    zone.textContent = baseMessage;
    zone.classList.remove('is-success', 'is-error');
  }, 2200);
}
flashDropZoneMessage._timer = 0;

function revealSectionItem(section, itemKey, opts){
  if(!section || !itemKey) return;
  const options = (opts && typeof opts === 'object') ? opts : {};
  const activeTab = getActiveTab();
  const switchedTabs = activeTab !== section;
  if(switchedTabs) setActiveTab(section);

  requestAnimationFrame(()=>{
    const tile = document.querySelector(`.tile[data-section="${CSS.escape(section)}"][data-key="${CSS.escape(itemKey)}"]`);
    if(!tile) return;
    const shouldScroll = options.scroll === true || options.scroll === 'always'
      || (options.scroll === 'if-tab-switch' && switchedTabs);
    if(shouldScroll){
      tile.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
    }
    tile.classList.add('is-added-highlight');
    clearTimeout(revealSectionItem._timers.get(tile));
    const timer = setTimeout(()=>{
      tile.classList.remove('is-added-highlight');
      revealSectionItem._timers.delete(tile);
    }, 1800);
    revealSectionItem._timers.set(tile, timer);
  });
}
revealSectionItem._timers = new WeakMap();

function getActiveTab(){
  const active = document.querySelector('.tab.is-active[data-tab]');
  if(active?.dataset?.tab) return active.dataset.tab;
  try{ return localStorage.getItem(ACTIVE_TAB_KEY) || DEFAULT_TAB_KEY; }catch{}
  return DEFAULT_TAB_KEY;
}

async function openSidePanel(){
  // Side panel API requires a windowId. Works in modern Chrome; degrade gracefully.
  try{
    if(!chrome?.windows?.getCurrent || !chrome?.sidePanel?.open){
      alert('Side panel is not available in this Chrome version.');
      return;
    }

    const win = await new Promise((resolve)=>{
      chrome.windows.getCurrent((w)=>resolve(w));
    });
    const windowId = win?.id;
    if(typeof windowId !== 'number'){
      alert('Could not determine current window.');
      return;
    }

    await new Promise((resolve, reject)=>{
      try{
        chrome.sidePanel.open({ windowId }, ()=>{
          const err = chrome.runtime?.lastError;
          if(err) reject(err);
          else resolve();
        });
      }catch(e){
        reject(e);
      }
    });
  }catch(e){
    console.error(e);
    alert('Failed to open side panel.');
  }
}

function wireTabs(){
  // Use event delegation so tab switching keeps working even if the UI is re-rendered
  // or if individual listeners fail to attach for any reason.
  if(!wireTabs._delegated){
    document.addEventListener('click', (e)=>{
      const btn = e.target && e.target.closest ? e.target.closest('.tab[data-tab]') : null;
      if(!btn) return;
      const tabName = btn.dataset ? btn.dataset.tab : null;
      if(!tabName) return;
      setActiveTab(tabName);
    }, true);
    wireTabs._delegated = true;
  }

  if(!wireTabs._delegatedDnD){
    let switchTimer = 0;
    const clearSwitchTimer = ()=>{ if(switchTimer){ clearTimeout(switchTimer); switchTimer = 0; } };

    const getTabBtn = (e)=> e?.target && e.target.closest ? e.target.closest('.tab[data-tab]') : null;

    document.addEventListener('dragenter', (e)=>{
      const btn = getTabBtn(e);
      if(!btn || !dragState?.key) return;
      const tabName = btn.dataset ? btn.dataset.tab : null;
      if(!tabName || !isListTab(tabName)) return;

      btn.classList.add('is-drop-target');
      e.preventDefault();
    }, true);

    document.addEventListener('dragover', (e)=>{
      const btn = getTabBtn(e);
      if(!btn || !dragState?.key) return;
      const tabName = btn.dataset ? btn.dataset.tab : null;
      if(!tabName || !isListTab(tabName)) return;
      e.preventDefault();
      try{ e.dataTransfer.dropEffect = 'move'; }catch{}
      btn.classList.add('is-drop-target');
    }, true);

    document.addEventListener('dragleave', (e)=>{
      const btn = getTabBtn(e);
      if(!btn) return;
      // Only clear if we're actually leaving the button entirely.
      const rel = e.relatedTarget;
      if(rel && btn.contains(rel)) return;
      btn.classList.remove('is-drop-target');
      clearSwitchTimer();
    }, true);

    document.addEventListener('drop', async(e)=>{
      const btn = getTabBtn(e);
      if(!btn || !dragState?.key) return;
      const tabName = btn.dataset ? btn.dataset.tab : null;
      if(!tabName || !isListTab(tabName)) return;
      e.preventDefault();
      btn.classList.remove('is-drop-target');
      clearSwitchTimer();

      const fromSection = dragState.section;
      const fromKey = dragState.key;
      const toSection = tabName;

      if(moveItemByKey(fromSection, fromKey, toSection, null)){
        await saveState();
        render();
      }
    }, true);

    wireTabs._delegatedDnD = true;
  }
  let initial = DEFAULT_TAB_KEY;
  try{ initial = localStorage.getItem(ACTIVE_TAB_KEY) || DEFAULT_TAB_KEY; }catch{}
  if(!isKnownTab(initial)) initial = DEFAULT_TAB_KEY;
  currentTab = initial;
  setActiveTab(initial);
}
wireTabs._delegated = false;
wireTabs._delegatedDnD = false;

function isKnownThemeValue(t){
  return t === 'classic' || t === 'dark' || t === 'valentine' || t === 'ocean' || t === 'forest' || t === 'naturefantasy' || t === 'sunset' || t === 'autumn' || t === 'prored' || t === 'emerald';
}

function normalizeThemeValue(theme){
  const t = (typeof theme === 'string') ? theme.toLowerCase() : '';
  if(t === 'arcane') return 'naturefantasy';
  if(t === 'cyberpunk' || t === 'midnight') return 'dark';
  if(t === 'cherryblossom') return 'prored';
  return isKnownThemeValue(t) ? t : 'classic';
}

function themeFromState(){
  return normalizeThemeValue(state?.settings?.theme);
}

function imageSourceFromState(){
  const v = state?.settings?.imageSource;
  return (v === 'cdn' || v === 'info' || v === 'auto') ? v : 'cdn';
}

function applyTheme(theme){
  if(!document?.body) return;
  if(theme === 'classic'){
    document.body.removeAttribute('data-theme');
  }else{
    document.body.setAttribute('data-theme', theme);
  }
}

function exportPalette(theme){
  if(theme === 'dark'){
    return {
      bg: '#130f1f',
      tileBg: '#1d1730',
      tileBorder: '#4a3a70',
      text: '#ede9fb',
      muted: '#b8abd8',
      imgFallback: '#2a2144',
      badgeBg: '#2a2144',
      badgeBorder: '#8f6ad8',
      badgeBorderAlt: '#ef4444',
      badgeText: '#ede9fb',
      priceBg: '#2a2144',
      priceBorder: '#8f6ad8',
      priceText: '#ede9fb'
    };
  }

  if(theme === 'valentine'){
    return {
      bg: '#fff1f2',
      tileBg: '#ffffff',
      tileBorder: '#fecdd3',
      text: '#1f2937',
      muted: '#6b7280',
      imgFallback: '#ffe4e6',
      badgeBg: '#ffe4e6',
      badgeBorder: '#e11d48',
      badgeBorderAlt: '#e11d48',
      badgeText: '#1f2937',
      priceBg: '#ffe4e6',
      priceBorder: '#e11d48',
      priceText: '#1f2937'
    };
  }

  if(theme === 'ocean'){
    return {
      bg: '#ecfeff',
      tileBg: '#ffffff',
      tileBorder: '#a5f3fc',
      text: '#0f172a',
      muted: '#475569',
      imgFallback: '#cffafe',
      badgeBg: '#cffafe',
      badgeBorder: '#0891b2',
      badgeBorderAlt: '#ef4444',
      badgeText: '#0f172a',
      priceBg: '#cffafe',
      priceBorder: '#0891b2',
      priceText: '#0f172a'
    };
  }

  if(theme === 'forest'){
    return {
      bg: '#f0fdf4',
      tileBg: '#ffffff',
      tileBorder: '#bbf7d0',
      text: '#052e16',
      muted: '#166534',
      imgFallback: '#dcfce7',
      badgeBg: '#dcfce7',
      badgeBorder: '#16a34a',
      badgeBorderAlt: '#ef4444',
      badgeText: '#052e16',
      priceBg: '#dcfce7',
      priceBorder: '#16a34a',
      priceText: '#052e16'
    };
  }

  if(theme === 'naturefantasy'){
    return {
      bg: '#f5f1e6',
      tileBg: '#fffaf0',
      tileBorder: '#c0b18f',
      text: '#2f2a1f',
      muted: '#635b42',
      imgFallback: '#ece3ce',
      badgeBg: '#ece3ce',
      badgeBorder: '#5f6f3a',
      badgeBorderAlt: '#ef4444',
      badgeText: '#2f2a1f',
      priceBg: '#ece3ce',
      priceBorder: '#5f6f3a',
      priceText: '#2f2a1f'
    };
  }

  if(theme === 'sunset'){
    return {
      bg: '#fff7ed',
      tileBg: '#ffffff',
      tileBorder: '#fed7aa',
      text: '#1f2937',
      muted: '#6b7280',
      imgFallback: '#ffedd5',
      badgeBg: '#ffedd5',
      badgeBorder: '#f97316',
      badgeBorderAlt: '#ef4444',
      badgeText: '#1f2937',
      priceBg: '#ffedd5',
      priceBorder: '#f97316',
      priceText: '#1f2937'
    };
  }

  if(theme === 'autumn'){
    return {
      bg: '#fff7f7',
      tileBg: '#ffffff',
      tileBorder: '#ff8a8a',
      text: '#4b0a0a',
      muted: '#8a2b2b',
      imgFallback: '#ffe0e0',
      badgeBg: '#ffe0e0',
      badgeBorder: '#dc2626',
      badgeBorderAlt: '#ef4444',
      badgeText: '#4b0a0a',
      priceBg: '#ffe0e0',
      priceBorder: '#dc2626',
      priceText: '#4b0a0a'
    };
  }

  if(theme === 'prored'){
    return {
      bg: '#f6efef',
      tileBg: '#fff8f8',
      tileBorder: '#d8b0b0',
      text: '#2c1b1b',
      muted: '#6f4a4a',
      imgFallback: '#f3e2e2',
      badgeBg: '#f3e2e2',
      badgeBorder: '#b03a3a',
      badgeBorderAlt: '#ef4444',
      badgeText: '#2c1b1b',
      priceBg: '#f3e2e2',
      priceBorder: '#b03a3a',
      priceText: '#2c1b1b'
    };
  }

  if(theme === 'emerald'){
    return {
      bg: '#0c1118',
      tileBg: '#141c28',
      tileBorder: '#2f425e',
      text: '#e7eef8',
      muted: '#9fb1c8',
      imgFallback: '#1e2b40',
      badgeBg: '#1e2b40',
      badgeBorder: '#38bdf8',
      badgeBorderAlt: '#ef4444',
      badgeText: '#e7eef8',
      priceBg: '#1e2b40',
      priceBorder: '#38bdf8',
      priceText: '#e7eef8'
    };
  }

  // classic
  return {
    bg: '#ffffff',
    tileBg: '#ffffff',
    tileBorder: '#d1d5db',
    text: '#111827',
    muted: '#6b7280',
    imgFallback: '#f3f4f6',
    badgeBg: '#f3f4f6',
    badgeBorder: '#111827',
    badgeBorderAlt: '#111827',
    badgeText: '#111827',
    priceBg: '#f3f4f6',
    priceBorder: '#111827',
    priceText: '#111827'
  };
}

function normalizeStateFromStorage(maybe){
  const s = (maybe && typeof maybe === 'object') ? maybe : {};
  const result = {
    ...migrateBuiltinListsFromSource(s),
    settings: normalizeSettingsFromStorage(s?.settings)
  };
  for(const t of result.settings.customTabs) result[t.key] = Array.isArray(s[t.key]) ? s[t.key] : [];
  return result;
}

function normalizeAllowCopyText(value){
  return value === true || value === 1;
}

function normalizeSettingsFromStorage(maybeSettings){
  const s = (maybeSettings && typeof maybeSettings === 'object') ? maybeSettings : {};
  const customTabs = (Array.isArray(s.customTabs) ? s.customTabs : [])
    .filter(t => t && typeof t.key === 'string' && t.key.startsWith('custom_') && typeof t.label === 'string')
    .map(t => ({ key: t.key, label: String(t.label).trim().slice(0, 30) || 'Custom' }));
  const lastSavedAt = Number(s.lastSavedAt);
  return {
    theme: normalizeThemeValue(s.theme),
    imageSource: (s.imageSource === 'cdn' || s.imageSource === 'info' || s.imageSource === 'auto')
      ? s.imageSource
      : 'cdn',
    allowCopyText: normalizeAllowCopyText(s.allowCopyText),
    customTabs,
    tabOrder: normalizeBuiltinKeyList(s.tabOrder),
    hiddenTabs: normalizeBuiltinKeyList(s.hiddenTabs),
    lastSavedAt: Number.isFinite(lastSavedAt) && lastSavedAt > 0 ? lastSavedAt : 0
  };
}

function mergeCustomTabDefs(...customTabLists){
  const merged = [];
  const seen = new Set();
  for(const list of customTabLists){
    const normalized = normalizeSettingsFromStorage({ customTabs: list }).customTabs;
    for(const tab of normalized){
      if(!tab?.key || seen.has(tab.key)) continue;
      seen.add(tab.key);
      merged.push(tab);
    }
  }
  return merged;
}

function pickPreferredSectionItems(primaryState, secondaryState, sectionKey){
  const first = Array.isArray(primaryState?.[sectionKey]) ? primaryState[sectionKey] : [];
  const second = Array.isArray(secondaryState?.[sectionKey]) ? secondaryState[sectionKey] : [];
  return first.length >= second.length ? first : second;
}

function mergePersistedListState(localState, legacySyncState, preferredSettings, fallbackSettings){
  const mergedSettings = normalizeSettingsFromStorage({
    ...preferredSettings,
    customTabs: mergeCustomTabDefs(
      preferredSettings?.customTabs,
      localState?.settings?.customTabs,
      legacySyncState?.settings?.customTabs,
      fallbackSettings?.customTabs
    )
  });

  const mergedState = {
    ...createBuiltinListState(),
    settings: mergedSettings
  };

  for(const tab of BUILTIN_TABS){
    mergedState[tab.key] = pickPreferredSectionItems(localState, legacySyncState, tab.key);
  }

  for(const tab of mergedSettings.customTabs){
    if(!tab?.key) continue;
    mergedState[tab.key] = pickPreferredSectionItems(localState, legacySyncState, tab.key);
  }

  return mergedState;
}

function settingsStateScore(maybeSettings){
  const s = normalizeSettingsFromStorage(maybeSettings);
  return (s.customTabs.length * 1000)
    + (s.tabOrder.length * 100)
    + (s.hiddenTabs.length * 10)
    + (s.allowCopyText ? 1 : 0)
    + (s.theme !== 'classic' ? 1 : 0)
    + (s.imageSource !== 'cdn' ? 1 : 0);
}

function areSettingsEqual(a, b){
  return JSON.stringify(normalizeSettingsFromStorage(a)) === JSON.stringify(normalizeSettingsFromStorage(b));
}

function pickPreferredSettings(primary, secondary){
  const first = normalizeSettingsFromStorage(primary);
  const second = normalizeSettingsFromStorage(secondary);
  if(first.lastSavedAt !== second.lastSavedAt){
    return first.lastSavedAt > second.lastSavedAt ? first : second;
  }
  const firstScore = settingsStateScore(first);
  const secondScore = settingsStateScore(second);
  if(firstScore !== secondScore){
    return firstScore > secondScore ? first : second;
  }
  return first;
}

function buildSettingsContentFingerprint(maybeSettings){
  const s = normalizeSettingsFromStorage(maybeSettings);
  return JSON.stringify({
    theme: s.theme,
    imageSource: s.imageSource,
    allowCopyText: s.allowCopyText,
    customTabs: s.customTabs,
    tabOrder: s.tabOrder,
    hiddenTabs: s.hiddenTabs
  });
}

function syncSettingsRetryDelayMs(errorMessage){
  const msg = String(errorMessage || '');
  if(/MAX_WRITE_OPERATIONS_PER_HOUR/i.test(msg)) return 60 * 60 * 1000 + 1000;
  if(/MAX_WRITE_OPERATIONS_PER_MINUTE/i.test(msg)) return 65 * 1000;
  return 5000;
}

function queueSyncSettingsWrite(nextSettings, options){
  const opts = (options && typeof options === 'object') ? options : {};
  const normalized = normalizeSettingsFromStorage(nextSettings);
  const nextJson = JSON.stringify(normalized);

  if(!opts.force && nextJson === lastSyncedSettingsPayloadJson){
    queuedSyncSettings = null;
    return;
  }

  queuedSyncSettings = normalized;

  if(opts.immediate){
    if(syncSettingsDebounceTimer){
      clearTimeout(syncSettingsDebounceTimer);
      syncSettingsDebounceTimer = 0;
    }
    void flushSyncSettingsWrite();
    return;
  }

  if(syncSettingsDebounceTimer) clearTimeout(syncSettingsDebounceTimer);
  syncSettingsDebounceTimer = setTimeout(()=>{
    syncSettingsDebounceTimer = 0;
    void flushSyncSettingsWrite();
  }, SYNC_SETTINGS_DEBOUNCE_MS);
}

async function flushSyncSettingsWrite(){
  if(syncSettingsWriteInFlight) return;
  if(!queuedSyncSettings) return;

  const now = safeNow();
  if(syncSettingsRetryAt > now){
    const wait = Math.max(250, syncSettingsRetryAt - now);
    if(syncSettingsRetryTimer) clearTimeout(syncSettingsRetryTimer);
    syncSettingsRetryTimer = setTimeout(()=>{
      syncSettingsRetryTimer = 0;
      void flushSyncSettingsWrite();
    }, wait);
    return;
  }

  const payload = normalizeSettingsFromStorage(queuedSyncSettings);
  const payloadJson = JSON.stringify(payload);
  if(payloadJson === lastSyncedSettingsPayloadJson){
    queuedSyncSettings = null;
    return;
  }

  syncSettingsWriteInFlight = true;
  const result = await storageSet('sync', SYNC_SETTINGS_KEY, payload);
  syncSettingsWriteInFlight = false;

  if(result.ok){
    lastSyncedSettingsPayloadJson = payloadJson;
    if(queuedSyncSettings && JSON.stringify(normalizeSettingsFromStorage(queuedSyncSettings)) === payloadJson){
      queuedSyncSettings = null;
    }
    syncSettingsRetryAt = 0;
    if(syncSettingsRetryTimer){
      clearTimeout(syncSettingsRetryTimer);
      syncSettingsRetryTimer = 0;
    }
    if(queuedSyncSettings) void flushSyncSettingsWrite();
    return;
  }

  const delay = syncSettingsRetryDelayMs(result.error);
  syncSettingsRetryAt = safeNow() + delay;
  if(syncSettingsRetryTimer) clearTimeout(syncSettingsRetryTimer);
  syncSettingsRetryTimer = setTimeout(()=>{
    syncSettingsRetryTimer = 0;
    void flushSyncSettingsWrite();
  }, delay);
  const msg = String(result.error || '');
  if(/MAX_WRITE_OPERATIONS_PER_MINUTE|MAX_WRITE_OPERATIONS_PER_HOUR/i.test(msg)){
    console.info('Sync settings write throttled; retry scheduled.');
  }else{
    console.warn('sync settings set deferred:', result.error);
  }
}

function countItemsInState(s){
  if(!s) return 0;
  let count = BUILTIN_TABS.reduce((sum, tab)=> sum + (Number(s?.[tab.key]?.length) || 0), 0);
  const customTabs = Array.isArray(s?.settings?.customTabs) ? s.settings.customTabs : [];
  for(const t of customTabs) count += (Number(s?.[t.key]?.length) || 0);
  return count;
}

function storageGet(area, key){
  return new Promise((resolve)=>{
    try{
      chrome.storage[area].get([key], (res)=>{
        const err = chrome.runtime?.lastError;
        resolve({ value: res ? res[key] : undefined, error: err ? String(err.message || err) : '' });
      });
    }catch(e){
      resolve({ value: undefined, error: String(e && e.message ? e.message : e) });
    }
  });
}

function storageSet(area, key, value){
  return new Promise((resolve)=>{
    try{
      chrome.storage[area].set({ [key]: value }, ()=>{
        const err = chrome.runtime?.lastError;
        resolve({ ok: !err, error: err ? String(err.message || err) : '' });
      });
    }catch(e){
      resolve({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  });
}

async function loadState(){
  const [legacySyncRes, localRes, syncSettingsRes] = await Promise.all([
    storageGet('sync', SYNC_KEY),
    storageGet('local', LOCAL_KEY),
    storageGet('sync', SYNC_SETTINGS_KEY)
  ]);

  if(legacySyncRes.error) console.warn('sync get failed:', legacySyncRes.error);
  if(syncSettingsRes.error) console.warn('sync settings get failed:', syncSettingsRes.error);
  if(localRes.error) console.warn('local get failed:', localRes.error);

  // Lists live in local. For backward compatibility, we still *read* legacy sync full-state.
  const legacySyncState = normalizeStateFromStorage(legacySyncRes.value);
  const localState = normalizeStateFromStorage(localRes.value);

  // Settings are small enough to sync reliably.
  const syncedSettingsOnly = normalizeSettingsFromStorage(syncSettingsRes.value);
  const haveSyncedSettings = !!(syncSettingsRes.value && typeof syncSettingsRes.value === 'object');
  const mergedSettingsBase = haveSyncedSettings
    ? pickPreferredSettings(pickPreferredSettings(localState.settings, legacySyncState.settings), syncedSettingsOnly)
    : pickPreferredSettings(localState.settings, legacySyncState.settings);

  state = mergePersistedListState(localState, legacySyncState, mergedSettingsBase, syncedSettingsOnly);
  const mergedSettings = state.settings;
  lastSettingsContentFingerprint = buildSettingsContentFingerprint(mergedSettings);
  lastSyncedSettingsPayloadJson = haveSyncedSettings ? JSON.stringify(syncedSettingsOnly) : '';

  if(!haveSyncedSettings || !areSettingsEqual(mergedSettings, syncedSettingsOnly)){
    queueSyncSettingsWrite(mergedSettings, { immediate: true, force: true });
  }
  const normalizedLocalState = normalizeStateFromStorage(localRes.value);
  if(JSON.stringify(state) !== JSON.stringify(normalizedLocalState)){
    const repairedLocal = await storageSet('local', LOCAL_KEY, state);
    if(!repairedLocal.ok) console.warn('local settings repair failed:', repairedLocal.error);
  }else if(sourceHasLegacyBuiltinKeys(localRes.value) || sourceHasLegacyBuiltinKeys(legacySyncRes.value)){
    const repairedLocal = await storageSet('local', LOCAL_KEY, state);
    if(!repairedLocal.ok) console.warn('local legacy key repair failed:', repairedLocal.error);
  }
}

async function saveState(){
  const normalizedSettings = normalizeSettingsFromStorage(state.settings || {});
  const nextFingerprint = buildSettingsContentFingerprint(normalizedSettings);
  const settingsChanged = nextFingerprint !== lastSettingsContentFingerprint;

  if(settingsChanged){
    state.settings = normalizeSettingsFromStorage({ ...normalizedSettings, lastSavedAt: safeNow() });
    lastSettingsContentFingerprint = nextFingerprint;
    queueSyncSettingsWrite(state.settings);
  }else{
    const keepLastSavedAt = Number(normalizedSettings.lastSavedAt) || 0;
    state.settings = normalizeSettingsFromStorage({ ...normalizedSettings, lastSavedAt: keepLastSavedAt });
  }

  // Always persist locally (higher quotas; reliable across extension reload).
  const local = await storageSet('local', LOCAL_KEY, state);
  if(!local.ok) console.warn('local set failed:', local.error);
}

async function saveLocalStateSnapshot(){
  const local = await storageSet('local', LOCAL_KEY, state);
  if(!local.ok) console.warn('local snapshot failed:', local.error);
}

function buildYwCdnImageUrlFromId(itemId){
  const id = Number(itemId);
  if(!Number.isFinite(id) || id <= 0) return '';

  // Provider CDN pathing uses the first 4 digits of the item id (zero-padded)
  // as folder segments, e.g. 26295 -> /26/29/26295/26295.png
  // This matches how yoworld.info constructs CDN URLs.
  const s = String(Math.trunc(id)).padStart(4, '0');
  const g1 = s.substring(0, 2);
  const g2 = s.substring(2, 4);
  return `https://yw-web.yoworld.com/cdn/items/${g1}/${g2}/${id}/${id}.png`;
}

function buildYwCdnImageUrlFromIdWithExt(itemId, ext){
  const id = Number(itemId);
  if(!Number.isFinite(id) || id <= 0) return '';
  const safeExt = String(ext || 'png').trim().toLowerCase();
  const e = (safeExt === 'jpg' || safeExt === 'jpeg' || safeExt === 'png' || safeExt === 'webp' || safeExt === 'gif') ? safeExt : 'png';
  const s = String(Math.trunc(id)).padStart(4, '0');
  const g1 = s.substring(0, 2);
  const g2 = s.substring(2, 4);
  return `https://yw-web.yoworld.com/cdn/items/${g1}/${g2}/${id}/${id}.${e}`;
}

function buildYwApiItemImageUrlFromId(itemId, size){
  const id = Number(itemId);
  if(!Number.isFinite(id) || id <= 0) return '';
  // The provider image API supports a limited set of sizes; 130_100 is reliable.
  const sz = (typeof size === 'string' && /^\d+_\d+$/.test(size.trim())) ? size.trim() : '130_100';
  return `https://api.yoworld.info/api/items/${id}/image/${sz}`;
}

function unwrapProviderInfoProxyInnerUrl(proxyUrl){
  const u = (typeof proxyUrl === 'string') ? proxyUrl.trim() : '';
  if(!u) return '';
  const m = u.match(/api\.yoworld\.info\/extension\.php\?[\s\S]*?\bx=([^&\s#]+)/i);
  if(!m || !m[1]) return '';
  try{ return decodeURIComponent(m[1]); }catch{ return ''; }
}

function isProviderInfoProxyToPng(proxyUrl){
  const inner = unwrapProviderInfoProxyInnerUrl(proxyUrl);
  return !!inner && /\.png(\?|#|$)/i.test(inner);
}

function providerInfoProxyUrlForImageUrl(imageUrl){
  const u = (typeof imageUrl === 'string') ? imageUrl.trim() : '';
  if(!u) return '';
  if(/^https?:\/\/api\.yoworld\.info\/extension\.php\?x=/i.test(u)) return u;
  if(!/^https?:\/\//i.test(u)) return '';
  return `https://api.yoworld.info/extension.php?x=${encodeURIComponent(u)}`;
}

function deepFindImageUrl(obj){
  // Best-effort: crawl a few levels looking for an absolute URL that looks like an image.
  const isImageUrl = (s)=>{
    if(typeof s !== 'string') return false;
    const u = s.trim();
    if(!/^https?:\/\//i.test(u)) return false;
    if(/\.(png|jpg|jpeg|webp)(\?|#|$)/i.test(u)) return true;
    // Some services omit extensions but still serve images.
    if(/image|cdn\/items|thumbnail|icon/i.test(u)) return true;
    return false;
  };

  const seen = new Set();
  const q = [{ v: obj, d: 0 }];
  while(q.length){
    const { v, d } = q.shift();
    if(!v || d > 4) continue;
    if(typeof v === 'string'){
      if(isImageUrl(v)) return v.trim();
      continue;
    }
    if(typeof v !== 'object') continue;
    if(seen.has(v)) continue;
    seen.add(v);

    if(Array.isArray(v)){
      for(const x of v) q.push({ v: x, d: d + 1 });
    }else{
      for(const k of Object.keys(v)) q.push({ v: v[k], d: d + 1 });
    }
  }
  return '';
}

function extractProviderInfoImageUrl(detail, itemId){
  const candidates = [
    detail?.image_url,
    detail?.imageUrl,
    detail?.image,
    detail?.image_path,
    detail?.img,
    detail?.icon,
    detail?.icon_url,
    detail?.thumbnail,
    detail?.thumbnail_url,
    detail?.cdn_image_url,
    detail?.cdnImageUrl
  ].filter(Boolean);

  for(const c of candidates){
    if(typeof c !== 'string') continue;
    const u = c.trim();
    if(!u) continue;
    if(/^https?:\/\//i.test(u)) return u;
    // Some APIs return relative paths
    if(u.startsWith('/')) return `https://yoworld.info${u}`;
  }

  const deep = deepFindImageUrl(detail);
  if(deep) return deep;

  // Fallback: if not provided, leave empty.
  // (We still have the provider CDN-derived URL.)
  void itemId;
  return '';
}

function bestImageUrlForItem(item){
  if(!item) return '';
  const s = (v)=> (typeof v === 'string' ? v.trim() : '');
  const source = imageSourceFromState();
  const direct = s(item.imageUrl);
  const cdn = s(item.ywCdnImageUrl) || buildYwCdnImageUrlFromId(item.id);
  const api = buildYwApiItemImageUrlFromId(item.id, '130_100');
  const storedInfo = s(item.ywInfoImageUrl);
  const info = storedInfo || api || providerInfoProxyUrlForImageUrl(cdn || direct);

  if(source === 'info'){
    // Avoid getting stuck on the extension.php proxy-to-missing-png placeholder (it can load as a black image).
    if(storedInfo && !isProviderInfoProxyToPng(storedInfo)) return storedInfo;
    return api || storedInfo || direct || cdn;
  }
  if(source === 'auto') return direct || cdn || api || info;
  return direct || cdn || info;
}

async function ensureInfoImageUrl(entry, currentUrl){
  if(!entry || !entry.id) return '';

  const cur = (typeof currentUrl === 'string') ? currentUrl.trim() : '';
  const existingInfo = (typeof entry.ywInfoImageUrl === 'string') ? entry.ywInfoImageUrl.trim() : '';
  if(existingInfo && existingInfo !== cur && !isProviderInfoProxyToPng(existingInfo)) return existingInfo;

  // Primary strategy: use the provider image proxy for the derived CDN URL.
  // This endpoint often returns a valid PNG even when the direct CDN URL 404s.

  const cdnPng = (typeof entry.ywCdnImageUrl === 'string' && entry.ywCdnImageUrl.trim())
    ? entry.ywCdnImageUrl.trim()
    : buildYwCdnImageUrlFromId(entry.id);

  if(cdnPng && !entry.ywCdnImageUrl) entry.ywCdnImageUrl = cdnPng;

  const cdnJpg = buildYwCdnImageUrlFromIdWithExt(entry.id, 'jpg');
  const proxyPng = providerInfoProxyUrlForImageUrl(cdnPng || entry.imageUrl);
  const proxyJpg = providerInfoProxyUrlForImageUrl(cdnJpg);
  const apiImg = buildYwApiItemImageUrlFromId(entry.id, '130_100');

  // Prefer real assets (CDN .jpg) and the reliable API image endpoint before the extension proxy.
  // The proxy can return a "valid" image even when the underlying CDN URL is missing (black placeholder).
  const candidates = [];
  if(existingInfo && !isProviderInfoProxyToPng(existingInfo)) candidates.push(existingInfo);
  candidates.push(
    cdnJpg,
    apiImg,
    cdnPng,
    proxyPng,
    proxyJpg,
    existingInfo,
    (typeof entry.imageUrl === 'string' ? entry.imageUrl.trim() : '')
  );

  for(const u of candidates){
    if(u && u !== cur){
      entry.ywInfoImageUrl = u;
      return u;
    }
  }

  try{
    const detail = await apiItemDetail(entry.id);
    const u = extractProviderInfoImageUrl(detail, entry.id);
    if(u){
      entry.ywInfoImageUrl = u;
      return u;
    }
  }catch{}
  return '';
}

async function apiSearch(query){
  const r = await apiSearchPaged(query, 1, 12);
  return r.items;
}

async function apiSearchPaged(query, page, itemsPerPage){
  const q = String(query || '').trim();
  const p = Math.max(1, Math.floor(Number(page) || 1));
  const ipp = Math.min(50, Math.max(1, Math.floor(Number(itemsPerPage) || 12)));
  const url = `https://api.yoworld.info/api/items/search?query=${encodeURIComponent(q)}&page=${p}&itemsPerPage=${ipp}&itemCategoryId=-1`;
  const res = await fetch(url, { credentials: 'omit' });
  if(!res.ok) throw new Error('Search failed');
  const json = await res.json();
  const pag = json?.data?.pagination || {};
  return {
    items: Array.isArray(pag?.data) ? pag.data : [],
    page: Number(pag?.current_page) || p,
    lastPage: Number(pag?.last_page) || 1,
    total: Number(pag?.total) || 0,
    perPage: Number(pag?.per_page) || ipp
  };
}

let listSearchPager = {
  query: '',
  page: 0,
  lastPage: 0,
  perPage: 12,
  loading: false
};

// Multi-select support for Add Item search results
let listSearchSelection = new Set(); // Set<string itemId>
let listSearchItemCache = new Map(); // Map<string itemId, { id:number, name?:string }>
let listSearchCurrentPageIds = []; // string[]
let listSearchBulkBusy = false;

function clearListSearchSelection(){
  listSearchSelection = new Set();
  updateListSearchBulkUi();
  syncListSearchResultCheckboxes();
}

function ensureListSearchBulkUi(){
  const resultsRoot = $('#results');
  if(!resultsRoot) return;
  if($('#results-bulkbar')) return;

  const bar = el('div','inline');
  bar.id = 'results-bulkbar';
  bar.style.justifyContent = 'space-between';
  bar.style.flexWrap = 'wrap';
  bar.style.marginTop = '6px';
  bar.hidden = true;

  const left = el('div','hint');
  left.id = 'results-selected-label';
  left.style.marginTop = '0';
  left.textContent = '0 selected';

  const right = el('div','inline');
  right.style.flexWrap = 'wrap';
  right.style.justifyContent = 'flex-end';

  const btnSelPage = el('button','ghost');
  btnSelPage.id = 'btn-results-select-page';
  btnSelPage.type = 'button';
  btnSelPage.textContent = 'Select page';

  const btnClearSel = el('button','ghost');
  btnClearSel.id = 'btn-results-clear-selection';
  btnClearSel.type = 'button';
  btnClearSel.textContent = 'Clear selection';

  const btnAddSel = el('button','primary');
  btnAddSel.id = 'btn-results-add-selected';
  btnAddSel.type = 'button';
  btnAddSel.textContent = 'Add Selected';

  btnSelPage.addEventListener('click', ()=>{
    for(const id of listSearchCurrentPageIds){
      if(id) listSearchSelection.add(String(id));
    }
    updateListSearchBulkUi();
    syncListSearchResultCheckboxes();
  });

  btnClearSel.addEventListener('click', ()=>{
    clearListSearchSelection();
  });

  btnAddSel.addEventListener('click', ()=>{
    void bulkAddSelectedSearchResults();
  });

  right.appendChild(btnSelPage);
  right.appendChild(btnClearSel);
  right.appendChild(btnAddSel);

  bar.appendChild(left);
  bar.appendChild(right);

  // Insert above results.
  resultsRoot.parentElement?.insertBefore(bar, resultsRoot);
  updateListSearchBulkUi();
}

function updateListSearchBulkUi(){
  const bar = $('#results-bulkbar');
  const label = $('#results-selected-label');
  const btnSelPage = $('#btn-results-select-page');
  const btnClearSel = $('#btn-results-clear-selection');
  const btnAddSel = $('#btn-results-add-selected');

  if(label) label.textContent = `${listSearchSelection.size} selected`;

  const hasQuery = !!String(listSearchPager?.query || '').trim();
  const show = hasQuery; // show bar whenever results paging is active
  if(bar) bar.hidden = !show;

  const hasSelection = listSearchSelection.size > 0;
  if(btnAddSel) btnAddSel.disabled = listSearchBulkBusy || !hasSelection;
  if(btnSelPage) btnSelPage.disabled = listSearchBulkBusy || !(listSearchCurrentPageIds && listSearchCurrentPageIds.length);
  if(btnClearSel) btnClearSel.disabled = listSearchBulkBusy || !hasSelection;
}

function syncListSearchResultCheckboxes(){
  const resultsRoot = $('#results');
  if(!resultsRoot) return;
  resultsRoot.querySelectorAll('input.result-sel[data-id]').forEach((inp)=>{
    const id = String(inp.getAttribute('data-id') || '');
    inp.checked = listSearchSelection.has(id);
  });
}

async function addItemFromSearchResult(section, it, note, opts){
  const options = opts && typeof opts === 'object' ? opts : {};
  const id = Number(it?.id) || 0;
  if(!id) return { status: 'error', id, message: 'Missing item id' };

  state[section] = state[section] || [];

  const existing = (state[section] || []).find(e=>String(e?.id) === String(id));
  const trimmedNote = String(note || '').trim();
  if(existing){
    if(trimmedNote){
      if(options.updateNoteOnDup){
        existing.note = trimmedNote;
        await saveState();
        render();
        revealSectionItem(section, existing.key);
        return { status: 'updated', id, key: existing.key, section };
      }
      if(options.allowPromptDup !== false){
        const ok = confirm('This item is already in this section. Update its note instead?');
        if(ok){
          existing.note = trimmedNote;
          await saveState();
          render();
          revealSectionItem(section, existing.key);
          return { status: 'updated', id, key: existing.key, section };
        }
      }
    }else if(options.allowPromptDup !== false){
      alert('Duplicate detected: this item is already in this section.');
    }
    revealSectionItem(section, existing.key);
    return { status: 'duplicate', id, key: existing.key, section };
  }

  let activeInStore = false;
  let fullName = String(it?.name || '').trim();
  let infoImageUrl = '';
  try{
    const detail = await apiItemDetailCached(id);
    activeInStore = !!detail?.active_in_store;
    if(detail?.name) fullName = String(detail.name);
  }catch{
    activeInStore = false;
  }

  const cdnImageUrl = buildYwCdnImageUrlFromId(id);
  infoImageUrl = buildYwApiItemImageUrlFromId(id, '130_100');
  const source = imageSourceFromState();
  let chosenImageUrl = cdnImageUrl;
  if(source === 'info'){
    chosenImageUrl = infoImageUrl || cdnImageUrl;
  }else if(source === 'auto'){
    chosenImageUrl = cdnImageUrl || infoImageUrl;
  }

  const entry = {
    key: keyFor(section, id),
    id,
    name: fullName || `Item ${id}`,
    note: trimmedNote,
    imageUrl: chosenImageUrl,
    ywCdnImageUrl: cdnImageUrl,
    ywInfoImageUrl: infoImageUrl,
    activeInStore,
    addedAt: Date.now()
  };

  state[section].push(entry);
  await saveState();
  render();
  revealSectionItem(section, entry.key);
  return { status: 'added', id, key: entry.key, section };
}

async function bulkAddSelectedSearchResults(){
  if(listSearchBulkBusy) return;
  ensureListSearchBulkUi();

  const ids = Array.from(listSearchSelection);
  if(!ids.length) return;

  const section = $('#in-section')?.value || DEFAULT_TAB_KEY;
  const note = ($('#in-note')?.value || '').trim();

  if(ids.length >= 25){
    const ok = confirm(`Add ${ids.length} selected items to "${section}"?`);
    if(!ok) return;
  }

  listSearchBulkBusy = true;
  updateListSearchBulkUi();

  let added = 0;
  let updated = 0;
  let dup = 0;
  let failed = 0;

  const label = $('#results-selected-label');
  const total = ids.length;

  for(let i=0;i<ids.length;i++){
    const idStr = String(ids[i] || '').trim();
    const it = listSearchItemCache.get(idStr) || { id: Number(idStr) || 0, name: '' };
    if(label) label.textContent = `Adding ${i+1}/${total}… (${added} added)`;
    try{
      const r = await addItemFromSearchResult(section, it, note, {
        allowPromptDup: false,
        updateNoteOnDup: !!note
      });
      if(r.status === 'added') added++;
      else if(r.status === 'updated') updated++;
      else if(r.status === 'duplicate') dup++;
      else failed++;
    }catch(e){
      console.error(e);
      failed++;
    }
  }

  listSearchBulkBusy = false;
  updateListSearchBulkUi();

  // Keep selection so user can re-run with a different note if desired.
  setTimeout(()=>{
    const msg = `Done: ${added} added` + (updated ? `, ${updated} updated` : '') + (dup ? `, ${dup} duplicates` : '') + (failed ? `, ${failed} failed` : '');
    setStatusLineForSearch(msg);
  }, 0);
}

function setStatusLineForSearch(msg){
  const label = $('#results-selected-label');
  if(label) label.textContent = String(msg || '');
}

function setResultsPagerVisible(visible){
  const pager = $('#results-pager');
  if(pager) pager.hidden = !visible;
}

function updateResultsPagerUi(){
  const prevBtn = $('#btn-results-prev');
  const nextBtn = $('#btn-results-next');
  const label = $('#results-page-label');

  const hasQuery = !!String(listSearchPager.query || '').trim();
  const page = Math.max(1, Math.floor(Number(listSearchPager.page) || 1));
  const lastPage = Math.max(1, Math.floor(Number(listSearchPager.lastPage) || 1));
  const show = hasQuery && (lastPage > 1);

  setResultsPagerVisible(show || listSearchPager.loading);
  if(label){
    label.textContent = listSearchPager.loading ? 'Loading…' : `Page ${page} / ${lastPage}`;
  }
  if(prevBtn) prevBtn.disabled = listSearchPager.loading || page <= 1;
  if(nextBtn) nextBtn.disabled = listSearchPager.loading || page >= lastPage;
}

function renderSearchResultRow(it, resultsRoot){
  const row = el('div','result');

  ensureListSearchBulkUi();
  const sel = el('input','result-sel');
  sel.type = 'checkbox';
  sel.setAttribute('aria-label', 'Select item');
  sel.setAttribute('data-id', String(it.id));
  sel.checked = listSearchSelection.has(String(it.id));
  sel.addEventListener('change', ()=>{
    const idStr = String(it.id);
    if(sel.checked) listSearchSelection.add(idStr);
    else listSearchSelection.delete(idStr);
    // Keep a minimal cache so bulk add works across pages.
    listSearchItemCache.set(idStr, { id: Number(it.id) || 0, name: String(it.name || '') });
    updateListSearchBulkUi();
  });
  row.appendChild(sel);

  const thumb = el('img','thumb');
  thumb.src = buildYwCdnImageUrlFromId(it.id);
  thumb.alt = it.name || 'Item';
  thumb.loading = 'lazy';
  thumb.referrerPolicy = 'no-referrer';
  thumb.addEventListener('error', async()=>{
    const stage = Number(thumb.dataset.fallbackStage || '0');
    if(stage >= 3) return;
    thumb.dataset.fallbackStage = String(stage + 1);
    const current = String(thumb.currentSrc || thumb.src || '').trim();
    const cdnJpg = buildYwCdnImageUrlFromIdWithExt(it.id, 'jpg');
    const proxyJpg = providerInfoProxyUrlForImageUrl(cdnJpg);
    const proxyPng = providerInfoProxyUrlForImageUrl(buildYwCdnImageUrlFromId(it.id));
    const next = stage === 0 ? cdnJpg : (stage === 1 ? proxyJpg : proxyPng);
    if(next && next !== current) thumb.src = next;
  });
  row.appendChild(thumb);

  const meta = el('div','meta');
  const name = el('div','name');
  name.textContent = it.name || '(Unnamed)';
  meta.appendChild(name);

  const small = el('div','small');
  small.textContent = `ID: ${it.id}`;
  meta.appendChild(small);

  const store = el('div','small');
  store.textContent = 'In store: ...';
  meta.appendChild(store);
  row.appendChild(meta);

  // Fetch store status asynchronously so results render fast.
  void (async()=>{
    try{
      const detail = await apiItemDetailCached(it.id);
      if(store.isConnected){
        store.textContent = `In store: ${detail?.active_in_store ? 'Yes' : 'No'}`;
      }
    }catch{
      if(store.isConnected){
        store.textContent = 'In store: No';
      }
    }
  })();

  const add = el('button');
  add.type = 'button';
  add.textContent = 'Add';
  add.addEventListener('click', async()=>{
    const section = $('#in-section')?.value || DEFAULT_TAB_KEY;
    const note = ($('#in-note')?.value || '').trim();
    await addItemFromSearchResult(section, it, note, { allowPromptDup: true, updateNoteOnDup: false });
  });
  row.appendChild(add);

  resultsRoot.appendChild(row);
}

async function loadListSearchPage(page){
  const resultsRoot = $('#results');
  if(!resultsRoot) return;
  if(listSearchPager.loading) return;

  const q = String(listSearchPager.query || '').trim();
  if(!q){
    setResultsPagerVisible(false);
    return;
  }

  const targetPage = Math.max(1, Math.floor(Number(page) || 1));

  listSearchPager.loading = true;
  updateResultsPagerUi();
  ensureListSearchBulkUi();
  updateListSearchBulkUi();
  resultsRoot.innerHTML = '';

  try{
    const r = await apiSearchPaged(q, targetPage, listSearchPager.perPage || 12);
    listSearchPager.page = Number(r.page) || targetPage;
    listSearchPager.lastPage = Number(r.lastPage) || 1;
    listSearchPager.perPage = Number(r.perPage) || (listSearchPager.perPage || 12);

    const items = Array.isArray(r.items) ? r.items : [];
    listSearchCurrentPageIds = items.map(x=> String(x?.id || '')).filter(Boolean);
    for(const x of items){
      if(x && x.id) listSearchItemCache.set(String(x.id), { id: Number(x.id) || 0, name: String(x.name || '') });
    }
    updateListSearchBulkUi();
    if(!items.length){
      const d = el('div');
      d.className = 'hint';
      d.textContent = 'No results.';
      resultsRoot.appendChild(d);
      return;
    }

    for(const it of items){
      if(!it || !it.id) continue;
      renderSearchResultRow(it, resultsRoot);
    }
    syncListSearchResultCheckboxes();
  }catch(e){
    console.error(e);
    const d = el('div');
    d.className = 'hint';
    d.textContent = 'Search failed.';
    resultsRoot.appendChild(d);
    // Keep pager hidden on failure to avoid confusing navigation.
    listSearchPager.lastPage = 1;
    listSearchPager.page = 1;
  }finally{
    listSearchPager.loading = false;
    updateListSearchBulkUi();
    updateResultsPagerUi();
  }
}

function clearListSearch(){
  const q = $('#in-query');
  const resultsRoot = $('#results');
  if(q) q.value = '';
  if(resultsRoot) resultsRoot.innerHTML = '';
  listSearchPager = { query: '', page: 0, lastPage: 0, perPage: listSearchPager?.perPage || 12, loading: false };
  updateResultsPagerUi();
  clearListSearchSelection();
  persistDraftForTab(getActiveTab());
}

function goPrevListSearchPage(){
  const page = Math.max(1, Math.floor(Number(listSearchPager.page) || 1));
  if(page <= 1) return;
  void loadListSearchPage(page - 1);
}

function goNextListSearchPage(){
  const page = Math.max(1, Math.floor(Number(listSearchPager.page) || 1));
  const lastPage = Math.max(1, Math.floor(Number(listSearchPager.lastPage) || 1));
  if(page >= lastPage) return;
  void loadListSearchPage(page + 1);
}

async function apiItemDetail(id){
  const url = `https://api.yoworld.info/api/items/${encodeURIComponent(String(id))}`;
  const res = await fetch(url, { credentials: 'omit' });
  if(!res.ok) throw new Error('Item detail failed');
  const json = await res.json();
  return json?.data?.item || null;
}

const ITEM_DETAIL_CACHE = new Map();
function apiItemDetailCached(id){
  const key = String(id);
  if(ITEM_DETAIL_CACHE.has(key)) return ITEM_DETAIL_CACHE.get(key);
  const p = apiItemDetail(id).catch((e)=>{
    ITEM_DETAIL_CACHE.delete(key);
    throw e;
  });
  ITEM_DETAIL_CACHE.set(key, p);
  return p;
}

function firstUrlFromText(text){
  const s = String(text || '');
  const m = s.match(/https?:\/\/[^\s"'<>]+/i);
  return m ? m[0] : '';
}

function extractItemIdFromUrl(url){
  const u = String(url || '').trim();
  if(!u) return 0;

  // Unwrap provider image proxy URLs (these often wrap the CDN URL in x=...)
  // Example: https://api.yoworld.info/extension.php?x=<encoded-cdn-url>
  try{
    const proxyMatch = u.match(/api\.yoworld\.info\/extension\.php\?[^\s#]*\bx=([^&\s#]+)/i);
    if(proxyMatch && proxyMatch[1]){
      const inner = decodeURIComponent(proxyMatch[1]);
      const innerId = extractItemIdFromUrl(inner);
      if(innerId) return innerId;
    }
  }catch{}

  // api.yoworld.info item endpoint
  let m = u.match(/api\.yoworld\.info\/api\/items\/(\d+)/i);
  if(m) return Number(m[1]) || 0;

  // yoworld.info item pages commonly include an ID in the path
  m = u.match(/yoworld\.info\/(?:item|items)\/(\d+)/i);
  if(m) return Number(m[1]) || 0;

  // Sometimes it's a slug with an ID in it
  m = u.match(/yoworld\.info\/[^\s\/]+\/(\d+)[^\s\/]*$/i);
  if(m) return Number(m[1]) || 0;

  // CDN URL ends with /<id>/<id>.png
  m = u.match(/\/cdn\/items\/[0-9]{2}\/[0-9]{2}\/(\d+)\/(\d+)\.png/i);
  if(m) return Number(m[2] || m[1]) || 0;

  // Some CDN variants / formats
  m = u.match(/\/cdn\/items\/[0-9]{2}\/[0-9]{2}\/(\d+)\/(\d+)\.(png|jpg|jpeg|webp)/i);
  if(m) return Number(m[2] || m[1]) || 0;

  // Fallback: first long-ish number in URL
  m = u.match(/\b(\d{4,})\b/);
  if(m) return Number(m[1]) || 0;
  return 0;
}

async function addItemById(section, itemId, note){
  const id = Number(itemId);
  if(!Number.isFinite(id) || id <= 0){
    alert('Could not detect an item ID from the dropped content.');
    return { status: 'error', id: 0, section, key: '' };
  }

  state[section] = state[section] || [];

  // Duplicate detection
  const existing = (state[section] || []).find(e=>String(e?.id) === String(id));
  if(existing){
    const n = String(note || '').trim();
    if(n){
      const ok = confirm('This item is already in this section. Update its note instead?');
      if(ok){
        existing.note = n;
        await saveState();
        render();
        revealSectionItem(section, existing.key);
        return { status: 'updated', id, key: existing.key, section };
      }
    }else{
      alert('Duplicate detected: this item is already in this section.');
    }
    revealSectionItem(section, existing.key);
    return { status: 'duplicate', id, key: existing.key, section };
  }

  let activeInStore = false;
  let fullName = '';
  let infoImageUrl = '';
  try{
    const detail = await apiItemDetail(id);
    activeInStore = !!detail?.active_in_store;
    if(detail?.name) fullName = detail.name;
  }catch{}

  const cdnImageUrl = buildYwCdnImageUrlFromId(id);
  infoImageUrl = buildYwApiItemImageUrlFromId(id, '130_100');
  const source = imageSourceFromState();
  let chosenImageUrl = cdnImageUrl;
  if(source === 'info'){
    chosenImageUrl = infoImageUrl || cdnImageUrl;
  }else if(source === 'auto'){
    chosenImageUrl = cdnImageUrl || infoImageUrl;
  }

  const entry = {
    key: keyFor(section, id),
    id,
    name: fullName || `Item ${id}`,
    note: String(note || '').trim(),
    imageUrl: chosenImageUrl,
    ywCdnImageUrl: cdnImageUrl,
    ywInfoImageUrl: infoImageUrl,
    activeInStore,
    addedAt: Date.now()
  };

  state[section].push(entry);
  await saveState();
  render();
  revealSectionItem(section, entry.key);
  return { status: 'added', id, key: entry.key, section };
}

function wireSidePanelDrop(){
  const zone = $('#drop-zone');
  if(!zone || wireSidePanelDrop._wired) return;
  wireSidePanelDrop._wired = true;

  zone.addEventListener('dragover', (e)=>{
    e.preventDefault();
    zone.classList.add('is-over');
    try{ e.dataTransfer.dropEffect = 'copy'; }catch{}
  });
  zone.addEventListener('dragleave', ()=>zone.classList.remove('is-over'));
  zone.addEventListener('drop', async(e)=>{
    e.preventDefault();
    zone.classList.remove('is-over');

    let url = '';
    try{
      url = e.dataTransfer.getData('text/uri-list') || '';
      if(!url) url = firstUrlFromText(e.dataTransfer.getData('text/plain'));
      if(!url) url = firstUrlFromText(e.dataTransfer.getData('text/html'));
    }catch{}

    if(!url){
      alert('Drop an item link (URL).');
      flashDropZoneMessage('Drop an item link (URL).', 'error');
      return;
    }

    const id = extractItemIdFromUrl(url);
    const section = $('#in-section')?.value || getActiveTab() || DEFAULT_TAB_KEY;
    const note = ($('#in-note')?.value || '').trim();
    const result = await addItemById(section, id, note);
    const sectionLabel = getListTabLabel(section);
    if(result?.status === 'added') flashDropZoneMessage(`Added item ${result.id} to ${sectionLabel}.`, 'success');
    else if(result?.status === 'updated') flashDropZoneMessage(`Updated existing item ${result.id} in ${sectionLabel}.`, 'success');
    else if(result?.status === 'duplicate') flashDropZoneMessage(`Item ${result.id} is already in ${sectionLabel}.`, 'error');
  });
}
wireSidePanelDrop._wired = false;

function storeBadge(active){
  const span = el('span', 'badge ' + (active ? 'instore' : 'notstore'));
  span.textContent = active ? 'IN STORE' : 'NOT IN STORE';
  return span;
}

function render(){
  BUILTIN_TABS.forEach((tab)=> renderGrid(tab.key, $('#grid-' + tab.key)));
  getCustomTabs().forEach(t => renderGrid(t.key, $('#grid-' + t.key)));
  updateExportPreviewSummary();
}

let dragState = {
  section: null,
  key: null,
  id: null
};

function moveItemByKey(fromSection, fromKey, toSection, beforeKey){
  if(!fromSection || !fromKey || !toSection) return false;

  state[fromSection] = state[fromSection] || [];
  state[toSection] = state[toSection] || [];

  if(fromSection === toSection){
    if(beforeKey) return reorderByKey(toSection, fromKey, beforeKey);
    const arr = (state[toSection] || []).slice();
    const fromIndex = arr.findIndex(x=>x && x.key === fromKey);
    if(fromIndex < 0) return false;
    const [moved] = arr.splice(fromIndex, 1);
    arr.push(moved);
    state[toSection] = arr;
    return true;
  }

  const fromArr = state[fromSection] || [];
  const fromIndex = fromArr.findIndex(x=>x && x.key === fromKey);
  if(fromIndex < 0) return false;
  const moved = fromArr[fromIndex];
  if(!moved) return false;

  // Prevent duplicates in the destination section (by item id).
  const toArr = state[toSection] || [];
  const dup = toArr.find(x=>x && String(x.id) === String(moved.id));
  if(dup){
    const srcNote = String(moved.note || '').trim();
    const dstNote = String(dup.note || '').trim();
    const wantsNote = srcNote && (!dstNote || srcNote !== dstNote);

    const msg = wantsNote
      ? 'That section already has this item.\n\nUpdate the existing item\'s note with the one you\'re moving, and remove it from the source section?'
      : 'That section already has this item.\n\nRemove it from the source section anyway?';
    const ok = confirm(msg);
    if(!ok) return false;

    if(wantsNote){
      dup.note = srcNote;
    }

    // Remove from source only.
    state[fromSection] = fromArr.filter(x=>x && x.key !== fromKey);
    return true;
  }

  // Remove from source.
  const newFrom = fromArr.slice();
  newFrom.splice(fromIndex, 1);
  state[fromSection] = newFrom;

  // Insert into destination.
  const newTo = toArr.slice();
  if(beforeKey){
    const toIndex = newTo.findIndex(x=>x && x.key === beforeKey);
    if(toIndex >= 0) newTo.splice(toIndex, 0, moved);
    else newTo.push(moved);
  }else{
    newTo.push(moved);
  }
  state[toSection] = newTo;
  return true;
}

function reorderByKey(section, fromKey, toKey){
  if(!section || !fromKey || !toKey) return false;
  const arr = (state[section] || []).slice();
  const fromIndex = arr.findIndex(x=>x && x.key === fromKey);
  const toIndex = arr.findIndex(x=>x && x.key === toKey);
  if(fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return false;
  const [moved] = arr.splice(fromIndex, 1);
  arr.splice(toIndex, 0, moved);
  state[section] = arr;
  return true;
}

function moveItemToTop(section, itemKey){
  if(!section || !itemKey) return false;
  const arr = (state[section] || []).slice();
  const fromIndex = arr.findIndex(x=>x && x.key === itemKey);
  if(fromIndex < 0) return false;
  if(fromIndex === 0) return false; // Already at top
  const [moved] = arr.splice(fromIndex, 1);
  arr.unshift(moved);
  state[section] = arr;
  return true;
}

function moveItemToBottom(section, itemKey){
  if(!section || !itemKey) return false;
  const arr = (state[section] || []).slice();
  const fromIndex = arr.findIndex(x=>x && x.key === itemKey);
  if(fromIndex < 0) return false;
  if(fromIndex === arr.length - 1) return false; // Already at bottom
  const [moved] = arr.splice(fromIndex, 1);
  arr.push(moved);
  state[section] = arr;
  return true;
}

function renderGrid(section, root){
  if(!root) return;
  root.dataset.section = section;

  // Get filter for this section
  const filterQuery = (sectionFilters[section] || '').trim().toLowerCase();

  if(!root._wiredDnD){
    root.addEventListener('dragover', (e)=>{
      if(!dragState?.key) return;
      // If we're over a tile, let the tile-level handler control insert position.
      const overTile = e.target && e.target.closest ? e.target.closest('.tile') : null;
      if(overTile) return;
      e.preventDefault();
      try{ e.dataTransfer.dropEffect = 'move'; }catch{}
      root.classList.add('is-drop-target');
    });
    root.addEventListener('dragleave', (e)=>{
      const rel = e.relatedTarget;
      if(rel && root.contains(rel)) return;
      root.classList.remove('is-drop-target');
    });
    root.addEventListener('drop', async(e)=>{
      if(!dragState?.key) return;
      // If the drop happened on a tile (or child of a tile), let the tile handler run.
      const onTile = e.target && e.target.closest ? e.target.closest('.tile') : null;
      if(onTile) return;
      e.preventDefault();
      root.classList.remove('is-drop-target');

      const fromSection = dragState.section;
      const fromKey = dragState.key;
      const toSection = section;
      if(moveItemByKey(fromSection, fromKey, toSection, null)){
        await saveState();
        render();
      }
    });
    root._wiredDnD = true;
  }

  root.innerHTML = '';
  const allItems = state[section] || [];
  
  // Filter items if there's a search query
  const items = filterQuery
    ? allItems.filter(item => {
        const name = (item.name || '').toLowerCase();
        const note = (item.note || '').toLowerCase();
        return name.includes(filterQuery) || note.includes(filterQuery);
      })
    : allItems;
  
  // Show filter hint if items are filtered
  if(filterQuery && items.length === 0 && allItems.length > 0){
    const hint = el('div', 'hint');
    hint.textContent = `No items match "${sectionFilters[section]}". Showing 0 of ${allItems.length} items.`;
    hint.style.padding = '20px';
    hint.style.textAlign = 'center';
    root.appendChild(hint);
    return;
  }
  
  if(filterQuery && items.length < allItems.length){
    const hint = el('div', 'hint');
    hint.textContent = `Showing ${items.length} of ${allItems.length} items.`;
    hint.style.padding = '10px';
    hint.style.textAlign = 'center';
    root.appendChild(hint);
  }
  
  const allowCopyText = normalizeAllowCopyText(state?.settings?.allowCopyText);
  for(const item of items){
    const tile = el('div','tile');
    tile.draggable = !allowCopyText;
    tile.dataset.key = item.key;
    tile.dataset.section = section;
    if(allowCopyText) tile.classList.add('allow-select');

    tile.addEventListener('dragstart', (e)=>{
      dragState = { section, key: item.key, id: item.id };
      tile.classList.add('is-dragging');
      try{
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.key);
        e.dataTransfer.setData('application/x-yoselection-item', JSON.stringify({ section, key: item.key, id: item.id }));
      }catch{}
    });

    tile.addEventListener('dragend', ()=>{
      tile.classList.remove('is-dragging');
      dragState = { section: null, key: null, id: null };
      root.querySelectorAll('.tile.is-drop-target').forEach(t=>t.classList.remove('is-drop-target'));
      root.classList.remove('is-drop-target');
      document.querySelectorAll('.tab.is-drop-target').forEach(t=>t.classList.remove('is-drop-target'));
    });

    tile.addEventListener('dragover', (e)=>{
      if(!dragState.key) return;
      if(dragState.section === section && dragState.key === item.key) return;
      e.preventDefault();
      e.stopPropagation();
      try{ e.dataTransfer.dropEffect = 'move'; }catch{}
      tile.classList.add('is-drop-target');
    });

    tile.addEventListener('dragleave', ()=>{
      tile.classList.remove('is-drop-target');
    });

    tile.addEventListener('drop', async (e)=>{
      if(!dragState.key) return;
      e.preventDefault();
      e.stopPropagation();
      tile.classList.remove('is-drop-target');
      const fromKey = dragState.key;
      const toKey = item.key;
      const fromSection = dragState.section;
      const toSection = section;

      const changed = moveItemByKey(fromSection, fromKey, toSection, toKey);
      if(changed){
        await saveState();
        render();
      }
    });

    const imgWrap = el('div','imgwrap');

    const img = el('img');
    img.src = bestImageUrlForItem(item);
    img.alt = item.name || 'Item';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', async()=>{
      // Some items use .jpg on the CDN (not .png). Also, the proxy can fail.
      // Allow a few sequential fallbacks instead of giving up after the first.
      const stage = Number(img.dataset.fallbackStage || '0');
      if(stage >= 4) return;
      img.dataset.fallbackStage = String(stage + 1);

      const current = String(img.currentSrc || img.src || '').trim();
      const next = await ensureInfoImageUrl(item, current);
      if(next && next !== current){
        if(item.imageUrl !== next){
          item.imageUrl = next;
          try{ await saveState(); }catch{}
        }
        img.src = next;
        return;
      }

      // Last resort: try swapping .png <-> .jpg directly on CDN.
      const cdnJpg = buildYwCdnImageUrlFromIdWithExt(item?.id, 'jpg');
      const cdnPng = buildYwCdnImageUrlFromIdWithExt(item?.id, 'png');
      const alt = (current && current.endsWith('.jpg')) ? cdnPng : cdnJpg;
      if(alt && alt !== current){
        item.imageUrl = alt;
        img.src = alt;
        try{ await saveState(); }catch{}
      }
    });
    imgWrap.appendChild(img);

    const edit = el('button','imgedit');
    edit.type = 'button';
    edit.title = 'Edit note/price';
    edit.setAttribute('aria-label', 'Edit note/price');
    edit.textContent = 'Edit';
    edit.addEventListener('mousedown', (e)=>{
      // Prevent drag from starting when pressing the button.
      e.stopPropagation();
      e.preventDefault();
    });
    edit.addEventListener('click', async(e)=>{
      e.stopPropagation();
      const current = String(item.note || '');
      const next = prompt('Note / price (leave blank to clear):', current);
      if(next === null) return;
      item.note = String(next).trim();
      await saveState();
      render();
    });
    imgWrap.appendChild(edit);

    tile.appendChild(imgWrap);

    const pad = el('div','tpad');
    const name = el('div','tname');
    name.textContent = item.name || '(Unnamed)';
    name.title = item.name || '';
    pad.appendChild(name);

    const note = el('div','tnote');
    note.textContent = item.note || '';
    pad.appendChild(note);

    const row = el('div','trow');
    row.appendChild(storeBadge(!!item.activeInStore));

    const moveTop = el('button','move-btn');
    moveTop.type = 'button';
    moveTop.textContent = '↑';
    moveTop.title = 'Move to top';
    moveTop.addEventListener('click', async()=>{
      if(moveItemToTop(section, item.key)){
        await saveState();
        render();
      }
    });
    row.appendChild(moveTop);

    const moveBottom = el('button','move-btn');
    moveBottom.type = 'button';
    moveBottom.textContent = '↓';
    moveBottom.title = 'Move to bottom';
    moveBottom.addEventListener('click', async()=>{
      if(moveItemToBottom(section, item.key)){
        await saveState();
        render();
      }
    });
    row.appendChild(moveBottom);

    const x = el('button','x');
    x.type = 'button';
    x.textContent = '×';
    x.title = 'Remove';
    x.addEventListener('click', async()=>{
      state[section] = (state[section]||[]).filter(it=>it.key !== item.key);
      await saveState();
      render();
    });
    row.appendChild(x);

    pad.appendChild(row);
    tile.appendChild(pad);
    root.appendChild(tile);
  }
}

function keyFor(section, id){
  return `${section}:${id}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2,7)}`;
}

function clearAddItemFields(){
  const q = $('#in-query');
  const n = $('#in-note');
  const r = $('#results');
  if(q) q.value = '';
  if(n) n.value = '';
  if(r) r.innerHTML = '';
  listSearchPager = { query: '', page: 0, lastPage: 0, perPage: listSearchPager?.perPage || 12, loading: false };
  updateResultsPagerUi();
  clearListSearchSelection();
  persistDraftForTab(getActiveTab());
}

function clearPriceCheckFields(){
  const q = $('#pc-query');
  if(q) q.value = '';
}

async function tryQuickAddFromAddItemInputs(){
  const raw = ($('#in-query')?.value || '').trim();
  if(!raw) return false;

  const maybeUrl = firstUrlFromText(raw) || raw;
  const idFromUrl = /^https?:\/\//i.test(maybeUrl) ? extractItemIdFromUrl(maybeUrl) : 0;
  const fromNum = Number(raw);
  const id = (idFromUrl > 0) ? idFromUrl : (Number.isFinite(fromNum) ? fromNum : 0);
  if(!(id > 0)) return false;

  const section = $('#in-section')?.value || getActiveTab() || DEFAULT_TAB_KEY;
  const note = ($('#in-note')?.value || '').trim();
  await addItemById(section, id, note);
  clearAddItemFields();
  return true;
}

async function tryQuickAddFromPriceCheckInputs(){
  const raw = ($('#pc-query')?.value || '').trim();
  if(!raw) return false;
  const fromUrl = extractItemIdFromUrl(raw);
  const fromNum = Number(raw);
  const id = (fromUrl > 0) ? fromUrl : (Number.isFinite(fromNum) ? fromNum : 0);
  if(!(id > 0)) return false;

  await addItemById(SPECIAL_PC_TAB_KEY, id, '');
  clearPriceCheckFields();
  return true;
}

async function doSearch(){
  const prevQuery = String(listSearchPager?.query || '').trim();
  const q = ($('#in-query')?.value || '').trim();
  const resultsRoot = $('#results');
  if(!resultsRoot) return;
  resultsRoot.innerHTML = '';
  listSearchPager = { query: '', page: 0, lastPage: 0, perPage: listSearchPager?.perPage || 12, loading: false };
  updateResultsPagerUi();
  ensureListSearchBulkUi();
  if(q !== prevQuery) clearListSearchSelection();
  updateListSearchBulkUi();
  if(!q){
    const d = el('div');
    d.className = 'hint';
    d.textContent = 'Type a search term.';
    resultsRoot.appendChild(d);
    return;
  }

  // Support pasting an item link OR an image link.
  // Even if the image URL is dead, it often contains the item ID.
  const maybeUrl = firstUrlFromText(q) || q;
  if(/^https?:\/\//i.test(maybeUrl)){
    const id = extractItemIdFromUrl(maybeUrl);
    if(id > 0){
      setResultsPagerVisible(false);
      // URL-search is a one-off add row; selection UI does not apply.
      clearListSearchSelection();
      const row = el('div','result');
      const thumb = el('img','thumb');
      thumb.src = buildYwCdnImageUrlFromId(id);
      thumb.alt = `Item ${id}`;
      thumb.loading = 'lazy';
      thumb.referrerPolicy = 'no-referrer';
      thumb.addEventListener('error', async()=>{
        const stage = Number(thumb.dataset.fallbackStage || '0');
        if(stage >= 3) return;
        thumb.dataset.fallbackStage = String(stage + 1);
        const current = String(thumb.currentSrc || thumb.src || '').trim();
        const cdnJpg = buildYwCdnImageUrlFromIdWithExt(id, 'jpg');
        const proxyJpg = providerInfoProxyUrlForImageUrl(cdnJpg);
        const proxyPng = providerInfoProxyUrlForImageUrl(buildYwCdnImageUrlFromId(id));
        const next = stage === 0 ? cdnJpg : (stage === 1 ? proxyJpg : proxyPng);
        if(next && next !== current) thumb.src = next;
      });
      row.appendChild(thumb);

      const meta = el('div','meta');
      const name = el('div','name');
      name.textContent = `Item ${id}`;
      meta.appendChild(name);
      const small = el('div','small');
      small.textContent = `ID: ${id}`;
      meta.appendChild(small);

      const store = el('div','small');
      store.textContent = 'In store: ...';
      meta.appendChild(store);
      row.appendChild(meta);

      // Try to resolve a friendly name, but don't block Add.
      void (async()=>{
        try{
          const detail = await apiItemDetailCached(id);
          const resolved = String(pick(detail, ['name','item_name','title']) || '').trim();
          if(resolved){
            name.textContent = resolved;
            thumb.alt = resolved;
          }

          if(store.isConnected){
            store.textContent = `In store: ${detail?.active_in_store ? 'Yes' : 'No'}`;
          }
        }catch{}
      })();

      const add = el('button');
      add.type = 'button';
      add.textContent = 'Add';
      add.addEventListener('click', async()=>{
        const section = $('#in-section')?.value || DEFAULT_TAB_KEY;
        const note = ($('#in-note')?.value || '').trim();
        await addItemById(section, id, note);
        clearAddItemFields();
      });
      row.appendChild(add);

      resultsRoot.appendChild(row);
      return;
    }
  }

  listSearchPager = {
    query: q,
    page: 1,
    lastPage: 1,
    perPage: listSearchPager?.perPage || 12,
    loading: false
  };
  updateResultsPagerUi();
  ensureListSearchBulkUi();
  updateListSearchBulkUi();
  await loadListSearchPage(1);
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines){
  const words = String(text||'').split(/\s+/).filter(Boolean);
  let line = '';
  let lines = 0;

  for(const w of words){
    const test = line ? (line + ' ' + w) : w;
    if(ctx.measureText(test).width <= maxWidth){
      line = test;
      continue;
    }
    ctx.fillText(line, x, y);
    y += lineHeight;
    lines += 1;
    line = w;
    if(lines >= maxLines - 1) break;
  }
  if(lines < maxLines){
    ctx.fillText(line, x, y);
  }
}

function wrapLines(ctx, text, maxWidth, maxLines){
  const words = String(text||'').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  let truncated = false;

  for(const w of words){
    const test = line ? (line + ' ' + w) : w;
    if(ctx.measureText(test).width <= maxWidth){
      line = test;
      continue;
    }

    if(line) lines.push(line);
    line = w;

    if(lines.length >= maxLines - 1){
      // Last line: fit remaining with ellipsis.
      const rest = [line, ...words.slice(words.indexOf(w)+1)].join(' ');
      const fitted = fitTextToWidth(ctx, rest, maxWidth);
      lines.push(fitted);
      truncated = fitted.endsWith('…');
      return { lines, truncated };
    }
  }

  if(line) lines.push(line);
  // If we used up maxLines but still had words, we'd have returned above.
  return { lines: lines.slice(0, maxLines), truncated };
}

function fitTextToWidth(ctx, text, maxWidth){
  const t = String(text || '');
  if(ctx.measureText(t).width <= maxWidth) return t;
  const ell = '…';
  let lo = 0;
  let hi = t.length;
  while(lo < hi){
    const mid = Math.floor((lo + hi) / 2);
    const cand = t.slice(0, mid) + ell;
    if(ctx.measureText(cand).width <= maxWidth) lo = mid + 1;
    else hi = mid;
  }
  const n = Math.max(0, lo - 1);
  return (n <= 0) ? ell : (t.slice(0, n) + ell);
}

function drawCenteredPillText(ctx, text, x, y, w, h, bg, border, color){
  ctx.save();
  const padX = 10;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  const maxTextW = Math.max(0, w - padX * 2);
  const fitted = fitTextToWidth(ctx, text, maxTextW);
  const textW = ctx.measureText(fitted).width;
  const pillW = Math.min(w, Math.max(44, textW + padX * 2));
  const px = x + (w - pillW) / 2;

  ctx.fillStyle = bg;
  roundRect(ctx, px, y, pillW, h, Math.floor(h / 2));
  ctx.fill();
  ctx.strokeStyle = border;
  ctx.lineWidth = 2;
  roundRect(ctx, px, y, pillW, h, Math.floor(h / 2));
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.fillText(fitted, x + w / 2, y + h / 2);
  ctx.restore();
}

async function loadImage(url){
  return new Promise((resolve, reject)=>{
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onload = ()=>resolve(img);
    img.onerror = ()=>reject(new Error('img load fail'));
    img.src = url;
  });
}

async function loadImageWithFallback(primaryUrl, itemId){
  if(!primaryUrl) return null;
  
  const attempts = [primaryUrl];
  
  // Add .jpg/.png alternatives if URL ends with an image extension
  if(primaryUrl.endsWith('.png')){
    attempts.push(primaryUrl.replace(/\.png$/i, '.jpg'));
  }else if(primaryUrl.endsWith('.jpg') || primaryUrl.endsWith('.jpeg')){
    attempts.push(primaryUrl.replace(/\.jpe?g$/i, '.png'));
  }
  
  // Add provider image API as fallback if we have an itemId
  if(itemId){
    attempts.push(`https://api.yoworld.info/api/items/${itemId}/image/130_100`);
  }
  
  for(const url of attempts){
    try{
      const img = await loadImage(url);
      return img;
    }catch{
      // Try next URL
      continue;
    }
  }
  
  return null;
}

async function canLoadImage(url, timeoutMs){
  const u = String(url || '').trim();
  if(!u) return false;
  const ms = Number.isFinite(timeoutMs) ? timeoutMs : 4500;
  return new Promise((resolve)=>{
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    let done = false;
    const finish = (ok)=>{
      if(done) return;
      done = true;
      try{ img.onload = null; img.onerror = null; }catch{}
      resolve(!!ok);
    };
    const t = setTimeout(()=>finish(false), ms);
    img.onload = ()=>{ clearTimeout(t); finish(true); };
    img.onerror = ()=>{ clearTimeout(t); finish(false); };
    // Bust caches so we don't get stuck on a cached broken response.
    const sep = u.includes('?') ? '&' : '?';
    img.src = u + sep + 'cb=' + Date.now().toString(36);
  });
}

function exportSectionsForScope(scope){
  const allLists = getAllListTabDefs().map((tab)=> ({ key: tab.key, title: tab.exportTitle || tab.label }));

  let s = scope;
  if(s === 'active') s = getActiveTab();
  const validScopeKeys = allLists.map(x => x.key);
  if(s !== 'all' && !validScopeKeys.includes(s)) s = DEFAULT_TAB_KEY;
  if(s === 'all' || !s) return allLists;

  const one = allLists.find(x=>x.key === s);
  return one ? [one] : allLists;
}

function exportPresetConfigs(){
  return {
    // Forums Wishlist: one forum-ready post page with 50 items arranged as 10x5.
    'forum-wishlist': { scope: 'wl', pageSize: '50', itemLimit: '50', exportScale: '100' },
    'forum-standard': { scope: '', pageSize: '25', itemLimit: '50', exportScale: '100' },
    'archive': { scope: '', pageSize: '50', itemLimit: '0', exportScale: '115' }
  };
}

function setExportPresetValues(presetKey){
  const cfg = exportPresetConfigs()[presetKey];
  if(!cfg) return;

  const scopeSel = $('#export-scope');
  const pageSizeSel = $('#export-wish-pagesize');
  const limitSel = $('#export-item-limit');
  const scaleSel = $('#export-scale');

  if(scopeSel && cfg.scope) scopeSel.value = cfg.scope;
  if(pageSizeSel) pageSizeSel.value = cfg.pageSize;
  if(limitSel) limitSel.value = cfg.itemLimit;
  if(scaleSel) scaleSel.value = cfg.exportScale;
}

function detectCurrentExportPreset(){
  const scope = $('#export-scope')?.value || 'active';
  const pageSize = $('#export-wish-pagesize')?.value || '25';
  const itemLimit = $('#export-item-limit')?.value || '0';
  const exportScale = $('#export-scale')?.value || '100';

  const presets = exportPresetConfigs();
  for(const [key, cfg] of Object.entries(presets)){
    if((!cfg.scope || cfg.scope === scope)
      && cfg.pageSize === pageSize
      && cfg.itemLimit === itemLimit
      && cfg.exportScale === exportScale){
      return key;
    }
  }
  // No "Custom" preset option: fall back to Standard.
  return 'forum-standard';
}

function syncExportPresetSelection(){
  const presetSel = $('#export-preset');
  if(!presetSel) return;
  presetSel.value = detectCurrentExportPreset();
  updateExportAdvancedControlsVisibility();
}

function updateExportAdvancedControlsVisibility(){
  const advancedRow = $('#export-advanced-controls');
  if(!advancedRow) return;
  // Preset-only workflow: hide manual controls.
  advancedRow.hidden = true;
}

function getExportUiOptions(){
  const presetKey = $('#export-preset')?.value || 'forum-standard';
  const presetCfg = exportPresetConfigs()[presetKey] || null;
  const scope = (presetKey === 'forum-wishlist')
    ? (presetCfg?.scope || 'wl')
    : ($('#export-scope')?.value || 'active');
  const pageSizeRaw = parseInt($('#export-wish-pagesize')?.value || '25', 10);
  const pageSize = (pageSizeRaw === 8 || pageSizeRaw === 20 || pageSizeRaw === 25 || pageSizeRaw === 35 || pageSizeRaw === 50) ? pageSizeRaw : 25;
  const itemLimitRaw = parseInt($('#export-item-limit')?.value || '0', 10);
  const itemLimit = (itemLimitRaw === 25 || itemLimitRaw === 50) ? itemLimitRaw : 0;
  const exportScaleRaw = parseInt($('#export-scale')?.value || '100', 10);
  const exportScale = exportScaleRaw === 85 ? 0.85 : (exportScaleRaw === 115 ? 1.15 : 1);
  return {
    presetKey,
    layoutMode: presetKey === 'forum-wishlist' ? 'forum-wishlist' : 'default',
    scope,
    includeStoreTags: true,
    pageSize,
    itemLimit,
    exportScale
  };
}

function estimateExportJobs(opts){
  const safe = (opts && typeof opts === 'object') ? opts : getExportUiOptions();
  const sections = exportSectionsForScope(safe.scope);
  return sections.map((s)=>{
    let allItems = state?.[s.key] || [];
    if(safe.itemLimit > 0) allItems = allItems.slice(0, safe.itemLimit);
    const itemCount = Array.isArray(allItems) ? allItems.length : 0;
    const pageCount = Math.max(1, Math.ceil(itemCount / Math.max(1, safe.pageSize)));
    return {
      key: s.key,
      itemCount,
      pageCount
    };
  });
}

function updateExportPreviewSummary(){
  const out = $('#export-preview-summary');
  if(!out) return;

  const opts = getExportUiOptions();
  const jobs = estimateExportJobs(opts);
  const files = jobs.reduce((n, j)=> n + j.pageCount, 0);
  const items = jobs.reduce((n, j)=> n + j.itemCount, 0);
  const limitLabel = opts.itemLimit > 0 ? `first ${opts.itemLimit}/list` : 'all items';
  const scalePct = Math.round(opts.exportScale * 100);
  const layoutLabel = opts.layoutMode === 'forum-wishlist' ? ' • 10x5 forum layout' : '';
  out.textContent = `Preview: ${files} file(s) • ${items} item(s) • ${opts.pageSize}/image • ${limitLabel} • ${scalePct}% • tags${layoutLabel}`;
}

function pick(obj, keys){
  for(const k of keys){
    if(obj && Object.prototype.hasOwnProperty.call(obj, k)) return obj[k];
  }
  return undefined;
}

function cloneJsonValue(value, fallback){
  try{
    return JSON.parse(JSON.stringify(value));
  }catch{}
  if(Array.isArray(fallback)) return [...fallback];
  if(fallback && typeof fallback === 'object') return { ...fallback };
  return fallback;
}

function isCustomListKey(key){
  return /^custom_[a-z0-9_]+$/i.test(String(key || '').trim());
}

function labelFromCustomListKey(key){
  const raw = String(key || '').trim();
  const base = raw.replace(/^custom_/i, '').replace(/[_-]+/g, ' ').trim();
  if(!base) return 'Custom';
  const label = base
    .split(/\s+/)
    .map((part)=> part ? (part[0].toUpperCase() + part.slice(1)) : '')
    .join(' ')
    .trim();
  return label.slice(0, 30) || 'Custom';
}

function inferCustomTabsFromLists(maybeListsSource){
  const source = (maybeListsSource && typeof maybeListsSource === 'object') ? maybeListsSource : {};
  const inferred = [];
  for(const [rawKey, entries] of Object.entries(source)){
    const key = String(rawKey || '').trim();
    if(!isCustomListKey(key)) continue;
    if(!Array.isArray(entries)) continue;
    inferred.push({ key, label: labelFromCustomListKey(key) });
  }
  return inferred;
}

function normalizeSettingsWithInferredCustomTabs(maybeSettings, maybeListsSource){
  const base = normalizeSettingsFromStorage(maybeSettings);
  const inferred = inferCustomTabsFromLists(maybeListsSource);
  const mergedCustomTabs = mergeCustomTabDefs(base.customTabs, inferred);
  return normalizeSettingsFromStorage({
    ...base,
    customTabs: mergedCustomTabs
  });
}

async function downloadBlobFile(blob, filename){
  if(!blob) throw new Error('No blob to download.');
  if(typeof document === 'undefined' || !document?.createElement) {
    throw new Error('Download is unavailable in this context.');
  }
  const safeName = String(filename || 'download.bin').trim() || 'download.bin';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeName;
  a.style.display = 'none';

  const parent = document.body || document.documentElement;
  if(parent && parent.appendChild) parent.appendChild(a);

  try{
    a.click();
  }finally{
    if(a.parentNode) a.parentNode.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(url), 3000);
  }
}

function backupTabKeysFromState(sourceState){
  const safeState = (sourceState && typeof sourceState === 'object') ? sourceState : {};
  const settings = normalizeSettingsWithInferredCustomTabs(safeState.settings, safeState);
  const customKeys = settings.customTabs
    .map((tab)=> String(tab?.key || '').trim())
    .filter(Boolean);
  return Array.from(new Set([...getBuiltinTabKeys(), ...customKeys]));
}

function buildDataBackupPayload(sourceState){
  const safeState = (sourceState && typeof sourceState === 'object') ? sourceState : state;
  const settings = normalizeSettingsWithInferredCustomTabs(safeState.settings, safeState);
  const lists = {};

  for(const key of backupTabKeysFromState({ settings })){
    const entries = Array.isArray(safeState[key]) ? safeState[key] : [];
    lists[key] = cloneJsonValue(entries, []);
  }

  let appVersion = '';
  try{ appVersion = String(chrome?.runtime?.getManifest?.()?.version || ''); }catch{}

  return {
    kind: BACKUP_KIND,
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    appVersion,
    settings: {
      theme: settings.theme,
      imageSource: settings.imageSource,
      allowCopyText: normalizeAllowCopyText(settings.allowCopyText),
      customTabs: cloneJsonValue(settings.customTabs, []),
      tabOrder: cloneJsonValue(settings.tabOrder, []),
      hiddenTabs: cloneJsonValue(settings.hiddenTabs, [])
    },
    lists
  };
}

async function exportDataBackupFile(){
  const payload = buildDataBackupPayload(state);
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await downloadBlobFile(blob, `wtb-wts-data-backup-${stamp}.json`);

  const customCount = Array.isArray(payload?.settings?.customTabs) ? payload.settings.customTabs.length : 0;
  alert(`Backup exported. Included ${customCount} custom tab${customCount === 1 ? '' : 's'}.`);
}

function normalizeImportedListEntries(rawEntries, sectionKey){
  if(!Array.isArray(rawEntries)) return [];
  const out = [];
  const seenKeys = new Set();

  for(const raw of rawEntries){
    if(!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;

    const idRaw = Number(raw.id);
    const itemId = Number.isFinite(idRaw) && idRaw > 0 ? Math.trunc(idRaw) : 0;

    let itemKey = String(raw.key || '').trim();
    if(!itemKey || seenKeys.has(itemKey)){
      itemKey = keyFor(sectionKey, itemId || (out.length + 1));
      while(seenKeys.has(itemKey)) itemKey = keyFor(sectionKey, itemId || (out.length + 1));
    }
    seenKeys.add(itemKey);

    const fallbackName = itemId > 0 ? `Item ${itemId}` : 'Unnamed Item';
    const itemName = String(raw.name || fallbackName).trim().slice(0, 140) || fallbackName;
    const itemNote = String(raw.note || '').trim().slice(0, 200);

    const one = {
      key: itemKey,
      id: itemId,
      name: itemName,
      note: itemNote,
      imageUrl: String(raw.imageUrl || '').trim(),
      ywCdnImageUrl: String(raw.ywCdnImageUrl || '').trim(),
      ywInfoImageUrl: String(raw.ywInfoImageUrl || '').trim(),
      activeInStore: !!raw.activeInStore
    };

    const addedAtRaw = Number(raw.addedAt);
    if(Number.isFinite(addedAtRaw) && addedAtRaw > 0) one.addedAt = Math.trunc(addedAtRaw);

    out.push(one);
  }

  return out;
}

function parseDataBackupPayloadText(text){
  const parsed = safeJsonParse(String(text || ''));
  if(!parsed || typeof parsed !== 'object' || Array.isArray(parsed)){
    throw new Error('Invalid JSON file.');
  }

  const kind = String(parsed.kind || '').trim();
  if(kind !== BACKUP_KIND && kind !== LEGACY_BACKUP_KIND){
    throw new Error('This is not a WTB & WTS backup file.');
  }

  const schemaVersion = Number(parsed.schemaVersion);
  if(!Number.isFinite(schemaVersion) || schemaVersion < 1){
    throw new Error('Backup schema version is missing or invalid.');
  }
  if(schemaVersion !== 1){
    throw new Error(`Backup schema version ${schemaVersion} is not supported in this build.`);
  }

  if(!parsed.settings || typeof parsed.settings !== 'object' || Array.isArray(parsed.settings)){
    throw new Error('Backup file is missing settings data.');
  }
  if(!parsed.lists || typeof parsed.lists !== 'object' || Array.isArray(parsed.lists)){
    throw new Error('Backup file is missing list data.');
  }

  const settings = normalizeSettingsWithInferredCustomTabs(parsed.settings, parsed.lists);
  const next = {
    ...createBuiltinListState(),
    settings
  };

  for(const key of backupTabKeysFromState({ settings })){
    next[key] = normalizeImportedListEntries(parsed.lists[key], key);
  }

  return {
    schemaVersion,
    exportedAt: String(parsed.exportedAt || ''),
    state: next
  };
}

function setStateForTests(nextState){
  state = normalizeStateFromStorage(nextState);
}

function readFileText(file){
  return new Promise((resolve, reject)=>{
    try{
      const reader = new FileReader();
      reader.onerror = ()=> reject(new Error('Could not read the selected file.'));
      reader.onload = ()=> resolve(String(reader.result || ''));
      reader.readAsText(file);
    }catch{
      reject(new Error('Could not read the selected file.'));
    }
  });
}

function refreshSettingsUiFromState(){
  const themeSelect = $('#suite-theme-select') || $('#theme-select');
  if(themeSelect) themeSelect.value = themeFromState();

  const imageSourceSelect = $('#suite-image-source-select') || $('#image-source-select');
  if(imageSourceSelect) imageSourceSelect.value = imageSourceFromState();

  const allowCopyTextCheckbox = $('#suite-allow-copy-text');
  if(allowCopyTextCheckbox) allowCopyTextCheckbox.checked = normalizeAllowCopyText(state?.settings?.allowCopyText);
}

async function applyImportedBackupState(importedState){
  state = normalizeStateFromStorage(importedState);
  sectionFilters = createSectionFilterState();
  for(const tab of getCustomTabs()){
    sectionFilters[tab.key] = sectionFilters[tab.key] || '';
  }

  buildTabsUI();
  const nextTab = isKnownTab(currentTab) ? currentTab : DEFAULT_TAB_KEY;
  setActiveTab(nextTab);
  applyTheme(themeFromState());
  refreshSettingsUiFromState();

  await saveState();
  render();
}

async function importDataBackupFile(file){
  if(!file) return false;
  const text = await readFileText(file);
  const parsed = parseDataBackupPayloadText(text);
  const nextState = parsed.state;

  const incomingItems = countItemsInState(nextState);
  const incomingCustomTabs = Array.isArray(nextState?.settings?.customTabs) ? nextState.settings.customTabs.length : 0;
  const incomingDate = parsed.exportedAt ? `\nBackup date: ${parsed.exportedAt}` : '';
  const ok = confirm(
    `Import backup from "${file.name}"?\n\n`
    + `This will replace your current lists and tab settings.\n`
    + `Incoming data: ${incomingItems} item(s), ${incomingCustomTabs} custom tab(s).`
    + incomingDate
  );
  if(!ok) return false;

  await applyImportedBackupState(nextState);
  alert(`Backup import complete. Restored ${incomingItems} item(s) across ${incomingCustomTabs} custom tab(s).`);
  return true;
}

async function copyTextToClipboard(text){
  const t = String(text || '');
  if(!t) return false;
  try{
    if(navigator?.clipboard?.writeText){
      await navigator.clipboard.writeText(t);
      return true;
    }
  }catch{}

  try{
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  }catch{}
  return false;
}

function providerItemPageUrl(itemId){
  const id = Number(itemId);
  if(!Number.isFinite(id) || id <= 0) return '';
  // Best guess; even if this path differs, we still show the API-based info.
  return `https://yoworld.info/items/${id}`;
}

async function priceCheckShowDetail(itemId){
  const root = $('#pc-detail');
  if(!root) return;
  root.innerHTML = '';

  const id = Number(itemId);
  if(!Number.isFinite(id) || id <= 0){
    root.appendChild(Object.assign(el('div','hint'), { textContent: 'Invalid item id.' }));
    return;
  }

  let detail = null;
  try{ detail = await apiItemDetail(id); }catch{}
  if(!detail){
    root.appendChild(Object.assign(el('div','hint'), { textContent: 'Could not load item details.' }));
    return;
  }

  const name = String(pick(detail, ['name','item_name','title']) || `Item ${id}`);
  const cdnImageUrl = buildYwCdnImageUrlFromId(id);
  const infoImageUrl = buildYwApiItemImageUrlFromId(id, '130_100');
  const imgUrl = bestImageUrlForItem({ id, imageUrl: '', ywCdnImageUrl: cdnImageUrl, ywInfoImageUrl: infoImageUrl });
  const link = providerItemPageUrl(id);

  // Load any saved notes/tags for this item.
  let noteState = { note: '', tags: [], updatedAt: 0 };
  try{
    const notesById = await loadPriceNotes();
    const existing = notesById[String(id)];
    if(existing && typeof existing === 'object'){
      noteState = {
        note: String(existing.note || ''),
        tags: normalizeTagList(existing.tags),
        updatedAt: Number(existing.updatedAt) || 0
      };
    }
  }catch{}

  // Remember last selected item (used as a convenience; not required for exporting).
  lastPriceCheckItem = {
    id,
    name,
    note: '',
    imageUrl: imgUrl,
    ywCdnImageUrl: cdnImageUrl,
    ywInfoImageUrl: infoImageUrl,
    activeInStore: !!detail?.active_in_store
  };

  const head = el('div');
  head.className = 'result';
  const img = el('img','thumb');
  img.src = imgUrl;
  img.alt = name;
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('error', async()=>{
    const stage = Number(img.dataset.fallbackStage || '0');
    if(stage >= 4) return;
    img.dataset.fallbackStage = String(stage + 1);

    const current = String(img.currentSrc || img.src || '').trim();
    const cdnJpg = buildYwCdnImageUrlFromIdWithExt(id, 'jpg');
    const proxyJpg = providerInfoProxyUrlForImageUrl(cdnJpg);
    const proxyPng = providerInfoProxyUrlForImageUrl(buildYwCdnImageUrlFromId(id));

    const next = stage === 0 ? cdnJpg : (stage === 1 ? proxyJpg : (stage === 2 ? proxyPng : ''));
    if(next && next !== current){
      img.src = next;
      if(lastPriceCheckItem && lastPriceCheckItem.id === id) lastPriceCheckItem.imageUrl = next;
      return;
    }

    // Final try: use the shared helper (may return stored/proxy candidates).
    if(stage === 3){
      const entry = (lastPriceCheckItem && lastPriceCheckItem.id === id)
        ? lastPriceCheckItem
        : { id, imageUrl: '', ywCdnImageUrl: cdnImageUrl, ywInfoImageUrl: infoImageUrl };
      const helperNext = await ensureInfoImageUrl(entry, current);
      if(helperNext && helperNext !== current){
        img.src = helperNext;
        if(lastPriceCheckItem && lastPriceCheckItem.id === id) lastPriceCheckItem.imageUrl = helperNext;
      }
    }
  });
  head.appendChild(img);
  const meta = el('div','meta');
  meta.appendChild(Object.assign(el('div','name'), { textContent: name }));
  meta.appendChild(Object.assign(el('div','small'), { textContent: `ID: ${id}` }));
  if(link){
    const a = document.createElement('a');
    a.href = link;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = 'Open item page';
    a.style.display = 'inline-block';
    a.style.marginTop = '4px';
    meta.appendChild(a);
  }
  head.appendChild(meta);
  root.appendChild(head);

  // Quick action: save this item to the PC list.
  {
    const actionsRow = el('div','inline');
    actionsRow.style.marginTop = '8px';
    const addBtn = el('button');
    addBtn.type = 'button';
    addBtn.textContent = 'Add to PC list';
    addBtn.addEventListener('click', async()=>{
      state[SPECIAL_PC_TAB_KEY] = state[SPECIAL_PC_TAB_KEY] || [];
      const existing = (state[SPECIAL_PC_TAB_KEY] || []).find(e=>String(e?.id) === String(id));
      if(existing){
        alert('Already in your PC list.');
        return;
      }

      const entry = {
        key: keyFor(SPECIAL_PC_TAB_KEY, id),
        id,
        name,
        note: '',
        imageUrl: imgUrl,
        ywCdnImageUrl: cdnImageUrl,
        ywInfoImageUrl: infoImageUrl,
        activeInStore: !!detail?.active_in_store,
        addedAt: Date.now()
      };
      state[SPECIAL_PC_TAB_KEY].push(entry);
      await saveState();
      render();
      setActiveTab(SPECIAL_PC_TAB_KEY);
    });
    actionsRow.appendChild(addBtn);
    root.appendChild(actionsRow);
  }

  // Price Notes (stored locally, separate from the saved list).
  {
    const box = el('div');
    box.className = 'row';
    box.style.marginTop = '10px';

    const lbl = el('div','lbl');
    lbl.textContent = 'Price Notes';
    box.appendChild(lbl);

    const noteTa = document.createElement('textarea');
    noteTa.value = noteState.note || '';
    noteTa.rows = 3;
    noteTa.placeholder = 'Example: last seen 2.5m, prefer 2.2m • seller: ...';
    noteTa.style.width = '100%';
    noteTa.style.resize = 'vertical';
    noteTa.style.padding = '8px';
    noteTa.style.borderRadius = '10px';
    noteTa.style.border = '1px solid var(--border)';
    noteTa.style.background = 'var(--surface)';
    noteTa.style.color = 'var(--text)';
    box.appendChild(noteTa);

    const tagRow = el('div','inline');
    tagRow.style.marginTop = '8px';
    tagRow.style.flexWrap = 'wrap';
    tagRow.style.gap = '8px';

    const tagsInput = document.createElement('input');
    tagsInput.type = 'text';
    tagsInput.placeholder = 'tags (comma-separated)';
    tagsInput.value = (noteState.tags || []).join(', ');
    tagsInput.style.flex = '1 1 220px';
    tagsInput.style.minWidth = '180px';
    tagsInput.style.padding = '8px';
    tagsInput.style.borderRadius = '999px';
    tagsInput.style.border = '1px solid var(--border)';
    tagsInput.style.background = 'var(--surface)';
    tagsInput.style.color = 'var(--text)';
    tagRow.appendChild(tagsInput);

    const saveBtn = el('button');
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save Notes';

    const stamp = el('div','hint');
    stamp.style.marginLeft = 'auto';
    const setStamp = (ts)=>{
      if(!ts) { stamp.textContent = ''; return; }
      try{
        const d = new Date(ts);
        stamp.textContent = `Saved ${d.toLocaleString()}`;
      }catch{ stamp.textContent = 'Saved.'; }
    };
    setStamp(noteState.updatedAt);

    const doSaveNotes = async()=>{
      const nextNote = String(noteTa.value || '').trim();
      const nextTags = normalizeTagList(tagsInput.value);
      const notesById = await loadPriceNotes();
      const updatedAt = Date.now();
      if(!nextNote && (!nextTags || !nextTags.length)){
        // If completely empty, delete the record.
        try{ delete notesById[String(id)]; }catch{}
      }else{
        notesById[String(id)] = { note: nextNote, tags: nextTags, updatedAt };
      }
      await savePriceNotes(notesById);
      setStamp(updatedAt);

      // If this item exists in the saved PC list, mirror the note into the tile note.
      try{
        const entry = (state[SPECIAL_PC_TAB_KEY] || []).find(e=>String(e?.id) === String(id));
        if(entry){
          entry.note = nextNote;
          await saveState();
          render();
        }
      }catch{}
    };

    saveBtn.addEventListener('click', ()=>{ void doSaveNotes(); });
    noteTa.addEventListener('keydown', (e)=>{
      if((e.ctrlKey || e.metaKey) && e.key === 'Enter'){
        e.preventDefault();
        void doSaveNotes();
      }
    });
    tagsInput.addEventListener('keydown', (e)=>{
      if(e.key === 'Enter'){
        e.preventDefault();
        void doSaveNotes();
      }
    });

    tagRow.appendChild(saveBtn);
    tagRow.appendChild(stamp);
    box.appendChild(tagRow);

    root.appendChild(box);
  }

  const msg = `PC: ${name} (ID ${id}) — what’s the current price?`;

  const box = el('div');
  box.className = 'row';
  box.style.marginTop = '10px';
  const lbl = el('div','lbl');
  lbl.textContent = 'Copy message';
  box.appendChild(lbl);

  const ta = document.createElement('textarea');
  ta.value = msg;
  ta.rows = 3;
  ta.style.width = '100%';
  ta.style.resize = 'vertical';
  ta.style.padding = '8px';
  ta.style.borderRadius = '10px';
  ta.style.border = '1px solid var(--border)';
  ta.style.background = 'var(--surface)';
  ta.style.color = 'var(--text)';
  box.appendChild(ta);

  const actions = el('div','inline');
  actions.style.marginTop = '8px';
  const copyBtn = el('button');
  copyBtn.type = 'button';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', async()=>{
    const ok = await copyTextToClipboard(ta.value);
    if(!ok) alert('Copy failed. You can manually select and copy the text.');
  });
  actions.appendChild(copyBtn);

  const addToNoteBtn = el('button');
  addToNoteBtn.type = 'button';
  addToNoteBtn.textContent = 'Use as note';
  addToNoteBtn.title = 'Copies the message into the Note box in the Add item section.';
  addToNoteBtn.addEventListener('click', ()=>{
    const n = $('#in-note');
    if(n) n.value = ta.value;
  });
  actions.appendChild(addToNoteBtn);

  // Simple templates for fast message building.
  const tpl = document.createElement('select');
  tpl.setAttribute('aria-label', 'Templates');
  tpl.style.marginLeft = '8px';
  tpl.style.padding = '8px';
  tpl.style.borderRadius = '999px';
  tpl.style.border = '1px solid var(--border)';
  tpl.style.background = 'var(--surface)';
  tpl.style.color = 'var(--text)';
  const templates = [
    { k: 'pc', label: 'Template: Price check', v: `PC: ${name} (ID ${id}) — what’s the current price?` },
    { k: 'wtb', label: 'Template: WTB', v: `WTB: ${name} (ID ${id}) — paying: ____` },
    { k: 'wts', label: 'Template: WTS', v: `WTS: ${name} (ID ${id}) — price: ____` },
    { k: 'note', label: 'Template: Note', v: `${name} (ID ${id}) — price: ____ • notes: ____` }
  ];
  templates.forEach((t)=>{
    const o = document.createElement('option');
    o.value = t.k;
    o.textContent = t.label;
    tpl.appendChild(o);
  });

  const applyTplBtn = el('button');
  applyTplBtn.type = 'button';
  applyTplBtn.textContent = 'Apply';
  applyTplBtn.addEventListener('click', ()=>{
    const k = tpl.value;
    const t = templates.find(x=>x.k === k);
    if(t) ta.value = t.v;
  });

  actions.appendChild(tpl);
  actions.appendChild(applyTplBtn);
  box.appendChild(actions);

  root.appendChild(box);
}

async function priceCheckSearch(){
  const q = ($('#pc-query')?.value || '').trim();
  const resultsRoot = $('#pc-results');
  const detailRoot = $('#pc-detail');
  if(resultsRoot) resultsRoot.innerHTML = '';
  if(detailRoot) detailRoot.innerHTML = '<div class="hint">Select an item to view details.</div>';
  lastPriceCheckItem = null;

  if(!q){
    resultsRoot?.appendChild(Object.assign(el('div','hint'), { textContent: 'Type a search term or paste an item link/ID.' }));
    return;
  }

  // If the user pasted an ID or URL, go straight to detail.
  const fromUrl = extractItemIdFromUrl(q);
  const fromNum = Number(q);
  const id = (fromUrl > 0) ? fromUrl : (Number.isFinite(fromNum) ? fromNum : 0);
  if(id > 0){
    await priceCheckShowDetail(id);
    return;
  }

  try{
    const items = await apiSearch(q);
    if(!items.length){
      resultsRoot?.appendChild(Object.assign(el('div','hint'), { textContent: 'No results.' }));
      return;
    }

    for(const it of items){
      const row = el('div','result');
      const thumb = el('img','thumb');
      thumb.src = buildYwCdnImageUrlFromId(it.id);
      thumb.alt = it.name || 'Item';
      thumb.loading = 'lazy';
      thumb.referrerPolicy = 'no-referrer';
      thumb.addEventListener('error', async()=>{
        const stage = Number(thumb.dataset.fallbackStage || '0');
        if(stage >= 4) return;
        thumb.dataset.fallbackStage = String(stage + 1);

        const current = String(thumb.currentSrc || thumb.src || '').trim();
        if(stage === 3){
          try{
            const detail = await apiItemDetail(it.id);
            const u = extractProviderInfoImageUrl(detail, it.id);
            if(u && u !== current) thumb.src = u;
          }catch{}
          return;
        }

        const cdnJpg = buildYwCdnImageUrlFromIdWithExt(it.id, 'jpg');
        const proxyJpg = providerInfoProxyUrlForImageUrl(cdnJpg);
        const proxyPng = providerInfoProxyUrlForImageUrl(buildYwCdnImageUrlFromId(it.id));
        const next = stage === 0 ? cdnJpg : (stage === 1 ? proxyJpg : proxyPng);
        if(next && next !== current) thumb.src = next;
      });
      row.appendChild(thumb);

      const meta = el('div','meta');
      meta.appendChild(Object.assign(el('div','name'), { textContent: it.name || '(Unnamed)' }));
      meta.appendChild(Object.assign(el('div','small'), { textContent: `ID: ${it.id}` }));
      row.appendChild(meta);

      const btn = el('button');
      btn.type = 'button';
      btn.textContent = 'Check';
      btn.addEventListener('click', ()=>priceCheckShowDetail(it.id));
      row.appendChild(btn);

      resultsRoot?.appendChild(row);
    }
  }catch(e){
    console.error(e);
    resultsRoot?.appendChild(Object.assign(el('div','hint'), { textContent: 'Price check search failed.' }));
  }
}

async function exportPng(scope, options){
  const canvas = $('#export-canvas');
  if(!canvas) return;
  const ctx = canvas.getContext('2d');

  function u16(n){
    const out = new Uint8Array(2);
    const v = Number(n) >>> 0;
    out[0] = v & 0xff;
    out[1] = (v >>> 8) & 0xff;
    return out;
  }

  function u32(n){
    const out = new Uint8Array(4);
    const v = Number(n) >>> 0;
    out[0] = v & 0xff;
    out[1] = (v >>> 8) & 0xff;
    out[2] = (v >>> 16) & 0xff;
    out[3] = (v >>> 24) & 0xff;
    return out;
  }

  const CRC32_TABLE = (()=>{
    const table = new Uint32Array(256);
    for(let i = 0; i < 256; i++){
      let c = i;
      for(let j = 0; j < 8; j++){
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes){
    let c = 0xffffffff;
    for(let i = 0; i < bytes.length; i++){
      c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosDateTimeParts(dateLike){
    const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
    const year = Math.max(1980, d.getFullYear());
    const month = Math.max(1, d.getMonth() + 1);
    const day = Math.max(1, d.getDate());
    const hour = d.getHours();
    const minute = d.getMinutes();
    const second = Math.floor(d.getSeconds() / 2);
    const dosTime = ((hour & 0x1f) << 11) | ((minute & 0x3f) << 5) | (second & 0x1f);
    const dosDate = (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);
    return { dosTime, dosDate };
  }

  async function buildZipBlob(files){
    const textEncoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const now = new Date();
    const { dosTime, dosDate } = dosDateTimeParts(now);

    for(const file of files){
      const name = String(file?.name || '').trim();
      if(!name) continue;
      const blob = file?.blob;
      if(!(blob instanceof Blob)) continue;

      const data = new Uint8Array(await blob.arrayBuffer());
      const nameBytes = textEncoder.encode(name);
      const crc = crc32(data);
      const size = data.length >>> 0;

      const localHeader = new Uint8Array(30 + nameBytes.length);
      localHeader.set(u32(0x04034b50), 0);
      localHeader.set(u16(20), 4); // version needed
      localHeader.set(u16(0), 6);  // flags
      localHeader.set(u16(0), 8);  // compression = store
      localHeader.set(u16(dosTime), 10);
      localHeader.set(u16(dosDate), 12);
      localHeader.set(u32(crc), 14);
      localHeader.set(u32(size), 18);
      localHeader.set(u32(size), 22);
      localHeader.set(u16(nameBytes.length), 26);
      localHeader.set(u16(0), 28); // extra length
      localHeader.set(nameBytes, 30);

      localParts.push(localHeader, data);

      const centralHeader = new Uint8Array(46 + nameBytes.length);
      centralHeader.set(u32(0x02014b50), 0);
      centralHeader.set(u16(20), 4); // version made by
      centralHeader.set(u16(20), 6); // version needed
      centralHeader.set(u16(0), 8);  // flags
      centralHeader.set(u16(0), 10); // compression = store
      centralHeader.set(u16(dosTime), 12);
      centralHeader.set(u16(dosDate), 14);
      centralHeader.set(u32(crc), 16);
      centralHeader.set(u32(size), 20);
      centralHeader.set(u32(size), 24);
      centralHeader.set(u16(nameBytes.length), 28);
      centralHeader.set(u16(0), 30); // extra length
      centralHeader.set(u16(0), 32); // comment length
      centralHeader.set(u16(0), 34); // disk number
      centralHeader.set(u16(0), 36); // internal attrs
      centralHeader.set(u32(0), 38); // external attrs
      centralHeader.set(u32(offset), 42);
      centralHeader.set(nameBytes, 46);
      centralParts.push(centralHeader);

      offset += localHeader.length + data.length;
    }

    let centralSize = 0;
    for(const p of centralParts) centralSize += p.length;

    const eocd = new Uint8Array(22);
    eocd.set(u32(0x06054b50), 0);
    eocd.set(u16(0), 4); // current disk
    eocd.set(u16(0), 6); // start disk
    eocd.set(u16(centralParts.length), 8);
    eocd.set(u16(centralParts.length), 10);
    eocd.set(u32(centralSize), 12);
    eocd.set(u32(offset), 16);
    eocd.set(u16(0), 20); // comment length

    return new Blob([...localParts, ...centralParts, eocd], { type: 'application/zip' });
  }

  const opts = (options && typeof options === 'object') ? options : {};
  const layoutMode = (opts.layoutMode === 'forum-wishlist') ? 'forum-wishlist' : 'default';
  const isForumWishlist = layoutMode === 'forum-wishlist';
  const includeStoreTags = opts.includeStoreTags !== false;
  const pageSize = (opts.pageSize === 8 || opts.pageSize === 20 || opts.pageSize === 25 || opts.pageSize === 35 || opts.pageSize === 50) ? opts.pageSize : 25;
  const itemLimit = (opts.itemLimit === 25 || opts.itemLimit === 50) ? opts.itemLimit : 0;
  const exportScale = (opts.exportScale === 0.85 || opts.exportScale === 1.15) ? opts.exportScale : 1;

  // Single font stack for all exported PNG text (readable at small sizes).
  // Nunito provides a rounded, friendly appearance with excellent readability.
  const EXPORT_FONT_STACK = '"Nunito", ui-rounded, "SF Pro Rounded", Verdana, system-ui, -apple-system, sans-serif';
  const EXPORT_FONT_W_BADGE = 700;
  const EXPORT_FONT_W_NAME = 700;
  const EXPORT_FONT_W_PRICE = 800;

  const theme = themeFromState();
  const pal = exportPalette(theme);

  const COLS_TAGS = 5;
  const COLS_PLAIN = 4;
  const COLS = isForumWishlist ? 10 : (includeStoreTags ? COLS_TAGS : COLS_PLAIN);

  const DEFAULT_PAGE_SIZE = pageSize;
  const WISH_PAGE_SIZE = pageSize;
  const TILE_W = 138;
  const TILE_H_TAGS_WITH_NOTE = 212;
  const TILE_H_TAGS_NO_NOTE = 194;
  const TILE_H_DEFAULT_WITH_NOTE = 196;
  const TILE_H_DEFAULT_NO_NOTE = 182;

  // Paint-friendly export: compact spacing; readable small fonts.
  const TILE_H_WISH_WITH_NOTE = 176;
  const TILE_H_WISH_NO_NOTE = 162;
  const PAD_DEFAULT = 5;
  const GAP_DEFAULT = 3;
  const HEADER_H_DEFAULT = 0;
  const PAD_WISH = 4;
  const GAP_WISH = 2;
  const HEADER_H_WISH = 0;

  function pageSizeForSection(_sectionKey){
    return WISH_PAGE_SIZE;
  }

  function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

  async function blobFromCurrentCanvas(){
    return new Promise((resolve)=> canvas.toBlob(resolve, 'image/png'));
  }

  async function downloadCurrentCanvas(filename){
    const blob = await blobFromCurrentCanvas();
    if(!blob) throw new Error('Could not generate PNG blob.');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(url), 2000);
  }

  async function renderAndDownloadSectionPage(sectionKey, _title, items, pageIndex, totalPages, captureFn){
    const pageHasAnyNote = (items || []).some(it => String(it?.note || '').trim());

    const isWish = sectionKey === 'wl' || sectionKey === 'npcs';
    const isPriceCheck = sectionKey === SPECIAL_PC_TAB_KEY;

    const cols = COLS;
    const tileW = TILE_W;

    const pagePad = isWish ? PAD_WISH : PAD_DEFAULT;
    const pageGap = isWish ? GAP_WISH : GAP_DEFAULT;
    const headerH = isWish ? HEADER_H_WISH : HEADER_H_DEFAULT;

    const rows = Math.max(1, Math.ceil(items.length / cols));
    const width = pagePad*2 + cols*tileW + (cols-1)*pageGap;
    const tileHBase = includeStoreTags
      ? (pageHasAnyNote ? TILE_H_TAGS_WITH_NOTE : TILE_H_TAGS_NO_NOTE)
      : (isWish
        ? (pageHasAnyNote ? TILE_H_WISH_WITH_NOTE : TILE_H_WISH_NO_NOTE)
        : (pageHasAnyNote ? TILE_H_DEFAULT_WITH_NOTE : TILE_H_DEFAULT_NO_NOTE));
    // If tags are disabled, reclaim the badge area to keep images tighter for paint boards.
    const tileH = Math.max(138, tileHBase + (includeStoreTags ? 0 : (isWish ? -22 : -28)));
    const height = pagePad + headerH + rows * tileH + (rows-1)*pageGap + pagePad;

    // Scale canvas for high-DPI displays and optional export scaling.
    const dpr = window.devicePixelRatio || 1;
    const outWidth = Math.max(1, Math.round(width * exportScale));
    const outHeight = Math.max(1, Math.round(height * exportScale));
    canvas.width = outWidth * dpr;
    canvas.height = outHeight * dpr;
    canvas.style.width = outWidth + 'px';
    canvas.style.height = outHeight + 'px';
    ctx.scale(dpr * exportScale, dpr * exportScale);

    // Background
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0,0,width,height);

    ctx.textBaseline = 'top';

    // No title/header text in exported PNGs (paint-board friendly)
    const y = pagePad;
    for(let r=0; r<rows; r++){
      for(let c=0; c<cols; c++){
        const idx = r*cols + c;
        const x = pagePad + c*(tileW+pageGap);
        const ty = y + r*(tileH+pageGap);

        const innerPad = includeStoreTags ? (isWish ? 6 : 8) : (isWish ? 5 : 6);

        // Tile background
        ctx.fillStyle = pal.tileBg;
        roundRect(ctx, x, ty, tileW, tileH, isWish ? 12 : 14);
        ctx.fill();

        ctx.strokeStyle = pal.tileBorder;
        ctx.lineWidth = 2;
        roundRect(ctx, x, ty, tileW, tileH, isWish ? 12 : 14);
        ctx.stroke();

        const item = items[idx];
        if(!item) continue;

        // Store badge (optional)
        let badgeBlockH = 0;
        if(includeStoreTags){
          const badgeText = item.activeInStore ? 'IN STORE' : 'NOT IN STORE';
          const isInStore = !!item.activeInStore;
          ctx.font = isWish
            ? `${EXPORT_FONT_W_BADGE} 13px ${EXPORT_FONT_STACK}`
            : `${EXPORT_FONT_W_BADGE} 14px ${EXPORT_FONT_STACK}`;
          const bw = ctx.measureText(badgeText).width + (isWish ? 14 : 16);
          const bx = x + (tileW - bw) / 2;
          const by = ty + (isWish ? 6 : 8);

          // IN STORE gets a dedicated green treatment for fast scanning.
          // NOT IN STORE stays theme-driven for consistency with selected palette.
          if(isInStore){
            const grad = ctx.createLinearGradient(bx, by, bx, by + 18);
            grad.addColorStop(0, '#2fd36f');
            grad.addColorStop(1, '#1f9b50');
            ctx.fillStyle = grad;
            ctx.save();
            ctx.shadowColor = 'rgba(31, 155, 80, 0.45)';
            ctx.shadowBlur = 6;
            ctx.shadowOffsetY = 1;
            roundRect(ctx, bx, by, bw, 18, 9);
            ctx.fill();
            ctx.restore();
          }else{
            ctx.fillStyle = pal.badgeBg;
            roundRect(ctx, bx, by, bw, 18, 9);
            ctx.fill();
          }

          ctx.lineWidth = 2;
          ctx.strokeStyle = isInStore ? '#15803d' : pal.badgeBorderAlt;
          roundRect(ctx, bx, by, bw, 18, 9);
          ctx.stroke();
          ctx.fillStyle = isInStore ? '#f4fff7' : pal.badgeText;
          ctx.fillText(badgeText, bx + (isWish ? 7 : 8), by + 3);
          badgeBlockH = 22;
        }

        // Price / note
        const price = String(item.note || '').trim();
        const hasPrice = !!price;
        const priceX = x + innerPad;
        const priceW = tileW - innerPad*2;
        const priceH = isWish ? 18 : 20;
        const priceY = ty + tileH - innerPad - priceH;
        if(includeStoreTags){
          // Tagged layout: status -> name -> image -> note
          const nameX = x + innerPad;
          const nameW = tileW - innerPad * 2;
          const nameY = ty + innerPad + badgeBlockH + 4;
          const nameAreaH = (isWish ? 36 : 42);

          ctx.fillStyle = pal.text;
          let nameFontSize = isWish ? 13 : 14;
          let nameLineH = 16;
          let nameLines = [];
          for(let fs = (isWish ? 13 : 14); fs >= 10; fs--){
            nameLineH = Math.max(13, fs + 2);
            const maxLines = Math.max(1, Math.min(3, Math.floor(nameAreaH / nameLineH)));
            ctx.font = `${EXPORT_FONT_W_NAME} ${fs}px ${EXPORT_FONT_STACK}`;
            const wrapped = wrapLines(ctx, item.name || '', nameW, maxLines);
            nameLines = wrapped.lines;
            nameFontSize = fs;
            if(!wrapped.truncated) break;
          }

          ctx.font = `${EXPORT_FONT_W_NAME} ${nameFontSize}px ${EXPORT_FONT_STACK}`;
          ctx.save();
          ctx.textAlign = 'center';
          const textBlockH = nameLines.length * nameLineH;
          const nameStartY = nameY + Math.max(0, (nameAreaH - textBlockH) / 2);
          for(let i=0; i<nameLines.length; i++){
            const yy = nameStartY + i * nameLineH;
            if(yy + nameLineH > nameY + nameAreaH + 1) break;
            ctx.fillText(nameLines[i], nameX + nameW / 2, yy);
          }
          ctx.restore();

          const noteGap = hasPrice ? 6 : 0;
          const imgInsetX = isWish ? 5 : 6;
          const imgX = x + innerPad + imgInsetX;
          const imgY = nameY + nameAreaH + 4;
          const imgW = tileW - innerPad*2 - imgInsetX*2;
          const imgBottom = hasPrice ? (priceY - noteGap - 2) : (ty + tileH - innerPad - 2);
          const imgH = Math.max(40, imgBottom - imgY);

          try{
            const primaryUrl = bestImageUrlForItem(item);
            const img = await loadImageWithFallback(primaryUrl, item?.id);
            if(!img) throw new Error('no image');
            drawContain(ctx, img, imgX, imgY, imgW, imgH);
            ctx.strokeStyle = pal.tileBorder;
            ctx.lineWidth = 2;
            roundRect(ctx, imgX, imgY, imgW, imgH, 12);
            ctx.stroke();
          }catch{
            ctx.fillStyle = pal.imgFallback;
            roundRect(ctx, imgX, imgY, imgW, imgH, 12);
            ctx.fill();
          }

          if(price){
            ctx.font = isWish
              ? `${EXPORT_FONT_W_PRICE} 14px ${EXPORT_FONT_STACK}`
              : `${EXPORT_FONT_W_PRICE} 15px ${EXPORT_FONT_STACK}`;
            drawCenteredPillText(ctx, price, priceX, priceY, priceW, priceH, pal.priceBg, pal.priceBorder, pal.priceText);
          }
        }else{
          if(price){
            ctx.font = isWish
              ? `${EXPORT_FONT_W_PRICE} 15px ${EXPORT_FONT_STACK}`
              : `${EXPORT_FONT_W_PRICE} 16px ${EXPORT_FONT_STACK}`;
            drawCenteredPillText(ctx, price, priceX, priceY, priceW, priceH, pal.priceBg, pal.priceBorder, pal.priceText);
          }

          // Plain layout: image first, then name.
          const imgInsetX = isWish ? 4 : 5;
          const imgX = x + innerPad + imgInsetX;
          const imgY = ty + innerPad + badgeBlockH;
          const imgW = tileW - innerPad*2 - imgInsetX*2;
          const imgH = isWish
            ? (pageHasAnyNote ? (!hasPrice ? 64 : 50) : 58)
            : (isPriceCheck
              ? (pageHasAnyNote ? (!hasPrice ? 70 : 54) : 64)
              : (pageHasAnyNote ? 54 : 60));

          try{
            const primaryUrl = bestImageUrlForItem(item);
            const img = await loadImageWithFallback(primaryUrl, item?.id);
            if(!img) throw new Error('no image');
            drawContain(ctx, img, imgX, imgY, imgW, imgH);
            ctx.strokeStyle = pal.tileBorder;
            ctx.lineWidth = 2;
            roundRect(ctx, imgX, imgY, imgW, imgH, 12);
            ctx.stroke();
          }catch{
            ctx.fillStyle = pal.imgFallback;
            roundRect(ctx, imgX, imgY, imgW, imgH, 12);
            ctx.fill();
          }

          // Name
          ctx.fillStyle = pal.text;
          const nameX = x + innerPad;
          const nameY = imgY + imgH + (isWish ? 3 : 4);
          const nameW = tileW - innerPad*2;
          const nameBottom = (hasPrice ? (priceY - 8) : (ty + tileH - innerPad));
          const availableH = Math.max(18, nameBottom - nameY);

          const startFontSize = isWish ? 14 : (isPriceCheck ? 15 : 16);
          const minFontSize = isWish ? 10 : (isPriceCheck ? 10 : 11);

          let nameFontSize = startFontSize;
          let nameLineH = 22;
          let nameLines = [];

          for(let fs = startFontSize; fs >= minFontSize; fs--){
            nameLineH = Math.max(13, fs + (isWish ? 2 : 3));
            const maxLines = Math.max(1, Math.min(3, Math.floor(availableH / nameLineH)));
            ctx.font = `${EXPORT_FONT_W_NAME} ${fs}px ${EXPORT_FONT_STACK}`;
            const wrapped = wrapLines(ctx, item.name || '', nameW, maxLines);
            nameLines = wrapped.lines;
            nameFontSize = fs;
            if(!wrapped.truncated) break;
          }

          ctx.font = `${EXPORT_FONT_W_NAME} ${nameFontSize}px ${EXPORT_FONT_STACK}`;
          ctx.save();
          ctx.textAlign = 'center';
          const textBlockH = nameLines.length * nameLineH;
          const shouldBottomAlign = pageHasAnyNote;
          const nameStartY = shouldBottomAlign
            ? Math.max(nameY, nameBottom - textBlockH)
            : nameY;
          for(let i=0; i<nameLines.length; i++){
            const yy = nameStartY + i * nameLineH;
            if(yy + nameLineH > nameBottom + 2) break;
            ctx.fillText(nameLines[i], nameX + nameW / 2, yy);
          }
          ctx.restore();
        }
      }
    }

    const suffix = totalPages > 1 ? `-p${pageIndex+1}` : '';
    const styleSuffix = includeStoreTags ? '-tags' : '-plain';
    const filename = `wtb-wts-${sectionKey}${styleSuffix}${suffix}.png`;
    if(typeof captureFn === 'function'){
      const blob = await blobFromCurrentCanvas();
      if(blob) await captureFn({ filename, blob });
      return;
    }
    await downloadCurrentCanvas(filename);
  }

  const sections = exportSectionsForScope(scope);
  const sectionJobs = sections.map(s=>{
    let allItems = [];

    allItems = state[s.key] || [];
    if(itemLimit > 0) allItems = allItems.slice(0, itemLimit);

    const pageSize = pageSizeForSection(s.key);
    const pages = [];
    for(let i=0; i<Math.max(1, allItems.length); i += pageSize){
      pages.push(allItems.slice(i, i + pageSize));
      if(allItems.length === 0) break;
    }
    return { key: s.key, title: s.title, pages };
  });

  const totalDownloads = sectionJobs.reduce((sum, j)=>sum + (j.pages.length || 1), 0);
  const useZipExport = totalDownloads > 5;
  if(totalDownloads > 1){
    const styleLine = includeStoreTags ? 'Style: With IN/OUT tags' : 'Style: Paint (no tags)';
    const limitLine = itemLimit > 0 ? `Per list cap: first ${itemLimit} items\n` : 'Per list cap: all items\n';
    const scaleLine = `Scale: ${Math.round(exportScale * 100)}%\n`;
    const modeLine = useZipExport
      ? 'Download mode: ZIP (auto, because export is more than 5 files)\n'
      : 'Download mode: individual PNG files\n';
    const ok = confirm(
      `This export will download ${totalDownloads} PNG files.\n\n` +
      `${styleLine}\n` +
      `${limitLine}` +
      `${scaleLine}` +
      `${modeLine}` +
      `All lists: ${pageSize} items per image\n\n` +
      `Continue?`
    );
    if(!ok) return;
  }

  const zipEntries = [];
  const zipCollector = async(entry)=>{
    if(entry?.blob && entry?.filename) zipEntries.push({ name: entry.filename, blob: entry.blob });
  };

  for(const job of sectionJobs){
    const totalPages = job.pages.length || 1;
    for(let pi=0; pi<totalPages; pi++){
      const items = job.pages[pi] || [];
      await renderAndDownloadSectionPage(job.key, job.title, items, pi, totalPages, useZipExport ? zipCollector : null);
      await sleep(90);
    }
  }

  if(useZipExport && zipEntries.length){
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const zipBlob = await buildZipBlob(zipEntries);
    await downloadBlobFile(zipBlob, `wtb-wts-export-${stamp}.zip`);
  }
}

function roundRect(ctx, x, y, w, h, r){
  const rr = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x+rr, y);
  ctx.arcTo(x+w, y, x+w, y+h, rr);
  ctx.arcTo(x+w, y+h, x, y+h, rr);
  ctx.arcTo(x, y+h, x, y, rr);
  ctx.arcTo(x, y, x+w, y, rr);
  ctx.closePath();
}

function drawCover(ctx, img, x, y, w, h){
  const ir = img.width / img.height;
  const tr = w / h;
  let sw, sh, sx, sy;
  if(ir > tr){
    sh = img.height;
    sw = sh * tr;
    sx = (img.width - sw) / 2;
    sy = 0;
  }else{
    sw = img.width;
    sh = sw / tr;
    sx = 0;
    sy = (img.height - sh) / 2;
  }
  ctx.save();
  roundRect(ctx, x, y, w, h, 12);
  ctx.clip();
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  ctx.restore();
}

function drawContain(ctx, img, x, y, w, h){
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  
  // Calculate scale to fit image within container while preserving aspect ratio
  const scale = Math.min(w / iw, h / ih);
  
  // Calculate final dimensions
  const dw = iw * scale;
  const dh = ih * scale;
  
  // Center the image in the container
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;
  
  ctx.save();
  roundRect(ctx, x, y, w, h, 12);
  ctx.clip();
  // Draw the entire source image scaled to fit (9-parameter form for precision)
  ctx.drawImage(img, 0, 0, iw, ih, dx, dy, dw, dh);
  ctx.restore();
}

function isKnownSection(section){
  return isListTab(section);
}

function getList(section){
  if(!isKnownSection(section)) return [];
  const arr = state?.[section];
  return Array.isArray(arr) ? arr : [];
}

function setList(section, items){
  if(!isKnownSection(section)) return;
  state[section] = Array.isArray(items) ? items : [];
}

async function clearSection(section){
  if(!confirm('Clear this section?')) return;
  setList(section, []);
  await saveState();
  render();
}

async function refreshSection(section){
  const items = getList(section);
  if(!items.length){
    alert('Nothing to refresh in this section.');
    return;
  }

  // Keep it simple + reliable: re-check active_in_store for each item.
  // (Sequential to avoid hammering the API.)
  for(const entry of items){
    if(!entry?.id) continue;
    try{
      const detail = await apiItemDetailCached(entry.id);
      if(detail){
        entry.activeInStore = !!detail.active_in_store;
        // If the name changes upstream, keep ours in sync.
        if(detail.name) entry.name = detail.name;
      }
    }catch{
      // Leave existing values as-is on failures.
    }
  }

  await saveState();
  render();
}

async function repairImagesInSection(section){
  const items = state[section] || [];
  if(!items.length){
    alert('Nothing to repair in this section.');
    return;
  }

  const ok = confirm('This will check each item image and swap to a better image link when needed (including fixing some black placeholder images). Continue?');
  if(!ok) return;

  let changed = 0;
  let checked = 0;

  for(const entry of items){
    if(!entry?.id) continue;
    checked++;

    const currentUrl = String(entry.imageUrl || '').trim();
    const looksProxyPng = isProviderInfoProxyToPng(currentUrl);
    const good = await canLoadImage(currentUrl, 4500);
    if(good && !looksProxyPng) continue;

    let fallback = '';
    if(looksProxyPng){
      // Try the real CDN .jpg first; if it exists, it avoids the proxy placeholder.
      const cdnJpg = buildYwCdnImageUrlFromIdWithExt(entry.id, 'jpg');
      if(await canLoadImage(cdnJpg, 4500)) fallback = cdnJpg;
      else fallback = buildYwApiItemImageUrlFromId(entry.id, '130_100');
    }else{
      fallback = await ensureInfoImageUrl(entry, currentUrl);
    }

    if(fallback && fallback !== currentUrl){
      entry.imageUrl = fallback;
      changed++;
    }
  }

  if(changed){
    await saveState();
    render();
  }

  alert(`Repair complete. Checked ${checked} items; updated ${changed} image links.`);
}

// ---- Tab Management (Builtin + Custom) ----

function escapeHtml(str){
  const d = document.createElement('div');
  d.textContent = String(str || '');
  return d.innerHTML;
}

function getCustomTabs(){
  return Array.isArray(state?.settings?.customTabs) ? state.settings.customTabs : [];
}

function genCustomTabKey(){
  return 'custom_' + Date.now();
}

function getTabsFullOrder(){
  const customTabs = getCustomTabs();
  const allKnownKeys = [...BUILTIN_TABS.map(t => t.key), ...customTabs.map(t => t.key)];
  const saved = Array.isArray(state?.settings?.tabOrder) ? state.settings.tabOrder : [];
  const result = saved.filter(k => allKnownKeys.includes(k));
  for(const k of allKnownKeys){ if(!result.includes(k)) result.push(k); }
  return result;
}

function getEffectiveTabOrder(){
  const hidden = Array.isArray(state?.settings?.hiddenTabs) ? state.settings.hiddenTabs : [];
  return getTabsFullOrder().filter(k => !hidden.includes(k));
}

function updateRestoreBtn(){
  // No-op: tab visibility is now managed via the #sel-tab-manage dropdown.
}

function syncCustomTabDropdowns(){
  const allListTabs = getAllListTabDefs();
  replaceSelectOptions($('#export-scope'), [
    { value: 'active', label: 'Current tab' },
    { value: 'all', label: 'All lists' },
    ...allListTabs.map((tab)=> ({ value: tab.key, label: tab.label }))
  ], $('#export-scope')?.value || 'active');
  replaceSelectOptions($('#in-section'), allListTabs.map((tab)=> ({ value: tab.key, label: tab.label })), $('#in-section')?.value || getActiveTab() || DEFAULT_TAB_KEY);
  replaceSelectOptions($('#bb-fill-list'), allListTabs.map((tab)=> ({ value: tab.key, label: tab.label })), $('#bb-fill-list')?.value || DEFAULT_TAB_KEY);
  updateExportPreviewSummary();
}

let tabDragKey = null;

function buildListPanelElement(def){
  const panel = document.createElement('section');
  panel.className = 'card';
  panel.dataset.panel = def.key;
  panel.hidden = true;

  const head = document.createElement('div');
  head.className = 'section-head';
  const h2 = document.createElement('h2');
  h2.textContent = def.label;
  const actions = document.createElement('div');
  actions.className = 'inline';

  const refreshBtn = document.createElement('button');
  refreshBtn.id = 'btn-refresh-' + def.key;
  refreshBtn.type = 'button';
  refreshBtn.className = 'ghost';
  refreshBtn.textContent = 'Refresh';
  refreshBtn.addEventListener('click', ()=> refreshSection(def.key));

  const repairBtn = document.createElement('button');
  repairBtn.id = 'btn-repair-' + def.key;
  repairBtn.type = 'button';
  repairBtn.className = 'ghost';
  repairBtn.textContent = 'Repair Images';
  repairBtn.addEventListener('click', ()=> repairImagesInSection(def.key));

  const clearBtn = document.createElement('button');
  clearBtn.id = 'btn-clear-' + def.key;
  clearBtn.type = 'button';
  clearBtn.className = 'ghost';
  clearBtn.textContent = 'Clear';
  clearBtn.addEventListener('click', ()=> clearSection(def.key));

  actions.append(refreshBtn, repairBtn, clearBtn);
  head.append(h2, actions);
  panel.appendChild(head);

  const filterRow = document.createElement('div');
  filterRow.className = 'row';
  const filterInput = document.createElement('input');
  filterInput.id = 'filter-' + def.key;
  filterInput.type = 'text';
  filterInput.placeholder = def.filterPlaceholder || `Filter ${def.label} items...`;
  filterInput.setAttribute('aria-label', def.filterAriaLabel || `Filter ${def.label} list`);
  filterInput.value = sectionFilters[def.key] || '';
  let debounceTimer = 0;
  filterInput.addEventListener('input', ()=>{
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(()=>{
      sectionFilters[def.key] = filterInput.value;
      render();
    }, 200);
  });
  filterInput.addEventListener('keydown', (e)=>{
    if(e.key !== 'Escape') return;
    e.preventDefault();
    filterInput.value = '';
    sectionFilters[def.key] = '';
    render();
  });
  filterRow.appendChild(filterInput);
  panel.appendChild(filterRow);

  const grid = document.createElement('div');
  grid.id = 'grid-' + def.key;
  grid.className = 'grid';
  panel.appendChild(grid);

  return panel;
}

function wireDragOnTab(btn, key){
  btn.setAttribute('draggable', 'true');
  btn.addEventListener('dragstart', (e) => {
    if(dragState?.key){ e.preventDefault(); return; }
    tabDragKey = key;
    btn.classList.add('tab-dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  btn.addEventListener('dragend', () => {
    tabDragKey = null;
    btn.classList.remove('tab-dragging');
    document.querySelectorAll('.tab-drag-over').forEach(el => el.classList.remove('tab-drag-over'));
  });
  btn.addEventListener('dragover', (e) => {
    if(!tabDragKey || tabDragKey === key) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    btn.classList.add('tab-drag-over');
  });
  btn.addEventListener('dragleave', () => {
    btn.classList.remove('tab-drag-over');
  });
  btn.addEventListener('drop', async (e) => {
    e.preventDefault();
    btn.classList.remove('tab-drag-over');
    if(!tabDragKey || tabDragKey === key) return;
    const fromKey = tabDragKey;
    tabDragKey = null;
    const order = getTabsFullOrder();
    const fromIdx = order.indexOf(fromKey);
    const toIdx = order.indexOf(key);
    if(fromIdx < 0 || toIdx < 0) return;
    order.splice(fromIdx, 1);
    order.splice(toIdx, 0, fromKey);
    state.settings = state.settings || {};
    state.settings.tabOrder = order;
    buildTabsUI();
    await saveState();
  });
}

function formatTabCountLabel(count, label){
  const n = Math.max(0, Number(count) || 0);
  return n + ' ' + label;
}

function updateTabsManagerSummary(){
  const meta = $('#tabs-meta');
  if(!meta) return;

  const hidden = Array.isArray(state?.settings?.hiddenTabs) ? state.settings.hiddenTabs : [];
  const visibleCount = getEffectiveTabOrder().length;
  const customCount = getCustomTabs().length;

  const visibleLabel = formatTabCountLabel(visibleCount, 'visible');
  const customLabel = formatTabCountLabel(customCount, 'custom');
  const hiddenLabel = formatTabCountLabel(hidden.length, 'hidden');

  meta.textContent = `${visibleLabel} • ${customLabel} • ${hiddenLabel}`;
}

function buildTabsUI(){
  const nav = document.querySelector('.tabs');
  if(!nav) return;
  const scrollArea = nav.querySelector('.tab-scroll-area');
  if(!scrollArea) return;
  const panelsRoot = $('#list-panels-root');

  // Remove all existing tab buttons from the scroll area
  scrollArea.querySelectorAll('.tab[data-tab]').forEach(el => el.remove());
  if(panelsRoot) panelsRoot.innerHTML = '';

  const allTabDefs = new Map(getAllListTabDefs().map((tab)=> [tab.key, tab]));

  for(const key of getEffectiveTabOrder()){
    const def = allTabDefs.get(key);
    if(!def) continue;

    // Tab button (click handled by wireTabs event delegation)
    const btn = document.createElement('button');
    btn.className = 'tab' + (def.isCustom ? ' tab-custom' : '');
    btn.type = 'button';
    btn.dataset.tab = key;
    btn.textContent = def.label;
    wireDragOnTab(btn, key);
    scrollArea.appendChild(btn);

    if(def.panelType === 'generic' && panelsRoot){
      sectionFilters[key] = sectionFilters[key] || '';
      panelsRoot.appendChild(buildListPanelElement(def));
    }
  }

  // Restore is-active class on current tab button
  if(currentTab){
    const activeBtn = scrollArea.querySelector(`.tab[data-tab="${CSS.escape(currentTab)}"]`);
    if(activeBtn) activeBtn.classList.add('is-active');
  }
  rebuildManageSelect();
  syncBuiltinPanelsFromConfig();
  syncCustomTabDropdowns();
}

function rebuildManageSelect(){
  const sel = $('#sel-tab-manage');
  if(!sel) return;
  // Clear all options except the first placeholder
  while(sel.options.length > 1) sel.remove(1);

  const customTabs = getCustomTabs();
  const hidden = Array.isArray(state?.settings?.hiddenTabs) ? state.settings.hiddenTabs : [];
  const allTabDefs = new Map([
    ...BUILTIN_TABS.map(t => [t.key, {label: t.label, isCustom: false}]),
    ...customTabs.map(t => [t.key, {label: t.label, isCustom: true}])
  ]);

  const visibleBuiltins = getEffectiveTabOrder().filter(k => !allTabDefs.get(k)?.isCustom);
  if(visibleBuiltins.length > 0){
    const grp = document.createElement('optgroup');
    grp.label = 'Hide tab';
    for(const k of visibleBuiltins){
      const opt = document.createElement('option');
      opt.value = 'hide::' + k;
      opt.textContent = allTabDefs.get(k)?.label || k;
      grp.appendChild(opt);
    }
    sel.appendChild(grp);
  }

  const visibleCustom = getEffectiveTabOrder().filter(k => allTabDefs.get(k)?.isCustom);
  if(visibleCustom.length > 0){
    const grp = document.createElement('optgroup');
    grp.label = 'Delete custom tab';
    for(const k of visibleCustom){
      const opt = document.createElement('option');
      opt.value = 'delete::' + k;
      opt.textContent = allTabDefs.get(k)?.label || k;
      grp.appendChild(opt);
    }
    sel.appendChild(grp);
  }

  if(hidden.length > 0){
    const grp = document.createElement('optgroup');
    grp.label = 'Restore hidden tab';
    for(const k of hidden){
      const def = allTabDefs.get(k);
      if(!def) continue;
      const opt = document.createElement('option');
      opt.value = 'restore::' + k;
      opt.textContent = def.label;
      grp.appendChild(opt);
    }
    sel.appendChild(grp);
  }

  const placeholder = sel.options[0];
  const availableActions = visibleBuiltins.length + visibleCustom.length + hidden.length;
  if(placeholder) placeholder.textContent = availableActions > 0 ? 'Tab action...' : 'No actions available';
  sel.disabled = availableActions <= 0;

  updateTabsManagerSummary();
}

function ensureStateSettingsContainer(targetState){
  const safeState = (targetState && typeof targetState === 'object') ? targetState : {};
  const currentSettings = (safeState.settings && typeof safeState.settings === 'object') ? safeState.settings : {};
  safeState.settings = {
    ...currentSettings,
    customTabs: Array.isArray(currentSettings.customTabs) ? currentSettings.customTabs : [],
    tabOrder: Array.isArray(currentSettings.tabOrder) ? currentSettings.tabOrder : [],
    hiddenTabs: Array.isArray(currentSettings.hiddenTabs) ? currentSettings.hiddenTabs : []
  };
  return safeState;
}

function applyHideBuiltinTabState(targetState, key){
  const safeState = ensureStateSettingsContainer(targetState);
  const tabKey = String(key || '').trim();
  if(!tabKey) return false;
  const hidden = Array.isArray(safeState.settings.hiddenTabs) ? [...safeState.settings.hiddenTabs] : [];
  if(hidden.includes(tabKey)) return false;
  hidden.push(tabKey);
  safeState.settings.hiddenTabs = hidden;
  return true;
}

function applyRestoreHiddenTabState(targetState, key){
  const safeState = ensureStateSettingsContainer(targetState);
  const tabKey = String(key || '').trim();
  if(!tabKey) return false;
  const hidden = Array.isArray(safeState.settings.hiddenTabs) ? [...safeState.settings.hiddenTabs] : [];
  if(!hidden.includes(tabKey)) return false;
  safeState.settings.hiddenTabs = hidden.filter(k => k !== tabKey);
  return true;
}

function applyCreateCustomTabState(targetState, targetSectionFilters, key, label){
  const safeState = ensureStateSettingsContainer(targetState);
  const safeFilters = (targetSectionFilters && typeof targetSectionFilters === 'object') ? targetSectionFilters : {};
  const tabKey = String(key || '').trim();
  const trimmedLabel = String(label || '').trim().slice(0, 30);
  if(!tabKey || !trimmedLabel) return false;

  const tabs = Array.isArray(safeState.settings.customTabs) ? safeState.settings.customTabs : [];
  if(tabs.some((tab)=> tab?.key === tabKey)) return false;

  safeState.settings.customTabs = [...tabs, { key: tabKey, label: trimmedLabel }];
  if(!Array.isArray(safeState[tabKey])) safeState[tabKey] = [];
  safeFilters[tabKey] = '';
  return true;
}

function buildDeleteCustomTabPrompt(tabLabel, count){
  const safeLabel = String(tabLabel || 'Custom Tab');
  const n = Number(count) || 0;
  return n > 0
    ? 'Delete "' + safeLabel + '" and its ' + n + ' item' + (n === 1 ? '' : 's') + '? This cannot be undone.'
    : 'Delete "' + safeLabel + '"?';
}

function applyDeleteCustomTabState(targetState, targetSectionFilters, key){
  const safeState = ensureStateSettingsContainer(targetState);
  const safeFilters = (targetSectionFilters && typeof targetSectionFilters === 'object') ? targetSectionFilters : null;
  const tabKey = String(key || '').trim();
  if(!tabKey) return { changed: false, itemCount: 0, tabLabel: '' };

  const tabs = Array.isArray(safeState.settings.customTabs) ? safeState.settings.customTabs : [];
  const tab = tabs.find((t)=> t && t.key === tabKey);
  if(!tab) return { changed: false, itemCount: 0, tabLabel: '' };

  const count = Array.isArray(safeState[tabKey]) ? safeState[tabKey].length : 0;
  safeState.settings.customTabs = tabs.filter((t)=> t && t.key !== tabKey);
  if(Array.isArray(safeState.settings.tabOrder)){
    safeState.settings.tabOrder = safeState.settings.tabOrder.filter((k)=> k !== tabKey);
  }

  delete safeState[tabKey];
  if(safeFilters) delete safeFilters[tabKey];

  return { changed: true, itemCount: count, tabLabel: String(tab.label || '') };
}

async function hideBuiltinTab(key){
  if(!applyHideBuiltinTabState(state, key)) return;
  buildTabsUI();
  await saveState();
  if(currentTab === key) setActiveTab(DEFAULT_TAB_KEY);
}

async function showHiddenTabsMenu(){
  const hidden = Array.isArray(state?.settings?.hiddenTabs) ? state.settings.hiddenTabs : [];
  if(hidden.length === 0) return;
  const allDefs = new Map(BUILTIN_TABS.map(t => [t.key, t.label]));
  const lines = hidden.map((k, i) => (i + 1) + '. ' + (allDefs.get(k) || k)).join('\n');
  const input = prompt('Choose a tab to restore (enter number):\n' + lines);
  if(!input) return;
  const idx = parseInt(input.trim(), 10) - 1;
  if(isNaN(idx) || idx < 0 || idx >= hidden.length) return;
  const keyToRestore = hidden[idx];
  if(!applyRestoreHiddenTabState(state, keyToRestore)) return;
  buildTabsUI();
  await saveState();
  setActiveTab(keyToRestore);
}

async function createCustomTab(){
  const label = prompt('Enter a name for the new tab:');
  const key = genCustomTabKey();
  if(!applyCreateCustomTabState(state, sectionFilters, key, label)) return;
  buildTabsUI();
  await saveState();
  setActiveTab(key);
  render();
}

async function deleteCustomTab(key){
  const tabs = getCustomTabs();
  const tab = tabs.find(t => t.key === key);
  if(!tab) return;
  const count = Array.isArray(state[key]) ? state[key].length : 0;
  const msg = buildDeleteCustomTabPrompt(tab.label, count);
  if(!confirm(msg)) return;
  const deleted = applyDeleteCustomTabState(state, sectionFilters, key);
  if(!deleted.changed) return;
  buildTabsUI();
  await saveState();
  if(currentTab === key) setActiveTab(DEFAULT_TAB_KEY);
}

if(typeof document !== 'undefined' && document?.addEventListener){
document.addEventListener('DOMContentLoaded', async()=>{
  await loadState();
  applyTheme(themeFromState());
  setListDensity(getListDensity());
  initListsQuickstartCue();
  syncBuiltinPanelsFromConfig();
  buildTabsUI(); // must be before wireTabs so all tab panels exist when initial tab is restored
  // Wire tabs early so navigation works even if rendering hits a bad state.
  wireTabs();
  try{ render(); }catch(e){ console.error('render failed', e); }

  // Side panel only: allow dropping item links to add items.
  if(document.body?.dataset?.page === 'sidepanel'){
    wireSidePanelDrop();
  }

  // Persist drafts as the user types.
  $('#in-query')?.addEventListener('input', ()=>persistDraftForTab(getActiveTab()));
  $('#in-note')?.addEventListener('input', ()=>persistDraftForTab(getActiveTab()));

  const themeSelect = $('#theme-select');
  if(themeSelect){
    themeSelect.value = themeFromState();
    themeSelect.addEventListener('change', async()=>{
      const t = themeSelect.value;
      state.settings = state.settings || {};
      state.settings.theme = normalizeThemeValue(t);
      applyTheme(themeFromState());
      await saveState();
    });
  }

  const imgSourceSelect = $('#image-source-select');
  if(imgSourceSelect){
    imgSourceSelect.value = imageSourceFromState();
    imgSourceSelect.addEventListener('change', async()=>{
      const v = imgSourceSelect.value;
      state.settings = state.settings || {};
      state.settings.imageSource = (v === 'cdn' || v === 'info' || v === 'auto') ? v : 'cdn';
      await saveState();
      render();
    });
  }

  const listDensitySelect = $('#list-density');
  if(listDensitySelect){
    listDensitySelect.value = getListDensity();
    listDensitySelect.addEventListener('change', ()=>{
      setListDensity(listDensitySelect.value);
    });
  }

  const exportPresetSelect = $('#export-preset');
  if(exportPresetSelect){
    setExportPresetValues(exportPresetSelect.value || 'forum-standard');
    exportPresetSelect.addEventListener('change', ()=>{
      const key = exportPresetSelect.value;
      setExportPresetValues(key);
      updateExportAdvancedControlsVisibility();
      syncExportPresetSelection();
      updateExportPreviewSummary();
    });
  }

  ['#export-wish-pagesize', '#export-item-limit', '#export-scale'].forEach((sel)=>{
    const node = $(sel);
    if(!node) return;
    node.addEventListener('change', ()=>{
      syncExportPresetSelection();
      updateExportAdvancedControlsVisibility();
      updateExportPreviewSummary();
    });
  });
  $('#export-scope')?.addEventListener('change', ()=> updateExportPreviewSummary());
  updateExportAdvancedControlsVisibility();
  syncExportPresetSelection();
  updateExportPreviewSummary();

  $('#btn-search')?.addEventListener('click', doSearch);
  $('#btn-search-clear')?.addEventListener('click', clearListSearch);
  $('#btn-results-prev')?.addEventListener('click', goPrevListSearchPage);
  $('#btn-results-next')?.addEventListener('click', goNextListSearchPage);

  // Keyboard paging for search results: ←/PageUp = Prev, →/PageDown = Next.
  // Avoid interfering with typing in inputs/textareas/selects.
  document.addEventListener('keydown', (e)=>{
    if(e.defaultPrevented) return;
    if(e.ctrlKey || e.altKey || e.metaKey) return;
    const key = e.key;
    if(key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'PageUp' && key !== 'PageDown') return;

    const active = document.activeElement;
    const tag = String(active?.tagName || '').toLowerCase();
    if(tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if(active && active.isContentEditable) return;

    const hasQuery = !!String(listSearchPager?.query || '').trim();
    if(!hasQuery) return;

    if(key === 'ArrowLeft' || key === 'PageUp'){
      goPrevListSearchPage();
      e.preventDefault();
      return;
    }
    if(key === 'ArrowRight' || key === 'PageDown'){
      goNextListSearchPage();
      e.preventDefault();
      return;
    }
  }, true);
  $('#in-query')?.addEventListener('keydown', (e)=>{
    if(e.key !== 'Enter') return;
    e.preventDefault();
    void (async()=>{
      const added = await tryQuickAddFromAddItemInputs();
      if(!added) await doSearch();
    })();
  });

  // Enter in Note should also attempt to save.
  $('#in-note')?.addEventListener('keydown', (e)=>{
    if(e.key !== 'Enter') return;
    e.preventDefault();
    void (async()=>{
      const added = await tryQuickAddFromAddItemInputs();
      if(!added) await doSearch();
    })();
  });

  // Price Check tab
  $('#pc-btn-search')?.addEventListener('click', priceCheckSearch);
  $('#pc-query')?.addEventListener('keydown', (e)=>{
    if(e.key !== 'Enter') return;
    e.preventDefault();
    void (async()=>{
      const added = await tryQuickAddFromPriceCheckInputs();
      if(!added) await priceCheckSearch();
    })();
  });

  $('#btn-add-tab')?.addEventListener('click', createCustomTab);
  $('#sel-tab-manage')?.addEventListener('change', async function(){
    const val = this.value;
    this.value = '';
    if(!val) return;
    const sep = val.indexOf('::');
    if(sep < 0) return;
    const action = val.slice(0, sep);
    const key = val.slice(sep + 2);
    if(action === 'hide') await hideBuiltinTab(key);
    else if(action === 'delete') await deleteCustomTab(key);
    else if(action === 'restore'){
      if(!applyRestoreHiddenTabState(state, key)) return;
      buildTabsUI();
      await saveState();
      setActiveTab(key);
    }
  });
  $('#btn-export')?.addEventListener('click', ()=>{
    const opts = getExportUiOptions();
    exportPng(opts.scope, {
      layoutMode: opts.layoutMode,
      includeStoreTags: opts.includeStoreTags,
      pageSize: opts.pageSize,
      itemLimit: opts.itemLimit,
      exportScale: opts.exportScale
    });
  });

  $('#btn-export-data-backup')?.addEventListener('click', async()=>{
    try{
      await exportDataBackupFile();
    }catch(e){
      console.error('data backup export failed', e);
      alert('Could not export backup JSON. Please try again.');
    }
  });

  $('#btn-import-data-backup')?.addEventListener('click', ()=>{
    const picker = $('#input-import-data-backup');
    if(picker) picker.click();
  });

  $('#input-import-data-backup')?.addEventListener('change', async(e)=>{
    const input = e.currentTarget;
    const file = input?.files?.[0] || null;
    try{
      if(file) await importDataBackupFile(file);
    }catch(err){
      console.error('data backup import failed', err);
      const msg = (err && err.message) ? err.message : 'Could not import backup JSON. Please verify the file and try again.';
      alert(msg);
    }finally{
      if(input) input.value = '';
    }
  });

  $('#btn-open-sidebar')?.addEventListener('click', openSidePanel);
  // Filter inputs for each section
  const filterInputs = BUILTIN_TABS.map((tab)=> ({ id: '#filter-' + tab.key, section: tab.key }));
  
  filterInputs.forEach(({ id, section }) => {
    const input = $(id);
    if(!input) return;
    
    let debounceTimer = 0;
    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        sectionFilters[section] = input.value;
        render();
      }, 200);
    });
    
    // Clear filter on Escape
    input.addEventListener('keydown', (e) => {
      if(e.key === 'Escape'){
        e.preventDefault();
        input.value = '';
        sectionFilters[section] = '';
        render();
      }
    });
  });

  BUILTIN_TABS.forEach((tab)=>{
    $('#btn-clear-' + tab.key)?.addEventListener('click', ()=>clearSection(tab.key));
    $('#btn-refresh-' + tab.key)?.addEventListener('click', ()=>refreshSection(tab.key));
    $('#btn-repair-' + tab.key)?.addEventListener('click', ()=>repairImagesInSection(tab.key));
  });

  const persistVisibleState = ()=>{ void saveLocalStateSnapshot(); };
  window.addEventListener('pagehide', persistVisibleState);
  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState === 'hidden') persistVisibleState();
  });

  // Keep state updated across devices.
  chrome.storage.onChanged.addListener((changes, area)=>{
    if(area !== 'sync') return;
    if(!changes[SYNC_SETTINGS_KEY]) return;

    // Update settings from SYNC_SETTINGS_KEY if changed
    if(changes[SYNC_SETTINGS_KEY]){
      const prevSettings = normalizeSettingsFromStorage(state.settings);
      const incomingSettings = normalizeSettingsFromStorage(changes[SYNC_SETTINGS_KEY].newValue || {});
      const nextSettings = pickPreferredSettings(prevSettings, incomingSettings);
      const acceptedIncoming = areSettingsEqual(nextSettings, incomingSettings);
      const prevCtJson = JSON.stringify(state.settings.customTabs || []);
      const prevTabOrderJson = JSON.stringify(state.settings.tabOrder || []);
      const prevHiddenJson = JSON.stringify(state.settings.hiddenTabs || []);
      state.settings = nextSettings;
      lastSettingsContentFingerprint = buildSettingsContentFingerprint(nextSettings);
      lastSyncedSettingsPayloadJson = JSON.stringify(incomingSettings);
      for(const tab of nextSettings.customTabs){
        if(tab?.key && !Array.isArray(state[tab.key])) state[tab.key] = [];
      }
      if(JSON.stringify(nextSettings.customTabs) !== prevCtJson
        || JSON.stringify(state.settings.tabOrder) !== prevTabOrderJson
        || JSON.stringify(state.settings.hiddenTabs) !== prevHiddenJson) buildTabsUI();

      void saveLocalStateSnapshot();
      if(!acceptedIncoming){
        queueSyncSettingsWrite(nextSettings, { immediate: true, force: true });
      }
    }

    applyTheme(themeFromState());
    const themeSelect = $('#theme-select');
    if(themeSelect) themeSelect.value = themeFromState();
    const imgSourceSelect = $('#image-source-select');
    if(imgSourceSelect) imgSourceSelect.value = imageSourceFromState();
    render();
  });
});
}

  if(typeof module === 'object' && module.exports){
    module.exports = {
      buildDataBackupPayload,
      parseDataBackupPayloadText,
      normalizeImportedListEntries,
      backupTabKeysFromState,
      exportSectionsForScope,
      defaultState,
      getTabsFullOrder,
      getEffectiveTabOrder,
      applyHideBuiltinTabState,
      applyRestoreHiddenTabState,
      applyCreateCustomTabState,
      buildDeleteCustomTabPrompt,
      applyDeleteCustomTabState,
      pickPreferredSettings,
      mergePersistedListState,
      normalizeSettingsFromStorage,
      normalizeStateFromStorage,
      setStateForTests
    };
  }
