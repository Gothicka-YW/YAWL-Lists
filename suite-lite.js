(function () {
  const MODULE_KEY = 'yo_boards_active_module_v1';
  const LOCAL_KEY = 'yo_boards_local_v1';
  const SYNC_SETTINGS_KEY = 'yo_boards_sync_settings_v1';
  const UI_PREFS_KEY = 'yo_boards_ui_prefs_v1';

  function qs(sel) {
    return document.querySelector(sel);
  }

  function normalizeModule(value) {
    return (value === 'selection' || value === 'boardbuilder' || value === 'settings')
      ? value
      : 'selection';
  }

  function normalizeTheme(value) {
    const known = [
      'classic',
      'dark',
      'valentine',
      'ocean',
      'forest',
      'sunset',
      'arcane',
      'cyberpunk',
      'autumn',
      'midnight',
      'cherryblossom',
      'emerald'
    ];
    return known.includes(value) ? value : 'classic';
  }

  function normalizeImageSource(value) {
    return (value === 'cdn' || value === 'info' || value === 'auto') ? value : 'cdn';
  }

  function normalizeSurface(value) {
    return value === 'popup' ? 'popup' : 'sidepanel';
  }

  function setActiveModule(moduleName) {
    const module = normalizeModule(moduleName);

    const selectionRoot = qs('#suite-selection');
    const boardBuilderRoot = qs('#suite-boardbuilder');
    const settingsRoot = qs('#suite-settings');

    if (selectionRoot) selectionRoot.hidden = module !== 'selection';
    if (boardBuilderRoot) boardBuilderRoot.hidden = module !== 'boardbuilder';
    if (settingsRoot) settingsRoot.hidden = module !== 'settings';

    const btnSelection = qs('#suite-nav-selection');
    const btnBoardBuilder = qs('#suite-nav-boardbuilder');
    const btnSettings = qs('#suite-nav-settings');

    if (btnSelection) btnSelection.classList.toggle('is-active', module === 'selection');
    if (btnBoardBuilder) btnBoardBuilder.classList.toggle('is-active', module === 'boardbuilder');
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

  async function updateLocalSettingsMirror(patch) {
    const res = await storageGet('local', LOCAL_KEY);
    const current = (res.value && typeof res.value === 'object') ? res.value : {};
    const next = {
      ...current,
      settings: {
        ...(current.settings && typeof current.settings === 'object' ? current.settings : {}),
        ...patch
      }
    };
    const result = await storageSet('local', LOCAL_KEY, next);
    if (!result.ok) {
      console.warn('Could not mirror local settings:', result.error);
    }
  }

  async function updateSyncSettings(patch) {
    const current = await readSyncSettings();
    const next = {
      ...current,
      ...patch
    };
    const result = await storageSet('sync', SYNC_SETTINGS_KEY, next);
    if (!result.ok) {
      console.warn('Could not save sync settings:', result.error);
    }
    await updateLocalSettingsMirror(patch);
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
    allowCopyTextCheckbox.checked = !!settings.allowCopyText;
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
      const windowId = await getCurrentWindowId();
      await sendRuntimeMessage({ type: 'YB_OPEN_SURFACE', surface: 'sidepanel', windowId });
    });

    btnOpenPopup?.addEventListener('click', async () => {
      await sendRuntimeMessage({ type: 'YB_OPEN_SURFACE', surface: 'popup' });
    });
  }

  function wireModuleNavigation() {
    qs('#suite-nav-selection')?.addEventListener('click', () => setActiveModule('selection'));
    qs('#suite-nav-boardbuilder')?.addEventListener('click', () => setActiveModule('boardbuilder'));
    qs('#suite-nav-settings')?.addEventListener('click', () => setActiveModule('settings'));
  }

  document.addEventListener('DOMContentLoaded', () => {
    wireModuleNavigation();
    setActiveModule(loadActiveModule());
  });
})();
