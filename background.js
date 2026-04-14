var WEB_APP_URL = "https://script.google.com/macros/s/AKfycbyW3i2O8ZOCO1mpGmUnu2sLeCXWI9n0HrFCE8ZZ2dzf27SRVNELKL85vxpKLM0-b3_k/exec";
var DELAY_MIN_FAST = 2000;
var DELAY_MAX_FAST = 4000;
var DELAY_MIN_SLOW = 6000;
var DELAY_MAX_SLOW = 10000;
var SLOW_MODE = false; /* Toggled from popup for older machines */
/* Load slow mode setting on startup */
chrome.storage.local.get('ortus_slow_mode',function(d){ if(d) SLOW_MODE=!!d.ortus_slow_mode; });

function getDelay(fast,slow){ return SLOW_MODE ? slow : fast; }
function pageDelay(){ return rDelay(SLOW_MODE?DELAY_MIN_SLOW:DELAY_MIN_FAST, SLOW_MODE?DELAY_MAX_SLOW:DELAY_MAX_FAST); }
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
  mode: null, isRunning: false, isPaused: false,
  tabId: null, currentPage: 0, totalPages: 0, totalResults: 0,
  profilesScraped: 0, allProfiles: [], errors: [],
  startTime: null, endTime: null, sheetUrl: '', sheetName: '',
  jobs: [], currentJobIndex: -1,
  salesNavUrl: '',
  srcSheetUrl: '', srcTabName: '', outputColIdx: -1,
};

var saveTimer = null;

function rDelay(a,b){return Math.floor(Math.random()*(b-a+1))+a;}

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
    case 'readTabs':readTabs(msg.sheetUrl).then(sendResponse);return true;
    case 'readColumns':readColumns(msg.sheetUrl,msg.tabName).then(sendResponse);return true;
    case 'setJobs':setJobs(msg);sendResponse({ok:true});break;
    case 'startBatch':startBatch().then(sendResponse);return true;
    case 'stopBatch':stopBatch();sendResponse({ok:true});break;
    /* Persistence / resume */
    case 'checkSavedState':checkSavedState().then(sendResponse);return true;
    case 'clearSavedState':clearSavedState().then(sendResponse);return true;
    case 'resumeInterrupted':resumeInterrupted().then(sendResponse);return true;
    case 'getLogs':sendResponse({logs:logBuffer});break;
    case 'clearLogs':logBuffer=[];chrome.storage.session.remove('ortus_logs');sendResponse({ok:true});break;
    case 'setSlowMode':SLOW_MODE=!!msg.slow;addLog('info','Slow mode: '+(SLOW_MODE?'ON':'OFF'));sendResponse({ok:true});break;
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
  state={mode:null,isRunning:false,isPaused:false,tabId:null,currentPage:0,totalPages:0,totalResults:0,
    profilesScraped:0,allProfiles:[],errors:[],startTime:null,endTime:null,sheetUrl:'',sheetName:'',
    jobs:[],currentJobIndex:-1,salesNavUrl:'',srcSheetUrl:'',srcTabName:'',outputColIdx:-1};
  chrome.action.setBadgeText({text:''});
  stopSaveTimer();
}

function bc(){chrome.runtime.sendMessage({action:'stateUpdate',state:pubState()}).catch(function(){});}

/* ─── PERSISTENCE ─── */
function startSaveTimer(){
  stopSaveTimer();
  saveTimer=setInterval(function(){saveState();},SAVE_INTERVAL);
}
function stopSaveTimer(){if(saveTimer){clearInterval(saveTimer);saveTimer=null;}}

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
      var win=await chrome.windows.create({url:resumeUrl,focused:false,width:1280,height:900});
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
      try{await tabMsg(tid,{action:'navigateToPage',page:state.currentPage});await waitNav(tid);runSinglePage();}catch(e){
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

async function startBatch(){
  if(state.isRunning)return{ok:false,error:'Running'};
  state.mode='batch';state.isRunning=true;state.startTime=Date.now();state.currentJobIndex=-1;
  chrome.action.setBadgeBackgroundColor({color:'#1a73e8'});
  startSaveTimer();nextJob();return{ok:true};
}

async function nextJob(){
  if(!state.isRunning)return;
  state.currentJobIndex++;
  while(state.currentJobIndex<state.jobs.length){
    var s=state.jobs[state.currentJobIndex].status;
    if(!s||s==='Pending')break;
    state.currentJobIndex++;
  }
  if(state.currentJobIndex>=state.jobs.length){
    state.isRunning=false;state.endTime=Date.now();stopSaveTimer();clearSavedState();
    chrome.action.setBadgeBackgroundColor({color:'#1e8e3e'});chrome.action.setBadgeText({text:'\u2713'});
    setTimeout(function(){chrome.action.setBadgeText({text:''});},30000);bc();return;
  }
  var job=state.jobs[state.currentJobIndex];var jn=state.currentJobIndex+1;var tot=state.jobs.length;
  chrome.action.setBadgeText({text:jn+'/'+tot});bc();
  job.status='Running';
  try{
    var win=await chrome.windows.create({url:job.salesNavUrl,focused:false,width:1280,height:900});var tab=win.tabs[0];
    state.tabId=tab.id;await waitTab(tab.id,20000);
    try{await chrome.tabs.setZoom(tab.id,0.25);}catch(e){addLog('warn','Zoom err: '+e.message);}
    await new Promise(function(r){setTimeout(r,getDelay(3000,8000));});
    try{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});}catch(e){}
    await new Promise(function(r){setTimeout(r,getDelay(500,2000));});
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
      chrome.action.setBadgeText({text:jn+':p'+cp});bc();
      var pageProfiles=0;
      try{
        /* === STEP A: Wait for content to render, then extract === */
        try{await tabMsg(tab.id,{action:'waitForResults',timeout:15000});}catch(ew){}
        var r=await tabMsg(tab.id,{action:'extractProfiles',slow:SLOW_MODE});
        if(r&&r.profiles&&r.profiles.length>0){
          for(var i=0;i<r.profiles.length;i++)r.profiles[i].pageNumber=cp;
          allP=allP.concat(r.profiles);pageProfiles=r.profiles.length;consecutiveEmpty=0;recentSkips=0;
          state.profilesScraped=allP.length;state.currentPage=cp;bc();
          addLog('info', 'Page '+cp+': got '+r.profiles.length+', total: '+allP.length+(r.pageInfo?' (pageTotal='+r.pageInfo.totalResults+')':''));
          /* === PARTIAL PAGE RETRY: LinkedIn shows exactly 25 per non-last page === */
          if(pageProfiles>0&&pageProfiles<25&&cp<maxPage){
            addLog('warn','Page '+cp+': only '+pageProfiles+'/25 profiles (not last page), retrying until 25...');
            var realRetries=0;var maxRealRetries=5;/* Only counts actual extraction attempts, not empty state hits */
            var emptyHits=0;var maxEmptyHits=10;/* Safety cap on empty state loops */
            var totalAttempts=0;var maxTotalAttempts=15;/* Absolute cap */
            while(pageProfiles<25&&realRetries<maxRealRetries&&emptyHits<maxEmptyHits&&totalAttempts<maxTotalAttempts&&state.isRunning){
              totalAttempts++;
              /* Wait before reload — shorter for empty state retries, longer for real retries */
              var partialWait=emptyHits>0?rDelay(10000,20000):rDelay(30000,60000);
              addLog('info','Page '+cp+' retry #'+totalAttempts+' (real='+realRetries+', empty='+emptyHits+'): waiting '+Math.round(partialWait/1000)+'s...');
              await new Promise(function(r){setTimeout(r,partialWait);});
              if(!state.isRunning)break;
              try{
                /* Full page reload */
                var partialUrl=new URL(job.salesNavUrl);
                partialUrl.searchParams.set('page',cp);
                await chrome.tabs.update(tab.id,{url:partialUrl.toString()});
                await waitTab(tab.id,20000);
                try{await chrome.tabs.setZoom(tab.id,0.25);}catch(ez){}
                await new Promise(function(r){setTimeout(r,3000);});
                try{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});}catch(e){}
                await new Promise(function(r){setTimeout(r,1000);});
                /* Check for empty state — if hit, fix it before counting as a real retry */
                var pageReady=true;
                try{
                  var esP=await tabMsg(tab.id,{action:'checkEmptyState'});
                  if(esP&&esP.emptyState){
                    emptyHits++;
                    addLog('warn','Page '+cp+': empty state #'+emptyHits+' ("'+esP.message+'"), nudging...');
                    /* Try nudge to clear the empty state */
                    var nudgeOk=false;
                    try{var nR=await tabMsg(tab.id,{action:'nudgeFilters'});nudgeOk=!!(nR&&nR.success);}catch(en3){}
                    if(nudgeOk){
                      addLog('info','Nudge cleared empty state on page '+cp);
                    }else{
                      /* Nudge failed — reload again within same attempt */
                      addLog('info','Nudge failed, reloading page '+cp+' again...');
                      await new Promise(function(r){setTimeout(r,rDelay(5000,10000));});
                      await chrome.tabs.update(tab.id,{url:partialUrl.toString()});
                      await waitTab(tab.id,20000);
                      try{await chrome.tabs.setZoom(tab.id,0.25);}catch(ez2){}
                      await new Promise(function(r){setTimeout(r,5000);});
                      try{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});}catch(e2){}
                      await new Promise(function(r){setTimeout(r,1000);});
                      /* Check again */
                      try{
                        var esP2=await tabMsg(tab.id,{action:'checkEmptyState'});
                        if(esP2&&esP2.emptyState){
                          addLog('warn','Page '+cp+': still empty after reload+nudge+reload, looping...');
                          pageReady=false;
                        }
                      }catch(e3){}
                    }
                  }
                }catch(eCheck){}
                if(!pageReady)continue;/* Don't count as real retry — page never loaded */
                /* Page is ready — try extraction */
                try{await tabMsg(tab.id,{action:'waitForResults',timeout:20000});}catch(ew){}
                var rP=await tabMsg(tab.id,{action:'extractProfiles',slow:SLOW_MODE});
                realRetries++;/* NOW count it — we actually attempted extraction */
                if(rP&&rP.profiles&&rP.profiles.length>=25){
                  /* Got full page — replace old partial */
                  allP=allP.filter(function(p){return p.pageNumber!==cp;});
                  for(var ip=0;ip<rP.profiles.length;ip++)rP.profiles[ip].pageNumber=cp;
                  allP=allP.concat(rP.profiles);pageProfiles=rP.profiles.length;
                  state.profilesScraped=allP.length;bc();
                  addLog('info','Page '+cp+' retry success: got '+rP.profiles.length+' (total: '+allP.length+')');
                  r=rP;
                }else if(rP&&rP.profiles&&rP.profiles.length>pageProfiles){
                  /* Got more than before but still < 25 — update and keep trying */
                  allP=allP.filter(function(p){return p.pageNumber!==cp;});
                  for(var ip2=0;ip2<rP.profiles.length;ip2++)rP.profiles[ip2].pageNumber=cp;
                  allP=allP.concat(rP.profiles);pageProfiles=rP.profiles.length;
                  state.profilesScraped=allP.length;bc();
                  addLog('info','Page '+cp+' retry: improved to '+rP.profiles.length+'/25 (total: '+allP.length+'), continuing...');
                  r=rP;
                }else{
                  addLog('warn','Page '+cp+' retry: still '+(rP&&rP.profiles?rP.profiles.length:0)+'/25');
                }
              }catch(ePartial){addLog('error','Page '+cp+' retry error: '+ePartial.message);}
            }
            if(pageProfiles<25){
              addLog('warn','Page '+cp+': could not get 25 after '+totalAttempts+' attempts (real='+realRetries+', empty='+emptyHits+'), adding to skipped for end retry');
              skippedPages.push(cp);
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
          await tabMsg(tab.id,{action:'navigateToPage',page:cp});
          await waitNav(tab.id);navOk=true;
        }catch(e){
          addLog('warn','URL nav failed: '+e.message+', trying full reload');
          try{
            var reloadUrl=new URL(job.salesNavUrl);
            reloadUrl.searchParams.set('page',cp);
            await chrome.tabs.update(tab.id,{url:reloadUrl.toString()});
            await waitTab(tab.id,20000);navOk=true;
            addLog('info','Full reload to page '+cp+' ok');
          }catch(e2){addLog('error','Full reload failed: '+e2.message);break;}
        }
      }
      if(navOk){
        try{await chrome.tabs.setZoom(tab.id,0.25);}catch(e){}
        await new Promise(function(r){setTimeout(r,getDelay(1000,4000));});
        try{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});}catch(e){}
        await new Promise(function(r){setTimeout(r,getDelay(500,2000));});
        /* Wait for results DOM to be ready before next extraction loop */
        try{await tabMsg(tab.id,{action:'waitForResults',timeout:15000});}catch(ew){}
      }
    }
    /* ═══ RETRY PASS: Go back for skipped pages ═══ */
    if(skippedPages.length>0&&state.isRunning){
      addLog('info','Retry pass: '+skippedPages.length+' skipped pages ['+skippedPages.join(',')+']');
      var recovered=0;
      for(var si=0;si<skippedPages.length&&state.isRunning;si++){
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
      job.status='Partial ('+allP.length+'/'+Math.min(totalR,2500)+')';
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
  if(state.isRunning){await new Promise(function(r){setTimeout(r,rDelay(5000,10000));});nextJob();}
}

function stopBatch(){
  state.isRunning=false;state.endTime=Date.now();stopSaveTimer();clearSavedState();
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
  try{var r=await fetch(WEB_APP_URL,{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify(payload)});return await r.json();}
  catch(e){addLog('error','Sheet err: '+e.message);return null;}
}

async function writeBackLink(srcUrl,srcTab,row,col,value){
  /* Try direct Google Sheets API first (uses user's own Google account) */
  try{
    var result=await writeBackDirect(srcUrl,srcTab,row,col,value);
    if(result)return result;
  }catch(e){addLog('warn','Direct write-back failed: '+e.message+', falling back to Apps Script');}
  /* Fallback to Apps Script */
  var payload={action:'writeBackLink',sheetUrl:srcUrl,tabName:srcTab,row:row,col:col,value:value};
  try{var r=await fetch(WEB_APP_URL,{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify(payload)});return await r.json();}
  catch(e){addLog('error','WriteBack err: '+e.message);return null;}
}

/* ─── DIRECT GOOGLE SHEETS API (uses user's own OAuth token) ─── */
function extractSheetId(url){
  var m=url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m?m[1]:null;
}

function colIdxToLetter(idx){
  /* Convert 1-based column index to letter: 1=A, 2=B, 27=AA */
  var s='';
  while(idx>0){idx--;s=String.fromCharCode(65+(idx%26))+s;idx=Math.floor(idx/26);}
  return s;
}

async function getGoogleToken(){
  return new Promise(function(resolve,reject){
    chrome.identity.getAuthToken({interactive:true},function(token){
      if(chrome.runtime.lastError){
        reject(new Error(chrome.runtime.lastError.message));
      }else{
        resolve(token);
      }
    });
  });
}

async function writeBackDirect(srcUrl,srcTab,row,col,value){
  var sheetId=extractSheetId(srcUrl);
  if(!sheetId){addLog('warn','Could not extract sheet ID from: '+srcUrl);return null;}
  var token=await getGoogleToken();
  if(!token){addLog('warn','No Google token available');return null;}
  var colLetter=colIdxToLetter(col);
  var range=encodeURIComponent("'"+srcTab+"'!"+colLetter+row);
  var apiUrl='https://sheets.googleapis.com/v4/spreadsheets/'+sheetId+'/values/'+range+'?valueInputOption=USER_ENTERED';
  var resp=await fetch(apiUrl,{
    method:'PUT',
    headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify({range:"'"+srcTab+"'!"+colLetter+row,majorDimension:'ROWS',values:[[value]]})
  });
  if(resp.status===401){
    /* Token expired — clear and retry once */
    addLog('info','Google token expired, refreshing...');
    await new Promise(function(resolve){chrome.identity.removeCachedAuthToken({token:token},resolve);});
    token=await getGoogleToken();
    resp=await fetch(apiUrl,{
      method:'PUT',
      headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},
      body:JSON.stringify({range:"'"+srcTab+"'!"+colLetter+row,majorDimension:'ROWS',values:[[value]]})
    });
  }
  if(!resp.ok){
    var errText=await resp.text();
    throw new Error('Sheets API '+resp.status+': '+errText.substring(0,200));
  }
  addLog('info','Direct write-back OK: '+srcTab+'!'+colLetter+row);
  return{success:true};
}

/* ─── HELPERS ─── */
function tabMsg(tid,msg){return new Promise(function(res,rej){chrome.tabs.sendMessage(tid,msg,function(r){if(chrome.runtime.lastError)rej(new Error(chrome.runtime.lastError.message));else res(r);});});}

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
  var h=['Record ID','First Name','Last Name','Domain','Priority (Company)','Priority (Role)','Priority','Lead Status','Company Name','Job Title','Linkedin Bio','First Phone','First Phone Value','Phone Number','Whatsapp Link','Mobile Phone Number','Email','Email Verification','LinkedIn Membership ID','Location','Notes','Secondary Email','Hubspot URL','Ortus Members','Current Tag','Open Profile','Premium','Linkedin First Connection','Client Lead Status','Apollo Contact ID'];
  var rows=ps.map(function(p){return['',p.firstName||'',p.lastName||'','','','','','',p.company||'',p.jobTitle||'',p.publicUrl||p.profileUrl||'','','','','','',p.linkedinEmail||'','',(p.membershipId||'').toString(),p.location||'','','','','','',p.openProfile||'No',p.premium||'Unknown','','',''].map(function(v){return '"'+String(v||'').replace(/"/g,'""')+'"';}).join(',');});
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
