/**
 * TEST Medium Mode 1.1 - Content Script v8
 * v1.1 adds: silent audio throttle prevention, throttle event forwarding
 *
 * IMPROVEMENTS over v7:
 * - MutationObserver DOM settling before extraction (catches lazy-rendered cards)
 * - Incremental scroll-by fallback when scrollIntoView isn't enough
 * - Validation pass: skip profiles with empty name/URL (placeholder cards)
 * - Dual deduplication: by URL AND membershipId
 * - Better scroll timing with exponential backoff on stable counts
 */

(() => {

  /* ═══ GUARD: Prevent multiple listener registrations ═══
   * background.js calls executeScript({files:['content.js']}) on every page nav.
   * Each call re-runs this IIFE, creating duplicate listeners.
   * If we already loaded, bail out — the first closure handles everything.
   * Its DOM queries (harvestVisible, getPageInfo etc) always reflect current page. */
  if (window.__ortusContentLoaded) {
    console.log('[Ortus] Guard: already loaded, skipping re-registration (injection #' + (window.__ortusInjectionCount || 1) + ')');
    window.__ortusInjectionCount = (window.__ortusInjectionCount || 1) + 1;
    return;
  }
  window.__ortusContentLoaded = true;
  window.__ortusInjectionCount = 1;

  /* Increase resource timing buffer */
  try { performance.setResourceTimingBufferSize(500); } catch(e) {}

  /* Slow mode — set by background.js before extraction */
  var SLOW_MODE = false;
  function sd(fast, slow) { return SLOW_MODE ? slow : fast; }

  /* ═══ v4.0 FETCH INTERCEPTOR: Capture LinkedIn's own API responses ═══
   * Content scripts run in an ISOLATED world — they can't see LinkedIn's fetch.
   * We inject a <script> tag into the MAIN world that monkey-patches fetch
   * and posts intercepted data back to us via CustomEvent. */
  var openLinkCache = {};
  var apiEnrichCache = {}; /* memberId → {openLink, premium, company, title} */

  /* Listen for data from the main-world interceptor (use document, not window,
   * because document is shared across MAIN and ISOLATED worlds in MV3) */
  /* v4.3 — forward throttle events from interceptor to background */
  document.addEventListener('__ortus_throttle_detected', function(e) {
    try {
      var d = JSON.parse(e.detail);
      console.log('[Ortus] Content: throttle detected (' + d.status + '), forwarding to background');
      chrome.runtime.sendMessage({ action: 'throttleDetected', status: d.status, retryAfter: d.retryAfter });
    } catch(err) {}
  });

  document.addEventListener('__ortus_api_data', function(e) {
    try {
      var data = JSON.parse(e.detail);
      if (data.elements) {
        var newCount = 0;
        for (var i = 0; i < data.elements.length; i++) {
          var elem = data.elements[i];
          var memberId = elem.memberId;
          if (!memberId) continue;
          if (!apiEnrichCache.hasOwnProperty(memberId)) newCount++;
          apiEnrichCache[memberId] = elem;
          openLinkCache[memberId] = elem.openLink;
        }
        if (data.total) exactTotalResults = data.total;
        var openCount = 0; var premCount = 0;
        for (var k in apiEnrichCache) { if (apiEnrichCache[k].openLink) openCount++; if (apiEnrichCache[k].premium) premCount++; }
        console.log('[Ortus] INTERCEPTED: +' + newCount + ' profiles (' + data.elements.length + ' in response), cache: ' + Object.keys(apiEnrichCache).length + ' (' + openCount + ' open, ' + premCount + ' premium)');
      }
    } catch(err) { console.log('[Ortus] Intercept event error:', err.message); }
  });

  /* interceptor.js handles the MAIN world fetch patching via manifest content_scripts.
   * It sends data back via CustomEvent AND stores on window.__ortusApiDataQueue.
   * We check the queue first (data may have arrived before we loaded). */

  /* DOM attribute check handles page 1 data. Events handle page 2+. */
  console.log('[Ortus] Content script listening for interceptor events (apiEnrichCache ready)');

  /* Exact total from API — overrides the rounded "2K+" from the page */
  var exactTotalResults = 0;

  var SELECTORS = {
    resultItem: [
      'li.artdeco-list__item',
      'li[class*="search-results__result-item"]',
      'ol > li[class*="artdeco"]',
      'li[data-scroll-into-view]'
    ],
    profileName: [
      '[data-anonymize="person-name"]',
      'a[data-control-name="view_lead_panel_via_search_lead_name"] span',
      '.artdeco-entity-lockup__title a span',
      '.result-lockup__name a span',
      'a[href*="/sales/lead/"] span',
      '.artdeco-entity-lockup__title span'
    ],
    profileLink: [
      'a[data-control-name="view_lead_panel_via_search_lead_name"]',
      '.artdeco-entity-lockup__title a',
      'a[href*="/sales/lead/"]',
      'a[href*="/sales/people/"]'
    ],
    jobTitle: [
      '[data-anonymize="title"]',
      '.artdeco-entity-lockup__subtitle span',
      '.result-lockup__highlight-keyword span',
      '[class*="body-text"] span'
    ],
    companyName: [
      '[data-anonymize="company-name"]',
      'a[data-control-name="view_lead_panel_via_search_lead_company_name"]',
      '.artdeco-entity-lockup__caption a',
      'a[href*="/sales/company/"]'
    ],
    location: [
      '[data-anonymize="location"]',
      '.artdeco-entity-lockup__caption span',
      '.result-lockup__misc-item'
    ],
    connectionDegree: [
      '.artdeco-entity-lockup__degree',
      '[class*="degree-icon"]',
      'span[class*="degree"]'
    ],
    totalResults: [
      '.search-results__total-results',
      'div.t-14.flex.align-items-center',
      'h2[class*="search-results"]',
      '[class*="total-results"]',
      '.artdeco-typography--body-small'
    ],
    nextButton: [
      'button[aria-label="Next"]',
      'button.artdeco-pagination__button--next',
      '[class*="pagination__button--next"]',
      'button[aria-label="Next\u2026"]',
      '.artdeco-pagination button:last-child',
      'li.artdeco-pagination__indicator:last-child + li button',
      'button[class*="pagination"][class*="next"]'
    ],
    currentPage: [
      'button.artdeco-pagination__indicator--number.active',
      'li.artdeco-pagination__indicator--number.active button',
      'li.artdeco-pagination__indicator--number.selected button'
    ]
  };

  function qs(parent, sels) {
    var list = typeof sels === 'string' ? [sels] : sels;
    for (var i = 0; i < list.length; i++) {
      try { var el = parent.querySelector(list[i]); if (el) return el; } catch(e) {}
    }
    return null;
  }

  function qsAll(parent, sels) {
    var list = typeof sels === 'string' ? [sels] : sels;
    for (var i = 0; i < list.length; i++) {
      try { var els = parent.querySelectorAll(list[i]); if (els.length > 0) return Array.from(els); } catch(e) {}
    }
    return [];
  }

  function getText(el) {
    if (!el) return '';
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  /* Wait for DOM mutations to settle — resolves when no changes for settleMs, max maxWait */
  function waitForDomSettle(settleMs, maxWait) {
    settleMs = settleMs || 1000;
    maxWait = maxWait || 8000;
    return new Promise(function(resolve) {
      var target = document.querySelector('main') || document.body;
      var timer;
      var observer = new MutationObserver(function() {
        clearTimeout(timer);
        timer = setTimeout(function() { observer.disconnect(); resolve(); }, settleMs);
      });
      observer.observe(target, { childList: true, subtree: true, characterData: true });
      timer = setTimeout(function() { observer.disconnect(); resolve(); }, settleMs);
      setTimeout(function() { observer.disconnect(); resolve(); }, maxWait);
    });
  }

  function normalizeUrl(url) {
    if (!url) return '';
    try { var u = new URL(url); return u.origin + u.pathname.replace(/\/+$/, ''); }
    catch(e) { return url; }
  }

  function getPageInfo() {
    var totalResults = 0;

    /* Method 1: Scan visible text for "X results" or "2.5K+ results" */
    var cands = document.querySelectorAll('h1, h2, h3, span, div');
    for (var i = 0; i < Math.min(cands.length, 500); i++) {
      if (cands[i].children.length > 5) continue;
      var t = getText(cands[i]);
      if (t.length > 60 || t.length < 3) continue;
      /* Match "2.5K+ results" or "10K+ results" */
      var km = t.match(/([\d.]+)\s*K\+?\s*results?/i);
      if (km) { totalResults = Math.round(parseFloat(km[1]) * 1000); break; }
      /* Match "2,500 results" or "77 results" */
      var nm = t.match(/([\d,]+)\s+results?\b/i);
      if (nm) { totalResults = parseInt(nm[1].replace(/,/g, ''), 10); break; }
    }

    /* Method 2: Old selectors as fallback */
    if (!totalResults) {
      var el = qs(document, SELECTORS.totalResults);
      if (el) {
        var et = getText(el);
        var km2 = et.match(/([\d.]+)\s*K\+?/i);
        if (km2) totalResults = Math.round(parseFloat(km2[1]) * 1000);
        else { var m = et.match(/([\d,]+)/); if (m) totalResults = parseInt(m[1].replace(/,/g, ''), 10); }
      }
    }

    var currentPage = 1;
    var pageEl = qs(document, SELECTORS.currentPage);
    if (pageEl) { var n = parseInt(getText(pageEl), 10); if (!isNaN(n)) currentPage = n; }
    var pp = parseInt(new URLSearchParams(window.location.search).get('page'), 10);
    if (!isNaN(pp) && pp > 0) currentPage = pp;

    var perPage = 25;
    var totalPages = totalResults > 0 ? Math.ceil(totalResults / perPage) : 0;
    var nextBtn = qs(document, SELECTORS.nextButton);
    var hasNext = nextBtn ? !nextBtn.disabled : false;
    /* Override with exact total from API if available (fixes "2K+" → exact number) */
    if (exactTotalResults > 0 && (exactTotalResults > totalResults || totalResults === 0)) {
      console.log('[Ortus] getPageInfo: using exact API total ' + exactTotalResults + ' instead of DOM total ' + totalResults);
      totalResults = exactTotalResults;
      totalPages = Math.ceil(totalResults / perPage);
    }

    /* Fallback: check if we are not on the last page based on total */
    if (!hasNext && totalResults > 0 && currentPage > 0) {
      var calcPages = Math.ceil(totalResults / perPage);
      if (currentPage < calcPages) {
        hasNext = true;
        console.log('[Ortus] hasNext override: page ' + currentPage + ' of ' + calcPages);
      }
    }

    console.log('[Ortus] getPageInfo: totalResults=' + totalResults + (exactTotalResults > 0 ? ' (exact)' : ' (DOM)') + ', page=' + currentPage + ', hasNext=' + hasNext);
    return {
      totalResults: totalResults, currentPage: currentPage,
      totalPages: totalPages, hasNextPage: hasNext,
      resultsPerPage: perPage, url: window.location.href
    };
  }

  /* Extract LinkedIn Membership ID */
  function extractMemberId(card, profileUrl) {
    /* Method 1: DOM attributes - look for URN with numeric ID */
    var els = card.querySelectorAll('*');
    for (var i = 0; i < Math.min(els.length, 80); i++) {
      for (var a = 0; a < els[i].attributes.length; a++) {
        var v = els[i].attributes[a].value;
        if (!v || v.length < 10) continue;
        /* Pattern: (ACwXXXX,NUMERIC_ID) in URN */
        var cm = v.match(/\(([^,]+),(\d{5,10})\)/);
        if (cm) return cm[2];
        /* Pattern: urn:li:member:NUMERIC */
        var um = v.match(/urn:li:(?:member|fsd_profile):(\d{5,10})/);
        if (um) return um[1];
      }
    }
    /* Method 2: Decode from Sales Nav URL - skip 4-byte prefix */
    if (profileUrl) {
      var pm = profileUrl.match(/\/sales\/(?:lead|people)\/([A-Za-z0-9_-]+)/);
      if (pm) {
        try {
          var b = pm[1].replace(/-/g, '+').replace(/_/g, '/');
          while (b.length % 4) b += '=';
          var raw = atob(b);
          var offsets = [4, 2, 3, 5];
          for (var oi = 0; oi < offsets.length; oi++) {
            var o = offsets[oi];
            if (o + 4 > raw.length) continue;
            var id = ((raw.charCodeAt(o)&0xFF)<<24)|((raw.charCodeAt(o+1)&0xFF)<<16)|((raw.charCodeAt(o+2)&0xFF)<<8)|(raw.charCodeAt(o+3)&0xFF);
            id = id >>> 0;
            if (id >= 100000 && id <= 2000000000) return String(id);
          }
        } catch(e) {}
      }
    }
    return '';
  }

  function extractOneProfile(card) {
    var nameEl = qs(card, SELECTORS.profileName);
    var name = getText(nameEl);

    var profileUrl = '';
    var linkEl = qs(card, SELECTORS.profileLink);
    if (linkEl) {
      profileUrl = linkEl.href || linkEl.getAttribute('href') || '';
      if (profileUrl && profileUrl.charAt(0) === '/') profileUrl = 'https://www.linkedin.com' + profileUrl;
      profileUrl = normalizeUrl(profileUrl);
    }

    var connectionDegree = '';
    var degreeEl = qs(card, SELECTORS.connectionDegree);
    if (degreeEl) { var dt = getText(degreeEl); var dm = dt.match(/(\d+)/); connectionDegree = dm ? dm[1] : dt; }

    var fullText = getText(card);
    var timeInRole = '';
    var tm = fullText.match(/(\d+\+?\s*(?:year|yr|month|mo)s?\s*(?:in\s*(?:current\s*)?role)?)/i);
    if (tm) timeInRole = tm[1].trim();

    var mid = extractMemberId(card, profileUrl);
    var nameParts = name.trim().split(/\s+/);
    var firstName = nameParts[0] || '';
    var lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
    var isOpen = false; /* Will be set by API fetch in scrollAndExtractAll */
    return {
      name: name,
      firstName: firstName,
      lastName: lastName,
      jobTitle: getText(qs(card, SELECTORS.jobTitle)),
      company: getText(qs(card, SELECTORS.companyName)),
      location: qs(card, SELECTORS.location) ? getText(qs(card, SELECTORS.location)).replace(/^[\s|]+/, '').replace(/[\s|]+$/, '') : '',
      connectionDegree: connectionDegree,
      timeInRole: timeInRole,
      profileUrl: profileUrl,
      membershipId: mid,
      linkedinEmail: mid ? mid + '@linkedinmembership.id' : '',
      publicUrl: profileUrl ? profileUrl.replace('https://www.linkedin.com/sales/people/','https://www.linkedin.com/in/').replace('https://www.linkedin.com/sales/lead/','https://www.linkedin.com/in/').split(',')[0] : '',
      openProfile: isOpen ? 'Yes' : 'No',
      premium: 'Unknown', /* v4.0: Will be set by API enrichment */
      scrapedAt: new Date().toISOString()
    };
  }

  /* v4.0.7: Data comes from XHR interceptor (interceptor.js).
   * LinkedIn uses XMLHttpRequest, not fetch. The interceptor patches XHR
   * and sends data via CustomEvent. This function just reads the cache. */
  async function fetchOpenLinkMap(cacheSizeBefore, expectedCount) {
    var cacheSize = Object.keys(apiEnrichCache).length;
    var needsPoll = (cacheSize === 0) || (typeof cacheSizeBefore === 'number' && cacheSize <= cacheSizeBefore);

    if (cacheSize > 0 && !needsPoll) {
      var oc = 0; var pc = 0;
      for (var k in apiEnrichCache) { if (apiEnrichCache[k].openLink) oc++; if (apiEnrichCache[k].premium) pc++; }
      console.log('[Ortus] Enrichment cache: ' + cacheSize + ' profiles (' + oc + ' open, ' + pc + ' premium)');
    }

    if (cacheSize === 0) {
      /* Check DOM attribute first (shared between MAIN and ISOLATED worlds — works for page 1) */
      var domData = document.documentElement.getAttribute('data-ortus-api');
      if (domData) {
        try {
          var parsed = JSON.parse(domData);
          if (parsed.elements) {
            for (var di = 0; di < parsed.elements.length; di++) {
              var de = parsed.elements[di];
              if (de.memberId) { apiEnrichCache[de.memberId] = de; openLinkCache[de.memberId] = de.openLink; }
            }
            if (parsed.total) exactTotalResults = parsed.total;
            console.log('[Ortus] Enrichment loaded from DOM attribute: ' + Object.keys(apiEnrichCache).length + ' profiles');
            needsPoll = false;
          }
        } catch(e) {}
      }
    }

    if (needsPoll) {
      /* Poll until cache covers the expected result count (not just "grew at all").
       * Previous logic exited on first growth, leaving later pages as Unknown. */
      var pollCount = SLOW_MODE ? 20 : 30;
      var pollMs = SLOW_MODE ? 500 : 500;
      var target = (typeof expectedCount === 'number' && expectedCount > 0) ? expectedCount : 0;
      var reason = cacheSize === 0 ? 'empty cache' : 'waiting for full coverage (cache=' + cacheSize + ', before=' + cacheSizeBefore + ', target=' + target + ')';
      console.log('[Ortus] Enrichment poll: ' + reason + ' (' + (pollCount * pollMs / 1000) + 's max, slow=' + SLOW_MODE + ')...');
      var lastSize = cacheSize;
      var stagnantTicks = 0;
      for (var w = 0; w < pollCount; w++) {
        await sleep(pollMs);
        /* Check DOM attribute each poll tick (shared across MAIN/ISOLATED worlds) */
        try {
          var domData = document.documentElement.getAttribute('data-ortus-api');
          if (domData) {
            var parsed = JSON.parse(domData);
            if (parsed.elements) {
              for (var di = 0; di < parsed.elements.length; di++) {
                var de = parsed.elements[di];
                if (de.memberId && !apiEnrichCache.hasOwnProperty(de.memberId)) {
                  apiEnrichCache[de.memberId] = de;
                  openLinkCache[de.memberId] = de.openLink;
                }
              }
              if (parsed.total) exactTotalResults = parsed.total;
            }
          }
        } catch(e) {}
        var nowSize = Object.keys(apiEnrichCache).length;
        if (target > 0 && nowSize >= target) {
          var oc2 = 0; var pc2 = 0;
          for (var k2 in apiEnrichCache) { if (apiEnrichCache[k2].openLink) oc2++; if (apiEnrichCache[k2].premium) pc2++; }
          console.log('[Ortus] Enrichment cache reached target ' + nowSize + '/' + target + ' after ' + ((w+1)*pollMs) + 'ms (' + oc2 + ' open, ' + pc2 + ' premium)');
          break;
        }
        if (nowSize > lastSize) { lastSize = nowSize; stagnantTicks = 0; }
        else if (nowSize > cacheSizeBefore) {
          stagnantTicks++;
          /* If we have some data and it's been stagnant for ~3s, accept what we have */
          if (stagnantTicks * pollMs >= 3000) {
            console.log('[Ortus] Enrichment cache stagnant at ' + nowSize + '/' + (target || '?') + ' after ' + ((w+1)*pollMs) + 'ms — accepting partial');
            break;
          }
        }
      }
      if (Object.keys(apiEnrichCache).length <= cacheSizeBefore) {
        console.log('[Ortus] Enrichment cache did not grow after ' + (pollCount * pollMs / 1000) + 's wait (still ' + Object.keys(apiEnrichCache).length + ')');
      }
    }
    return openLinkCache;
  }

  /* Harvest all currently visible profile cards */
  function harvestVisible() {
    var found = [];
    var urls = new Set();

    var items = qsAll(document, SELECTORS.resultItem);
    for (var i = 0; i < items.length; i++) {
      var p = extractOneProfile(items[i]);
      if (p.name && p.profileUrl && !urls.has(p.profileUrl)) {
        urls.add(p.profileUrl);
        found.push(p);
      }
    }

    /* Fallback: look for profile links NOT caught by resultItem selectors,
     * but ONLY within the main search results container (not sidebar/recommendations) */
    var resultsContainer = document.querySelector('.search-results__result-list')
      || document.querySelector('ol.artdeco-list')
      || document.querySelector('[class*="search-results"] ol')
      || document.querySelector('[class*="search-results"] ul');
    var searchScope = resultsContainer || document;
    var links = searchScope.querySelectorAll('a[href*="/sales/lead/"], a[href*="/sales/people/"]');
    for (var j = 0; j < links.length; j++) {
      var href = normalizeUrl(links[j].href || '');
      if (!href || urls.has(href)) continue;
      var card = links[j];
      for (var k = 0; k < 10; k++) { if (!card.parentElement) break; card = card.parentElement; if (card.tagName === 'LI') break; }
      var ln = getText(links[j]);
      if (!ln || ln.length > 120) continue;
      var p2 = extractOneProfile(card);
      if (!p2.name) p2.name = ln;
      if (!p2.profileUrl) p2.profileUrl = href;
      if (p2.name && !urls.has(p2.profileUrl)) { urls.add(p2.profileUrl); found.push(p2); }
    }

    return found;
  }

  /* Get all visible LI items (the actual DOM nodes) */
  function getVisibleItems() {
    return qsAll(document, SELECTORS.resultItem);
  }

  /* ── MAIN: scrollIntoView approach ── */

  async function scrollAndExtractAll() {
    var allProfiles = new Map();
    var seenMemberIds = new Set(); /* Dual dedup: URL + membershipId */

    function addProfile(p) {
      /* Validate: skip placeholder cards with no real data */
      if (!p.name || p.name.length < 2) return false;
      if (!p.profileUrl) return false;
      /* Skip if already seen by URL or membershipId */
      var key = p.profileUrl;
      if (allProfiles.has(key)) return false;
      if (p.membershipId && seenMemberIds.has(p.membershipId)) return false;
      allProfiles.set(key, p);
      if (p.membershipId) seenMemberIds.add(p.membershipId);
      return true;
    }

    /* Wait for result items to actually appear in the DOM before harvesting.
     * This is critical: after page load/reload, LinkedIn's SPA may take 5-15s
     * to render search results. Polling with MutationObserver is far more reliable
     * than any fixed timeout. */
    /* Wait for POPULATED result items — not just empty placeholder <li> shells.
     * LinkedIn renders empty list items first, then fills in names/links lazily.
     * We poll for profile links with actual text content (length > 1). */
    console.log('[Ortus] Waiting for populated result items in DOM...');
    var waitStart = Date.now();
    var maxContentWait = 20000; /* 20s max — covers slow filter-heavy searches */
    while (Date.now() - waitStart < maxContentWait) {
      /* Check for profile links that have actual text (not empty placeholders) */
      var probeLinks = document.querySelectorAll('a[href*="/sales/lead/"], a[href*="/sales/people/"]');
      var populated = 0;
      for (var pi2 = 0; pi2 < probeLinks.length; pi2++) {
        if ((probeLinks[pi2].textContent || '').trim().length > 1) populated++;
      }
      /* Also check name spans */
      var probeNames = document.querySelectorAll('[data-anonymize="person-name"]');
      for (var pn = 0; pn < probeNames.length; pn++) {
        if ((probeNames[pn].textContent || '').trim().length > 1) populated++;
      }
      if (populated >= 3) {
        console.log('[Ortus] Found ' + populated + ' populated items after ' + (Date.now() - waitStart) + 'ms');
        break;
      }
      await sleep(500);
    }
    if (Date.now() - waitStart >= maxContentWait) {
      console.log('[Ortus] WARNING: Timed out waiting for populated items after ' + maxContentWait + 'ms');
    }
    /* Brief settle — waitForResults already confirmed populated items exist */
    await waitForDomSettle(sd(600,1500), sd(2000,3000));

    /* Harvest initial */
    var initial = harvestVisible();
    var added = 0;
    for (var i = 0; i < initial.length; i++) { if (addProfile(initial[i])) added++; }
    console.log('[Ortus] Initial harvest: ' + added + ' profiles (of ' + initial.length + ' candidates, waited ' + (Date.now() - waitStart) + 'ms)');

    /* Get expected total from page info */
    var pageInfo = getPageInfo();
    var expectedTotal = Math.min(pageInfo.resultsPerPage, pageInfo.totalResults || 25);
    console.log('[Ortus] Expecting up to ' + expectedTotal + ' profiles on this page');

    /* v2 FAST PATH: At 25% zoom, all 25 profiles are usually visible without scrolling.
     * If initial harvest already got enough, skip the scroll loop entirely. */
    if (allProfiles.size >= expectedTotal) {
      console.log('[Ortus] FAST PATH: Initial harvest got ' + allProfiles.size + '/' + expectedTotal + ', skipping scroll loop');
    } else {
      console.log('[Ortus] Initial harvest short (' + allProfiles.size + '/' + expectedTotal + '), entering scroll loop');
    }

    /* Scroll loop: only runs if initial harvest was short.
     * v2 OPTIMIZATION: shorter waits, fewer stable checks, instant break at 25. */
    var attempt = 0;
    if (allProfiles.size < expectedTotal) {
      var stableCount = 0;
      var maxStable = sd(3, 4);
      var maxAttempts = sd(40, 50);

      while (attempt < maxAttempts && stableCount < maxStable) {
        attempt++;
        var prevSize = allProfiles.size;

        /* Find all visible LI items and scroll the LAST one into view */
        var items = getVisibleItems();
        if (items.length > 0) {
          var lastItem = items[items.length - 1];
          lastItem.scrollIntoView({ behavior: 'smooth', block: 'center' });

          var evt = new Event('scroll', { bubbles: true });
          lastItem.dispatchEvent(evt);
          document.dispatchEvent(evt);
          window.dispatchEvent(evt);
        }

        /* Also try incremental scroll-by as fallback (triggers lazy loaders) */
        if (stableCount >= 2) {
          window.scrollBy(0, 800);
        }

        /* v2: Faster waits — DOM settle on first 2 attempts only, then short sleep */
        if (attempt <= 2) {
          await waitForDomSettle(sd(500,1000), sd(2000,2500));
        } else {
          await sleep(sd(500,1000));
        }

        /* Harvest again */
        var batch = harvestVisible();
        var batchAdded = 0;
        for (var b = 0; b < batch.length; b++) { if (addProfile(batch[b])) batchAdded++; }

        if (allProfiles.size > prevSize) {
          console.log('[Ortus] Attempt #' + attempt + ': +' + batchAdded + ' -> ' + allProfiles.size + ' total');
          stableCount = 0;
        } else {
          stableCount++;
        }

        /* If we have reached or exceeded expected, we can stop early */
        if (allProfiles.size >= expectedTotal) {
          console.log('[Ortus] Reached expected count (' + expectedTotal + '). Stopping.');
          break;
        }
      }

      /* Final attempt: scroll ALL the way down using keyboard End key simulation */
      if (allProfiles.size < expectedTotal) {
        console.log('[Ortus] Trying keyboard End key for final sweep...');
        document.activeElement && document.activeElement.blur();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', code: 'End', bubbles: true }));
        await waitForDomSettle(600, 2000);

        var finalBatch = harvestVisible();
        for (var f = 0; f < finalBatch.length; f++) { addProfile(finalBatch[f]); }
      }

      /* Extra sweep: if still short, try scrolling page by page (800px increments) */
      if (allProfiles.size < expectedTotal && allProfiles.size > 0) {
        console.log('[Ortus] Short by ' + (expectedTotal - allProfiles.size) + ', trying page-scroll sweep...');
        window.scrollTo(0, 0);
        await sleep(300);
        var docHeight = document.body.scrollHeight;
        for (var scrollY = 0; scrollY < docHeight; scrollY += 600) {
          window.scrollTo(0, scrollY);
          await sleep(250);
          var sweepBatch = harvestVisible();
          for (var s = 0; s < sweepBatch.length; s++) { addProfile(sweepBatch[s]); }
          if (allProfiles.size >= expectedTotal) break;
        }
        console.log('[Ortus] After page-scroll sweep: ' + allProfiles.size + ' profiles');
      }
    }

    /* Scroll to bottom to make pagination visible */
    var paginationEl = document.querySelector('.artdeco-pagination')
      || document.querySelector('[class*="pagination"]')
      || document.querySelector('button[aria-label="Next"]');
    if (paginationEl) {
      paginationEl.scrollIntoView({ block: 'center' });
      console.log('[Ortus] Scrolled to pagination');
    } else {
      window.scrollTo(0, document.body.scrollHeight);
      console.log('[Ortus] Scrolled to bottom (no pagination el found)');
    }
    await sleep(sd(500,1500));

    var result = Array.from(allProfiles.values());

    /* v4.0: Apply API enrichment data — openLink, premium, and fill missing company/title */
    try {
      var cacheSizeBefore = Object.keys(apiEnrichCache).length;
      await sleep(sd(500,3000));
      var olMap = await fetchOpenLinkMap(cacheSizeBefore, result.length);
      var enrichSize = Object.keys(apiEnrichCache).length;
      if (enrichSize > 0) {
        var matched = 0; var companyFills = 0; var titleFills = 0; var nameFallbacks = 0;
        for (var oi = 0; oi < result.length; oi++) {
          var mid = result[oi].membershipId;
          if (mid && apiEnrichCache.hasOwnProperty(mid)) {
            var enrich = apiEnrichCache[mid];
            result[oi].openProfile = enrich.openLink ? 'Yes' : 'No';
            result[oi].premium = enrich.premium ? 'Yes' : 'No';
            /* Fill missing company from API */
            if ((!result[oi].company || result[oi].company.length < 2) && enrich.company) {
              result[oi].company = enrich.company;
              companyFills++;
            }
            /* Fill missing title from API */
            if ((!result[oi].jobTitle || result[oi].jobTitle.length < 2) && enrich.title) {
              result[oi].jobTitle = enrich.title;
              titleFills++;
            }
            matched++;
          } else {
            /* Fallback: match by name+company against unmatched API entries */
            var nameMatch = null;
            var profileName = (result[oi].name || '').trim().toLowerCase();
            if (profileName) {
              for (var nk in apiEnrichCache) {
                var candidate = apiEnrichCache[nk];
                var apiName = (candidate.fullName || '').trim().toLowerCase();
                if (apiName && apiName === profileName) {
                  /* Verify company matches too if both have one */
                  var profileCo = (result[oi].company || '').trim().toLowerCase();
                  var apiCo = (candidate.company || '').trim().toLowerCase();
                  if (!profileCo || !apiCo || profileCo.indexOf(apiCo) !== -1 || apiCo.indexOf(profileCo) !== -1) {
                    nameMatch = candidate;
                    break;
                  }
                }
              }
            }
            if (nameMatch) {
              result[oi].openProfile = nameMatch.openLink ? 'Yes' : 'No';
              result[oi].premium = nameMatch.premium ? 'Yes' : 'No';
              result[oi].idUnverified = '?';
              if ((!result[oi].company || result[oi].company.length < 2) && nameMatch.company) {
                result[oi].company = nameMatch.company;
                companyFills++;
              }
              if ((!result[oi].jobTitle || result[oi].jobTitle.length < 2) && nameMatch.title) {
                result[oi].jobTitle = nameMatch.title;
                titleFills++;
              }
              matched++;
              nameFallbacks++;
            } else {
              result[oi].premium = 'Unknown';
            }
          }
        }
        console.log('[Ortus] Enrichment applied: ' + matched + '/' + result.length + ' matched (' + nameFallbacks + ' by name), ' + companyFills + ' company fills, ' + titleFills + ' title fills (cache: ' + enrichSize + ')');
      } else {
        console.log('[Ortus] Enrichment: empty cache, no API data applied');
        for (var ui = 0; ui < result.length; ui++) result[ui].premium = 'Unknown';
      }
    } catch(e) { console.log('[Ortus] Enrichment apply error:', e.message); }

    console.log('[Ortus] DONE: ' + result.length + ' unique profiles from ' + attempt + ' scroll attempts (expected ' + expectedTotal + ')');
    return result;
  }

  /* ── Empty State Detection ── */

  function detectEmptyState() {
    var body = document.body ? (document.body.textContent || '') : '';
    if (body.indexOf('Apply filters to find leads') !== -1) {
      return { emptyState: true, message: 'Apply filters to find leads' };
    }
    if (body.indexOf('No leads match') !== -1 || body.indexOf('No results found') !== -1) {
      return { emptyState: true, message: 'No leads matched' };
    }
    return { emptyState: false };
  }

  /* ── Filter Nudge: wake up LinkedIn's SPA search engine ── */

  async function nudgeFilters() {
    console.log('[Ortus] Nudging: will exclude a filter, wait, then include it back...');

    /* Find a removable active filter — these are pills/tags with close (X) buttons.
     * In Sales Nav, active filters show as removable chips near the top or in the sidebar. */
    var closeBtn = null;
    var closeSelectors = [
      /* Filter pill close buttons */
      'button[aria-label*="Remove"]',
      'button[aria-label*="remove"]',
      'button[aria-label*="Clear"]',
      'button[data-test-id*="remove"]',
      /* X icons inside filter tags */
      '[class*="filter-value"] button',
      '[class*="filter-tag"] button',
      '[class*="artdeco-pill"] button[class*="close"]',
      '[class*="artdeco-pill"] button[aria-label]',
      /* Generic close icons inside filter areas */
      '[class*="search-filter"] button[class*="close"]',
      '[class*="facet"] button[class*="remove"]'
    ];

    for (var si = 0; si < closeSelectors.length; si++) {
      try {
        var els = document.querySelectorAll(closeSelectors[si]);
        if (els.length > 0) {
          closeBtn = els[0];
          console.log('[Ortus] Found filter remove button via: ' + closeSelectors[si] + ' ("' + (closeBtn.getAttribute('aria-label') || closeBtn.textContent || '').trim().substring(0, 40) + '")');
          break;
        }
      } catch(e) {}
    }

    if (closeBtn) {
      /* Step 1: Remove the filter (click X) */
      console.log('[Ortus] Clicking filter remove button...');
      closeBtn.click();
      await sleep(2000);

      /* Step 2: Browser back to restore all filters */
      console.log('[Ortus] Going back to restore filters...');
      window.history.back();
      await sleep(3000);

      var es = detectEmptyState();
      if (!es.emptyState) {
        console.log('[Ortus] Filter nudge worked (remove + back)');
        return true;
      }
      console.log('[Ortus] Still empty after remove+back, waiting longer...');
      await sleep(3000);
      if (!detectEmptyState().emptyState) {
        console.log('[Ortus] Filter nudge worked after extra wait');
        return true;
      }
    } else {
      console.log('[Ortus] No removable filter button found');
    }

    /* Reset interceptor dedup so it can re-capture page 1 data after nudge */
    try { window.dispatchEvent(new CustomEvent('__ortus_reset_interceptor')); } catch(e) {}
    /* Also clear DOM attribute that may have stale data */
    try { document.documentElement.removeAttribute('data-ortus-api'); } catch(e) {}

    /* Fallback: try toggling a boolean filter switch on/off */
    var toggles = document.querySelectorAll('input[type="checkbox"], [role="switch"], [role="checkbox"]');
    for (var ti = 0; ti < Math.min(toggles.length, 3); ti++) {
      try {
        var tog = toggles[ti];
        console.log('[Ortus] Trying toggle #' + ti + '...');
        tog.click();
        await sleep(2000);
        tog.click();
        await sleep(3000);
        if (!detectEmptyState().emptyState) {
          console.log('[Ortus] Toggle nudge worked via toggle #' + ti);
          return true;
        }
      } catch(e) {}
    }

    console.log('[Ortus] All nudge strategies failed');
    return false;
  }

  /* ── Navigation ── */

  function clickNextPage() {
    /* First scroll pagination into view */
    var pagArea = document.querySelector('.artdeco-pagination') || document.querySelector('[class*="pagination"]');
    if (pagArea) pagArea.scrollIntoView({ block: 'center' });

    /* Try direct selector */
    var btn = qs(document, SELECTORS.nextButton);
    if (btn && !btn.disabled) { console.log('[Ortus] Clicking Next button'); btn.click(); return true; }

    /* Fallback: find all pagination buttons, click the last enabled one */
    var allBtns = document.querySelectorAll('.artdeco-pagination button, [class*="pagination"] button');
    for (var i = allBtns.length - 1; i >= 0; i--) {
      var b = allBtns[i];
      if (!b.disabled && b.getAttribute('aria-label') && b.getAttribute('aria-label').toLowerCase().indexOf('next') >= 0) {
        console.log('[Ortus] Clicking fallback Next button'); b.click(); return true;
      }
    }
    /* Last resort: find the right-arrow / chevron button */
    for (var j = allBtns.length - 1; j >= 0; j--) {
      if (!allBtns[j].disabled && allBtns[j].querySelector('svg, [class*="chevron"], [class*="arrow"]')) {
        console.log('[Ortus] Clicking chevron Next button'); allBtns[j].click(); return true;
      }
    }
    console.log('[Ortus] No Next button found!');
    return false;
  }

  function navigateToPage(pageNum, baseUrl) {
    /* Canonical-URL discipline: prefer baseUrl (job.salesNavUrl) over the live URL.
     * The live URL can be a stripped/redirected variant (LinkedIn SPA can drop filters
     * mid-session); navigating from it would propagate the wipe across every subsequent page. */
    var src = baseUrl || window.location.href;
    if (!baseUrl) console.log('[Ortus] navigateToPage: no canonical baseUrl — falling back to live URL');
    var url = new URL(src);
    url.searchParams.set('page', pageNum);
    window.location.href = url.toString();
  }

  /* ── Message Handler ── */

  /* v1.2 — Anti-throttle layered defense:
   *   (1) Web Audio oscillator at gain=0 — actively generates audio samples,
   *       harder for macOS App Nap to dismiss as "no audio activity" than a
   *       silent dataURI <audio> element.
   *   (2) MediaSession metadata — declares active media playback to the OS,
   *       which gets stronger anti-throttle treatment than plain <audio>.
   *   (3) Fallback <audio> element (for browsers where AudioContext is blocked). */
  function __ortusStartSilentAudio() {
    if (window.__ortusSilentAudio) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        var ac = new Ctx();
        var osc = ac.createOscillator();
        var gain = ac.createGain();
        gain.gain.value = 0; /* silent — no perceptible output */
        osc.frequency.value = 440;
        osc.connect(gain);
        gain.connect(ac.destination);
        osc.start();
        if (ac.state === 'suspended') {
          ac.resume().catch(function(e) { console.log('[Ortus] AudioContext resume blocked:', e.message); });
        }
        window.__ortusSilentAudio = { ctx: ac, osc: osc, gain: gain };
        console.log('[Ortus] Web Audio oscillator started (anti-throttle layer 1)');
      } else {
        var audio = document.createElement('audio');
        audio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
        audio.loop = true; audio.volume = 0; audio.style.display = 'none';
        document.documentElement.appendChild(audio);
        var p = audio.play();
        if (p && p.catch) p.catch(function(e) { console.log('[Ortus] Silent audio autoplay blocked:', e.message); });
        window.__ortusSilentAudio = audio;
        console.log('[Ortus] dataURI silent audio fallback started');
      }
    } catch(e) { console.log('[Ortus] Silent audio failed:', e.message); }

    /* MediaSession declaration — separate try/catch so failure doesn't block audio setup */
    try {
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: 'Sales Nav Batch Scraper',
          artist: 'Ortus',
          album: 'Anti-throttle keepalive'
        });
        navigator.mediaSession.playbackState = 'playing';
        console.log('[Ortus] MediaSession declared (anti-throttle layer 2)');
      }
    } catch(e) { console.log('[Ortus] MediaSession failed:', e.message); }
  }

  chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
    __ortusStartSilentAudio(); /* idempotent; first scrape-related message triggers it */
    console.log('[Ortus] Received:', msg.action);

    switch (msg.action) {
      case 'ping':
        sendResponse({ ok: true, url: window.location.href });
        break;
      case 'getPageInfo':
        sendResponse(getPageInfo());
        break;
      case 'waitForResults':
        /* Poll until result items with ACTUAL DATA appear in DOM.
         * LinkedIn renders empty placeholder <li> items first, then lazily populates
         * the text/links. We must wait for populated items, not just empty shells. */
        (function() {
          var timeout = msg.timeout || 20000;
          var start = Date.now();
          function check() {
            /* Count items that have REAL profile data (name link populated) */
            var profileLinks = document.querySelectorAll('a[href*="/sales/lead/"], a[href*="/sales/people/"]');
            var populatedLinks = 0;
            for (var pl = 0; pl < profileLinks.length; pl++) {
              var txt = (profileLinks[pl].textContent || '').trim();
              if (txt.length > 1) populatedLinks++;
            }
            /* Also check for populated name spans */
            var nameSpans = document.querySelectorAll('[data-anonymize="person-name"]');
            var populatedNames = 0;
            for (var ns = 0; ns < nameSpans.length; ns++) {
              var nt = (nameSpans[ns].textContent || '').trim();
              if (nt.length > 1) populatedNames++;
            }
            var bestCount = Math.max(populatedLinks, populatedNames);
            if (bestCount >= 3) {
              console.log('[Ortus] waitForResults: ' + bestCount + ' populated items (links=' + populatedLinks + ', names=' + populatedNames + ') after ' + (Date.now() - start) + 'ms');
              sendResponse({ ready: true, items: bestCount, links: populatedLinks, names: populatedNames, waited: Date.now() - start });
            } else if (bestCount < 3 && Date.now() - start > 5000) {
              var es = detectEmptyState();
              if (es.emptyState) {
                console.log('[Ortus] waitForResults: empty state detected: ' + es.message + ' after ' + (Date.now() - start) + 'ms');
                sendResponse({ ready: false, emptyState: true, emptyMessage: es.message, items: bestCount, links: populatedLinks, names: populatedNames, waited: Date.now() - start });
                return;
              }
              setTimeout(check, 500);
            } else if (Date.now() - start > timeout) {
              console.log('[Ortus] waitForResults: TIMEOUT after ' + timeout + 'ms (found ' + bestCount + ' populated)');
              sendResponse({ ready: false, items: bestCount, links: populatedLinks, names: populatedNames, waited: timeout });
            } else {
              setTimeout(check, 500);
            }
          }
          check();
        })();
        return true;
      case 'setSlowMode':
        SLOW_MODE = !!msg.slow;
        console.log('[Ortus] Slow mode: ' + (SLOW_MODE ? 'ON' : 'OFF'));
        sendResponse({ ok: true });
        break;
      case 'extractProfiles':
        if (msg.slow !== undefined) SLOW_MODE = !!msg.slow;
        scrollAndExtractAll().then(function(profiles) {
          sendResponse({ profiles: profiles, pageInfo: getPageInfo() });
        });
        return true;
      case 'goToNextPage':
        sendResponse({ success: clickNextPage() });
        break;
      case 'navigateToPage':
        navigateToPage(msg.page, msg.baseUrl);
        sendResponse({ success: true });
        break;
      case 'checkEmptyState':
        sendResponse(detectEmptyState());
        break;
      case 'nudgeFilters':
        nudgeFilters().then(function(ok) {
          sendResponse({ success: ok, emptyState: detectEmptyState() });
        });
        return true;
      case 'debugSelectors':
        var debug = {};
        var keys = Object.keys(SELECTORS);
        for (var ki = 0; ki < keys.length; ki++) {
          var k = keys[ki]; debug[k] = {};
          var sels = SELECTORS[k];
          for (var si = 0; si < sels.length; si++) {
            try { debug[k][sels[si]] = document.querySelectorAll(sels[si]).length; }
            catch(e) { debug[k][sels[si]] = 'ERR'; }
          }
        }
        sendResponse(debug);
        break;
      default:
        sendResponse({ error: 'Unknown action' });
    }
  });

  console.log('[Ortus] Content script v4.0.18 Easter loaded (injection #' + window.__ortusInjectionCount + ')');
})();
