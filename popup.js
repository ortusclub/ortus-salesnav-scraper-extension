var currentView=null,currentTab='single',pageInfo=null,tabId=null,progressInterval=null,completedSheetUrl='';
var batchColData=null; /* {headers:[], sampleRows:[], allRows:[], srcUrl:'', srcTab:'', totalRows:0} */
var batchTabs=null; /* [{name,rows,cols}] */

document.addEventListener('DOMContentLoaded',function(){
  /* Show version from manifest */
  var verEl=document.getElementById('app-version');
  if(verEl){var m=chrome.runtime.getManifest();verEl.textContent='v'+m.version;}

  /* Single */
  $('tab-single').addEventListener('click',function(){switchTab('single');});
  $('tab-batch').addEventListener('click',function(){switchTab('batch');});
  $('btn-start').addEventListener('click',startScrape);
  $('btn-pause').addEventListener('click',togglePause);
  $('btn-stop').addEventListener('click',stopScrape);
  $('btn-open-sheet').addEventListener('click',openSheet);
  $('btn-csv').addEventListener('click',downloadCSV);
  $('btn-again').addEventListener('click',scrapeAgain);
  $('btn-resume').addEventListener('click',resumeSingle);
  $('btn-discard').addEventListener('click',discardSingle);
  $('btn-logs').addEventListener('click',function(e){e.preventDefault();chrome.tabs.create({url:chrome.runtime.getURL('logs.html')});});

  /* Slow mode toggle */
  var slowToggle=$('toggle-slow-mode');
  chrome.storage.local.get('ortus_slow_mode',function(d){
    slowToggle.checked=!!(d&&d.ortus_slow_mode);
  });
  slowToggle.addEventListener('change',function(){
    chrome.storage.local.set({ortus_slow_mode:slowToggle.checked});
    chrome.runtime.sendMessage({action:'setSlowMode',slow:slowToggle.checked});
  });

  /* Corner window toggle */
  var cornerToggle=$('toggle-corner-window');
  chrome.storage.local.get(['ortus_corner_window','ortus_hide_window'],function(d){
    var v=(d&&typeof d.ortus_corner_window!=='undefined')?d.ortus_corner_window:(d&&d.ortus_hide_window);
    cornerToggle.checked=!!v;
  });
  cornerToggle.addEventListener('change',function(){
    chrome.storage.local.set({ortus_corner_window:cornerToggle.checked});
    chrome.runtime.sendMessage({action:'setCornerWindow',corner:cornerToggle.checked});
  });

  /* Batch wizard */
  $('btn-connect-sheet').addEventListener('click',connectSheet);
  $('btn-tab-back').addEventListener('click',function(){showView('batch-setup');saveWizard();});
  $('btn-load-tab').addEventListener('click',loadTabData);
  $('btn-config-back').addEventListener('click',function(){
    if(batchTabs){showView('batch-tab-select');}else{showView('batch-setup');}
    saveWizard();
  });
  $('btn-batch-confirm').addEventListener('click',confirmBatchConfig);
  $('btn-ready-back').addEventListener('click',function(){showView('batch-config');saveWizard();});
  $('btn-start-batch').addEventListener('click',startBatch);
  $('btn-stop-batch').addEventListener('click',stopBatch);
  $('btn-pause-batch').addEventListener('click',togglePauseBatch);
  $('btn-recover-batch').addEventListener('click',recoverBatch);
  $('btn-batch-again').addEventListener('click',batchAgain);
  $('btn-resume-batch').addEventListener('click',resumeBatch);
  $('btn-discard-batch').addEventListener('click',discardBatch);

  /* Dynamic listeners */
  $('sel-url-col').addEventListener('change',function(){updateColPreview();saveWizard();});
  $('sel-tab-source').addEventListener('change',function(){onTabSourceChange();saveWizard();});
  $('sel-tab-col').addEventListener('change',function(){updateTabColPreview();saveWizard();});
  $('sel-src-tab').addEventListener('change',function(){updateTabHint();saveWizard();});
  ['input-dest-sheet','input-dest-tab','input-row-from','input-row-to'].forEach(function(id){
    $(id).addEventListener('input',debounce(saveWizard,500));
  });

  chrome.runtime.onMessage.addListener(function(msg){
    if(msg.action==='stateUpdate'){
      if(currentTab==='single'&&currentView==='single-progress')updateProgress();
      if(currentTab==='batch')updateBatchView(msg.state);
    }
  });
  init();
});

/* ─── WIZARD PERSISTENCE ─── */
function saveWizard(){
  var w={
    step:currentView,batchColData:batchColData,batchTabs:batchTabs,
    srcSheet:gv('input-src-sheet'),selSrcTab:gv('sel-src-tab'),
    selUrlCol:gv('sel-url-col'),selTabSource:gv('sel-tab-source'),selTabCol:gv('sel-tab-col'),
    selOutputCol:gv('sel-output-col'),
    destSheet:gv('input-dest-sheet'),destTab:gv('input-dest-tab'),
    rowFrom:gv('input-row-from'),rowTo:gv('input-row-to')
  };
  chrome.storage.session.set({ortus_wizard:w});
}

async function restoreWizard(){
  try{
    var d=await chrome.storage.session.get('ortus_wizard');
    if(!d||!d.ortus_wizard)return false;
    var w=d.ortus_wizard;
    if(!w.step||w.step.indexOf('batch-')===-1)return false;
    if(w.srcSheet)sv('input-src-sheet',w.srcSheet);

    if(w.step==='batch-tab-select'&&w.batchTabs){
      batchTabs=w.batchTabs;
      rebuildTabDropdown(w);
      showView('batch-tab-select');
      return true;
    }
    if(w.step==='batch-config'&&w.batchColData){
      batchColData=w.batchColData;batchTabs=w.batchTabs;
      rebuildAllDropdowns(w);
      showView('batch-config');
      updateColPreview();onTabSourceChange();
      return true;
    }
    if(w.step==='batch-ready'){
      var st=await sendBG('getState');
      if(st&&st.jobs&&st.jobs.length>0){
        showView('batch-ready');
        $('batch-ready-msg').textContent=st.jobs.length+' jobs ready';
        renderJobs('job-list',st.jobs,-1);
        return true;
      }
    }
  }catch(e){console.log('[Popup] Restore err:',e);}
  return false;
}

function clearWizard(){chrome.storage.session.remove('ortus_wizard');}

function rebuildTabDropdown(w){
  var sel=$('sel-src-tab');sel.innerHTML='';
  if(!batchTabs)return;
  for(var i=0;i<batchTabs.length;i++){
    var o=document.createElement('option');o.value=batchTabs[i].name;
    o.textContent=batchTabs[i].name+' ('+batchTabs[i].rows+' rows)';
    sel.appendChild(o);
  }
  if(w.selSrcTab)sel.value=w.selSrcTab;
  updateTabHint();
}

function rebuildAllDropdowns(w){
  if(!batchColData||!batchColData.headers)return;
  var h=batchColData.headers;
  populateColSelect('sel-url-col',h,w.selUrlCol);
  populateColSelect('sel-tab-col',h,w.selTabCol);
  /* Output col with "Don't write back" option */
  var outSel=$('sel-output-col');outSel.innerHTML='';
  var none=document.createElement('option');none.value='-1';none.textContent="Don't write back";outSel.appendChild(none);
  for(var i=0;i<h.length;i++){
    var o=document.createElement('option');o.value=i;o.textContent=(i+1)+'. '+h[i];outSel.appendChild(o);
  }
  if(w.selOutputCol)outSel.value=w.selOutputCol;
  /* Tab source + "From column" option */
  var tabSrcSel=$('sel-tab-source');
  if(!tabSrcSel.querySelector('option[value="column"]')){
    var co=document.createElement('option');co.value='column';co.textContent='From a column in the sheet';
    tabSrcSel.appendChild(co);
  }
  if(w.selTabSource)tabSrcSel.value=w.selTabSource;
  if(w.destSheet)sv('input-dest-sheet',w.destSheet);
  if(w.destTab)sv('input-dest-tab',w.destTab);
  if(w.rowFrom)sv('input-row-from',w.rowFrom);
  if(w.rowTo)sv('input-row-to',w.rowTo);
}

function populateColSelect(id,headers,selectedVal){
  var sel=$(id);sel.innerHTML='';
  for(var i=0;i<headers.length;i++){
    var o=document.createElement('option');o.value=i;o.textContent=(i+1)+'. '+headers[i];sel.appendChild(o);
  }
  if(selectedVal!==undefined&&selectedVal!==null)sel.value=selectedVal;
}

/* ─── INIT ─── */
function switchTab(tab){
  currentTab=tab;
  $('tab-single').classList.toggle('active',tab==='single');
  $('tab-batch').classList.toggle('active',tab==='batch');
  if(tab==='single')initSingle();else initBatch();
}

async function init(){
  var st=await sendBG('getState');
  var saved=await sendBG('checkSavedState');
  if(saved&&saved.hasInterrupted){
    if(saved.mode==='batch'){switchTab('batch');return;}
    else{switchTab('single');return;}
  }
  if(st&&st.isRunning&&st.mode==='batch'){switchTab('batch');return;}
  if(st&&st.isRunning&&st.mode==='single'){switchTab('single');return;}
  initSingle();
}

/* ─── SINGLE TAB ─── */
async function initSingle(){
  hideAll();
  var st=await sendBG('getState');
  if(st&&st.isRunning&&st.mode==='single'){showView('single-progress');startPoll();return;}
  if(st&&st.endTime&&st.profileCount>0&&st.mode==='single'){showDone(st);return;}
  var saved=await sendBG('checkSavedState');
  if(saved&&saved.hasInterrupted&&saved.mode==='single'){showInterrupted(saved);return;}
  var tab=await sendBG('checkCurrentTab');
  if(!tab.ok){showView('single-wrong');return;}
  pageInfo=tab.pageInfo;tabId=tab.tabId;
  showView('single-ready');
  $('stat-results').textContent=pageInfo.totalResults?(pageInfo.totalResults>2500?'2,500 of '+pageInfo.totalResults.toLocaleString():pageInfo.totalResults.toLocaleString()):'-';
  $('stat-pages').textContent=pageInfo.totalPages||'-';
  chrome.storage.sync.get({lastSheetUrl:'',lastSheetName:''},function(s){
    if(s.lastSheetUrl)$('input-sheet-url').value=s.lastSheetUrl;
    if(s.lastSheetName)$('input-sheet-name').value=s.lastSheetName;
  });
}

async function startScrape(){
  var u=$('input-sheet-url').value.trim();
  if(!u||u.indexOf('docs.google.com/spreadsheets')===-1){flash('input-sheet-url');return;}
  var nm=$('input-sheet-name').value.trim()||'Sales Nav Scrape';
  chrome.storage.sync.set({lastSheetUrl:u,lastSheetName:nm});
  var cfg={tabId:tabId,startPage:pageInfo?pageInfo.currentPage:1,totalPages:pageInfo?pageInfo.totalPages:0,totalResults:pageInfo?pageInfo.totalResults:0,sheetUrl:u,sheetName:nm};
  var r=await sendBG('startScrape',{config:cfg});
  if(r.ok){showView('single-progress');startPoll();}
}

function showInterrupted(saved){
  showView('single-interrupted');
  $('interrupted-msg').textContent='Scraping was interrupted on page '+saved.currentPage;
  $('int-profiles').textContent=saved.profilesScraped||0;
  $('int-page').textContent=saved.currentPage+(saved.totalPages?'/'+saved.totalPages:'');
}
async function resumeSingle(){var r=await sendBG('resumeInterrupted');if(r&&r.ok){showView('single-progress');startPoll();}else{alert(r&&r.error?r.error:'Could not resume');discardSingle();}}
async function discardSingle(){await sendBG('clearSavedState');await sendBG('resetState');initSingle();}
function startPoll(){updateProgress();if(progressInterval)clearInterval(progressInterval);progressInterval=setInterval(updateProgress,1500);}

async function updateProgress(){
  var st=await sendBG('getState');if(!st)return;
  if(!st.isRunning&&st.endTime){clearInterval(progressInterval);showDone(st);return;}
  $('prog-profiles').textContent=st.profilesScraped;
  $('prog-page').textContent=st.currentPage+(st.totalPages?'/'+st.totalPages:'');
  var pct=st.totalPages>0?Math.round((st.currentPage/st.totalPages)*100):0;
  $('prog-fill').style.width=pct+'%';$('prog-pct').textContent=pct+'%';
  if(st.startTime&&st.currentPage>1){var el=Date.now()-st.startTime;var ms=el/(st.currentPage-1);var rem=(st.totalPages-st.currentPage)*ms;$('prog-eta').textContent=fmtD(rem);}
  $('progress-status').textContent=st.isPaused?'Paused':'Scraping page '+st.currentPage+'...';
  $('btn-pause').textContent=st.isPaused?'Resume':'Pause';
}
async function togglePause(){var st=await sendBG('getState');await sendBG(st.isPaused?'resumeScrape':'pauseScrape');}
async function stopScrape(){clearInterval(progressInterval);await sendBG('stopScrape');var st=await sendBG('getState');showDone(st);}

function showDone(st){
  showView('single-done');
  $('done-profiles').textContent=st.profilesScraped||st.profileCount||0;
  $('done-pages').textContent=st.currentPage||0;
  $('done-time').textContent=fmtD((st.endTime||Date.now())-(st.startTime||Date.now()));
  $('done-errors').textContent=(st.errors||[]).length;
  $('complete-summary').textContent=(st.profilesScraped||st.profileCount||0)+' profiles collected';
  completedSheetUrl=st.sheetUrl||'';
  $('btn-open-sheet').style.display=completedSheetUrl?'':'none';
}
function openSheet(){if(completedSheetUrl)chrome.tabs.create({url:completedSheetUrl});}
async function downloadCSV(){var r=await sendBG('exportCSV');if(!r||!r.csv){alert('No data');return;}var b=new Blob([r.csv],{type:'text/csv'});var u=URL.createObjectURL(b);var a=document.createElement('a');a.href=u;a.download='scrape-'+new Date().toISOString().slice(0,10)+'.csv';a.click();URL.revokeObjectURL(u);}
async function scrapeAgain(){await sendBG('clearSavedState');await sendBG('resetState');initSingle();}

/* ─── BATCH WIZARD ─── */
async function initBatch(){
  hideAll();
  var st=await sendBG('getState');
  if(st&&st.isRunning&&st.mode==='batch'){showView('batch-running');renderJobs('batch-job-list',st.jobs,st.currentJobIndex,st.isPaused);startBatchPoll();return;}
  if(st&&st.endTime&&st.mode==='batch'&&st.jobs&&st.jobs.length>0){showBatchDone(st);return;}
  var saved=await sendBG('checkSavedState');
  if(saved&&saved.hasInterrupted&&saved.mode==='batch'){showBatchInterrupted(saved);return;}
  var restored=await restoreWizard();
  if(restored)return;
  showView('batch-setup');
  chrome.storage.sync.get({srcSheetUrl:''},function(s){if(s.srcSheetUrl)$('input-src-sheet').value=s.srcSheetUrl;});
}

/* Step 1: Connect → load visible tabs */
async function connectSheet(){
  var url=$('input-src-sheet').value.trim();
  if(!url||url.indexOf('docs.google.com/spreadsheets')===-1){flash('input-src-sheet');return;}
  setBtn('btn-connect-sheet','Connecting...',true);
  var r=await sendBG('readTabs',{sheetUrl:url});
  setBtn('btn-connect-sheet','Connect',false);
  if(!r.ok){alert(r.error||'Could not connect');return;}
  if(!r.tabs||r.tabs.length===0){alert('No visible tabs found');return;}
  chrome.storage.sync.set({srcSheetUrl:url});
  batchTabs=r.tabs;
  $('sheet-title').textContent=r.title||'Connected';
  var sel=$('sel-src-tab');sel.innerHTML='';
  for(var i=0;i<r.tabs.length;i++){
    var o=document.createElement('option');o.value=r.tabs[i].name;
    o.textContent=r.tabs[i].name+' ('+r.tabs[i].rows+' rows)';
    sel.appendChild(o);
  }
  updateTabHint();
  showView('batch-tab-select');
  saveWizard();
}

function updateTabHint(){
  var sel=$('sel-src-tab');if(!batchTabs)return;
  var name=sel.value;
  var tab=batchTabs.find(function(t){return t.name===name;});
  $('tab-row-hint').textContent=tab?(tab.rows-1)+' data rows, '+tab.cols+' columns':'';
}

/* Step 1b: Load tab data → show config */
async function loadTabData(){
  var url=$('input-src-sheet').value.trim();
  var tabName=$('sel-src-tab').value;
  setBtn('btn-load-tab','Loading...',true);
  var r=await sendBG('readColumns',{sheetUrl:url,tabName:tabName});
  setBtn('btn-load-tab','Load Data',false);
  if(!r.ok){alert(r.error||'Could not load data');return;}
  if(!r.headers||r.headers.length===0){alert('Tab appears empty');return;}
  batchColData={headers:r.headers,sampleRows:r.sampleRows||[],allRows:r.allRows||[],srcUrl:url,srcTab:tabName,totalRows:r.totalRows||r.allRows.length};

  /* Populate all column dropdowns */
  var h=r.headers;
  populateColSelect('sel-url-col',h);
  populateColSelect('sel-tab-col',h);
  /* Auto-select URL column */
  for(var i=0;i<h.length;i++){
    var lc=h[i].toLowerCase();
    if(lc.indexOf('sales nav')!==-1||lc.indexOf('salesnav')!==-1||lc.indexOf('linkedin')!==-1||lc.indexOf('url')!==-1||lc.indexOf('link')!==-1){
      $('sel-url-col').value=i;break;
    }
  }
  /* Auto-select tab name column */
  for(var j=0;j<h.length;j++){
    var lt=h[j].toLowerCase();
    if(lt.indexOf('tab')!==-1||lt.indexOf('campaign')!==-1||lt.indexOf('sheet')!==-1){
      $('sel-tab-col').value=j;break;
    }
  }
  /* Output column dropdown */
  var outSel=$('sel-output-col');outSel.innerHTML='';
  var none=document.createElement('option');none.value='-1';none.textContent="Don't write back";outSel.appendChild(none);
  for(var k=0;k<h.length;k++){
    var o=document.createElement('option');o.value=k;o.textContent=(k+1)+'. '+h[k];outSel.appendChild(o);
  }
  /* Add "From column" to tab source */
  var tabSrc=$('sel-tab-source');
  if(!tabSrc.querySelector('option[value="column"]')){
    var co=document.createElement('option');co.value='column';co.textContent='From a column in the sheet';
    tabSrc.appendChild(co);
  }
  tabSrc.value='auto';onTabSourceChange();
  /* Row range defaults */
  $('input-row-from').value='2';
  $('input-row-to').value='';
  $('input-row-to').placeholder=(batchColData.totalRows+1)||'All';
  /* Restore dest sheet */
  chrome.storage.sync.get({destSheetUrl:'',destTabName:''},function(s){
    if(s.destSheetUrl)$('input-dest-sheet').value=s.destSheetUrl;
    if(s.destTabName)$('input-dest-tab').value=s.destTabName;
  });
  showView('batch-config');
  updateColPreview();
  saveWizard();
}

function updateColPreview(){
  var idx=parseInt($('sel-url-col').value);
  var prev=$('col-preview');prev.innerHTML='';
  if(!batchColData||!batchColData.sampleRows)return;
  var shown=0;
  for(var i=0;i<Math.min(batchColData.sampleRows.length,5);i++){
    var val=(batchColData.sampleRows[i][idx]||'').toString().trim();
    if(!val)continue;
    var s=document.createElement('span');s.textContent=val.length>60?val.substring(0,57)+'...':val;
    prev.appendChild(s);shown++;
  }
  if(shown===0)prev.innerHTML='<em>No values in selected column</em>';
}

function onTabSourceChange(){
  var v=$('sel-tab-source').value;
  $('field-fixed-tab').classList.toggle('hidden',v!=='fixed');
  $('field-tab-col').classList.toggle('hidden',v!=='column');
  if(v==='column')updateTabColPreview();
}

function updateTabColPreview(){
  var idx=parseInt($('sel-tab-col').value);
  var prev=$('tab-col-preview');prev.innerHTML='';
  if(!batchColData||!batchColData.sampleRows)return;
  var shown=0;
  for(var i=0;i<Math.min(batchColData.sampleRows.length,5);i++){
    var val=(batchColData.sampleRows[i][idx]||'').toString().trim();
    if(!val)continue;
    var s=document.createElement('span');s.textContent=val;
    prev.appendChild(s);shown++;
  }
  if(shown===0)prev.innerHTML='<em>No values in selected column</em>';
}

/* Step 2 → Step 3: Build jobs from config */
async function confirmBatchConfig(){
  var destUrl=$('input-dest-sheet').value.trim();
  if(!destUrl||destUrl.indexOf('docs.google.com/spreadsheets')===-1){flash('input-dest-sheet');return;}
  var tabSource=$('sel-tab-source').value;
  var fixedTabName=$('input-dest-tab').value.trim()||'Sales Nav Scrape';
  var tabColIdx=parseInt($('sel-tab-col').value);
  var colIdx=parseInt($('sel-url-col').value);
  var outputColIdx=parseInt($('sel-output-col').value);
  var rowFrom=parseInt($('input-row-from').value)||2;
  var rowToRaw=$('input-row-to').value.trim();
  var rowTo=rowToRaw?parseInt(rowToRaw):0;/* 0 = all */
  chrome.storage.sync.set({destSheetUrl:destUrl,destTabName:fixedTabName});

  var rows=batchColData.allRows||[];
  /* Row numbers are sheet rows (row 1 = header, row 2 = first data) */
  var startIdx=Math.max(0,rowFrom-2);
  var endIdx=rowTo>0?Math.min(rows.length,rowTo-1):rows.length;
  var jobs=[];var autoNum=1;
  for(var i=startIdx;i<endIdx;i++){
    var val=(rows[i][colIdx]||'').toString().trim();
    if(!val)continue;
    if(val.indexOf('linkedin.com/sales')===-1)continue;
    var tabName;
    if(tabSource==='column'){tabName=(rows[i][tabColIdx]||'').toString().trim()||('Scrape '+autoNum);}
    else if(tabSource==='fixed'){tabName=fixedTabName;}
    else{tabName='Scrape '+autoNum;}
    jobs.push({
      row:i+2,/* actual sheet row (1-indexed + header) */
      salesNavUrl:val,resultSheetUrl:destUrl,tabName:tabName,status:'Pending'
    });
    autoNum++;
  }
  if(jobs.length===0){alert('No valid Sales Nav URLs found in rows '+rowFrom+'-'+(rowTo||'end'));return;}
  /* Send to background with write-back config */
  var r=await sendBG('setJobs',{
    jobs:jobs,srcSheetUrl:batchColData.srcUrl,srcTabName:batchColData.srcTab,
    destSheetUrl:destUrl,destTabName:fixedTabName,
    outputColIdx:outputColIdx>=0?outputColIdx+1:-1/* convert to 1-indexed for Sheets API, -1 = disabled */
  });
  if(!r.ok){alert(r.error||'Error setting up jobs');return;}
  showView('batch-ready');
  $('batch-ready-msg').textContent=jobs.length+' jobs from rows '+rowFrom+'-'+(rowTo||batchColData.totalRows);
  renderJobs('job-list',jobs,-1);
  saveWizard();
}

async function startBatch(){clearWizard();var r=await sendBG('startBatch');if(r.ok){showView('batch-running');startBatchPoll();}}
function startBatchPoll(){if(progressInterval)clearInterval(progressInterval);progressInterval=setInterval(async function(){var st=await sendBG('getState');updateBatchView(st);},2000);}

function updateBatchView(st){
  if(!st)return;
  if(!st.isRunning&&st.endTime&&st.mode==='batch'){clearInterval(progressInterval);showBatchDone(st);return;}
  if(st.isRunning&&st.mode==='batch'){
    $('batch-status').textContent=st.isPaused?'Paused — job '+(st.currentJobIndex+1)+' of '+st.jobs.length:'Job '+(st.currentJobIndex+1)+' of '+st.jobs.length;
    var pb=$('btn-pause-batch');if(pb)pb.textContent=st.isPaused?'Resume':'Pause';
    var s=st.profilesScraped||0,t=st.totalResults||0,cap=Math.min(t,2500),pct=cap>0?Math.min(100,Math.round(s/cap*100)):0;
    var e;e=$('bp-bar');if(e)e.style.width=pct+'%';
    e=$('bp-lbl');if(e)e.textContent='Page '+(st.currentPage||1);
    e=$('bp-pct');if(e)e.textContent=pct+'%';
    e=$('bp-n');if(e)e.textContent=s+' profiles';
    e=$('bp-t');if(e)e.textContent=t>0?(t>2500?'of 2,500 ('+t.toLocaleString()+' match, LinkedIn limit)':'of '+t.toLocaleString()+' total'):'';
    renderJobs('batch-job-list',st.jobs,st.currentJobIndex,st.isPaused);
  }
}

async function stopBatch(){clearInterval(progressInterval);await sendBG('stopBatch');var st=await sendBG('getState');showBatchDone(st);}
async function togglePauseBatch(){var st=await sendBG('getState');await sendBG(st&&st.isPaused?'resumeBatch':'pauseBatch');var st2=await sendBG('getState');updateBatchView(st2);}
async function recoverBatch(){var b=$('btn-recover-batch');if(b){b.disabled=true;b.textContent='Recovering...';}var r=await sendBG('recoverBatch');if(b){setTimeout(function(){b.disabled=false;b.textContent='Recover';},3000);}if(r&&!r.ok)alert(r.error||'Could not recover');}

function showBatchDone(st){
  showView('batch-done');clearWizard();
  var done=(st.jobs||[]).filter(function(j){return j.status&&j.status.indexOf('Done')===0;}).length;
  var partial=(st.jobs||[]).filter(function(j){return j.status&&j.status.indexOf('Partial')===0;}).length;
  var msg=done+' of '+(st.jobs||[]).length+' completed';
  if(partial>0)msg+=', '+partial+' partial';
  $('batch-done-msg').textContent=msg;
  renderJobs('batch-done-list',st.jobs||[],-1);
}

function showBatchInterrupted(saved){
  showView('batch-interrupted');
  var jobs=saved.jobs||[];var done=jobs.filter(function(j){return j.status&&j.status.indexOf('Done')===0;}).length;
  $('batch-int-msg').textContent='Batch interrupted ('+done+'/'+jobs.length+' done)';
  $('bint-done').textContent=done;$('bint-total').textContent=jobs.length;
  renderJobs('batch-int-list',jobs,-1);
}
async function resumeBatch(){var r=await sendBG('resumeInterrupted');if(r&&r.ok){showView('batch-running');startBatchPoll();}else{alert(r&&r.error?r.error:'Could not resume');discardBatch();}}
async function discardBatch(){clearWizard();await sendBG('clearSavedState');await sendBG('resetState');initBatch();}
async function batchAgain(){clearWizard();await sendBG('clearSavedState');await sendBG('resetState');initBatch();}

/* ─── SHARED UI ─── */
function renderJobs(elId,jobs,activeIdx,isPaused){
  var ul=$(elId);ul.innerHTML='';
  for(var i=0;i<jobs.length;i++){
    var j=jobs[i],li=document.createElement('li');li.className='job-item';
    var sc='pending',st=j.status||'Pending';
    if(j.status&&j.status.indexOf('Done')===0)sc='done';
    else if(j.status&&j.status.indexOf('Partial')===0)sc='partial';
    else if(j.status==='Running'||i===activeIdx){
      if(isPaused&&i===activeIdx){sc='partial';st='Paused';}
      else{sc='running';st='Running';}
    }
    else if(j.status==='Incomplete')sc='error';
    else if(j.status&&(j.status.indexOf('Error')===0||j.status==='Stopped'))sc='error';
    var nm=j.tabName||('Job '+(i+1));
    var shortSrc=(j.salesNavUrl||'').length>42?(j.salesNavUrl||'').substring(0,39)+'...':j.salesNavUrl||'';
    li.innerHTML='<div class="job-num">'+(i+1)+'</div><div class="job-info"><div class="job-name">'+esc(nm)+'</div><div class="job-dest">'+esc(shortSrc)+'</div></div><div class="job-status '+sc+'">'+esc(st)+'</div>';
    ul.appendChild(li);
  }
}

function hideAll(){['single-wrong','single-ready','single-progress','single-done','single-interrupted','batch-setup','batch-tab-select','batch-config','batch-ready','batch-running','batch-done','batch-interrupted'].forEach(function(id){var el=document.getElementById('view-'+id);if(el)el.classList.add('hidden');});}
function showView(n){hideAll();var el=document.getElementById('view-'+n);if(el)el.classList.remove('hidden');currentView=n;}
function $(id){return document.getElementById(id);}
function sendBG(a,x){return new Promise(function(r){chrome.runtime.sendMessage(Object.assign({action:a},x||{}),function(v){r(v||{});});});}
function fmtD(ms){if(!ms||ms<0)return'-';var s=Math.floor(ms/1000);if(s<60)return s+'s';var m=Math.floor(s/60);if(m<60)return m+'m '+(s%60)+'s';return Math.floor(m/60)+'h '+(m%60)+'m';}
function esc(s){var d=document.createElement('div');d.textContent=s||'';return d.innerHTML;}
function flash(id){$(id).style.borderColor='var(--red)';setTimeout(function(){$(id).style.borderColor='';},2000);}
function setBtn(id,text,dis){var b=$(id);b.textContent=text;b.disabled=dis;}
function gv(id){var el=$(id);return el?el.value:'';}
function sv(id,v){var el=$(id);if(el)el.value=v;}
function debounce(fn,ms){var t;return function(){clearTimeout(t);t=setTimeout(fn,ms);};}
