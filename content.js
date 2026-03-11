/**
 * Ortus Sales Nav Scraper - Content Script v7
 *
 * APPROACH: Instead of finding the scroll container (unreliable),
 * use scrollIntoView() on the last visible result card.
 * The browser scrolls whatever container holds it automatically.
 * Extract at every step, deduplicate by profile URL.
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

  /* ═══ openLink state — uses sessionStorage (survives SPA nav + full reload) ═══ */
  var openLinkCache = {};
  var openLinkLastFetchedUrl = '';
  var openLinkBaseUrl = '';

  function loadOpenLinkState() {
    try {
      var raw = sessionStorage.getItem('ortus_ol_state');
      if (raw) {
        var s = JSON.parse(raw);
        if (s.baseUrl) openLinkBaseUrl = s.baseUrl;
        if (s.lastUrl) openLinkLastFetchedUrl = s.lastUrl;
        if (s.cache) openLinkCache = s.cache;
        console.log('[Ortus] Restored openLink: ' + Object.keys(openLinkCache).length + ' cached, base=' + (openLinkBaseUrl ? openLinkBaseUrl.substring(0, 60) + '...' : 'none'));
      }
    } catch(e) { console.log('[Ortus] loadOpenLinkState err:', e.message); }
  }

  function saveOpenLinkState() {
    try {
      sessionStorage.setItem('ortus_ol_state', JSON.stringify({
        baseUrl: openLinkBaseUrl,
        lastUrl: openLinkLastFetchedUrl,
        cache: openLinkCache
      }));
    } catch(e) { console.log('[Ortus] saveOpenLinkState err:', e.message); }
  }

  /* Load on startup */
  loadOpenLinkState();

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
      scrapedAt: new Date().toISOString()
    };
  }

  /* Fetch openLink data directly from LinkedIn's search API */
  async function fetchOpenLinkMap() {
    try {
      var csrf = '';
      document.cookie.split(';').forEach(function(c) {
        var p = c.trim().split('=');
        if (p[0] === 'JSESSIONID') csrf = p[1].replace(/"/g, '');
      });
      if (!csrf) { console.log('[Ortus] OL FAIL: No CSRF token'); return openLinkCache; }

      /* Determine current page number for start offset */
      var pageNum = 1;
      var pp = parseInt(new URLSearchParams(window.location.search).get('page'), 10);
      if (!isNaN(pp) && pp > 0) pageNum = pp;
      var startOffset = (pageNum - 1) * 25;

      /* Step 1: Capture the base API URL (strip any start/count params) */
      var strategy = '';
      if (!openLinkBaseUrl) {
        var entries = performance.getEntriesByType('resource').map(function(r) { return r.name; });
        var searchUrls = entries.filter(function(u) { return u.indexOf('salesApiLeadSearch') !== -1; });
        if (searchUrls.length > 0) {
          /* Strip start=, count= params and trailing & to get clean base */
          var raw = searchUrls[searchUrls.length - 1];
          openLinkBaseUrl = raw.replace(/[&?]start=\d+/g, '').replace(/[&?]count=\d+/g, '');
          saveOpenLinkState();
          console.log('[Ortus] OL: saved base URL (' + openLinkBaseUrl.length + ' chars)');
        }
        /* Fallback: construct from page URL */
        if (!openLinkBaseUrl) {
          var qMatch = window.location.href.match(/[?&]query=([^&]+)/);
          if (qMatch) {
            openLinkBaseUrl = 'https://www.linkedin.com/sales-api/salesApiLeadSearch?q=searchQuery&query=' + qMatch[1];
            var params = new URLSearchParams(window.location.search);
            params.forEach(function(v, k) {
              if (k !== 'query' && k !== 'page' && k !== 'start' && k !== 'count') {
                openLinkBaseUrl += '&' + k + '=' + encodeURIComponent(v);
              }
            });
            saveOpenLinkState();
            console.log('[Ortus] OL: constructed base URL from page params');
          }
        }
      }

      if (!openLinkBaseUrl) {
        console.log('[Ortus] OL FAIL page ' + pageNum + ': could not determine base URL');
        return openLinkCache;
      }

      /* Step 2: Append start + count for THIS page */
      var sep = openLinkBaseUrl.indexOf('?') !== -1 ? '&' : '?';
      var url = openLinkBaseUrl + sep + 'start=' + startOffset + '&count=25';
      strategy = 'base+start=' + startOffset;

      /* Skip if exact same URL (same page re-harvest within one extractProfiles call) */
      if (url === openLinkLastFetchedUrl) {
        console.log('[Ortus] OL page ' + pageNum + ': same URL, returning cache (' + Object.keys(openLinkCache).length + ')');
        return openLinkCache;
      }

      console.log('[Ortus] OL page ' + pageNum + ' via ' + strategy + ' — fetching...');
      var resp = await fetch(url, {
        credentials: 'include',
        headers: { 'csrf-token': csrf, 'x-restli-protocol-version': '2.0.0' }
      });
      if (resp.status === 429) {
        console.log('[Ortus] OL page ' + pageNum + ': rate limited (429), waiting 10s...');
        await sleep(10000);
        resp = await fetch(url, { credentials: 'include', headers: { 'csrf-token': csrf, 'x-restli-protocol-version': '2.0.0' } });
        if (resp.status !== 200) { console.log('[Ortus] OL page ' + pageNum + ': still 429 after wait'); return openLinkCache; }
      }
      if (resp.status !== 200) { console.log('[Ortus] OL page ' + pageNum + ': HTTP ' + resp.status); return openLinkCache; }
      var text = await resp.text();
      /* Extract exact total count from API response */
      var totalMatch = text.match(/"total"\s*:\s*(\d+)/);
      if (totalMatch) {
        var apiTotal = parseInt(totalMatch[1], 10);
        if (apiTotal > 0 && apiTotal < 100000) {
          exactTotalResults = apiTotal;
          console.log('[Ortus] OL: exact total from API = ' + apiTotal);
        }
      }
      var newCount = 0;
      var re = /urn:li:member:(\d+)/g;
      var match;
      while ((match = re.exec(text)) !== null) {
        var memberId = match[1];
        var start = Math.max(0, match.index - 300);
        var end = Math.min(text.length, match.index + 300);
        var chunk = text.substring(start, end);
        var olMatch = chunk.match(/"openLink"\s*:\s*(true|false)/);
        if (olMatch) {
          if (!openLinkCache.hasOwnProperty(memberId)) newCount++;
          openLinkCache[memberId] = olMatch[1] === 'true';
        }
      }
      openLinkLastFetchedUrl = url;
      saveOpenLinkState();
      var openCount = 0; for (var k in openLinkCache) { if (openLinkCache[k]) openCount++; }
      console.log('[Ortus] OL page ' + pageNum + ': +' + newCount + ' new, ' + Object.keys(openLinkCache).length + ' total (' + openCount + ' open), via ' + strategy);
    } catch(e) { console.log('[Ortus] OL FAIL: ' + e.message); }
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

    var links = document.querySelectorAll('a[href*="/sales/lead/"], a[href*="/sales/people/"]');
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

    /* Harvest initial */
    var initial = harvestVisible();
    for (var i = 0; i < initial.length; i++) {
      var key = initial[i].profileUrl || initial[i].name;
      allProfiles.set(key, initial[i]);
    }
    console.log('[Ortus] Initial harvest: ' + initial.length + ' profiles');

    /* Get expected total from page info */
    var pageInfo = getPageInfo();
    var expectedTotal = Math.min(pageInfo.resultsPerPage, pageInfo.totalResults || 25);
    console.log('[Ortus] Expecting up to ' + expectedTotal + ' profiles on this page');

    /* Scroll loop: scroll last visible item into view, wait, harvest, repeat */
    var stableCount = 0;
    var maxStable = 5;
    var maxAttempts = 60;
    var attempt = 0;

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

      /* Wait for LinkedIn to render new items */
      await sleep(1000);

      /* Harvest again */
      var batch = harvestVisible();
      for (var b = 0; b < batch.length; b++) {
        var bkey = batch[b].profileUrl || batch[b].name;
        if (!allProfiles.has(bkey)) allProfiles.set(bkey, batch[b]);
      }

      if (allProfiles.size > prevSize) {
        console.log('[Ortus] Attempt #' + attempt + ': +' + (allProfiles.size - prevSize) + ' -> ' + allProfiles.size + ' total');
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
      await sleep(3000);

      var finalBatch = harvestVisible();
      for (var f = 0; f < finalBatch.length; f++) {
        var fkey = finalBatch[f].profileUrl || finalBatch[f].name;
        if (!allProfiles.has(fkey)) allProfiles.set(fkey, finalBatch[f]);
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
    await sleep(1000);

    var result = Array.from(allProfiles.values());

    /* Apply openLink data — fetch for every page, with delay to avoid rate limits */
    try {
      await sleep(1500);
      var olMap = await fetchOpenLinkMap();
      var olSize = Object.keys(olMap).length;
      if (olSize > 0) {
        var matched = 0;
        for (var oi = 0; oi < result.length; oi++) {
          var mid = result[oi].membershipId;
          if (mid && olMap.hasOwnProperty(mid)) {
            result[oi].openProfile = olMap[mid] ? 'Yes' : 'No';
            matched++;
          }
        }
        console.log('[Ortus] OL applied: ' + matched + '/' + result.length + ' matched (cache: ' + olSize + ', injection #' + (window.__ortusInjectionCount || '?') + ')');
      } else {
        console.log('[Ortus] OL: empty cache, no openLink data applied (injection #' + (window.__ortusInjectionCount || '?') + ')');
      }
    } catch(e) { console.log('[Ortus] OL apply error:', e.message); }

    console.log('[Ortus] DONE: ' + result.length + ' unique profiles from ' + attempt + ' scroll attempts (expected ' + expectedTotal + ')');
    return result;
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

  function navigateToPage(pageNum) {
    var url = new URL(window.location.href);
    url.searchParams.set('page', pageNum);
    window.location.href = url.toString();
  }

  /* ── Message Handler ── */

  chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
    console.log('[Ortus] Received:', msg.action);

    switch (msg.action) {
      case 'ping':
        sendResponse({ ok: true, url: window.location.href });
        break;
      case 'getPageInfo':
        sendResponse(getPageInfo());
        break;
      case 'extractProfiles':
        scrollAndExtractAll().then(function(profiles) {
          sendResponse({ profiles: profiles, pageInfo: getPageInfo() });
        });
        return true;
      case 'goToNextPage':
        sendResponse({ success: clickNextPage() });
        break;
      case 'navigateToPage':
        navigateToPage(msg.page);
        sendResponse({ success: true });
        break;
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

  console.log('[Ortus] Content script v7 loaded (injection #' + window.__ortusInjectionCount + ')');
})();
