var WEB_APP_URL = "https://script.google.com/macros/s/AKfycbyW3i2O8ZOCO1mpGmUnu2sLeCXWI9n0HrFCE8ZZ2dzf27SRVNELKL85vxpKLM0-b3_k/exec";
var DELAY_MIN = 3000;
var DELAY_MAX = 6000;

var state = {
  mode: null, isRunning: false, isPaused: false,
  tabId: null, currentPage: 0, totalPages: 0, totalResults: 0,
  profilesScraped: 0, allProfiles: [], errors: [],
  startTime: null, endTime: null, sheetUrl: '', sheetName: '',
  jobSheetUrl: '', jobs: [], currentJobIndex: -1,
};

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
    case 'loadJobs':loadJobs(msg.jobSheetUrl).then(sendResponse);return true;
    case 'startBatch':startBatch().then(sendResponse);return true;
    case 'stopBatch':stopBatch();sendResponse({ok:true});break;
    default:sendResponse({error:'Unknown: '+msg.action});
  }
});

function pubState(){
  return {mode:state.mode,isRunning:state.isRunning,isPaused:state.isPaused,
    currentPage:state.currentPage,totalPages:state.totalPages,totalResults:state.totalResults,
    profilesScraped:state.profilesScraped,profileCount:state.allProfiles.length,
    errors:state.errors,startTime:state.startTime,endTime:state.endTime,sheetUrl:state.sheetUrl,
    jobSheetUrl:state.jobSheetUrl,jobs:state.jobs,currentJobIndex:state.currentJobIndex};
}

function resetState(){
  state={mode:null,isRunning:false,isPaused:false,tabId:null,currentPage:0,totalPages:0,totalResults:0,
    profilesScraped:0,allProfiles:[],errors:[],startTime:null,endTime:null,sheetUrl:'',sheetName:'',
    jobSheetUrl:'',jobs:[],currentJobIndex:-1};
  chrome.action.setBadgeText({text:''});
}

function bc(){chrome.runtime.sendMessage({action:'stateUpdate',state:pubState()}).catch(function(){});}

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

// -- SINGLE --
async function startSingle(cfg){
  if(state.isRunning)return{ok:false,error:'Running'};
  resetState();state.mode='single';state.isRunning=true;
  state.tabId=cfg.tabId;state.currentPage=cfg.startPage||1;state.totalPages=cfg.totalPages||0;
  state.totalResults=cfg.totalResults||0;state.sheetUrl=cfg.sheetUrl||'';state.sheetName=cfg.sheetName||'Sales Nav Scrape';
  state.startTime=Date.now();
  chrome.action.setBadgeBackgroundColor({color:'#1a73e8'});chrome.action.setBadgeText({text:'...'});
  runSinglePage();return{ok:true};
}

async function runSinglePage(){
  if(!state.isRunning||state.isPaused)return;
  var tid=state.tabId,pg=state.currentPage;
  chrome.action.setBadgeText({text:state.totalPages>0?pg+'/'+state.totalPages:'p'+pg});bc();
  try{
    await waitTab(tid);
    var r=await tabMsg(tid,{action:'extractProfiles'});
    if(r&&r.profiles){
      for(var i=0;i<r.profiles.length;i++)r.profiles[i].pageNumber=pg;
      state.allProfiles=state.allProfiles.concat(r.profiles);state.profilesScraped+=r.profiles.length;
      if(r.pageInfo&&r.pageInfo.totalPages>0){state.totalPages=r.pageInfo.totalPages;state.totalResults=r.pageInfo.totalResults;}
      if(state.sheetUrl)await sendSheet(r.profiles,pg,state.sheetUrl,state.sheetName);
    }
    bc();
    var pi=await tabMsg(tid,{action:'getPageInfo'});
    if(!pi.hasNextPage||(state.totalPages>0&&pg>=state.totalPages)){finishScrape();return;}
    await new Promise(function(r){setTimeout(r,rDelay(DELAY_MIN,DELAY_MAX));});
    if(!state.isRunning||state.isPaused)return;
    state.currentPage=pg+1;
    await tabMsg(tid,{action:'goToNextPage'});await waitNav(tid);runSinglePage();
  }catch(err){
    state.errors.push({page:pg,error:err.message||String(err)});
    if(state.isRunning){state.currentPage=pg+1;await new Promise(function(r){setTimeout(r,3000);});
      try{await tabMsg(tid,{action:'navigateToPage',page:state.currentPage});await waitNav(tid);runSinglePage();}catch(e){finishScrape();}}
  }
}

function finishScrape(){state.isRunning=false;state.endTime=Date.now();chrome.action.setBadgeBackgroundColor({color:'#1e8e3e'});chrome.action.setBadgeText({text:'\u2713'});setTimeout(function(){chrome.action.setBadgeText({text:''});},30000);bc();}
function stopScrape(){state.isRunning=false;state.isPaused=false;state.endTime=Date.now();chrome.action.setBadgeText({text:''});bc();}

// -- BATCH --
async function loadJobs(url){
  state.jobSheetUrl=url;
  try{
    var resp=await fetch(WEB_APP_URL,{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify({action:'readJobs',jobSheetUrl:url}),redirect:'follow'});
    var data=JSON.parse(await resp.text());
    if(!data.success)return{ok:false,error:data.error||"Failed"};
    state.jobs=data.jobs||[];chrome.storage.sync.set({jobSheetUrl:url});
    return{ok:true,jobs:state.jobs};
  }catch(e){return{ok:false,error:'Load failed: '+e.message};}
}

async function startBatch(){
  if(state.isRunning)return{ok:false,error:'Running'};
  state.mode='batch';state.isRunning=true;state.startTime=Date.now();state.currentJobIndex=-1;
  chrome.action.setBadgeBackgroundColor({color:'#1a73e8'});
  nextJob();return{ok:true};
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
    state.isRunning=false;state.endTime=Date.now();
    chrome.action.setBadgeBackgroundColor({color:'#1e8e3e'});chrome.action.setBadgeText({text:'\u2713'});
    setTimeout(function(){chrome.action.setBadgeText({text:''});},30000);bc();return;
  }
  var job=state.jobs[state.currentJobIndex];var jn=state.currentJobIndex+1;var tot=state.jobs.length;
  chrome.action.setBadgeText({text:jn+'/'+tot});bc();
  job.status='Running';updateStatus(state.jobSheetUrl,state.currentJobIndex,job.row,'Running');
  try{
    var win=await chrome.windows.create({url:job.salesNavUrl,focused:false,width:1280,height:900});var tab=win.tabs[0];
    state.tabId=tab.id;await waitTab(tab.id,20000);await new Promise(function(r){setTimeout(r,12000);});
    try{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});}catch(e){}
    await new Promise(function(r){setTimeout(r,1500);});
    var pi;try{pi=await tabMsg(tab.id,{action:'getPageInfo'});}catch(e){pi={totalPages:1,hasNextPage:false,currentPage:1};}
    var totalR=pi.totalResults||0;
    state.totalResults=totalR;state.profilesScraped=0;state.currentPage=1;bc();
    var maxPage=totalR>0?Math.ceil(totalR/25):200;
    console.log('[BG] Job '+job.tabName+': '+totalR+' results, maxPage='+maxPage);
    var allP=[];var cp=1;
    while(cp<=maxPage&&state.isRunning){
      chrome.action.setBadgeText({text:jn+':p'+cp});bc();
      try{
        var r=await tabMsg(tab.id,{action:'extractProfiles'});
        if(r&&r.profiles&&r.profiles.length>0){
          for(var i=0;i<r.profiles.length;i++)r.profiles[i].pageNumber=cp;
          allP=allP.concat(r.profiles);
          state.profilesScraped=allP.length;state.currentPage=cp;bc();
          console.log('[BG] Page '+cp+': got '+r.profiles.length+', total: '+allP.length);
          await sendSheet(r.profiles,cp,job.resultSheetUrl,job.tabName||'Sales Nav Scrape');
        }else{console.log('[BG] Page '+cp+': 0 profiles');}
        if(r&&r.pageInfo&&r.pageInfo.totalResults>0){var nm=Math.ceil(r.pageInfo.totalResults/25);if(nm>0)maxPage=nm;}
      }catch(e){console.log('[BG] Error p'+cp+': '+e.message);}
      var shouldContinue=false;
      if(totalR>0&&allP.length<totalR){shouldContinue=true;console.log('[BG] '+allP.length+'/'+totalR+' so far, continuing');}
      else{var pi2;try{pi2=await tabMsg(tab.id,{action:'getPageInfo'});}catch(e){pi2={};}
        if(pi2.hasNextPage){shouldContinue=true;console.log('[BG] hasNextPage=true');}
        else{console.log('[BG] No more pages');}}
      if(!shouldContinue)break;
      await new Promise(function(r){setTimeout(r,rDelay(DELAY_MIN,DELAY_MAX));});
      if(!state.isRunning)break;
      cp++;
      console.log('[BG] -> page '+cp);
      try{
        await tabMsg(tab.id,{action:'goToNextPage'});
        await waitNav(tab.id);
        await new Promise(function(r){setTimeout(r,5000);});
        try{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});}catch(e){}
        await new Promise(function(r){setTimeout(r,3000);});
      }catch(e){
        console.log('[BG] Next click failed, trying URL nav');
        try{
          await tabMsg(tab.id,{action:'navigateToPage',page:cp});
          await waitNav(tab.id);
          await new Promise(function(r){setTimeout(r,5000);});
          try{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});}catch(e2){}
          await new Promise(function(r){setTimeout(r,3000);});
        }catch(e3){console.log('[BG] Nav failed');break;}
      }
    }
    console.log('[BG] '+job.tabName+' done: '+allP.length+' profiles, '+cp+' pages');
    try{await chrome.tabs.remove(tab.id);}catch(e){}
    job.status='Done ('+allP.length+')';job.profilesScraped=allP.length;
    updateStatus(state.jobSheetUrl,state.currentJobIndex,job.row,job.status);
  }catch(e){
    job.status='Error: '+e.message;updateStatus(state.jobSheetUrl,state.currentJobIndex,job.row,job.status);
    try{if(state.tabId)await chrome.tabs.remove(state.tabId);}catch(x){}
  }
  bc();
  if(state.isRunning){await new Promise(function(r){setTimeout(r,rDelay(5000,10000));});nextJob();}
}

function stopBatch(){
  state.isRunning=false;state.endTime=Date.now();
  if(state.currentJobIndex>=0&&state.currentJobIndex<state.jobs.length){
    state.jobs[state.currentJobIndex].status='Stopped';
    updateStatus(state.jobSheetUrl,state.currentJobIndex,state.jobs[state.currentJobIndex].row,'Stopped');
  }
  try{if(state.tabId)chrome.tabs.remove(state.tabId);}catch(e){}
  chrome.action.setBadgeText({text:''});bc();
}

// -- SHEET --
async function sendSheet(profiles,pg,sheetUrl,sheetName){
  var payload={action:'writeProfiles',sheetUrl:sheetUrl,tabName:sheetName,profiles:profiles,pageNumber:pg};
  try{var r=await fetch(WEB_APP_URL,{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify(payload)});return await r.json();}
  catch(e){console.log('[BG] Sheet err: '+e.message);return null;}
}

async function updateStatus(jobUrl,idx,row,status){
  var payload={action:'updateJob',jobSheetUrl:jobUrl,row:row,status:status};
  try{await fetch(WEB_APP_URL,{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify(payload)});}
  catch(e){console.log('[BG] Status err: '+e.message);}
}

// -- HELPERS --
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
  var h=['Record ID','First Name','Last Name','Domain','Priority (Company)','Priority (Role)','Priority','Lead Status','Company Name','Job Title','Linkedin Bio','First Phone','First Phone Value','Phone Number','Whatsapp Link','Mobile Phone Number','Email','Email Verification','LinkedIn Membership ID','Location','Notes','Secondary Email','Hubspot URL','Ortus Members','Current Tag','Open Profile','Linkedin First Connection','Client Lead Status','Apollo Contact ID'];
  var rows=ps.map(function(p){return['',p.firstName||'',p.lastName||'','','','','','',p.company||'',p.jobTitle||'',p.profileUrl||'','','','','','',p.linkedinEmail||'','',(p.membershipId||'').toString(),p.location||'','','','','','',p.openProfile||'No',p.connectionDegree||'','',''].map(function(v){return '"'+String(v||'').replace(/"/g,'""')+'"';}).join(',');});
  return[h.join(',')].concat(rows).join('\n');
}

chrome.tabs.onRemoved.addListener(function(tid){if(state.isRunning&&state.tabId===tid&&state.mode==='single')stopScrape();});
