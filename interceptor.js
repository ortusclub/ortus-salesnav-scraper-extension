/* Ortus v4.0.10 — Parallel fetch approach.
 * LinkedIn's XHR objects get discarded before completing.
 * When we detect salesApiLeadSearch XHR.open(), we make our OWN
 * parallel fetch() call to the same URL (proven to return 200). */
(function() {
  if (window.__ortusInterceptorInstalled) return;
  window.__ortusInterceptorInstalled = true;
  if (!window.__ortusApiDataQueue) window.__ortusApiDataQueue = [];
  var fetchedUrls = {};

  function processResponse(text) {
    try {
      var json = JSON.parse(text);
      if (json.elements && json.elements.length > 0) {
        var extracted = { elements: [], total: json.paging ? json.paging.total : 0 };
        for (var i = 0; i < json.elements.length; i++) {
          var el = json.elements[i];
          var urn = el.objectUrn || '';
          var m = urn.match(/urn:li:member:(\d+)/);
          if (!m) continue;
          extracted.elements.push({
            memberId: m[1], openLink: !!el.openLink, premium: !!el.premium,
            company: (el.currentPositions && el.currentPositions[0]) ? el.currentPositions[0].companyName || '' : '',
            title: (el.currentPositions && el.currentPositions[0]) ? el.currentPositions[0].title || '' : '',
            fullName: el.fullName || '', location: el.geoRegion || ''
          });
        }
        window.__ortusApiDataQueue.push(extracted);
        window.dispatchEvent(new CustomEvent('__ortus_api_data', { detail: JSON.stringify(extracted) }));
        /* Also store on DOM (shared between MAIN and ISOLATED worlds) for page 1 timing */
        try { document.documentElement.setAttribute('data-ortus-api', JSON.stringify(extracted)); } catch(e) {}
        var ol = extracted.elements.filter(function(e){return e.openLink;}).length;
        var pr = extracted.elements.filter(function(e){return e.premium;}).length;
        console.log('[Ortus] INTERCEPTED: ' + extracted.elements.length + ' profiles (' + ol + ' open, ' + pr + ' premium)');
      }
    } catch(err) {}
  }

  /* Get CSRF token from cookies */
  function getCsrf() {
    var match = document.cookie.match(/JSESSIONID="?([^";]+)/);
    return match ? match[1] : '';
  }

  /* When XHR.open detects salesApiLeadSearch, make our own parallel fetch */
  var _origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    var fullUrl = (url || '').toString();
    if (fullUrl.indexOf('salesApiLeadSearch') !== -1 && fullUrl.indexOf('searchQuery') !== -1) {
      /* Deduplicate — use start param as key (URL is 3000+ chars, start= differs per page) */
      var startMatch = fullUrl.match(/start=(\d+)/);
      var urlKey = startMatch ? startMatch[1] : fullUrl.length.toString();
      if (!fetchedUrls[urlKey]) {
        fetchedUrls[urlKey] = true;
        var csrf = getCsrf();
        console.log('[Ortus] Detected salesApiLeadSearch — making parallel fetch (csrf=' + (csrf ? 'yes' : 'NO') + ')');
        fetch(fullUrl, {
          credentials: 'include',
          headers: { 'csrf-token': csrf, 'x-restli-protocol-version': '2.0.0' }
        }).then(function(r) {
          console.log('[Ortus] Parallel fetch status: ' + r.status);
          if (r.ok) return r.text();
          return null;
        }).then(function(text) {
          if (text) processResponse(text);
        }).catch(function(err) {
          console.log('[Ortus] Parallel fetch error: ' + err.message);
        });
      }
    }
    return _origOpen.apply(this, arguments);
  };

  /* Allow content script to reset dedup after a nudge so page 1 can be re-intercepted */
  window.addEventListener('__ortus_reset_interceptor', function() {
    fetchedUrls = {};
    console.log('[Ortus] Interceptor dedup reset (nudge recovery)');
  });

  console.log('[Ortus] Interceptor v4.0.11 installed (parallel fetch on XHR detect)');
})();
