'use strict';
/* Local-first focus timer: server owns elapsed time. Browser only animates the view. */
(() => {
  const api=window.CourseForgeServices;
  const $=id=>document.getElementById(id);
  const weekday=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  let session=null, snapshotAt=performance.now(), pending=null, ticker=null, analyticsSeq=0;
  const msg=text=>{$('focusMessage').textContent=text||'';};
  function dayString(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
  function monday(s){const d=new Date(`${s}T12:00:00`);d.setDate(d.getDate()-(d.getDay()+6)%7);return dayString(d);}
  const format=s=>`${String(Math.floor(s/60)).padStart(2,'0')}:${String(Math.floor(s%60)).padStart(2,'0')}`;
  function currentRemaining(){
    if(!session)return Number($('focusMinutes').value)*60;
    const running=session.status==='running';
    return Math.max(0,session.remaining_seconds-(running?(performance.now()-snapshotAt)/1000:0));
  }
  function render(){
    const status=session?.status||'ready', remaining=currentRemaining();
    $('focusClock').textContent=format(Math.ceil(remaining));
    $('focusState').textContent=session?`${session.mode==='break'?'Break':'Focus'} · ${status}`:'No active timer';
    $('focusLinked').textContent=session?.title||pending?.title||'Choose a lesson or start an independent focus session.';
    const pct=session?Math.min(100,Math.max(0,100*(1-remaining/session.duration_seconds))):0;
    $('focusProgress').setAttribute('aria-valuenow',String(Math.round(pct)));
    $('focusProgressFill').style.width=`${pct}%`;
    $('focusStart').hidden=!!session;
    $('focusPause').hidden=status!=='running';$('focusResume').hidden=status!=='paused';
    $('focusFinish').hidden=!session;$('focusCancel').hidden=!session;
    $('focusMode').disabled=!!session;$('focusMinutes').disabled=!!session;
  }
  function remember(next){session=next; snapshotAt=performance.now();render();}
  async function refreshInsights(){
    const id=++analyticsSeq;
    const week=monday($('weekStart').value||dayString(new Date()));
    const tz=new Date(`${week}T12:00:00`).getTimezoneOffset();
    const [a,history]=await Promise.all([api.focusAnalytics(week,tz),api.focusHistory()]);
    if(id!==analyticsSeq)return;
    $('focusWeekLabel').textContent=`Week of ${week} · planned vs reported vs measured`;
    $('focusPlanned').textContent=`${a.planned_minutes} min`;
    $('focusReported').textContent=`${a.self_reported_minutes} min`;
    $('focusMeasured').textContent=`${a.measured_minutes} min`;
    $('focusConsistency').textContent=`${a.active_days} of 7 days with at least 1 measured focus minute. These intervals do not verify attention.`;
    const root=$('focusBars');root.replaceChildren();
    const maximum=Math.max(1,...a.days.flatMap(x=>[x.planned_minutes,x.measured_minutes]));
    a.days.forEach((d,i)=>{
      const group=document.createElement('div');group.className='focus-chart-day';
      const bars=document.createElement('div');bars.className='focus-bar-pair';
      for(const [kind,value] of [['planned',d.planned_minutes],['measured',d.measured_minutes]]){
        const bar=document.createElement('span');bar.className=`focus-bar ${kind}`;
        bar.style.height=`${Math.max(0,value/maximum)*100}%`;
        bar.title=`${weekday[i]}: ${kind} ${value} minutes`;
        bars.append(bar);
      }
      const label=document.createElement('small');label.textContent=weekday[i];
      group.append(bars,label);root.append(group);
    });
    root.setAttribute('aria-label',a.days.map((d,i)=>`${weekday[i]} ${d.planned_minutes} planned, ${d.measured_minutes} measured`).join('; '));
    const list=$('focusHistory');list.replaceChildren();
    for(const h of history.sessions.slice(0,8)){
      if(h.status==='cancelled')continue;
      const row=document.createElement('div');row.className='focus-history-row';
      const title=document.createElement('span');title.textContent=h.title;
      const value=document.createElement('span');value.textContent=`${Math.round(h.elapsed_seconds/60*10)/10} min · ${h.mode} · ${h.status}`;
      row.append(title,value);list.append(row);
    }
    if(!list.children.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='No completed focus sessions yet.';list.append(empty);}
  }
  async function begin(){
    if(session){msg('Finish or pause your current timer first.');return;}
    const mode=$('focusMode').value, duration_minutes=Number($('focusMinutes').value);
    const body={mode,duration_minutes};
    if(mode==='focus' && pending){Object.assign(body,pending);delete body.title;if(pending.title)body.title=pending.title;}
    $('focusStart').disabled=true;
    try{remember(await api.beginFocus(body));pending=null;msg('Focus timer started. Hide the tab to pause when possible.');await refreshInsights();}
    catch(e){msg(e.message);}finally{$('focusStart').disabled=false;}
  }
  async function action(value){
    if(!session)return;
    const id=session.id;
    try{
      const next=await api.focusAction(id,value);
      if(value==='finish'||value==='cancel'){remember(null);msg(value==='finish'?'Session saved. Study time recorded without changing mastery.':'Session discarded.');}
      else {remember(next);msg(value==='pause'?'Paused.': 'Resumed.');}
      await refreshInsights();
    }catch(e){msg(e.message);await reload().catch(()=>{});}
  }
  async function reload(){
    const data=await api.activeFocus();remember(data.session);
    await refreshInsights();
  }
  $('focusStart').addEventListener('click',begin);
  for(const value of ['pause','resume','finish','cancel'])$('focus'+value[0].toUpperCase()+value.slice(1)).addEventListener('click',()=>action(value));
  $('focusMinutes').addEventListener('change',render);
  $('focusMode').addEventListener('change',render);
  $('focusVideo').addEventListener('click',()=>{
    const source=$('player').getAttribute('src')||'';
    const videoId=/\/api\/videos\/([^/]+)\/stream/.exec(source)?.[1];
    if(!videoId){msg('Open a lesson first.');return;}
    pending={video_id:decodeURIComponent(videoId),title:$('playingTitle').textContent};
    document.querySelector('[data-nav="planner"]')?.click();
    msg('Lesson selected. Start your focus timer.');render();
  });
  window.CourseForgeFocus=Object.freeze({startForItem:(id,title)=>{
    if(session){msg('Finish or pause your current timer first.');document.querySelector('[data-nav="planner"]')?.click();return;}
    pending={planner_item_id:id,title};msg(`Ready to focus on: ${title}`);render();$('focusStart').focus();
  },startForLab:(id,title)=>{pending={lab_session_id:id,title};document.querySelector('[data-nav="planner"]')?.click();render();}});
  // When the browser tab is hidden, best-effort pause prevents background time
  // from being counted. A browser crash/offline request may still leave the
  // server timer running until its hard cap.
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden&&session?.status==='running'){
      const sid=session.id;
      remember({...session,status:'paused',remaining_seconds:currentRemaining()});
      api.focusAction(sid,'pause').then(remember).catch(()=>{msg('Auto-pause failed. Reopen the tab to sync the server timer.');});
    } else if(!document.hidden){reload().catch(e=>msg(e.message));}
  });
  $('focusLab').addEventListener('click',()=>{
    const button=$('focusLab');
    if(!button.dataset.sessionId){msg('Open a lab first.');return;}
    window.CourseForgeFocus.startForLab(button.dataset.sessionId,button.dataset.labTitle||'Practice lab');
    msg('Lab selected. Start the focus timer.');$('focusStart').focus();
  });
  $('weekStart').addEventListener('change',()=>refreshInsights().catch(e=>msg(e.message)));
  window.addEventListener('hashchange',()=>{if(location.hash==='#planner')reload().catch(e=>msg(e.message));});
  ticker=setInterval(()=>{
    if(session?.status==='running'&&currentRemaining()<=0){reload().catch(()=>{});}
    render();
  },1000);
  reload().catch(e=>msg(e.message));
})();
