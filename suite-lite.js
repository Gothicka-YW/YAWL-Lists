(function () {
  const MODULE_KEY = 'yawl_lists_active_module_v1';
  const LOCAL_KEY = 'yawl_lists_local_v1';
  const SYNC_SETTINGS_KEY = 'yawl_lists_sync_settings_v1';
  const UI_PREFS_KEY = 'yawl_lists_ui_prefs_v1';

  function qs(sel) {
    return document.querySelector(sel);
  }

  function normalizeModule(value) {
    return (value === 'selection' || value === 'settings')
      ? value
      : 'selection';
  }

  function normalizeTheme(value) {
    const legacyThemeMap = {
      arcane: 'naturefantasy',
      cyberpunk: 'dark',
      midnight: 'dark',
      cherryblossom: 'prored'
    };
    const normalized = typeof value === 'string' ? value.toLowerCase() : '';
    const migrated = legacyThemeMap[normalized] || normalized;
    const known = [
      'classic',
      'dark',
      'valentine',
      'ocean',
      'forest',
      'naturefantasy',
      'sunset',
      'autumn',
      'prored',
      'emerald'
    ];
    return known.includes(migrated) ? migrated : 'ocean';
  }

  function normalizeImageSource(value) {
    return (value === 'cdn' || value === 'info' || value === 'auto') ? value : 'cdn';
  }

  function normalizeSurface(value) {
    return value === 'popup' ? 'popup' : 'sidepanel';
  }

  function normalizeAllowCopyText(value) {
    return value === true || value === 1;
  }

  function safeNow() {
    try {
      return Date.now();
    } catch {
      return 0;
    }
  }

  function setActiveModule(moduleName) {
    const module = normalizeModule(moduleName);

    const selectionRoot = qs('#suite-selection');
    const settingsRoot = qs('#suite-settings');

    if (selectionRoot) selectionRoot.hidden = module !== 'selection';
    if (settingsRoot) settingsRoot.hidden = module !== 'settings';

    const btnSelection = qs('#suite-nav-selection');
    const btnSettings = qs('#suite-nav-settings');

    if (btnSelection) btnSelection.classList.toggle('is-active', module === 'selection');
    if (btnSettings) btnSettings.classList.toggle('is-active', module === 'settings');

    try {
      localStorage.setItem(MODULE_KEY, module);
    } catch {}

    if (module === 'settings') {
      void initializeSettingsUI();
    }
  }

  function loadActiveModule() {
    try {
      return normalizeModule(localStorage.getItem(MODULE_KEY));
    } catch {
      return 'selection';
    }
  }

  function storageGet(area, key) {
    return new Promise((resolve) => {
      try {
        chrome.storage[area].get([key], (res) => {
          const err = chrome.runtime?.lastError;
          resolve({ value: res ? res[key] : undefined, error: err ? String(err.message || err) : '' });
        });
      } catch (e) {
        resolve({ value: undefined, error: String(e?.message || e) });
      }
    });
  }

  function storageSet(area, key, value) {
    return new Promise((resolve) => {
      try {
        chrome.storage[area].set({ [key]: value }, () => {
          const err = chrome.runtime?.lastError;
          resolve({ ok: !err, error: err ? String(err.message || err) : '' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e?.message || e) });
      }
    });
  }

  async function readSyncSettings() {
    const res = await storageGet('sync', SYNC_SETTINGS_KEY);
    if (res.error) {
      console.warn('Could not read sync settings:', res.error);
    }
    return (res.value && typeof res.value === 'object') ? res.value : {};
  }

  async function updateLocalSettingsMirror(patch, lastSavedAt) {
    const res = await storageGet('local', LOCAL_KEY);
    const current = (res.value && typeof res.value === 'object') ? res.value : {};
    const next = {
      ...current,
      settings: {
        ...(current.settings && typeof current.settings === 'object' ? current.settings : {}),
        ...patch,
        lastSavedAt: Number.isFinite(lastSavedAt) && lastSavedAt > 0 ? lastSavedAt : safeNow()
      }
    };
    const result = await storageSet('local', LOCAL_KEY, next);
    if (!result.ok) {
      console.warn('Could not mirror local settings:', result.error);
    }
  }

  async function updateSyncSettings(patch) {
    const current = await readSyncSettings();
    const nextTheme = Object.prototype.hasOwnProperty.call(patch || {}, 'theme')
      ? normalizeTheme(patch.theme)
      : current.theme;
    const nextImageSource = Object.prototype.hasOwnProperty.call(patch || {}, 'imageSource')
      ? normalizeImageSource(patch.imageSource)
      : current.imageSource;
    const nextAllowCopyText = Object.prototype.hasOwnProperty.call(patch || {}, 'allowCopyText')
      ? normalizeAllowCopyText(patch.allowCopyText)
      : current.allowCopyText;

    const changed = nextTheme !== current.theme
      || nextImageSource !== current.imageSource
      || nextAllowCopyText !== current.allowCopyText;

    if (!changed) {
      return current;
    }

    const nextSavedAt = safeNow();
    const next = {
      ...current,
      theme: nextTheme,
      imageSource: nextImageSource,
      allowCopyText: nextAllowCopyText,
      lastSavedAt: nextSavedAt
    };
    const result = await storageSet('sync', SYNC_SETTINGS_KEY, next);
    if (!result.ok) {
      const msg = String(result.error || '');
      if (/MAX_WRITE_OPERATIONS_PER_MINUTE|MAX_WRITE_OPERATIONS_PER_HOUR/i.test(msg)) {
        console.info('Sync settings write throttled; change will be retried later.');
      } else {
        console.warn('Could not save sync settings:', result.error);
      }
    }
    await updateLocalSettingsMirror(patch, nextSavedAt);
    return next;
  }

  async function readUiPrefs() {
    const res = await storageGet('sync', UI_PREFS_KEY);
    const raw = (res.value && typeof res.value === 'object') ? res.value : {};
    return {
      defaultSurface: normalizeSurface(raw.defaultSurface)
    };
  }

  async function writeUiPrefs(prefs) {
    const next = {
      defaultSurface: normalizeSurface(prefs?.defaultSurface)
    };
    const result = await storageSet('sync', UI_PREFS_KEY, next);
    if (!result.ok) {
      console.warn('Could not save UI prefs:', result.error);
    }
    return next;
  }

  function applyThemeToBody(theme) {
    const safeTheme = normalizeTheme(theme);
    if (!document.body) return;
    if (safeTheme === 'classic') {
      document.body.removeAttribute('data-theme');
      return;
    }
    document.body.setAttribute('data-theme', safeTheme);
  }

  function getCurrentWindowId() {
    return new Promise((resolve) => {
      try {
        chrome.windows.getCurrent((win) => {
          resolve(typeof win?.id === 'number' ? win.id : null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  async function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const err = chrome.runtime?.lastError;
          if (err) {
            resolve({ ok: false, error: String(err.message || err) });
            return;
          }
          resolve(response || { ok: false });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e?.message || e) });
      }
    });
  }

  async function openSidePanelFromGesture() {
    if (!chrome?.sidePanel?.open) {
      return { ok: false, error: 'Side panel API is unavailable in this Chrome version.' };
    }

    try {
      const currentWindowId = chrome?.windows?.WINDOW_ID_CURRENT;
      if (typeof currentWindowId === 'number') {
        await chrome.sidePanel.open({ windowId: currentWindowId });
        return { ok: true };
      }
    } catch (e) {
      // Fall through to a slower fallback that resolves a numeric window id.
      void e;
    }

    const windowId = await getCurrentWindowId();
    if (typeof windowId !== 'number') {
      return { ok: false, error: 'Could not determine current window id.' };
    }

    try {
      await chrome.sidePanel.open({ windowId });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  async function openPopupFromGesture() {
    if (!chrome?.action?.openPopup) {
      return { ok: false, error: 'Action popup API is unavailable in this Chrome version.' };
    }

    let previousPopup = '';
    try {
      if (chrome.action?.getPopup) {
        previousPopup = await chrome.action.getPopup({}) || '';
      }
    } catch {}

    try {
      if (chrome.action?.setPopup) {
        await chrome.action.setPopup({ popup: 'popup.html' });
      }
      await chrome.action.openPopup();
      if (chrome.action?.setPopup) {
        await chrome.action.setPopup({ popup: previousPopup || '' });
      }
      return { ok: true };
    } catch (e) {
      if (chrome.action?.setPopup) {
        try {
          await chrome.action.setPopup({ popup: previousPopup || '' });
        } catch {}
      }
      return { ok: false, error: String(e?.message || e) };
    }
  }

  let settingsInitialized = false;

  async function initializeSettingsUI() {
    const themeSelect = qs('#suite-theme-select');
    const imageSourceSelect = qs('#suite-image-source-select');
    const allowCopyTextCheckbox = qs('#suite-allow-copy-text');
    const surfaceSelect = qs('#suite-default-surface');
    const btnOpenSidePanel = qs('#suite-btn-open-sidepanel');
    const btnOpenPopup = qs('#suite-btn-open-popup');

    if (!themeSelect || !imageSourceSelect || !allowCopyTextCheckbox || !surfaceSelect) {
      return;
    }

    const [settings, prefs] = await Promise.all([
      readSyncSettings(),
      readUiPrefs()
    ]);

    themeSelect.value = normalizeTheme(settings.theme);
    imageSourceSelect.value = normalizeImageSource(settings.imageSource);
    allowCopyTextCheckbox.checked = normalizeAllowCopyText(settings.allowCopyText);
    surfaceSelect.value = normalizeSurface(prefs.defaultSurface);

    applyThemeToBody(themeSelect.value);

    if (settingsInitialized) return;
    settingsInitialized = true;

    themeSelect.addEventListener('change', async () => {
      const theme = normalizeTheme(themeSelect.value);
      applyThemeToBody(theme);
      await updateSyncSettings({ theme });
    });

    imageSourceSelect.addEventListener('change', async () => {
      const imageSource = normalizeImageSource(imageSourceSelect.value);
      await updateSyncSettings({ imageSource });
    });

    allowCopyTextCheckbox.addEventListener('change', async () => {
      await updateSyncSettings({ allowCopyText: !!allowCopyTextCheckbox.checked });
    });

    surfaceSelect.addEventListener('change', async () => {
      const defaultSurface = normalizeSurface(surfaceSelect.value);
      await writeUiPrefs({ defaultSurface });
      await sendRuntimeMessage({ type: 'YB_SET_LAUNCH_SURFACE', surface: defaultSurface });
    });

    btnOpenSidePanel?.addEventListener('click', async () => {
      const direct = await openSidePanelFromGesture();
      if (direct.ok) return;

      const windowId = await getCurrentWindowId();
      const fallback = await sendRuntimeMessage({ type: 'YB_OPEN_SURFACE', surface: 'sidepanel', windowId });
      if (!fallback?.ok) {
        console.warn('Could not open side panel:', fallback?.error || direct.error || 'Unknown error');
      }
    });

    btnOpenPopup?.addEventListener('click', async () => {
      const direct = await openPopupFromGesture();
      if (direct.ok) return;

      const fallback = await sendRuntimeMessage({ type: 'YB_OPEN_SURFACE', surface: 'popup' });
      if (!fallback?.ok) {
        console.warn('Could not open popup:', fallback?.error || direct.error || 'Unknown error');
      }
    });
  }

  function wireModuleNavigation() {
    qs('#suite-nav-selection')?.addEventListener('click', () => setActiveModule('selection'));
    qs('#suite-nav-settings')?.addEventListener('click', () => setActiveModule('settings'));
  }

  document.addEventListener('DOMContentLoaded', () => {
    wireModuleNavigation();
    setActiveModule(loadActiveModule());
  });
})();
