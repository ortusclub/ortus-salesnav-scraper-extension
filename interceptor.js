/* Ortus v4.2.0 — Read XHR response directly instead of re-fetching.
 * LinkedIn now uses POST for salesApiLeadSearch, so re-fetching the URL
 * without the request body returns 400. Instead, we patch XHR.open to
 * tag matching requests, then patch XHR.send to read the response
 * when it completes. */
(function() {
  if (window.__ortusInterceptorInstalled) return;
  window.__ortusInterceptorInstalled = true;
  if (!window.__ortusApiDataQueue) window.__ortusApiDataQueue = [];

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
        document.dispatchEvent(new CustomEvent('__ortus_api_data', { detail: JSON.stringify(extracted) }));
        try { document.documentElement.setAttribute('data-ortus-api', JSON.stringify(extracted)); } catch(e) {}
        var ol = extracted.elements.filter(function(e){return e.openLink;}).length;
        var pr = extracted.elements.filter(function(e){return e.premium;}).length;
        console.log('[Ortus] INTERCEPTED: ' + extracted.elements.length + ' profiles (' + ol + ' open, ' + pr + ' premium)');
      }
    } catch(err) { console.log('[Ortus] processResponse error:', err.message); }
  }

  /* Patch XHR.open — tag requests that match salesApiLeadSearch */
  var _origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    var fullUrl = (url || '').toString();
    if (fullUrl.indexOf('salesApiLeadSearch') !== -1) {
      this.__ortusIsLeadSearch = true;
      console.log('[Ortus] Tagged salesApiLeadSearch XHR (' + method + ')');
    }
    return _origOpen.apply(this, arguments);
  };

  /* Patch XHR.send — add load listener to read response from tagged requests */
  var _origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function() {
    if (this.__ortusIsLeadSearch) {
      var xhr = this;
      xhr.addEventListener('load', function() {
        try {
          if (xhr.status === 200) {
            if (xhr.responseType === 'blob' && xhr.response instanceof Blob) {
              /* LinkedIn uses responseType='blob' — convert to text */
              var reader = new FileReader();
              reader.onload = function() {
                console.log('[Ortus] Reading salesApiLeadSearch blob response (' + reader.result.length + ' bytes)');
                processResponse(reader.result);
              };
              reader.readAsText(xhr.response);
            } else if (xhr.responseType === '' || xhr.responseType === 'text') {
              console.log('[Ortus] Reading salesApiLeadSearch text response (' + xhr.responseText.length + ' bytes)');
              processResponse(xhr.responseText);
            } else if (xhr.responseType === 'arraybuffer' && xhr.response) {
              var text = new TextDecoder().decode(xhr.response);
              console.log('[Ortus] Reading salesApiLeadSearch arraybuffer response (' + text.length + ' bytes)');
              processResponse(text);
            } else {
              console.log('[Ortus] salesApiLeadSearch unknown responseType: ' + xhr.responseType);
            }
          } else {
            console.log('[Ortus] salesApiLeadSearch returned status ' + xhr.status);
            /* v4.3 throttle detection — 429 Too Many Requests, 999 LinkedIn throttle */
            if (xhr.status === 429 || xhr.status === 999) {
              var retryAfter = 0;
              try { retryAfter = parseInt(xhr.getResponseHeader('Retry-After') || '0', 10) || 0; } catch(e) {}
              console.log('[Ortus] THROTTLE DETECTED: status=' + xhr.status + ' retryAfter=' + retryAfter + 's');
              document.dispatchEvent(new CustomEvent('__ortus_throttle_detected', {
                detail: JSON.stringify({ status: xhr.status, retryAfter: retryAfter })
              }));
            }
          }
        } catch(e) {
          console.log('[Ortus] Error reading XHR response:', e.message);
        }
      });
    }
    return _origSend.apply(this, arguments);
  };

  /* Allow content script to reset state after a nudge */
  window.addEventListener('__ortus_reset_interceptor', function() {
    console.log('[Ortus] Interceptor reset (nudge recovery)');
  });

  console.log('[Ortus] Interceptor v4.2.0 installed (direct XHR response reading)');
})();
