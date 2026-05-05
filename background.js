var WEB_APP_URL = "https://script.google.com/macros/s/AKfycbyW3i2O8ZOCO1mpGmUnu2sLeCXWI9n0HrFCE8ZZ2dzf27SRVNELKL85vxpKLM0-b3_k/exec";
var DELAY_MIN_FAST = 2000;
var DELAY_MAX_FAST = 4000;
var DELAY_MIN_SLOW = 6000;
var DELAY_MAX_SLOW = 10000;
var SLOW_MODE = false; /* Page-to-page pacing — rate-limit safety, NOT hardware-related */
var CORNER_WINDOW = true; /* Default ON — small corner so it stays visible without dominating the screen */
var CORNER_WIDTH = 500, CORNER_HEIGHT = 800;
/* Load settings on startup */
chrome.storage.local.get(['ortus_slow_mode','ortus_corner_window','ortus_hide_window'],function(d){
  if(d){
    SLOW_MODE=!!d.ortus_slow_mode;
    /* Migrate old ortus_hide_window → ortus_corner_window */
    if(typeof d.ortus_corner_window!=='undefined')CORNER_WINDOW=!!d.ortus_corner_window;
    else if(typeof d.ortus_hide_window!=='undefined')CORNER_WINDOW=!!d.ortus_hide_window;
  }
});
async function createScrapeWindow(url){
  /* Chrome requires window bounds to be ≥50% on-screen — use a safe top-right offset */
  var opts=CORNER_WINDOW
    ?{url:url,focused:false,width:CORNER_WIDTH,height:CORNER_HEIGHT,left:800,top:30}
    :{url:url,focused:false,width:1280,height:900};
  var win;
  try{win=await chrome.windows.create(opts);}
  catch(e){
    addLog('warn','createScrapeWindow bounds rejected ('+e.message+'), retrying without position');
    delete opts.left;delete opts.top;
    win=await chrome.windows.create(opts);
  }
  /* Pin the scrape tab as non-discardable so Chrome Memory Saver can't freeze it mid-run. */
  try{
    if(win&&win.tabs&&win.tabs[0]){
      await chrome.tabs.update(win.tabs[0].id,{autoDiscardable:false});
      addLog('info','Scrape tab pinned (autoDiscardable=false)');
    }
  }catch(eAd){addLog('warn','autoDiscardable set failed: '+eAd.message);}
  return win;
}
async function applyCornerState(){
  if(!state.tabId)return{ok:false,error:'No active tab'};
  return new Promise(function(res){
    chrome.tabs.get(state.tabId,function(t){
      if(chrome.runtime.lastError||!t){addLog('warn','applyCornerState: no live tab ('+(chrome.runtime.lastError?chrome.runtime.lastError.message:'null')+')');res({ok:false});return;}
      var upd=CORNER_WINDOW
        ?{state:'normal',width:CORNER_WIDTH,height:CORNER_HEIGHT,left:800,top:30,focused:false}
        :{state:'normal',width:1280,height:900,focused:false};
      chrome.windows.update(t.windowId,upd,function(w){
        if(chrome.runtime.lastError){addLog('warn','Corner update rejected ('+chrome.runtime.lastError.message+'), retrying without position');
          var fb=CORNER_WINDOW?{state:'normal',width:CORNER_WIDTH,height:CORNER_HEIGHT,focused:false}:{state:'normal',width:1280,height:900,focused:false};
          chrome.windows.update(t.windowId,fb,function(){
            if(chrome.runtime.lastError){addLog('error','Window update failed: '+chrome.runtime.lastError.message);res({ok:false});return;}
            addLog('info','Window '+t.windowId+' resized (fallback position)');res({ok:true});
          });return;
        }
        addLog('info','Window '+t.windowId+' → '+(CORNER_WINDOW?'corner':'normal'));
        res({ok:true});
      });
    });
  });
}

function getDelay(fast,slow){ return SLOW_MODE ? slow : fast; }
function pageDelay(){
  return rDelay(SLOW_MODE?DELAY_MIN_SLOW:DELAY_MIN_FAST, SLOW_MODE?DELAY_MAX_SLOW:DELAY_MAX_FAST);
}
var SAVE_INTERVAL = 15000; /* Save state every 15s */
var LOG_MAX = 500; /* Max log entries kept */
var logBuffer = [];
var logFlushTimer = null;

function addLog(level, msg) {
  var entry = { t: Date.now(), l: level, m: String(msg) };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_MAX) logBuffer = logBuffer.slice(-LOG_MAX);
  console.log('[BG] ' + msg);
  /* Debounced flush — writes at most every 500ms */
  if (!logFlushTimer) {
    logFlushTimer = setTimeout(function() {
      logFlushTimer = null;
      chrome.storage.session.set({ortus_logs: logBuffer}).catch(function(){});
    }, 500);
  }
}

/* Restore logs on service worker startup */
chrome.storage.session.get('ortus_logs',function(d){
  if(d&&d.ortus_logs&&d.ortus_logs.length)logBuffer=d.ortus_logs;
});

var state = {
  mode: null, isRunning: false, isPaused: false, recoverRequested: false, retryQueue: [],
  tabId: null, currentPage: 0, totalPages: 0, totalResults: 0,
  profilesScraped: 0, allProfiles: [], errors: [],
  startTime: null, endTime: null, sheetUrl: '', sheetName: '',
  jobs: [], currentJobIndex: -1,
  salesNavUrl: '',
  srcSheetUrl: '', srcTabName: '', outputColIdx: -1,
};

var saveTimer = null;

function rDelay(a,b){return Math.floor(Math.random()*(b-a+1))+a;}
/* Filter integrity check: did LinkedIn strip the search filters from the live URL?
 * Sales Nav search URLs always carry an opaque 'query' param holding the filter blob.
 * If the live URL is missing 'query' (or it's empty), filters were wiped — recover. */
function urlFiltersIntact(liveUrl,canonicalUrl){
  try{
    var canon=new URL(canonicalUrl);
    var canonQuery=canon.searchParams.get('query');
    if(!canonQuery)return true; /* canonical has no query — nothing to enforce */
    var live=new URL(liveUrl);
    var liveQuery=live.searchParams.get('query');
    if(!liveQuery)return false;
    /* Sales Nav can append/reorder query trailing fragments; require canonical core to be a prefix */
    var core=canonQuery.length>40?canonQuery.slice(0,40):canonQuery;
    return liveQuery.indexOf(core)===0;
  }catch(e){return true;} /* on parse error, don't trigger recovery */
}
/* Filter-wipe recovery: full-reload the tab from the canonical URL at page N and re-extract.
 * Caller discards whatever profiles came back from the wiped page before invoking this. */
async function recoverFromFilterWipe(tabId,canonicalUrl,pageNum){
  var fixUrl=new URL(canonicalUrl);
  fixUrl.searchParams.set('page',pageNum);
  await chrome.tabs.update(tabId,{url:fixUrl.toString()});
  await waitTab(tabId,20000);
  try{await chrome.tabs.setZoom(tabId,0.25);}catch(e){}
  await new Promise(function(r){setTimeout(r,getDelay(300,800));});
  try{await chrome.scripting.executeScript({target:{tabId:tabId},files:['content.js']});}catch(e){}
  await new Promise(function(r){setTimeout(r,getDelay(150,400));});
  try{await tabMsg(tabId,{action:'waitForResults',timeout:20000});}catch(ew){}
  return await tabMsg(tabId,{action:'extractProfiles',slow:SLOW_MODE});
}
async function waitWhilePaused(){while(state.isPaused&&state.isRunning){await new Promise(function(r){setTimeout(r,500);});}}
async function recoverBatch(){
  if(!state.isRunning)return{ok:false,error:'Batch not running'};
  addLog('info','Recover requested by user at job '+(state.currentJobIndex+1)+' page '+state.currentPage);
  state.recoverRequested=true;state.isPaused=false;bc();
  if(state.tabId){try{await chrome.tabs.remove(state.tabId);addLog('info','Recover: tab closed to unblock');}catch(e){addLog('warn','Recover: tab close err: '+e.message);}}
  return{ok:true};
}
async function retryJobAction(idx){
  if(typeof idx!=='number'||idx<0||!state.jobs||idx>=state.jobs.length)return{ok:false,error:'Invalid job index'};
  var job=state.jobs[idx];
  if(!job)return{ok:false,error:'No job at index'};
  job.status='Pending';job.profilesScraped=0;
  if(!state.retryQueue)state.retryQueue=[];
  if(state.retryQueue.indexOf(idx)===-1)state.retryQueue.push(idx);
  addLog('info','Retry queued for job '+(idx+1)+(state.isRunning?' (will run after current)':' (starting now)'));
  bc();
  if(!state.isRunning){
    state.mode='batch';state.isRunning=true;
    state.startTime=state.startTime||Date.now();state.endTime=null;
    state.currentJobIndex=-1;
    chrome.action.setBadgeBackgroundColor({color:'#1a73e8'});
    startSaveTimer();nextJob();
  }
  return{ok:true};
}

chrome.runtime.onMessage.addListener(function(msg,sender,sendResponse){
  switch(msg.action){
    case 'getWebAppUrl':sendResponse({url:WEB_APP_URL});break;
    case 'getState':sendResponse(pubState());break;
    case 'resetState':resetState();sendResponse({ok:true});break;
    case 'checkCurrentTab':checkTab().then(sendResponse);return true;
    case 'startScrape':startSingle(msg.config).then(sendResponse);return true;
    case 'pauseScrape':state.isPaused=true;sendResponse({ok:true});break;
    case 'resumeScrape':state.isPaused=false;runSinglePage();sendResponse({ok:true});break;
    case 'stopScrape':stopScrape();sendResponse({ok:true});break;
    case 'exportCSV':sendResponse({csv:toCSV(state.allProfiles)});break;
    /* Batch - flexible input */
    case 'checkSheetSharing':checkSheetSharing(msg.sheetUrl).then(sendResponse);return true;
    case 'readTabs':readTabs(msg.sheetUrl).then(sendResponse);return true;
    case 'readColumns':readColumns(msg.sheetUrl,msg.tabName).then(sendResponse);return true;
    case 'setJobs':setJobs(msg);sendResponse({ok:true});break;
    case 'startBatch':startBatch().then(sendResponse);return true;
    case 'stopBatch':stopBatch();sendResponse({ok:true});break;
    case 'pauseBatch':state.isPaused=true;bc();sendResponse({ok:true});break;
    case 'resumeBatch':state.isPaused=false;bc();sendResponse({ok:true});break;
    case 'recoverBatch':recoverBatch().then(sendResponse);return true;
    case 'retryJob':retryJobAction(msg.index).then(sendResponse);return true;
    case 'throttleDetected':addLog('warn','Throttle signal ('+msg.status+') ignored — cooldowns disabled');sendResponse({ok:true});break;
    /* Persistence / resume */
    case 'checkSavedState':checkSavedState().then(sendResponse);return true;
    case 'clearSavedState':clearSavedState().then(sendResponse);return true;
    case 'resumeInterrupted':resumeInterrupted().then(sendResponse);return true;
    case 'getLogs':sendResponse({logs:logBuffer});break;
    case 'clearLogs':logBuffer=[];chrome.storage.session.remove('ortus_logs');sendResponse({ok:true});break;
    case 'setSlowMode':SLOW_MODE=!!msg.slow;addLog('info','Slow mode: '+(SLOW_MODE?'ON':'OFF'));sendResponse({ok:true});break;
    case 'setCornerWindow':
      CORNER_WINDOW=!!msg.corner;addLog('info','Corner window: '+(CORNER_WINDOW?'ON':'OFF'));
      applyCornerState().then(function(r){sendResponse({ok:true,applied:r&&r.ok});});
      return true;
    default:sendResponse({error:'Unknown: '+msg.action});
  }
});

function pubState(){
  return {mode:state.mode,isRunning:state.isRunning,isPaused:state.isPaused,
    currentPage:state.currentPage,totalPages:state.totalPages,totalResults:state.totalResults,
    profilesScraped:state.profilesScraped,profileCount:state.allProfiles.length,
    errors:state.errors,startTime:state.startTime,endTime:state.endTime,sheetUrl:state.sheetUrl,
    jobs:state.jobs,currentJobIndex:state.currentJobIndex};
}

function resetState(){
  state={mode:null,isRunning:false,isPaused:false,recoverRequested:false,retryQueue:[],tabId:null,currentPage:0,totalPages:0,totalResults:0,
    profilesScraped:0,allProfiles:[],errors:[],startTime:null,endTime:null,sheetUrl:'',sheetName:'',
    jobs:[],currentJobIndex:-1,salesNavUrl:'',srcSheetUrl:'',srcTabName:'',outputColIdx:-1};
  chrome.action.setBadgeText({text:''});
  stopSaveTimer();
}

function bc(){chrome.runtime.sendMessage({action:'stateUpdate',state:pubState()}).catch(function(){});}

/* Persistent-port keepalive — the mini window opens a "mini-keepalive" port and
 * holds it for its lifetime. Chrome won't evict the SW while any extension port
 * is open, even if the mini's JS is throttled (e.g. macOS fullscreen on another
 * Space). This is more reliable than chrome.alarms for active-scrape scenarios. */
chrome.runtime.onConnect.addListener(function(port){
  if(port.name==='mini-keepalive'){
    /* Existence of the port is the value. Just hold it until the other side closes. */
    port.onDisconnect.addListener(function(){
      /* Mini closed or SW restart — nothing to clean up; mini will reconnect on next load. */
    });
  }
});

/* ─── PERSISTENCE ─── */
function startSaveTimer(){
  stopSaveTimer();
  saveTimer=setInterval(function(){saveState();},SAVE_INTERVAL);
  startKeepalive();
}
function stopSaveTimer(){if(saveTimer){clearInterval(saveTimer);saveTimer=null;}stopKeepalive();}

/* ─── KEEPALIVE ───
 * MV3 service workers suspend after ~30s of idle. setInterval can stop firing.
 * chrome.alarms survives suspension and wakes the SW back up — paired with the
 * silent-audio/Web-Audio in content.js to defeat macOS App Nap on the page side. */
var KEEPALIVE_ALARM='ortus-keepalive';
function startKeepalive(){
  try{chrome.alarms.create(KEEPALIVE_ALARM,{periodInMinutes:0.4});}catch(e){}
}
function stopKeepalive(){
  try{chrome.alarms.clear(KEEPALIVE_ALARM);}catch(e){}
}
chrome.alarms.onAlarm.addListener(function(a){
  if(a&&a.name===KEEPALIVE_ALARM){
    /* No-op handler — the wakeup itself is the value. Touch state to prove liveness. */
    if(state&&state.isRunning){try{saveState();}catch(e){}}
  }
});

async function saveState(){
  if(!state.isRunning)return;
  var s={
    mode:state.mode,currentPage:state.currentPage,totalPages:state.totalPages,
    totalResults:state.totalResults,profilesScraped:state.profilesScraped,
    errors:state.errors,startTime:state.startTime,sheetUrl:state.sheetUrl,
    sheetName:state.sheetName,salesNavUrl:state.salesNavUrl,
    srcSheetUrl:state.srcSheetUrl,srcTabName:state.srcTabName,outputColIdx:state.outputColIdx,
    jobs:state.jobs,currentJobIndex:state.currentJobIndex,
    savedAt:Date.now(),interrupted:true
  };
  try{await chrome.storage.local.set({ortus_saved_state:s});}
  catch(e){addLog('error','Save state error: '+e.message);}
}

async function checkSavedState(){
  try{
    var d=await chrome.storage.local.get('ortus_saved_state');
    if(!d.ortus_saved_state||!d.ortus_saved_state.interrupted)return{hasInterrupted:false};
    var s=d.ortus_saved_state;
    return{hasInterrupted:true,mode:s.mode,currentPage:s.currentPage,totalPages:s.totalPages,
      profilesScraped:s.profilesScraped,sheetUrl:s.sheetUrl,sheetName:s.sheetName,
      salesNavUrl:s.salesNavUrl,jobs:s.jobs||[],currentJobIndex:s.currentJobIndex};
  }catch(e){return{hasInterrupted:false};}
}

async function clearSavedState(){
  try{await chrome.storage.local.remove('ortus_saved_state');}catch(e){}
  return{ok:true};
}

async function resumeInterrupted(){
  try{
    var d=await chrome.storage.local.get('ortus_saved_state');
    if(!d.ortus_saved_state)return{ok:false,error:'No saved state'};
    var s=d.ortus_saved_state;
    if(s.mode==='single'){
      /* Resume single scrape: open the Sales Nav URL to the last page */
      if(!s.salesNavUrl)return{ok:false,error:'No URL to resume'};
      resetState();
      state.mode='single';state.isRunning=true;state.startTime=s.startTime||Date.now();
      state.currentPage=s.currentPage||1;state.totalPages=s.totalPages||0;
      state.totalResults=s.totalResults||0;state.sheetUrl=s.sheetUrl||'';
      state.sheetName=s.sheetName||'Sales Nav Scrape';state.salesNavUrl=s.salesNavUrl;
      state.profilesScraped=s.profilesScraped||0;state.errors=s.errors||[];
      chrome.action.setBadgeBackgroundColor({color:'#1a73e8'});
      /* Open the page at the right page number */
      var resumeUrl=s.salesNavUrl;
      if(state.currentPage>1){
        var sep=resumeUrl.indexOf('?')!==-1?'&':'?';
        resumeUrl=resumeUrl+sep+'page='+state.currentPage;
      }
      var win=await createScrapeWindow(resumeUrl);
      state.tabId=win.tabs[0].id;
      await waitTab(state.tabId,20000);
      try{await chrome.tabs.setZoom(state.tabId,0.25);}catch(e){}
      await new Promise(function(r){setTimeout(r,8000);});
      try{await chrome.scripting.executeScript({target:{tabId:state.tabId},files:['content.js']});}catch(e){}
      await new Promise(function(r){setTimeout(r,2000);});
      await clearSavedState();
      startSaveTimer();runSinglePage();
      return{ok:true};
    }else if(s.mode==='batch'){
      /* Resume batch: restore jobs, skip completed ones */
      resetState();
      state.mode='batch';state.isRunning=true;state.startTime=s.startTime||Date.now();
      state.jobs=s.jobs||[];state.currentJobIndex=(s.currentJobIndex||1)-1;/* will be incremented in nextJob */
      state.sheetUrl=s.sheetUrl||'';state.sheetName=s.sheetName||'';
      state.srcSheetUrl=s.srcSheetUrl||'';state.srcTabName=s.srcTabName||'';
      state.outputColIdx=s.outputColIdx||-1;
      state.profilesScraped=s.profilesScraped||0;
      chrome.action.setBadgeBackgroundColor({color:'#1a73e8'});
      await clearSavedState();
      startSaveTimer();nextJob();
      return{ok:true};
    }
    return{ok:false,error:'Unknown mode'};
  }catch(e){return{ok:false,error:e.message};}
}

/* ─── CHECK TAB ─── */
async function checkTab(){
  try{
    var tabs=await chrome.tabs.query({active:true,currentWindow:true});var tab=tabs[0];
    if(!tab)return{ok:false,error:'No tab'};
    var url=tab.url||'';
    if(url.indexOf('linkedin.com/sales/search/people')===-1&&url.indexOf('linkedin.com/sales/lists/people')===-1)return{ok:false,error:'NOT_SALES_NAV'};
    try{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});}catch(e){}
    await new Promise(function(r){setTimeout(r,500);});
    try{var pi=await tabMsg(tab.id,{action:'getPageInfo'});return{ok:true,tabId:tab.id,pageInfo:pi||{}};}
    catch(e){return{ok:false,error:'Content script not responding'};}
  }catch(e){return{ok:false,error:e.message};}
}

/* ─── SINGLE MODE ─── */
async function startSingle(cfg){
  if(state.isRunning)return{ok:false,error:'Running'};
  resetState();state.mode='single';state.isRunning=true;
  state.tabId=cfg.tabId;state.currentPage=cfg.startPage||1;state.totalPages=cfg.totalPages||0;
  state.totalResults=cfg.totalResults||0;state.sheetUrl=cfg.sheetUrl||'';state.sheetName=cfg.sheetName||'Sales Nav Scrape';
  state.startTime=Date.now();
  maybeAutoOpenMini();
  /* Save the Sales Nav URL for resume */
  try{
    var t=await chrome.tabs.get(cfg.tabId);
    state.salesNavUrl=(t&&t.url)?t.url.split('&page=')[0].split('?page=')[0]:'';
  }catch(e){state.salesNavUrl='';}
  chrome.action.setBadgeBackgroundColor({color:'#1a73e8'});chrome.action.setBadgeText({text:'...'});
  startSaveTimer();runSinglePage();return{ok:true};
}

async function runSinglePage(){
  if(!state.isRunning||state.isPaused)return;
  var tid=state.tabId,pg=state.currentPage;
  chrome.action.setBadgeText({text:state.totalPages>0?pg+'/'+state.totalPages:'p'+pg});bc();
  try{
    await waitTab(tid);
    var r=await tabMsg(tid,{action:'extractProfiles',slow:SLOW_MODE});
    /* Post-extraction integrity check — uses pi.url from the result we already have.
     * Catches both empty-page wipes AND silent fallback wipes (LinkedIn returning
     * unfiltered results) before we add bad profiles to the collection. */
    if(state.salesNavUrl&&r&&r.pageInfo&&r.pageInfo.url&&!urlFiltersIntact(r.pageInfo.url,state.salesNavUrl)){
      addLog('warn','Filters wiped on page '+pg+' — discarding '+(r.profiles?r.profiles.length:0)+' profiles, recovering');
      try{r=await recoverFromFilterWipe(tid,state.salesNavUrl,pg);}
      catch(e){addLog('error','Recovery failed: '+e.message);}
    }
    if(r&&r.profiles){
      for(var i=0;i<r.profiles.length;i++)r.profiles[i].pageNumber=pg;
      state.allProfiles=state.allProfiles.concat(r.profiles);state.profilesScraped+=r.profiles.length;
      if(r.pageInfo&&r.pageInfo.totalPages>0){state.totalPages=r.pageInfo.totalPages;state.totalResults=r.pageInfo.totalResults;}
      if(state.sheetUrl)sendSheet(r.profiles,pg,state.sheetUrl,state.sheetName).catch(function(e){addLog('error','Async sheet err: '+e.message);});
    }
    bc();
    var pi=await tabMsg(tid,{action:'getPageInfo'});
    if(!pi.hasNextPage||(state.totalPages>0&&pg>=state.totalPages)){finishScrape();return;}
    await new Promise(function(r){setTimeout(r,pageDelay());});
    if(!state.isRunning||state.isPaused)return;
    state.currentPage=pg+1;
    await tabMsg(tid,{action:'goToNextPage'});await waitNav(tid);runSinglePage();
  }catch(err){
    state.errors.push({page:pg,error:err.message||String(err)});
    /* Check if it's a tab-closed / fatal error */
    if(err.message&&(err.message.indexOf('Tab closed')!==-1||err.message.indexOf('No tab')!==-1||err.message.indexOf('disconnected')!==-1)){
      notifyError('Scraping interrupted on page '+pg+'. You can resume from the extension.');
      saveState();stopSaveTimer();state.isRunning=false;bc();return;
    }
    if(state.isRunning){state.currentPage=pg+1;await new Promise(function(r){setTimeout(r,2000);});
      try{await tabMsg(tid,{action:'navigateToPage',page:state.currentPage,baseUrl:state.salesNavUrl});await waitNav(tid);runSinglePage();}catch(e){
        notifyError('Scraping stopped due to error on page '+pg+'. You can resume from the extension.');
        saveState();stopSaveTimer();state.isRunning=false;bc();
      }}
  }
}

function finishScrape(){
  state.isRunning=false;state.endTime=Date.now();stopSaveTimer();clearSavedState();
  chrome.action.setBadgeBackgroundColor({color:'#1e8e3e'});chrome.action.setBadgeText({text:'\u2713'});
  setTimeout(function(){chrome.action.setBadgeText({text:''});},30000);bc();
}

function stopScrape(){
  state.isRunning=false;state.isPaused=false;state.endTime=Date.now();
  stopSaveTimer();clearSavedState();
  chrome.action.setBadgeText({text:''});bc();
}

/* ─── BATCH MODE ─── */
/* Verify a sheet is shared as "Anyone with the link · Editor".
 * Two-tier check:
 *   1. Apps Script bridge (checkSharing action) — uses DriveApp.getSharingAccess() +
 *      getSharingPermission() to verify EDITOR specifically. Most accurate.
 *   2. Fallback: public CSV export URL — only confirms anyone-with-link viewer-or-better,
 *      used if the apps script hasn't been redeployed with the new action yet. */
async function checkSheetSharing(sheetUrl){
  var m=String(sheetUrl||'').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if(!m)return{ok:false,error:'Not a valid Google Sheets URL'};
  var sheetId=m[1];
  /* Tier 1: apps-script accurate check */
  try{
    var resp=await fetch(WEB_APP_URL,{method:'POST',headers:{'Content-Type':'text/plain'},
      body:JSON.stringify({action:'checkSharing',sheetUrl:sheetUrl}),redirect:'follow'});
    var data=JSON.parse(await resp.text());
    if(data&&data.success===true&&typeof data.shared==='boolean'){
      if(data.shared)return{ok:true,shared:true,via:'appsscript',access:data.access,permission:data.permission};
      return{ok:true,shared:false,via:'appsscript',error:data.reason||'Sheet not shared as Anyone with the link · Editor'};
    }
    /* If success:false and it's the "Unknown action" error, the apps script is stale — fall through to tier 2. */
    if(data&&data.error&&/unknown/i.test(data.error)){
      addLog('info','checkSharing: apps script stale, falling back to public-probe');
    }else if(data&&data.error){
      /* Real error from apps script — surface it but still try fallback */
      addLog('warn','checkSharing apps-script error: '+data.error);
    }
  }catch(e){addLog('warn','checkSharing apps-script call failed: '+e.message+' — trying fallback');}
  /* Tier 2: public-export probe (anyone-with-link viewer-or-better) */
  try{
    var probeUrl='https://docs.google.com/spreadsheets/d/'+sheetId+'/export?format=csv&gid=0';
    var resp2=await fetch(probeUrl,{method:'GET',redirect:'manual',credentials:'omit'});
    if(resp2.status===200)return{ok:true,shared:true,via:'public-probe',note:'Editor permission not verified — apps script outdated'};
    return{ok:true,shared:false,via:'public-probe',status:resp2.status,error:'Sheet is not publicly shared (status '+resp2.status+'). Set sharing to "Anyone with the link · Editor".'};
  }catch(e){return{ok:false,error:'Sharing check failed: '+e.message};}
}

async function readTabs(sheetUrl){
  try{
    var resp=await fetch(WEB_APP_URL,{method:'POST',headers:{'Content-Type':'text/plain'},
      body:JSON.stringify({action:'readTabs',sheetUrl:sheetUrl}),redirect:'follow'});
    var data=JSON.parse(await resp.text());
    if(!data.success)return{ok:false,error:data.error||'Failed'};
    return{ok:true,tabs:data.tabs||[],title:data.title||''};
  }catch(e){return{ok:false,error:'Load failed: '+e.message};}
}

async function readColumns(sheetUrl,tabName){
  try{
    var resp=await fetch(WEB_APP_URL,{method:'POST',headers:{'Content-Type':'text/plain'},
      body:JSON.stringify({action:'readColumns',sheetUrl:sheetUrl,tabName:tabName||''}),redirect:'follow'});
    var data=JSON.parse(await resp.text());
    if(!data.success)return{ok:false,error:data.error||'Failed'};
    return{ok:true,headers:data.headers||[],sampleRows:data.sampleRows||[],allRows:data.allRows||[]};
  }catch(e){return{ok:false,error:'Load failed: '+e.message};}
}

function setJobs(msg){
  state.jobs=msg.jobs;state.sheetUrl=msg.destSheetUrl;state.sheetName=msg.destTabName;
  state.srcSheetUrl=msg.srcSheetUrl||'';state.srcTabName=msg.srcTabName||'';
  state.outputColIdx=msg.outputColIdx||-1;/* 1-indexed column for write-back, -1 = disabled */
}

/* Auto-open the floating mini status window when a scrape starts (unless disabled).
 * Setting key: ortus_float_auto — defaults to true. The mini window keeps the SW
 * alive (constant chrome.runtime traffic), which speeds the scrape. */
function maybeAutoOpenMini(){
  chrome.storage.local.get(['ortus_float_auto'],function(d){
    var enabled=(d&&typeof d.ortus_float_auto!=='undefined')?!!d.ortus_float_auto:true;
    if(!enabled)return;
    var miniUrl=chrome.runtime.getURL('mini.html');
    chrome.windows.getAll({populate:true},function(wins){
      for(var i=0;i<wins.length;i++){
        var w=wins[i];if(w.type!=='popup'||!w.tabs||!w.tabs.length)continue;
        for(var j=0;j<w.tabs.length;j++){if(w.tabs[j].url===miniUrl)return;}
      }
      try{chrome.windows.create({url:miniUrl,type:'popup',width:320,height:116,focused:true});}
      catch(e){addLog('warn','Mini auto-open failed: '+e.message);}
    });
  });
}

async function startBatch(){
  if(state.isRunning)return{ok:false,error:'Running'};
  state.mode='batch';state.isRunning=true;state.startTime=Date.now();state.currentJobIndex=-1;
  chrome.action.setBadgeBackgroundColor({color:'#1a73e8'});
  startSaveTimer();maybeAutoOpenMini();nextJob();return{ok:true};
}

async function nextJob(){
  /* Safety: never leave a previous job stuck at 'Running' */
  if(state.currentJobIndex>=0&&state.currentJobIndex<state.jobs.length){
    var prev=state.jobs[state.currentJobIndex];
    if(prev&&prev.status==='Running'){
      var n=prev.profilesScraped||state.profilesScraped||0;
      prev.status=n>0?'Partial ('+n+', interrupted)':'Error: interrupted';
      addLog('warn','Safety: job '+(state.currentJobIndex+1)+' still "Running" at nextJob — finalized to "'+prev.status+'"');
    }
  }
  if(!state.isRunning)return;
  /* Priority 1: retry queue (user-requested re-runs of failed/partial jobs) */
  if(state.retryQueue&&state.retryQueue.length>0){
    state.currentJobIndex=state.retryQueue.shift();
    addLog('info','Running retry for job '+(state.currentJobIndex+1));
  }else{
    state.currentJobIndex++;
    while(state.currentJobIndex<state.jobs.length){
      var s=state.jobs[state.currentJobIndex].status;
      if(!s||s==='Pending')break;
      state.currentJobIndex++;
    }
  }
  if(state.currentJobIndex>=state.jobs.length){
    /* Final safety: flush any remaining retries before declaring done */
    if(state.retryQueue&&state.retryQueue.length>0){
      state.currentJobIndex=state.retryQueue.shift();
      addLog('info','Running final retry for job '+(state.currentJobIndex+1));
    }else{
      state.isRunning=false;state.endTime=Date.now();stopSaveTimer();clearSavedState();
      chrome.action.setBadgeBackgroundColor({color:'#1e8e3e'});chrome.action.setBadgeText({text:'\u2713'});
      setTimeout(function(){chrome.action.setBadgeText({text:''});},30000);bc();return;
    }
  }
  var job=state.jobs[state.currentJobIndex];var jn=state.currentJobIndex+1;var tot=state.jobs.length;
  chrome.action.setBadgeText({text:jn+'/'+tot});bc();
  job.status='Running';
  try{
    var win=await createScrapeWindow(job.salesNavUrl);var tab=win.tabs[0];
    state.tabId=tab.id;await waitTab(tab.id,20000);
    try{await chrome.tabs.setZoom(tab.id,0.25);}catch(e){addLog('warn','Zoom err: '+e.message);}
    await new Promise(function(r){setTimeout(r,getDelay(3000,8000));});
    try{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});}catch(e){}
    await new Promise(function(r){setTimeout(r,getDelay(150,400));});
    /* Wait for results to actually render in DOM before reading page info */
    try{var wr=await tabMsg(tab.id,{action:'waitForResults',timeout:20000});addLog('info','Initial waitForResults: ready='+wr.ready+' items='+wr.items+' waited='+wr.waited+'ms');
      if(wr&&wr.emptyState){
        addLog('warn','Initial load: empty state ("'+(wr.emptyMessage||'')+'")');
        /* Try filter nudge first (faster than full reload) */
        addLog('info','Trying filter nudge to wake SPA...');
        try{
          var nudge=await tabMsg(tab.id,{action:'nudgeFilters'});
          if(nudge&&nudge.success){
            addLog('info','Filter nudge worked on initial load');
            wr={ready:true,items:25,emptyState:false};
          }else{
            addLog('warn','Filter nudge failed, falling back to full reload');
          }
        }catch(en){addLog('warn','Nudge error: '+en.message);}
        /* Full reload fallback (always, or if nudge failed) */
        if(wr&&wr.emptyState){
          addLog('info','Reloading page with full URL...');
          await new Promise(function(r){setTimeout(r,rDelay(30000,60000));});
          await chrome.tabs.update(tab.id,{url:job.salesNavUrl});await waitTab(tab.id,20000);
          try{await chrome.tabs.setZoom(tab.id,0.25);}catch(e){}
          await new Promise(function(r){setTimeout(r,5000);});
          try{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});}catch(e){}
          await new Promise(function(r){setTimeout(r,1000);});
          try{wr=await tabMsg(tab.id,{action:'waitForResults',timeout:20000});addLog('info','Initial retry waitForResults: ready='+wr.ready+' items='+wr.items);}catch(e){}
        }
      }
    }catch(e){addLog('warn','waitForResults err: '+e.message);await new Promise(function(r){setTimeout(r,8000);});}
    var pi;try{pi=await tabMsg(tab.id,{action:'getPageInfo'});}catch(e){pi={totalPages:1,hasNextPage:false,currentPage:1};}
    var totalR=pi.totalResults||0;
    state.totalResults=totalR;state.profilesScraped=0;state.currentPage=1;bc();
    var maxPage=totalR>0?Math.min(Math.ceil(totalR/25),100):100;/* LinkedIn caps at 2500/100 pages */
    addLog('info','Job '+(jn)+': '+totalR+' results'+(totalR>2500?' (capped at 2500)':'')+', maxPage='+maxPage+', hasNext='+(pi.hasNextPage||false));
    var allP=[];var cp=1;var consecutiveEmpty=0;
    var skippedPages=[];var recentSkips=0;
    while(cp<=maxPage&&state.isRunning){
      if(state.recoverRequested){
        state.recoverRequested=false;
        addLog('info','Recover: reopening tab at page '+cp);
        try{if(state.tabId){try{await chrome.tabs.remove(state.tabId);}catch(_){}}}catch(_){}
        try{
          var recUrl=new URL(job.salesNavUrl);recUrl.searchParams.set('page',cp);
          var rwin=await createScrapeWindow(recUrl.toString());
          tab=rwin.tabs[0];state.tabId=tab.id;
          await waitTab(tab.id,20000);
          try{await chrome.tabs.setZoom(tab.id,0.25);}catch(_){}
          await new Promise(function(r){setTimeout(r,5000);});
          try{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});}catch(_){}
          await new Promise(function(r){setTimeout(r,2000);});
          try{await tabMsg(tab.id,{action:'waitForResults',timeout:20000});}catch(_){}
          addLog('info','Recover: tab reopened at page '+cp);
        }catch(er){addLog('error','Recover reopen failed: '+er.message);break;}
      }
      chrome.action.setBadgeText({text:jn+':p'+cp});bc();
      var pageProfiles=0;
      try{
        /* === STEP A: Wait for content to render, then extract === */
        try{await tabMsg(tab.id,{action:'waitForResults',timeout:15000});}catch(ew){}
        var r=await tabMsg(tab.id,{action:'extractProfiles',slow:SLOW_MODE});
        /* Post-extraction integrity check: piggybacks on r.pageInfo.url (already in the result).
         * Catches both empty-page wipes AND silent fallback wipes before bad profiles enter allP. */
        if(r&&r.pageInfo&&r.pageInfo.url&&!urlFiltersIntact(r.pageInfo.url,job.salesNavUrl)){
          addLog('warn','Filters wiped on page '+cp+' — discarding '+(r.profiles?r.profiles.length:0)+' profiles, recovering');
          try{r=await recoverFromFilterWipe(tab.id,job.salesNavUrl,cp);}
          catch(e){addLog('error','Recovery failed: '+e.message);}
        }
        if(r&&r.profiles&&r.profiles.length>0){
          for(var i=0;i<r.profiles.length;i++)r.profiles[i].pageNumber=cp;
          allP=allP.concat(r.profiles);pageProfiles=r.profiles.length;consecutiveEmpty=0;recentSkips=0;
          state.profilesScraped=allP.length;state.currentPage=cp;bc();
          addLog('info', 'Page '+cp+': got '+r.profiles.length+', total: '+allP.length+(r.pageInfo?' (pageTotal='+r.pageInfo.totalResults+')':''));
          /* Sub-25 on a non-final page: keep re-extracting with 6s waits until we hit 25.
           * Cap at 10 attempts (60s extra per page) so genuinely anonymous-heavy pages don't
           * loop forever. Do NOT label the missing ones "anonymous" — we don't actually know. */
          if(pageProfiles>0&&pageProfiles<25&&cp<maxPage){
            var SOFT_MAX_ATTEMPTS=5;
            var softAttempt=0;
            while(softAttempt<SOFT_MAX_ATTEMPTS&&pageProfiles<25&&state.isRunning){
              softAttempt++;
              addLog('info','Page '+cp+' partial ('+pageProfiles+'/25), waiting 6s then re-checking (attempt '+softAttempt+'/'+SOFT_MAX_ATTEMPTS+')');
              await new Promise(function(r){setTimeout(r,6000);});
              if(!state.isRunning)break;
              try{
                try{await tabMsg(tab.id,{action:'waitForResults',timeout:10000});}catch(ew){}
                var rSoft=await tabMsg(tab.id,{action:'extractProfiles',slow:SLOW_MODE});
                if(rSoft&&rSoft.profiles&&rSoft.profiles.length>pageProfiles){
                  allP=allP.filter(function(p){return p.pageNumber!==cp;});
                  for(var is=0;is<rSoft.profiles.length;is++)rSoft.profiles[is].pageNumber=cp;
                  allP=allP.concat(rSoft.profiles);pageProfiles=rSoft.profiles.length;
                  state.profilesScraped=allP.length;bc();
                  r=rSoft;
                }
              }catch(eSoft){}
            }
            if(pageProfiles<25){
              var miss=25-pageProfiles;
              addLog('warn','Page '+cp+': '+pageProfiles+' leads, '+miss+' missing after '+softAttempt+' re-checks (could be anonymous or extraction issue)');
            }else{
              addLog('info','Page '+cp+' recovered to 25 after '+softAttempt+' re-check'+(softAttempt===1?'':'s'));
            }
          }
          /* Send final profiles for this page (may have been updated by partial retry) */
          var pageData=allP.filter(function(p){return p.pageNumber===cp;});
          sendSheet(pageData,cp,job.resultSheetUrl,job.tabName||'Sales Nav Scrape').catch(function(e){addLog('error','Async sheet err: '+e.message);});
        }else{
          /* === RETRY 1: Re-inject content script, wait for results, extract === */
          addLog('warn', 'Page '+cp+': 0 profiles, retrying with re-inject + waitForResults...');
          await new Promise(function(r){setTimeout(r,3000);});
          /* Re-inject content script (guard flag will block duplicate listeners — that's fine,
           * the existing listener is still active and will respond to messages) */
          try{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});}catch(e){}
          await new Promise(function(r){setTimeout(r,1000);});
          try{await tabMsg(tab.id,{action:'waitForResults',timeout:15000});}catch(ew){}
          var r2=await tabMsg(tab.id,{action:'extractProfiles',slow:SLOW_MODE});
          if(r2&&r2.profiles&&r2.profiles.length>0){
            for(var i2=0;i2<r2.profiles.length;i2++)r2.profiles[i2].pageNumber=cp;
            allP=allP.concat(r2.profiles);pageProfiles=r2.profiles.length;consecutiveEmpty=0;recentSkips=0;
            state.profilesScraped=allP.length;state.currentPage=cp;bc();
            addLog('info', 'Page '+cp+' retry ok: got '+r2.profiles.length+', total: '+allP.length);
            sendSheet(r2.profiles,cp,job.resultSheetUrl,job.tabName||'Sales Nav Scrape').catch(function(e){addLog('error','Async sheet err: '+e.message);});
          }else{
            /* === RETRY 2: Full page reload + waitForResults === */
            addLog('warn', 'Page '+cp+': still 0, trying full reload...');
            try{
              var retryUrl=new URL(job.salesNavUrl);
              retryUrl.searchParams.set('page',cp);
              await chrome.tabs.update(tab.id,{url:retryUrl.toString()});
              await waitTab(tab.id,20000);
              try{await chrome.tabs.setZoom(tab.id,0.25);}catch(ez){}
              await new Promise(function(r){setTimeout(r,3000);});
              try{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});}catch(e3){}
              await new Promise(function(r){setTimeout(r,1000);});
              /* Wait up to 20s for results to appear after full reload */
              try{var wr2=await tabMsg(tab.id,{action:'waitForResults',timeout:20000});addLog('info','Reload waitForResults: ready='+wr2.ready+' items='+wr2.items+' waited='+wr2.waited+'ms');
                /* Check for "Apply filters to find leads" empty state */
                if(wr2&&wr2.emptyState){
                  addLog('warn','Page '+cp+': empty state after reload ("'+(wr2.emptyMessage||'')+'")');
                  /* Try filter nudge first (faster than full reload) */
                  var nudgeFixed=false;
                  addLog('info','Trying filter nudge on page '+cp+'...');
                  try{
                    var nudgeR=await tabMsg(tab.id,{action:'nudgeFilters'});
                    if(nudgeR&&nudgeR.success){addLog('info','Filter nudge worked on page '+cp);nudgeFixed=true;}
                    else{addLog('warn','Filter nudge failed on page '+cp);}
                  }catch(en2){addLog('warn','Nudge error p'+cp+': '+en2.message);}
                  if(!nudgeFixed){
                  addLog('info','Waiting 60s then reloading page '+cp+'...');
                  await new Promise(function(r){setTimeout(r,rDelay(45000,75000));});
                  await chrome.tabs.update(tab.id,{url:retryUrl.toString()});await waitTab(tab.id,20000);
                  try{await chrome.tabs.setZoom(tab.id,0.25);}catch(ez2){}
                  await new Promise(function(r){setTimeout(r,5000);});
                  try{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});}catch(e4){}
                  await new Promise(function(r){setTimeout(r,1000);});
                  try{await tabMsg(tab.id,{action:'waitForResults',timeout:20000});}catch(ew3){}
                  }/* end if(!nudgeFixed) */
                }
              }catch(ew2){addLog('warn','Reload waitForResults err: '+ew2.message);await new Promise(function(r){setTimeout(r,8000);});}
              var r3=await tabMsg(tab.id,{action:'extractProfiles',slow:SLOW_MODE});
              if(r3&&r3.profiles&&r3.profiles.length>0){
                for(var i3=0;i3<r3.profiles.length;i3++)r3.profiles[i3].pageNumber=cp;
                allP=allP.concat(r3.profiles);pageProfiles=r3.profiles.length;consecutiveEmpty=0;recentSkips=0;
                state.profilesScraped=allP.length;state.currentPage=cp;bc();
                addLog('info', 'Page '+cp+' reload ok: got '+r3.profiles.length+', total: '+allP.length);
                sendSheet(r3.profiles,cp,job.resultSheetUrl,job.tabName||'Sales Nav Scrape').catch(function(e){addLog('error','Async sheet err: '+e.message);});
              }else{
                addLog('error', 'Page '+cp+': 0 after full reload + waitForResults');
                consecutiveEmpty++;
                skippedPages.push(cp);recentSkips++;
                if(recentSkips>=3){addLog('info','Cooldown 45s after '+recentSkips+' recent skips...');await new Promise(function(r){setTimeout(r,45000);});recentSkips=0;}
              }
              r2=r3;
            }catch(eReload){
              addLog('error', 'Page '+cp+' reload error: '+eReload.message);
              consecutiveEmpty++;
              skippedPages.push(cp);recentSkips++;
            }
          }
          r=r2;/* use retry result for pageInfo below */
        }
        /* Update totalR from latest page info (exact total from API overrides DOM "2K+") */
        if(r&&r.pageInfo&&r.pageInfo.totalResults>0){
          var newTotal=r.pageInfo.totalResults;
          if(newTotal!==totalR){
            addLog('info','totalR updated: '+totalR+' → '+newTotal+' from page '+cp);
            totalR=newTotal;
            state.totalResults=totalR;
            var nm=Math.min(Math.ceil(totalR/25),100);
            if(nm>0)maxPage=nm;
            addLog('info','maxPage updated to '+maxPage);
            bc();
          }
        }
      }catch(e){
        addLog('error','Error p'+cp+': '+e.message);
        consecutiveEmpty++;
        skippedPages.push(cp);recentSkips++;
        if(e.message&&(e.message.indexOf('Tab closed')!==-1||e.message.indexOf('disconnected')!==-1)){
          if(state.recoverRequested){addLog('info','Tab closed by recover — continuing to top-of-loop reopen');continue;}
          job.status='Error: Tab closed';
          notifyError('Batch interrupted at job '+(jn)+', page '+cp+'. You can resume from the extension.');
          saveState();stopSaveTimer();state.isRunning=false;bc();return;
        }
      }
      /* Decide whether to continue */
      var shouldContinue=false;
      var effectiveTotal=totalR>0?Math.min(totalR,2500):0;/* LinkedIn cap */
      if(skippedPages.length>=15){
        addLog('error', '15 pages skipped total, stopping main pass');
      }else if(effectiveTotal>0&&allP.length>=effectiveTotal){
        addLog('info', 'Collected all '+allP.length+(totalR>2500?' (LinkedIn limit, '+totalR+' total match)':' results'));
      }else if(effectiveTotal>0&&allP.length<effectiveTotal){
        /* We know the total and haven't reached it */
        shouldContinue=true;
      }else if(totalR===0&&allP.length>0&&skippedPages.length<10){
        /* Total unknown but we've been getting data — keep going */
        shouldContinue=true;
        addLog('info', 'totalR unknown, collected '+allP.length+' so far, continuing (skipped='+skippedPages.length+')');
      }else{
        /* Fallback: check Next button */
        var pi2;try{pi2=await tabMsg(tab.id,{action:'getPageInfo'});}catch(e){pi2={};}
        if(pi2.hasNextPage){shouldContinue=true;}
        else if(pi2.totalResults>0){
          /* Finally got totalResults from page — update and check */
          totalR=pi2.totalResults;
          if(allP.length<effectiveTotal){shouldContinue=true;addLog('info','Late totalR update: '+totalR+(totalR>2500?' (capped 2500)':''));}
          else{addLog('info', 'Collected all '+allP.length+' (late check)');}
        }else{addLog('info', 'No more pages (hasNext=false, totalR='+totalR+', collected='+allP.length+')');}
      }
      if(!shouldContinue){addLog('warn','STOPPING: totalR='+totalR+', collected='+allP.length+', skipped='+skippedPages.length+', consecutiveEmpty='+consecutiveEmpty+', cp='+cp+', maxPage='+maxPage);break;}
      await new Promise(function(r){setTimeout(r,pageDelay());});
      if(!state.isRunning)break;
      await waitWhilePaused();
      if(!state.isRunning)break;
      cp++;
      /* If previous page was empty, skip click nav — go straight to URL nav */
      var navOk=false;
      if(pageProfiles>0){
        try{
          var nr=await tabMsg(tab.id,{action:'goToNextPage'});
          if(nr&&nr.success){await waitNav(tab.id);navOk=true;}
          else{addLog('warn','Next button not found on page '+(cp-1));}
        }catch(e){addLog('warn','Next click error: '+e.message);}
      }else{addLog('info','Skipping click nav (empty page), using URL nav');}
      if(!navOk){
        try{
          addLog('info','URL nav to page '+cp);
          await tabMsg(tab.id,{action:'navigateToPage',page:cp,baseUrl:job.salesNavUrl});
          await waitNav(tab.id);navOk=true;
        }catch(e){
          addLog('warn','URL nav failed: '+e.message+', trying full reload');
          try{
            var reloadUrl=new URL(job.salesNavUrl);
            reloadUrl.searchParams.set('page',cp);
            await chrome.tabs.update(tab.id,{url:reloadUrl.toString()});
            await waitTab(tab.id,20000);navOk=true;
            addLog('info','Full reload to page '+cp+' ok');
          }catch(e2){addLog('error','Full reload failed: '+e2.message);if(state.recoverRequested)continue;break;}
        }
      }
      if(navOk){
        try{await chrome.tabs.setZoom(tab.id,0.25);}catch(e){}
        await new Promise(function(r){setTimeout(r,getDelay(300,800));});
        try{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});}catch(e){}
        await new Promise(function(r){setTimeout(r,getDelay(150,400));});
        /* Wait for results DOM to be ready before next extraction loop */
        try{await tabMsg(tab.id,{action:'waitForResults',timeout:15000});}catch(ew){}
      }
    }
    /* ═══ RETRY PASS: Go back for skipped pages ═══ */
    if(skippedPages.length>0&&state.isRunning){
      addLog('info','Retry pass: '+skippedPages.length+' skipped pages ['+skippedPages.join(',')+']');
      var recovered=0;
      for(var si=0;si<skippedPages.length&&state.isRunning;si++){
        await waitWhilePaused();
        if(!state.isRunning)break;
        var sp=skippedPages[si];
        addLog('info','Retrying page '+sp+'...');
        try{
          var spUrl=new URL(job.salesNavUrl);
          spUrl.searchParams.set('page',sp);
          await chrome.tabs.update(tab.id,{url:spUrl.toString()});
          await waitTab(tab.id,20000);
          try{await chrome.tabs.setZoom(tab.id,0.25);}catch(e){}
          await new Promise(function(r){setTimeout(r,3000);});
          try{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});}catch(e){}
          await new Promise(function(r){setTimeout(r,1000);});
          /* Wait for results to render — critical for retry pass success */
          try{await tabMsg(tab.id,{action:'waitForResults',timeout:20000});}catch(ew){}
          var rr=await tabMsg(tab.id,{action:'extractProfiles',slow:SLOW_MODE});
          if(rr&&rr.profiles&&rr.profiles.length>0){
            for(var ri=0;ri<rr.profiles.length;ri++)rr.profiles[ri].pageNumber=sp;
            allP=allP.concat(rr.profiles);recovered+=rr.profiles.length;
            state.profilesScraped=allP.length;bc();
            addLog('info','Retry page '+sp+': got '+rr.profiles.length+', total now '+allP.length);
            sendSheet(rr.profiles,sp,job.resultSheetUrl,job.tabName||'Sales Nav Scrape').catch(function(e){addLog('error','Async sheet err: '+e.message);});
          }else{addLog('warn','Retry page '+sp+': still 0');}
        }catch(e){addLog('error','Retry page '+sp+' error: '+e.message);}
        await new Promise(function(r){setTimeout(r,pageDelay());});
      }
      addLog('info','Retry pass done: recovered '+recovered+' from '+skippedPages.length+' pages');
    }
    addLog('info', 'Job '+(jn)+' done: '+allP.length+' profiles, '+cp+' pages (totalR='+totalR+(totalR>2500?', capped at 2500':'')+')'+( skippedPages.length?' ('+skippedPages.length+' skipped)':''));
    try{await chrome.tabs.setZoom(tab.id,0.75);}catch(e){}
    try{await chrome.tabs.remove(tab.id);}catch(e){}
    if(totalR>2500&&allP.length>=2500){
      job.status='Done ('+allP.length+' of '+totalR+', LinkedIn limit)';
    }else if(totalR>0&&allP.length<Math.min(totalR,2500)&&allP.length>0){
      /* Tolerate small shortfalls — typically anonymized profiles the searcher's account
       * can't see (out-of-network / privacy-restricted). Only flag Partial for meaningful gaps. */
      var expected=Math.min(totalR,2500);
      var deficit=expected-allP.length;
      if(deficit<=Math.max(5,Math.ceil(expected*0.02))){
        job.status='Done ('+allP.length+' of '+expected+', '+deficit+' missing)';
      }else{
        job.status='Partial ('+allP.length+'/'+expected+')';
      }
    }else if(totalR===0&&skippedPages.length>=15&&allP.length>0){
      job.status='Partial ('+allP.length+', stopped after '+skippedPages.length+' skipped pages)';
    }else{
      job.status='Done ('+allP.length+')';
    }
    job.profilesScraped=allP.length;
    /* Write result sheet link back to source sheet */
    if(state.outputColIdx>0&&state.srcSheetUrl&&state.srcTabName&&job.row){
      try{
        await writeBackLink(state.srcSheetUrl,state.srcTabName,job.row,state.outputColIdx,job.resultSheetUrl);
        addLog('info','Wrote back link to row '+job.row+' col '+state.outputColIdx);
      }catch(e){addLog('error','Write-back error: '+e.message);}
    }
  }catch(e){
    job.status='Error: '+e.message;
    try{if(state.tabId){try{await chrome.tabs.setZoom(state.tabId,0.75);}catch(e){}await chrome.tabs.remove(state.tabId);}}catch(x){}
  }
  bc();
  if(state.isRunning){await new Promise(function(r){setTimeout(r,rDelay(5000,10000));});await waitWhilePaused();if(state.isRunning)nextJob();}
}

function stopBatch(){
  state.isRunning=false;state.isPaused=false;state.recoverRequested=false;state.retryQueue=[];state.endTime=Date.now();stopSaveTimer();clearSavedState();
  if(state.currentJobIndex>=0&&state.currentJobIndex<state.jobs.length){
    state.jobs[state.currentJobIndex].status='Stopped';
  }
  try{if(state.tabId){try{chrome.tabs.setZoom(state.tabId,0.75);}catch(e){}chrome.tabs.remove(state.tabId);}}catch(e){}
  chrome.action.setBadgeText({text:''});bc();
}

/* ─── NOTIFICATIONS ─── */
function notifyError(msg){
  try{
    chrome.notifications.create('ortus-error-'+Date.now(),{
      type:'basic',title:'Ortus Scraper',message:msg,
      iconUrl:'icons/icon128.png',priority:2
    });
  }catch(e){addLog('error','Notification error: '+e.message);}
  chrome.action.setBadgeBackgroundColor({color:'#f75f5f'});
  chrome.action.setBadgeText({text:'!'});
}

/* ─── SHEET API ─── */
async function sendSheet(profiles,pg,sheetUrl,sheetName){
  var payload={action:'writeProfiles',sheetUrl:sheetUrl,tabName:sheetName,profiles:profiles,pageNumber:pg};
  try{
    var r=await fetch(WEB_APP_URL,{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify(payload)});
    return await r.json();
  }
  catch(e){addLog('error','Sheet err: '+e.message);return null;}
}

async function writeBackLink(srcUrl,srcTab,row,col,value){
  var payload={action:'writeBackLink',sheetUrl:srcUrl,tabName:srcTab,row:row,col:col,value:value};
  try{var r=await fetch(WEB_APP_URL,{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify(payload)});return await r.json();}
  catch(e){addLog('error','WriteBack err: '+e.message);return null;}
}

/* ─── HELPERS ─── */
function tabMsg(tid,msg,timeoutMs){
  var to=(typeof timeoutMs==='number'&&timeoutMs>0)?timeoutMs:60000;
  return new Promise(function(res,rej){
    var done=false;
    var t=setTimeout(function(){if(done)return;done=true;rej(new Error('tabMsg timeout after '+to+'ms — tab frozen? action='+(msg&&msg.action)));},to);
    chrome.tabs.sendMessage(tid,msg,function(r){
      if(done)return;done=true;clearTimeout(t);
      if(chrome.runtime.lastError)rej(new Error(chrome.runtime.lastError.message));
      else res(r);
    });
  });
}

function waitTab(tid,to){
  to=to||15000;
  return new Promise(function(res,rej){
    var st=Date.now();
    function ck(){if(Date.now()-st>to){res();return;}chrome.tabs.get(tid,function(t){if(chrome.runtime.lastError||!t){rej(new Error('Tab closed'));return;}if(t.status==='complete')setTimeout(res,1500);else setTimeout(ck,500);});}
    ck();
  });
}

function waitNav(tid,to){
  to=to||20000;
  return new Promise(function(res){
    var done=false;
    var fn=function(id,info){if(id===tid&&info.status==='complete'){chrome.tabs.onUpdated.removeListener(fn);if(!done){done=true;setTimeout(res,2000);}}};
    chrome.tabs.onUpdated.addListener(fn);
    setTimeout(function(){chrome.tabs.onUpdated.removeListener(fn);if(!done){done=true;res();}},to);
  });
}

function toCSV(ps){
  if(!ps.length)return '';
  var h=['Record ID','First Name','Last Name','Domain','Priority (Company)','Priority (Role)','Priority','Lead Status','Company Name','Job Title','Linkedin Bio','First Phone','First Phone Value','Phone Number','Whatsapp Link','Mobile Phone Number','Email','Email Verification','LinkedIn Membership ID','Location','Notes','Secondary Email','Hubspot URL','Ortus Members','Current Tag','Open Profile','Premium','Linkedin First Connection','Client Lead Status','Apollo Contact ID','ID Check'];
  var rows=ps.map(function(p){return['',p.firstName||'',p.lastName||'','','','','','',p.company||'',p.jobTitle||'',p.publicUrl||p.profileUrl||'','','','','','',p.linkedinEmail||'','',(p.membershipId||'').toString(),p.location||'','','','','','',p.openProfile||'No',p.premium||'Unknown','','','',p.idUnverified||''].map(function(v){return '"'+String(v||'').replace(/"/g,'""')+'"';}).join(',');});
  return[h.join(',')].concat(rows).join('\n');
}

/* Detect tab close during scrape */
chrome.tabs.onRemoved.addListener(function(tid){
  if(state.isRunning&&state.tabId===tid){
    if(state.mode==='single'){
      notifyError('Scraping tab was closed on page '+state.currentPage+'. Open the extension to resume.');
      saveState();stopSaveTimer();state.isRunning=false;bc();
    }
    /* For batch, the nextJob loop handles tab close errors */
  }
});

/* On service worker startup, check if there was an interrupted scrape */
chrome.runtime.onStartup.addListener(function(){
  chrome.storage.local.get('ortus_saved_state',function(d){
    if(d.ortus_saved_state&&d.ortus_saved_state.interrupted){
      chrome.action.setBadgeBackgroundColor({color:'#f7943e'});
      chrome.action.setBadgeText({text:'!'});
    }
  });
});
