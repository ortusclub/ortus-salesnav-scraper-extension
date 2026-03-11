var WEB_APP_URL = "https://script.google.com/macros/s/AKfycbyW3i2O8ZOCO1mpGmUnu2sLeCXWI9n0HrFCE8ZZ2dzf27SRVNELKL85vxpKLM0-b3_k/exec";
var DELAY_MIN = 4000;
var DELAY_MAX = 7000;
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
    /* Ensure results are loaded before extracting */
    await waitContentReady(tid,15000);
    var r=await tabMsg(tid,{action:'extractProfiles'});
    if(r&&r.profiles){
      for(var i=0;i<r.profiles.length;i++)r.profiles[i].pageNumber=pg;
      state.allProfiles=state.allProfiles.concat(r.profiles);state.profilesScraped+=r.profiles.length;
      if(r.pageInfo&&r.pageInfo.totalPages>0){state.totalPages=r.pageInfo.totalPages;state.totalResults=r.pageInfo.totalResults;}
      if(state.sheetUrl)sendSheet(r.profiles,pg,state.sheetUrl,state.sheetName).catch(function(e){addLog('error','Async sheet err: '+e.message);});
    }
    bc();
    var pi=await tabMsg(tid,{action:'getPageInfo'});
    if(!pi.hasNextPage||(state.totalPages>0&&pg>=state.totalPages)){finishScrape();return;}
    await new Promise(function(r){setTimeout(r,rDelay(DELAY_MIN,DELAY_MAX));});
    if(!state.isRunning||state.isPaused)return;
    state.currentPage=pg+1;
    await tabMsg(tid,{action:'goToNextPage'});await waitNav(tid);
    try{await chrome.scripting.executeScript({target:{tabId:tid},files:['content.js']});}catch(e){}
    await waitContentReady(tid,15000);
    runSinglePage();
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
    await new Promise(function(r){setTimeout(r,8000);});
    try{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});}catch(e){}
    await new Promise(function(r){setTimeout(r,1000);});
    /* Wait for content to be ready before getting page info */
    await waitContentReady(tab.id,15000);
    var pi;try{pi=await tabMsg(tab.id,{action:'getPageInfo'});}catch(e){pi={totalPages:1,hasNextPage:false,currentPage:1};}
    var totalR=pi.totalResults||0;
    /* If totalR is 0, try a full reload — page may not have loaded properly */
    if(totalR===0){
      addLog('warn','Job '+(jn)+': totalR=0 on first load, trying full reload...');
      try{
        await chrome.tabs.update(tab.id,{url:job.salesNavUrl});
        await waitTab(tab.id,20000);
        try{await chrome.tabs.setZoom(tab.id,0.25);}catch(e){}
        await new Promise(function(r){setTimeout(r,8000);});
        try{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});}catch(e){}
        await new Promise(function(r){setTimeout(r,2000);});
        await waitContentReady(tab.id,15000);
        try{pi=await tabMsg(tab.id,{action:'getPageInfo'});}catch(e){pi={totalPages:1,hasNextPage:false,currentPage:1};}
        totalR=pi.totalResults||0;
        addLog('info','After reload: totalR='+totalR);
      }catch(e){addLog('error','First page reload error: '+e.message);}
    }
    state.totalResults=totalR;state.profilesScraped=0;state.currentPage=1;bc();
    var maxPage=totalR>0?Math.min(Math.ceil(totalR/25),100):100;/* LinkedIn caps at 2500/100 pages */
    addLog('info','Job '+(jn)+': '+totalR+' results'+(totalR>2500?' (capped at 2500)':'')+', maxPage='+maxPage+', hasNext='+(pi.hasNextPage||false));
    var allP=[];var cp=1;var consecutiveEmpty=0;
    while(cp<=maxPage&&state.isRunning){
      chrome.action.setBadgeText({text:jn+':p'+cp});bc();
      var pageProfiles=0;
      try{
        var r=await tabMsg(tab.id,{action:'extractProfiles'});
        if(r&&r.profiles&&r.profiles.length>0){
          for(var i=0;i<r.profiles.length;i++)r.profiles[i].pageNumber=cp;
          allP=allP.concat(r.profiles);pageProfiles=r.profiles.length;consecutiveEmpty=0;
          state.profilesScraped=allP.length;state.currentPage=cp;bc();
          addLog('info', 'Page '+cp+': got '+r.profiles.length+', total: '+allP.length+(r.pageInfo?' (pageTotal='+r.pageInfo.totalResults+')':''));
          sendSheet(r.profiles,cp,job.resultSheetUrl,job.tabName||'Sales Nav Scrape').catch(function(e){addLog('error','Async sheet err: '+e.message);});
        }else{
          addLog('warn', 'Page '+cp+': 0 profiles, retrying with re-inject...');
          await new Promise(function(r){setTimeout(r,3000);});
          try{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});}catch(e){}
          await new Promise(function(r){setTimeout(r,1000);});
          var r2=await tabMsg(tab.id,{action:'extractProfiles'});
          if(r2&&r2.profiles&&r2.profiles.length>0){
            for(var i2=0;i2<r2.profiles.length;i2++)r2.profiles[i2].pageNumber=cp;
            allP=allP.concat(r2.profiles);pageProfiles=r2.profiles.length;consecutiveEmpty=0;
            state.profilesScraped=allP.length;state.currentPage=cp;bc();
            addLog('info', 'Page '+cp+' retry ok: got '+r2.profiles.length+', total: '+allP.length);
            sendSheet(r2.profiles,cp,job.resultSheetUrl,job.tabName||'Sales Nav Scrape').catch(function(e){addLog('error','Async sheet err: '+e.message);});
          }else{
            /* Retry 2: full page reload */
            addLog('warn', 'Page '+cp+': still 0, trying full reload...');
            try{
              var retryUrl=new URL(job.salesNavUrl);
              retryUrl.searchParams.set('page',cp);
              await chrome.tabs.update(tab.id,{url:retryUrl.toString()});
              await waitTab(tab.id,20000);
              try{await chrome.tabs.setZoom(tab.id,0.25);}catch(ez){}
              await new Promise(function(r){setTimeout(r,5000);});
              try{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});}catch(e3){}
              await new Promise(function(r){setTimeout(r,2000);});
              await waitContentReady(tab.id,15000);
              var r3=await tabMsg(tab.id,{action:'extractProfiles'});
              if(r3&&r3.profiles&&r3.profiles.length>0){
                for(var i3=0;i3<r3.profiles.length;i3++)r3.profiles[i3].pageNumber=cp;
                allP=allP.concat(r3.profiles);pageProfiles=r3.profiles.length;consecutiveEmpty=0;
                state.profilesScraped=allP.length;state.currentPage=cp;bc();
                addLog('info', 'Page '+cp+' reload ok: got '+r3.profiles.length+', total: '+allP.length);
                sendSheet(r3.profiles,cp,job.resultSheetUrl,job.tabName||'Sales Nav Scrape').catch(function(e){addLog('error','Async sheet err: '+e.message);});
              }else{
                addLog('error', 'Page '+cp+': 0 after full reload');
                consecutiveEmpty++;
              }
              r2=r3;
            }catch(eReload){
              addLog('error', 'Page '+cp+' reload error: '+eReload.message);
              consecutiveEmpty++;
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
        if(e.message&&(e.message.indexOf('Tab closed')!==-1||e.message.indexOf('disconnected')!==-1)){
          job.status='Error: Tab closed';
          notifyError('Batch interrupted at job '+(jn)+', page '+cp+'. You can resume from the extension.');
          saveState();stopSaveTimer();state.isRunning=false;bc();return;
        }
      }
      /* Decide whether to continue */
      var shouldContinue=false;
      var effectiveTotal=totalR>0?Math.min(totalR,2500):0;/* LinkedIn cap */
      if(consecutiveEmpty>=5){
        addLog('error', '5 consecutive empty pages, stopping');
      }else if(effectiveTotal>0&&allP.length>=effectiveTotal){
        addLog('info', 'Collected all '+allP.length+(totalR>2500?' (LinkedIn limit, '+totalR+' total match)':' results'));
      }else if(effectiveTotal>0&&allP.length<effectiveTotal){
        /* We know the total and haven't reached it */
        shouldContinue=true;
      }else if(totalR===0&&allP.length>0&&consecutiveEmpty<3){
        /* Total unknown but we've been getting data — keep going */
        shouldContinue=true;
        addLog('info', 'totalR unknown, collected '+allP.length+' so far, continuing (empty='+consecutiveEmpty+')');
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
      if(!shouldContinue){addLog('warn','STOPPING: totalR='+totalR+', collected='+allP.length+', consecutiveEmpty='+consecutiveEmpty+', cp='+cp+', maxPage='+maxPage);break;}
      await new Promise(function(r){setTimeout(r,rDelay(DELAY_MIN,DELAY_MAX));});
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
        await new Promise(function(r){setTimeout(r,2000);});
        try{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});}catch(e){}
        await new Promise(function(r){setTimeout(r,1000);});
        /* Wait for results to actually appear before extracting */
        await waitContentReady(tab.id,15000);
      }
    }
    addLog('info', 'Job '+(jn)+' done: '+allP.length+' profiles, '+cp+' pages (totalR='+totalR+(totalR>2500?', capped at 2500':'')+')');
    try{await chrome.tabs.setZoom(tab.id,0.75);}catch(e){}
    try{await chrome.tabs.remove(tab.id);}catch(e){}
    if(totalR>2500&&allP.length>=2500){
      job.status='Done ('+allP.length+' of '+totalR+', LinkedIn limit)';
    }else if(allP.length===0&&totalR>0){
      job.status='Rate Limited (0/'+Math.min(totalR,2500)+' — too many requests)';
    }else if(allP.length===0&&totalR===0){
      job.status='Rate Limited (0 — too many requests)';
    }else if(totalR>0&&allP.length<Math.min(totalR,2500)&&consecutiveEmpty>=3){
      job.status='Partial ('+allP.length+'/'+Math.min(totalR,2500)+' — rate limited)';
    }else if(totalR>0&&allP.length<Math.min(totalR,2500)&&allP.length>0){
      job.status='Partial ('+allP.length+'/'+Math.min(totalR,2500)+')';
    }else if(totalR===0&&consecutiveEmpty>=5&&allP.length>0){
      job.status='Partial ('+allP.length+', stopped after empty pages)';
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
  if(state.isRunning){
    /* Smart backoff: if job got 0 profiles, LinkedIn is likely rate-limiting.
       Wait progressively longer to let the rate limit cool down. */
    var jobProfiles=job.profilesScraped||0;
    var delay;
    if(jobProfiles===0){
      /* Count consecutive zero-profile jobs */
      var zeroStreak=0;
      for(var zi=state.currentJobIndex;zi>=0;zi--){
        if(state.jobs[zi].profilesScraped===0)zeroStreak++;
        else break;
      }
      /* Backoff: 30s, 45s, 60s... up to 2 min */
      delay=Math.min(30000+zeroStreak*15000,120000);
      addLog('warn','Rate limit detected ('+zeroStreak+' consecutive zero jobs). Waiting '+Math.round(delay/1000)+'s before next job...');
    }else if(consecutiveEmpty>=3){
      /* Job got some profiles but ended with empty pages — partial rate limit */
      delay=rDelay(20000,40000);
      addLog('info','Partial rate limit (ended with empty pages). Waiting '+Math.round(delay/1000)+'s before next job...');
    }else{
      /* Normal: 8-15s between successful jobs */
      delay=rDelay(8000,15000);
    }
    await new Promise(function(r){setTimeout(r,delay);});
    nextJob();
  }
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
  var payload={action:'writeBackLink',sheetUrl:srcUrl,tabName:srcTab,row:row,col:col,value:value};
  try{var r=await fetch(WEB_APP_URL,{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify(payload)});return await r.json();}
  catch(e){addLog('error','WriteBack err: '+e.message);return null;}
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
    /* For SPA navigation, tabs.onUpdated may not fire. Poll URL change as fallback. */
    var startUrl='';
    try{chrome.tabs.get(tid,function(t){if(t)startUrl=t.url||'';});}catch(e){}
    var pollCount=0;
    var pollFn=function(){
      if(done||pollCount>40)return;
      pollCount++;
      try{chrome.tabs.get(tid,function(t){
        if(chrome.runtime.lastError||!t){if(!done){done=true;res();}return;}
        /* If URL changed (SPA nav) and tab is complete, we're done */
        if(startUrl&&t.url!==startUrl&&t.status==='complete'){
          chrome.tabs.onUpdated.removeListener(fn);
          if(!done){done=true;setTimeout(res,1500);}
          return;
        }
        setTimeout(pollFn,500);
      });}catch(e){if(!done){done=true;res();}}
    };
    setTimeout(pollFn,1000);
    setTimeout(function(){chrome.tabs.onUpdated.removeListener(fn);if(!done){done=true;res();}},to);
  });
}

/* Wait for content script to confirm results are loaded */
async function waitContentReady(tid,timeout){
  timeout=timeout||15000;
  try{
    var r=await tabMsg(tid,{action:'waitForResults',timeout:timeout});
    if(r&&r.found){addLog('info','Content ready: '+r.itemCount+' items');return true;}
    /* Try to get the page title/URL for debugging */
    try{
      var t=await chrome.tabs.get(tid);
      addLog('warn','Content not ready after '+timeout+'ms — URL: '+(t.url||'?').substring(0,80)+', title: '+(t.title||'?').substring(0,60));
    }catch(e2){addLog('warn','Content not ready after '+timeout+'ms');}
    return false;
  }catch(e){addLog('warn','waitContentReady err: '+e.message);return false;}
}

function toCSV(ps){
  if(!ps.length)return '';
  var h=['Record ID','First Name','Last Name','Domain','Priority (Company)','Priority (Role)','Priority','Lead Status','Company Name','Job Title','Linkedin Bio','First Phone','First Phone Value','Phone Number','Whatsapp Link','Mobile Phone Number','Email','Email Verification','LinkedIn Membership ID','Location','Notes','Secondary Email','Hubspot URL','Ortus Members','Current Tag','Open Profile','Linkedin First Connection','Client Lead Status','Apollo Contact ID'];
  var rows=ps.map(function(p){return['',p.firstName||'',p.lastName||'','','','','','',p.company||'',p.jobTitle||'',p.publicUrl||p.profileUrl||'','','','','','',p.linkedinEmail||'','',(p.membershipId||'').toString(),p.location||'','','','','','',p.openProfile||'No','','',''].map(function(v){return '"'+String(v||'').replace(/"/g,'""')+'"';}).join(',');});
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
