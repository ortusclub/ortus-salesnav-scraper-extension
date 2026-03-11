var currentFilter='all';
var autoRefresh=null;

document.getElementById('btn-refresh').addEventListener('click',loadLogs);
document.getElementById('btn-clear').addEventListener('click',function(){
  chrome.storage.session.remove('ortus_logs',function(){loadLogs();});
});
document.querySelectorAll('.filter-btn').forEach(function(btn){
  btn.addEventListener('click',function(){
    document.querySelectorAll('.filter-btn').forEach(function(b){b.classList.remove('active');});
    btn.classList.add('active');
    currentFilter=btn.getAttribute('data-level');
    loadLogs();
  });
});

function loadLogs(){
  chrome.storage.session.get('ortus_logs',function(d){
    var logs=(d&&d.ortus_logs)?d.ortus_logs:[];
    if(logs.length===0){document.getElementById('log-list').innerHTML='<div class="empty">No logs yet. Start a scrape to see activity here.</div>';document.getElementById('stats').innerHTML='';return;}
    var infoCount=logs.filter(function(l){return l.l==='info';}).length;
    var warnCount=logs.filter(function(l){return l.l==='warn';}).length;
    var errCount=logs.filter(function(l){return l.l==='error';}).length;
    document.getElementById('stats').innerHTML='<span>'+logs.length+' total</span><span style="color:var(--blue)">'+infoCount+' info</span><span style="color:var(--yellow)">'+warnCount+' warn</span><span style="color:var(--red)">'+errCount+' error</span>';

    var filtered=currentFilter==='all'?logs:logs.filter(function(l){return l.l===currentFilter;});
    var html='';
    for(var i=filtered.length-1;i>=0;i--){
      var e=filtered[i];
      var dt=new Date(e.t);
      var ts=dt.toLocaleTimeString()+'.'+String(dt.getMilliseconds()).padStart(3,'0');
      html+='<div class="log-entry"><span class="log-time">'+ts+'</span><span class="log-level '+e.l+'">'+e.l+'</span><span class="log-msg">'+escHtml(e.m)+'</span></div>';
    }
    document.getElementById('log-list').innerHTML=html||'<div class="empty">No matching logs</div>';
  });
}

function escHtml(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML;}

loadLogs();
autoRefresh=setInterval(loadLogs,2000);
