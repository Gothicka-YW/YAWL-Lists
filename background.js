const UI_PREFS_KEY = 'yo_boards_ui_prefs_v1';

function normalizeSurface(value) {
  return value === 'popup' ? 'popup' : 'sidepanel';
}

function storageGetSync(key) {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get([key], (res) => {
        const err = chrome.runtime?.lastError;
        resolve({ value: res ? res[key] : undefined, error: err ? String(err.message || err) : '' });
      });
    } catch (e) {
      resolve({ value: undefined, error: String(e?.message || e) });
    }
  });
}

function storageSetSync(key, value) {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.set({ [key]: value }, () => {
        const err = chrome.runtime?.lastError;
        resolve({ ok: !err, error: err ? String(err.message || err) : '' });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e?.message || e) });
    }
  });
}

async function loadUiPrefs() {
  const res = await storageGetSync(UI_PREFS_KEY);
  const raw = (res.value && typeof res.value === 'object') ? res.value : {};
  return {
    defaultSurface: normalizeSurface(raw.defaultSurface)
  };
}

async function saveUiPrefs(next) {
  const prefs = {
    defaultSurface: normalizeSurface(next?.defaultSurface)
  };
  const result = await storageSetSync(UI_PREFS_KEY, prefs);
  if (!result.ok) {
    console.warn('Failed to save UI prefs:', result.error);
  }
  return prefs;
}

async function applyPanelBehaviorFromPrefs() {
  const prefs = await loadUiPrefs();
  try {
    await chrome.sidePanel.setPanelBehavior({
      openPanelOnActionClick: prefs.defaultSurface === 'sidepanel'
    });
  } catch (e) {
    console.warn('Could not set side panel behavior:', e);
  }

  try {
    await chrome.action.setPopup({
      popup: prefs.defaultSurface === 'popup' ? 'popup.html' : ''
    });
  } catch (e) {
    console.warn('Could not set action popup path:', e);
  }

  return prefs;
}

function getCurrentWindowId() {
  return new Promise((resolve) => {
    try {
      chrome.windows.getLastFocused((win) => {
        resolve(typeof win?.id === 'number' ? win.id : null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function openExtensionPopup(options) {
  const opts = (options && typeof options === 'object') ? options : {};
  const restoreAfterOpen = !!opts.restoreAfterOpen;
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
    if (!chrome.action?.openPopup) {
      return false;
    }
    await chrome.action.openPopup();

    if (restoreAfterOpen && chrome.action?.setPopup) {
      await chrome.action.setPopup({ popup: previousPopup || '' });
    }

    return true;
  } catch (e) {
    console.error('Failed to open extension popup:', e);

    if (restoreAfterOpen && chrome.action?.setPopup) {
      try {
        await chrome.action.setPopup({ popup: previousPopup || '' });
      } catch {}
    }

    return false;
  }
}

async function openSidePanel(windowId) {
  const winId = (typeof windowId === 'number') ? windowId : await getCurrentWindowId();
  if (typeof winId !== 'number') return false;
  try {
    await chrome.sidePanel.open({ windowId: winId });
    return true;
  } catch (e) {
    console.error('Failed to open side panel:', e);
    return false;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void applyPanelBehaviorFromPrefs();
});

chrome.runtime.onStartup?.addListener?.(() => {
  void applyPanelBehaviorFromPrefs();
});

chrome.action.onClicked.addListener((tab) => {
  void (async () => {
    const prefs = await loadUiPrefs();
    if (prefs.defaultSurface === 'popup') {
      await openExtensionPopup({ restoreAfterOpen: false });
      return;
    }

    const opened = await openSidePanel(tab?.windowId);
    if (!opened) {
      await openExtensionPopup({ restoreAfterOpen: true });
    }
  })();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  void (async () => {
    if (msg?.type === 'YB_GET_UI_PREFS') {
      const prefs = await loadUiPrefs();
      sendResponse({ ok: true, prefs });
      return;
    }

    if (msg?.type === 'YB_SET_LAUNCH_SURFACE') {
      const prefs = await saveUiPrefs({ defaultSurface: msg?.surface });
      await applyPanelBehaviorFromPrefs();
      sendResponse({ ok: true, prefs });
      return;
    }

    if (msg?.type === 'YB_OPEN_SURFACE') {
      const surface = normalizeSurface(msg?.surface);
      const prefs = await loadUiPrefs();
      const ok = surface === 'popup'
        ? await openExtensionPopup({ restoreAfterOpen: prefs.defaultSurface !== 'popup' })
        : await openSidePanel(msg?.windowId);
      sendResponse({ ok });
      return;
    }

    sendResponse({ ok: false, error: 'Unknown message type.' });
  })();

  return true;
});
