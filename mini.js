/* Floating mini status window — subscribes to bg state broadcasts and renders
 * a compact "Scraping…" strip.
 *
 * KEEPALIVE STRATEGY (fullscreen-resistant):
 * 1. A persistent chrome.runtime.connect() port to bg — Chrome keeps the SW alive
 *    while the port exists, regardless of whether this window's JS is throttled
 *    by macOS Spaces / fullscreen mode. This is the documented MV3 pattern.
 * 2. setInterval(2s) refresh — best-effort UI updates, may slow to 1/min when
 *    backgrounded. Doesn't matter for SW lifetime — that's the port's job. */
(function(){
  var keepalivePort = null;
  function openKeepalivePort(){
    try {
      keepalivePort = chrome.runtime.connect({name: 'mini-keepalive'});
      keepalivePort.onDisconnect.addListener(function(){
        keepalivePort = null;
        /* SW was evicted and is restarting, or bg disconnected us — reconnect. */
        setTimeout(openKeepalivePort, 500);
      });
    } catch (e) {
      /* Bg not ready — try again shortly */
      setTimeout(openKeepalivePort, 1000);
    }
  }
  openKeepalivePort();

  var dot = document.getElementById('dot');
  var headline = document.getElementById('headline');
  var meta = document.getElementById('meta');
  var closeBtn = document.getElementById('close');

  var lastMode = '';
  var lastRunning = false;

  /* X stops the entire campaign and closes the window. To close without stopping,
   * use the macOS red traffic light on the title bar. */
  closeBtn.addEventListener('click', function(){
    if (!lastRunning) { window.close(); return; }
    var label = lastMode === 'batch' ? 'this entire batch (all remaining jobs)' : 'this scrape';
    if (!confirm('Stop ' + label + ' and close?\n\nLeads already captured stay in the sheet.')) return;
    var action = lastMode === 'batch' ? 'stopBatch' : 'stopScrape';
    chrome.runtime.sendMessage({action: action}, function(){ window.close(); });
  });

  function fmt(n){ try{ return (n||0).toLocaleString(); }catch(e){ return String(n||0); } }

  function render(st){
    if (!st) { setIdle('Connecting…'); return; }
    var running = !!st.isRunning;
    var paused = !!st.isPaused;
    var mode = st.mode || '';
    lastMode = mode;
    lastRunning = running;
    var scraped = st.profilesScraped || 0;
    var page = st.currentPage || 0;
    var jobs = st.jobs || [];
    var jobIdx = (typeof st.currentJobIndex === 'number') ? st.currentJobIndex : -1;
    var totalJobs = jobs.length;
    /* Compute total page count from jobs total profiles when possible — fall back to st.totalPages */
    var totalPages = st.totalPages || 0;

    if (running && !paused) {
      dot.setAttribute('data-state', 'running');
      headline.innerHTML = 'Scraping<span class="dots"></span>';
      var parts = [];
      parts.push(fmt(scraped) + ' lead' + (scraped === 1 ? '' : 's'));
      if (page > 0) parts.push('page ' + page + (totalPages ? '/' + totalPages : ''));
      if (mode === 'batch' && totalJobs > 0 && jobIdx >= 0) {
        parts.push('job ' + (jobIdx + 1) + '/' + totalJobs);
      }
      meta.textContent = parts.join(' · ');
      document.title = 'Scraping · ' + parts.join(' · ');
      return;
    }
    if (running && paused) {
      dot.setAttribute('data-state', 'paused');
      headline.textContent = 'Paused';
      meta.textContent = fmt(scraped) + ' leads · page ' + (page || 0);
      document.title = 'Paused · ' + fmt(scraped) + ' leads';
      return;
    }
    if (!running && st.endTime) {
      dot.setAttribute('data-state', 'done');
      headline.textContent = 'Done';
      meta.textContent = fmt(scraped) + ' lead' + (scraped === 1 ? '' : 's') + ' captured';
      document.title = 'Done · ' + fmt(scraped) + ' leads';
      return;
    }
    setIdle('Idle · no scrape running');
  }

  function setIdle(text){
    dot.setAttribute('data-state', 'idle');
    headline.textContent = 'Standby';
    meta.textContent = text || 'Idle';
    document.title = 'Ortus Status';
  }

  function refresh(){
    chrome.runtime.sendMessage({action:'getState'}, function(st){
      if (chrome.runtime.lastError) { setIdle('Background not responding'); return; }
      render(st);
    });
  }

  /* Listen for live state pushes (same broadcast the main popup uses) */
  chrome.runtime.onMessage.addListener(function(msg){
    if (msg && msg.action === 'stateUpdate') refresh();
  });

  /* Initial paint + safety poll every 2s in case a broadcast is missed */
  refresh();
  setInterval(refresh, 2000);
})();
