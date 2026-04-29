(function(){
  const STORE_KEY = 'yo_boards_board_builder_v1';
  const QUICKFILL_PREFS_KEY = 'yo_boards_bb_quickfill_prefs_v1';
  const SUITE_LISTS_LOCAL_KEY = 'yo_boards_local_v1';
  const BOARD_COLS = 3;
  const BOARD_ROWS = 2;
  const BOARD_SLOTS = BOARD_COLS * BOARD_ROWS;

  const qs = (sel)=> document.querySelector(sel);
  const qsa = (sel)=> Array.from(document.querySelectorAll(sel));

  function setStatus(msg){
    const el = qs('#bb-status');
    if(el) el.textContent = String(msg || '');
  }

  function safeNow(){
    try{ return Date.now(); }catch{ return 0; }
  }

  function clamp(n, a, b){
    const x = Number(n);
    if(!Number.isFinite(x)) return a;
    return Math.min(b, Math.max(a, x));
  }

  function parseItemIdFromText(text){
    const s = String(text || '').trim();
    if(!s) return 0;
    // direct number
    const direct = s.match(/^\d{1,9}$/);
    if(direct) return Number(direct[0]) || 0;

    // common yoworld.info item URL patterns
    const m1 = s.match(/\/items\/(\d{1,9})/i) || s.match(/\bitem(?:Id)?=(\d{1,9})\b/i) || s.match(/\bid\/(\d{1,9})\b/i);
    if(m1 && m1[1]) return Number(m1[1]) || 0;

    // fallback: first long-ish number
    const m2 = s.match(/\b(\d{4,9})\b/);
    if(m2 && m2[1]) return Number(m2[1]) || 0;

    return 0;
  }

  function filenameSafe(s){
    return String(s || '')
      .replace(/[^a-z0-9_-]+/gi, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 64) || 'board';
  }

  async function storageGetLocal(key){
    return new Promise((resolve)=>{
      try{
        chrome.storage.local.get([key], (res)=>{
          const err = chrome.runtime?.lastError;
          resolve({ value: res ? res[key] : undefined, error: err ? String(err.message || err) : '' });
        });
      }catch(e){
        resolve({ value: undefined, error: String(e?.message || e) });
      }
    });
  }

  async function storageSetLocal(key, value){
    return new Promise((resolve)=>{
      try{
        chrome.storage.local.set({ [key]: value }, ()=>{
          const err = chrome.runtime?.lastError;
          resolve({ ok: !err, error: err ? String(err.message || err) : '' });
        });
      }catch(e){
        resolve({ ok: false, error: String(e?.message || e) });
      }
    });
  }

  async function fetchJsonWithTimeout(url, timeoutMs){
    const ctl = new AbortController();
    const t = setTimeout(()=>{ try{ ctl.abort(); }catch{} }, Math.max(1000, Number(timeoutMs) || 8000));
    try{
      const res = await fetch(url, { credentials: 'omit', signal: ctl.signal });
      return res;
    }finally{
      clearTimeout(t);
    }
  }

  async function fetchItemDetail(itemId){
    const id = Number(itemId) || 0;
    if(!id) return null;
    const url = `https://api.yoworld.info/api/items/${encodeURIComponent(String(id))}`;
    const res = await fetchJsonWithTimeout(url, 10000);
    if(!res.ok) return null;
    const json = await res.json();
    return json?.data?.item || null;
  }

  function pickImageUrlFromItem(itemId, itemDetail, imageSource){
    const id = Number(itemId) || 0;
    const src = (imageSource === 'info' || imageSource === 'auto') ? 'info' : (imageSource === 'cdn' ? 'cdn' : 'cdn');

    // CDN URLs preserve original aspect ratio
    const fromCdn = (typeof buildYwCdnImageUrlFromId === 'function')
      ? buildYwCdnImageUrlFromId(id)
      : '';

    // API endpoint as fallback (forces dimensions, use as last resort)
    const fromApi = (typeof buildYwApiItemImageUrlFromId === 'function')
      ? buildYwApiItemImageUrlFromId(id, '130_100')
      : `https://api.yoworld.info/api/items/${id}/image/130_100`;

    // Prefer explicit item-provided image URLs if present.
    const maybe = (typeof deepFindImageUrl === 'function') ? deepFindImageUrl(itemDetail) : '';

    let base = '';
    if(src === 'info') base = fromApi;
    if(src === 'cdn') base = fromCdn || fromApi;
    if(src === 'auto') base = fromCdn || fromApi;

    // If we found a plausible image URL inside the payload, use it for auto.
    if(imageSource === 'auto' && maybe) base = maybe;

    // DON'T wrap with proxy for board builder - we need original dimensions
    return base;
  }

  function drawContain(ctx, img, x, y, w, h){
    const iw = img.naturalWidth || img.width || 1;
    const ih = img.naturalHeight || img.height || 1;
    
    console.log(`drawContain: source ${iw}x${ih}, container ${w}x${h}`);
    
    // Calculate scale to fit image within container while preserving aspect ratio
    const scale = Math.min(w / iw, h / ih);
    
    // Calculate final dimensions
    const dw = iw * scale;
    const dh = ih * scale;
    
    console.log(`  scale=${scale.toFixed(3)}, result ${dw.toFixed(1)}x${dh.toFixed(1)}`);
    
    // Center the image in the container
    const dx = x + (w - dw) / 2;
    const dy = y + (h - dh) / 2;
    
    ctx.save();
    // Clip to rounded rectangle to contain image
    roundRect(ctx, x, y, w, h, 8);
    ctx.clip();
    // Draw the entire source image scaled to fit
    ctx.drawImage(img, 0, 0, iw, ih, dx, dy, dw, dh);
    ctx.restore();
  }

  function fitText(ctx, text, maxWidth){
    let s = String(text || '').trim();
    if(!s) return '';
    if(ctx.measureText(s).width <= maxWidth) return s;
    while(s.length > 0 && ctx.measureText(s + '…').width > maxWidth){
      s = s.slice(0, -1);
    }
    return s ? (s + '…') : '';
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
        const rest = [line, ...words.slice(words.indexOf(w)+1)].join(' ');
        const fitted = fitText(ctx, rest, maxWidth);
        lines.push(fitted);
        truncated = fitted.endsWith('…');
        return { lines, truncated };
      }
    }

    if(line) lines.push(line);
    return { lines: lines.slice(0, maxLines), truncated };
  }

  function drawCenteredPillText(ctx, text, x, y, w, h, bg, border, color){
    ctx.save();
    const padX = 8;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    const maxTextW = Math.max(0, w - padX * 2);
    const fitted = fitText(ctx, text, maxTextW);
    const textW = ctx.measureText(fitted).width;
    const pillW = Math.min(w, Math.max(44, textW + padX * 2));
    const px = x + (w - pillW) / 2;

    ctx.fillStyle = bg;
    roundRect(ctx, px, y, pillW, h, Math.floor(h / 2));
    ctx.fill();
    ctx.strokeStyle = border;
    ctx.lineWidth = 1.5;
    roundRect(ctx, px, y, pillW, h, Math.floor(h / 2));
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.fillText(fitted, x + w / 2, y + h / 2);
    ctx.restore();
  }

  function isKnownThemeValue(val){
    return val === 'classic' || val === 'dark' || val === 'valentine' 
      || val === 'ocean' || val === 'forest' || val === 'sunset' 
      || val === 'arcane' || val === 'cyberpunk' || val === 'autumn' 
      || val === 'midnight' || val === 'cherryblossom' || val === 'emerald';
  }

  function exportPalette(theme){
    if(theme === 'dark'){
      return { priceBg: '#1f2a44', priceBorder: '#14b8a6', priceText: '#e5e7eb' };
    }
    if(theme === 'arcane'){
      return { priceBg: '#221842', priceBorder: '#d4af37', priceText: '#f3f0ff' };
    }
    if(theme === 'valentine'){
      return { priceBg: '#ffe4e6', priceBorder: '#e11d48', priceText: '#1f2937' };
    }
    if(theme === 'ocean'){
      return { priceBg: '#cffafe', priceBorder: '#0891b2', priceText: '#0f172a' };
    }
    if(theme === 'forest'){
      return { priceBg: '#dcfce7', priceBorder: '#16a34a', priceText: '#052e16' };
    }
    if(theme === 'sunset'){
      return { priceBg: '#ffedd5', priceBorder: '#f97316', priceText: '#1f2937' };
    }
    if(theme === 'cyberpunk'){
      return { priceBg: '#2d1b4e', priceBorder: '#e100ff', priceText: '#f0e6ff' };
    }
    if(theme === 'autumn'){
      return { priceBg: '#fde7c8', priceBorder: '#d84315', priceText: '#3e2723' };
    }
    if(theme === 'midnight'){
      return { priceBg: '#0f1936', priceBorder: '#5e72e4', priceText: '#d8e3f0' };
    }
    if(theme === 'cherryblossom'){
      return { priceBg: '#ffe4e9', priceBorder: '#ff69b4', priceText: '#4a1c29' };
    }
    if(theme === 'emerald'){
      return { priceBg: '#c8e6c9', priceBorder: '#2e7d32', priceText: '#1b5e20' };
    }
    // classic
    return { priceBg: '#f3f4f6', priceBorder: '#111827', priceText: '#111827' };
  }

  function createDefaultState(){
    return {
      updatedAt: safeNow(),
      slots: Array.from({ length: BOARD_SLOTS }, ()=>({
        input: '',
        itemId: 0,
        name: '',
        imageUrl: '',
        caption: ''
      }))
    };
  }

  let bbState = createDefaultState();

  async function loadBoardBuilderState(){
    const res = await storageGetLocal(STORE_KEY);
    if(res.error) return;
    const v = res.value;
    if(v && typeof v === 'object' && Array.isArray(v.slots)){
      const next = createDefaultState();
      for(let i=0;i<BOARD_SLOTS;i++){
        const s = v.slots[i] || {};
        next.slots[i] = {
          input: typeof s.input === 'string' ? s.input : '',
          itemId: Number(s.itemId) || 0,
          name: typeof s.name === 'string' ? s.name : '',
          imageUrl: typeof s.imageUrl === 'string' ? s.imageUrl : '',
          caption: typeof s.caption === 'string' ? s.caption : ''
        };
      }
      bbState = next;
    }
  }

  async function saveBoardBuilderState(){
    bbState.updatedAt = safeNow();
    const res = await storageSetLocal(STORE_KEY, bbState);
    if(!res.ok) console.warn('board builder save failed:', res.error);
  }

  function slotNode(i){
    const s = bbState.slots[i];
    const div = document.createElement('div');
    div.className = 'bb-slot';
    div.dataset.slot = String(i);

    const head = document.createElement('div');
    head.className = 'bb-slot-head';

    const title = document.createElement('div');
    title.className = 'bb-slot-title';
    title.textContent = `Slot ${i+1}`;

    const btns = document.createElement('div');
    btns.className = 'inline';

    const btnLoad = document.createElement('button');
    btnLoad.type = 'button';
    btnLoad.textContent = 'Load';

    const btnClear = document.createElement('button');
    btnClear.type = 'button';
    btnClear.className = 'ghost';
    btnClear.textContent = 'Clear';

    btns.appendChild(btnLoad);
    btns.appendChild(btnClear);

    head.appendChild(title);
    head.appendChild(btns);

    const wrap = document.createElement('div');
    wrap.className = 'bb-slot-preview';

    const thumb = document.createElement('div');
    thumb.className = 'bb-thumb';

    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    if(s.imageUrl) img.src = s.imageUrl;
    thumb.appendChild(img);

    const fields = document.createElement('div');
    fields.className = 'bb-slot-fields';

    const in1 = document.createElement('input');
    in1.type = 'text';
    in1.placeholder = 'Paste item ID / YoWorld.info link';
    in1.value = s.input || (s.itemId ? String(s.itemId) : '');

    const in2 = document.createElement('input');
    in2.type = 'text';
    in2.placeholder = 'Caption (optional)';
    in2.value = s.caption || '';

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = s.name ? s.name : ' '; // keep height stable

    fields.appendChild(in1);
    fields.appendChild(in2);
    fields.appendChild(hint);

    wrap.appendChild(thumb);
    wrap.appendChild(fields);

    div.appendChild(head);
    div.appendChild(wrap);

    const onInput = ()=>{
      bbState.slots[i].input = in1.value;
      saveBoardBuilderState();
    };

    in1.addEventListener('change', onInput);
    in1.addEventListener('blur', onInput);

    in2.addEventListener('input', ()=>{
      bbState.slots[i].caption = in2.value;
      saveBoardBuilderState();
      renderCanvas();
    });

    btnClear.addEventListener('click', async ()=>{
      bbState.slots[i] = { input:'', itemId:0, name:'', imageUrl:'', caption:'' };
      await saveBoardBuilderState();
      in1.value = '';
      in2.value = '';
      img.removeAttribute('src');
      hint.textContent = ' ';
      await renderCanvas();
      setStatus('Cleared slot ' + (i+1) + '.');
    });

    btnLoad.addEventListener('click', async ()=>{
      const raw = in1.value;
      const itemId = parseItemIdFromText(raw);
      if(!itemId){
        setStatus('Paste a valid item ID or YoWorld.info link.');
        return;
      }
      setStatus('Loading item ' + itemId + '…');
      try{
        const detail = await fetchItemDetail(itemId);
        const name = String(detail?.name || detail?.item_name || '') || ('Item ' + itemId);

        // Pull image source from Suite state (if available)
        let imageSource = 'auto';
        try{ if(window.state && window.state.settings && window.state.settings.imageSource) imageSource = window.state.settings.imageSource; }catch{}

        const imageUrl = pickImageUrlFromItem(itemId, detail, imageSource);

        bbState.slots[i].input = raw;
        bbState.slots[i].itemId = itemId;
        bbState.slots[i].name = name;
        bbState.slots[i].imageUrl = imageUrl;
        await saveBoardBuilderState();

        img.src = imageUrl;
        hint.textContent = name;

        await renderCanvas();
        setStatus('Loaded slot ' + (i+1) + '.');
      }catch(e){
        console.error(e);
        setStatus('Failed to load item ' + itemId + '.');
      }
    });

    return div;
  }

  function ensureSlotsUI(){
    const root = qs('#bb-slots');
    if(!root) return;
    if(root.childElementCount > 0) return;
    for(let i=0;i<BOARD_SLOTS;i++) root.appendChild(slotNode(i));
  }

  async function loadSuiteListsState(){
    // Matches popup.js: lists live in local under LOCAL_KEY.
    const res = await storageGetLocal(SUITE_LISTS_LOCAL_KEY);
    if(res.error) return null;
    const v = res.value;
    return (v && typeof v === 'object') ? v : null;
  }

  function normalizeListEntryToSlot(entry){
    const e = (entry && typeof entry === 'object') ? entry : {};
    const itemId = Number(e.itemId || e.id || e.item_id || e.itemID) || 0;
    const name = String(e.name || e.title || '') || (itemId ? ('Item ' + itemId) : '');

    let imageUrl = '';

    // ALWAYS build fresh CDN URL from itemId to avoid stretched API URLs that may be stored
    if(itemId){
      // Check if there's a CDN URL stored (these preserve aspect ratio)
      const storedUrl = String(e.ywCdnImageUrl || e.cdnImageUrl || '') || '';
      if(storedUrl && storedUrl.includes('yw-web.yoworld.com/cdn/')){
        imageUrl = storedUrl;
      }else if(typeof buildYwCdnImageUrlFromId === 'function'){
        imageUrl = buildYwCdnImageUrlFromId(itemId);
      }else{
        // Fallback: construct CDN URL manually (preserves original aspect ratio)
        const s = String(Math.trunc(itemId)).padStart(4, '0');
        const g1 = s.substring(0, 2);
        const g2 = s.substring(2, 4);
        imageUrl = `https://yw-web.yoworld.com/cdn/items/${g1}/${g2}/${itemId}/${itemId}.png`;
      }
    }

    // DON'T wrap with proxy - we need original dimensions, proxy may resize to 390x260

    const note = String(e.note || '').trim();

    return { itemId, name, imageUrl, note };
  }

  async function saveQuickFillPrefs(listName, startIndex, useNotes){
    const fallbackListName = String(qs('#bb-fill-list')?.options?.[0]?.value || '');
    const prefs = {
      listName: String(listName || fallbackListName),
      startIndex: Number(startIndex) || 1,
      useNotes: !!useNotes
    };
    await storageSetLocal(QUICKFILL_PREFS_KEY, prefs);
  }

  async function loadQuickFillPrefs(){
    const res = await storageGetLocal(QUICKFILL_PREFS_KEY);
    if(res.error || !res.value) return null;
    return res.value;
  }

  function applyQuickFillPrefs(prefs){
    if(!prefs) return;
    const listSel = qs('#bb-fill-list');
    const startIn = qs('#bb-fill-start');
    const useNotes = qs('#bb-fill-use-notes');

    if(listSel && prefs.listName) listSel.value = prefs.listName;
    if(startIn && prefs.startIndex) startIn.value = prefs.startIndex;
    if(useNotes && typeof prefs.useNotes === 'boolean') useNotes.checked = prefs.useNotes;
  }

  async function fillFromList(autoIncrement){
    const listSel = qs('#bb-fill-list');
    const startIn = qs('#bb-fill-start');
    const useNotes = qs('#bb-fill-use-notes');

    const listName = String(listSel?.value || listSel?.options?.[0]?.value || '');
    let startIndex = clamp(startIn?.value || 1, 1, 999999);
    const useNoteCaptions = !!useNotes?.checked;

    setStatus('Loading list…');
    const lists = await loadSuiteListsState();
    if(!lists){
      setStatus('Could not read lists from storage.');
      return;
    }

    const arr = Array.isArray(lists[listName]) ? lists[listName] : [];
    const offset = startIndex - 1;

    for(let i=0;i<BOARD_SLOTS;i++){
      const entry = arr[offset + i];
      if(!entry){
        bbState.slots[i] = { input:'', itemId:0, name:'', imageUrl:'', caption:'' };
        continue;
      }
      const mapped = normalizeListEntryToSlot(entry);
      bbState.slots[i] = {
        input: mapped.itemId ? String(mapped.itemId) : '',
        itemId: mapped.itemId,
        name: mapped.name,
        imageUrl: mapped.imageUrl,
        caption: useNoteCaptions ? (mapped.note || '') : ''
      };
    }

    await saveBoardBuilderState();

    // Refresh UI fields.
    const slotDivs = qsa('.bb-slot');
    slotDivs.forEach((d)=>{
      const i = Number(d.dataset.slot) || 0;
      const s = bbState.slots[i];
      const inputs = Array.from(d.querySelectorAll('input'));
      const img = d.querySelector('img');
      const hint = d.querySelector('.hint');
      if(inputs[0]) inputs[0].value = s.input || (s.itemId ? String(s.itemId) : '');
      if(inputs[1]) inputs[1].value = s.caption || '';
      if(img){
        if(s.imageUrl) img.src = s.imageUrl;
        else img.removeAttribute('src');
      }
      if(hint) hint.textContent = s.name ? s.name : ' ';
    });

    await renderCanvas();
    setStatus('Filled 6 slots from ' + listName + '.');
    
    // If autoIncrement is true, increment the start index by 6 for next fill
    if(autoIncrement && startIn){
      startIndex = startIndex + 6;
      startIn.value = startIndex;
    }
    
    // Save preferences AFTER incrementing (if applicable)
    await saveQuickFillPrefs(listName, startIndex, useNoteCaptions);
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
    
    // Add CDN URL with different extensions as fallback if we have an itemId
    if(itemId){
      const s = String(Math.trunc(itemId)).padStart(4, '0');
      const g1 = s.substring(0, 2);
      const g2 = s.substring(2, 4);
      const cdnBase = `https://yw-web.yoworld.com/cdn/items/${g1}/${g2}/${itemId}/${itemId}`;
      // Try both extensions
      attempts.push(`${cdnBase}.jpg`);
      attempts.push(`${cdnBase}.png`);
      // As last resort, use API with forced dimensions
      attempts.push(`https://api.yoworld.info/api/items/${itemId}/image/130_100`);
    }
    
    for(const url of attempts){
      try{
        const img = await new Promise((resolve, reject)=>{
          const image = new Image();
          image.crossOrigin = 'anonymous';
          image.onload = ()=> resolve(image);
          image.onerror = ()=> reject(new Error('Failed to load'));
          image.src = url;
        });
        return img;
      }catch{
        // Try next URL
        continue;
      }
    }
    
    return null;
  }

  async function clearAll(){
    bbState = createDefaultState();
    await saveBoardBuilderState();
    const root = qs('#bb-slots');
    if(root) root.innerHTML = '';
    ensureSlotsUI();
    await renderCanvas();
    setStatus('Cleared board.');
  }

  async function renderCanvas(){
    const canvas = qs('#bb-canvas');
    if(!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if(!ctx) return;

    // Enable high-quality image smoothing to prevent stretching artifacts
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const W = canvas.width, H = canvas.height;
    const cols = BOARD_COLS, rows = BOARD_ROWS;

    // Get current theme from storage
    const listsState = await loadSuiteListsState();
    const theme = listsState?.settings?.theme;
    const currentTheme = isKnownThemeValue(theme) ? theme : 'classic';
    const pal = exportPalette(currentTheme);

    // Background (light gray like list templates)
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#f3f4f6';
    ctx.fillRect(0, 0, W, H);

    // 3×2 grid: 130×130px tiles on a 390×260 canvas.
    const slotW = Math.floor(W / cols);
    const slotH = Math.floor(H / rows);

    // Load images with fallback logic (try .jpg, API proxy, etc.)
    const images = await Promise.all(bbState.slots.map(async (s, idx)=>{
      const url = String(s.imageUrl || '').trim();
      if(!url) return null;
      const img = await loadImageWithFallback(url, s.itemId);
      if(img){
        console.log(`Slot ${idx+1} (${s.name}): ${img.naturalWidth}x${img.naturalHeight} from ${url.substring(0, 80)}`);
      }
      return img;
    }));

    // Draw each slot as a card
    ctx.textBaseline = 'top';

    for(let r=0;r<rows;r++){
      for(let c=0;c<cols;c++){
        const idx = r * cols + c;
        const x = c * slotW;
        const y = r * slotH;

        const innerPad = 5;
        
        // Card background
        ctx.fillStyle = '#ffffff';
        roundRect(ctx, x, y, slotW, slotH, 10);
        ctx.fill();

        // Card border
        ctx.strokeStyle = '#d1d5db';
        ctx.lineWidth = 1.5;
        roundRect(ctx, x, y, slotW, slotH, 10);
        ctx.stroke();

        const item = bbState.slots[idx];
        const img = images[idx];
        
        // Calculate layout
        const itemName = String(item?.name || '').trim();
        const caption = String(item?.caption || '').trim();
        const hasCaption = !!caption;
        
        // Caption height
        const captionH = hasCaption ? 18 : 0;
        const captionY = hasCaption ? (y + slotH - innerPad - captionH) : 0;
        
        // Name area (1-2 lines max)
        const nameLineH = 11;
        const maxNameLines = 2;
        const nameBlockH = maxNameLines * nameLineH;
        const nameY = captionY ? (captionY - 3 - nameBlockH) : (y + slotH - innerPad - nameBlockH);
        
        // Image area (fill remaining space)
        const imgX = x + innerPad;
        const imgY = y + innerPad;
        const imgW = slotW - innerPad*2;
        const imgH = nameY - imgY - 3;

        // Draw image
        if(img){
          try{ 
            drawContain(ctx, img, imgX, imgY, imgW, imgH);
          }catch{}
        }else{
          // Placeholder
          ctx.fillStyle = '#f9fafb';
          roundRect(ctx, imgX, imgY, imgW, imgH, 8);
          ctx.fill();
          ctx.strokeStyle = '#e5e7eb';
          ctx.lineWidth = 1;
          roundRect(ctx, imgX, imgY, imgW, imgH, 8);
          ctx.stroke();
          ctx.fillStyle = '#9ca3af';
          ctx.font = '600 10px system-ui, -apple-system, Segoe UI, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(String(idx + 1), imgX + imgW/2, imgY + imgH/2 - 5);
        }

        // Draw name (centered, wrapped)
        if(itemName){
          ctx.fillStyle = '#111827';
          ctx.font = '600 9px system-ui, -apple-system, Segoe UI, sans-serif';
          const nameW = slotW - innerPad*2;
          const wrapped = wrapLines(ctx, itemName, nameW, maxNameLines);
          
          ctx.save();
          ctx.textAlign = 'center';
          const centerX = x + slotW / 2;
          for(let i=0; i<wrapped.lines.length; i++){
            const lineY = nameY + i * nameLineH;
            ctx.fillText(wrapped.lines[i], centerX, lineY);
          }
          ctx.restore();
        }

        // Draw caption/price pill
        if(hasCaption){
          const pillX = x + innerPad;
          const pillW = slotW - innerPad*2;
          ctx.font = '700 10px system-ui, -apple-system, Segoe UI, sans-serif';
          drawCenteredPillText(ctx, caption, pillX, captionY, pillW, captionH, pal.priceBg, pal.priceBorder, pal.priceText);
        }
      }
    }
  }

  async function exportPng(){
    const canvas = qs('#bb-canvas');
    if(!canvas) return;
    setStatus('Exporting…');

    const nameParts = bbState.slots
      .map(s=> String(s.name || '').trim())
      .filter(Boolean)
      .slice(0, 2)
      .join('_');

    const filename = 'board_' + filenameSafe(nameParts || '3x2') + '.png';

    const blob = await new Promise((resolve)=> canvas.toBlob(resolve, 'image/png'));
    if(!blob){
      setStatus('Export failed (no blob).');
      return;
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(()=> URL.revokeObjectURL(url), 1500);
    setStatus('Downloaded ' + filename + '.');
  }

  async function copyPng(){
    const canvas = qs('#bb-canvas');
    if(!canvas) return;

    if(!navigator.clipboard || typeof ClipboardItem === 'undefined'){
      setStatus('Clipboard copy not supported here. Use Export PNG.');
      return;
    }

    setStatus('Copying…');
    const blob = await new Promise((resolve)=> canvas.toBlob(resolve, 'image/png'));
    if(!blob){
      setStatus('Copy failed (no blob).');
      return;
    }

    try{
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setStatus('Copied PNG to clipboard.');
    }catch(e){
      console.warn(e);
      setStatus('Copy failed. Use Export PNG.');
    }
  }

  function wireActionsOnce(){
    if(wireActionsOnce._wired) return;
    wireActionsOnce._wired = true;

    qs('#bb-btn-fill')?.addEventListener('click', ()=>{ fillFromList(false); });
    qs('#bb-btn-fill-next')?.addEventListener('click', ()=>{ fillFromList(true); });
    qs('#bb-btn-clear')?.addEventListener('click', ()=>{ clearAll(); });
    qs('#bb-btn-export')?.addEventListener('click', ()=>{ exportPng(); });
    qs('#bb-btn-copy')?.addEventListener('click', ()=>{ copyPng(); });
    
    // Allow Enter key in start index field to trigger fill
    qs('#bb-fill-start')?.addEventListener('keydown', (e)=>{
      if(e.key === 'Enter'){
        e.preventDefault();
        fillFromList(false);
      }
    });
  }

  async function init(){
    // Only run on sidepanel page.
    if(document?.body?.getAttribute('data-page') !== 'sidepanel') return;

    // If the module isn't present, bail.
    if(!qs('#suite-boardbuilder')) return;

    await loadBoardBuilderState();
    ensureSlotsUI();
    wireActionsOnce();

    // Dynamically append any user-created custom list tabs to the Quick Fill dropdown.
    const listSel = qs('#bb-fill-list');
    if(listSel){
      const listsState = await loadSuiteListsState();
      const customTabs = Array.isArray(listsState?.settings?.customTabs) ? listsState.settings.customTabs : [];
      for(const t of customTabs){
        if(!t || typeof t.key !== 'string' || !t.key.startsWith('custom_') || typeof t.label !== 'string') continue;
        // Only add if not already present (avoid duplicates on re-init)
        if(!listSel.querySelector(`option[value="${CSS.escape(t.key)}"]`)){
          const opt = document.createElement('option');
          opt.value = t.key;
          opt.textContent = t.label;
          listSel.appendChild(opt);
        }
      }
    }

    // Restore Quick Fill preferences, or set defaults
    const prefs = await loadQuickFillPrefs();
    if(prefs){
      applyQuickFillPrefs(prefs);
    }else{
      // First-time defaults: use list notes as captions
      const useNotes = qs('#bb-fill-use-notes');
      if(useNotes) useNotes.checked = true;
    }

    await renderCanvas();
    setStatus('Ready.');
  }

  document.addEventListener('DOMContentLoaded', ()=>{
    init().catch((e)=> console.error(e));
  });
})();
