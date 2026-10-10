'use strict';
/* Weekly study planning: use browser-local weekday and timezone; no fabricated elapsed time. */
(() => {
  const api = window.CourseForgeServices;
  const $ = (id) => document.getElementById(id);
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  let loadedWeek = null;
  let token = 0;
  function localIso(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
  function parseDay(day) {return new Date(`${day}T12:00:00`);}
  function monday(day) { const d = parseDay(day); d.setDate(d.getDate()-((d.getDay()+6)%7));return localIso(d); }
  function addDays(day, count) {const d = parseDay(day);d.setDate(d.getDate()+count);return localIso(d);}
  function make(tag, cls, value) {const n=document.createElement(tag);if(cls)n.className=cls;if(value)n.textContent=value;return n;}
  function message(value) {$('weekMessage').textContent=value || '';}
  function controls(minutes) {
    const root = $('weekDaysInput');root.replaceChildren();
    minutes.forEach((value, i) => {
      const label = make('label','week-budget-day');
      label.append(make('span','',weekdays[i]));
      const input = document.createElement('input');
      input.type='number';input.min='0';input.max='180';input.step='1';input.value=String(value);
      input.dataset.weekday=String(i);input.className='form-input';
      input.setAttribute('aria-label',`${weekdays[i]} study minutes, zero for rest`);
      label.append(input);root.append(label);
    });
  }
  function render(week) {
    loadedWeek = week;
    const root = $('weekCards');root.replaceChildren();root.setAttribute('aria-busy','false');
    $('weekTotals').textContent = `${week.planned_minutes} planned / ${week.actual_minutes} logged min`;
    for (const day of week.days) {
      const card=make('article',`week-card${day.rest_day?' rest':''}`);
      const date=make('span','week-date',`${weekdays[day.weekday]} · ${day.date.slice(5)}`);
      card.append(date);
      card.append(make('strong','week-number',day.rest_day?'Rest day':`${day.planned_minutes} min planned`));
      card.append(make('span','week-actual',day.rest_day?'Rest':`${day.actual_minutes} min logged`));
      if (!day.rest_day) {
        card.append(make('span','week-review',`${day.forecast_reviews} review card${day.forecast_reviews===1?'':'s'} forecast`));
        card.append(make('span','week-count',`${day.completed_count}/${day.task_count} checklist complete`));
        const open=make('button','btn btn-outline','Open day');open.type='button';
        open.setAttribute('aria-label',`Open ${day.date} daily study plan`);
        open.addEventListener('click',()=>{
          $('plannerDate').value=day.date;
          $('plannerDate').dispatchEvent(new Event('change',{bubbles:true}));
          $('plannerDayTitle').scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});
        });
        card.append(open);
      }
      root.append(card);
    }
    if (week.warnings?.length) message(week.warnings.join(' '));
  }
  async function loadWeek() {
    const week=monday($('weekStart').value);
    $('weekStart').value=week;
    const id=++token;
    try {const result=await api.weeklyCalendar(week);if(token===id){render(result);message(result.warnings?.join(' ')||'');}}
    catch(e){if(token!==id)return;loadedWeek=null;$('weekCards').replaceChildren(make('p','muted','No saved calendar for this week. Choose study days and build your week.'));$('weekTotals').textContent='Not planned';message(/404/.test(e.message)?'':e.message);}
  }
  async function init() {
    if (!$('weekStart').value) $('weekStart').value=monday(localIso(new Date()));
    const pref=await api.weekPreferences();controls(pref.weekday_minutes);
    await loadWeek();
  }
  $('weekPrevious').addEventListener('click',()=>{$('weekStart').value=addDays(monday($('weekStart').value),-7);loadWeek();});
  $('weekNext').addEventListener('click',()=>{$('weekStart').value=addDays(monday($('weekStart').value),7);loadWeek();});
  $('weekStart').addEventListener('change',loadWeek);
  $('weekForm').addEventListener('submit',async event=>{
    event.preventDefault();const button=$('weekBuild');button.disabled=true;message('');$('weekCards').setAttribute('aria-busy','true');
    try {
      const minutes=[...$('weekDaysInput').querySelectorAll('input')].map(n=>Number(n.value));
      if(minutes.length!==7||minutes.some(n=>!Number.isInteger(n)||(n!==0&&(n<15||n>180))))throw new Error('Enter 0 or 15–180 whole minutes for each day');
      await api.saveWeekPreferences(minutes);
      // Reuse the daily planner path preference to avoid divergent goals.
      await api.savePlannerPreferences(Number($('plannerBudget').value),$('plannerPath').value||null);
      const week=monday($('weekStart').value);
      const result=await api.generateWeeklyCalendar(week,parseDay(week).getTimezoneOffset(),true);
      render(result);message(result.warnings?.join(' ')||'Weekly calendar saved.');
      $('plannerDate').dispatchEvent(new Event('change'));
    }catch(e){message(e.message);}finally{button.disabled=false;$('weekCards').setAttribute('aria-busy','false');}
  });
  window.CourseForgeWeekly=Object.freeze({refresh:loadWeek});
  window.addEventListener('hashchange',()=>{if(location.hash==='#planner')init().catch(e=>message(e.message));});
  if(location.hash==='#planner')init().catch(e=>message(e.message));
})();
