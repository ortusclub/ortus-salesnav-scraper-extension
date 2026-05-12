/* ─────────────────────────────────────────────────────────────────────
   Ortus Sales Nav Scraper — popup.js
   v3.7.2: editorial UI rebuild. Background.js wire-up unchanged.
   ───────────────────────────────────────────────────────────────────── */

var currentView=null, currentTab='batch', pageInfo=null, tabId=null, progressInterval=null, completedSheetUrl='';
var batchColData=null;  /* {headers, sampleRows, allRows, srcUrl, srcTab, totalRows} */
var batchTabs=null;     /* [{name,rows,cols}] */
var jobToggles=[];      /* parallel array of bool — true = include this job */
var lastSetJobsConfig=null; /* {srcSheetUrl, srcTabName, destSheetUrl, destTabName, outputColIdx} — for re-registering filtered jobs */
var lastViewBeforeSettings=null;

document.addEventListener('DOMContentLoaded', function(){
  /* ── Version ── */
  var m = chrome.runtime.getManifest();
  $('app-version').textContent = 'v' + m.version;
  $('footer-version').textContent = m.version;

  /* ── Float-status mini window ── */
  var floatBtn = $('btn-float-mini');
  function setFloatBtnActive(on){
    if (!floatBtn) return;
    floatBtn.setAttribute('data-active', on ? 'true' : 'false');
  }
  function findMiniWindow(cb){
    var miniUrl = chrome.runtime.getURL('mini.html');
    chrome.windows.getAll({populate: true}, function(wins){
      if (chrome.runtime.lastError) { cb(null); return; }
      for (var i = 0; i < wins.length; i++) {
        var w = wins[i];
        if (w.type !== 'popup' || !w.tabs || !w.tabs.length) continue;
        for (var j = 0; j < w.tabs.length; j++) {
          if (w.tabs[j].url === miniUrl) { cb(w); return; }
        }
      }
      cb(null);
    });
  }
  if (floatBtn) {
    findMiniWindow(function(w){ setFloatBtnActive(!!w); });
    /* Sync button state if the mini window gets closed while the popup is still open */
    if (chrome.windows && chrome.windows.onRemoved) {
      chrome.windows.onRemoved.addListener(function(){
        findMiniWindow(function(w){ setFloatBtnActive(!!w); });
      });
    }
    floatBtn.addEventListener('click', function(){
      findMiniWindow(function(existing){
        if (existing) {
          /* Already open — bring it forward instead of duplicating */
          chrome.windows.update(existing.id, {focused: true, drawAttention: true});
          setFloatBtnActive(true);
          return;
        }
        chrome.windows.create({
          url: chrome.runtime.getURL('mini.html'),
          type: 'popup',
          width: 320,
          height: 116,
          focused: true
        }, function(){ setFloatBtnActive(true); });
      });
    });
  }

  /* ── Mode-strip slow toggle (pill) ── */
  var slowPill = $('toggle-slow-mode-pill');
  var slowLabel = $('slow-state-label');
  var slowCheckbox = $('toggle-slow-mode'); /* hidden, kept for state-of-truth */
  function applySlowState(on){
    slowCheckbox.checked = on;
    slowPill.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (slowLabel) slowLabel.textContent = on ? 'On' : 'Off';
  }
  chrome.storage.local.get('ortus_slow_mode', function(d){
    applySlowState(!!(d && d.ortus_slow_mode));
  });
  slowPill.addEventListener('click', function(){
    var newVal = slowPill.getAttribute('aria-pressed') !== 'true';
    applySlowState(newVal);
    chrome.storage.local.set({ortus_slow_mode: newVal});
    chrome.runtime.sendMessage({action:'setSlowMode', slow: newVal});
  });

  /* ── Auto-open status window toggle (in settings) ── */
  var floatAutoSwitch = $('settings-float-auto-switch');
  if (floatAutoSwitch) {
    chrome.storage.local.get(['ortus_float_auto'], function(d){
      var on = (d && typeof d.ortus_float_auto !== 'undefined') ? !!d.ortus_float_auto : true;
      floatAutoSwitch.classList.toggle('on', on);
    });
    floatAutoSwitch.addEventListener('click', function(){
      var newVal = !floatAutoSwitch.classList.contains('on');
      floatAutoSwitch.classList.toggle('on', newVal);
      chrome.storage.local.set({ortus_float_auto: newVal});
    });
  }

  /* ── Corner window toggle (in settings) ── */
  var cornerSwitch = $('settings-corner-switch');
  var cornerCheckbox = $('toggle-corner-window');
  chrome.storage.local.get(['ortus_corner_window','ortus_hide_window'], function(d){
    var on;
    if (d && typeof d.ortus_corner_window !== 'undefined') on = !!d.ortus_corner_window;
    else if (d && typeof d.ortus_hide_window !== 'undefined') on = !!d.ortus_hide_window;
    else on = true; /* New default: ON */
    cornerCheckbox.checked = on;
    cornerSwitch.classList.toggle('on', on);
  });
  cornerSwitch.addEventListener('click', function(){
    var newVal = !cornerSwitch.classList.contains('on');
    cornerSwitch.classList.toggle('on', newVal);
    cornerCheckbox.checked = newVal;
    chrome.storage.local.set({ortus_corner_window: newVal});
    chrome.runtime.sendMessage({action:'setCornerWindow', corner: newVal});
  });

  /* ── Shared status pill + loud alarm — auto-detected from the sheet ── */
  var sharedPill = $('toggle-shared-pill');
  var sharedLabel = $('shared-state-label');
  var shareAlarm = $('alarm-share');
  function applySharedState(state, reason){
    /* state: 'on' | 'off' | 'checking' | 'idle' */
    if (!sharedPill || !sharedLabel) return;
    sharedPill.setAttribute('aria-pressed', state === 'on' ? 'true' : 'false');
    sharedPill.setAttribute('data-state', state);
    sharedLabel.textContent = state === 'on' ? 'OK'
      : state === 'checking' ? '…'
      : state === 'idle' ? '—'
      : 'Off';
    if (reason) sharedPill.title = reason;
    else sharedPill.title = state === 'on' ? 'Sheet shared as Anyone with the link · Editor'
      : state === 'idle' ? 'Paste a sheet URL to verify sharing'
      : 'Not shared as Anyone with the link · Editor';
    if (shareAlarm) shareAlarm.classList.toggle('hidden', state !== 'off');
    var connect = $('btn-connect-sheet');
    if (connect) connect.disabled = (state !== 'on');
  }
  if (sharedPill && sharedLabel) {
    sharedPill.style.cursor = 'default';
    /* No click handler — pill is purely a status indicator. Alarm is non-interactive. */
    applySharedState('idle');
  }

  /* ── Auto-check sharing whenever the sheet URL changes ── */
  var srcSheetInput = $('input-src-sheet');
  var sharingCheckTimer = null;
  var lastCheckedUrl = '';
  function maybeCheckSharing(){
    var url = srcSheetInput ? srcSheetInput.value.trim() : '';
    if (!url || url.indexOf('docs.google.com/spreadsheets') === -1) {
      applySharedState('idle');
      lastCheckedUrl = '';
      return;
    }
    if (url === lastCheckedUrl) return; /* don't re-check identical URL */
    lastCheckedUrl = url;
    applySharedState('checking');
    sendBG('checkSheetSharing', {sheetUrl: url}).then(function(sc){
      /* Stale-response guard: only apply if the URL hasn't changed since we kicked off */
      if ((srcSheetInput ? srcSheetInput.value.trim() : '') !== url) return;
      if (sc && sc.ok && sc.shared) applySharedState('on', 'Verified · ' + (sc.via || 'check'));
      else applySharedState('off', (sc && sc.error) || 'Not shared as Anyone with the link · Editor');
    }).catch(function(e){
      if ((srcSheetInput ? srcSheetInput.value.trim() : '') !== url) return;
      applySharedState('off', 'Check failed: ' + e.message);
    });
  }
  if (srcSheetInput) {
    srcSheetInput.addEventListener('input', function(){
      if (sharingCheckTimer) clearTimeout(sharingCheckTimer);
      lastCheckedUrl = ''; /* reset so debounce always fires */
      sharingCheckTimer = setTimeout(maybeCheckSharing, 600);
    });
    /* On popup open, if a URL is already populated (restored from storage), check immediately */
    setTimeout(maybeCheckSharing, 250);
  }

  /* ── Caffeinate copy button ── */
  var caffBtn = $('btn-copy-caffeinate');
  if (caffBtn) {
    caffBtn.addEventListener('click', function(){
      var cmd = 'caffeinate -i';
      var done = function(){
        caffBtn.classList.add('copied');
        var hint = caffBtn.querySelector('.copy-hint');
        var orig = hint ? hint.textContent : '';
        if (hint) hint.textContent = 'Copied';
        setTimeout(function(){
          caffBtn.classList.remove('copied');
          if (hint) hint.textContent = orig || 'Copy';
        }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(cmd).then(done).catch(function(){
          var ta=document.createElement('textarea');ta.value=cmd;document.body.appendChild(ta);
          ta.select();try{document.execCommand('copy');done();}catch(e){}document.body.removeChild(ta);
        });
      } else {
        var ta=document.createElement('textarea');ta.value=cmd;document.body.appendChild(ta);
        ta.select();try{document.execCommand('copy');done();}catch(e){}document.body.removeChild(ta);
      }
    });
  }

  /* ── Open activity log (logs.html) ── */
  var logsBtn = $('btn-open-logs');
  if (logsBtn) {
    logsBtn.addEventListener('click', function(){
      chrome.tabs.create({ url: chrome.runtime.getURL('logs.html') });
    });
  }

  /* ── Keep-LinkedIn-Awake preflight: two-step nudge before any start/resume action.
     Step 1 (initial): "Open settings" button deep-links to chrome://settings/performance.
       This sets ortus_memsaver_opened=true so the next time the popup opens the banner
       advances to step 2 — but does NOT yet ack. They could've forgotten to click Add.
     Step 2 (confirm): "Yes, I added it ✓" button persists ortus_memsaver_ack=true and
       hides every banner forever on this machine.
     Banners are purely informational; Start is never disabled. */
  function paintPreflights(opened, acked){
    var banners = document.querySelectorAll('.preflight-memsaver');
    for (var i = 0; i < banners.length; i++) {
      var b = banners[i];
      if (acked) { b.classList.add('hidden'); continue; }
      b.classList.remove('hidden');
      b.setAttribute('data-state', opened ? 'confirm' : 'initial');
    }
  }
  /* Storage keys are namespaced under v2 because v3.9.0 used the same names with
   * different semantics (auto-ack on first click). Reading the old keys would
   * silently hide every banner for users who clicked once in v3.9.0. */
  function loadPreflightState(){
    chrome.storage.local.get(['ortus_lkd_keepalive_opened_v2','ortus_lkd_keepalive_ack_v2'], function(d){
      paintPreflights(!!(d && d.ortus_lkd_keepalive_opened_v2), !!(d && d.ortus_lkd_keepalive_ack_v2));
    });
    /* Best-effort cleanup of v3.9.0 stale keys (no-op if they don't exist) */
    chrome.storage.local.remove(['ortus_memsaver_opened','ortus_memsaver_ack']);
  }
  loadPreflightState();
  document.querySelectorAll('.preflight-open').forEach(function(b){
    b.addEventListener('click', function(){
      chrome.tabs.create({ url: 'chrome://settings/performance' });
      chrome.storage.local.set({ortus_lkd_keepalive_opened_v2: true}, function(){
        paintPreflights(true, false);
      });
    });
  });
  document.querySelectorAll('.preflight-confirm').forEach(function(b){
    b.addEventListener('click', function(){
      chrome.storage.local.set({ortus_lkd_keepalive_ack_v2: true}, function(){
        paintPreflights(true, true);
      });
    });
  });
  /* Click-to-copy pill (e.g. "www.linkedin.com") inside every preflight banner */
  document.querySelectorAll('.preflight-copy').forEach(function(btn){
    btn.addEventListener('click', function(){
      var text = btn.getAttribute('data-copy') || '';
      var hint = btn.querySelector('.copy-hint');
      var origHint = hint ? hint.textContent : '';
      var flash = function(){
        btn.classList.add('copied');
        if (hint) hint.textContent = 'Copied';
        setTimeout(function(){
          btn.classList.remove('copied');
          if (hint) hint.textContent = origHint || 'Copy';
        }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(flash).catch(function(){
          var ta=document.createElement('textarea'); ta.value=text;
          document.body.appendChild(ta); ta.select();
          try{document.execCommand('copy'); flash();}catch(e){}
          document.body.removeChild(ta);
        });
      } else {
        var ta=document.createElement('textarea'); ta.value=text;
        document.body.appendChild(ta); ta.select();
        try{document.execCommand('copy'); flash();}catch(e){}
        document.body.removeChild(ta);
      }
    });
  });

  /* ── Settings view toggle ── */
  $('btn-settings-toggle').addEventListener('click', function(){
    if (currentView === 'settings') {
      showView(lastViewBeforeSettings || 'batch-setup');
    } else {
      lastViewBeforeSettings = currentView;
      showView('settings');
    }
  });
  var settingsBackBtn = $('btn-settings-back');
  if (settingsBackBtn) {
    settingsBackBtn.addEventListener('click', function(){
      showView(lastViewBeforeSettings || 'batch-setup');
    });
  }

  /* ── Single mode handlers ── */
  $('btn-start').addEventListener('click', startScrape);
  $('btn-pause').addEventListener('click', togglePause);
  $('btn-stop').addEventListener('click', stopScrape);
  $('btn-open-sheet').addEventListener('click', openSheet);
  $('btn-csv').addEventListener('click', downloadCSV);
  $('btn-again').addEventListener('click', scrapeAgain);
  $('btn-resume').addEventListener('click', resumeSingle);
  /* btn-discard now goes through confirm-strip (wireConfirmStrip below) */

  /* ── Mode switch buttons ── */
  $('btn-go-single-link').addEventListener('click', function(){
    currentTab = 'single';
    initSingle();
  });
  /* btn-back-to-welcome removed — masthead Single/Batch toggle replaces it.
     Keep the lookup null-safe for future-proofing. */
  var bw = $('btn-back-to-welcome');
  if (bw) bw.addEventListener('click', function(){ currentTab = 'batch'; showView('batch-setup'); });

  /* ── Batch wizard handlers ── */
  $('btn-connect-sheet').addEventListener('click', connectSheet);
  $('btn-tab-back').addEventListener('click', function(){
    showView('batch-setup');
    saveWizard();
  });
  $('btn-load-tab').addEventListener('click', loadTabData);
  $('btn-config-back').addEventListener('click', function(){
    if (batchTabs) showView('batch-tab-select'); else showView('batch-setup');
    saveWizard();
  });
  $('btn-batch-confirm').addEventListener('click', confirmBatchConfig);
  $('btn-ready-back').addEventListener('click', function(){
    showView('batch-config');
    saveWizard();
  });
  $('btn-start-batch').addEventListener('click', startBatch);
  /* btn-stop-batch now goes through confirm-strip (wireConfirmStrip below) */
  $('btn-pause-batch').addEventListener('click', togglePauseBatch);
  $('btn-recover-batch').addEventListener('click', recoverBatch);
  $('btn-batch-again').addEventListener('click', batchAgain);
  $('btn-resume-batch').addEventListener('click', resumeBatch);
  /* btn-discard-batch now goes through confirm-strip (wireConfirmStrip below) */

  /* ── Dynamic listeners ── */
  $('sel-url-col').addEventListener('change', function(){updateColPreview(); saveWizard();});
  $('sel-tab-source').addEventListener('change', function(){onTabSourceChange(); saveWizard();});
  $('sel-tab-col').addEventListener('change', function(){updateTabColPreview(); saveWizard();});
  $('sel-src-tab').addEventListener('change', function(){updateTabHint(); saveWizard();});
  ['input-dest-sheet','input-dest-tab','input-row-from','input-row-to'].forEach(function(id){
    $(id).addEventListener('input', debounce(saveWizard, 500));
  });

  /* ── Background state pushes ── */
  chrome.runtime.onMessage.addListener(function(msg){
    if (msg.action === 'stateUpdate') {
      if (currentTab === 'single' && currentView === 'single-progress') updateProgress();
      if (currentTab === 'batch' && (currentView === 'batch-running' || currentView === 'batch-done')) {
        chrome.runtime.sendMessage({action:'getState'}, function(st){ updateBatchView(st); });
      }
    }
  });

  /* ── Masthead Single / Batch toggle (replaces hidden ghost button) ── */
  var modeSingle = $('mode-single');
  var modeBatch = $('mode-batch');
  function setMode(target, persist){
    if (modeSingle) modeSingle.setAttribute('aria-pressed', target === 'single' ? 'true' : 'false');
    if (modeBatch) modeBatch.setAttribute('aria-pressed', target === 'batch' ? 'true' : 'false');
    if (persist) chrome.storage.local.set({ortus_last_mode: target});
  }
  if (modeSingle) {
    modeSingle.addEventListener('click', function(){
      if (currentView && (currentView.indexOf('single-progress') === 0 || currentView.indexOf('batch-running') === 0)) return; /* don't switch mid-run */
      setMode('single', true);
      currentTab = 'single';
      initSingle();
    });
  }
  if (modeBatch) {
    modeBatch.addEventListener('click', function(){
      if (currentView && (currentView.indexOf('single-progress') === 0 || currentView.indexOf('batch-running') === 0)) return;
      setMode('batch', true);
      currentTab = 'batch';
      showView('batch-setup');
    });
  }

  /* ── Paste-a-link single scrape (view-single-wrong's new flow) ── */
  var pasteBtn = $('btn-paste-start');
  if (pasteBtn) {
    pasteBtn.addEventListener('click', async function(){
      var url = ($('input-paste-salesnav') ? $('input-paste-salesnav').value.trim() : '');
      var sheet = ($('input-paste-sheet-url') ? $('input-paste-sheet-url').value.trim() : '');
      var name = ($('input-paste-sheet-name') ? $('input-paste-sheet-name').value.trim() : '') || 'Sales Nav Scrape';
      if (!url || url.indexOf('linkedin.com/sales/') === -1) { flash('input-paste-salesnav'); return; }
      if (!sheet || sheet.indexOf('docs.google.com/spreadsheets') === -1) { flash('input-paste-sheet-url'); return; }
      var orig = pasteBtn.innerHTML;
      pasteBtn.disabled = true;
      pasteBtn.innerHTML = 'Opening Sales Nav…<span class="pod">…</span>';
      try {
        /* Open the URL in a new tab and wait for it to load before handing tabId to the scraper. */
        var newTab = await new Promise(function(res){
          chrome.tabs.create({url:url, active:false}, function(t){ res(t); });
        });
        await new Promise(function(res){
          var deadline = Date.now() + 25000;
          function tick(){
            chrome.tabs.get(newTab.id, function(t){
              if (chrome.runtime.lastError || !t) { res(); return; }
              if (t.status === 'complete') { res(); return; }
              if (Date.now() > deadline) { res(); return; }
              setTimeout(tick, 250);
            });
          }
          tick();
        });
        chrome.storage.sync.set({lastSheetUrl: sheet, lastSheetName: name});
        var cfg = { tabId: newTab.id, startPage: 1, totalPages: 0, totalResults: 0, sheetUrl: sheet, sheetName: name, dedup: dedupState.paste.on };
        var r = await sendBG('startScrape', {config: cfg});
        if (r && r.ok) { showView('single-progress'); startPoll(); }
        else { alert(r && r.error ? r.error : 'Could not start scrape'); }
      } finally {
        pasteBtn.disabled = false;
        pasteBtn.innerHTML = orig;
      }
    });
  }

  /* ── Dedup toggle state — per-launch, default ON.
     Exposed on window so top-level functions (initSingle, startScrape,
     confirmBatchConfig, startBatch, paste-flow handler) can read/refresh it. */
  window.dedupState = {
    paste: { on: true, count: 0, hasIdCol: false, hasUrlCol: false, error: null },
    single: { on: true, count: 0, hasIdCol: false, hasUrlCol: false, error: null },
    batch: { on: true, count: 0, hasIdCol: false, hasUrlCol: false, error: null }
  };
  var dedupState = window.dedupState;

  /* Per-view request sequence counters — drop stale previewDedup responses
     when a newer request has been issued (prevents out-of-order races). */
  var __dedupReqSeq = { paste: 0, single: 0, batch: 0 };

  function renderDedupToggle(which) {
    var s = dedupState[which];
    var toggle = $('dedup-toggle-' + which);
    var note = $('dedup-note-' + which);
    var sw = $('dedup-switch-' + which);
    var label = $('dedup-label-' + which);
    var count = $('dedup-count-' + which);
    if (!toggle || !note) return;
    if (s.error) {
      toggle.classList.add('hidden');
      note.classList.remove('hidden');
      note.textContent = "Couldn't check for duplicates · running anyway";
      return;
    }
    if (!s.hasIdCol && !s.hasUrlCol && s.count === 0) {
      toggle.classList.add('hidden');
      note.classList.add('hidden');
      return;
    }
    if (!s.hasIdCol && !s.hasUrlCol) {
      toggle.classList.add('hidden');
      note.classList.remove('hidden');
      note.textContent = "Can't dedupe — sheet has no LinkedIn Membership ID or Bio column";
      return;
    }
    if (s.count === 0) {
      toggle.classList.add('hidden');
      note.classList.add('hidden');
      return;
    }
    toggle.classList.remove('hidden');
    note.classList.add('hidden');
    toggle.classList.toggle('off', !s.on);
    if (sw) {
      sw.classList.toggle('on', s.on);
      sw.setAttribute('aria-pressed', s.on ? 'true' : 'false');
      sw.setAttribute('aria-label', s.on ? 'Skip leads already in this sheet — currently on' : 'Re-scrape everything — currently off');
    }
    if (label) {
      label.innerHTML = s.on
        ? '<strong>Skip leads already in this sheet</strong>'
        : '<strong>Re-scrape everything</strong> — dupes will be re-added';
    }
    if (count) {
      count.textContent = s.count.toLocaleString() + ' found';
    }
  }
  function wireDedupSwitch(which) {
    var sw = $('dedup-switch-' + which);
    if (!sw) return;
    sw.addEventListener('click', function() {
      dedupState[which].on = !dedupState[which].on;
      renderDedupToggle(which);
    });
  }
  ['paste','single','batch'].forEach(wireDedupSwitch);

  window.refreshDedupForView = async function(which, sheetUrl, tabName) {
    var seq = ++__dedupReqSeq[which];
    if (!sheetUrl || !tabName) {
      dedupState[which] = { on: dedupState[which].on, count: 0, hasIdCol: false, hasUrlCol: false, error: null };
      renderDedupToggle(which);
      return;
    }
    var r = await sendBG('previewDedup', { sheetUrl: sheetUrl, tabName: tabName });
    if (seq !== __dedupReqSeq[which]) return;  // stale — newer request was issued
    if (!r || !r.ok) {
      dedupState[which] = { on: dedupState[which].on, count: 0, hasIdCol: false, hasUrlCol: false, error: (r && r.error) || 'fetch failed' };
    } else {
      dedupState[which] = {
        on: dedupState[which].on,
        count: r.count || 0,
        hasIdCol: !!r.hasIdCol,
        hasUrlCol: !!r.hasUrlCol,
        error: null
      };
    }
    renderDedupToggle(which);
  };
  var refreshDedupForView = window.refreshDedupForView;

  /* Refresh paste-view dedup preview when sheet URL or tab name changes */
  var pastePreviewTimer = null;
  function pastePreview() {
    var sheet = $('input-paste-sheet-url') ? $('input-paste-sheet-url').value.trim() : '';
    var tab = ($('input-paste-sheet-name') ? $('input-paste-sheet-name').value.trim() : '') || 'Sales Nav Scrape';
    if (sheet.indexOf('docs.google.com/spreadsheets') === -1) {
      dedupState.paste = { on: dedupState.paste.on, count: 0, hasIdCol: false, hasUrlCol: false, error: null };
      renderDedupToggle('paste');
      return;
    }
    refreshDedupForView('paste', sheet, tab);
  }
  ['input-paste-sheet-url','input-paste-sheet-name'].forEach(function(id) {
    var el = $(id);
    if (el) el.addEventListener('input', function() {
      if (pastePreviewTimer) clearTimeout(pastePreviewTimer);
      pastePreviewTimer = setTimeout(pastePreview, 600);
    });
  });

  /* ── Radio-card proxy for #sel-tab-source (hidden state-of-truth) ── */
  document.querySelectorAll('.radio-stack [role="radio"]').forEach(function(card){
    card.addEventListener('click', function(){
      var stack = card.closest('.radio-stack');
      if (!stack) return;
      stack.querySelectorAll('[role="radio"]').forEach(function(c){c.setAttribute('aria-checked','false');});
      card.setAttribute('aria-checked','true');
      var hiddenSel = $('sel-tab-source');
      if (hiddenSel) {
        hiddenSel.value = card.getAttribute('data-value') || 'auto';
        hiddenSel.dispatchEvent(new Event('change', {bubbles:true}));
      }
    });
  });
  window.syncRadioCardsFromSelect = function(){
    var v = $('sel-tab-source') ? $('sel-tab-source').value : 'auto';
    document.querySelectorAll('.radio-stack [role="radio"]').forEach(function(c){
      c.setAttribute('aria-checked', c.getAttribute('data-value') === v ? 'true' : 'false');
    });
  };
  /* Re-sync radio cards whenever something else (restore-wizard) writes to the hidden select */
  if ($('sel-tab-source')) {
    $('sel-tab-source').addEventListener('change', window.syncRadioCardsFromSelect);
  }

  /* ── Column-picker listbox helpers (replaces visible <select> for column-pickers) ── */
  function colLetter(idx){
    var s = '';
    var n = idx;
    while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; }
    return s;
  }
  function firstPreview(sampleRows, idx){
    if (!sampleRows) return '';
    for (var i = 0; i < sampleRows.length; i++) {
      var v = (sampleRows[i] && sampleRows[i][idx] != null) ? String(sampleRows[i][idx]).trim() : '';
      if (v) return v;
    }
    return '';
  }
  /* Render a column listbox driven by a hidden <select>. Each li reflects a header
     with its column letter, name, and first non-empty preview value. */
  window.populateColListbox = function(listboxId, hiddenSelectId, headers, sampleRows, opts){
    var lb = document.getElementById(listboxId);
    var sel = document.getElementById(hiddenSelectId);
    if (!lb || !sel) return;
    opts = opts || {};
    lb.innerHTML = '';
    if (opts.includeNone) {
      var none = document.createElement('li');
      none.setAttribute('role','option');
      none.setAttribute('data-value','-1');
      none.innerHTML = '<span class="col">—</span><span class="nm" style="font-style:italic; color:var(--ink-soft)">'+(opts.noneLabel || "Don't write back")+'</span><span class="preview"></span>';
      lb.appendChild(none);
    }
    headers.forEach(function(h, i){
      var li = document.createElement('li');
      li.setAttribute('role','option');
      li.setAttribute('data-value', String(i));
      var preview = firstPreview(sampleRows, i);
      li.innerHTML =
        '<span class="col">'+colLetter(i)+'</span>'+
        '<span class="nm">'+(h || '(unnamed)').replace(/[<>]/g,'')+'</span>'+
        '<span class="preview">'+preview.replace(/[<>]/g,'').slice(0,80)+'</span>';
      lb.appendChild(li);
    });
    /* Selection is driven by the existing hidden <select>'s value. */
    function syncFromSelect(){
      var v = sel.value;
      lb.querySelectorAll('li').forEach(function(li){
        li.setAttribute('aria-selected', li.getAttribute('data-value') === v ? 'true' : 'false');
      });
    }
    syncFromSelect();
    /* Click handler — set hidden select's value and dispatch change for legacy listeners */
    lb.querySelectorAll('li').forEach(function(li){
      li.addEventListener('click', function(){
        sel.value = li.getAttribute('data-value');
        sel.dispatchEvent(new Event('change', {bubbles:true}));
        syncFromSelect();
      });
    });
    /* Re-sync if someone else writes to the select */
    sel.addEventListener('change', syncFromSelect);
  };

  /* ── Discard confirm strips (single + batch interrupted) ── */
  function wireConfirmStrip(triggerId, stripId, cancelId, confirmId, onConfirm){
    var trigger = $(triggerId);
    var strip = $(stripId);
    if (!trigger || !strip) return;
    trigger.addEventListener('click', function(e){
      e.preventDefault();
      strip.classList.remove('hidden');
      var confirmBtn = $(confirmId);
      if (confirmBtn) confirmBtn.focus();
    });
    var cancel = $(cancelId);
    if (cancel) cancel.addEventListener('click', function(){ strip.classList.add('hidden'); });
    var confirm = $(confirmId);
    if (confirm) confirm.addEventListener('click', function(){
      strip.classList.add('hidden');
      onConfirm();
    });
  }
  wireConfirmStrip('btn-discard','confirm-discard-single','btn-cancel-discard-single','btn-confirm-discard-single', discardSingle);
  wireConfirmStrip('btn-discard-batch','confirm-discard-batch','btn-cancel-discard-batch','btn-confirm-discard-batch', discardBatch);
  wireConfirmStrip('btn-stop-batch','confirm-stop-batch','btn-cancel-stop-batch','btn-confirm-stop-batch', stopBatch);
  /* Single-mode stop already lives in single-progress; keep its current behavior. */

  /* ════════════════════════════════════════════════════════════════════
     HELP SYSTEM — first-run overlay + coachmark pills
     Overlay shows ONCE on install (flag: ortus_help_overlay_seen_v1).
     Pills are always visible; pulse only until any one is dismissed
     (flag: ortus_help_pill_dismissed_v1). "? Tour" in masthead replays.
     ════════════════════════════════════════════════════════════════════ */
  initHelpSystem();

  /* SYNC pre-render from localStorage cache — no waiting for getState round-trip.
   * Live state will reconcile within milliseconds via init() below. */
  applyOptimisticState();

  init();
});

function initHelpSystem(){
  var overlay = $('help-overlay');
  var stepPill = $('help-step-pill');
  var backBtn = $('help-back');
  var nextBtn = $('help-next');
  var skipBtn = $('help-skip');
  var replayBtn = $('btn-replay-tour');
  if (!overlay || !nextBtn) return;

  var slides = overlay.querySelectorAll('.help-slide');
  var pips = overlay.querySelectorAll('.help-pips span');
  var total = slides.length;
  var current = 1;

  function showSlide(n){
    if (n < 1) n = 1;
    if (n > total) n = total;
    current = n;
    for (var i = 0; i < slides.length; i++){
      slides[i].setAttribute('data-active', slides[i].getAttribute('data-slide') === String(n) ? 'true' : 'false');
    }
    for (var p = 0; p < pips.length; p++){
      pips[p].setAttribute('data-on', p < n ? 'true' : 'false');
    }
    stepPill.textContent = 'Step ' + n + ' of ' + total;
    backBtn.disabled = (n === 1);
    nextBtn.textContent = (n === total) ? 'Done ✓' : 'Next →';
  }

  function openOverlay(){
    showSlide(1);
    overlay.setAttribute('data-open', 'true');
  }
  function closeOverlay(){
    overlay.setAttribute('data-open', 'false');
    chrome.storage.local.set({ortus_help_overlay_seen_v1: true});
  }

  nextBtn.addEventListener('click', function(){
    if (current >= total) { closeOverlay(); return; }
    showSlide(current + 1);
  });
  backBtn.addEventListener('click', function(){
    if (current > 1) showSlide(current - 1);
  });
  skipBtn.addEventListener('click', closeOverlay);

  /* "Open fresh blank sheet" — used by overlay CTA + every help bubble */
  function bindFreshSheetAction(root){
    var btns = root.querySelectorAll('[data-action="open-fresh-sheet"]');
    for (var i = 0; i < btns.length; i++){
      btns[i].addEventListener('click', function(e){
        e.preventDefault();
        e.stopPropagation();
        chrome.tabs.create({url: 'https://docs.google.com/spreadsheets/create'});
      });
    }
  }
  bindFreshSheetAction(document);

  /* Replay tour from masthead — does NOT clear the seen flag, just re-opens */
  if (replayBtn) {
    replayBtn.addEventListener('click', function(){ openOverlay(); });
  }

  /* Auto-show overlay on first install */
  chrome.storage.local.get(['ortus_help_overlay_seen_v1'], function(d){
    if (!(d && d.ortus_help_overlay_seen_v1)) openOverlay();
  });

  /* ── Coachmark pills (shared bubble, dynamically positioned) ── */
  var pills = document.querySelectorAll('.help-pill');
  var bubble = $('help-bubble');
  var bubbleBody = $('help-bubble-body');

  function setPulsing(on){
    for (var i = 0; i < pills.length; i++){
      if (on) pills[i].setAttribute('data-pulsing', 'true');
      else pills[i].removeAttribute('data-pulsing');
    }
  }
  function closeBubble(){
    if (bubble) bubble.setAttribute('data-open', 'false');
  }
  function positionBubble(pill){
    if (!bubble) return;
    var rect = pill.getBoundingClientRect();
    var bubbleW = 300;
    var margin = 10;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    /* Horizontally: align bubble's right edge with pill's right edge — clamp to viewport */
    var left = rect.right - bubbleW + 8;
    if (left < margin) left = margin;
    if (left + bubbleW > vw - margin) left = vw - margin - bubbleW;
    /* Vertically: prefer below pill; flip above if not enough room */
    var top = rect.bottom + 10;
    var spaceBelow = vh - rect.bottom;
    var bubbleH = bubble.offsetHeight || 240;  /* estimate before render */
    if (spaceBelow < bubbleH + margin) {
      top = rect.top - bubbleH - 10;
      bubble.setAttribute('data-arrow', 'bottom');
    } else {
      bubble.setAttribute('data-arrow', 'top');
    }
    if (top < margin) top = margin;
    bubble.style.left = left + 'px';
    bubble.style.top = top + 'px';
  }
  function setBubbleContentFor(pill){
    if (!bubbleBody) return;
    var ctx = pill.getAttribute('data-help-context');
    if (ctx === 'read-write') {
      bubbleBody.innerHTML = 'Set it to <strong>Anyone with link · Editor</strong> so this tool can read your URLs and write the result link back.';
    } else {
      bubbleBody.innerHTML = 'Set it to <strong>Anyone with link · Editor</strong> so this tool can write results into it.';
    }
  }

  chrome.storage.local.get(['ortus_help_pill_dismissed_v1'], function(d){
    var dismissed = !!(d && d.ortus_help_pill_dismissed_v1);
    setPulsing(!dismissed);
  });

  pills.forEach(function(pill){
    pill.addEventListener('click', function(e){
      e.preventDefault();
      e.stopPropagation();
      var isOpenForThis = bubble && bubble.getAttribute('data-open') === 'true'
                         && bubble.getAttribute('data-current-pill') === (pill.id || pill.getAttribute('data-help'));
      closeBubble();
      if (!isOpenForThis && bubble) {
        setBubbleContentFor(pill);
        bubble.setAttribute('data-current-pill', pill.id || pill.getAttribute('data-help'));
        bubble.setAttribute('data-open', 'true');
        /* Render once to get height, then re-position with accurate measurements */
        positionBubble(pill);
        requestAnimationFrame(function(){ positionBubble(pill); });
      }
      /* First-ever pill engagement: stop pulsing forever */
      setPulsing(false);
      chrome.storage.local.set({ortus_help_pill_dismissed_v1: true});
    });
  });

  /* Bubble close button */
  var closeBtn = $('help-bubble-close');
  if (closeBtn) closeBtn.addEventListener('click', function(e){
    e.preventDefault();
    e.stopPropagation();
    closeBubble();
  });

  /* Click outside the bubble (or pill) closes it */
  document.addEventListener('click', function(e){
    if (e.target.closest('.help-bubble') || e.target.closest('.help-pill')) return;
    closeBubble();
  });

  /* Reposition on resize/scroll while bubble is open */
  window.addEventListener('resize', function(){ closeBubble(); });
}

/* ═════════════════════════════════════════════════════════════════════
   FAST-REOPEN CACHE — sync localStorage so the popup paints the running
   view instantly when it's reopened mid-scrape.
   ═════════════════════════════════════════════════════════════════════ */
var STATE_CACHE_KEY = 'ortus_state_v1';
var STATE_CACHE_MAX_AGE_MS = 60000; /* 60s — beyond this, suspect staleness */

function cacheStateForFastReopen(st){
  try{
    if (!st) return;
    var snap = {
      isRunning: !!st.isRunning, isPaused: !!st.isPaused,
      mode: st.mode || null, endTime: st.endTime || 0,
      currentJobIndex: st.currentJobIndex || 0,
      currentPage: st.currentPage || 0, totalPages: st.totalPages || 0,
      profilesScraped: st.profilesScraped || 0, totalResults: st.totalResults || 0,
      startTime: st.startTime || 0,
      jobs: (st.jobs || []).map(function(j){
        return {
          tabName: j.tabName, status: j.status, salesNavUrl: j.salesNavUrl,
          profilesScraped: j.profilesScraped, row: j.row
        };
      }),
      cachedAt: Date.now()
    };
    localStorage.setItem(STATE_CACHE_KEY, JSON.stringify(snap));
  }catch(e){}
}

function readStateCache(){
  try{
    var raw = localStorage.getItem(STATE_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  }catch(e){ return null; }
}

function applyOptimisticState(){
  var c = readStateCache();
  if (!c) return;
  if (Date.now() - (c.cachedAt || 0) > STATE_CACHE_MAX_AGE_MS) return;
  if (!c.isRunning) return;

  if (c.mode === 'batch') {
    currentTab = 'batch';
    showView('batch-running');
    /* updateBatchView accepts a state-shaped object — feed it the cache */
    updateBatchView(c);
  } else if (c.mode === 'single') {
    currentTab = 'single';
    showView('single-progress');
    /* Render cached values into the progress view */
    $('prog-profiles').textContent = (c.profilesScraped || 0).toLocaleString();
    $('prog-page').textContent = (c.currentPage || 0) + (c.totalPages ? '/' + c.totalPages : '');
    var pct = c.totalPages > 0 ? Math.round((c.currentPage / c.totalPages) * 100) : 0;
    $('prog-fill').style.width = pct + '%';
    $('prog-pct').textContent = pct + '%';
    $('progress-status').textContent = c.isPaused ? 'Paused' : 'Now scraping';
    setLiveBadge(c.isPaused ? 'paused' : 'running', c.isPaused ? 'Paused' : 'Live');
  }
}

/* ═════════════════════════════════════════════════════════════════════
   INIT — live state always wins. Saved-interrupted only surfaces when
   nothing is currently running and nothing recently finished.
   ═════════════════════════════════════════════════════════════════════ */
async function init(){
  var st = await sendBG('getState');

  /* Priority 1 — actively running right now */
  if (st && st.isRunning && st.mode === 'batch') {
    currentTab = 'batch';
    showView('batch-running');
    renderJobsForQueue('batch-job-list', st.jobs, st.currentJobIndex, st.isPaused);
    startBatchPoll();
    return;
  }
  if (st && st.isRunning && st.mode === 'single') {
    currentTab = 'single';
    showView('single-progress');
    startPoll();
    return;
  }

  /* Priority 2 — just finished (within this session) */
  if (st && st.endTime && st.profileCount > 0 && st.mode === 'single') {
    currentTab = 'single';
    showDone(st);
    return;
  }
  if (st && st.endTime && st.mode === 'batch' && st.jobs && st.jobs.length > 0) {
    currentTab = 'batch';
    showBatchDone(st);
    return;
  }

  /* Priority 3 — saved interrupted state from a prior session
   * (only reached when nothing is currently running) */
  var saved = await sendBG('checkSavedState');
  if (saved && saved.hasInterrupted) {
    if (saved.mode === 'batch') { currentTab = 'batch'; showBatchInterrupted(saved); return; }
    if (saved.mode === 'single') { currentTab = 'single'; showInterrupted(saved); return; }
  }

  /* Priority 4 — restore mid-wizard flow if user was setting things up */
  var restored = await restoreWizard();
  if (restored) return;

  /* Default: respect last-used mode (Single or Batch) from masthead toggle.
     Migrate v3.10.0's "quick" value to "single" silently. */
  var lastMode = await new Promise(function(res){
    chrome.storage.local.get('ortus_last_mode', function(d){
      var v = (d && d.ortus_last_mode) || 'batch';
      if (v === 'quick') { v = 'single'; chrome.storage.local.set({ortus_last_mode:'single'}); }
      res(v);
    });
  });
  var tab = await sendBG('checkCurrentTab');
  if (lastMode === 'single') {
    currentTab = 'single';
    if (tab && tab.ok) {
      pageInfo = tab.pageInfo;
      tabId = tab.tabId;
      showView('single-ready');
      /* Stat strip + ready-status update */
      if (tab.pageInfo) {
        $('stat-results').textContent = tab.pageInfo.totalResults || '-';
        $('stat-pages').textContent = tab.pageInfo.totalPages || '-';
      }
    } else {
      showView('single-wrong');
    }
    return;
  }
  /* Default — Batch */
  currentTab = 'batch';
  showView('batch-setup');
  if (tab && tab.ok) { pageInfo = tab.pageInfo; tabId = tab.tabId; }
  chrome.storage.sync.get({srcSheetUrl:''}, function(s){
    if (s.srcSheetUrl) $('input-src-sheet').value = s.srcSheetUrl;
  });
}

/* ═════════════════════════════════════════════════════════════════════
   SINGLE MODE
   ═════════════════════════════════════════════════════════════════════ */
async function initSingle(){
  hideAll();
  var tab = await sendBG('checkCurrentTab');
  if (!tab || !tab.ok) { showView('single-wrong'); return; }
  pageInfo = tab.pageInfo;
  tabId = tab.tabId;
  showView('single-ready');
  var total = pageInfo.totalResults || 0;
  $('stat-results').textContent = total ? (total > 2500 ? '2,500' : total.toLocaleString()) : '-';
  $('stat-pages').textContent = pageInfo.totalPages || '-';
  $('ready-status').textContent = total > 2500
    ? 'Up to 2,500 of ' + total.toLocaleString() + ' (LinkedIn limit)'
    : (total ? total.toLocaleString() + ' leads ready' : 'Ready to scrape');
  chrome.storage.sync.get({lastSheetUrl:'', lastSheetName:''}, function(s){
    if (s.lastSheetUrl) $('input-sheet-url').value = s.lastSheetUrl;
    if (s.lastSheetName) $('input-sheet-name').value = s.lastSheetName;
    /* Now that inputs are populated, fire the dedup preview against the
       restored sheet. Storage hydrate may race the 200ms safety-net below. */
    if (typeof singlePreview === 'function') singlePreview();
  });

  /* Wire result-sheet inputs to refresh dedup preview */
  var singlePreviewTimer = null;
  function singlePreview() {
    var sheet = $('input-sheet-url') ? $('input-sheet-url').value.trim() : '';
    var tab = ($('input-sheet-name') ? $('input-sheet-name').value.trim() : '') || 'Sales Nav Scrape';
    if (sheet.indexOf('docs.google.com/spreadsheets') === -1) {
      /* refreshDedupForView with empty sheet resets state and re-renders */
      window.refreshDedupForView('single', '', '');
      return;
    }
    window.refreshDedupForView('single', sheet, tab);
  }
  ['input-sheet-url','input-sheet-name'].forEach(function(id) {
    var el = $(id);
    if (el && !el._dedupListenerAttached) {
      el._dedupListenerAttached = true;
      el.addEventListener('input', function() {
        if (singlePreviewTimer) clearTimeout(singlePreviewTimer);
        singlePreviewTimer = setTimeout(singlePreview, 600);
      });
    }
  });
  setTimeout(singlePreview, 200);
}

async function startScrape(){
  var u = $('input-sheet-url').value.trim();
  if (!u || u.indexOf('docs.google.com/spreadsheets') === -1) { flash('input-sheet-url'); return; }
  var nm = $('input-sheet-name').value.trim() || 'Sales Nav Scrape';
  chrome.storage.sync.set({lastSheetUrl: u, lastSheetName: nm});
  var cfg = {
    tabId: tabId,
    startPage: pageInfo ? pageInfo.currentPage : 1,
    totalPages: pageInfo ? pageInfo.totalPages : 0,
    totalResults: pageInfo ? pageInfo.totalResults : 0,
    sheetUrl: u, sheetName: nm,
    dedup: window.dedupState ? window.dedupState.single.on : true
  };
  var r = await sendBG('startScrape', {config: cfg});
  if (r.ok) { showView('single-progress'); startPoll(); }
}

function showInterrupted(saved){
  showView('single-interrupted');
  var page = saved.currentPage || 1;
  var total = saved.totalPages || 0;
  var leads = saved.profilesScraped || 0;
  var leadsLabel = leads.toLocaleString() + ' lead' + (leads === 1 ? '' : 's');
  var pagesLeft = total > page ? (total - page + 1) : 0;
  var remainEst = pagesLeft ? pagesLeft * 25 : 0;
  $('int-page-prom').textContent = total ? (page + ' of ' + total) : String(page);
  $('int-saved-prose').textContent = leads ? leadsLabel + ' are' : 'No leads yet,';
  $('int-next-page').textContent = page;
  $('int-profiles').textContent = leads.toLocaleString();
  $('int-remaining').textContent = remainEst ? '~' + remainEst.toLocaleString() : '—';
  $('int-cta-h').textContent = 'Keep going from page ' + page;
  $('int-cta-d').textContent = (leads ? leadsLabel + ' safe' : 'No leads saved yet')
    + (remainEst ? ' — ~' + remainEst.toLocaleString() + ' to go' : '');
}
async function resumeSingle(){
  var r = await sendBG('resumeInterrupted');
  if (r && r.ok) { showView('single-progress'); startPoll(); }
  else { alert(r && r.error ? r.error : 'Could not resume'); discardSingle(); }
}
async function discardSingle(){
  await sendBG('clearSavedState');
  await sendBG('resetState');
  init();
}
function startPoll(){
  updateProgress();
  if (progressInterval) clearInterval(progressInterval);
  progressInterval = setInterval(updateProgress, 1500);
}
async function updateProgress(){
  var st = await sendBG('getState');
  if (!st) return;
  cacheStateForFastReopen(st);
  if (!st.isRunning && st.endTime) { clearInterval(progressInterval); showDone(st); return; }
  $('prog-profiles').textContent = (st.profilesScraped || 0).toLocaleString();
  $('prog-page').textContent = st.currentPage + (st.totalPages ? '/' + st.totalPages : '');
  var pct = st.totalPages > 0 ? Math.round((st.currentPage / st.totalPages) * 100) : 0;
  $('prog-fill').style.width = pct + '%';
  $('prog-pct').textContent = pct + '%';
  if (st.skippedDupes && st.skippedDupes > 0) {
    $('prog-skipped-row').style.display = '';
    $('prog-skipped-count').textContent = st.skippedDupes.toLocaleString();
  } else {
    $('prog-skipped-row').style.display = 'none';
  }
  if (st.startTime && st.currentPage > 1) {
    var el = Date.now() - st.startTime;
    var ms = el / (st.currentPage - 1);
    var rem = (st.totalPages - st.currentPage) * ms;
    $('prog-eta').textContent = '~' + fmtD(rem) + ' remaining';
  }
  $('progress-status').textContent = st.isPaused ? 'Paused' : 'Now scraping';
  $('btn-pause').textContent = st.isPaused ? 'Resume' : 'Pause';
  setLiveBadge(st.isPaused ? 'paused' : 'running', st.isPaused ? 'Paused' : 'Live');
}
async function togglePause(){
  var st = await sendBG('getState');
  await sendBG(st.isPaused ? 'resumeScrape' : 'pauseScrape');
}
async function stopScrape(){
  clearInterval(progressInterval);
  await sendBG('stopScrape');
  var st = await sendBG('getState');
  showDone(st);
}
function showDone(st){
  showView('single-done');
  $('done-profiles').textContent = (st.profilesScraped || st.profileCount || 0).toLocaleString();
  $('done-pages').textContent = st.currentPage || 0;
  $('done-time').textContent = fmtD((st.endTime || Date.now()) - (st.startTime || Date.now()));
  $('done-errors').textContent = (st.errors || []).length;
  if (st.skippedDupes && st.skippedDupes > 0) {
    $('done-skipped-row').style.display = '';
    $('done-skipped-count').textContent = st.skippedDupes.toLocaleString();
  } else {
    $('done-skipped-row').style.display = 'none';
  }
  $('complete-summary').textContent = 'Scraping complete';
  completedSheetUrl = st.sheetUrl || '';
  $('btn-open-sheet').style.display = completedSheetUrl ? '' : 'none';
}
function openSheet(){ if (completedSheetUrl) chrome.tabs.create({url: completedSheetUrl}); }
async function downloadCSV(){
  var r = await sendBG('exportCSV');
  if (!r || !r.csv) { alert('No data'); return; }
  var b = new Blob([r.csv], {type: 'text/csv'});
  var u = URL.createObjectURL(b);
  var a = document.createElement('a');
  a.href = u;
  a.download = 'scrape-' + new Date().toISOString().slice(0,10) + '.csv';
  a.click();
  URL.revokeObjectURL(u);
}
async function scrapeAgain(){
  await sendBG('clearSavedState');
  await sendBG('resetState');
  init();
}

/* ═════════════════════════════════════════════════════════════════════
   BATCH MODE — wizard
   ═════════════════════════════════════════════════════════════════════ */
async function connectSheet(){
  var url = $('input-src-sheet').value.trim();
  if (!url || url.indexOf('docs.google.com/spreadsheets') === -1) { flash('input-src-sheet'); return; }
  /* Sharing is auto-verified by the status pill before this point — Connect button is
   * disabled until the pill flips to ON. No need to re-check here. */
  setBtn('btn-connect-sheet', 'Connecting…', true);
  setLiveBadge('connecting', 'Connecting');
  var r = await sendBG('readTabs', {sheetUrl: url});
  setBtn('btn-connect-sheet', 'Connect', false);
  setLiveBadge('standby', 'Standby');
  if (!r.ok) { alert(r.error || 'Could not connect'); return; }
  if (!r.tabs || r.tabs.length === 0) { alert('No visible tabs found'); return; }
  chrome.storage.sync.set({srcSheetUrl: url});
  batchTabs = r.tabs;
  $('sheet-title').textContent = r.title || 'Connected';
  var sel = $('sel-src-tab'); sel.innerHTML = '';
  for (var i = 0; i < r.tabs.length; i++) {
    var o = document.createElement('option');
    o.value = r.tabs[i].name;
    o.textContent = r.tabs[i].name + ' (' + r.tabs[i].rows + ' rows)';
    sel.appendChild(o);
  }
  updateTabHint();
  showView('batch-tab-select');
  saveWizard();
}

function updateTabHint(){
  var sel = $('sel-src-tab');
  if (!batchTabs) return;
  var name = sel.value;
  var t = batchTabs.find(function(x){ return x.name === name; });
  $('tab-row-hint').textContent = t ? (t.rows - 1) + ' data rows · ' + t.cols + ' columns' : '';
}

async function loadTabData(){
  var url = $('input-src-sheet').value.trim();
  var tabName = $('sel-src-tab').value;
  setBtn('btn-load-tab', 'Loading…', true);
  var r = await sendBG('readColumns', {sheetUrl: url, tabName: tabName});
  setBtn('btn-load-tab', 'Load data', false);
  if (!r.ok) { alert(r.error || 'Could not load data'); return; }
  if (!r.headers || r.headers.length === 0) { alert('Tab appears empty'); return; }
  batchColData = {
    headers: r.headers, sampleRows: r.sampleRows || [], allRows: r.allRows || [],
    srcUrl: url, srcTab: tabName, totalRows: r.totalRows || (r.allRows || []).length
  };
  var h = r.headers;
  populateColSelect('sel-url-col', h);
  populateColSelect('sel-tab-col', h);
  /* Auto-select URL column */
  for (var i = 0; i < h.length; i++) {
    var lc = h[i].toLowerCase();
    if (lc.indexOf('sales nav') !== -1 || lc.indexOf('salesnav') !== -1 || lc.indexOf('linkedin') !== -1 || lc.indexOf('url') !== -1 || lc.indexOf('link') !== -1) {
      $('sel-url-col').value = i; break;
    }
  }
  /* Auto-select tab name column */
  for (var j = 0; j < h.length; j++) {
    var lt = h[j].toLowerCase();
    if (lt.indexOf('tab') !== -1 || lt.indexOf('campaign') !== -1 || lt.indexOf('sheet') !== -1) {
      $('sel-tab-col').value = j; break;
    }
  }
  /* Output column dropdown */
  var outSel = $('sel-output-col'); outSel.innerHTML = '';
  var none = document.createElement('option'); none.value = '-1'; none.textContent = "Don't write back"; outSel.appendChild(none);
  for (var k = 0; k < h.length; k++) {
    var oo = document.createElement('option'); oo.value = k; oo.textContent = (k + 1) + '. ' + h[k]; outSel.appendChild(oo);
  }
  /* Tab source — hidden select keeps all 3 options always */
  var tabSrc = $('sel-tab-source');
  tabSrc.value = 'auto';
  onTabSourceChange();
  if (typeof window.syncRadioCardsFromSelect === 'function') window.syncRadioCardsFromSelect();
  /* Render the new listbox UIs (driven by the hidden selects above) */
  if (typeof window.populateColListbox === 'function') {
    window.populateColListbox('sel-url-col-listbox', 'sel-url-col', h, batchColData.sampleRows);
    window.populateColListbox('sel-tab-col-listbox', 'sel-tab-col', h, batchColData.sampleRows);
    window.populateColListbox('sel-output-col-listbox', 'sel-output-col', h, batchColData.sampleRows, {includeNone:true, noneLabel:"Don't write back"});
  }
  /* Row range defaults */
  $('input-row-from').value = '2';
  $('input-row-to').value = '';
  $('input-row-to').placeholder = (batchColData.totalRows + 1) || 'All';
  /* Restore dest sheet */
  chrome.storage.sync.get({destSheetUrl:'', destTabName:''}, function(s){
    if (s.destSheetUrl) $('input-dest-sheet').value = s.destSheetUrl;
    if (s.destTabName) $('input-dest-tab').value = s.destTabName;
  });
  showView('batch-config');
  updateColPreview();
  saveWizard();
}

function updateColPreview(){
  var prev = $('col-preview');
  if (!prev) return; /* legacy node — replaced by inline previews in sel-url-col-listbox */
  var idx = parseInt($('sel-url-col').value);
  prev.innerHTML = '';
  if (!batchColData || !batchColData.sampleRows) return;
  var shown = 0;
  for (var i = 0; i < Math.min(batchColData.sampleRows.length, 5); i++) {
    var val = (batchColData.sampleRows[i][idx] || '').toString().trim();
    if (!val) continue;
    var s = document.createElement('span');
    s.textContent = val.length > 60 ? val.substring(0, 57) + '…' : val;
    prev.appendChild(s); shown++;
  }
  if (shown === 0) prev.innerHTML = '<em>No values in selected column</em>';
}

function onTabSourceChange(){
  var v = $('sel-tab-source').value;
  $('field-fixed-tab').classList.toggle('hidden', v !== 'fixed');
  $('field-tab-col').classList.toggle('hidden', v !== 'column');
  if (v === 'column') updateTabColPreview();
}

function updateTabColPreview(){
  var prev = $('tab-col-preview');
  if (!prev) return; /* legacy node — replaced by inline previews in sel-tab-col-listbox */
  var idx = parseInt($('sel-tab-col').value);
  prev.innerHTML = '';
  if (!batchColData || !batchColData.sampleRows) return;
  var shown = 0;
  for (var i = 0; i < Math.min(batchColData.sampleRows.length, 5); i++) {
    var val = (batchColData.sampleRows[i][idx] || '').toString().trim();
    if (!val) continue;
    var s = document.createElement('span'); s.textContent = val;
    prev.appendChild(s); shown++;
  }
  if (shown === 0) prev.innerHTML = '<em>No values in selected column</em>';
}

async function confirmBatchConfig(){
  var destUrl = $('input-dest-sheet').value.trim();
  if (!destUrl || destUrl.indexOf('docs.google.com/spreadsheets') === -1) { flash('input-dest-sheet'); return; }
  var tabSource = $('sel-tab-source').value;
  var fixedTabName = $('input-dest-tab').value.trim() || 'Sales Nav Scrape';
  var tabColIdx = parseInt($('sel-tab-col').value);
  var colIdx = parseInt($('sel-url-col').value);
  var outputColIdx = parseInt($('sel-output-col').value);
  var rowFrom = parseInt($('input-row-from').value) || 2;
  var rowToRaw = $('input-row-to').value.trim();
  var rowTo = rowToRaw ? parseInt(rowToRaw) : 0;
  chrome.storage.sync.set({destSheetUrl: destUrl, destTabName: fixedTabName});

  var rows = batchColData.allRows || [];
  var startIdx = Math.max(0, rowFrom - 2);
  var endIdx = rowTo > 0 ? Math.min(rows.length, rowTo - 1) : rows.length;
  var jobs = []; var autoNum = 1;
  for (var i = startIdx; i < endIdx; i++) {
    var val = (rows[i][colIdx] || '').toString().trim();
    if (!val) continue;
    if (val.indexOf('linkedin.com/sales') === -1) continue;
    var tabName;
    if (tabSource === 'column') tabName = (rows[i][tabColIdx] || '').toString().trim() || ('Scrape ' + autoNum);
    else if (tabSource === 'fixed') tabName = fixedTabName;
    else tabName = 'Scrape ' + autoNum;
    jobs.push({ row: i + 2, salesNavUrl: val, resultSheetUrl: destUrl, tabName: tabName, status: 'Pending' });
    autoNum++;
  }
  if (jobs.length === 0) { alert('No valid Sales Nav URLs found in rows ' + rowFrom + '-' + (rowTo || 'end')); return; }

  lastSetJobsConfig = {
    srcSheetUrl: batchColData.srcUrl, srcTabName: batchColData.srcTab,
    destSheetUrl: destUrl, destTabName: fixedTabName,
    outputColIdx: outputColIdx >= 0 ? outputColIdx + 1 : -1
  };
  var r = await sendBG('setJobs', Object.assign({jobs: jobs, dedup: window.dedupState ? window.dedupState.batch.on : true}, lastSetJobsConfig));
  if (!r.ok) { alert(r.error || 'Error setting up jobs'); return; }

  showView('batch-ready');
  $('batch-ready-msg').textContent = jobs.length + ' jobs · rows ' + rowFrom + '–' + (rowTo || batchColData.totalRows);
  jobToggles = jobs.map(function(){ return true; });
  renderJobsForPreview(jobs);
  saveWizard();

  /* Preview dedup against the FIRST job's destination tab as a representative.
     Each job has its own dedup at runtime; this preview is informational. */
  if (jobs.length > 0 && window.refreshDedupForView) {
    window.refreshDedupForView('batch', jobs[0].resultSheetUrl, jobs[0].tabName);
  }
}

async function startBatch(){
  /* Filter to only included jobs */
  var st = await sendBG('getState');
  var jobs = (st && st.jobs) ? st.jobs : [];
  var keep = jobs.filter(function(_, idx){ return jobToggles[idx] !== false; });
  if (keep.length === 0) { alert('All jobs are toggled off'); return; }
  if (keep.length !== jobs.length) {
    /* Re-register the filtered set, preserving the original write-back config */
    var cfg = lastSetJobsConfig || {
      srcSheetUrl: batchColData ? batchColData.srcUrl : '',
      srcTabName: batchColData ? batchColData.srcTab : '',
      destSheetUrl: keep[0].resultSheetUrl,
      destTabName: keep[0].tabName,
      outputColIdx: -1
    };
    await sendBG('setJobs', Object.assign({jobs: keep, dedup: window.dedupState ? window.dedupState.batch.on : true}, cfg));
  }
  clearWizard();
  var r = await sendBG('startBatch');
  if (r.ok) { showView('batch-running'); startBatchPoll(); }
}

function startBatchPoll(){
  if (progressInterval) clearInterval(progressInterval);
  progressInterval = setInterval(async function(){
    var st = await sendBG('getState');
    updateBatchView(st);
  }, 2000);
}

function updateBatchView(st){
  if (!st) return;
  cacheStateForFastReopen(st);
  if (!st.isRunning && st.endTime && st.mode === 'batch') {
    clearInterval(progressInterval);
    showBatchDone(st);
    return;
  }
  if (st.isRunning && st.mode === 'batch') {
    var ji = st.currentJobIndex || 0;
    var job = (st.jobs || [])[ji] || {};
    $('batch-status').textContent = st.isPaused ? 'Paused' : 'Now scraping · job ' + (ji + 1) + ' of ' + (st.jobs || []).length;
    $('batch-job-name').textContent = job.tabName || ('Job ' + (ji + 1));
    $('batch-job-sub').textContent = decodeSubLine(job.salesNavUrl || '');
    var pb = $('btn-pause-batch'); if (pb) pb.textContent = st.isPaused ? 'Resume' : 'Pause';
    var s = st.profilesScraped || 0, t = st.totalResults || 0, cap = Math.min(t, 2500);
    var pct = cap > 0 ? Math.min(100, Math.round(s / cap * 100)) : 0;
    var anonPerJob = computeAnonymousFromJobs(st.jobs);
    $('bp-bar').style.width = pct + '%';
    $('bp-lbl').textContent = 'Page ' + (st.currentPage || 1) + (st.totalPages ? ' / ' + st.totalPages : '');
    $('bp-pct').textContent = pct + '%';
    $('bp-n').textContent = s.toLocaleString();
    $('bp-t').textContent = t > 0 ? (t > 2500 ? ' of 2,500' : ' of ' + t.toLocaleString()) : '';
    if (anonPerJob > 0) {
      $('batch-anon-note').classList.remove('hidden');
      $('batch-anon-count').textContent = anonPerJob + ' lead' + (anonPerJob === 1 ? '' : 's') + ' missing so far.';
      $('bp-anon-meta').textContent = anonPerJob + ' missing';
    } else {
      $('batch-anon-note').classList.add('hidden');
      $('bp-anon-meta').textContent = '';
    }
    /* ETA */
    if (st.startTime && st.currentPage > 1 && st.totalPages > 0) {
      var el = Date.now() - st.startTime;
      var ms = el / (st.currentPage - 1);
      var rem = (st.totalPages - st.currentPage) * ms;
      $('bp-eta').textContent = '~' + fmtD(rem) + ' remaining';
    } else {
      $('bp-eta').textContent = '';
    }
    if (st.skippedDupes && st.skippedDupes > 0) {
      $('bp-skipped-row').style.display = '';
      $('bp-skipped-count').textContent = st.skippedDupes.toLocaleString();
    } else {
      $('bp-skipped-row').style.display = 'none';
    }
    setLiveBadge(st.isPaused ? 'paused' : 'running', st.isPaused ? 'Paused' : 'Live');
    renderJobsForQueue('batch-job-list', st.jobs, st.currentJobIndex, st.isPaused);
  }
}

async function stopBatch(){
  clearInterval(progressInterval);
  await sendBG('stopBatch');
  var st = await sendBG('getState');
  showBatchDone(st);
}
async function togglePauseBatch(){
  var st = await sendBG('getState');
  await sendBG(st && st.isPaused ? 'resumeBatch' : 'pauseBatch');
  var st2 = await sendBG('getState');
  updateBatchView(st2);
}
async function recoverBatch(){
  var b = $('btn-recover-batch');
  if (b) { b.disabled = true; b.textContent = 'Recovering…'; }
  var r = await sendBG('recoverBatch');
  if (b) setTimeout(function(){ b.disabled = false; b.textContent = 'Recover'; }, 3000);
  if (r && !r.ok) alert(r.error || 'Could not recover');
}

function showBatchDone(st){
  showView('batch-done');
  clearWizard();
  var jobs = st.jobs || [];
  var done = jobs.filter(function(j){ return j.status && j.status.indexOf('Done') === 0; }).length;
  var partial = jobs.filter(function(j){ return j.status && j.status.indexOf('Partial') === 0; }).length;
  var total = jobs.length;
  var msg = done + ' of ' + total + ' done';
  if (partial > 0) msg += ' · ' + partial + ' partial';
  $('batch-done-msg').textContent = msg;
  setLiveBadge('done', 'Complete');
  renderJobsForQueue('batch-done-list', jobs, -1);
  var __batchSkipTotal = st.totalSkippedDupes || st.skippedDupes || 0;
  if (__batchSkipTotal > 0) {
    $('batch-done-skipped-row').style.display = '';
    $('batch-done-skipped-count').textContent = __batchSkipTotal.toLocaleString();
  } else {
    $('batch-done-skipped-row').style.display = 'none';
  }
}

function showBatchInterrupted(saved){
  showView('batch-interrupted');
  var jobs = saved.jobs || [];
  var done = jobs.filter(function(j){ return j.status && j.status.indexOf('Done') === 0; }).length;
  var total = jobs.length;
  var nextIdx = jobs.findIndex(function(j){ return !(j.status && j.status.indexOf('Done') === 0); });
  if (nextIdx < 0) nextIdx = total; /* all done */
  var nextJobNum = nextIdx + 1;
  var remaining = Math.max(0, total - done);
  $('bint-job-prom').textContent = nextJobNum > total ? '—' : String(nextJobNum);
  $('bint-total-prom').textContent = String(total);
  $('bint-summary').textContent = done === 0 ? 'No jobs finished yet.' : (done + ' of ' + total + ' job' + (total === 1 ? '' : 's') + ' already done.');
  $('bint-next').textContent = nextJobNum > total ? '—' : ('job ' + nextJobNum);
  $('bint-done').textContent = done;
  $('bint-remaining').textContent = remaining || '—';
  $('bint-cta-h').textContent = nextJobNum > total ? 'All jobs already done' : ('Keep going from job ' + nextJobNum);
  $('bint-cta-d').textContent = done + '/' + total + ' done' + (remaining ? ' — ' + remaining + ' to go' : '');
  setLiveBadge('warn', 'Interrupted');
  renderJobsForQueue('batch-int-list', jobs, -1);
}
async function resumeBatch(){
  var r = await sendBG('resumeInterrupted');
  if (r && r.ok) { showView('batch-running'); startBatchPoll(); }
  else { alert(r && r.error ? r.error : 'Could not resume'); discardBatch(); }
}
async function discardBatch(){
  clearWizard();
  await sendBG('clearSavedState');
  await sendBG('resetState');
  init();
}
async function batchAgain(){
  clearWizard();
  await sendBG('clearSavedState');
  await sendBG('resetState');
  init();
}

/* ═════════════════════════════════════════════════════════════════════
   WIZARD PERSISTENCE
   ═════════════════════════════════════════════════════════════════════ */
function saveWizard(){
  var w = {
    step: currentView, batchColData: batchColData, batchTabs: batchTabs,
    srcSheet: gv('input-src-sheet'), selSrcTab: gv('sel-src-tab'),
    selUrlCol: gv('sel-url-col'), selTabSource: gv('sel-tab-source'), selTabCol: gv('sel-tab-col'),
    selOutputCol: gv('sel-output-col'),
    destSheet: gv('input-dest-sheet'), destTab: gv('input-dest-tab'),
    rowFrom: gv('input-row-from'), rowTo: gv('input-row-to')
  };
  chrome.storage.session.set({ortus_wizard: w});
}
async function restoreWizard(){
  try{
    var d = await chrome.storage.session.get('ortus_wizard');
    if (!d || !d.ortus_wizard) return false;
    var w = d.ortus_wizard;
    if (!w.step || w.step.indexOf('batch-') === -1) return false;
    if (w.srcSheet) sv('input-src-sheet', w.srcSheet);

    if (w.step === 'batch-tab-select' && w.batchTabs) {
      batchTabs = w.batchTabs;
      rebuildTabDropdown(w);
      showView('batch-tab-select');
      return true;
    }
    if (w.step === 'batch-config' && w.batchColData) {
      batchColData = w.batchColData; batchTabs = w.batchTabs;
      rebuildAllDropdowns(w);
      showView('batch-config');
      updateColPreview(); onTabSourceChange();
      return true;
    }
    if (w.step === 'batch-ready') {
      var st = await sendBG('getState');
      if (st && st.jobs && st.jobs.length > 0) {
        showView('batch-ready');
        $('batch-ready-msg').textContent = st.jobs.length + ' jobs ready';
        jobToggles = st.jobs.map(function(){ return true; });
        renderJobsForPreview(st.jobs);
        return true;
      }
    }
  } catch(e) { console.log('[Popup] Restore err:', e); }
  return false;
}
function clearWizard(){ chrome.storage.session.remove('ortus_wizard'); }

function rebuildTabDropdown(w){
  var sel = $('sel-src-tab'); sel.innerHTML = '';
  if (!batchTabs) return;
  for (var i = 0; i < batchTabs.length; i++) {
    var o = document.createElement('option'); o.value = batchTabs[i].name;
    o.textContent = batchTabs[i].name + ' (' + batchTabs[i].rows + ' rows)';
    sel.appendChild(o);
  }
  if (w.selSrcTab) sel.value = w.selSrcTab;
  updateTabHint();
}
function rebuildAllDropdowns(w){
  if (!batchColData || !batchColData.headers) return;
  var h = batchColData.headers;
  populateColSelect('sel-url-col', h, w.selUrlCol);
  populateColSelect('sel-tab-col', h, w.selTabCol);
  var outSel = $('sel-output-col'); outSel.innerHTML = '';
  var none = document.createElement('option'); none.value = '-1'; none.textContent = "Don't write back"; outSel.appendChild(none);
  for (var i = 0; i < h.length; i++) {
    var o = document.createElement('option'); o.value = i; o.textContent = (i + 1) + '. ' + h[i]; outSel.appendChild(o);
  }
  if (w.selOutputCol) outSel.value = w.selOutputCol;
  var tabSrcSel = $('sel-tab-source');
  if (w.selTabSource) tabSrcSel.value = w.selTabSource;
  if (typeof window.syncRadioCardsFromSelect === 'function') window.syncRadioCardsFromSelect();
  if (w.destSheet) sv('input-dest-sheet', w.destSheet);
  if (w.destTab) sv('input-dest-tab', w.destTab);
  if (w.rowFrom) sv('input-row-from', w.rowFrom);
  if (w.rowTo) sv('input-row-to', w.rowTo);
  /* Render listbox UIs after select values are set */
  if (typeof window.populateColListbox === 'function') {
    window.populateColListbox('sel-url-col-listbox', 'sel-url-col', h, batchColData.sampleRows);
    window.populateColListbox('sel-tab-col-listbox', 'sel-tab-col', h, batchColData.sampleRows);
    window.populateColListbox('sel-output-col-listbox', 'sel-output-col', h, batchColData.sampleRows, {includeNone:true, noneLabel:"Don't write back"});
  }
}
function populateColSelect(id, headers, selectedVal){
  var sel = $(id); sel.innerHTML = '';
  for (var i = 0; i < headers.length; i++) {
    var o = document.createElement('option'); o.value = i; o.textContent = (i + 1) + '. ' + headers[i]; sel.appendChild(o);
  }
  if (selectedVal !== undefined && selectedVal !== null) sel.value = selectedVal;
}

/* ═════════════════════════════════════════════════════════════════════
   FILTER DECODE — turn a Sales Nav URL into human-readable chips
   ═════════════════════════════════════════════════════════════════════ */
function decodeSalesNavUrl(url){
  var chips = [];
  if (!url) return chips;
  var qIdx = url.indexOf('?');
  if (qIdx === -1) return chips;
  var qs = url.substring(qIdx + 1);
  var parts = qs.split('&');
  var params = {};
  parts.forEach(function(p){
    var kv = p.split('=');
    if (kv.length === 2) {
      try { params[kv[0]] = decodeURIComponent(kv[1]); } catch(e) { params[kv[0]] = kv[1]; }
    }
  });

  if (params.keywords) chips.push({k:'Keywords', v: params.keywords.replace(/\+/g,' ')});
  if (params.titleIncluded || params.title) chips.push({k:'Title', v: extractValues(params.titleIncluded || params.title)});
  if (params.titleExcluded) chips.push({k:'Title not', v: extractValues(params.titleExcluded), muted:true});
  if (params.geoIncluded) chips.push({k:'Geo', v: chipCount(params.geoIncluded, 'region')});
  if (params.geoExcluded) chips.push({k:'Geo not', v: chipCount(params.geoExcluded, 'region'), muted:true});
  if (params.industryIncluded) chips.push({k:'Industry', v: chipCount(params.industryIncluded, 'industry')});
  if (params.industryExcluded) chips.push({k:'Industry not', v: chipCount(params.industryExcluded, 'industry'), muted:true});
  if (params.companyIncluded) chips.push({k:'Company', v: chipCount(params.companyIncluded, 'company')});
  if (params.companyExcluded) chips.push({k:'Company not', v: chipCount(params.companyExcluded, 'company'), muted:true});
  if (params.companySize) chips.push({k:'Company size', v: extractValues(params.companySize)});
  if (params.seniorityIncluded || params.seniorityLevel) chips.push({k:'Seniority', v: extractValues(params.seniorityIncluded || params.seniorityLevel)});
  if (params.functionIncluded || params.function) chips.push({k:'Function', v: extractValues(params.functionIncluded || params.function)});
  if (params.tenureAtCompany) chips.push({k:'Tenure at company', v: extractValues(params.tenureAtCompany)});
  if (params.tenureAtRole) chips.push({k:'Tenure in role', v: extractValues(params.tenureAtRole)});
  if (params.recentlyChangedJobs) chips.push({k:'Changed jobs', v: 'Past 90 days', muted: false});
  if (params.postedContent || params.posted) chips.push({k:'Posted', v: 'Recently', muted:true});
  if (params.relationship) chips.push({k:'Relationship', v: extractValues(params.relationship), muted:true});

  return chips;
}
function extractValues(s){
  if (!s) return '';
  /* values in Sales Nav URLs often look like: List(VALUE,VALUE) or just plain comma-list */
  var inner = s.replace(/^List\(/, '').replace(/\)$/, '');
  var parts = inner.split(',').map(function(p){ return p.replace(/^urn:.*?:/, '').trim(); }).filter(function(p){ return p.length > 0; });
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  if (parts.length <= 3) return parts.join(' · ');
  return parts.slice(0,2).join(' · ') + ' +' + (parts.length - 2);
}
function chipCount(s, noun){
  if (!s) return '';
  var inner = s.replace(/^List\(/, '').replace(/\)$/, '');
  var parts = inner.split(',').filter(function(p){ return p.trim().length > 0; });
  if (parts.length === 1) return '1 ' + noun;
  return parts.length + ' ' + noun + 's';
}
function decodeSubLine(url){
  var chips = decodeSalesNavUrl(url);
  if (chips.length === 0) return '';
  var parts = [];
  chips.slice(0, 3).forEach(function(c){
    if (!c.muted) parts.push(c.v);
  });
  return parts.join(' · ');
}

/* ═════════════════════════════════════════════════════════════════════
   RENDERERS
   ═════════════════════════════════════════════════════════════════════ */
function renderJobsForPreview(jobs){
  var ul = $('job-list'); ul.innerHTML = '';
  for (var i = 0; i < jobs.length; i++) {
    var j = jobs[i];
    var li = document.createElement('li');
    var nm = j.tabName || ('Job ' + (i + 1));
    var url = j.salesNavUrl || '';
    var chips = decodeSalesNavUrl(url);
    var subline = decodeSubLine(url) || shorten(url, 50);
    var on = jobToggles[i] !== false;

    li.innerHTML =
      '<div class="row">' +
        '<span class="num">' + zeroPad(i + 1) + '</span>' +
        '<div><div class="nm">' + esc(nm) + '</div><div class="est">' + esc(subline) + '</div></div>' +
        '<div class="toggle' + (on ? '' : ' off') + '" data-idx="' + i + '"></div>' +
        '<button class="expand" data-idx="' + i + '" type="button">▾</button>' +
      '</div>';

    if (chips.length > 0) {
      var chipHtml = '<div class="filter-detail">';
      chipHtml += '<div class="header">Filters decoded</div>';
      chipHtml += '<div class="chips">';
      chips.forEach(function(c){
        chipHtml += '<span class="fchip' + (c.muted ? ' muted' : '') + '"><span class="k">' + esc(c.k) + '</span>' + esc(c.v || '') + '</span>';
      });
      chipHtml += '</div>';
      chipHtml += '<div class="urn">' + esc(shorten(url, 200)) + '</div>';
      chipHtml += '</div>';
      li.innerHTML += chipHtml;
      li.querySelector('.filter-detail').style.display = 'none';
    }
    ul.appendChild(li);
  }
  ul.onclick = function(e){
    var t = e.target;
    if (!t || !t.classList) return;
    if (t.classList.contains('toggle')) {
      var idx = parseInt(t.getAttribute('data-idx'), 10);
      jobToggles[idx] = t.classList.contains('off');
      t.classList.toggle('off');
      return;
    }
    if (t.classList.contains('expand')) {
      var idx2 = parseInt(t.getAttribute('data-idx'), 10);
      var li = ul.children[idx2];
      var detail = li.querySelector('.filter-detail');
      var open = li.classList.toggle('expanded');
      if (detail) detail.style.display = open ? 'block' : 'none';
      t.textContent = open ? '▴' : '▾';
      return;
    }
  };
}

function renderJobsForQueue(elId, jobs, activeIdx, isPaused){
  var ul = $(elId); if (!ul) return;
  ul.innerHTML = '';
  for (var i = 0; i < jobs.length; i++) {
    var j = jobs[i];
    var li = document.createElement('li');
    var sc = 'pending', st = j.status || 'Pending';
    if (j.status && j.status.indexOf('Done') === 0) sc = 'done';
    else if (j.status && j.status.indexOf('Partial') === 0) sc = 'partial';
    else if (j.status === 'Running' || i === activeIdx) {
      if (isPaused && i === activeIdx) { sc = 'paused'; st = 'Paused'; }
      else { sc = 'running'; st = 'Running'; }
    }
    else if (j.status && (j.status.indexOf('Error') === 0 || j.status === 'Stopped' || j.status === 'Incomplete')) sc = 'error';

    var nm = j.tabName || ('Job ' + (i + 1));
    var meta = j.profilesScraped ? (j.profilesScraped + ' leads') : (decodeSubLine(j.salesNavUrl) || '—');
    var canRetry = (sc === 'error' || sc === 'partial');
    var retryHtml = canRetry ? '<button class="retry" data-idx="' + i + '" title="Retry" type="button">↻</button>' : '';
    var displayStatus = simplifyStatus(j.status, sc);
    li.innerHTML =
      '<span class="num">' + zeroPad(i + 1) + '</span>' +
      '<div class="info"><div class="nm">' + esc(nm) + '</div><div class="meta">' + esc(meta) + '</div></div>' +
      '<span class="chip ' + sc + '"><span class="dot"></span>' + esc(displayStatus) + '</span>' +
      retryHtml;
    ul.appendChild(li);
  }
  ul.onclick = function(e){
    var t = e.target;
    if (!t || !t.classList || !t.classList.contains('retry')) return;
    var idx = parseInt(t.getAttribute('data-idx'), 10);
    if (!isNaN(idx)) retryJob(idx, t);
  };
}

function simplifyStatus(raw, sc){
  if (!raw) return sc.charAt(0).toUpperCase() + sc.slice(1);
  if (sc === 'done') return 'Done';
  if (sc === 'partial') return 'Partial';
  if (sc === 'error') return 'Error';
  if (sc === 'running') return 'Running';
  if (sc === 'paused') return 'Paused';
  return raw;
}

async function retryJob(idx, btn){
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  var r = await sendBG('retryJob', {index: idx});
  if (r && !r.ok) {
    alert(r.error || 'Could not retry');
    if (btn) { btn.disabled = false; btn.textContent = '↻'; }
    return;
  }
  var st = await sendBG('getState');
  if (st && st.isRunning && st.mode === 'batch') { showView('batch-running'); startBatchPoll(); updateBatchView(st); }
  else { updateBatchView(st); }
}

function computeAnonymousFromJobs(jobs){
  /* Parse "X missing" out of done/partial job.status strings (was "anonymous" — renamed because we don't actually verify) */
  if (!jobs) return 0;
  var total = 0;
  for (var i = 0; i < jobs.length; i++) {
    var s = jobs[i].status || '';
    var m = s.match(/(\d+)\s+missing/);
    if (m) total += parseInt(m[1], 10) || 0;
  }
  return total;
}

/* ═════════════════════════════════════════════════════════════════════
   VIEW ROUTER + LIVE BADGE
   ═════════════════════════════════════════════════════════════════════ */
function hideAll(){
  ['single-wrong','single-ready','single-progress','single-done','single-interrupted',
   'batch-setup','batch-tab-select','batch-config','batch-ready','batch-running','batch-done','batch-interrupted',
   'settings'].forEach(function(id){
    var el = document.getElementById('view-' + id);
    if (el) el.classList.add('hidden');
  });
}
function showView(name){
  hideAll();
  var el = document.getElementById('view-' + name);
  if (el) el.classList.remove('hidden');
  currentView = name;
  /* Sync the masthead Single / Batch toggle to match the view */
  var mq = document.getElementById('mode-single');
  var mb = document.getElementById('mode-batch');
  if (mq && mb) {
    if (name && name.indexOf('single-') === 0) {
      mq.setAttribute('aria-pressed','true'); mb.setAttribute('aria-pressed','false');
    } else if (name && name.indexOf('batch-') === 0) {
      mq.setAttribute('aria-pressed','false'); mb.setAttribute('aria-pressed','true');
    }
  }
  /* Hide the combined control strip on any view past the entry points — once you're
     mid-flow, the mode choice is irrelevant and switching tabs would lose work.
     Slow mode goes with it; users rarely toggle it mid-run anyway. */
  var ctrlStrip = document.querySelector('.control-strip');
  if (ctrlStrip) {
    var entryViews = ['batch-setup','single-ready','single-wrong'];
    ctrlStrip.classList.toggle('hidden', entryViews.indexOf(name) === -1);
  }
  /* Live badge default per view (running/done overrides happen in updateBatchView/updateProgress) */
  if (name === 'single-progress' || name === 'batch-running') {
    /* state will be set by polling */
  } else if (name === 'single-done' || name === 'batch-done') {
    setLiveBadge('done', 'Complete');
  } else if (name === 'single-interrupted' || name === 'batch-interrupted') {
    setLiveBadge('warn', 'Interrupted');
  } else if (name === 'batch-tab-select' || name === 'batch-config' || name === 'batch-ready') {
    setLiveBadge('ready', 'Setup');
  } else if (name === 'settings') {
    setLiveBadge('standby', 'Settings');
  } else if (name === 'single-ready') {
    setLiveBadge('ready', 'Ready');
  } else {
    setLiveBadge('standby', 'Standby');
  }
}
function setLiveBadge(state, label){
  var b = $('live-badge');
  if (!b) return;
  b.setAttribute('data-state', state);
  $('live-label').textContent = label;
}

/* ═════════════════════════════════════════════════════════════════════
   UTILITIES
   ═════════════════════════════════════════════════════════════════════ */
function $(id){ return document.getElementById(id); }
function sendBG(a, x){
  return new Promise(function(r){
    chrome.runtime.sendMessage(Object.assign({action: a}, x || {}), function(v){ r(v || {}); });
  });
}
function fmtD(ms){
  if (!ms || ms < 0) return '-';
  var s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  var mn = Math.floor(s / 60);
  if (mn < 60) return mn + 'm ' + (s % 60) + 's';
  return Math.floor(mn / 60) + 'h ' + (mn % 60) + 'm';
}
function esc(s){ var d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }
function flash(id){ var el = $(id); if (!el) return; el.style.borderColor = 'var(--err)'; setTimeout(function(){ el.style.borderColor = ''; }, 2000); }
function setBtn(id, text, dis){
  var b = $(id); if (!b) return;
  /* preserve the gold pod if present */
  var pod = b.querySelector('.pod');
  if (pod) { b.firstChild.textContent = text; b.disabled = dis; }
  else { b.textContent = text; b.disabled = dis; }
}
function gv(id){ var el = $(id); return el ? el.value : ''; }
function sv(id, v){ var el = $(id); if (el) el.value = v; }
function debounce(fn, ms){ var t; return function(){ clearTimeout(t); t = setTimeout(fn, ms); }; }
function zeroPad(n){ return n < 10 ? '0' + n : String(n); }
function shorten(s, max){ if (!s) return ''; return s.length > max ? s.substring(0, max - 1) + '…' : s; }
