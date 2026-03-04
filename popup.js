var currentView=null,currentTab='single',pageInfo=null,tabId=null,progressInterval=null,completedSheetUrl='';

document.addEventListener('DOMContentLoaded',function(){
  document.getElementById('tab-single').addEventListener('click',function(){switchTab('single');});
  document.getElementById('tab-batch').addEventListener('click',function(){switchTab('batch');});
  document.getElementById('btn-start').addEventListener('click',startScrape);
  document.getElementById('btn-pause').addEventListener('click',togglePause);
  document.getElementById('btn-stop').addEventListener('click',stopScrape);
  document.getElementById('btn-open-sheet').addEventListener('click',openSheet);
  document.getElementById('btn-csv').addEventListener('click',downloadCSV);
  document.getElementById('btn-again').addEventListener('click',scrapeAgain);
  document.getElementById('btn-load-jobs').addEventListener('click',loadJobs);
  document.getElementById('btn-start-batch').addEventListener('click',startBatch);
  document.getElementById('btn-stop-batch').addEventListener('click',stopBatch);
  document.getElementById('btn-batch-again').addEventListener('click',batchAgain);
  chrome.runtime.onMessage.addListener(function(msg){
    if(msg.action==='stateUpdate'){
      if(currentTab==='single'&&currentView==='single-progress')updateProgress();
      if(currentTab==='batch')updateBatchView(msg.state);
    }
  });
  init();
});

function switchTab(tab){
  currentTab=tab;
  document.getElementById('tab-single').classList.toggle('active',tab==='single');
  document.getElementById('tab-batch').classList.toggle('active',tab==='batch');
  if(tab==='single')initSingle();else initBatch();
}

async function init(){
  var st=await sendBG('getState');
  if(st&&st.isRunning&&st.mode==='batch'){switchTab('batch');return;}
  if(st&&st.isRunning&&st.mode==='single'){switchTab('single');return;}
  initSingle();
}

async function initSingle(){
  hideAll();
  var st=await sendBG('getState');
  if(st&&st.isRunning&&st.mode==='single'){showView('single-progress');startPoll();return;}
  if(st&&st.endTime&&st.profileCount>0&&st.mode==='single'){showDone(st);return;}
  var tab=await sendBG('checkCurrentTab');
  if(!tab.ok){showView('single-wrong');return;}
  pageInfo=tab.pageInfo;tabId=tab.tabId;
  showView('single-ready');
  document.getElementById('stat-results').textContent=pageInfo.totalResults?pageInfo.totalResults.toLocaleString():'-';
  document.getElementById('stat-pages').textContent=pageInfo.totalPages||'-';
}

async function startScrape(){
  var u=document.getElementById('input-sheet-url').value.trim();
  if(!u||u.indexOf('docs.google.com/spreadsheets')===-1){document.getElementById('input-sheet-url').style.borderColor='var(--red)';setTimeout(function(){document.getElementById('input-sheet-url').style.borderColor='';},2000);return;}
  var cfg={tabId:tabId,startPage:pageInfo?pageInfo.currentPage:1,totalPages:pageInfo?pageInfo.totalPages:0,totalResults:pageInfo?pageInfo.totalResults:0,sheetUrl:u,sheetName:document.getElementById('input-sheet-name').value.trim()||'Sales Nav Scrape'};
  var r=await sendBG('startScrape',{config:cfg});
  if(r.ok){showView('single-progress');startPoll();}
}

function startPoll(){updateProgress();if(progressInterval)clearInterval(progressInterval);progressInterval=setInterval(updateProgress,1500);}

async function updateProgress(){
  var st=await sendBG('getState');if(!st)return;
  if(!st.isRunning&&st.endTime){clearInterval(progressInterval);showDone(st);return;}
  document.getElementById('prog-profiles').textContent=st.profilesScraped;
  document.getElementById('prog-page').textContent=st.currentPage+(st.totalPages?'/'+st.totalPages:'');
  var pct=st.totalPages>0?Math.round((st.currentPage/st.totalPages)*100):0;
  document.getElementById('prog-fill').style.width=pct+'%';
  document.getElementById('prog-pct').textContent=pct+'%';
  if(st.startTime&&st.currentPage>1){var el=Date.now()-st.startTime;var ms=el/(st.currentPage-1);var rem=(st.totalPages-st.currentPage)*ms;document.getElementById('prog-eta').textContent=fmtD(rem);}
  document.getElementById('progress-status').textContent=st.isPaused?'Paused':'Scraping page '+st.currentPage+'...';
  document.getElementById('btn-pause').textContent=st.isPaused?'Resume':'Pause';
}

async function togglePause(){var st=await sendBG('getState');await sendBG(st.isPaused?'resumeScrape':'pauseScrape');}
async function stopScrape(){clearInterval(progressInterval);await sendBG('stopScrape');var st=await sendBG('getState');showDone(st);}

function showDone(st){
  showView('single-done');
  document.getElementById('done-profiles').textContent=st.profilesScraped||st.profileCount||0;
  document.getElementById('done-pages').textContent=st.currentPage||0;
  document.getElementById('done-time').textContent=fmtD((st.endTime||Date.now())-(st.startTime||Date.now()));
  document.getElementById('done-errors').textContent=(st.errors||[]).length;
  document.getElementById('complete-summary').textContent=(st.profilesScraped||st.profileCount||0)+' profiles collected';
  completedSheetUrl=st.sheetUrl||'';
  document.getElementById('btn-open-sheet').style.display=completedSheetUrl?'':'none';
}

function openSheet(){if(completedSheetUrl)chrome.tabs.create({url:completedSheetUrl});}

async function downloadCSV(){
  var r=await sendBG('exportCSV');if(!r||!r.csv){alert('No data');return;}
  var b=new Blob([r.csv],{type:'text/csv'});var u=URL.createObjectURL(b);
  var a=document.createElement('a');a.href=u;a.download='scrape-'+new Date().toISOString().slice(0,10)+'.csv';a.click();URL.revokeObjectURL(u);
}

async function scrapeAgain(){await sendBG('resetState');initSingle();}

async function initBatch(){
  hideAll();
  var st=await sendBG('getState');
  if(st&&st.isRunning&&st.mode==='batch'){showView('batch-running');renderJobs('batch-job-list',st.jobs,st.currentJobIndex);startBatchPoll();return;}
  if(st&&st.endTime&&st.mode==='batch'&&st.jobs&&st.jobs.length>0){showBatchDone(st);return;}
  showView('batch-setup');
  chrome.storage.sync.get({jobSheetUrl:''},function(s){if(s.jobSheetUrl)document.getElementById('input-job-sheet').value=s.jobSheetUrl;});
}

async function loadJobs(){
  var url=document.getElementById('input-job-sheet').value.trim();
  if(!url||url.indexOf('docs.google.com/spreadsheets')===-1){document.getElementById('input-job-sheet').style.borderColor='var(--red)';setTimeout(function(){document.getElementById('input-job-sheet').style.borderColor='';},2000);return;}
  document.getElementById('btn-load-jobs').textContent='Loading...';document.getElementById('btn-load-jobs').disabled=true;
  var r=await sendBG('loadJobs',{jobSheetUrl:url});
  document.getElementById('btn-load-jobs').textContent='Load Jobs';document.getElementById('btn-load-jobs').disabled=false;
  if(!r.ok){alert(r.error||'Could not load jobs');return;}
  showView('batch-ready');
  var pending=r.jobs.filter(function(j){return!j.status||j.status==='Pending';}).length;
  document.getElementById('batch-ready-msg').textContent=r.jobs.length+' jobs found, '+pending+' pending';
  renderJobs('job-list',r.jobs,-1);
}

async function startBatch(){var r=await sendBG('startBatch');if(r.ok){showView('batch-running');startBatchPoll();}}

function startBatchPoll(){if(progressInterval)clearInterval(progressInterval);progressInterval=setInterval(async function(){var st=await sendBG('getState');updateBatchView(st);},2000);}

function updateBatchView(st){
  if(!st)return;
  if(!st.isRunning&&st.endTime&&st.mode==='batch'){clearInterval(progressInterval);showBatchDone(st);return;}
  if(st.isRunning&&st.mode==='batch'){
    var j=st.jobs[st.currentJobIndex]||{};
    document.getElementById('batch-status').textContent='Job '+(st.currentJobIndex+1)+' of '+st.jobs.length+': '+(j.tabName||'');
    var s=st.profilesScraped||0,t=st.totalResults||0,pct=t>0?Math.min(100,Math.round(s/t*100)):0;
    var e;e=document.getElementById('bp-bar');if(e)e.style.width=pct+'%';
    e=document.getElementById('bp-lbl');if(e)e.textContent='Page '+(st.currentPage||1);
    e=document.getElementById('bp-pct');if(e)e.textContent=pct+'%';
    e=document.getElementById('bp-n');if(e)e.textContent=s+' profiles';
    e=document.getElementById('bp-t');if(e)e.textContent=t>0?'of '+t+' total':'';
    renderJobs('batch-job-list',st.jobs,st.currentJobIndex);
  }
}

async function stopBatch(){clearInterval(progressInterval);await sendBG('stopBatch');var st=await sendBG('getState');showBatchDone(st);}

function showBatchDone(st){
  showView('batch-done');
  var done=(st.jobs||[]).filter(function(j){return j.status&&j.status.indexOf('Done')===0;}).length;
  document.getElementById('batch-done-msg').textContent=done+' of '+(st.jobs||[]).length+' jobs completed';
  renderJobs('batch-done-list',st.jobs||[],-1);
}

async function batchAgain(){await sendBG('resetState');initBatch();}

function renderJobs(elId,jobs,activeIdx){
  var ul=document.getElementById(elId);ul.innerHTML='';
  for(var i=0;i<jobs.length;i++){
    var j=jobs[i],li=document.createElement('li');li.className='job-item';
    var sc='pending',st=j.status||'Pending';
    if(j.status&&j.status.indexOf('Done')===0)sc='done';
    else if(j.status==='Running'||i===activeIdx){sc='running';st='Running';}
    else if(j.status&&(j.status.indexOf('Error')===0||j.status==='Stopped'))sc='error';
    var nm=j.tabName||('Job '+(i+1));
    li.innerHTML='<div class="job-num">'+(i+1)+'</div><div class="job-info"><div class="job-name">'+esc(nm)+'</div></div><div class="job-status '+sc+'">'+esc(st)+'</div>';
    ul.appendChild(li);
  }
}

function hideAll(){var ids=['single-wrong','single-ready','single-progress','single-done','batch-setup','batch-ready','batch-running','batch-done'];for(var i=0;i<ids.length;i++)document.getElementById('view-'+ids[i]).classList.add('hidden');}
function showView(n){hideAll();document.getElementById('view-'+n).classList.remove('hidden');currentView=n;}
function sendBG(a,x){return new Promise(function(r){chrome.runtime.sendMessage(Object.assign({action:a},x||{}),function(v){r(v||{});});});}
function fmtD(ms){if(!ms||ms<0)return'-';var s=Math.floor(ms/1000);if(s<60)return s+'s';var m=Math.floor(s/60);if(m<60)return m+'m '+(s%60)+'s';return Math.floor(m/60)+'h '+(m%60)+'m';}
function esc(s){var d=document.createElement('div');d.textContent=s||'';return d.innerHTML;}
function shortUrl(u){if(!u)return'';var m=u.match(/\/d\/([^\/]+)/);return m?'...'+m[1].slice(0,12):u.slice(0,40);}
