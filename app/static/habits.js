'use strict';
(() => {
  const api=window.CourseForgeServices.request,json=window.CourseForgeServices.json;
  let current=null,pending=null,timer=null,saving=Promise.resolve();
  const time=seconds=>{const minutes=Math.floor(seconds/60);return minutes>=60?`${Math.floor(minutes/60)}h ${minutes%60}m`:`${minutes}m`;};
  function card(){
    if($('#habitCard'))return $('#habitCard');
    const panel=make('section','panel habit-card');panel.id='habitCard';panel.setAttribute('aria-label','Your daily learning');
    panel.innerHTML='<div class="habit-heading"><div><span class="eyebrow">ONE SMALL STEP TODAY</span><h2>Your daily learning</h2></div><strong id="habitStreak"></strong></div><p id="habitGoalText"></p><progress id="habitProgress" max="900" value="0" aria-label="Daily learning goal"></progress><p id="habitMessage" role="status"></p><p id="weeklyRecap"></p>';
    document.querySelector('[data-view=dashboard] .hero').after(panel);return panel;
  }
  function render(data){
    const previous=current;current=data;card();
    const goal=data.preferences.goal,actions=data.today.lessons+data.today.quizzes+data.today.reviews;
    $('#habitStreak').textContent=`${data.streak} day${data.streak===1?'':'s'}`;
    $('#dashStreak').textContent=`${data.streak} day${data.streak===1?'':'s'}`;
    $('#habitGoalText').textContent=goal==='minutes'?`${time(data.today.watched_seconds)} of 15 minutes watched`:`${Math.min(1,actions)} of 1 lesson finished`;
    $('#habitProgress').max=goal==='minutes'?900:1;$('#habitProgress').value=data.today.goal_met?$('#habitProgress').max:goal==='minutes'?data.today.watched_seconds:Math.min(1,actions);
    $('#habitMessage').textContent=data.today.goal_met?'Daily goal complete. Enjoy your progress.':'Learn at your own pace. Your progress is always saved.';
    $('#weeklyRecap').textContent=`This week: ${time(data.week.watched_seconds)} watched across ${data.week.lessons} finished lesson${data.week.lessons===1?'':'s'}.`;
    for(const id of ['goalMinutes','settingsGoal'])$('#'+id).value=goal==='minutes'?'15':'lesson';
    if($('#reminderEmail'))$('#reminderEmail').checked=Boolean(data.preferences.reminder_email);
    if($('#reminderAvailability'))$('#reminderAvailability').textContent=data.email_available?'One weekly email, only if you choose. Turn it off anytime.':'Your choice is saved. Emails will begin when CourseForge email is available.';
    if(previous&&previous.day===data.day&&!previous.today.goal_met&&data.today.goal_met){
      const message=make('div','habit-celebration');message.append(icon('check'),make('span','','Today’s goal complete'));message.setAttribute('role','status');$('#habitMessage').replaceChildren(message);
    }
  }
  async function refresh(){
    if(pending)return pending;
    pending=api('/api/me/habits').then(render).finally(()=>pending=null);return pending;
  }
  function refreshSoon(){clearTimeout(timer);timer=setTimeout(()=>refresh().catch(()=>{}),1000);}
  function save(change){
    const job=saving.catch(()=>{}).then(async()=>{if(!current)return;const data=await api('/api/me/habit-preferences',json('PUT',{...current.preferences,...change}));render(data);});
    saving=job;return job;
  }
  function momentum(){
    const available=state.videos.filter(v=>v.cloud_ready&&!state.progress.get(v.id)?.completed);
    const recent=Object.values(window.CourseForgeAccount?.lastLessons||{}).map(id=>available.find(v=>v.id===id)).find(Boolean);
    const next=recent||available[0];state.continueVideo=next?.id||null;
    const title=document.querySelector('[data-view=dashboard] .hero h1'),description=document.querySelector('[data-view=dashboard] .hero-copy>p');
    title.textContent=next?`Continue ${lessonTitle(next.title)}`:state.videos.length?'You’ve come a long way.':'Your first lesson is waiting.';
    description.textContent=next?'Pick up where you left off. Your place is saved.':state.videos.length?'Revisit a lesson or explore another course.':'Choose a course below and start learning.';
    $('#heroLearnBtn').textContent=next?'Continue lesson':state.videos.length?'Explore my courses':'Choose a course';
    document.querySelector('.hero-art')?.remove();
    if(!state.videos.length&&state.discovery?.length){
      const target=$('#featuredCourses');target.replaceChildren();
      for(const course of state.discovery){
        const panel=make('article','panel first-course');panel.append(make('span','eyebrow',course.category||'Course'),make('h3','',course.title),make('p','muted',`${course.lesson_count} lessons${course.instructor?' · '+course.instructor:''}`));
        const start=make('button','btn btn-primary first-course-start','Start course');start.type='button';start.dataset.course=course.id;
        start.onclick=async()=>{start.disabled=true;try{
          await api(`/api/courses/${encodeURIComponent(course.id)}/enroll`,json('POST',{}));
          window.CourseForgeAccount.bootstrap=await api('/api/me/bootstrap');await window.CourseForgeAcademy.workspace();
          const first=state.videos.find(v=>v.course===course.id&&v.cloud_ready);if(first){await openVideo(first.id);await window.CourseForgeNative.video()?.play().catch(()=>{});}
        }catch(error){toast(error.message,true);}finally{start.disabled=false;}};
        panel.append(start);target.append(panel);
      }
    }
  }
  async function continueLearning(){
    if(state.continueVideo){await openVideo(state.continueVideo);await window.CourseForgeNative.video()?.play().catch(()=>{});}
    else if(!state.videos.length)$('#featuredCourses').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth',block:'start'});
    else navigate('library');
  }
  function showCompletion(courseId){
    const course=groupCourses().find(c=>c.name===courseId);if(!course||course.completed!==course.videos.length)return;
    const root=window.CourseForgeAcademy.page('Course complete');history.replaceState(null,'','#finished/'+encodeURIComponent(courseId));
    const paper=make('section','course-completion');paper.append(icon('check'),make('p','eyebrow','YOUR NEXT CHAPTER STARTS HERE'),make('h2','',window.CourseForgeAccount.user.name),make('h3','',course.title||course.name),make('p','',`${course.completed} of ${course.videos.length} lessons completed`),make('p','muted','Your learning record · '+new Date().toLocaleDateString(undefined,{dateStyle:'long'})));
    const back=make('button','btn btn-primary','Explore my courses');back.onclick=async()=>{await window.CourseForgeAcademy.workspace();navigate('library');};paper.append(back);root.append(paper);
  }
  function completed(id){refreshSoon();momentum();const lesson=state.videos.find(v=>v.id===id);if(lesson)showCompletion(lesson.course);}
  async function init(){
    const initial=state.habits||await api('/api/me/habits');render(initial);momentum();
    if(initial.preferences.initialized===false)await save({timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'});
    if(!$('#reminderEmail')){
      const panel=$('#settingsGoal').closest('.panel'),label=make('label','reminder-choice');
      const input=make('input');input.type='checkbox';input.id='reminderEmail';input.checked=Boolean(current.preferences.reminder_email);
      input.onchange=()=>save({reminder_email:input.checked}).catch(error=>{input.checked=Boolean(current.preferences.reminder_email);toast(error.message,true);});
      label.append(input,make('span','','Send me a weekly learning reminder'));panel.append(label,make('p','small-note',''));panel.lastElementChild.id='reminderAvailability';render(current);
    }
  }
  for(const id of ['goalMinutes','settingsGoal'])$('#'+id).onchange=e=>save({goal:e.target.value==='lesson'?'lesson':'minutes'}).catch(error=>{render(current);toast(error.message,true);});
  window.addEventListener('courseforge-interactive',()=>init().catch(()=>{}));
  window.addEventListener('courseforge-navigate',()=>{if(state.view==='dashboard')momentum();});
  setInterval(()=>{if(window.CourseForgeReady&&!document.hidden)refresh().catch(()=>{});},30000);
  window.CourseForgeHabit={refresh,refreshSoon,momentum,continueLearning,completed,showCompletion};
})();
