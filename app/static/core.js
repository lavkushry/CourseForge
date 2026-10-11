/* services.js */
'use strict';
/**
 * CourseForge's typed client boundary. Only real backend data is rendered as facts.
 * @typedef {{id:string,course:string,title:string,duration:number|null,status:string,chunk_count:number}} Video
 * @typedef {{video_id:string,percent:number,position:number,completed:number,updated_at?:string|null}} Progress
 * @typedef {{due_count:number,total_cards:number,reviews_today:number,streak_days:number,mastery_signal_percent:number|null,weak_areas:Array<{course:string,question:string,quality:number,date:string}>,history:Array<{course:string,question:string,quality:number,date:string}>,weekly_reviews:Array<{date:string,count:number}>}} Insights
 */
(() => {
  async function request(path, options = {}, resolveTask = true) {
    const headers = new Headers(options.headers || {});
    if (window.CourseForgeAccount?.csrf) headers.set('X-CSRF-Token', window.CourseForgeAccount.csrf);
    const response = await fetch(path, {...options, headers});
    const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(typeof body.detail === 'string' ? body.detail : body.detail?.message || `Request failed (${response.status})`);
      error.status = response.status;
      error.detail = body.detail;
      if(response.status===401 && window.CourseForgeAccount?.user) window.dispatchEvent(new Event('courseforge-session-expired'));
      throw error;
    }
    if (body.task_id && resolveTask) {
      window.dispatchEvent(new CustomEvent('courseforge-task', {detail: body}));
      for(let i=0;i<360;i++) {
        await new Promise(resolve=>setTimeout(resolve,1000));
        const task=await request(`/api/tasks/${encodeURIComponent(body.task_id)}`,{},false);
        if(task.status==='done')return task.result;
        if(task.status==='failed')throw new Error(task.error || 'The task could not finish. Please retry.');
      }
      throw new Error('This task is still queued. Refresh later or ask the administrator to check the learning worker.');
    }
    return body;
  }
  const json = (method, data) => ({method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)});
  /** @returns {Promise<{videos:Video[]}>} */
  const videos = () => request('/api/videos');
  /** @returns {Promise<{progress:Progress[]}>} */
  const progress = () => request('/api/progress');
  /** @returns {Promise<Insights>} */
  const insights = () => request('/api/studio/insights');
  const notes = (id) => request(`/api/videos/${encodeURIComponent(id)}/notes`);
  const saveNote = (id, position, content) => request(`/api/videos/${encodeURIComponent(id)}/notes`, json('POST', {position, content}));
  const deleteNote = (id) => request(`/api/notes/${encodeURIComponent(id)}`, {method:'DELETE'});
  /** @typedef {{id:string,title:string,instructor:string|null,category:string|null,tags:string[],cover_url:string,cover_kind:string|null}} CourseMeta */
  /** @returns {Promise<{courses:CourseMeta[]}>} */
  const courses = () => request('/api/courses');
  const updateCourse = (id,data) => request(`/api/courses/${encodeURIComponent(id)}`,json('PATCH',data));
  const uploadCover = (id,file) => request(`/api/courses/${encodeURIComponent(id)}/cover`,{method:'PUT',headers:{'Content-Type':file.type},body:file});
  const resetCover = (id) => request(`/api/courses/${encodeURIComponent(id)}/cover`,{method:'DELETE'});
  /** @typedef {{id:string,title:string,order:number,prerequisites:string[],sources:Array<{video_id:string,video_title:string,start:number,course:string}>,completed:boolean,watched_sources:number,goal_focus:boolean}} PathStep */
  /** @typedef {{id:string,goal:string,courses:string[],steps:PathStep[],inference:string,completion_percent:number,outdated:boolean,next_step_id:string|null}} LearningPath */
  const learningPaths = () => request('/api/learning-paths');
  const learningPath = (id) => request(`/api/learning-paths/${encodeURIComponent(id)}`);
  const createLearningPath = (courses,goal,use_ai=true) => request('/api/learning-paths',json('POST',{courses,goal,use_ai}));
  const completeLearningStep = (id,step,completed) => request(`/api/learning-paths/${encodeURIComponent(id)}/steps/${encodeURIComponent(step)}`,json('PUT',{completed}));
  /** @typedef {{id:string,question_count:number,questions:Array<{id:string,question:string,options:string[],source:{video_id:string,start:number,title:string}}>} } TopicAssessment */
  const startAssessment = (pathId,stepId,count=3) => request(`/api/learning-paths/${encodeURIComponent(pathId)}/steps/${encodeURIComponent(stepId)}/assessments`,json('POST',{count}));
  const submitAssessment = (id,answers) => request(`/api/assessments/${encodeURIComponent(id)}/attempts`,json('POST',{answers}));
  const assessmentHistory = (pathId,stepId=null) => request(`/api/learning-paths/${encodeURIComponent(pathId)}/assessment-history${stepId?'?step_id='+encodeURIComponent(stepId):''}`);
  const practiceRecommendations = (id) => request(`/api/learning-paths/${encodeURIComponent(id)}/practice-recommendations`);
  const practiceHistory = (id,step=null) => request(`/api/learning-paths/${encodeURIComponent(id)}/practice-history${step?'?step_id='+encodeURIComponent(step):''}`);
  const startRecommendedPractice = (id,step,slug) => request(`/api/learning-paths/${encodeURIComponent(id)}/steps/${encodeURIComponent(step)}/practice/${encodeURIComponent(slug)}/start`,{method:'POST'});
  /** @typedef {{study_date:string,budget_minutes:number,planned_minutes:number,completed_count:number,items:Array<{id:string,kind:string,title:string,description:string,minutes:number,status:string,action:object}>}} DailyPlan */
  const plannerPreferences = () => request('/api/planner/preferences');
  const savePlannerPreferences = (daily_minutes,path_id) => request('/api/planner/preferences', json('PUT',{daily_minutes,path_id}));
  const plannerDay = (day) => request(`/api/planner/days/${encodeURIComponent(day)}`);
  const generatePlannerDay = (study_date,tz_offset_minutes,refresh=false) => request('/api/planner/days',json('POST',{study_date,tz_offset_minutes,refresh}));
  const setPlannerItem = (id,status) => request(`/api/planner/items/${encodeURIComponent(id)}`,json('PUT',{status}));
  /** @typedef {{week_start:string,days:Array<{date:string,weekday:number,budget_minutes:number,planned_minutes:number,actual_minutes:number,forecast_reviews:number,rest_day:boolean}>}} WeeklyCalendar */
  const weekPreferences = () => request('/api/planner/week-preferences');
  const saveWeekPreferences = (weekday_minutes) => request('/api/planner/week-preferences',json('PUT',{weekday_minutes}));
  const weeklyCalendar = (week) => request(`/api/planner/weeks/${encodeURIComponent(week)}`);
  const generateWeeklyCalendar = (week_start,tz_offset_minutes,refresh=false) => request('/api/planner/weeks',json('POST',{week_start,tz_offset_minutes,refresh}));
  const savePlannerActual = (id,actual_minutes) => request(`/api/planner/items/${encodeURIComponent(id)}/actual`,json('PUT',{actual_minutes}));
  /** @typedef {{id:string,mode:'focus'|'break',status:'running'|'paused'|'finished'|'cancelled',duration_seconds:number,elapsed_seconds:number,remaining_seconds:number}} FocusSession */
  const beginFocus = (body) => request('/api/focus/sessions',json('POST',body));
  const focusAction = (id,action) => request(`/api/focus/sessions/${encodeURIComponent(id)}/actions`,json('POST',{action}));
  const activeFocus = () => request('/api/focus/active');
  const focusHistory = () => request('/api/focus/history');
  const focusAnalytics = (week,offset) => request(`/api/focus/analytics/${encodeURIComponent(week)}?tz_offset_minutes=${encodeURIComponent(offset)}`);
  const habits = () => request('/api/me/habits');
  const saveHabitPrefs = (body) => request('/api/me/habit-preferences', json('PUT', body));
  const trackStreamingEvent = (eventType, eventName, meta = {}) => {
    try {
      const payload = JSON.stringify({ event_type: eventType, event_name: eventName, meta });
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/streaming/analytics/event', new Blob([payload], { type: 'application/json' }));
      } else {
        fetch('/api/streaming/analytics/event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true
        }).catch(() => {});
      }
    } catch (_) {}
  };
  window.CourseForgeServices = Object.freeze({trackStreamingEvent,beginFocus,focusAction,activeFocus,focusHistory,focusAnalytics,weekPreferences,saveWeekPreferences,weeklyCalendar,generateWeeklyCalendar,savePlannerActual,plannerPreferences,savePlannerPreferences,plannerDay,generatePlannerDay,setPlannerItem,practiceRecommendations,practiceHistory,startRecommendedPractice,startAssessment,submitAssessment,assessmentHistory,learningPaths,learningPath,createLearningPath,completeLearningStep,request, json, videos, progress, insights, notes, saveNote, deleteNote, courses, updateCourse, uploadCover, resetCover, habits, saveHabitPrefs});
})();

/* app.js */
'use strict';
/* CourseForge UI v3 — progressive enhancement on the existing local FastAPI API. */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const services = window.CourseForgeServices;
const state = {videos:[], jobs:[], progress:new Map(), mode:'explain', view:'home', libraryFilter:'all', search:'', selectedId:null, currentVideoId:null, lastAnswer:'', currentLab:null, dueCards:[], activeCard:null, lastSavedPosition:-1, toastTimer:null, insights:null, librarySort:'recent', category:'all', theme:{mode:'system',accent:'indigo'}, courseMeta:new Map(), coverRevision:0, editingCourse:null};
const prettyTime = (seconds) => {const n=Math.max(0,Math.floor(Number(seconds)||0));return `${String(Math.floor(n/3600)).padStart(2,'0')}:${String(Math.floor(n%3600/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;};
const icon = (name) => {const el=document.createElementNS('http://www.w3.org/2000/svg','svg');el.setAttribute('class','icon');const use=document.createElementNS('http://www.w3.org/2000/svg','use');use.setAttribute('href',`#i-${name}`);el.append(use);return el;};
const make = (tag,cls='',text='') => {const el=document.createElement(tag);if(cls)el.className=cls;if(text)el.textContent=text;return el;};
async function request(path,opts={}){return services.request(path,opts);}
function toast(message,error=false){const node=$('#notice');node.textContent=message;node.classList.toggle('error',error);node.hidden=false;clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>node.hidden=true,error?7500:4500);}
const navNames={planner:'Today’s plan',dashboard:'Home / Continue',library:'Library',learning:'Learning',tutor:'AI Tutor',syllabus:'Study paths',reviews:'Review',labs:'Labs',settings:'Settings'};
function updateBreadcrumbs(courseId=null,lessonName=null){
  const courseTitle=courseId?(state.courseMeta.get(courseId)?.title||courseId):null;
  const courseCrumb=$('#studioCourseCrumb'),lessonCrumb=$('#studioLessonCrumb');
  if(courseCrumb){
    courseCrumb.textContent=courseTitle||'Library';
    courseCrumb.onclick=e=>{e.preventDefault();if(courseId){state.category='all';state.search='';$('#lessonCourse').value=courseId;}navigate('library',true);};
  }
  if(lessonCrumb)lessonCrumb.textContent=lessonName||'Choose a lesson';
}
function navigate(view, focusHeading=false){if(!navNames[view])view='dashboard';state.view=view;$$('[data-view]').forEach(el=>el.hidden=el.dataset.view!==view);$$('.nav-item').forEach(el=>{const selected=el.dataset.nav===view;el.classList.toggle('active',selected);if(selected)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});$('#topbarLocation').textContent=navNames[view];$('#universalSearchResults').hidden=true;window.dispatchEvent(new Event('courseforge-navigate'));closeMobileMenu(false);document.body.classList.toggle('in-learning',view==='learning');if(!applyingRoute){const h=location.hash;const isDeep=h.startsWith('#/my-list')||h.startsWith('#/history')||h.startsWith('#/browse')||h.startsWith('#/course/');if(!isDeep){const hash=view==='learning'&&state.currentVideoId?lessonHash(state.currentVideoId):'#'+view;if(location.hash!==hash)history.pushState(null,'',hash);}}window.scrollTo({top:0,behavior:'instant'});if(focusHeading){const heading=$(`[data-view="${view}"] h1`);if(heading){heading.setAttribute('tabindex','-1');heading.focus({preventScroll:true})}}if(view!=='learning')window.CourseForgeAcademy?.leaveLesson();else if(state.currentVideoId&&!document.querySelector('#lecturePlayerWrap iframe, #lecturePlayerWrap video, #lecturePlayerWrap .player-loading, #lecturePlayerWrap .player-unavailable'))openVideo(state.currentVideoId).catch(err=>toast(err.message,true));if(view==='syllabus')loadSyllabus().catch(err=>toast(err.message,true));if(view==='reviews')loadDue().catch(err=>toast(err.message,true));if(view==='labs')loadLabs().catch(err=>toast(err.message,true));}
$$('[data-nav]').forEach(el=>el.addEventListener('click',event=>{if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();navigate(el.dataset.nav,true);}));
let applyingRoute=0;
function readLessonRoute(){
  const raw=location.hash.replace(/^#\/?/,'');
  const [path,query='']=raw.split('?');
  const parts=path.split('/');
  let view=parts[0]||'dashboard';
  let id=parts[1]||null;
  const params=new URLSearchParams(query);
  let decoded=null;
  try{decoded=id?decodeURIComponent(id):null;}catch{}
  if(view==='lecture')view='learning';
  else if(view==='browse'||view==='courses'||view==='catalog'){
    view='library';
    if(id)state.category=id;
  }else if(view==='course'){
    view='library';
    if(id)state.selectedCourse=id;
  }else if(view==='my-list'||view==='history'){
    view='library';
    state.libraryFilter='active';
  }
  return {rawView:parts[0],view,id:decoded,at:params.has('t')?Math.max(0,Number(params.get('t'))||0):null,tab:params.get('tab')||'lessons',query:params.get('q')||''};
}
function lessonHash(id,at=null){
  const params=new URLSearchParams();
  if(at!==null)params.set('t',Math.floor(at));
  const tab=state.studyTab||'lessons';
  if(tab&&tab!=='lessons')params.set('tab',tab);
  return '#/lecture/'+encodeURIComponent(id)+(params.size?'?'+params:'');
}
function syncLessonRoute(id,at=null,replace=false){if(applyingRoute)return;const hash=lessonHash(id,at);if(location.hash!==hash)history[replace?'replaceState':'pushState'](null,'',hash);}
function closeMobileMenu(restoreFocus=false){$('#sidebar').classList.remove('open');$('#mobileScrim').hidden=true;for(const id of ['mobileMenu','studioMenu'])$('#'+id).setAttribute('aria-expanded','false');$('.main-column').inert=false;$('.academy-header').inert=false;if(restoreFocus)$(state.view==='learning'?'#studioMenu':'#mobileMenu').focus();}
function openMobileMenu(){const open=!$('#sidebar').classList.contains('open');if(!open){closeMobileMenu(true);return;}$('#sidebar').classList.add('open');$('#mobileScrim').hidden=false;for(const id of ['mobileMenu','studioMenu'])$('#'+id).setAttribute('aria-expanded','true');$('.main-column').inert=true;$('.academy-header').inert=true;$('#sidebar .nav-item').focus();}
for(const id of ['mobileMenu','studioMenu'])$('#'+id).addEventListener('click',openMobileMenu);
$('#mobileScrim').addEventListener('click',()=>closeMobileMenu(true));
$('#sidebar').addEventListener('keydown',event=>{if(!$('#sidebar').classList.contains('open')||event.key!=='Tab')return;const controls=[...$('#sidebar').querySelectorAll('a,button')].filter(e=>!e.hidden&&!e.disabled&&e.getClientRects().length);const first=controls[0],last=controls.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}});
async function applyRoute(){const route=readLessonRoute();if(!navNames[route.view])return;applyingRoute++;try{navigate(route.view);if(route.view==='learning'){selectLessonTab(route.tab,false);if(route.id&&(route.id!==state.currentVideoId||route.at!==null))await openVideo(route.id,route.at);}}catch(error){toast(error.message,true);}finally{applyingRoute--;}}
window.addEventListener('hashchange',applyRoute);window.addEventListener('popstate',applyRoute);
function effectiveTheme(mode){return mode==='system'?(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):mode;}
function loadTheme(){try{const saved=JSON.parse(localStorage.getItem('courseforge-theme-v3')||'{}');if(['light','dark','system'].includes(saved.mode))state.theme.mode=saved.mode;if(['indigo','teal','rose'].includes(saved.accent))state.theme.accent=saved.accent;}catch{}applyTheme(false);}
function applyTheme(persist=true){document.documentElement.dataset.theme=state.theme.mode;document.documentElement.dataset.resolvedTheme=effectiveTheme(state.theme.mode);document.documentElement.dataset.accent=state.theme.accent;$$('[data-theme-option]').forEach(el=>{el.classList.toggle('active',el.dataset.themeOption===state.theme.mode);el.setAttribute('aria-pressed',String(el.dataset.themeOption===state.theme.mode));});$$('[data-accent-option]').forEach(el=>{el.classList.toggle('active',el.dataset.accentOption===state.theme.accent);el.setAttribute('aria-pressed',String(el.dataset.accentOption===state.theme.accent));});if(persist){try{localStorage.setItem('courseforge-theme-v3',JSON.stringify(state.theme))}catch{}}}
$$('[data-theme-option]').forEach(button=>button.addEventListener('click',()=>{state.theme.mode=button.dataset.themeOption;applyTheme();}));
$$('[data-accent-option]').forEach(button=>button.addEventListener('click',()=>{state.theme.accent=button.dataset.accentOption;applyTheme();}));
$('#themeBtn').addEventListener('click',()=>{const open=$('#themePopover').hidden;$('#themePopover').hidden=!open;$('#themeBtn').setAttribute('aria-expanded',String(open));if(open)$('#themePopover [data-theme-option]').focus();});
$('#closeTheme').addEventListener('click',()=>{closeTheme();$('#themeBtn').focus()});
function closeTheme(){$('#themePopover').hidden=true;$('#themeBtn').setAttribute('aria-expanded','false');}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change',()=>{if(state.theme.mode==='system')applyTheme(false)});
document.addEventListener('click',event=>{if(!$('#themePopover').hidden&&!$('#themePopover').contains(event.target)&&!$('#themeBtn').contains(event.target))closeTheme();if(!$('#notifyPopover').hidden&&!$('#notifyPopover').contains(event.target)&&!$('#notifyBtn').contains(event.target))closeNotify();if(!$('#universalSearchResults').hidden&&!$('#universalSearchResults').contains(event.target)&&!$('#globalSearch').contains(event.target))$('#universalSearchResults').hidden=true;});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){if(!$('#universalSearchResults').hidden)$('#universalSearchResults').hidden=true;if(!$('#themePopover').hidden){closeTheme();$('#themeBtn').focus();}if(!$('#notifyPopover').hidden){closeNotify();$('#notifyBtn').focus();}closeMobileMenu(true);}if(event.key==='/'&&!['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)&&!event.ctrlKey&&!event.metaKey){event.preventDefault();$('#globalSearch').focus();}});
loadTheme();
$('#todayLabel').textContent=new Intl.DateTimeFormat(undefined,{month:'long',day:'numeric',year:'numeric'}).format(new Date());
const colorways=[['#493eb8','#9285ed','{ }','ENGINEERING'],['#06685f','#4bd4ac','<>','DEVELOPMENT'],['#d66c39','#f7c68a','01','DATA'],['#305b92','#72aff8','>_','TECHNOLOGY'],['#903b81','#e39ad2','','CREATIVE'],['#414c70','#8797cc','//','COURSE']];
function coverFor(course){let hash=0;for(const c of course)hash=((hash*31)+c.charCodeAt(0))>>>0;const lower=course.toLowerCase();let index=hash%colorways.length;if(/kubernetes|ansible|docker|devops|cloud|linux/i.test(lower))index=0;if(/java|python|javascript|backend|go\b|program/i.test(lower))index=1;if(/data|sql|spark|databricks|analytics|machine learning/i.test(lower))index=2;return colorways[index];}
function nextUpLesson(course){
  const lessons=course?.videos||[];
  if(!lessons.length)return null;
  const lastId=window.CourseForgeAccount?.lastLessons?.[course.name];
  const last=lastId&&lessons.find(v=>v.id===lastId&&!state.progress.get(v.id)?.completed);
  if(last)return last;
  const active=lessons.find(v=>{const p=state.progress.get(v.id);return p&&!p.completed&&(p.percent>0||p.position>0);});
  if(active)return active;
  return lessons.find(v=>!state.progress.get(v.id)?.completed)||null;
}
function groupCourses(){const groups=new Map();for(const video of state.videos){if(!groups.has(video.course))groups.set(video.course,[]);groups.get(video.course).push(video);}return [...groups].map(([name,videos])=>{const materials=(state.materials||[]).filter(m=>m.course===name);const completed=videos.filter(v=>state.progress.get(v.id)?.completed).length;const percent=Math.round(completed/videos.length*100);const indexed=videos.filter(v=>v.status==='done').length;const hasRecent=Boolean(window.CourseForgeAccount?.lastLessons?.[name]);const lastActivity=Math.max(...videos.map(v=>Date.parse(state.progress.get(v.id)?.updated_at||'')||0),hasRecent?1:0);const nextLesson=nextUpLesson({name,videos});return {name,videos,materials,completed,percent,indexed,lastActivity,recentlyViewed:lastActivity>0,nextLesson,...(state.courseMeta.get(name)||{})};}).sort((a,b)=>b.lastActivity-a.lastActivity||a.name.localeCompare(b.name));}
function lessonTitle(title){return String(title||'').replace(/^\[\d+(?: Part\d+)?\]\s*/, '').replace(/\s*(?:\[Live\]|\(Live\))\s*/gi,' ').trim();}
function formatDuration(seconds){const total=Math.round((Number(seconds)||0)/60);if(!total)return '';const hours=Math.floor(total/60),minutes=total%60;return hours?`${hours}h${minutes?' '+minutes+'m':''}`:`${minutes}m`;}
function formatFileSize(kb){const n=Number(kb)||0;return n>=1024?`${(n/1024).toFixed(1)} MB`:`${Math.max(1,Math.round(n))} KB`;}
function getCourseFlow(course=''){
  const vids=state.videos.filter(v=>!course||v.course===course).map(v=>({...v,item_type:'video',flow_order:Number(v.flow_order??9999)}));
  const mats=(state.materials||[]).filter(m=>!course||m.course===course).map(m=>({...m,item_type:'material',flow_order:Number(m.flow_order??9999)}));
  return [...vids,...mats].sort((a,b)=>a.course.localeCompare(b.course)||(a.flow_order-b.flow_order)||((a.item_type==='video'?0:1)-(b.item_type==='video'?0:1))||String(a.title||a.name).localeCompare(String(b.title||b.name)));
}
function materialIcon(ext){const e=String(ext||'').toLowerCase();return '';}
function materialSvgIcon(ext){const e=String(ext||'').toLowerCase();return icon(e==='ipynb'?'notebook':e==='pdf'?'pdf':(e==='pptx'||e==='ppt')?'slides':(e==='zip'||e==='tar'||e==='gz')?'archive':(e==='py'||e==='sql'||e==='sh'||e==='js')?'code':(e==='csv'||e==='parquet'||e==='json')?'dataset':'file');}
function openFlowItem(item){if(!item)return Promise.resolve();return item.item_type==='material'?openMaterial(item):openVideo(item.id);}
window.getCourseFlow=getCourseFlow;window.openFlowItem=openFlowItem;
function openCourse(course){const lessons=state.videos.filter(v=>v.course===course.name);$('#lessonCourse').value=course.name;renderLessons();const recent=nextUpLesson({name:course.name,videos:lessons})||lessons[0];updateBreadcrumbs(course.name,recent?lessonTitle(recent.title):null);navigate('learning');if(recent)openVideo(recent.id).catch(err=>toast(err.message,true));}

function updateHeroAction(){
  const btn=$('#heroLearnBtn');
  if(!btn)return;
  const resumeBanner=$('#smartResumeBanner');
  if(resumeBanner){
    request('/api/smart-resume').then(res=>{
      if(res&&res.show_banner){
        $('#smartResumeText').textContent=res.banner_text;
        resumeBanner.hidden=false;
      }else{
        resumeBanner.hidden=true;
      }
    }).catch(()=>{if(resumeBanner)resumeBanner.hidden=true;});
  }
  const courses=groupCourses();
  if(!courses.length){
    btn.innerHTML=`<span>Browse courses</span> <svg class="icon"><use href="#i-arrow"/></svg>`;
    btn.onclick=()=>navigate('library');
    return;
  }
  let targetCourse=courses.find(c=>c.percent>0&&c.percent<100);
  if(!targetCourse)targetCourse=courses.find(c=>c.percent===0)||courses[0];
  const next=targetCourse.nextLesson||targetCourse.videos[0];
  if(next){
    const p=state.progress.get(next.id);
    const isStarted=p&&(p.percent>0||p.position>0);
    const label=isStarted?`Continue "${lessonTitle(next.title)}"`:`Start "${lessonTitle(next.title)}"`;
    btn.innerHTML=`<span>${label}</span> <svg class="icon"><use href="#i-arrow"/></svg>`;
    btn.onclick=()=>{
      openCourse(targetCourse);
      openVideo(next.id).catch(err=>toast(err.message,true));
    };
  }else{
    btn.innerHTML=`<span>Continue learning</span> <svg class="icon"><use href="#i-arrow"/></svg>`;
    btn.onclick=()=>openCourse(targetCourse);
  }
}

function triggerLessonCheckMoment(){
  document.querySelector('.lesson-check-moment')?.remove();
  const checkEl=make('div','lesson-check-moment');
  checkEl.innerHTML=`<div class="check-circle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></div><strong>Lesson completed!</strong>`;
  document.body.append(checkEl);
  setTimeout(()=>checkEl.classList.add('visible'),30);
  setTimeout(()=>{
    checkEl.classList.remove('visible');
    setTimeout(()=>checkEl.remove(),400);
  },2200);
}

function showCourseCompletion(course){
  const dialog=$('#courseCompletionDialog');
  if(!dialog)return;
  const user=window.CourseForgeAccount?.user?.name||'Dedicated Learner';
  const cName=course.title||course.name||course.id;
  $('#completionStudentName').textContent=user;
  $('#completionCourseName').textContent=cName;
  $('#completionLessonCount').textContent=`${(course.videos||[]).length} lessons completed`;
  $('#completionDate').textContent=new Date().toLocaleDateString(undefined,{year:'numeric',month:'long',day:'numeric'});
  const codeEl=$('#completionCode');const linkEl=$('#completionVerifyLink');const btnEl=$('#completionVerifyBtn');
  if(codeEl)codeEl.textContent='Checking…';
  if(linkEl)linkEl.hidden=true;
  if(btnEl)btnEl.hidden=true;
  request(`/api/courses/${encodeURIComponent(cName)}/certificate`).then(res=>{
    if(res.issued){
      if(codeEl)codeEl.textContent=res.verification_code;
      if(linkEl){linkEl.href=res.verify_url;linkEl.hidden=false;}
      if(btnEl){btnEl.href=res.verify_url;btnEl.hidden=false;}
      $('#completionShareBtn').onclick=()=>{
        const shareText=`I just completed ${cName} and earned an official Certificate of Completion on CourseForge! Verify at: ${window.location.origin}${res.verify_url}`;
        navigator.clipboard?.writeText(shareText).then(()=>toast('Achievement & verification link copied!')).catch(()=>toast('Ready to screenshot.'));
      };
    }else{
      if(codeEl)codeEl.textContent='Complete all lesson quizzes to issue public certificate';
    }
  }).catch(()=>{
    if(codeEl)codeEl.textContent='Complete all lesson quizzes to issue certificate';
  });
  $('#completionShareBtn').onclick=()=>{
    const shareText=`I just completed all ${(course.videos||[]).length} lessons in ${cName} on CourseForge!`;
    navigator.clipboard?.writeText(shareText).then(()=>toast('Achievement copied to clipboard!')).catch(()=>toast('Course completed! Ready to screenshot.'));
  };
  $('#completionCloseBtn').onclick=()=>{dialog.close();navigate('library');};
  dialog.showModal();
}

function updateWeeklyRecap(habitData){
  const recap=$('#weeklyRecap');
  if(!recap)return;
  if(!habitData?.week){recap.hidden=true;return;}
  recap.hidden=false;
  const secs=habitData.week.watched_seconds||0;
  const lessons=habitData.week.lessons||0;
  const mins=Math.round(secs/60);
  const hrs=Math.floor(mins/60);
  const remMins=mins%60;
  const timeStr=hrs>0?`${hrs}h ${remMins}m`:`${mins}m`;
  $('#recapText').textContent=`You learned ${timeStr} across ${lessons} lesson${lessons===1?'':'s'} this week. Your next lesson is ready whenever you are!`;
  const optInBtn=$('#recapOptInBtn');
  if(optInBtn){
    const on=Boolean(habitData.preferences?.reminder_email);
    optInBtn.textContent=`Email recap: ${on?'On':'Off'}`;
    optInBtn.classList.toggle('active',on);
    optInBtn.onclick=async()=>{
      try{
        const nextState=!on;
        const res=await services.saveHabitPrefs({
          goal:habitData.preferences?.goal||'minutes',
          timezone:habitData.preferences?.timezone||'UTC',
          reminder_email:nextState
        });
        toast(nextState?'Weekly recap emails turned on.':'Weekly recap emails turned off.');
        updateWeeklyRecap(res);
      }catch(err){toast(err.message,true);}
    };
  }
}

function triggerGoalCelebration(){
  const toastEl=make('div','goal-celebration-toast');
  toastEl.innerHTML=`<span class="celebration-spark"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-trophy"/></svg></span> <strong>Daily goal reached!</strong> Streak updated.`;
  document.body.append(toastEl);
  setTimeout(()=>toastEl.classList.add('visible'),50);
  setTimeout(()=>{
    toastEl.classList.remove('visible');
    setTimeout(()=>toastEl.remove(),400);
  },3500);
}
window.CourseForgeCompletion={triggerLessonCheckMoment,showCourseCompletion,triggerGoalCelebration};

function buildCourseCard(course){
  const tile=make('div','course-tile');
  const button=make('button','course-card');button.type='button';button.style.cssText='border:1px solid var(--line);padding:0;text-align:left;color:inherit';
  const [a,b,symbol,category]=coverFor(course.name);const cover=make('div','course-cover');
  cover.style.setProperty('--cover-a',a);cover.style.setProperty('--cover-b',b);
  const posterUrl = `/api/artwork/courses/${encodeURIComponent(course.name)}/poster`;
  const img=make('img','course-cover-img');img.src=posterUrl;img.alt='';img.loading='lazy';img.decoding='async';
  img.addEventListener('load',()=>cover.classList.add('has-image'));
  img.addEventListener('error',()=>{if(course.cover_url)img.src=course.cover_url+'?rev='+state.coverRevision;});
  cover.append(img);
  const body=make('div','course-body');
  body.append(make('div','course-category',course.recentlyViewed?'Recently viewed':'Your course'));
  body.append(make('h3','',course.title||course.name));
  const length=course.videos.reduce((total,v)=>total+(Number(v.duration)||0),0);
  const matCount=(course.materials||[]).length;
  body.append(make('div','course-meta',`${course.videos.length} lessons${matCount?` · ${matCount} materials`:''}${course.videos.every(v=>v.duration)&&length?' · '+formatDuration(length):''}`));
  if(course.instructor)body.append(make('div','course-byline',`By ${course.instructor}`));
  body.append(make('span','course-topic',course.category||courseCategory(course.name)));
  if(course.nextLesson){
    const nextRow=make('div','course-next-up');
    nextRow.append(make('span','next-up-pill','Next up'),make('span','next-up-title',lessonTitle(course.nextLesson.title)));
    body.append(nextRow);
  }
  if(course.tags?.length){const tags=make('div','course-tags');for(const tag of course.tags.slice(0,3))tags.append(make('span','course-tag',tag));body.append(tags);}
  const line=make('div','course-progress-line');line.append(make('span','',`${course.completed} of ${course.videos.length} lessons`));line.append(make('b','',`${course.percent}%`));body.append(line);
  const progress=make('div','progress-track');const bar=make('span');bar.style.width=course.percent+'%';progress.append(bar);body.append(progress);
  const bottom=make('div','course-bottom');
  if(course.percent===100){
    bottom.append(make('span','','View certificate'));
    bottom.append(icon('arrow'));
    button.addEventListener('click',()=>showCourseCompletion(course));
  }else{
    bottom.append(make('span','',course.percent>0?'Continue learning':'Start learning'));
    bottom.append(icon('arrow'));
    button.addEventListener('click',()=>openCourse(course));
  }
  button.append(body);
  tile.append(button);
  if(course.cover_url&&window.CourseForgeAccount?.user?.role==='admin'){const edit=make('button','course-edit-btn','Edit details');edit.type='button';edit.setAttribute('aria-label',`Edit details for ${course.title||course.name}`);edit.addEventListener('click',()=>openCourseEditor(course));tile.append(edit);}
  return tile;
}
function openCourseEditor(course){
  state.editingCourse=course.name;
  $('#courseEditTitle').value=course.title||course.name;
  $('#courseEditInstructor').value=course.instructor||'';
  $('#courseEditCategory').value=course.category||'';
  $('#courseEditTags').value=(course.tags||[]).join(', ');
  $('#courseEditFile').value='';
  $('#courseCoverReset').hidden=course.cover_kind!=='custom';
  $('#courseEditError').textContent='';
  $('#courseEditHeading').textContent=`Edit ${course.title||course.name}`;
  $('#courseEditDialog').showModal();$('#courseEditTitle').focus();
}
$('#courseEditCancel').addEventListener('click',()=>$('#courseEditDialog').close());
$('#courseEditDialog').addEventListener('close',()=>{state.editingCourse=null;});
$('#courseEditForm').addEventListener('submit',async event=>{
  event.preventDefault();const course=state.editingCourse;if(!course)return;
  const save=$('#courseEditSave');save.disabled=true;$('#courseEditError').textContent='';
  try{
    const tags=$('#courseEditTags').value.split(',').map(t=>t.trim()).filter(Boolean);
    const data={title:$('#courseEditTitle').value.trim(),instructor:$('#courseEditInstructor').value.trim(),category:$('#courseEditCategory').value.trim(),tags};
    let updated=await services.updateCourse(course,data);
    const file=$('#courseEditFile').files[0];
    if(file){if(file.size>4*1024*1024)throw new Error('Image must be smaller than 4 MiB');updated=await services.uploadCover(course,file);}
    state.courseMeta.set(course,updated);state.coverRevision++;renderCatalog();$('#courseEditDialog').close();toast('Course details updated.');
  }catch(error){$('#courseEditError').textContent=error.message;}finally{save.disabled=false;}
});
$('#courseCoverReset').addEventListener('click',async()=>{
  const course=state.editingCourse;if(!course)return;
  try{await services.resetCover(course);const {courses}=await services.courses();state.courseMeta=new Map(courses.map(c=>[c.id,c]));state.coverRevision++;renderCatalog();$('#courseEditDialog').close();toast('Automatic video cover restored.');}catch(error){$('#courseEditError').textContent=error.message;}
});
function courseCategory(name){return (/kubernetes|ansible|docker|devops|cloud|linux/i.test(name)?'Cloud & DevOps Engineering':/data|spark|sql|databricks|analytics/i.test(name)?'Data Engineering':/agentic|genai|llm|ai/i.test(name)?'AI & Agentic Systems':/java|backend|python|javascript|golang|web/i.test(name)?'Software Development':'General');}
function renderCatalog(){if(location.hash.startsWith('#/my-list')||location.hash==='#my-list'){window.CourseForgeBrowse?.renderMyListView();return;}if(location.hash.startsWith('#/history')||location.hash==='#history'){window.CourseForgeBrowse?.renderHistoryView();return;}const all=groupCourses();updateHeroAction();const totalMats=(state.materials||[]).length;$('#featuredCourses').setAttribute('aria-busy','false');$('#courseCatalog').setAttribute('aria-busy','false');$('#statCourses').textContent=all.length;$('#statVideos').textContent=state.videos.length;$('#statIndexed').textContent=state.videos.filter(v=>v.status==='done').length;$('#statCompleted').textContent=state.videos.filter(v=>state.progress.get(v.id)?.completed).length;$('#sideCourseCount').textContent=all.length;$('#countLabel').textContent=`${state.videos.length} lessons · ${totalMats} materials`;
  const featured=$('#featuredCourses');featured.replaceChildren();
  const recentFirst=[...all].sort((a,b)=>(Number(b.recentlyViewed)-Number(a.recentlyViewed))||(b.lastActivity-a.lastActivity)||(b.percent-a.percent));
  for(const course of recentFirst.slice(0,3))featured.append(buildCourseCard(course));
  if(!all.length){const hint=make('div','panel empty-featured');hint.append(make('h3','','Your learning library starts here'));const admin=window.CourseForgeAccount?.user?.role==='admin';hint.append(make('p','',admin?'Import a course to organize your library.':'Enroll in a published course to start learning.'));const c=make('button','btn btn-primary',admin?'Scan my library':'Browse courses');c.addEventListener('click',admin?scanLibrary:()=>document.getElementById('catalogNav').click());hint.append(c);featured.append(hint);}
  const categorySelect=$('#categoryFilter');const categories=[...new Set(all.map(c=>c.category||courseCategory(c.name)))].sort();const oldCategory=categorySelect.value;categorySelect.replaceChildren(new Option('All categories','all'));categories.forEach(c=>categorySelect.add(new Option(c,c)));categorySelect.value=categories.includes(oldCategory)?oldCategory:'all';state.category=categorySelect.value;
  let visible=all.filter(c=>[c.name,c.title||'',c.instructor||'',c.category||'',...(c.tags||[])].some(t=>t.toLowerCase().includes(state.search))||c.videos.some(v=>v.title.toLowerCase().includes(state.search)||(v.section||'').toLowerCase().includes(state.search))||(c.materials||[]).some(m=>(m.friendly_name||m.name||'').toLowerCase().includes(state.search)||(m.material_type||'').toLowerCase().includes(state.search)));
  if(state.category!=='all')visible=visible.filter(c=>(c.category||courseCategory(c.name))===state.category);
  if(state.libraryFilter==='active')visible=visible.filter(c=>c.percent>0&&c.percent<100);
  if(state.libraryFilter==='completed')visible=visible.filter(c=>c.percent===100);
  if(state.libraryFilter==='unstarted')visible=visible.filter(c=>c.percent===0&&c.completed===0);
  if(state.librarySort==='title')visible.sort((a,b)=>(a.title||a.name).localeCompare(b.title||b.name));else if(state.librarySort==='duration')visible.sort((a,b)=>b.videos.reduce((sum,v)=>sum+(v.duration||0),0)-a.videos.reduce((sum,v)=>sum+(v.duration||0),0));else if(state.librarySort==='progress')visible.sort((a,b)=>b.percent-a.percent);
  $('#libraryCount').textContent=`Showing ${visible.length} of ${all.length} courses`;
  $('#libraryEmpty').hidden=!!visible.length||!!all.length;
  const catalog=$('#courseCatalog');catalog.replaceChildren();
  const byCategory=new Map();
  for(const course of visible){
    const cat=course.category||courseCategory(course.name);
    if(!byCategory.has(cat))byCategory.set(cat,[]);
    byCategory.get(cat).push(course);
  }
  for(const [cat,coursesInCat] of byCategory){
    const header=make('div','catalog-category-header');
    header.append(make('h2','',cat),make('span','tag',`${coursesInCat.length} ${coursesInCat.length===1?'course':'courses'}`));
    catalog.append(header);
    for(const course of coursesInCat)catalog.append(buildCourseCard(course));
  }
  if(!visible.length&&all.length){const hint=make('p','muted',state.search?'No courses match your search. Try a different keyword.':'No courses match this filter yet.');catalog.append(hint);}
}
function renderSelects(){const courses=groupCourses();for(const id of ['#scope','#studyCourse','#lessonCourse']){const select=$(id);const old=select.value;select.replaceChildren();if(id==='#scope')select.add(new Option('Entire course library','all'));else if(id==='#studyCourse')select.add(new Option('Choose a course',''));else select.add(new Option('All courses',''));for(const c of courses){if(id==='#studyCourse'&&!c.indexed)continue;const totalItems=c.videos.length+(c.materials?.length||0);select.add(new Option(`${c.title||c.name}${id==='#scope'?' ('+totalItems+')':''}`,id==='#scope'?'course:'+c.name:c.name));}if([...select.options].some(x=>x.value===old))select.value=old;else if(id==='#studyCourse'&&select.options.length>1)select.selectedIndex=1;}
  const scope=$('#scope');const selected=scope.value;for(const v of state.videos){scope.add(new Option(`↳ ${v.title}`,'video:'+v.id));}if([...scope.options].some(x=>x.value===selected))scope.value=selected;
}
function getViewerName(){return window.CourseForgeAccount?.user?.name || '';}
function openMaterialsModal(course=null){return window.CourseForgeAcademy?.materials(course);}
function previewMaterialInline(mat){
  const preview=$('#lessonMaterialPreview');
  if(!preview)return openMaterial(mat);
  preview.hidden=false;preview.replaceChildren();
  const bar=make('div','material-preview-bar');
  const titleWrap=make('strong','');titleWrap.style.cssText='display:inline-flex;align-items:center;gap:8px';
  titleWrap.append(materialSvgIcon(mat.ext),make('span','',mat.friendly_name||mat.name));
  bar.append(titleWrap,make('span','tag',`${mat.material_type||'File'} · ${formatFileSize(mat.size_kb)}`));
  const actions=make('div','material-preview-actions');
  const dl=make('a','btn btn-outline');dl.href=mat.download_url||(mat.url+'?download=1');dl.setAttribute('download','');dl.append(icon('download'),make('span','','Download'));
  const close=make('button','btn btn-outline','Close preview');close.type='button';close.onclick=()=>{preview.hidden=true;preview.replaceChildren();};
  actions.append(dl,close);bar.append(actions);
  const frame=make('iframe','material-preview-frame');frame.title=mat.friendly_name||mat.name;frame.src=mat.url;
  preview.append(bar,frame);
  preview.scrollIntoView({behavior:'smooth',block:'nearest'});
}
function buildMaterialCard(mat){
  const card=make('div','material-item-card');
  const main=make('div','material-item-main');
  main.append(materialSvgIcon(mat.ext));
  const text=make('div','material-item-text');
  text.append(make('strong','material-item-title',mat.friendly_name||mat.name),make('span','',`${mat.material_type||'Resource'} · ${formatFileSize(mat.size_kb)}`));
  main.append(make('span','material-type-badge',mat.material_type||'Resource'),text);
  const actions=make('div','material-item-actions');
  const openBtn=make('button','btn btn-outline btn-sm material-open-btn','Open in browser');openBtn.type='button';
  openBtn.onclick=()=>previewMaterialInline(mat);
  const dlLink=make('a','btn btn-outline btn-sm material-download-btn');
  dlLink.href=mat.download_url||(mat.url+'?download=1');dlLink.setAttribute('download','');
  dlLink.append(icon('download'),make('span','','Download'));
  actions.append(openBtn,dlLink);
  card.append(main,actions);
  return card;
}
function renderLessonMaterials(video){
  const sectionEl=$('#lessonMaterialsSection'),listEl=$('#lessonMaterialsList'),previewEl=$('#lessonMaterialPreview');
  const tabEl=$('#tab-materials'),railListEl=$('#railMaterialsList');
  if(!sectionEl||!listEl||!tabEl||!railListEl)return;
  previewEl.hidden=true;previewEl.replaceChildren();
  const lessonMats=(state.materials||[]).filter(m=>m.course===video.course&&m.scope!=='section'&&m.lesson_id===video.id);
  listEl.replaceChildren();railListEl.replaceChildren();
  if(!lessonMats.length){
    sectionEl.hidden=true;
    tabEl.hidden=true;tabEl.classList.remove('lesson-tab');
    if(state.studyTab==='materials')selectLessonTab('lessons',false);
    return;
  }
  sectionEl.hidden=false;
  $('#lessonMaterialsHeading').textContent=`Materials for ${lessonTitle(video.title)}`;
  $('#lessonMaterialsCount').textContent=`${lessonMats.length} ${lessonMats.length===1?'file':'files'}`;
  tabEl.hidden=false;tabEl.classList.add('lesson-tab');tabEl.textContent=`Materials (${lessonMats.length})`;
  for(const mat of lessonMats){
    listEl.append(buildMaterialCard(mat));
    railListEl.append(buildMaterialCard(mat));
  }
}
function renderLessons(){
  const course=$('#lessonCourse').value;const list=$('#courseList');list.replaceChildren();
  const vids=state.videos.filter(v=>!course||v.course===course);
  const courseGroups=new Map();
  for(const v of vids){if(!courseGroups.has(v.course))courseGroups.set(v.course,[]);courseGroups.get(v.course).push(v);}
  let vidCount=0;
  for(const [courseName,courseVids] of courseGroups){
    list.append(make('div','lesson-course-label',state.courseMeta.get(courseName)?.title||courseName));
    const nextUp=nextUpLesson({name:courseName,videos:courseVids});
    const sections=new Map();
    for(const v of courseVids){
      const sec=v.section||'Module 1 — Course Foundations';
      if(!sections.has(sec))sections.set(sec,[]);
      sections.get(sec).push(v);
    }
    const sectionMats=(state.materials||[]).filter(m=>m.course===courseName&&m.scope==='section');
    let courseIdx=0;
    for(const [secTitle,secVids] of sections){
      const details=make('details','lesson-section');
      details.open=true;
      const summary=make('summary','lesson-section-summary');
      const doneInSec=secVids.filter(v=>state.progress.get(v.id)?.completed).length;
      const titleSpan=make('span','lesson-section-title');titleSpan.style.cssText='display:inline-flex;align-items:center;gap:6px';
      titleSpan.append(icon('folder'),make('span','',secTitle));
      summary.append(titleSpan,make('span','lesson-section-count',`${doneInSec}/${secVids.length}`));
      details.append(summary);
      const secBody=make('div','lesson-section-body');
      for(const item of secVids){
        courseIdx++;vidCount++;
        const isCurrent=state.currentVideoId===item.id;
        const isNextUp=nextUp&&nextUp.id===item.id;
        const attachedMats=(state.materials||[]).filter(m=>m.course===courseName&&m.scope!=='section'&&m.lesson_id===item.id);
        const btn=make('a','lesson-link'+(isCurrent?' active':'')+(isNextUp?' is-next-up':''));
        btn.dataset.vid=item.id;btn.href='#/lecture/'+encodeURIComponent(item.id);
        if(isCurrent)btn.setAttribute('aria-current','true');
        const number=make('span','lesson-number',String(courseIdx).padStart(2,'0'));
        if(state.progress.get(item.id)?.completed){number.replaceChildren(icon('check'));number.setAttribute('aria-label','Completed');}
        btn.append(number);
        const t=make('span','lesson-text');
        const nameRow=make('span','name',lessonTitle(item.title));
        if(isNextUp)nameRow.append(make('span','next-up-badge','Next up'));
        if(state.quizPassed?.has(item.id)){const lb=make('span','lesson-learned-badge');lb.append(icon('check'),document.createTextNode(' Learned'));nameRow.append(lb);}
        t.append(nameRow);
        const p=state.progress.get(item.id);
        const baseStatus=p?.completed?'Completed':p?.position>0?'In progress':item.cloud_ready?'Ready to watch':'Coming soon';
        const matLabel=attachedMats.length?`${attachedMats.length} ${attachedMats.length===1?'material':'materials'}`:'';
        t.append(make('span','status',[formatDuration(item.duration),baseStatus,matLabel].filter(Boolean).join(' · ')));
        btn.append(t);
        btn.addEventListener('click',event=>{if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();openVideo(item.id).catch(err=>toast(err.message,true));});
        secBody.append(btn);
      }
      const sharedForSec=sectionMats.filter(m=>(m.section||secTitle)===secTitle);
      for(const sm of sharedForSec){
        const sharedRow=make('div','section-shared-file');
        const sharedInfo=make('div','section-shared-info');
        sharedInfo.append(materialSvgIcon(sm.ext));
        const infoTxt=make('div','');
        infoTxt.append(make('strong','',sm.friendly_name||sm.name),make('span','',`${sm.material_type||'Archive'} · ${formatFileSize(sm.size_kb)}`));
        sharedInfo.append(infoTxt);
        const sharedActions=make('span','section-shared-actions');
        const previewBtn=make('button','text-link','Preview');previewBtn.type='button';previewBtn.onclick=()=>openMaterial(sm);
        const dlBtn=make('a','text-link','Download');dlBtn.href=sm.download_url||(sm.url+'?download=1');dlBtn.setAttribute('download','');
        sharedActions.append(previewBtn,dlBtn);
        sharedRow.append(sharedInfo,sharedActions);
        secBody.append(sharedRow);
      }
      details.append(secBody);
      list.append(details);
    }
  }
  const totalMats=(state.materials||[]).filter(m=>!course||m.course===course).length;
  $('#lessonCount').textContent=`${vidCount} lessons${totalMats?` · ${totalMats} files`:''}`;
}
function renderUniversalSearch(rawQuery){
  const panel=$('#universalSearchResults');
  const q=String(rawQuery||'').trim().toLowerCase();
  if(!q){panel.hidden=true;panel.replaceChildren();return;}
  const allCourses=groupCourses();
  const matchedCourses=allCourses.filter(c=>[c.name,c.title||'',c.category||'',c.instructor||'',...(c.tags||[])].some(x=>x.toLowerCase().includes(q))).slice(0,5);
  const matchedLessons=state.videos.filter(v=>[v.title,v.section||'',v.course].some(x=>String(x||'').toLowerCase().includes(q))).slice(0,8);
  const matchedMaterials=(state.materials||[]).filter(m=>[m.friendly_name||'',m.name||'',m.material_type||'',m.section||'',m.course||''].some(x=>String(x||'').toLowerCase().includes(q))).slice(0,8);
  panel.replaceChildren();
  const head=make('div','universal-search-header');
  head.append(make('strong','',`Search results for “${rawQuery.trim()}”`));
  const closeBtn=make('button','text-link','Close');closeBtn.type='button';closeBtn.onclick=()=>{panel.hidden=true;};
  head.append(closeBtn);panel.append(head);
  if(!matchedCourses.length&&!matchedLessons.length&&!matchedMaterials.length){
    panel.append(make('p','muted','No matching courses, lessons, or materials found.'));
    panel.hidden=false;return;
  }
  const grid=make('div','universal-search-columns');
  if(matchedCourses.length){
    const col=make('div','search-group');col.append(make('h4','','Courses'));
    for(const c of matchedCourses){
      const item=make('button','search-result-item');item.type='button';
      item.append(make('strong','',c.title||c.name),make('small','',`${c.category||courseCategory(c.name)} · ${c.videos.length} lessons`));
      item.onclick=()=>{panel.hidden=true;openCourse(c);};
      col.append(item);
    }
    grid.append(col);
  }
  if(matchedLessons.length){
    const col=make('div','search-group');col.append(make('h4','','Lessons'));
    for(const v of matchedLessons){
      const item=make('button','search-result-item');item.type='button';
      item.append(make('strong','',lessonTitle(v.title)),make('small','',`${v.course} · ${v.section||'Lesson'}`));
      item.onclick=()=>{panel.hidden=true;openVideo(v.id).catch(err=>toast(err.message,true));};
      col.append(item);
    }
    grid.append(col);
  }
  if(matchedMaterials.length){
    const col=make('div','search-group');col.append(make('h4','','Lesson materials'));
    for(const m of matchedMaterials){
      const strongEl=make('strong');strongEl.append(materialSvgIcon(m.ext),document.createTextNode(' '+(m.friendly_name||m.name)));
      item.append(strongEl,make('small','',`${m.material_type||'File'} · ${formatFileSize(m.size_kb)} · ${m.course}`));
      item.onclick=async()=>{
        panel.hidden=true;
        if(m.lesson_id){await openVideo(m.lesson_id);previewMaterialInline(m);}
        else await openMaterial(m);
      };
      col.append(item);
    }
    grid.append(col);
  }
  panel.append(grid);panel.hidden=false;
  const curGen=++searchReqGen;
  request(`/api/search?q=${encodeURIComponent(rawQuery.trim())}`).then(data=>{
    if(curGen!==searchReqGen||panel.hidden)return;
    if(data.moments&&data.moments.length){
      let col=grid.querySelector('#searchMomentsCol');
      if(!col){
        col=make('div','search-group');
        col.id='searchMomentsCol';
        grid.append(col);
      }
      col.replaceChildren(make('h4','','Transcript moments'));
      for(const m of data.moments.slice(0,6)){
        const item=make('button','search-result-item search-moment-item');
        item.type='button';
        item.append(make('strong','',`${lessonTitle(m.title)} · ${m.time_label}`),make('p','',`“${m.text}…”`));
        item.onclick=()=>{panel.hidden=true;openVideo(m.video_id,m.start).catch(err=>toast(err.message,true));};
        col.append(item);
      }
    }
  }).catch(()=>{});
}
let searchReqGen=0;
function renderJobs(){const active=state.jobs.filter(j=>j.status==='processing');const queued=state.jobs.filter(j=>j.status==='queued');const failed=state.jobs.filter(j=>j.status==='failed');$('#jobSummary').textContent=active.length?`Indexing: ${active[0].title}`:queued.length?`${queued.length} queued · ${failed.length} failed`:failed.length?`${failed.length} imports need attention`:'Your library is ready';}
async function loadLibrary(){const [{videos},{jobs},{progress},catalog,matRes]=await Promise.all([request('/api/videos'),(window.CourseForgeAccount?.user?.role==='admin'?request('/api/jobs'):Promise.resolve({jobs:[]})),request('/api/progress'),services.courses().catch(()=>({courses:[]})),request('/api/materials').catch(()=>({materials:[]}))]);state.videos=videos;state.materials=matRes.materials||[];state.jobs=jobs;state.progress=new Map(progress.map(p=>[p.video_id,p]));state.courseMeta=new Map((catalog.courses||[]).map(c=>[c.id,c]));renderCatalog();renderSelects();renderLessons();renderJobs();}
async function scanLibrary(){for(const btn of ['#scanBtn','#scanBtnSide','#scanBtnLibrary','#emptyScanBtn'])$(btn).disabled=true;try{const result=await request('/api/scan',{method:'POST'});await loadLibrary();toast(`Found ${result.found} videos · ${result.imported} new · ${result.changed} changed. Processing continues in the worker.`);}catch(err){toast(err.message,true)}finally{for(const btn of ['#scanBtn','#scanBtnSide','#scanBtnLibrary','#emptyScanBtn'])$(btn).disabled=false;}}
for(const selector of ['#scanBtn','#scanBtnSide','#scanBtnLibrary','#emptyScanBtn'])$(selector).addEventListener('click',scanLibrary);
$('#refreshBtn').addEventListener('click',()=>loadLibrary().catch(err=>toast(err.message,true)));
$('#heroLearnBtn').addEventListener('click',()=>{const courses=groupCourses();if(courses.length)openCourse(courses.find(c=>c.percent>0&&c.percent<100)||courses[0]);else navigate('library')});
$$('[data-filter]').forEach(button=>button.addEventListener('click',()=>{state.libraryFilter=button.dataset.filter;$$('[data-filter]').forEach(el=>el.classList.toggle('active',el===button));renderCatalog()}));
$('#categoryFilter').addEventListener('change',event=>{state.category=event.target.value;renderCatalog()});
$('#librarySort').addEventListener('change',event=>{state.librarySort=event.target.value;renderCatalog()});
$('#librarySearch').addEventListener('input',event=>{state.search=event.target.value.trim().toLowerCase();renderCatalog()});
$('#globalSearch').addEventListener('input',event=>{const raw=event.target.value;state.search=raw.trim().toLowerCase();$('#librarySearch').value=raw;renderCatalog();renderUniversalSearch(raw);});
$('#globalSearch').addEventListener('focus',event=>{if(event.target.value.trim())renderUniversalSearch(event.target.value);});
$('#globalSearch').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();$('#universalSearchResults').hidden=true;navigate('library')}});
$('#lessonCourse').addEventListener('change',renderLessons);
let openingGeneration=0;
window.CourseForgeCancelVideoOpen=()=>{openingGeneration++;};
async function openMaterial(item){
  const generation=++openingGeneration;
  window.CourseForgeStudio?.cancelNext();window.CourseForgeNative?.stop();await window.CourseForgePlayerSession?.close();window.CourseForgeAcademy?.stopActivity();
  if(generation!==openingGeneration)return;
  state.selectedId=item.id;state.currentVideoId=item.id;state.currentCourse=item.course;
  const player=$('#player');player.pause();player.hidden=true;$('#emptyPlayer').hidden=true;
  let wrap=document.getElementById('lecturePlayerWrap');if(!wrap){wrap=make('div','lecture-player-wrap');wrap.id='lecturePlayerWrap';player.parentElement.append(wrap);}
  wrap.replaceChildren();
  const iframe=make('iframe');iframe.title=item.friendly_name||item.name;iframe.src=item.url;
  iframe.style.cssText='width:100%;min-height:560px;border:0;background:#0f1420';
  iframe.allowFullscreen=true;
  const tools=make('div','embedded-actions');
  const badge=make('span','muted');
  badge.append(materialSvgIcon(item.ext),document.createTextNode(` ${item.material_type||String(item.ext||'FILE').toUpperCase()} · ${formatFileSize(item.size_kb)}`));
  const dl=make('a','btn btn-outline');dl.href=item.download_url||(item.url+'?download=1');dl.target='_blank';dl.rel='noopener';dl.append(icon('download'),document.createTextNode(' Download file'));
  const pop=make('a','btn btn-outline');pop.href=item.url;pop.target='_blank';pop.rel='noopener';pop.append(icon('arrow'),document.createTextNode(' Open in tab'));
  const resources=make('button','btn btn-outline');resources.type='button';resources.onclick=()=>openMaterialsModal(item.course);resources.append(icon('paperclip'),document.createTextNode(' All course files'));
  tools.append(badge,dl,pop,resources);wrap.replaceChildren(iframe,tools);
  $('#playingDetails').hidden=false;$('#playingTitle').replaceChildren(materialSvgIcon(item.ext),document.createTextNode(' '+(item.friendly_name||item.name)));
  $('#playingCourse').textContent=`${item.material_type||'Course material'} · ${formatFileSize(item.size_kb)}`;
  updateBreadcrumbs(item.course,item.friendly_name||item.name);
  $('#lessonCourse').value=item.course;renderLessons();navigate('learning');
}
async function loadCourseQuizzes(courseName){
  if(!courseName)return;
  try{
    const res=await request(`/api/courses/${encodeURIComponent(courseName)}/quizzes/status`);
    if(!state.quizPassed)state.quizPassed=new Set();
    Object.keys(res.status||{}).forEach(id=>state.quizPassed.add(id));
  }catch{}
}

async function renderLessonQuiz(video){
  const container=$('#quizContainer');
  const tag=$('#quizStatusTag');
  const heading=$('#quizHeading');
  const subtext=$('#quizSubtext');
  if(!container)return;
  container.replaceChildren(make('p','muted','Loading lesson quiz…'));
  try{
    const data=await request(`/api/videos/${encodeURIComponent(video.id)}/quiz`);
    const status=data.status||{};
    heading.textContent=`Quiz: ${lessonTitle(video.title)}`;
    if(status.passed){
      tag.className='tag mint';
      tag.replaceChildren(icon('check'),document.createTextNode(' Learned'));
      subtext.textContent=`You passed this quiz with ${status.last_score}%. Retake anytime to refresh your recall.`;
      if(!state.quizPassed)state.quizPassed=new Set();
      state.quizPassed.add(video.id);
    }else if(status.attempts>0){
      tag.className='tag orange';
      tag.textContent=`Score: ${status.last_score}%`;
      subtext.textContent='Review suggested sections and try again to earn your Learned badge.';
    }else{
      tag.className='tag';
      tag.textContent='Not attempted';
      subtext.textContent=`Answer ${data.question_count} questions to test your understanding and earn Learned status.`;
    }

    container.replaceChildren();
    const form=make('form','quiz-form');
    data.questions.forEach((q,idx)=>{
      const qBlock=make('div','quiz-question-block');
      qBlock.append(make('h4','quiz-stem',`${idx+1}. ${q.question}`));
      const optList=make('div','quiz-options');
      q.options.forEach((optText,oIdx)=>{
        const optLabel=make('label','quiz-option-label');
        const radio=document.createElement('input');
        radio.type='radio';
        radio.name=`quiz_q_${q.id}`;
        radio.value=String(oIdx);
        radio.required=true;
        optLabel.append(radio,make('span','quiz-opt-text',optText));
        optList.append(optLabel);
      });
      qBlock.append(optList);
      form.append(qBlock);
    });

    const submitBtn=make('button','btn btn-primary full',status.passed?'Submit re-attempt':'Submit answers');
    submitBtn.type='submit';
    form.append(submitBtn);

    form.onsubmit=async(e)=>{
      e.preventDefault();
      const answers={};
      data.questions.forEach(q=>{
        const sel=form.querySelector(`input[name="quiz_q_${q.id}"]:checked`);
        if(sel)answers[q.id]=parseInt(sel.value,10);
      });
      submitBtn.disabled=true;
      submitBtn.textContent='Grading quiz…';
      try{
        const res=await request(`/api/videos/${encodeURIComponent(video.id)}/quiz/attempts`,services.json('POST',{
          quiz_id:data.quiz_id,
          answers:answers
        }));
        if(res.passed){
          tag.className='tag mint';
          tag.replaceChildren(icon('check'),document.createTextNode(' Learned'));
          toast(`Lesson Learned! Scored ${res.score}%. Your streak and habit have been updated.`);
          if(!state.quizPassed)state.quizPassed=new Set();
          state.quizPassed.add(video.id);
          const checkEl=document.querySelector('.lesson-check-moment');
          if(checkEl){
            checkEl.classList.remove('active');
            void checkEl.offsetWidth;
            checkEl.classList.add('active');
            setTimeout(()=>checkEl.classList.remove('active'),2500);
          }
          await renderLessonQuiz(video);
          await loadHabits();
          renderLessons();
          const crs=state.videos.filter(v=>v.course===video.course);
          const doneAll=crs.every(v=>state.progress.get(v.id)?.completed);
          if(doneAll)showCourseCompletion({name:video.course,title:video.course,videos:crs});
        }else{
          tag.className='tag orange';
          tag.textContent=`Score: ${res.score}%`;
          toast(`Scored ${res.score}%. ${res.suggested_review}`,true);
          const fb=make('div','quiz-retry-box');
          fb.append(make('h4','','Keep going — you’re close!'));
          fb.append(make('p','muted',res.suggested_review));
          const retryBtn=make('button','btn btn-outline','Try again');
          retryBtn.type='button';
          retryBtn.onclick=()=>renderLessonQuiz(video);
          fb.append(retryBtn);
          container.replaceChildren(fb);
        }
      }catch(err){
        toast(err.message||'Quiz submission failed',true);
        submitBtn.disabled=false;
        submitBtn.textContent='Submit answers';
      }
    };
    container.append(form);
  }catch(err){
    container.replaceChildren(make('p','muted','Quiz questions for this lesson are being prepared.'));
  }
}

async function renderLessonBrief(video){
  const container=$('#briefContainer');
  const tag=$('#briefStatusTag');
  const heading=$('#briefHeading');
  if(!container)return;
  container.replaceChildren(make('p','muted','Loading lesson brief…'));
  if(heading)heading.textContent=`In this lesson: ${lessonTitle(video.title)}`;
  try{
    const res=await request(`/api/videos/${encodeURIComponent(video.id)}/brief`);
    if(!res.available||!res.bullets||!res.bullets.length){
      if(tag)tag.textContent='Transcribing';
      container.replaceChildren(make('p','muted','Lesson brief will appear once lecture transcripts are indexed.'));
      return;
    }
    if(tag)tag.textContent='Ready';
    container.replaceChildren();

    const sec1=make('div','brief-section');
    sec1.append(make('h4','','5 Key Concepts & Takeaways'));
    const ul=make('ul','brief-bullets');
    for(const b of res.bullets){
      ul.append(make('li','',b));
    }
    sec1.append(ul);

    const sec2=make('div','brief-section');
    sec2.append(make('h4','','Prerequisites'));
    sec2.append(make('p','brief-text',res.prerequisites||'Basic cloud & data fundamentals.'));

    const sec3=make('div','brief-section');
    sec3.append(make('h4','','What you’ll be able to build'));
    sec3.append(make('p','brief-text',res.outcome||'Production architectures and workflows.'));

    container.append(sec1,sec2,sec3);
  }catch(err){
    container.replaceChildren(make('p','muted','Brief currently unavailable for this lesson.'));
  }
}

async function openVideo(id,at=null){
  const existingMedia=window.CourseForgeNative?.video();
  if(id===state.currentVideoId&&at!==null&&existingMedia&&!existingMedia.error&&existingMedia.readyState>=1&&Number.isFinite(existingMedia.duration)){
    if(window.CourseForgeNative.locked()){toast('Unlock the player before seeking.');return;}
    window.CourseForgeNative.seek(at,true);syncLessonRoute(id,at);return;
  }
  const generation=++openingGeneration,current=()=>generation===openingGeneration;
  window.CourseForgeStudio?.cancelNext();window.CourseForgeNative?.stop();await window.CourseForgePlayerSession?.close();window.CourseForgeAcademy?.stopActivity();
  const cached=state.videos.find(v=>v.id===id);
  const {video,chunks}=cached?{video:cached,chunks:[]}:await request(`/api/videos/${encodeURIComponent(id)}`);if(!current())return;
  state.selectedId=id;state.currentVideoId=id;state.currentCourse=video.course;if(window.CourseForgeAccount){if(!window.CourseForgeAccount.lastLessons)window.CourseForgeAccount.lastLessons={};window.CourseForgeAccount.lastLessons[video.course]=id;}
  updateBreadcrumbs(video.course,lessonTitle(video.title));
  renderLessonMaterials(video);
  renderLessonQuiz(video);
  renderLessonBrief(video);
  loadCourseQuizzes(video.course).then(()=>renderLessons());
  const player=$('#player');player.pause();player.hidden=true;$('#emptyPlayer').hidden=true;
  let wrap=document.getElementById('lecturePlayerWrap');if(!wrap){wrap=make('div','lecture-player-wrap');wrap.id='lecturePlayerWrap';player.parentElement.append(wrap);}
  wrap.replaceChildren(make('p','player-loading','Preparing your lecture…'));
  navigate('learning');syncLessonRoute(id,at,true);window.CourseForgeStudio.update(video);
  const start=at===null?(state.progress.get(id)?.position||0):at;
  const startNative=async psid=>{
    const session=await request(`/api/videos/${encodeURIComponent(id)}/native-session`,services.json('POST',{start_pos:start,player_session_id:psid}));
    if(!current())return;
    wrap.replaceChildren();await window.CourseForgeNative.open(wrap,video,session,()=>renderFailure('We couldn’t load this lesson. Please retry, or try the alternative player.'));
  };
  const startEmbedded=async()=>{
    window.CourseForgeServices?.trackStreamingEvent('failover', 'cloud_to_local', { video_id: id });
    const point=window.CourseForgeNative.currentPosition()??start;window.CourseForgeNative.stop();
    let psid=window.CourseForgePlayerSession.current();
    if(!psid)psid=await window.CourseForgePlayerSession.open(video,current,window.CourseForgeStudio.ownershipLost);
    if(!psid||!current())return;
    const session=await request(`/api/videos/${encodeURIComponent(id)}/playback-session`,services.json('POST',{start_pos:point,player_session_id:psid}));if(!current())return;
    const iframe=make('iframe');iframe.title=video.title;iframe.src=session.vault_url;iframe.allow='autoplay; fullscreen; encrypted-media';iframe.allowFullscreen=true;
    const tools=make('div','embedded-actions'),label=make('label','','Resume point'),input=make('input','form-input');input.value=prettyTime(point);input.setAttribute('aria-label','Manually saved resume timestamp');label.append(input);
    const save=make('button','btn btn-outline','Save resume');save.onclick=async()=>{try{await request(`/api/videos/${id}/resume-point`,services.json('PUT',{position:window.CourseForgeAcademy.parseTimestamp(input.value)}));toast('Resume point saved.');}catch(error){toast(error.message,true);}};
    const native=make('button','btn btn-outline','CourseForge player');native.onclick=()=>openVideo(id,point).catch(error=>toast(error.message,true));
    tools.append(label,save,native);wrap.replaceChildren(iframe,tools);$('#playingCourse').textContent='Save your place using the resume point below the player.';
  };
  function renderFailure(message){
    if(!current())return;
    wrap.querySelector('.player-recovery')?.remove();
    const failure=make('div','player-unavailable');failure.append(make('h3','','This lesson couldn’t open'),make('p','',message));
    const actions=make('div','dialog-actions');
    for(const [label,fn]of [['Retry',()=>openVideo(id,window.CourseForgeNative.currentPosition()??start)],['Alternative player',startEmbedded]]){
      const b=make('button','btn btn-outline',label);b.type='button';b.onclick=()=>Promise.resolve(fn()).catch(()=>toast('This lesson couldn’t open. Please try again shortly.',true));actions.append(b);
    }failure.append(actions);
    const stage=wrap.querySelector('.native-player-stage');if(stage){failure.className='player-recovery';stage.append(failure);}else wrap.replaceChildren(failure);
  }
  $('#playingDetails').hidden=false;$('#playingTitle').textContent=lessonTitle(video.title);window.CourseForgeStudio.completion(Boolean(state.progress.get(id)?.completed));
  const timeline=$('#timeline');timeline.replaceChildren();if(!chunks.length)timeline.append(make('p','muted','A transcript is not available for this lecture yet.'));
  for(const chunk of chunks){const item=make('button','timeline-btn');item.type='button';item.append(make('span','',prettyTime(chunk.start)),make('div','',chunk.text||''));item.onclick=()=>openVideo(id,chunk.start).catch(error=>toast(error.message,true));timeline.append(item);}
  $('#lessonCourse').value=video.course;renderLessons();$('#lessonSummary').textContent='Create a summary to revisit the key ideas.';$('#noteText').value='';$('#notePosition').value=prettyTime(start);
  window.CourseForgeLoadPlayer?.();
  if(cached)request(`/api/videos/${encodeURIComponent(id)}`).then(result=>{
    if(!current())return;const timeline=$('#timeline');timeline.replaceChildren();
    if(!result.chunks.length)timeline.append(make('p','muted','A transcript is not available for this lesson yet.'));
    for(const chunk of result.chunks){const item=make('button','timeline-btn');item.type='button';item.append(make('span','',prettyTime(chunk.start)),make('div','',chunk.text||''));item.onclick=()=>openVideo(id,chunk.start).catch(error=>toast(error.message,true));timeline.append(item);}
  }).catch(()=>{});
  try{
    if(!video.cloud_ready){renderFailure('This lesson isn’t ready yet. Choose another lesson to keep learning.');return;}
    const psid=await window.CourseForgePlayerSession.open(video,current,window.CourseForgeStudio.ownershipLost);
    if(!current())return;
    if(psid)await startNative(psid);else renderFailure('Playback stays in your other window. Select Retry when you want to move it here.');
  }catch(error){renderFailure(error.status===401?'Please sign in again to continue learning.':'This lesson couldn’t open. Please retry in a moment.');}
  if(!current())return;
  await loadNotes(id);if(!current())return;
  await window.CourseForgeAcademy?.startActivity(id,current);await window.CourseForgeAcademy?.loadBookmarks(id);
}
$('#markCompleteBtn').addEventListener('click',async()=>{
  if(!state.currentVideoId)return;
  const id=state.currentVideoId,completed=Boolean(state.progress.get(id)?.completed);
  const button=$('#markCompleteBtn');button.disabled=true;
  try{await request(`/api/videos/${id}/progress`,services.json('PUT',{percent:completed?0:100,position:state.progress.get(id)?.position||0}));
    await loadLibrary();if(state.currentVideoId===id)window.CourseForgeStudio.completion(!completed);
    if(!completed){
      triggerLessonCheckMoment();
      const currentVid=state.videos.find(v=>v.id===id);
      if(currentVid){
        const courseLessons=state.videos.filter(v=>v.course===currentVid.course);
        const allDone=courseLessons.every(v=>v.id===id||state.progress.get(v.id)?.completed);
        if(allDone){
          const meta=state.courseMeta.get(currentVid.course)||{};
          showCourseCompletion({name:currentVid.course,title:meta.title||currentVid.course,videos:courseLessons});
        }
      }
    }
    toast(completed?'Completion undone.':'Lesson completed.');
  }catch(error){toast('We couldn’t save your progress. Please try again.',true);}finally{button.disabled=false;}
});
$('#reindexBtn').addEventListener('click',async()=>{if(!state.currentVideoId)return;try{const result=await request(`/api/videos/${state.currentVideoId}/reindex`,{method:'POST'});toast(result.message);await loadLibrary()}catch(err){toast(err.message,true)}});
$('#askAboutVideo').addEventListener('click',()=>{if(!state.currentVideoId)return;$('#scope').value='video:'+state.currentVideoId;$('#question').value='Explain the key ideas from this lesson with examples and references to timestamps.';navigate('tutor');$('#question').focus()});
const currentScope=()=>{const value=$('#scope').value;return value==='all'?{}:value.startsWith('video:')?{video_id:value.slice(6)}:{course:value.slice(7)};};
$$('.mode').forEach(button=>button.addEventListener('click',()=>{state.mode=button.dataset.mode;$$('.mode').forEach(el=>el.classList.toggle('active',el===button));$('#question').placeholder=({explain:'Explain a concept from my lectures…',notes:'Create concise notes from this course…',quiz:'Quiz me on what I learned…',lab:'Give me a practical exercise…'})[state.mode]}));
$$('[data-prompt]').forEach(button=>button.addEventListener('click',()=>{$('#question').value=button.dataset.prompt;$('#question').focus();}));
function renderTutorAnswer(text){
  const el=$('#answer');
  if(!el)return;
  el.replaceChildren();
  const linkRegex=/\[([^\]]+)\]\(#learning\/([^?]+)\?t=(\d+)\)/g;
  let lastIdx=0,m;
  const wrap=document.createElement('div');
  while((m=linkRegex.exec(text))!==null){
    const before=text.slice(lastIdx,m.index);
    if(before)wrap.append(document.createTextNode(before));
    const label=m[1],vid=m[2],seek=parseInt(m[3],10);
    const a=make('a','tutor-timestamp-link',label);
    a.href=`#learning/${vid}?t=${seek}`;
    a.onclick=e=>{e.preventDefault();openVideo(vid,seek).catch(err=>toast(err.message,true));};
    wrap.append(a);
    lastIdx=m.index+m[0].length;
  }
  const rem=text.slice(lastIdx);
  if(rem)wrap.append(document.createTextNode(rem));
  el.append(wrap);
}

async function askTutor(){const question=$('#question').value.trim();if(!question)return toast('Enter a question first.',true);const btn=$('#askBtn');btn.disabled=true;btn.textContent='Searching your lessons…';try{const result=await request('/api/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question,mode:state.mode,...currentScope()})});state.lastAnswer=result.answer;renderTutorAnswer(result.answer);$('#answerPanel').hidden=false;
    const turn=make('div','chat-turn');turn.append(make('strong','','You asked'));turn.append(make('p','',question));$('#tutorHistory').prepend(turn);
    const follow=$('#followUps');follow.replaceChildren();for(const prompt of ['Show me a practical example with a timestamp.','Give me one question to check my understanding.','Compare this concept with a related one.']){const suggestion=make('button','btn btn-outline',prompt);suggestion.addEventListener('click',()=>{$('#question').value=prompt+' Context: '+question;$('#question').focus()});follow.append(suggestion)}
const sources=$('#sources');sources.replaceChildren();for(const source of result.sources||[]){const button=make('button','source');button.append(make('strong','',`${source.label} · ${source.title}`));button.append(make('small','',`${source.course} · ${prettyTime(source.start)} · ${source.kind}`));button.append(make('p','',(source.text||'Extracted frame').slice(0,185)));if(source.frame_path){const image=make('img');image.src=`/api/chunks/${encodeURIComponent(source.chunk_id)}/frame`;image.loading='lazy';image.alt='Extracted source screen';button.append(image);}button.addEventListener('click',()=>openVideo(source.video_id,source.start).catch(err=>toast(err.message,true)));sources.append(button);}toast(`${(result.sources||[]).length} lecture sources retrieved. Check the original video for critical details.`);}catch(err){toast(err.message,true)}finally{btn.disabled=false;btn.replaceChildren(document.createTextNode('Ask tutor '),icon('arrow'));}}
$('#askForm').addEventListener('submit',event=>{event.preventDefault();askTutor()});
$('#copyBtn').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(state.lastAnswer);toast('Explanation copied.')}catch{toast('Copy failed. Please select the explanation manually.',true)}});
const selectedStudyCourse=()=>$('#studyCourse').value;
async function loadSyllabus(){if(!selectedStudyCourse()){$('#syllabusSummary').textContent='Choose a course to create a study path.';$('#syllabusItems').replaceChildren();return;}const {syllabus}=await request('/api/syllabus?course='+encodeURIComponent(selectedStudyCourse()));const target=$('#syllabusItems');target.replaceChildren();if(!syllabus){$('#syllabusSummary').textContent='No saved path yet. Click Build / refresh path.';return;}$('#syllabusSummary').textContent=`${syllabus.topics.length} unique topics · ${syllabus.duplicates_collapsed} overlaps merged · ${syllabus.video_count} lectures analyzed`;for(const topic of syllabus.topics){const node=make('div','topic');node.append(make('strong','',`${topic.order}. ${topic.title}`));if(topic.objectives?.length)node.append(make('p','',topic.objectives.join(' · ')));node.append(make('p','',`${topic.sources.length} lecture references`));for(const source of topic.sources){const btn=make('button','',`${source.video_title} · ${prettyTime(source.start)}`);btn.addEventListener('click',()=>openVideo(source.video_id,source.start).catch(err=>toast(err.message,true)));node.append(btn);}target.append(node);}}
$('#studyCourse').addEventListener('change',()=>{loadSyllabus().catch(err=>toast(err.message,true));loadDue().catch(()=>{})});
$('#loadSyllabusBtn').addEventListener('click',()=>loadSyllabus().catch(err=>toast(err.message,true)));
$('#buildSyllabusBtn').addEventListener('click',async()=>{const course=selectedStudyCourse();if(!course)return toast('Choose a course first.',true);const btn=$('#buildSyllabusBtn');btn.disabled=true;$('#syllabusSummary').textContent='Creating your study path…';try{await request('/api/syllabus/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({course})});await loadSyllabus();}catch(err){$('#syllabusSummary').textContent=err.message}finally{btn.disabled=false}});
async function loadDue(){let url='/api/reviews/adaptive';if(selectedStudyCourse())url+='?course='+encodeURIComponent(selectedStudyCourse());const {cards}=await request(url).catch(()=>request('/api/reviews/due'+(selectedStudyCourse()?'?course='+encodeURIComponent(selectedStudyCourse()):'')));state.dueCards=cards||[];showReview();}
function showReview(){state.activeCard=state.dueCards.shift()||null;$('#reviewCard').hidden=!state.activeCard;const badge=state.activeCard?.adaptive_tag?` [${state.activeCard.adaptive_tag}]`:'';$('#reviewStatus').textContent=state.activeCard?`${state.dueCards.length+1} cards in this review session${badge}`:'You’re all caught up. Create flashcards from your lessons to keep practising.';if(!state.activeCard)return;$('#reviewQuestion').textContent=state.activeCard.question;$('#reviewAnswer').textContent=state.activeCard.answer;$('#reviewAnswer').hidden=true;$('#reviewGrades').hidden=true;$('#revealAnswerBtn').hidden=false;}
$('#generateCardsBtn').addEventListener('click',async()=>{const course=selectedStudyCourse();if(!course)return toast('Choose a course in Study paths first.',true);const btn=$('#generateCardsBtn');btn.disabled=true;$('#reviewStatus').textContent='Creating your flashcards…';try{const result=await request('/api/reviews/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({course,topic:$('#reviewTopic').value.trim()||'key concepts',count:5})});await loadDue();toast(`${result.created} flashcards created.`)}catch(err){$('#reviewStatus').textContent=err.message}finally{btn.disabled=false}});
$('#loadDueBtn').addEventListener('click',()=>loadDue().catch(err=>toast(err.message,true)));
$('#revealAnswerBtn').addEventListener('click',()=>{$('#reviewAnswer').hidden=false;$('#revealAnswerBtn').hidden=true;$('#reviewGrades').hidden=false});
$$('[data-quality]').forEach(button=>button.addEventListener('click',async()=>{if(!state.activeCard)return;button.disabled=true;try{const curCourse=state.activeCard.course;await request(`/api/reviews/${state.activeCard.id}/grade`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({quality:Number(button.dataset.quality)})});await request('/api/reviews/complete',services.json('POST',{course:curCourse,cards_count:1})).catch(()=>{});await loadHabits().catch(()=>{});showReview();loadInsights().catch(()=>{});}catch(err){toast(err.message,true)}finally{button.disabled=false}}));
$('#reviewSource').addEventListener('click',()=>{if(state.activeCard)openVideo(state.activeCard.video_id,state.activeCard.source_start).catch(err=>toast(err.message,true))});
let labCatalogCache=[];
function paintLabCatalog(){
  const list=$('#labCatalog');list.setAttribute('aria-busy','false');list.replaceChildren();
  const choice=$('#labCategoryFilter').value;
  const filtered=labCatalogCache.filter(lab=>choice==='all'||lab.category===choice);
  if(!filtered.length){list.append(make('p','muted','No exercises in this category.'));return;}
  for(const lab of filtered){
    const button=make('button','lab-card');button.type='button';
    button.setAttribute('aria-label',`Start ${lab.title}`);
    const symbol=make('span','lab-symbol');symbol.append(icon('code'));button.append(symbol);
    button.append(make('span','lab-meta',`${lab.category||'Practice'} · ${lab.level||'Guided'}`));
    button.append(make('strong','',lab.title));button.append(make('small','',lab.objective));
    button.append(make('span','lab-cta',lab.type==='static'?'Check configuration →':'Start practice →'));
    button.addEventListener('click',async()=>{try{
      const session=await request(`/api/labs/${encodeURIComponent(lab.slug)}/start`,{method:'POST'});
      activateLabSession(session,button);
    }catch(err){toast(err.message,true)}});
    list.append(button);
  }
}
function activateLabSession(session,selectedButton=null){
  state.currentLab=session;
  const focusLab=document.getElementById('focusLab');if(focusLab){focusLab.dataset.sessionId=session.session_id;focusLab.dataset.labTitle=session.title;}
  navigate('labs',true);
  $('#labEditor').hidden=false;
  $('#labTitle').textContent=session.title;
  $('#labObjective').textContent=session.objective;
  $('#labFilename').textContent=session.filename;
  $('#labCode').value=session.content;
  $('#kindCheck').parentElement.hidden=session.type!=='kubernetes';
  $('#kindCheck').checked=false;
  $('#labResult').replaceChildren();
  $$('.lab-card').forEach(x=>x.classList.remove('selected'));
  if(selectedButton)selectedButton.classList.add('selected');
  if(session.practice_context){
    $('#labResult').textContent='Linked practice for your learning path. Only a verified grader result updates the practice history.';
  }
  $('#labEditor').scrollIntoView({behavior:'smooth',block:'start'});
}
window.CourseForgeLabs=Object.freeze({openSession:activateLabSession});
async function loadLabs(){const {labs}=await request('/api/labs');labCatalogCache=labs;paintLabCatalog();}
$('#labCategoryFilter').addEventListener('change',paintLabCatalog);
async function saveLab(){if(!state.currentLab)return;return request(`/api/lab-sessions/${state.currentLab.session_id}/file`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:$('#labCode').value})});}
$('#saveLabBtn').addEventListener('click',async()=>{try{await saveLab();toast('Solution saved locally.')}catch(err){toast(err.message,true)}});
$('#submitLabBtn').addEventListener('click',async()=>{if(!state.currentLab)return;const btn=$('#submitLabBtn');btn.disabled=true;$('#labResult').textContent=state.currentLab.type==='static'?'Checking your work…':'Checking your work…';try{await saveLab();const result=await request(`/api/lab-sessions/${state.currentLab.session_id}/submit`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({validate_in_kind:$('#kindCheck').checked})});const target=$('#labResult');target.replaceChildren();target.append(make('strong','',result.passed?'All checks passed':'Some checks need attention'));for(const check of result.checks||[])target.append(make('div','grade-check',`${check.passed?'PASS':'FAIL'} · ${check.name}${check.details?' — '+check.details:''}`));if(result.kind)target.append(make('div','grade-check',result.kind.skipped?result.kind.reason:result.kind.details));if(result.practice_attempt){target.append(make('p','muted',result.practice_attempt.passed?'Verified practice pass saved. Take another topic check to confirm understanding.':'Practice attempt saved. Review failed checks and retry.'));window.dispatchEvent(new CustomEvent('courseforge:practicegraded',{detail:result.practice_attempt}));}}catch(err){$('#labResult').textContent=err.message}finally{btn.disabled=false}});

// Analytics reflect actual persisted self-reviews and completions, not speculative scores.
async function loadInsights(){
  const data=await services.insights();state.insights=data;
  $('#dashDue').textContent=String(data.due_count);
  $('#dashStreak').textContent=`${data.streak_days} day${data.streak_days===1?'':'s'}`;
  $('#dashMastery').textContent=data.mastery_signal_percent===null?'Not enough data':`${data.mastery_signal_percent}%`;
  $('#dashMastery').title=data.mastery_basis;
  $('#reviewDueCount').textContent=String(data.due_count);
  $('#reviewRecallRate').textContent=data.mastery_signal_percent===null?'—':`${data.mastery_signal_percent}%`;
  const history=$('#reviewHistory');history.replaceChildren();
  const weak=$('#weakAreas');weak.replaceChildren();
  for(const h of data.history){const item=make('div','insight-row');item.append(make('strong','',h.question));item.append(make('span','',`${h.course} · ${h.date} · ${['Again','Hard','Good','Easy'][h.quality===0?0:h.quality===3?1:h.quality===4?2:3]}`));history.append(item);}
  for(const item of data.weak_areas){const row=make('div','insight-row');row.append(make('strong','',item.question));row.append(make('span','',`Review again · ${item.course}`));weak.append(row);}
  if(!data.history.length)history.textContent='No graded reviews yet. Generate cards and rate your answers.';
  if(!data.weak_areas.length)weak.textContent='No cards marked Again recently.';
  const failed=state.jobs.filter(j=>j.status==='failed').length;
  const notifications=$('#notificationItems');notifications.replaceChildren();
  if(data.due_count)notifications.append(make('p','',`${data.due_count} flashcards are due for review.`));
  if(failed)notifications.append(make('p','',`${failed} video processing jobs need attention.`));
  if(!data.due_count&&!failed)notifications.append(make('p','muted','All caught up. Your learning activity is up to date.'));
  $('#notificationDot').hidden=!data.due_count&&!failed;

  try {
    const habitData=await services.habits();
    state.habits=habitData;
    const streakEl=$('#dashStreak');
    if(streakEl){
      if(habitData.streak>0){
        streakEl.innerHTML=`<span class="streak-flame"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-flame"/></svg></span> ${habitData.streak} day${habitData.streak===1?'':'s'}${habitData.today?.goal_met?' <span class="goal-met-badge"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-check"/></svg> Done</span>':''}`;
      } else {
        streakEl.textContent='0 days (start today)';
      }
    }
    const goalSelect=$('#goalMinutes');
    if(goalSelect&&habitData.preferences?.goal){
      goalSelect.value=habitData.preferences.goal;
    }
    updateWeeklyRecap(habitData);
  } catch(e) {
    $('#dashStreak').textContent=`${data.streak_days} day${data.streak_days===1?'':'s'}`;
  }
}
$('#goalMinutes')?.addEventListener('change',async event=>{
  const newGoal=event.target.value;
  try{
    const tz=state.habits?.preferences?.timezone||'UTC';
    const email=Boolean(state.habits?.preferences?.reminder_email);
    const updated=await services.saveHabitPrefs({goal:newGoal,timezone:tz,reminder_email:email});
    state.habits=updated;
    toast(`Daily habit goal set to ${newGoal==='lesson'?'1 lesson completed':'15 minutes of watching'}.`);
    if(updated.today?.goal_met)triggerGoalCelebration();
    await loadInsights();
  }catch(err){toast(err.message,true);}
});
function closeNotify(){$('#notifyPopover').hidden=true;$('#notifyBtn').setAttribute('aria-expanded','false');}
$('#notifyBtn').addEventListener('click',()=>{const open=$('#notifyPopover').hidden;closeTheme();$('#notifyPopover').hidden=!open;$('#notifyBtn').setAttribute('aria-expanded',String(open));if(open)$('#closeNotify').focus();});
$('#closeNotify').addEventListener('click',()=>{closeNotify();$('#notifyBtn').focus()});
// Use the database-backed notes API, never a pretend save button.
async function loadNotes(id){
  const {notes}=await services.notes(id);if(state.currentVideoId!==id)return;
  const target=$('#notesList');target.replaceChildren();
  if(!notes.length){target.append(make('p','muted','No notes for this lecture yet. Add your first note above.'));return;}
  for(const note of notes){const item=make('div','saved-note');const jump=make('button','text-link',prettyTime(note.position));jump.addEventListener('click',()=>openVideo(id,note.position).catch(error=>toast(error.message,true)));item.append(jump);item.append(make('p','',note.content));const del=make('button','small-delete','Delete');del.setAttribute('aria-label',`Delete note at ${prettyTime(note.position)}`);del.addEventListener('click',async()=>{try{await services.deleteNote(note.id);await loadNotes(id)}catch(err){toast(err.message,true)}});item.append(del);target.append(item);}
}
$('#noteForm').addEventListener('submit',async(event)=>{event.preventDefault();if(!state.currentVideoId)return toast('Choose a lesson first.',true);const text=$('#noteText').value.trim();if(!text)return;const btn=$('#saveNoteBtn');btn.disabled=true;try{await services.saveNote(state.currentVideoId,window.CourseForgeAcademy.parseTimestamp($('#notePosition').value),text);$('#noteText').value='';await loadNotes(state.currentVideoId);toast('Note saved at your selected timestamp.')}catch(err){toast(err.message,true)}finally{btn.disabled=false}});
function selectLessonTab(name,sync=true){
  if(!['lessons','brief','materials','quiz','notes','transcript','summary','path'].includes(name))name='lessons';
  if(name==='materials'&&$('#tab-materials')?.hidden)name='lessons';
  state.studyTab=name;
  $$('[data-lesson-tab]').forEach(tab=>{const selected=tab.dataset.lessonTab===name;tab.classList.toggle('active',selected);tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected||(['summary','path'].includes(name)&&tab.dataset.lessonTab==='lessons')?0:-1;});
  $$('[data-lesson-panel]').forEach(panel=>panel.hidden=panel.dataset.lessonPanel!==name);
  if(sync&&state.currentVideoId)syncLessonRoute(state.currentVideoId,null,true);
}
$$('[data-lesson-tab]').forEach(button=>{button.addEventListener('click',()=>selectLessonTab(button.dataset.lessonTab));button.addEventListener('keydown',event=>{const tabs=$$('[data-lesson-tab]').filter(t=>!t.hidden),index=tabs.indexOf(button);let next;if(event.key==='ArrowRight')next=tabs[(index+1)%tabs.length];else if(event.key==='ArrowLeft')next=tabs[(index+tabs.length-1)%tabs.length];else if(event.key==='Home')next=tabs[0];else if(event.key==='End')next=tabs.at(-1);if(next){event.preventDefault();next.focus();selectLessonTab(next.dataset.lessonTab);}});});
$('#nextLessonBtn').addEventListener('click',()=>{
  const next=window.CourseForgeStudio?.adjacent(1);
  if(next)openVideo(next.id).catch(error=>toast(error.message,true));
  else toast('You have reached the last lesson in this course.');
});
$('#generateSummaryBtn').addEventListener('click',async()=>{if(!state.currentVideoId)return toast('Choose a lesson first.',true);const btn=$('#generateSummaryBtn');btn.disabled=true;$('#lessonSummary').textContent='Creating your lesson summary…';try{const data=await request('/api/ask',services.json('POST',{question:'Summarize the learning objectives, key concepts, code or commands, and next steps from this lecture. Cite sources and timestamps.',mode:'notes',video_id:state.currentVideoId}));$('#lessonSummary').textContent=data.answer;}catch(err){$('#lessonSummary').textContent=err.message;}finally{btn.disabled=false}});
$('#guidedTutorBtn').addEventListener('click',()=>{state.mode='explain';$$('.mode').forEach(m=>m.classList.toggle('active',m.dataset.mode==='explain'));$('#question').value='Teach me a core concept from the selected course step by step. Start with intuition, then a worked example, then one question to check understanding. Include source timestamps.';navigate('tutor');$('#question').focus()});
$('#conceptCheckBtn').addEventListener('click',()=>{state.mode='quiz';$$('.mode').forEach(m=>m.classList.toggle('active',m.dataset.mode==='quiz'));$('#question').value='Give me one question to assess my understanding of the selected course, then explain the correct answer with a video citation. Do not claim to grade my knowledge without my response.';$('#question').focus()});
function recordConceptSignal(signal){const answer=state.lastAnswer;if(!answer)return;try{const history=JSON.parse(localStorage.getItem('courseforge-concept-feedback:'+window.CourseForgeAccount.user.id)||'[]');history.unshift({feedback:signal,summary:answer.slice(0,120),date:new Date().toISOString()});localStorage.setItem('courseforge-concept-feedback:'+window.CourseForgeAccount.user.id,JSON.stringify(history.slice(0,60)));}catch{}toast(signal==='confident'?'Confidence recorded on this device.':'Marked for extra practice on this device. Review the cited lecture next.');}
$('#conceptConfident').addEventListener('click',()=>recordConceptSignal('confident'));
$('#conceptUnsure').addEventListener('click',()=>recordConceptSignal('unsure'));
function renderPlannedLabs(){const target=$('#plannedLabs');target.replaceChildren();for(const text of ['Choose an exercise', 'Write your solution', 'Check your work', 'Review feedback']){const card=make('div','planned-lab');card.append(make('strong','',text));target.append(card);}}
async function loadSettings(){$('#settingsPaths').textContent='Your saved lessons, notes, and progress stay together in your account.';}
function syncGoal(){let value='30';try{value=localStorage.getItem('courseforge-daily-goal:'+window.CourseForgeAccount.user.id)||'30';}catch{}if(!['15','30','45','60'].includes(value))value='30';$('#goalMinutes').value=value;$('#settingsGoal').value=value;}
// Phase 5: Interview Prep Mode
let currentInterviewSession=null;
$('#interviewPrepModeBtn')?.addEventListener('click',async()=>{
  const dialog=$('#interviewPrepDialog');
  if(!dialog)return;
  dialog.showModal();
  $('#interviewWorkspace').hidden=true;
  $('#interviewTopicPicker').hidden=false;
  const list=$('#interviewTopicList');
  list.replaceChildren(make('p','muted','Analyzing your course library…'));
  try{
    const res=await request('/api/interview-prep/topics');
    list.replaceChildren();
    if(!res.topics||!res.topics.length){
      list.append(make('p','muted','Complete or watch lessons in your courses to unlock technical interview topics.'));
      return;
    }
    for(const t of res.topics){
      const btn=make('button','interview-topic-btn');
      btn.type='button';
      btn.append(
        make('span','',t.name),
        make('span','tag',`Readiness: ${t.readiness_score}%`)
      );
      btn.onclick=async()=>{
        list.replaceChildren(make('p','muted','Preparing question…'));
        try{
          const session=await request('/api/interview-prep/start',services.json('POST',{topic_id:t.topic_id}));
          currentInterviewSession=session;
          $('#activeTopicBadge').textContent=session.topic_name;
          $('#activeReadinessBadge').textContent=`Readiness: ${t.readiness_score}%`;
          $('#activeInterviewQuestion').textContent=session.question;
          $('#interviewAnswerInput').value='';
          $('#interviewFeedbackPanel').hidden=true;
          $('#interviewTopicPicker').hidden=true;
          $('#interviewWorkspace').hidden=false;
        }catch(err){toast(err.message,true);}
      };
      list.append(btn);
    }
  }catch(err){
    list.replaceChildren(make('p','muted','Interview prep topics currently unavailable.'));
  }
});

$('#interviewCloseBtn')?.addEventListener('click',()=>$('#interviewPrepDialog')?.close());
$('#interviewChangeTopicBtn')?.addEventListener('click',()=>{
  $('#interviewWorkspace').hidden=true;
  $('#interviewTopicPicker').hidden=false;
  $('#interviewPrepModeBtn')?.click();
});

$('#interviewAnswerForm')?.addEventListener('submit',async e=>{
  e.preventDefault();
  if(!currentInterviewSession)return;
  const ans=$('#interviewAnswerInput').value.trim();
  if(!ans)return;
  const btn=$('#interviewSubmitBtn');
  btn.disabled=true;
  btn.textContent='Evaluating…';
  try{
    const evalRes=await request('/api/interview-prep/evaluate',services.json('POST',{
      session_id:currentInterviewSession.session_id,
      answer:ans
    }));
    $('#interviewScoreTag').textContent=`Score: ${evalRes.score}/100`;
    $('#activeReadinessBadge').textContent=`Readiness: ${evalRes.readiness_score}%`;
    $('#interviewFeedbackText').textContent=evalRes.feedback;
    const citBox=$('#interviewCitations');
    citBox.replaceChildren();
    if(evalRes.citations&&evalRes.citations.length){
      citBox.append(make('h4','','Relevant Course Excerpts & Timestamps'));
      for(const cit of evalRes.citations){
        const cBtn=make('button','btn btn-outline',`Watch ${cit.timestamp} in ${cit.title}`);
        cBtn.type='button';
        cBtn.onclick=()=>{
          $('#interviewPrepDialog')?.close();
          openVideo(cit.video_id,cit.seconds).catch(err=>toast(err.message,true));
        };
        citBox.append(cBtn);
      }
    }
    $('#interviewFeedbackPanel').hidden=false;
  }catch(err){toast(err.message,true);}
  finally{btn.disabled=false;btn.innerHTML=`Evaluate answer <svg class="icon"><use href="#i-arrow"/></svg>`;}
});

$('#interviewNextQBtn')?.addEventListener('click',()=>{
  $('#interviewWorkspace').hidden=true;
  $('#interviewTopicPicker').hidden=false;
  $('#interviewPrepModeBtn')?.click();
});

// Phase 5: Placement Diagnostic
$('#openPlacementBtn')?.addEventListener('click',async()=>{
  const dialog=$('#placementDialog');
  if(!dialog)return;
  dialog.showModal();
  const container=$('#placementQuizContainer');
  const resultPanel=$('#placementResultPanel');
  resultPanel.hidden=true;
  container.replaceChildren(make('p','muted','Preparing 10 diagnostic questions…'));

  const curCourse=state.currentCourse||(state.videos[0]?.course)||'Deepak Data Engg';
  try{
    const res=await request(`/api/courses/${encodeURIComponent(curCourse)}/placement-test`);
    container.replaceChildren();
    const form=make('form','quiz-form');
    for(let i=0;i<res.questions.length;i++){
      const q=res.questions[i];
      const block=make('div','placement-question-card');
      const stem=make('p','quiz-stem',`${i+1}. [${q.level}] ${q.question}`);
      const optsDiv=make('div','quiz-options');
      q.options.forEach((optText,optIdx)=>{
        const lbl=make('label','quiz-option-label');
        const radio=document.createElement('input');
        radio.type='radio';
        radio.name=q.id;
        radio.value=String(optIdx);
        radio.required=true;
        lbl.append(radio,make('span','quiz-opt-text',optText));
        optsDiv.append(lbl);
      });
      block.append(stem,optsDiv);
      form.append(block);
    }
    const submitBtn=make('button','btn btn-primary full','Submit Diagnostic');
    submitBtn.type='submit';
    form.append(submitBtn);

    form.onsubmit=async e=>{
      e.preventDefault();
      submitBtn.disabled=true;
      submitBtn.textContent='Analyzing…';
      const answers={};
      const fd=new FormData(form);
      for(const [k,v] of fd.entries()){
        answers[k]=parseInt(v,10);
      }
      try{
        const evalRes=await request(`/api/courses/${encodeURIComponent(curCourse)}/placement-test/submit`,services.json('POST',{answers}));
        $('#placementScoreBadge').textContent=`Score: ${evalRes.score}% (${evalRes.level_label})`;
        $('#placementResultMessage').textContent=evalRes.message;
        $('#placementRecLessonTitle').textContent=evalRes.recommended_lesson_title;
        $('#placementJumpBtn').onclick=()=>{
          dialog.close();
          openVideo(evalRes.recommended_lesson_id).catch(err=>toast(err.message,true));
        };
        form.hidden=true;
        resultPanel.hidden=false;
      }catch(err){toast(err.message,true);submitBtn.disabled=false;submitBtn.textContent='Submit Diagnostic';}
    };
    container.append(form);
  }catch(err){
    container.replaceChildren(make('p','muted','Placement diagnostic currently unavailable.'));
  }
});
$('#placementCloseBtn')?.addEventListener('click',()=>$('#placementDialog')?.close());

window.CourseForgeBoot=async(initialData)=>{
  const initial=readLessonRoute();applyingRoute++;try{navigate(navNames[initial.view]?initial.view:'dashboard');}finally{applyingRoute--;}
  if(initialData){state.videos=initialData.videos;state.materials=initialData.materials||[];state.jobs=[];state.progress=new Map(initialData.progress.map(p=>[p.video_id,p]));state.courseMeta=new Map(initialData.courses.map(c=>[c.id,c]));renderCatalog();renderSelects();renderLessons();renderJobs();}else await loadLibrary();
  renderPlannedLabs();syncGoal();loadSettings();await window.CourseForgePlayerSession.loadPreferences(initialData?.preferences);
  document.documentElement.dataset.lessonInteractive='true';window.dispatchEvent(new Event('courseforge-interactive'));
  if(initial.view==='learning'&&initial.id){selectLessonTab(initial.tab,false);applyingRoute++;try{await openVideo(initial.id,initial.at);}finally{applyingRoute--;}}
  setTimeout(()=>Promise.allSettled([loadSyllabus(),loadDue(),loadInsights(),loadLabs()]),0);
};
setInterval(()=>{if(window.CourseForgeAccount?.user?.verified&&!document.hidden&&!$('#appShell').hidden)loadLibrary().catch(()=>{})},30000);

/* streaming-home.js */
/**
 * CourseForge Streaming Experience — Stage 2: Chrome & Cinematic Home
 *
 * Implements:
 * 1. Sticky Header scroll darkening and avatar menu.
 * 2. 6-second auto-rotating Billboard Hero Slider with pause on hover/focus.
 * 3. Netflix-style horizontal rows with smooth scroll, desktop chevrons, mobile snap.
 * 4. Cards: Continue Watching (16:9 + progress), Top 10 (SVG numerals + 2:3),
 *    Featured Masterclasses (2:3), New Episodes (16:9 + NEW chip), Category rows.
 */
(function() {
  'use strict';

  let heroSlides = [];
  let currentSlide = 0;
  let heroTimer = null;
  let isPaused = false;
  let savedMyList = new Set();

  // Scroll listener for sticky header glassmorphism
  window.addEventListener('scroll', function() {
    const isScrolled = window.scrollY > 15;
    const topbar = document.querySelector('.topbar');
    if (topbar) topbar.classList.toggle('scrolled', isScrolled);
    const academyHeader = document.querySelector('.academy-header');
    if (academyHeader) academyHeader.classList.toggle('scrolled', isScrolled);
  }, { passive: true });

  // Load My List items for visual bookmark state
  async function loadMyListIds() {
    try {
      const res = await fetch('/api/streaming/my-list');
      if (res.ok) {
        const data = await res.json();
        savedMyList = new Set((data.items || []).map(i => i.item_id));
      }
    } catch (_) {}
  }

  // --------------------------------------------------------------------------
  // Hero Billboard Slider
  // --------------------------------------------------------------------------
  function initStreamingBillboard(heroData) {
    const heroEl = document.getElementById('streamingHero');
    if (!heroEl || !heroData || !heroData.length) return;

    heroSlides = heroData;
    currentSlide = 0;

    renderDots();
    showSlide(currentSlide);
    startTimer();

    // Event listeners
    heroEl.addEventListener('mouseenter', pauseTimer);
    heroEl.addEventListener('mouseleave', resumeTimer);
    heroEl.addEventListener('focusin', pauseTimer);
    heroEl.addEventListener('focusout', resumeTimer);

    const prevBtn = document.getElementById('heroPrevBtn');
    const nextBtn = document.getElementById('heroNextBtn');
    if (prevBtn) prevBtn.onclick = () => { prevSlide(); resetTimer(); };
    if (nextBtn) nextBtn.onclick = () => { nextSlide(); resetTimer(); };

    heroEl.addEventListener('keydown', function(e) {
      if (e.key === 'ArrowLeft') { prevSlide(); resetTimer(); }
      else if (e.key === 'ArrowRight') { nextSlide(); resetTimer(); }
    });

    // Wire More Info button
    const infoBtn = document.getElementById('heroInfoBtn');
    if (infoBtn) {
      infoBtn.onclick = () => {
        const slide = heroSlides[currentSlide];
        if (slide?.slug) {
          location.hash = `#/course/${slide.slug}`;
        }
      };
    }

    // Wire My List button
    const listBtn = document.getElementById('heroListBtn');
    if (listBtn) {
      listBtn.onclick = async () => {
        const slide = heroSlides[currentSlide];
        if (!slide?.slug) return;
        const inList = savedMyList.has(slide.slug);
        try {
          const csrf = window.CourseForgeAccount?.csrf || '';
          if (inList) {
            await fetch(`/api/streaming/my-list/course/${slide.slug}`, {
              method: 'DELETE',
              headers: { 'X-CSRF-Token': csrf }
            });
            savedMyList.delete(slide.slug);
          } else {
            await fetch('/api/streaming/my-list', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
              body: JSON.stringify({ item_type: 'course', item_id: slide.slug })
            });
            savedMyList.add(slide.slug);
          }
          updateHeroListBtn();
          if (window.toast) {
            window.toast(inList ? 'Removed from My List' : 'Added to My List');
          }
        } catch (_) {}
      };
    }
  }

  function showSlide(index) {
    if (!heroSlides.length) return;
    currentSlide = (index + heroSlides.length) % heroSlides.length;
    const slide = heroSlides[currentSlide];

    const backdrop = document.getElementById('heroBackdrop');
    if (backdrop) {
      backdrop.style.opacity = '0';
      setTimeout(() => {
        backdrop.style.backgroundImage = `url("${slide.backdrop_url}")`;
        backdrop.style.opacity = '1';
      }, 150);
    }

    const badgeText = document.getElementById('heroBadgeText');
    if (badgeText) badgeText.textContent = slide.category ? `${slide.category} Masterclass` : 'Featured Series';

    const titleEl = document.getElementById('heroTitle');
    if (titleEl) titleEl.textContent = slide.title || '';

    const catEl = document.getElementById('heroCategory');
    if (catEl) catEl.textContent = slide.category || 'Engineering';

    const epsEl = document.getElementById('heroEpisodes');
    if (epsEl) epsEl.textContent = `${slide.lesson_count || 10} Episodes`;

    const durEl = document.getElementById('heroDuration');
    if (durEl) durEl.textContent = slide.duration ? formatDuration(slide.duration) : 'Full Series';

    const synEl = document.getElementById('heroSynopsis');
    if (synEl) synEl.textContent = slide.synopsis || 'Explore in-depth production workflows, structured modules, and verifiable engineering practices.';

    // Update play button text while keeping existing resume momentum
    const playBtn = document.getElementById('heroLearnBtn');
    if (playBtn) {
      const activeVideo = window.CourseForgeHabit?.activeLesson;
      if (!playBtn.dataset.originalBound) {
        playBtn.dataset.originalBound = 'true';
        playBtn.onclick = () => {
          window.CourseForgeServices?.trackStreamingEvent('row_click', 'billboard_hero', { item_id: slide.slug || slide.first_video_id });
          if (slide.first_video_id) {
            location.hash = `#/lecture/${slide.first_video_id}`;
          } else if (slide.slug) {
            location.hash = `#/course/${slide.slug}`;
          }
        };
      }
    }

    updateHeroListBtn();
    updateActiveDot();
  }

  function updateHeroListBtn() {
    const listBtn = document.getElementById('heroListBtn');
    if (!listBtn || !heroSlides[currentSlide]) return;
    const inList = savedMyList.has(heroSlides[currentSlide].slug);
    listBtn.innerHTML = inList
      ? `<svg class="icon"><use href="#i-check"/></svg> In My List`
      : `<svg class="icon"><use href="#i-bookmark"/></svg> My List`;
  }

  function renderDots() {
    const dotsContainer = document.getElementById('heroDots');
    if (!dotsContainer) return;
    dotsContainer.innerHTML = '';
    heroSlides.forEach((slide, idx) => {
      const dot = document.createElement('button');
      dot.className = `billboard-dot ${idx === currentSlide ? 'active' : ''}`;
      dot.setAttribute('aria-label', `Go to slide ${idx + 1}: ${slide.title}`);
      dot.onclick = () => {
        showSlide(idx);
        resetTimer();
      };
      dotsContainer.appendChild(dot);
    });
  }

  function updateActiveDot() {
    const dots = document.querySelectorAll('.billboard-dot');
    dots.forEach((dot, idx) => {
      dot.classList.toggle('active', idx === currentSlide);
    });
  }

  function nextSlide() {
    showSlide(currentSlide + 1);
  }

  function prevSlide() {
    showSlide(currentSlide - 1);
  }

  function startTimer() {
    clearInterval(heroTimer);
    heroTimer = setInterval(() => {
      if (!isPaused) nextSlide();
    }, 6000);
  }

  function resetTimer() {
    startTimer();
  }

  function pauseTimer() {
    isPaused = true;
  }

  function resumeTimer() {
    isPaused = false;
  }

  // --------------------------------------------------------------------------
  // Netflix-Style Horizontal Rows
  // --------------------------------------------------------------------------
  function renderStreamingRows(rows) {
    const container = document.getElementById('streamingCarousels');
    if (!container || !rows) return;
    container.innerHTML = '';

    rows.forEach(row => {
      if (!row.items || !row.items.length) return;

      const rowSec = document.createElement('section');
      rowSec.className = 'streaming-row';
      rowSec.dataset.rowId = row.id;

      // Header
      const header = document.createElement('div');
      header.className = 'row-header';
      header.innerHTML = `
        <h2 class="row-title">${escapeHtml(row.title)}</h2>
        <a class="row-explore" href="#library">Explore all <svg class="icon"><use href="#i-arrow"/></svg></a>
      `;
      rowSec.appendChild(header);

      // Slider wrapper
      const wrapper = document.createElement('div');
      wrapper.className = 'row-slider-wrapper';

      const prevBtn = document.createElement('button');
      prevBtn.className = 'row-nav-btn row-nav-prev';
      prevBtn.setAttribute('aria-label', `Previous ${row.title}`);
      prevBtn.innerHTML = `<svg class="icon"><use href="#i-chevron"/></svg>`;

      const track = document.createElement('div');
      track.className = 'row-track';
      track.tabIndex = 0;

      const nextBtn = document.createElement('button');
      nextBtn.className = 'row-nav-btn row-nav-next';
      nextBtn.setAttribute('aria-label', `Next ${row.title}`);
      nextBtn.innerHTML = `<svg class="icon"><use href="#i-chevron"/></svg>`;

      prevBtn.onclick = () => track.scrollBy({ left: -track.clientWidth * 0.75, behavior: 'smooth' });
      nextBtn.onclick = () => track.scrollBy({ left: track.clientWidth * 0.75, behavior: 'smooth' });

      // Render items according to row style
      row.items.forEach((item, index) => {
        let card;
        if (row.id === 'continue_watching') {
          card = buildContinueCard(item);
        } else if (row.id === 'trending_top_10') {
          card = buildTop10Card(item, index + 1);
        } else if (row.id === 'new_episodes') {
          card = buildNewEpisodeCard(item);
        } else {
          card = buildPosterCard(item);
        }
        card.addEventListener('click', () => {
          window.CourseForgeServices?.trackStreamingEvent('row_click', row.title || row.id, { item_id: item.id || item.slug, position: index + 1 });
        });
        track.appendChild(card);
      });

      wrapper.appendChild(prevBtn);
      wrapper.appendChild(track);
      wrapper.appendChild(nextBtn);
      rowSec.appendChild(wrapper);

      container.appendChild(rowSec);
    });
  }

  // 1. Continue Watching Card (16:9)
  function buildContinueCard(item) {
    const card = document.createElement('a');
    card.className = 'stream-card stream-card-continue';
    card.href = item.deep_link || `#/lecture/${item.id}`;

    const percent = Math.min(100, Math.round(((item.position || 0) / (item.duration || 1)) * 100));
    const remainingSec = Math.max(0, (item.duration || 0) - (item.position || 0));
    const remainingMins = Math.ceil(remainingSec / 60);

    card.innerHTML = `
      <div class="card-thumb-wrap">
        <img src="${escapeHtml(item.thumbnail_url)}" alt="${escapeHtml(item.title)}" loading="lazy" />
        <div class="card-play-overlay">
          <div class="card-play-icon"><svg class="icon"><use href="#i-play"/></svg></div>
        </div>
        <div class="card-progress-bar-wrap">
          <div class="card-progress-fill" style="width: ${percent}%;"></div>
        </div>
      </div>
      <div class="card-info">
        <span class="card-series-title">${escapeHtml(item.course || '')}</span>
        <strong class="card-episode-title">${escapeHtml(item.title)}</strong>
        <span class="card-time-remaining">${remainingMins}m remaining</span>
      </div>
    `;
    return card;
  }

  // 2. Top 10 Card (Big Numeral + 2:3 Poster)
  function buildTop10Card(item, rank) {
    const card = document.createElement('a');
    card.className = 'stream-card stream-card-top10';
    card.href = item.deep_link || `#/course/${item.slug}`;

    card.innerHTML = `
      <div class="top10-rank-wrap">
        <svg class="top10-num-svg" viewBox="0 0 45 80" aria-hidden="true">
          <text x="50%" y="70" text-anchor="middle" font-size="76" font-weight="900" font-family="sans-serif">${rank}</text>
        </svg>
      </div>
      <div class="top10-poster-wrap">
        <img src="${escapeHtml(item.poster_url)}" alt="${escapeHtml(item.title)}" loading="lazy" />
      </div>
    `;
    return card;
  }

  // 3. Featured / Masterclass Poster Card (2:3)
  function buildPosterCard(item) {
    const card = document.createElement('a');
    card.className = 'stream-card stream-card-poster';
    card.href = item.deep_link || `#/course/${item.slug}`;

    card.innerHTML = `
      <div class="poster-image-wrap">
        <img src="${escapeHtml(item.poster_url)}" alt="${escapeHtml(item.title)}" loading="lazy" />
        <span class="poster-badge">${escapeHtml(item.category || 'Masterclass')}</span>
      </div>
      <div class="poster-info">
        <strong class="poster-title">${escapeHtml(item.title)}</strong>
        <span class="poster-sub">${item.lesson_count || 12} Episodes</span>
      </div>
    `;
    return card;
  }

  // 4. New Episodes Card (16:9 Backdrop + NEW Chip)
  function buildNewEpisodeCard(item) {
    const card = document.createElement('a');
    card.className = 'stream-card stream-card-backdrop';
    card.href = item.deep_link || `#/lecture/${item.id}`;

    card.innerHTML = `
      <div class="backdrop-image-wrap">
        <img src="${escapeHtml(item.backdrop_url || item.thumbnail_url)}" alt="${escapeHtml(item.title)}" loading="lazy" />
        <span class="new-chip">NEW</span>
      </div>
      <div class="backdrop-info">
        <span class="backdrop-series">${escapeHtml(item.course || '')}</span>
        <strong class="backdrop-title">${escapeHtml(item.title)}</strong>
      </div>
    `;
    return card;
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------
  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDuration(sec) {
    const s = Number(sec) || 0;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  // Export module globally
  window.CourseForgeStreaming = {
    initStreamingBillboard,
    renderStreamingRows,
    loadMyListIds
  };

  // Auto-fetch streaming feed when dashboard is active
  async function loadStreamingHome() {
    try {
      await loadMyListIds();
      const res = await fetch('/api/streaming/home-feed');
      if (res.ok) {
        const feed = await res.json();
        if (feed.hero && feed.hero.length) {
          initStreamingBillboard(feed.hero);
        }
        if (feed.rows && feed.rows.length) {
          renderStreamingRows(feed.rows);
        }
      }
    } catch (_) {}
  }

  // Trigger on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadStreamingHome);
  } else {
    loadStreamingHome();
  }

})();

/* streaming-search.js */
/**
 * CourseForge Streaming Search — Stage 3: Search Overlay & Typeahead Suggest
 *
 * Implements:
 * 1. Focus trigger on header search and "/" keyboard shortcut.
 * 2. Recent searches with removable chips saved in localStorage.
 * 3. Typeahead search grouped by Titles (Courses), Episodes (Lectures), and Topics.
 * 4. Substring match highlighting with <mark class="search-match">.
 * 5. Full keyboard navigation (ArrowUp, ArrowDown, Enter, Escape).
 */
(function() {
  'use strict';

  const RECENT_KEY = 'cf_recent_searches';
  let selectedIndex = -1;
  let currentResults = [];
  let debounceTimer = null;

  function getRecentSearches() {
    try {
      return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    } catch (_) {
      return [];
    }
  }

  function saveRecentSearch(term) {
    if (!term || !term.trim()) return;
    const clean = term.trim();
    let recents = getRecentSearches().filter(t => t.toLowerCase() !== clean.toLowerCase());
    recents.unshift(clean);
    if (recents.length > 8) recents = recents.slice(0, 8);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recents));
    } catch (_) {}
  }

  function removeRecentSearch(term) {
    let recents = getRecentSearches().filter(t => t.toLowerCase() !== term.toLowerCase());
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recents));
    } catch (_) {}
    renderRecentSearches();
  }

  function highlightMatch(text, query) {
    if (!query || !text) return escapeHtml(text);
    const escapedText = escapeHtml(text);
    const escapedQuery = escapeHtml(query);
    const regex = new RegExp(`(${escapeRegex(escapedQuery)})`, 'gi');
    return escapedText.replace(regex, '<mark class="search-match">$1</mark>');
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function renderRecentSearches() {
    const panel = document.getElementById('universalSearchResults');
    if (!panel) return;
    const recents = getRecentSearches();
    selectedIndex = -1;
    currentResults = [];

    if (!recents.length) {
      panel.innerHTML = `
        <div class="search-section">
          <div class="search-section-title">Explore Courses &amp; Episodes</div>
          <p class="search-hint muted">Type a title, topic (e.g. Spark, LLM, System Design), or instructor to search.</p>
        </div>
      `;
      panel.hidden = false;
      return;
    }

    let html = `
      <div class="search-section">
        <div class="search-section-header">
          <span class="search-section-title">Recent Searches</span>
          <button type="button" class="search-clear-btn" id="searchClearAll">Clear all</button>
        </div>
        <div class="recent-chips">
    `;

    recents.forEach(term => {
      html += `
        <span class="recent-chip">
          <span class="chip-text" data-term="${escapeHtml(term)}">${escapeHtml(term)}</span>
          <button type="button" class="chip-remove" data-remove="${escapeHtml(term)}" aria-label="Remove ${escapeHtml(term)}">
            <svg class="icon"><use href="#i-close"/></svg>
          </button>
        </span>
      `;
    });

    html += `
        </div>
      </div>
    `;

    panel.innerHTML = html;
    panel.hidden = false;

    // Wire clicks on chips
    panel.querySelectorAll('.chip-text').forEach(chip => {
      chip.onclick = () => {
        const term = chip.dataset.term;
        const input = document.getElementById('globalSearch');
        if (input) {
          input.value = term;
          doSearch(term);
        }
      };
    });

    panel.querySelectorAll('.chip-remove').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        removeRecentSearch(btn.dataset.remove);
      };
    });

    const clearAll = document.getElementById('searchClearAll');
    if (clearAll) {
      clearAll.onclick = () => {
        localStorage.removeItem(RECENT_KEY);
        renderRecentSearches();
      };
    }
  }

  function doSearch(query) {
    const panel = document.getElementById('universalSearchResults');
    if (!panel) return;

    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
      renderRecentSearches();
      return;
    }

    const state = window.state || { videos: [], courseMeta: new Map() };
    const courses = typeof window.groupCourses === 'function' ? window.groupCourses() : [];

    // 1. Matching Courses (Titles)
    const matchingCourses = courses.filter(c => {
      const title = (c.title || c.name || '').toLowerCase();
      const instructor = (c.instructor || '').toLowerCase();
      const category = (c.category || '').toLowerCase();
      const tags = (c.tags || []).join(' ').toLowerCase();
      return title.includes(trimmed) || instructor.includes(trimmed) || category.includes(trimmed) || tags.includes(trimmed);
    }).slice(0, 4);

    // 2. Matching Episodes (Lectures)
    const matchingEpisodes = (state.videos || []).filter(v => {
      const title = (v.title || '').toLowerCase();
      const section = (v.section || '').toLowerCase();
      return title.includes(trimmed) || section.includes(trimmed);
    }).slice(0, 6);

    // 3. Matching Topics / Categories
    const allTopics = new Set();
    courses.forEach(c => {
      if (c.category) allTopics.add(c.category);
      (c.tags || []).forEach(t => allTopics.add(t));
    });
    const matchingTopics = [...allTopics].filter(t => t.toLowerCase().includes(trimmed)).slice(0, 4);

    selectedIndex = -1;
    currentResults = [];

    if (!matchingCourses.length && !matchingEpisodes.length && !matchingTopics.length) {
      panel.innerHTML = `
        <div class="search-empty">
          <p>No results found for "<strong>${escapeHtml(query)}</strong>"</p>
          <span class="muted">Try checking for typos or searching by broad topic.</span>
        </div>
      `;
      panel.hidden = false;
      return;
    }

    let html = '';

    // Render Course Matches
    if (matchingCourses.length) {
      html += `<div class="search-section" id="searchSectionTitles"><div class="search-section-title">Titles &amp; Masterclasses</div><div class="search-items-list">`;
      matchingCourses.forEach(c => {
        const slug = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const posterUrl = `/api/artwork/courses/${encodeURIComponent(c.name)}/poster`;
        const itemIdx = currentResults.length;
        currentResults.push({ type: 'course', url: `#/course/${slug}`, term: c.title || c.name });

        html += `
          <a class="search-item search-item-course" href="#/course/${slug}" data-index="${itemIdx}">
            <img class="search-thumb-poster" src="${posterUrl}" alt="" loading="lazy" />
            <div class="search-item-info">
              <strong class="search-item-title">${highlightMatch(c.title || c.name, query)}</strong>
              <div class="search-item-meta">
                <span class="badge-category">${escapeHtml(c.category || 'Course')}</span>
                <span>${c.videos ? c.videos.length : 0} Episodes</span>
                ${c.instructor ? `<span>· By ${escapeHtml(c.instructor)}</span>` : ''}
              </div>
            </div>
            <span class="search-action-hint"><svg class="icon"><use href="#i-chevron"/></svg></span>
          </a>
        `;
      });
      html += `</div></div>`;
    }

    // Render Episode Matches
    if (matchingEpisodes.length) {
      html += `<div class="search-section" id="searchSectionEpisodes"><div class="search-section-title">Episodes &amp; Lectures</div><div class="search-items-list">`;
      matchingEpisodes.forEach(v => {
        const thumbUrl = `/api/artwork/lectures/${v.id}/thumbnail?size=sm`;
        const itemIdx = currentResults.length;
        currentResults.push({ type: 'lecture', url: `#/lecture/${v.id}`, term: v.title });

        const durationMins = v.duration ? Math.ceil(v.duration / 60) + 'm' : '';

        html += `
          <a class="search-item search-item-episode" href="#/lecture/${v.id}" data-index="${itemIdx}">
            <img class="search-thumb-backdrop" src="${thumbUrl}" alt="" loading="lazy" />
            <div class="search-item-info">
              <strong class="search-item-title">${highlightMatch(v.title, query)}</strong>
              <div class="search-item-meta">
                <span>${escapeHtml(v.course || '')}</span>
                ${durationMins ? `<span class="badge-duration">${durationMins}</span>` : ''}
              </div>
            </div>
            <span class="search-action-play"><svg class="icon"><use href="#i-play"/></svg></span>
          </a>
        `;
      });
      html += `</div></div>`;
    }

    // Render Topic Matches
    if (matchingTopics.length) {
      html += `<div class="search-section" id="searchSectionTopics"><div class="search-section-title">Topics</div><div class="search-topics-list">`;
      matchingTopics.forEach(t => {
        const itemIdx = currentResults.length;
        currentResults.push({ type: 'topic', url: `#/browse/${encodeURIComponent(t)}`, term: t });
        html += `
          <a class="search-topic-pill" href="#/browse/${encodeURIComponent(t)}" data-index="${itemIdx}">
            <svg class="icon"><use href="#i-spark"/></svg> ${highlightMatch(t, query)}
          </a>
        `;
      });
      html += `</div></div>`;
    }

    panel.innerHTML = html;
    panel.hidden = false;

    // Track search query analytics
    window.CourseForgeServices?.trackStreamingEvent('search_query', query, { results_count: currentResults.length });

    // Attach click recording to results
    panel.querySelectorAll('.search-item, .search-topic-pill').forEach(el => {
      el.addEventListener('click', () => {
        window.CourseForgeServices?.trackStreamingEvent('search_click', query, { item_url: el.getAttribute('href') });
        saveRecentSearch(query);
        panel.hidden = true;
      });
    });
  }

  function updateSelection(delta) {
    if (!currentResults.length) return;
    const items = document.querySelectorAll('#universalSearchResults [data-index]');
    items.forEach(el => el.classList.remove('selected'));

    selectedIndex += delta;
    if (selectedIndex < 0) selectedIndex = currentResults.length - 1;
    if (selectedIndex >= currentResults.length) selectedIndex = 0;

    const activeEl = document.querySelector(`#universalSearchResults [data-index="${selectedIndex}"]`);
    if (activeEl) {
      activeEl.classList.add('selected');
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }

  function setupSearchListeners() {
    const input = document.getElementById('globalSearch');
    const panel = document.getElementById('universalSearchResults');
    if (!input || !panel) return;

    input.addEventListener('focus', () => {
      if (!input.value.trim()) {
        renderRecentSearches();
      } else {
        doSearch(input.value);
      }
    });

    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        doSearch(input.value);
      }, 150);
    });

    input.addEventListener('keydown', (e) => {
      if (panel.hidden) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        updateSelection(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        updateSelection(-1);
      } else if (e.key === 'Enter') {
        if (selectedIndex >= 0 && currentResults[selectedIndex]) {
          e.preventDefault();
          const target = currentResults[selectedIndex];
          saveRecentSearch(input.value);
          panel.hidden = true;
          location.hash = target.url;
        } else if (input.value.trim()) {
          saveRecentSearch(input.value);
          panel.hidden = true;
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        panel.hidden = true;
        input.blur();
      }
    });
  }

  // Export search helper
  window.CourseForgeSearch = {
    doSearch,
    renderRecentSearches
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupSearchListeners);
  } else {
    setupSearchListeners();
  }

})();

/* streaming-browse.js */
/**
 * CourseForge Streaming Browse & My List — Stage 3
 *
 * Implements:
 * 1. Browse / Category Hub (#/browse and #/browse/<category>).
 * 2. Category filter pills (#categoryFilterPills) with live count badges.
 * 3. 2:3 poster grid with .browse-poster-card styling.
 * 4. Hover preview cards with 180ms delay (synopsis, episodes, Play CTA, My List CTA).
 * 5. Dedicated My List surface (#/my-list) inside .mylist-surface container
 *    with 1-click remove, 1-click play, and streaming empty state.
 */
(function() {
  'use strict';

  let hoverTimer = null;
  let activePreview = null;

  // --------------------------------------------------------------------------
  // Category Hub & Deep Linking
  // --------------------------------------------------------------------------
  function initBrowseHub() {
    window.addEventListener('hashchange', handleBrowseRouting);
    window.addEventListener('courseforge-navigate', syncCategoryPills);

    // Observe changes to catalog to add streaming classes and preview cards
    const catalog = document.getElementById('courseCatalog');
    if (catalog) {
      const observer = new MutationObserver(() => {
        enhanceCatalogCards();
      });
      observer.observe(catalog, { childList: true });
    }

    handleBrowseRouting();
    setTimeout(syncCategoryPills, 300);
  }

  function handleBrowseRouting() {
    const hash = location.hash;
    if (hash.startsWith('#/browse') || hash.startsWith('#browse')) {
      const parts = hash.replace(/^#\/?browse\/?/, '').split('?');
      const categoryParam = parts[0] ? decodeURIComponent(parts[0]).trim() : '';
      if (typeof window.navigate === 'function') {
        window.navigate('library');
      }
      setTimeout(() => {
        syncCategoryPills();
        if (categoryParam) {
          applyCategoryFilter(categoryParam);
        }
      }, 50);
    } else if (hash === '#/my-list' || hash === '#my-list') {
      if (typeof window.navigate === 'function') {
        window.navigate('library');
      }
      renderMyListView();
    } else if (hash === '#/history' || hash === '#history') {
      if (typeof window.navigate === 'function') {
        window.navigate('library');
      }
      renderHistoryView();
    }
  }

  function syncCategoryPills() {
    const libraryControls = document.querySelector('.library-controls');
    if (!libraryControls) return;

    let pillsBar = document.getElementById('categoryFilterPills');
    if (!pillsBar) {
      pillsBar = document.createElement('div');
      pillsBar.id = 'categoryFilterPills';
      pillsBar.className = 'category-pills-bar';
      pillsBar.setAttribute('role', 'tablist');
      pillsBar.setAttribute('aria-label', 'Browse by category');
      libraryControls.parentNode.insertBefore(pillsBar, document.getElementById('courseCatalog'));
    }

    const courses = typeof window.groupCourses === 'function' ? window.groupCourses() : [];
    if (!courses.length) return;

    // Collect category counts
    const catCounts = { 'all': courses.length };
    courses.forEach(c => {
      const cat = c.category || (typeof window.courseCategory === 'function' ? window.courseCategory(c.name) : 'General');
      catCounts[cat] = (catCounts[cat] || 0) + 1;
    });

    const activeCat = (window.state && window.state.category) || 'all';

    const categories = [
      { id: 'all', label: 'All Titles' },
      { id: 'Cloud & Azure', label: 'Cloud & Azure' },
      { id: 'Agentic AI', label: 'Agentic AI' },
      { id: 'Big Data', label: 'Big Data' },
      { id: 'System Design', label: 'System Design' },
      { id: 'DSA & ML', label: 'DSA & ML' }
    ];

    // Also include any other unique categories
    Object.keys(catCounts).forEach(cat => {
      if (cat !== 'all' && !categories.some(c => c.id.toLowerCase() === cat.toLowerCase() || c.label.toLowerCase() === cat.toLowerCase())) {
        categories.push({ id: cat, label: cat });
      }
    });

    pillsBar.innerHTML = '';
    categories.forEach(cat => {
      // Calculate count matching this category
      let count = 0;
      if (cat.id === 'all') {
        count = courses.length;
      } else {
        count = courses.filter(c => {
          const courseCat = (c.category || (typeof window.courseCategory === 'function' ? window.courseCategory(c.name) : '')).toLowerCase();
          const target = cat.id.toLowerCase();
          return courseCat.includes(target) || target.includes(courseCat);
        }).length;
      }

      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = `category-pill ${activeCat.toLowerCase() === cat.id.toLowerCase() ? 'active' : ''}`;
      pill.setAttribute('role', 'tab');
      pill.setAttribute('data-category', cat.id);
      pill.innerHTML = `${escapeHtml(cat.label)} <span class="badge-count">${count}</span>`;

      pill.onclick = () => {
        pillsBar.querySelectorAll('.category-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        applyCategoryFilter(cat.id);
      };

      pillsBar.appendChild(pill);
    });
  }

  function applyCategoryFilter(cat) {
    if (!window.state) return;
    const courses = typeof window.groupCourses === 'function' ? window.groupCourses() : [];

    if (cat === 'all') {
      window.state.category = 'all';
    } else {
      // Find matching category value
      const match = courses.find(c => {
        const cCat = (c.category || (typeof window.courseCategory === 'function' ? window.courseCategory(c.name) : '')).toLowerCase();
        return cCat.includes(cat.toLowerCase()) || cat.toLowerCase().includes(cCat);
      });
      if (match) {
        window.state.category = match.category || (typeof window.courseCategory === 'function' ? window.courseCategory(match.name) : cat);
      } else {
        window.state.category = cat;
      }
    }

    const categorySelect = document.getElementById('categoryFilter');
    if (categorySelect) {
      categorySelect.value = window.state.category;
    }

    if (typeof window.renderCatalog === 'function') {
      window.renderCatalog();
    }
  }

  function enhanceCatalogCards() {
    const cards = document.querySelectorAll('#courseCatalog .course-tile, #courseCatalog .course-card');
    cards.forEach(card => {
      card.classList.add('browse-poster-card');
      attachHoverPreview(card);
    });
  }

  // --------------------------------------------------------------------------
  // Hover Preview Cards (180ms delay)
  // --------------------------------------------------------------------------
  function attachHoverPreview(card) {
    if (card._previewAttached) return;
    card._previewAttached = true;

    card.addEventListener('mouseenter', () => {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        showPreviewModal(card);
      }, 180);
    });

    card.addEventListener('mouseleave', () => {
      clearTimeout(hoverTimer);
    });
  }

  function showPreviewModal(card) {
    // Stage 4 will render the full Netflix modal; Stage 3 activates hover styling
    card.classList.add('hover-active');
  }

  // --------------------------------------------------------------------------
  // Dedicated My List View (#/my-list)
  // --------------------------------------------------------------------------
  async function renderMyListView() {
    const catalog = document.getElementById('courseCatalog');
    const libraryCount = document.getElementById('libraryCount');
    const libraryEmpty = document.getElementById('libraryEmpty');
    const pillsBar = document.getElementById('categoryFilterPills');
    if (!catalog) return;

    if (pillsBar) pillsBar.hidden = true;
    if (libraryEmpty) libraryEmpty.hidden = true;
    catalog.setAttribute('aria-busy', 'true');
    catalog.innerHTML = '<div class="skeleton-row"><div class="skeleton-poster"></div><div class="skeleton-poster"></div><div class="skeleton-poster"></div></div>';

    try {
      const res = await fetch('/api/streaming/my-list');
      catalog.setAttribute('aria-busy', 'false');
      if (!res.ok) throw new Error('Could not load My List');
      const data = await res.json();
      const items = data.items || [];

      if (libraryCount) {
        libraryCount.textContent = `My List (${items.length} titles)`;
      }

      catalog.innerHTML = '';
      const surface = document.createElement('div');
      surface.className = 'mylist-surface';

      if (!items.length) {
        surface.innerHTML = `
          <div class="panel empty-mylist">
            <div class="empty-illustration"><svg class="icon"><use href="#i-bookmark"/></svg></div>
            <h3>Your list is empty</h3>
            <p>Explore our engineering masterclasses and save titles to watch anytime.</p>
            <a href="#/browse" class="btn btn-primary">Find titles to add</a>
          </div>
        `;
        catalog.appendChild(surface);
        return;
      }

      const grid = document.createElement('div');
      grid.className = 'mylist-grid';

      items.forEach(item => {
        const card = document.createElement('div');
        card.className = 'mylist-card';

        const isCourse = item.item_type === 'course';
        const posterUrl = item.poster_url || `/api/artwork/courses/${item.slug || item.item_id}/poster`;
        const playLink = item.deep_link || (isCourse ? `#/course/${item.slug}` : `#/lecture/${item.item_id}`);

        card.innerHTML = `
          <div class="mylist-thumb-wrap">
            <img src="${escapeHtml(posterUrl)}" alt="${escapeHtml(item.title)}" loading="lazy" />
            <button type="button" class="mylist-remove-btn" data-type="${item.item_type}" data-id="${item.item_id || item.slug}" title="Remove from My List" aria-label="Remove from My List">
              <svg class="icon"><use href="#i-close"/></svg>
            </button>
            <a href="${playLink}" class="mylist-play-overlay" title="Play">
              <div class="card-play-icon"><svg class="icon"><use href="#i-play"/></svg></div>
            </a>
          </div>
          <div class="mylist-card-info">
            <strong class="mylist-card-title">${escapeHtml(item.title)}</strong>
            <span class="mylist-card-meta">${isCourse ? 'Masterclass' : escapeHtml(item.course || 'Episode')}</span>
          </div>
        `;

        // Wire 1-click remove button
        const removeBtn = card.querySelector('.mylist-remove-btn');
        if (removeBtn) {
          removeBtn.onclick = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            try {
              const csrf = window.CourseForgeAccount?.csrf || '';
              const delRes = await fetch(`/api/streaming/my-list/${removeBtn.dataset.type}/${encodeURIComponent(removeBtn.dataset.id)}`, {
                method: 'DELETE',
                headers: { 'X-CSRF-Token': csrf }
              });
              if (delRes.ok) {
                card.remove();
                if (window.toast) window.toast('Removed from My List');
                if (grid.children.length === 0) {
                  renderMyListView();
                }
              }
            } catch (err) {
              if (window.toast) window.toast(err.message, true);
            }
          };
        }

        grid.appendChild(card);
      });

      surface.appendChild(grid);
      catalog.appendChild(surface);
    } catch (err) {
      catalog.setAttribute('aria-busy', 'false');
      catalog.innerHTML = `<p class="muted">Could not load My List: ${escapeHtml(err.message)}</p>`;
    }
  }

  // --------------------------------------------------------------------------
  // Dedicated Watch History View (#/history)
  // --------------------------------------------------------------------------
  async function renderHistoryView() {
    const catalog = document.getElementById('courseCatalog');
    const libraryCount = document.getElementById('libraryCount');
    const libraryEmpty = document.getElementById('libraryEmpty');
    const pillsBar = document.getElementById('categoryFilterPills');
    if (!catalog) return;

    if (pillsBar) pillsBar.hidden = true;
    if (libraryEmpty) libraryEmpty.hidden = true;
    catalog.setAttribute('aria-busy', 'true');
    catalog.innerHTML = '<div class="skeleton-row"><div class="skeleton-poster"></div><div class="skeleton-poster"></div><div class="skeleton-poster"></div></div>';

    try {
      const res = await fetch('/api/streaming/history');
      catalog.setAttribute('aria-busy', 'false');
      if (!res.ok) throw new Error('Could not load Watch History');
      const data = await res.json();
      const items = data.history || [];

      if (libraryCount) {
        libraryCount.textContent = `Watch History (${items.length} titles)`;
      }

      catalog.innerHTML = '';
      const surface = document.createElement('div');
      surface.className = 'history-surface';

      // Header row with Clear History button
      const headerRow = document.createElement('div');
      headerRow.className = 'history-header-row';
      headerRow.innerHTML = `
        <div class="history-title-wrap">
          <h2 class="history-heading">Watch History</h2>
          <p class="history-subheading">Chronological record of your watched lectures across all devices.</p>
        </div>
        ${items.length ? `
          <button type="button" class="btn btn-outline history-clear-btn" id="clearHistoryBtn">
            <svg class="icon"><use href="#i-trash"/></svg> Clear watch history
          </button>
        ` : ''}
      `;
      surface.appendChild(headerRow);

      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'panel empty-history';
        empty.innerHTML = `
          <div class="empty-illustration"><svg class="icon"><use href="#i-clock"/></svg></div>
          <h3>No watch history yet</h3>
          <p>Lectures you stream will appear here in chronological order with your resume timestamps.</p>
          <a href="#/browse" class="btn btn-primary">Start exploring masterclasses</a>
        `;
        surface.appendChild(empty);
        catalog.appendChild(surface);
        return;
      }

      const grid = document.createElement('div');
      grid.className = 'history-grid';

      items.forEach(item => {
        const card = document.createElement('div');
        card.className = 'history-card';

        const thumbUrl = item.thumbnail_url || `/api/artwork/lectures/${item.video_id}/thumbnail?size=md`;
        const durMins = item.duration ? Math.ceil(item.duration / 60) + 'm' : '';
        const posMins = item.position ? Math.floor(item.position / 60) + 'm' : '0m';
        const percent = item.duration ? Math.min(100, Math.round((item.position / item.duration) * 100)) : 0;
        const formattedDate = item.watched_at ? new Date(item.watched_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

        card.innerHTML = `
          <div class="history-thumb-wrap">
            <img src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(item.title)}" loading="lazy" />
            <div class="history-progress-bar"><div class="history-progress-fill" style="width: ${percent}%"></div></div>
            <a href="${item.deep_link}" class="history-play-overlay" title="Resume playback">
              <div class="card-play-icon"><svg class="icon"><use href="#i-play"/></svg></div>
            </a>
          </div>
          <div class="history-card-info">
            <div class="history-card-meta-top">
              <span class="history-course-badge">${escapeHtml(item.course || '')}</span>
              ${formattedDate ? `<span class="history-date">${formattedDate}</span>` : ''}
            </div>
            <strong class="history-card-title">${escapeHtml(item.title)}</strong>
            <div class="history-card-meta-bottom">
              <span class="history-resume-pill">${item.completed ? 'Completed' : `Resume at ${posMins}`}</span>
              ${durMins ? `<span class="history-duration">${durMins}</span>` : ''}
            </div>
          </div>
        `;
        grid.appendChild(card);
      });

      surface.appendChild(grid);
      catalog.appendChild(surface);

      // Wire Clear History button with confirmation dialog
      const clearBtn = surface.querySelector('#clearHistoryBtn');
      if (clearBtn) {
        clearBtn.onclick = async () => {
          if (!window.confirm('Clear your entire watch history? This cannot be undone.')) {
            return;
          }
          try {
            const csrf = window.CourseForgeAccount?.csrf || '';
            const delRes = await fetch('/api/streaming/history', {
              method: 'DELETE',
              headers: { 'X-CSRF-Token': csrf }
            });
            if (delRes.ok) {
              if (window.toast) window.toast('Watch history cleared');
              renderHistoryView();
            } else {
              throw new Error('Failed to clear history');
            }
          } catch (err) {
            if (window.toast) window.toast('Could not clear watch history: ' + err.message, true);
          }
        };
      }
    } catch (err) {
      catalog.setAttribute('aria-busy', 'false');
      catalog.innerHTML = `<div class="error-panel">Failed to load Watch History. <button class="btn btn-outline" onclick="CourseForgeBrowse.renderHistoryView()">Retry</button></div>`;
    }
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Export browse and my-list helper
  window.CourseForgeBrowse = {
    initBrowseHub,
    syncCategoryPills,
    renderMyListView,
    renderHistoryView
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBrowseHub);
  } else {
    initBrowseHub();
  }

})();

/* streaming-title.js */
/**
 * CourseForge Streaming Title & Episode Details — Stage 4
 *
 * Implements:
 * 1. Title surface & Netflix-style modal (#/course/<slug>) with 16:9 cinematic backdrop.
 * 2. Primary Play CTA (Play S1:E1 or Resume), My List toggle, Share button (clipboard + toast).
 * 3. Metadata line: Match %, Year (2026), Seasons count, Category, Audio/Video quality.
 * 4. Full synopsis and instructor byline.
 * 5. Seasons & Episodes selector: dropdown switcher with batch durations and episode counts.
 * 6. Episode list: 16:9 thumbnails, episode number, title, duration, collapsible synopsis,
 *    progress bar, completion checkmark, direct Play CTA.
 * 7. More Like This: 6-card row of related courses based on category + co-enrollment.
 * 8. Details tab: curriculum breakdown, secure materials downloads, prerequisites, certification.
 */
(function() {
  'use strict';

  let currentTitleData = null;
  let activeSeasonIndex = 0;
  let activeTab = 'episodes';

  function initTitleExperience() {
    window.addEventListener('hashchange', handleTitleRouting);
    document.addEventListener('click', handleCardClicks);

    const dialog = document.getElementById('titleDetailDialog');
    if (dialog) {
      dialog.addEventListener('click', (e) => {
        // Close on clicking backdrop outside dialog content
        const rect = dialog.getBoundingClientRect();
        const isInDialog = (rect.top <= e.clientY && e.clientY <= rect.top + rect.height &&
                            rect.left <= e.clientX && e.clientX <= rect.left + rect.width);
        if (!isInDialog && e.target === dialog) {
          closeTitleModal();
        }
      });

      dialog.addEventListener('cancel', (e) => {
        e.preventDefault();
        closeTitleModal();
      });
    }

    handleTitleRouting();
  }

  function handleCardClicks(e) {
    const link = e.target.closest('a[href*="#/course/"], button[data-course-slug]');
    if (!link) return;

    let slug = '';
    if (link.dataset && link.dataset.courseSlug) {
      slug = link.dataset.courseSlug;
    } else if (link.getAttribute('href')) {
      const href = link.getAttribute('href');
      const match = href.match(/#\/course\/([a-zA-Z0-9_-]+)/);
      if (match) slug = match[1];
    }

    if (slug) {
      e.preventDefault();
      openTitleModal(slug);
    }
  }

  function handleTitleRouting() {
    const hash = location.hash;
    const match = hash.match(/^#\/?course\/([a-zA-Z0-9_-]+)/);
    if (match) {
      const slug = match[1];
      openTitleModal(slug);
    }
  }

  async function openTitleModal(slug) {
    const dialog = document.getElementById('titleDetailDialog');
    if (!dialog) return;

    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
      }
    }

    // Render skeleton state
    dialog.innerHTML = `
      <div class="title-dialog-content">
        <button type="button" class="title-dialog-close" id="titleDialogClose" aria-label="Close details">
          <svg class="icon"><use href="#i-close"/></svg>
        </button>
        <div class="skeleton-hero title-skeleton-hero"></div>
        <div class="title-dialog-body">
          <div class="skeleton-row">
            <div class="skeleton-poster" style="height: 40px; width: 140px;"></div>
            <div class="skeleton-poster" style="height: 40px; width: 140px;"></div>
          </div>
        </div>
      </div>
    `;

    const closeBtn = document.getElementById('titleDialogClose');
    if (closeBtn) closeBtn.onclick = closeTitleModal;

    try {
      const res = await fetch(`/api/streaming/courses/${encodeURIComponent(slug)}`);
      if (!res.ok) throw new Error('Could not load course details');
      const data = await res.json();
      currentTitleData = data;
      activeSeasonIndex = 0;
      activeTab = 'episodes';

      renderTitleContent(data);
    } catch (err) {
      dialog.innerHTML = `
        <div class="title-dialog-content title-error-content">
          <button type="button" class="title-dialog-close" id="titleDialogClose" aria-label="Close details">
            <svg class="icon"><use href="#i-close"/></svg>
          </button>
          <div class="title-error-box">
            <h3>Unable to load title details</h3>
            <p class="muted">${escapeHtml(err.message)}</p>
            <button type="button" class="btn btn-primary" onclick="window.CourseForgeTitle.closeTitleModal()">Close</button>
          </div>
        </div>
      `;
      const btn = document.getElementById('titleDialogClose');
      if (btn) btn.onclick = closeTitleModal;
    }
  }

  function renderTitleContent(data) {
    const dialog = document.getElementById('titleDetailDialog');
    if (!dialog) return;

    const course = data.course;
    const seasons = data.seasons || [];
    const related = data.related || [];

    const nextLec = course.next_lecture;
    const playUrl = nextLec ? nextLec.deep_link : (seasons[0]?.episodes[0]?.deep_link || '#');
    const playLabel = nextLec && nextLec.resume_position > 30 ? 'Resume Playing' : 'Play S1:E1';

    const backdropUrl = course.backdrop_url || `/api/artwork/courses/${course.slug}/backdrop`;
    const inList = Boolean(course.in_my_list);

    let html = `
      <div class="title-dialog-content">
        <button type="button" class="title-dialog-close" id="titleDialogClose" aria-label="Close details">
          <svg class="icon"><use href="#i-close"/></svg>
        </button>

        <!-- Billboard Backdrop & Title Treatment -->
        <div class="title-billboard" style="background-image: linear-gradient(180deg, rgba(13,17,23,0.1) 0%, rgba(13,17,23,0.95) 100%), url('${escapeHtml(backdropUrl)}')">
          <div class="title-billboard-overlay">
            <span class="title-badge-eyebrow"><svg class="icon"><use href="#i-spark"/></svg> COURSEFORGE ORIGINAL MASTERCLASS</span>
            <h1 class="title-main-heading">${escapeHtml(course.title)}</h1>

            <div class="title-meta-row">
              <span class="match-score">98% Match</span>
              <span class="meta-year">2026</span>
              <span class="meta-seasons">${seasons.length} ${seasons.length === 1 ? 'Season' : 'Seasons'}</span>
              <span class="meta-badge-quality">4K Ultra HD</span>
              <span class="meta-badge-audio">Stereo</span>
              <span class="meta-category-chip">${escapeHtml(course.category)}</span>
            </div>

            <div class="title-cta-row">
              <a href="${escapeHtml(playUrl)}" class="btn btn-primary title-play-cta" id="titlePlayCta">
                <svg class="icon"><use href="#i-play"/></svg> ${playLabel}
              </a>
              <button type="button" class="btn btn-outline title-mylist-cta ${inList ? 'in-list' : ''}" id="titleMyListBtn" data-slug="${escapeHtml(course.slug)}">
                <svg class="icon"><use href="#${inList ? 'i-check' : 'i-bookmark'}"/></svg>
                <span id="titleMyListLabel">${inList ? 'In My List' : 'Add to My List'}</span>
              </button>
              <button type="button" class="btn btn-outline title-share-cta" id="titleShareBtn" data-slug="${escapeHtml(course.slug)}" title="Copy shareable link">
                <svg class="icon"><use href="#i-paperclip"/></svg> Share
              </button>
            </div>
          </div>
        </div>

        <div class="title-dialog-body">
          <!-- Overview & Synopsis -->
          <div class="title-synopsis-section">
            <div class="title-synopsis-main">
              <p class="title-synopsis-text">${escapeHtml(course.synopsis)}</p>
              ${course.progress_percent > 0 ? `
                <div class="title-progress-bar-wrap">
                  <div class="title-progress-meta">
                    <span>${course.completed_episodes} of ${course.total_episodes} episodes completed</span>
                    <strong>${course.progress_percent}%</strong>
                  </div>
                  <div class="progress-track"><span style="width: ${course.progress_percent}%"></span></div>
                </div>
              ` : ''}
            </div>
            <div class="title-credits-aside">
              <div class="credit-row"><span class="credit-label">Instructor:</span> <strong class="credit-val">${escapeHtml(course.instructor)}</strong></div>
              <div class="credit-row"><span class="credit-label">Category:</span> <span class="credit-val">${escapeHtml(course.category)}</span></div>
              <div class="credit-row"><span class="credit-label">Total Duration:</span> <span class="credit-val">${formatDuration(course.total_duration)}</span></div>
              <div class="credit-row"><span class="credit-label">Audio:</span> <span class="credit-val">English · Stereo 2.0</span></div>
            </div>
          </div>

          <!-- Navigation Tabs -->
          <div class="title-tabs-bar" role="tablist">
            <button type="button" class="title-tab ${activeTab === 'episodes' ? 'active' : ''}" data-tab="episodes" role="tab">Episodes</button>
            <button type="button" class="title-tab ${activeTab === 'related' ? 'active' : ''}" data-tab="related" role="tab">More Like This</button>
            <button type="button" class="title-tab ${activeTab === 'details' ? 'active' : ''}" data-tab="details" role="tab">Curriculum &amp; Details</button>
          </div>

          <!-- Tab Content Panes -->
          <div class="title-tab-panes">
            <div class="tab-pane ${activeTab === 'episodes' ? 'active' : ''}" id="paneEpisodes">
              ${renderEpisodesPane(seasons)}
            </div>
            <div class="tab-pane ${activeTab === 'related' ? 'active' : ''}" id="paneRelated">
              ${renderRelatedPane(related)}
            </div>
            <div class="tab-pane ${activeTab === 'details' ? 'active' : ''}" id="paneDetails">
              ${renderDetailsPane(course, seasons)}
            </div>
          </div>
        </div>
      </div>
    `;

    dialog.innerHTML = html;

    // Attach Event Handlers
    wireTitleEventHandlers(course);
  }

  function renderEpisodesPane(seasons) {
    if (!seasons.length) {
      return '<p class="muted">No episodes available yet.</p>';
    }

    const currentSeason = seasons[activeSeasonIndex] || seasons[0];

    let selectOptions = '';
    seasons.forEach((s, idx) => {
      selectOptions += `<option value="${idx}" ${idx === activeSeasonIndex ? 'selected' : ''}>Season ${s.season_number}: ${escapeHtml(s.title)} (${s.episodes_count} Episodes)</option>`;
    });

    let episodesHtml = '';
    (currentSeason.episodes || []).forEach(ep => {
      const durText = ep.duration ? Math.ceil(ep.duration / 60) + 'm' : '';
      const thumbUrl = ep.thumbnail_url || `/api/artwork/lectures/${ep.id}/thumbnail?size=md`;

      episodesHtml += `
        <div class="episode-row ${ep.is_next ? 'next-up' : ''}">
          <div class="episode-num">${ep.episode_number}</div>
          <div class="episode-thumb-wrap">
            <img src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(ep.title)}" loading="lazy" />
            <a href="${escapeHtml(ep.deep_link)}" class="episode-thumb-play" title="Play episode">
              <svg class="icon"><use href="#i-play"/></svg>
            </a>
            ${durText ? `<span class="episode-duration-badge">${durText}</span>` : ''}
            ${ep.progress_percent > 0 && !ep.completed ? `
              <div class="episode-thumb-progress"><span style="width: ${ep.progress_percent}%"></span></div>
            ` : ''}
          </div>
          <div class="episode-info">
            <div class="episode-header-line">
              <h4 class="episode-title">
                <a href="${escapeHtml(ep.deep_link)}">${escapeHtml(ep.title)}</a>
              </h4>
              <div class="episode-actions">
                ${ep.completed ? `<span class="episode-completed-badge" title="Completed"><svg class="icon"><use href="#i-check-circle"/></svg></span>` : ''}
                <a href="${escapeHtml(ep.deep_link)}" class="btn btn-outline btn-sm episode-direct-play">
                  <svg class="icon"><use href="#i-play"/></svg> Play
                </a>
              </div>
            </div>
            <p class="episode-synopsis">${escapeHtml(ep.synopsis || 'Comprehensive technical walk-through and architectural analysis.')}</p>
          </div>
        </div>
      `;
    });

    return `
      <div class="season-selector-bar">
        <label for="titleSeasonSelect" class="season-select-label">Select Season:</label>
        <select id="titleSeasonSelect" class="form-input season-select">
          ${selectOptions}
        </select>
      </div>
      <div class="episodes-list">
        ${episodesHtml}
      </div>
    `;
  }

  function renderRelatedPane(related) {
    if (!related.length) {
      return '<p class="muted">No related titles found.</p>';
    }

    let cardsHtml = '';
    related.slice(0, 6).forEach(rc => {
      const posterUrl = rc.poster_url || `/api/artwork/courses/${rc.slug}/poster`;
      cardsHtml += `
        <div class="related-course-card" data-course-slug="${escapeHtml(rc.slug)}">
          <div class="related-poster-wrap">
            <img src="${escapeHtml(posterUrl)}" alt="${escapeHtml(rc.title)}" loading="lazy" />
            <div class="related-play-overlay">
              <svg class="icon"><use href="#i-play"/></svg>
            </div>
          </div>
          <strong class="related-card-title">${escapeHtml(rc.title)}</strong>
        </div>
      `;
    });

    return `
      <div class="more-like-this-grid">
        ${cardsHtml}
      </div>
    `;
  }

  function renderDetailsPane(course, seasons) {
    let materialsList = [];
    seasons.forEach(s => {
      (s.materials || []).forEach(m => materialsList.push(m));
    });

    let matsHtml = '';
    if (materialsList.length) {
      materialsList.slice(0, 8).forEach(mat => {
        matsHtml += `
          <div class="detail-material-item">
            <svg class="icon"><use href="#i-file"/></svg>
            <span class="mat-name">${escapeHtml(mat.friendly_name)}</span>
            <span class="mat-badge">${escapeHtml(mat.material_type || 'File')}</span>
            <a href="${escapeHtml(mat.download_url)}" class="btn btn-outline btn-sm" download>
              <svg class="icon"><use href="#i-download"/></svg> Download
            </a>
          </div>
        `;
      });
    } else {
      matsHtml = '<p class="muted">No study materials attached to this masterclass.</p>';
    }

    return `
      <div class="title-details-content">
        <div class="detail-section">
          <h3>Curriculum Breakdown</h3>
          <p class="muted">${seasons.length} modules covering comprehensive system engineering and architecture patterns.</p>
          <ul class="curriculum-list">
            ${seasons.map(s => `<li><strong>Season ${s.season_number}: ${escapeHtml(s.title)}</strong> — ${s.episodes_count} lectures</li>`).join('')}
          </ul>
        </div>

        <div class="detail-section">
          <h3>Study Materials &amp; Architecture Documents</h3>
          <div class="materials-download-list">
            ${matsHtml}
          </div>
        </div>

        <div class="detail-section">
          <h3>Prerequisites &amp; Certification</h3>
          <p>Upon completion of all ${course.total_episodes} lectures, an official CourseForge Certificate of Completion is awarded and recorded in your learning profile.</p>
        </div>
      </div>
    `;
  }

  function wireTitleEventHandlers(course) {
    const dialog = document.getElementById('titleDetailDialog');
    if (!dialog) return;

    // Close button
    const closeBtn = document.getElementById('titleDialogClose');
    if (closeBtn) closeBtn.onclick = closeTitleModal;

    // My List toggle
    const myListBtn = document.getElementById('titleMyListBtn');
    if (myListBtn) {
      myListBtn.onclick = async () => {
        const isCurrentlyIn = myListBtn.classList.contains('in-list');
        const csrf = window.CourseForgeAccount?.csrf || '';
        try {
          if (isCurrentlyIn) {
            const delRes = await fetch(`/api/streaming/my-list/course/${encodeURIComponent(course.slug)}`, {
              method: 'DELETE',
              headers: { 'X-CSRF-Token': csrf }
            });
            if (delRes.ok) {
              myListBtn.classList.remove('in-list');
              myListBtn.querySelector('use').setAttribute('href', '#i-bookmark');
              document.getElementById('titleMyListLabel').textContent = 'Add to My List';
              if (window.toast) window.toast('Removed from My List');
            }
          } else {
            const addRes = await fetch('/api/streaming/my-list', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrf
              },
              body: JSON.stringify({
                item_type: 'course',
                item_id: course.id
              })
            });
            if (addRes.ok) {
              myListBtn.classList.add('in-list');
              myListBtn.querySelector('use').setAttribute('href', '#i-check');
              document.getElementById('titleMyListLabel').textContent = 'In My List';
              if (window.toast) window.toast('Added to My List');
            }
          }
        } catch (err) {
          if (window.toast) window.toast(err.message, true);
        }
      };
    }

    // Share button
    const shareBtn = document.getElementById('titleShareBtn');
    if (shareBtn) {
      shareBtn.onclick = () => {
        const shareUrl = `${location.origin}/#/course/${course.slug}`;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(shareUrl).then(() => {
            if (window.toast) window.toast('Link copied to clipboard');
          }).catch(() => {
            prompt('Copy course link:', shareUrl);
          });
        } else {
          prompt('Copy course link:', shareUrl);
        }
      };
    }

    // Tab switcher
    dialog.querySelectorAll('.title-tab').forEach(tab => {
      tab.onclick = () => {
        activeTab = tab.dataset.tab;
        dialog.querySelectorAll('.title-tab').forEach(t => t.classList.toggle('active', t === tab));
        dialog.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

        if (activeTab === 'episodes') {
          const p = document.getElementById('paneEpisodes');
          if (p) p.classList.add('active');
        } else if (activeTab === 'related') {
          const p = document.getElementById('paneRelated');
          if (p) p.classList.add('active');
        } else if (activeTab === 'details') {
          const p = document.getElementById('paneDetails');
          if (p) p.classList.add('active');
        }
      };
    });

    // Season switcher
    const seasonSelect = document.getElementById('titleSeasonSelect');
    if (seasonSelect) {
      seasonSelect.onchange = (e) => {
        activeSeasonIndex = parseInt(e.target.value, 10) || 0;
        const episodesPane = document.getElementById('paneEpisodes');
        if (episodesPane && currentTitleData) {
          episodesPane.innerHTML = renderEpisodesPane(currentTitleData.seasons || []);
          wireSeasonSelect();
        }
      };
    }

    // Wire clicks on related courses
    dialog.querySelectorAll('.related-course-card').forEach(card => {
      card.onclick = () => {
        const slug = card.dataset.courseSlug;
        if (slug) {
          openTitleModal(slug);
        }
      };
    });
  }

  function wireSeasonSelect() {
    const seasonSelect = document.getElementById('titleSeasonSelect');
    if (seasonSelect) {
      seasonSelect.onchange = (e) => {
        activeSeasonIndex = parseInt(e.target.value, 10) || 0;
        const episodesPane = document.getElementById('paneEpisodes');
        if (episodesPane && currentTitleData) {
          episodesPane.innerHTML = renderEpisodesPane(currentTitleData.seasons || []);
          wireSeasonSelect();
        }
      };
    }
  }

  function closeTitleModal() {
    const dialog = document.getElementById('titleDetailDialog');
    if (dialog && dialog.open) {
      dialog.close();
    }
    if (location.hash.startsWith('#/course/') || location.hash.startsWith('#course/')) {
      history.replaceState(null, '', '#/browse');
    }
  }

  function formatDuration(seconds) {
    if (!seconds) return '0m';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (hrs > 0) return `${hrs}h ${mins}m`;
    return `${mins}m`;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Export helper
  window.CourseForgeTitle = {
    initTitleExperience,
    openTitleModal,
    closeTitleModal
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTitleExperience);
  } else {
    initTitleExperience();
  }

})();

/* player-tracking.js */
'use strict';
/* Bounded, ordered playback delivery. Retries keep the same event sequence. */
(() => {
  window.CourseForgePlaybackDelivery = ({request,onSaved,onError}) => {
    let queue=[],running=false,stopped=false,controller=null;
    function stop(){stopped=true;queue=[];controller?.abort();}
    async function deliver(packet){
      for(let attempt=0;attempt<2;attempt++){
        if(stopped)return;
        if(navigator.onLine===false)throw new Error('You are offline. Progress saving resumes when the connection returns.');
        controller=new AbortController();
        const timeout=setTimeout(()=>controller.abort(),4000);
        try{return await request(packet,controller.signal);}
        catch(error){
          if(stopped)return;
          // Access failures and rate limits need user/server recovery.
          const transient=!error.status||error.status===408||error.status>=500;
          if(!transient||attempt===1)throw error;
        }finally{clearTimeout(timeout);controller=null;}
      }
    }
    async function pump(){
      if(running||stopped)return;running=true;
      try{
        while(queue.length&&!stopped){
          const packet=queue.shift();
          try{const result=await deliver(packet);if(!stopped)onSaved(result);}
          catch(error){
            if(stopped)return;
            if([401,403,404].includes(error.status))stop();
            onError(error);
          }
        }
      }finally{running=false;}
    }
    function send(packet){
      if(stopped)return;
      // Keep transitions in order, replacing only queued heartbeat samples.
      if(packet.event==='heartbeat')queue=queue.filter(e=>e.event!=='heartbeat');
      if(queue.length>=128){
        stop();const error=new Error('Progress saving could not keep up. Reopen this lesson to continue.');
        error.code='queue_full';onError(error);return;
      }
      queue.push(packet);void pump();
    }
    return {send,stop};
  };
})();

/* player-session.js */
'use strict';
/* Account ownership and user preferences are separate from media telemetry. */
(() => {
  const api=window.CourseForgeServices.request,json=window.CourseForgeServices.json;
  let owner=null,preferences={speed:1,autoplay:false,theater:false},savePending=null;
  function confirmTakeover(detail){
    return new Promise(resolve=>{
      const dialog=document.createElement('dialog');dialog.className='player-dialog';
      const heading=document.createElement('h2');heading.textContent='Move playback to this window?';
      const text=document.createElement('p');text.textContent=detail?.player?.title?`Your account has “${detail.player.title}” open in another window. Moving playback will stop that player.`:'Your account has a player open in another window. Moving playback will stop that player.';
      const actions=document.createElement('div');actions.className='dialog-actions';
      function done(result){dialog.close();dialog.remove();resolve(result);}
      for(const [label,result] of [['Keep the other player',false],['Move playback here',true]]){
        const button=document.createElement('button');button.type='button';button.className=result?'btn btn-primary':'btn btn-outline';button.textContent=label;button.onclick=()=>done(result);actions.append(button);
      }
      dialog.append(heading,text,actions);dialog.addEventListener('cancel',event=>{event.preventDefault();done(false);});document.body.append(dialog);dialog.showModal();actions.firstElementChild.focus();
    });
  }
  async function withConfirmation(path,body,current){
    try{return await api(path,json('POST',body));}
    catch(error){
      if(error.status!==409||error.detail?.code!=='player_conflict')throw error;
      if(!await confirmTakeover(error.detail)||!current())return null;
      return api(path,json('POST',{...body,take_over:true}));
    }
  }
  function close(){
    const a=owner;owner=null;if(!a)return Promise.resolve();clearInterval(a.timer);a.delivery.stop();
    return fetch(`/api/player-sessions/${a.id}/heartbeat`,{method:'POST',keepalive:true,credentials:'same-origin',
      headers:{'Content-Type':'application/json','X-CSRF-Token':window.CourseForgeAccount?.csrf||''},
      body:JSON.stringify({sequence:++a.sequence,visible:false,closed:true})}).catch(()=>{});
  }
  async function open(video,current,onLost){
    await close();
    const result=await withConfirmation(`/api/videos/${encodeURIComponent(video.id)}/player-session`,{},current);
    if(!result)return null;
    if(!current()){
      await api(`/api/player-sessions/${result.id}/heartbeat`,json('POST',{sequence:1,visible:false,closed:true})).catch(()=>{});return null;
    }
    const a={id:result.id,sequence:0,claimed:true,timer:null,delivery:null,onLost};owner=a;
    if(!current()){close();return null;}
    a.delivery=window.CourseForgePlaybackDelivery({
      request:(sample,signal)=>api(`/api/player-sessions/${a.id}/heartbeat`,{...json('POST',sample),signal}),
      onSaved:r=>{if(owner!==a)return;if(!r.active&&!r.released){a.claimed=false;onLost('Your lesson is paused. Select Resume here to continue.');}},
      onError:error=>{if(owner!==a)return;if([401,403,404].includes(error.status)){a.claimed=false;onLost('Please reopen the lesson to keep watching.');}else window.CourseForgeNative?.trackingNotice('Connection interrupted. Progress saving will resume after reconnection.');}
    });
    a.timer=setInterval(()=>heartbeat(),10000);return a.id;
  }
  function heartbeat(visible=!document.hidden){
    const a=owner;if(!a||(!a.claimed&&visible))return;
    a.delivery.send({sequence:++a.sequence,event:'heartbeat',visible});
    if(!visible)a.claimed=false;
  }
  async function reclaim(){
    const a=owner;if(!a)return false;
    const r=await withConfirmation(`/api/player-sessions/${a.id}/claim`,{},()=>owner===a&&!document.hidden);
    if(owner!==a||!r)return false;a.claimed=true;window.CourseForgeNative?.resetBaseline();return true;
  }
  document.addEventListener('visibilitychange',()=>{
    if(!owner)return;
    if(document.hidden){window.CourseForgeNative?.suspend();owner.onLost('Your lesson is paused. Resume when you’re ready.');heartbeat(false);}
    // Visible players reclaim only after a deliberate user action.
  });
  window.addEventListener('pagehide',close);
  window.addEventListener('offline',()=>{window.CourseForgeNative?.trackingNotice('You are offline. Watched time will not be estimated during the interruption.');});
  window.addEventListener('online',()=>{if(owner){owner.claimed=false;owner.onLost('You’re back online. Resume your lesson.');}});
  async function loadPreferences(initial){
    preferences=initial||await api('/api/me/player-preferences');return preferences;
  }
  function setPreferences(change){
    Object.assign(preferences,change);clearTimeout(savePending);
    savePending=setTimeout(()=>api('/api/me/player-preferences',json('PUT',preferences)).catch(error=>toast('Player preference could not save: '+error.message,true)),300);
  }
  window.CourseForgePlayerSession={open,close,reclaim,heartbeat,loadPreferences,setPreferences,preferences:()=>({...preferences}),current:()=>owner?.id,isOwner:()=>Boolean(owner?.claimed)};
})();

/* player-recovery.js */
'use strict';
/* A bounded recovery cycle. Paused/offline/background players never take
 * ownership or invent watch time while waiting for a new authorized source. */
window.CourseForgePlayerRecovery = function({reload,canRecover,onState,onFailure,
  delays=[800,2500],setTimer=setTimeout,clearTimer=clearTimeout}) {
  let attempts=0,timer=null,request=null,pending=false,stopped=false,fatal=false,healthySeconds=0,lastError=null;
  function terminal(error){return [401,403,404,409].includes(error?.status)||error?.code==='decode';}
  function failed(error){pending=false;fatal=true;onState('failed');onFailure(error);}
  function schedule(){
    if(stopped||!pending||timer!==null||request)return;
    if(terminal(lastError)||attempts>=delays.length){failed(lastError);return;}
    if(!canRecover()){onState('waiting');return;}
    onState('reconnecting');
    timer=setTimer(async()=>{
      timer=null;if(stopped||!pending)return;
      if(!canRecover()){onState('waiting');return;}
      attempts++;request=new AbortController();const current=request;
      try{
        await reload(current.signal);
        if(stopped||request!==current)return;
        pending=false;healthySeconds=0;onState('restored');
      }catch(error){if(!stopped&&request===current){lastError=error;}}
      finally{if(request===current)request=null;}
      schedule();
    },delays[attempts]);
  }
  return {
    fail(error){if(stopped||fatal)return;lastError=error;healthySeconds=0;pending=true;schedule();},
    resume:schedule,
    healthy(seconds){if(stopped||pending)return;healthySeconds+=Math.max(0,seconds);if(healthySeconds>=30){attempts=0;healthySeconds=0;fatal=false;}},
    busy:()=>pending||fatal,
    suspend(){if(timer!==null)clearTimer(timer);timer=null;request?.abort();request=null;},
    cancel(){stopped=true;pending=false;if(timer!==null)clearTimer(timer);timer=null;request?.abort();request=null;}
  };
};

/* native-player.js */
'use strict';
(() => {
  const api=window.CourseForgeServices.request,json=window.CourseForgeServices.json;
  let active=null;
  const element=(tag,cls='',text='')=>{const e=document.createElement(tag);e.className=cls;e.textContent=text;return e;};
  function button(label,svgOrId,action){
    const b=element('button','player-button');b.type='button';b.title=label;b.setAttribute('aria-label',label);
    if(typeof svgOrId==='string'&&svgOrId.startsWith('i-')){
      b.innerHTML=`<svg class="icon" aria-hidden="true"><use href="#${svgOrId}"/></svg>`;
    }else{
      b.innerHTML=`<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${svgOrId}</svg>`;
    }
    b.onclick=action;return b;
  }
  function stop(){
    const a=active;active=null;if(!a)return;
    const progress=state.progress.get(a.lesson)||{};
    state.progress.set(a.lesson,{...progress,video_id:a.lesson,position:position(a)});
    a.recovery?.cancel();clearInterval(a.watchdog);clearInterval(a.timer);clearTimeout(a.hold);clearTimeout(a.feedbackTimer);a.send('closed',true);a.stopped=true;
    a.cleanup?.();a.video.pause();a.video.removeAttribute('src');a.video.load();
  }
  function position(a){return a.video.readyState>=1&&!a.video.error&&Number.isFinite(a.video.currentTime)?a.video.currentTime:a.savedPosition;}
  function seek(seconds,absolute=false){
    const a=active;if(!a||a.locked||!Number.isFinite(a.video.duration))return;
    a.video.currentTime=Math.max(0,Math.min(a.video.duration,absolute?seconds:a.video.currentTime+seconds));
    a.feedback.textContent=absolute?`Jumped to ${prettyTime(a.video.currentTime)}`:`${seconds<0?'Back':'Forward'} ${Math.abs(seconds)} seconds`;
    a.feedback.hidden=false;clearTimeout(a.feedbackTimer);a.feedbackTimer=setTimeout(()=>a.feedback.hidden=true,900);
  }
  async function open(wrap,lesson,session,onFailure){
    stop();
    window.CourseForgeLoadPlayer?.();
    const stage=element('div','native-player-stage'),controller=element('media-controller'),v=element('video');
    stage.tabIndex=0;stage.setAttribute('aria-label','Lesson player. Space plays or pauses, arrows seek, M mutes, F opens fullscreen, L locks controls.');
    controller.setAttribute('autohide','3');controller.setAttribute('nohotkeys','');controller.setAttribute('gesturesdisabled','');
    controller.setAttribute('fullscreenelement','lecturePlayerWrap');
    v.id='nativeLecturePlayer';v.controls=true;v.playsInline=true;v.preload='metadata';v.slot='media';
    v.disablePictureInPicture=true;v.setAttribute('disableRemotePlayback','');
    v.setAttribute('aria-label',lesson.title);v.setAttribute('controlsList','nodownload nofullscreen noremoteplayback');
    const watermark=element('div','native-watermark',session.watermark),feedback=element('div','seek-feedback');feedback.hidden=true;feedback.setAttribute('aria-live','polite');
    const loading=element('media-loading-indicator');loading.setAttribute('slot','centered-chrome');loading.setAttribute('noautohide','');
    controller.append(v,loading);stage.append(controller,watermark,feedback);wrap.append(stage);
    const status=element('p','native-player-status','Loading lesson…');status.setAttribute('aria-live','polite');stage.append(status);
    const prefs=window.CourseForgePlayerSession?.preferences()||{speed:1};
    const a={video:v,stage,controller,status,feedback,id:session.id,lesson:lesson.id,sequence:0,last:performance.now(),position:0,
      rate:prefs.speed,running:false,delivery:null,stopped:false,timer:null,locked:false,hold:null,
      savedPosition:session.start_pos||0,resumeAt:session.start_pos||0,wantsPlay:false,reloading:false,
      lastAdvance:performance.now(),loadedOnce:false};active=a;
    const actual=()=>document.hidden?'hidden':v.paused?'pause':v.readyState<3?'waiting':'playing';
    a.send=(event,final=false)=>{
      if(a.stopped)return;
      const now=performance.now(),wall=(now-a.last)/1000,pos=position(a);
      const advanced=pos-a.position;
      const elapsed=a.running&&navigator.onLine!==false&&advanced>0&&advanced<=Math.min(wall,20)*a.rate+1?Math.min(20,wall,advanced/a.rate):0;
      const packet={sequence:++a.sequence,event,position:pos,duration:Number.isFinite(v.duration)?v.duration:0,
        elapsed_seconds:Math.max(0,elapsed),rate:a.rate,playback_state:actual()};
      a.last=now;a.position=pos;a.rate=v.playbackRate;
      a.running=navigator.onLine!==false&&actual()==='playing'&&!['seeking','seeked','ready','error','closed'].includes(event);
      const apply=r=>{
        if(active!==a||!r)return;
        if(['closed','expired','ownership_lost'].includes(r.reason)){
          a.running=false;a.recovery.suspend();v.pause();status.textContent='Playback is paused. Resume here to continue.';
          window.CourseForgeStudio?.ownershipLost(status.textContent);return;
        }
        if(!r.accepted&&r.reason!=='duplicate')return;
        if(r.resume_saved===false)return;
        const p=state.progress.get(a.lesson)||{};
        const completed=r.completed??p.completed;
        window.CourseForgeStudio?.completion(completed);
        if(completed&&!p.completed){
          renderLessons();
          toast('Lesson completed.');
          window.CourseForgeCompletion?.triggerLessonCheckMoment?.();
          const currentVid=state.videos.find(v=>v.id===a.lesson);
          if(currentVid){
            const courseLessons=state.videos.filter(v=>v.course===currentVid.course);
            const allDone=courseLessons.every(v=>v.id===a.lesson||state.progress.get(v.id)?.completed);
            if(allDone){
              const meta=state.courseMeta.get(currentVid.course)||{};
              window.CourseForgeCompletion?.showCourseCompletion?.({name:currentVid.course,title:meta.title||currentVid.course,videos:courseLessons});
            }
          }
        }
      };
      if(final){
        a.delivery?.stop();fetch(`/api/player/${a.id}/events`,{method:'POST',keepalive:true,credentials:'same-origin',
          headers:{'Content-Type':'application/json','X-CSRF-Token':window.CourseForgeAccount?.csrf||''},body:JSON.stringify(packet)}).catch(()=>{});return;
      }
      if(!a.delivery)a.delivery=window.CourseForgePlaybackDelivery({
        request:(sample,signal)=>api(`/api/player/${a.id}/events`,{...json('POST',sample),signal}),onSaved:apply,
        onError:error=>{if(active!==a)return;if([401,403,404].includes(error.status)||error.code==='queue_full'){a.recovery.suspend();v.pause();window.CourseForgeStudio?.ownershipLost('Please resume the lesson to continue.');}}
      });
      a.delivery.send(packet);
    };
    v.addEventListener('loadedmetadata',()=>{
      if(active!==a)return;
      if(a.resumeAt>0)v.currentTime=Math.min(a.resumeAt,Math.max(0,v.duration-.1));
      v.playbackRate=a.rate;status.textContent='';a.lastAdvance=performance.now();a.send('ready');
      if(!a.loadedOnce)window.CourseForgeStudio?.resumePrompt(a.resumeAt);a.loadedOnce=true;
    });
    for(const event of ['playing','pause','seeking','waiting','ended','ratechange'])v.addEventListener(event,()=>{
      if(active!==a||a.reloading)return;a.send(document.hidden?'hidden':event);
      if(event==='playing'){a.wantsPlay=true;a.lastAdvance=performance.now();status.textContent='';stage.querySelector('.player-resume')?.remove();}
      if(event==='pause'&&!v.error){a.wantsPlay=false;}
      if(event==='ratechange')window.CourseForgePlayerSession?.setPreferences({speed:v.playbackRate});
      if(event==='ended')window.CourseForgeStudio?.ended(lesson);
    });
    v.addEventListener('seeked',()=>{if(active===a){a.send('seeked');if(!v.paused&&!document.hidden)a.send('playing');}});
    v.addEventListener('timeupdate',()=>{
      if(active!==a||v.error||v.readyState<1)return;
      const advanced=v.currentTime-a.savedPosition;a.savedPosition=v.currentTime;
      if(!v.paused&&advanced>0&&advanced<2){a.lastAdvance=performance.now();a.recovery.healthy(advanced/Math.max(.25,v.playbackRate));}
      window.CourseForgeStudio?.checkUpNext?.(lesson, v.currentTime, v.duration);
    });
    v.addEventListener('play',()=>{if(!a.reloading){a.wantsPlay=true;a.lastAdvance=performance.now();}});
    a.recovery=window.CourseForgePlayerRecovery({
      canRecover:()=>active===a&&!a.blocked&&!document.hidden&&navigator.onLine!==false&&window.CourseForgePlayerSession.isOwner(),
      onState:mode=>{if(active!==a)return;status.textContent=mode==='waiting'?'Waiting for your connection…':mode==='reconnecting'?'Reconnecting…':'';stage.toggleAttribute('data-recovering',mode==='reconnecting'||mode==='waiting');},
      onFailure:()=>{if(active===a)onFailure();},
      reload:async signal=>{
        a.reloading=true;a.running=false;a.resumeAt=position(a);a.delivery?.stop();a.delivery=null;
        const request=new AbortController(),timeout=setTimeout(()=>request.abort(),20000);
        const abort=()=>request.abort();signal.addEventListener('abort',abort,{once:true});
        try{
          const fresh=await api(`/api/videos/${encodeURIComponent(lesson.id)}/native-session`,{...json('POST',{
            start_pos:a.resumeAt,player_session_id:window.CourseForgePlayerSession.current()}),signal:request.signal});
          if(active!==a||signal.aborted)throw new DOMException('Cancelled','AbortError');
          a.id=fresh.id;a.sequence=0;a.last=performance.now();a.position=a.resumeAt;
          await new Promise((resolve,reject)=>{
            const finish=error=>{v.removeEventListener('canplay',ready);v.removeEventListener('error',fail);request.signal.removeEventListener('abort',cancel);error?reject(error):resolve();};
            const ready=()=>finish(),fail=()=>finish(new Error('Media unavailable')),cancel=()=>finish(new DOMException('Cancelled','AbortError'));
            v.addEventListener('canplay',ready,{once:true});v.addEventListener('error',fail,{once:true});request.signal.addEventListener('abort',cancel,{once:true});
            v.src=fresh.media_url;v.load();
          });
          a.lastAdvance=performance.now();a.reloading=false;
          if(a.wantsPlay&&!document.hidden&&window.CourseForgePlayerSession.isOwner())await v.play();
        }finally{clearTimeout(timeout);signal.removeEventListener('abort',abort);a.reloading=false;}
      }
    });
    v.addEventListener('error',()=>{if(active===a&&!a.reloading){a.send('error');a.recovery.fail(v.error?.code===3?{code:'decode'}:new Error('Media unavailable'));}});
    a.timer=setInterval(()=>{if(active===a&&!a.reloading)a.send(document.hidden?'hidden':'heartbeat');},10000);
    a.watchdog=setInterval(()=>{if(active===a&&!a.recovery.busy()&&(v.readyState===0||a.wantsPlay&&!v.ended)&&performance.now()-a.lastAdvance>20000){a.lastAdvance=performance.now();a.recovery.fail(new Error('Playback stalled'));}},2000);
    // Media Chrome is locally hosted. Preserve the browser's controls if the
    // component bundle cannot load, rather than leaving an unusable player.
    const ready=await Promise.race([customElements.whenDefined('media-controller').then(()=>true),new Promise(r=>setTimeout(()=>r(false),4000))]);
    if(active!==a)return null;
    const chrome=element('div','native-controls');
    if(ready){
      v.controls=false;
      const top=element('div','player-top-controls');top.slot='top-chrome';
      const capture=button('Capture timestamp','i-bookmark',()=>window.CourseForgeStudio?.capture());
      const episodesBtn=button('Course episodes drawer','i-menu',()=>toggleEpisodesDrawer());
      const theater=button('Theater mode','i-theater',()=>window.CourseForgeStudio?.toggleTheater());
      const shortcutsBtn=button('Keyboard shortcuts','i-help',()=>toggleShortcuts(shortcutsPopover.hidden));
      shortcutsBtn.setAttribute('aria-haspopup','dialog');shortcutsBtn.setAttribute('aria-expanded','false');
      const lock=button('Lock player controls','i-lock',()=>setLock(true));
      top.append(capture,episodesBtn,theater,shortcutsBtn,lock);controller.append(top);

      const drawer=element('aside','player-episodes-drawer');
      drawer.hidden=true;drawer.setAttribute('role','region');drawer.setAttribute('aria-label','Course episodes list');
      stage.append(drawer);

      function toggleEpisodesDrawer(open){
        const shouldOpen=open!==undefined?open:drawer.hidden;
        drawer.hidden=!shouldOpen;episodesBtn.setAttribute('aria-expanded',String(shouldOpen));
        pinControls();
        if(shouldOpen)renderDrawerEpisodes();
      }

      function renderDrawerEpisodes(){
        const currentVid=state.videos.find(item=>item.id===a.lesson);
        if(!currentVid)return;
        const courseLessons=state.videos.filter(item=>item.course===currentVid.course);
        const escapeStr=str=>String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

        drawer.innerHTML=`
          <div class="drawer-header">
            <div class="drawer-header-titles">
              <span class="drawer-eyebrow">COURSE EPISODES</span>
              <h3 class="drawer-title">${escapeStr(state.courseMeta.get(currentVid.course)?.title||currentVid.course)}</h3>
            </div>
            <button type="button" class="player-button drawer-close-btn" aria-label="Close drawer">
              <svg class="icon"><use href="#i-close"/></svg>
            </button>
          </div>
          <div class="drawer-list">
            ${courseLessons.map((ep,idx)=>{
              const isCurrent=ep.id===currentVid.id;
              const dur=ep.duration?Math.ceil(ep.duration/60)+'m':'';
              const thumbUrl=`/api/artwork/lectures/${ep.id}/thumbnail?size=sm`;
              const isDone=Boolean(state.progress.get(ep.id)?.completed);
              return `
                <div class="drawer-episode-item ${isCurrent?'is-current':''}" data-id="${ep.id}">
                  <div class="drawer-ep-thumb-wrap">
                    <img src="${thumbUrl}" alt="" loading="lazy" />
                    ${isCurrent?'<div class="drawer-playing-indicator"><svg class="icon"><use href="#i-play"/></svg></div>':''}
                    ${dur?`<span class="drawer-duration">${dur}</span>`:''}
                  </div>
                  <div class="drawer-ep-info">
                    <div class="drawer-ep-num-row">
                      <span class="drawer-ep-num">E${idx+1}</span>
                      ${isDone?'<span class="drawer-done-check"><svg class="icon"><use href="#i-check-circle"/></svg></span>':''}
                    </div>
                    <strong class="drawer-ep-title">${escapeStr(ep.title)}</strong>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `;

        drawer.querySelector('.drawer-close-btn').onclick=()=>toggleEpisodesDrawer(false);
        drawer.querySelectorAll('.drawer-episode-item').forEach(item=>{
          item.onclick=async()=>{
            const epId=item.dataset.id;
            if(epId&&epId!==currentVid.id){
              toggleEpisodesDrawer(false);
              if(typeof window.openVideo==='function'){
                await window.openVideo(epId);
                window.CourseForgeNative.video()?.play().catch(()=>{});
              }
            }
          };
        });
      }

      const timeline=element('media-time-range','player-timeline');timeline.setAttribute('aria-label','Seek lecture');
      const row=element('media-control-bar','player-control-row');
      for(const [tag,attrs] of [['media-play-button',{}],['media-seek-backward-button',{seekoffset:'10'}],['media-seek-forward-button',{seekoffset:'10'}],['media-mute-button',{}],['media-volume-range',{}]]){
        const e=element(tag);for(const [k,value]of Object.entries(attrs))e.setAttribute(k,value);row.append(e);
      }
      const clock=element('span','player-clock'),spacer=element('span','player-control-spacer');
      const compactTime=seconds=>prettyTime(Math.max(0,seconds)).replace(/^00:/,'');
      const updateClock=()=>{clock.textContent=`${compactTime(position(a))} / ${Number.isFinite(v.duration)?compactTime(v.duration):'--:--'}`;};
      updateClock();v.addEventListener('timeupdate',updateClock);v.addEventListener('loadedmetadata',updateClock);
      row.append(clock);
      const speed=button('Playback speed','i-speed',()=>toggleMenu(menu.hidden));
      speed.classList.add('player-settings');speed.setAttribute('aria-haspopup','true');speed.setAttribute('aria-expanded','false');
      const menu=element('div','player-speed-menu');menu.hidden=true;menu.setAttribute('role','group');menu.setAttribute('aria-label','Playback speed');
      menu.append(element('strong','','Playback speed'));
      const rates=element('div','player-speed-options');
      for(const rate of [.5,.75,1,1.25,1.5,1.75,2,2.5,3]){
        const choice=element('button','',rate===1?'Normal':`${rate}×`);choice.type='button';choice.dataset.rate=rate;
        choice.setAttribute('aria-pressed',String(rate===prefs.speed));choice.onclick=()=>{v.playbackRate=rate;toggleMenu(false);speed.focus();};rates.append(choice);
      }
      menu.append(rates);stage.append(menu);

      const shortcutsPopover=element('div','player-shortcuts-popover');shortcutsPopover.hidden=true;
      shortcutsPopover.setAttribute('role','dialog');shortcutsPopover.setAttribute('aria-label','Keyboard shortcuts');
      const popHeader=element('div','shortcuts-header');
      popHeader.append(element('strong','','Keyboard shortcuts'));
      const closeShortcuts=button('Close shortcuts','i-close',()=>toggleShortcuts(false));
      closeShortcuts.classList.add('shortcuts-close');
      popHeader.append(closeShortcuts);
      const scList=element('div','shortcuts-grid');
      for(const [keys,label] of [
        [['Space','K'],'Play / Pause'],
        [['J','← / →'],'Seek backward / forward'],
        [['↑','↓'],'Volume ±10%'],
        [['M'],'Mute audio'],
        [['F'],'Toggle fullscreen'],
        [['C'],'Cinema mode'],
        [['L'],'Lock controls'],
        [['Esc'],'Close popups']
      ]){
        const item=element('div','shortcut-row');
        const kw=element('span','shortcut-keys');
        for(const k of keys)kw.append(element('kbd','',k));
        item.append(kw,element('span','shortcut-label',label));
        scList.append(item);
      }
      shortcutsPopover.append(popHeader,scList);stage.append(shortcutsPopover);

      function toggleShortcuts(open){
        shortcutsPopover.hidden=!open;shortcutsBtn.setAttribute('aria-expanded',String(open));
        pinControls();
        if(open)closeShortcuts.focus();else shortcutsBtn.focus();
      }
      stage.addEventListener('pointerdown',event=>{
        if(!shortcutsPopover.hidden&&!event.composedPath().includes(shortcutsPopover)&&!event.composedPath().includes(shortcutsBtn))toggleShortcuts(false);
      });
      shortcutsPopover.addEventListener('keydown',event=>{
        if(event.key==='Escape'){event.preventDefault();event.stopPropagation();toggleShortcuts(false);shortcutsBtn.focus();}
      });

      const pinControls=()=>controller.setAttribute('autohide',a.locked||!menu.hidden||!shortcutsPopover.hidden||!drawer.hidden||stage.matches(':focus-visible')||stage.querySelector(':focus-visible')?'-1':'3');
      function toggleMenu(open){menu.hidden=!open;speed.setAttribute('aria-expanded',String(open));pinControls();if(open)rates.querySelector('[aria-pressed="true"]')?.focus();}
      v.addEventListener('ratechange',()=>{for(const choice of rates.children)choice.setAttribute('aria-pressed',String(Number(choice.dataset.rate)===v.playbackRate));});
      stage.addEventListener('pointerdown',event=>{if(!menu.hidden&&!event.composedPath().includes(menu)&&!event.composedPath().includes(speed))toggleMenu(false);});
      menu.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();toggleMenu(false);speed.focus();}});
      menu.addEventListener('focusout',event=>{if(event.relatedTarget&&!menu.contains(event.relatedTarget)&&event.relatedTarget!==speed)toggleMenu(false);});
      const full=button('Fullscreen','i-fullscreen',async()=>{
        try{if(document.fullscreenElement)await document.exitFullscreen();else{await wrap.requestFullscreen();if(matchMedia('(pointer:coarse)').matches)await screen.orientation?.lock?.('landscape').catch(()=>{});}}
        catch{toast('Fullscreen is unavailable.',true);}
      });
      const fullscreen=()=>{if(!document.fullscreenElement)screen.orientation?.unlock?.();};
      document.addEventListener('fullscreenchange',fullscreen);
      a.cleanup=()=>{document.removeEventListener('fullscreenchange',fullscreen);screen.orientation?.unlock?.();};
      row.append(spacer,speed,full);chrome.append(timeline,row);controller.append(chrome);
      const center=element('div','player-center-controls');
      const back=button('Back 10 seconds','i-replay-10',()=>seek(-10));
      const play=button('Play lesson','i-play',()=>v.paused?v.play().catch(()=>{}):v.pause());
      const forward=button('Forward 10 seconds','i-forward-10',()=>seek(10));
      play.classList.add('player-center-play');center.append(back,play,forward);stage.append(center);
      const updatePlay=()=>{
        stage.classList.toggle('is-playing',!v.paused);
        play.setAttribute('aria-label',v.paused?'Play lesson':'Pause lesson');play.title=v.paused?'Play lesson':'Pause lesson';
        play.querySelector('use')?.setAttribute('href',v.paused?'#i-play':'#i-pause');
      };
      for(const event of ['play','pause','ended'])v.addEventListener(event,updatePlay);
      const unlock=element('button','player-unlock','Hold to unlock');unlock.type='button';unlock.hidden=true;unlock.setAttribute('aria-label','Hold for one second to unlock, or press Enter or Escape');stage.append(unlock);
      function setLock(locked){
        a.locked=locked;toggleMenu(false);toggleShortcuts(false);toggleEpisodesDrawer(false);stage.classList.toggle('controls-locked',locked);chrome.inert=locked;top.inert=locked;center.inert=locked;
        unlock.hidden=!locked;pinControls();unlock.textContent='Hold to unlock';
        if(locked)unlock.focus();else stage.focus();
      }
      a.unlock=()=>setLock(false);
      unlock.addEventListener('pointerdown',event=>{if(event.button!==0)return;unlock.setPointerCapture(event.pointerId);unlock.textContent='Keep holding…';a.hold=setTimeout(()=>setLock(false),1000);});
      for(const event of ['pointerup','pointercancel','lostpointercapture'])unlock.addEventListener(event,()=>{clearTimeout(a.hold);if(a.locked)unlock.textContent='Hold to unlock';});
      unlock.onclick=event=>{if(event.detail===0)setLock(false);};

      function changeVolume(delta){
        v.volume=Math.max(0,Math.min(1,Number((v.volume+delta).toFixed(2))));
        if(v.muted&&delta>0)v.muted=false;
        a.feedback.textContent=`Volume: ${Math.round(v.volume*100)}%`;
        a.feedback.hidden=false;clearTimeout(a.feedbackTimer);a.feedbackTimer=setTimeout(()=>a.feedback.hidden=true,900);
      }

      stage.addEventListener('keydown',event=>{
        if(event.key==='Escape'&&a.locked){event.preventDefault();event.stopPropagation();setLock(false);return;}
        if(!drawer.hidden&&event.key==='Escape'){event.preventDefault();toggleEpisodesDrawer(false);return;}
        if(a.locked)return;
        const target=event.composedPath()[0];if(target.tagName==='INPUT'||target.tagName==='TEXTAREA'||target.isContentEditable)return;
        if(event.ctrlKey||event.metaKey||event.altKey)return;
        const keyChar=event.key.length===1?event.key.toLowerCase():event.key;
        const actions={
          ' ':()=>v.paused?v.play().catch(()=>{}):v.pause(),
          'k':()=>v.paused?v.play().catch(()=>{}):v.pause(),
          'j':()=>seek(-10),
          'ArrowLeft':()=>seek(-10),
          'ArrowRight':()=>seek(10),
          'ArrowUp':()=>changeVolume(0.1),
          'ArrowDown':()=>changeVolume(-0.1),
          'm':()=>{v.muted=!v.muted;a.feedback.textContent=v.muted?'Muted':'Unmuted';a.feedback.hidden=false;clearTimeout(a.feedbackTimer);a.feedbackTimer=setTimeout(()=>a.feedback.hidden=true,900);},
          'f':()=>full.click(),
          'c':()=>window.CourseForgeStudio?.toggleTheater(),
          'l':()=>setLock(true),
          '?':()=>toggleShortcuts(!shortcutsPopover.hidden)
        };
        const action=actions[keyChar]||actions[event.key];if(action){event.preventDefault();action();}
      });
      let lastTap=0,lastSide=null;
      stage.addEventListener('pointerup',event=>{
        if(a.locked)return;
        if(event.target.closest('button, media-control-bar, .player-speed-menu, .player-shortcuts-popover, input, select'))return;
        if(event.pointerType==='mouse'){
          if(event.target===v||event.target===controller){v.paused?v.play().catch(()=>{}):v.pause();}
          return;
        }
        const rect=stage.getBoundingClientRect();
        const x=event.clientX-rect.left;
        const side=x<rect.width/2?'left':'right';
        const now=performance.now();
        if(now-lastTap<350&&side===lastSide){
          seek(side==='left'?-10:10);lastTap=0;lastSide=null;
        }else{
          lastTap=now;lastSide=side;
        }
      });
      stage.addEventListener('focusin',pinControls);
      stage.addEventListener('focusout',()=>queueMicrotask(pinControls));
    }else{
      controller.replaceWith(v);stage.classList.add('native-fallback');
    }
    const volumeKey='courseforge-volume-'+window.CourseForgeAccount?.user?.id;
    try{const saved=JSON.parse(localStorage.getItem(volumeKey)||'null');if(saved){v.volume=Math.max(0,Math.min(1,saved.volume));v.muted=Boolean(saved.muted);}}catch{}
    v.addEventListener('volumechange',()=>{try{localStorage.setItem(volumeKey,JSON.stringify({volume:v.volume,muted:v.muted}));}catch{}});
    v.src=session.media_url;return v;
  }
  function suspend(){if(active){active.recovery.suspend();active.send('hidden');active.running=false;active.video.pause();}}
  window.addEventListener('offline',()=>{if(active){active.running=false;active.send('hidden');active.status.textContent='You’re offline. Waiting for your connection…';}});
  window.addEventListener('online',()=>active?.recovery.resume());
  window.CourseForgeNative={open,stop,seek,suspend,toolbar:()=>element('div'),currentPosition:()=>active?position(active):null,
    video:()=>active?.video,locked:()=>Boolean(active?.locked),unlock:()=>active?.unlock?.(),
    resetBaseline:()=>{if(active){active.last=performance.now();active.position=position(active);active.running=false;active.blocked=false;}},
    pauseForRecovery:()=>{if(active){active.blocked=true;active.recovery.suspend();active.running=false;active.video.pause();}},
    resumeRecovery:()=>active?.recovery.resume(),
    trackingNotice:()=>{}};
})();

/* player-studio.js */
'use strict';
(() => {
  let countdown = null, seconds = 0;
  let upNextTriggered = false, upNextCancelled = false;
  const prefs = () => window.CourseForgePlayerSession.preferences();

  function cancelNext() {
    clearInterval(countdown);
    countdown = null;
    upNextTriggered = false;
    document.querySelector('.player-next, .player-up-next-card')?.remove();
  }

  function adjacent(direction, availableOnly = false) {
    const current = state.videos.find(v => v.id === state.currentVideoId);
    if (!current) return null;
    const lessons = state.videos.filter(v => v.course === current.course);
    const at = lessons.findIndex(v => v.id === current.id);
    for (let i = at + direction; i >= 0 && i < lessons.length; i += direction) {
      if (!availableOnly || lessons[i].cloud_ready) return lessons[i];
    }
    return null;
  }

  function update(video) {
    cancelNext();
    upNextTriggered = false;
    upNextCancelled = false;
    document.body.classList.add('in-learning');
    $('#learningHeader').textContent = state.courseMeta.get(video.course)?.title || video.course;
    $('#learningSubhead').textContent = lessonTitle(video.title);
    completion(Boolean(state.progress.get(video.id)?.completed));
    $('#playerAutoplay').checked = prefs().autoplay;
    $('.learning-grid').classList.toggle('cinema-expanded', prefs().theater);
    for (const [id, step] of [['previousLessonBtn', -1], ['nextLessonBtn', 1]]) {
      const next = adjacent(step);
      $('#' + id).disabled = !next;
      $('#' + id).title = next?.title || 'No more lessons';
    }
  }

  function overlay(cls, text, actions) {
    const stage = document.querySelector('.native-player-stage') || $('#lecturePlayerWrap');
    if (!stage) return null;
    stage.querySelector('.' + cls)?.remove();
    const box = make('div', cls);
    box.setAttribute('role', 'status');
    if (cls === 'player-recovery') {
      stage.querySelector('.player-resume')?.remove();
      const status = stage.querySelector('.native-player-status');
      if (status) status.textContent = '';
      const iconWrap = make('div', 'player-recovery-icon');
      iconWrap.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-refresh"/></svg>';
      box.append(iconWrap, make('h3', '', 'Stream Interrupted'));
    }
    box.append(make('p', '', text));
    const row = make('div', cls === 'player-recovery' ? 'player-recovery-actions' : '');
    for (const [label, action] of actions) {
      const isPrimary = label.toLowerCase().includes('resume') || label.toLowerCase().includes('play');
      const b = make('button', `btn ${isPrimary ? 'btn-primary' : 'btn-outline'}`, label);
      b.type = 'button';
      b.onclick = () => Promise.resolve(action()).catch(error => toast(error.message, true));
      row.append(b);
    }
    box.append(row);
    stage.append(box);
    return box;
  }

  function checkUpNext(lesson, currentTime, duration) {
    if (upNextTriggered || upNextCancelled || !duration || Number.isNaN(duration)) return;
    const remaining = duration - currentTime;
    if (remaining <= 30 && remaining > 0) {
      upNextTriggered = true;
      showUpNextCard(lesson);
    }
  }

  function showUpNextCard(lesson) {
    cancelNext();
    upNextTriggered = true;
    const next = adjacent(1, true);
    if (!next || next.course !== lesson.course) return;

    const stage = document.querySelector('.native-player-stage') || $('#lecturePlayerWrap');
    if (!stage) return;

    const card = document.createElement('div');
    card.className = 'player-up-next-card';
    card.id = 'playerUpNextCard';
    card.setAttribute('role', 'region');
    card.setAttribute('aria-label', 'Next episode countdown');

    seconds = 10;
    const thumbUrl = `/api/artwork/lectures/${next.id}/thumbnail?size=sm`;

    card.innerHTML = `
      <div class="up-next-thumb-wrap">
        <img src="${thumbUrl}" alt="" loading="lazy" />
        <span class="up-next-countdown-badge" id="upNextCountdownBadge">${seconds}s</span>
      </div>
      <div class="up-next-content">
        <span class="up-next-eyebrow">UP NEXT</span>
        <h4 class="up-next-title">${escapeHtml(next.title)}</h4>
        <div class="up-next-actions">
          <button type="button" class="btn btn-primary btn-sm up-next-watch-btn" id="upNextWatchBtn">
            <svg class="icon"><use href="#i-play"/></svg> Watch Now
          </button>
          <button type="button" class="btn btn-outline btn-sm up-next-cancel-btn" id="upNextCancelBtn">
            Cancel
          </button>
        </div>
      </div>
    `;

    card.querySelector('#upNextWatchBtn').onclick = async () => {
      window.CourseForgeServices?.trackStreamingEvent('up_next_accepted', next.id, { source: 'watch_now_button' });
      cancelNext();
      await openVideo(next.id);
      await window.CourseForgeNative.video()?.play();
    };

    card.querySelector('#upNextCancelBtn').onclick = () => {
      window.CourseForgeServices?.trackStreamingEvent('up_next_declined', next.id, { source: 'cancel_button' });
      upNextCancelled = true;
      cancelNext();
    };

    stage.append(card);

    countdown = setInterval(() => {
      if (document.hidden || window.CourseForgeNative.locked()) {
        cancelNext();
        return;
      }
      seconds--;
      const badge = document.getElementById('upNextCountdownBadge');
      if (badge) badge.textContent = `${seconds}s`;

      if (seconds <= 0) {
        window.CourseForgeServices?.trackStreamingEvent('up_next_accepted', next.id, { source: 'auto_countdown' });
        cancelNext();
        openVideo(next.id).then(() => window.CourseForgeNative.video()?.play()).catch(error => toast(error.message, true));
      }
    }, 1000);
  }

  function ownershipLost(text) {
    cancelNext();
    const v = window.CourseForgeNative.video();
    if (v) {
      window.CourseForgeNative.unlock();
      window.CourseForgeNative.pauseForRecovery();
    } else {
      document.querySelector('#lecturePlayerWrap iframe')?.remove();
    }
    overlay('player-recovery', text, [['Resume here', async () => {
      try {
        if (!await window.CourseForgePlayerSession.reclaim()) return;
      } catch (error) {
        if ([403, 404].includes(error.status)) {
          await openVideo(state.currentVideoId);
          return;
        }
        throw error;
      }
      const media = window.CourseForgeNative.video();
      if (media && !media.error && media.readyState >= 1) {
        document.querySelector('.player-recovery')?.remove();
        window.CourseForgeNative.resumeRecovery();
        await media.play();
      } else {
        await openVideo(state.currentVideoId, window.CourseForgeNative.currentPosition());
      }
    }], ['Back to courses', () => navigate('library')]]);
  }

  function ended(lesson) {
    if (!upNextTriggered && !upNextCancelled && prefs().autoplay) {
      showUpNextCard(lesson);
    }
  }

  function resumePrompt(start) {
    if (!start) return;
    overlay('player-resume', `Continue from ${prettyTime(start)}?`, [
      ['Resume', () => {
        document.querySelector('.player-resume')?.remove();
        return window.CourseForgeNative.video()?.play();
      }],
      ['Restart', () => {
        window.CourseForgeNative.seek(0, true);
        document.querySelector('.player-resume')?.remove();
        return window.CourseForgeNative.video()?.play();
      }]
    ]);
  }

  function capture() {
    const position = window.CourseForgeNative.currentPosition();
    if (position === null) return;
    for (const id of ['notePosition', 'bookmarkPosition']) $('#' + id).value = prettyTime(position);
    selectLessonTab('notes');
    $('#noteText').focus({ preventScroll: true });
    toast('Timestamp added. Write a note or bookmark to save it.');
  }

  function completion(completed) {
    const button = $('#markCompleteBtn');
    button.textContent = completed ? 'Completed' : 'Complete lesson';
    button.setAttribute('aria-pressed', String(Boolean(completed)));
    button.title = completed ? 'Undo lesson completion' : 'Mark this lesson complete';
    button.classList.toggle('lesson-completed', Boolean(completed));
    $('#playingCourse').textContent = completed ? 'Lesson completed. Continue to the next lesson when you’re ready.' : 'Pick up where you left off. Your place is saved automatically.';
  }

  function toggleTheater() {
    const theater = !prefs().theater;
    window.CourseForgePlayerSession.setPreferences({ theater });
    $('.learning-grid').classList.toggle('cinema-expanded', theater);
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  $('#playerAutoplay').onchange = event => {
    window.CourseForgePlayerSession.setPreferences({ autoplay: event.target.checked });
    if (!event.target.checked) cancelNext();
  };
  $('#studioAccount').onclick = () => $('#accountNav').click();
  $('#studioResources').onclick = () => {
    const video = state.videos.find(v => v.id === state.currentVideoId);
    if (video) openMaterialsModal(video.course);
  };
  document.querySelectorAll('[data-study-extra]').forEach(button => button.onclick = () => {
    selectLessonTab(button.dataset.studyExtra);
    button.closest('details').open = false;
  });

  window.CourseForgeStudio = {
    update,
    completion,
    cancelNext,
    adjacent,
    ended,
    checkUpNext,
    showUpNextCard,
    ownershipLost,
    capture,
    toggleTheater,
    resumePrompt
  };
})();

/* loaders.js */
'use strict';
(() => {
  let tools,player;
  window.CourseForgeLoadPlayer=()=>player||(player=import('/static/vendor/media-chrome-4.19.3.js').catch(()=>{}));
  window.CourseForgeLoadTools=()=>tools||(tools=new Promise((resolve,reject)=>{
    const css=document.createElement('link');css.rel='stylesheet';css.href='/static/tools.css?v=14';document.head.append(css);
    const script=document.createElement('script');script.src='/static/tools.js?v=14';script.onload=()=>{if(window.CourseForgeReady)window.dispatchEvent(new Event('courseforge-ready'));resolve();};script.onerror=()=>{tools=null;reject(new Error('Study tools could not load. Please refresh.'));};document.head.append(script);
  }));
  window.addEventListener('courseforge-navigate',()=>{if(['planner','syllabus','labs','reviews'].includes(state.view))window.CourseForgeLoadTools().catch(e=>toast(e.message,true));});
})();

/* academy.js */
'use strict';
(() => {
  const el=id=>document.getElementById(id);
  const api=window.CourseForgeServices.request;
  const json=window.CourseForgeServices.json;
  const account=window.CourseForgeAccount={user:null,csrf:'',lastLessons:{}};
  const node=(tag,cls='',text='')=>{const n=document.createElement(tag);n.className=cls;n.textContent=text;return n;};
  const button=(text,action,primary=false)=>{const b=node('button',primary?'btn btn-primary':'btn btn-outline',text);b.type='button';b.onclick=()=>Promise.resolve().then(action).catch(error=>message(error.message,true));return b;};
  const minutes=seconds=>{const n=Math.floor(seconds||0);return n>=3600?`${Math.floor(n/3600)}h ${Math.floor(n%3600/60)}m`:n>=60?`${Math.floor(n/60)}m ${n%60}s`:`${n}s`;};
  const date=value=>value?new Date(value).toLocaleString():'—';
  const message=(text,error=false)=>{el('academyMessage').textContent=text;el('academyMessage').classList.toggle('error',error);el('academyMessage').hidden=false;};
  const clearMessage=()=>{el('academyMessage').hidden=true;};
  const resetBrowser=()=>{history.replaceState(null,'','/');location.reload();};
  function page(title){
    leaveLesson();document.body.classList.remove('in-learning');el('appShell').hidden=true;el('academyContent').hidden=false;
    const root=el('academyContent');root.replaceChildren(node('h1','',title));clearMessage();return root;
  }
  function table(headers,rows){
    const wrap=node('div','academy-table-wrap'),t=node('table','academy-table'),head=node('thead'),hrow=node('tr');
    headers.forEach(h=>hrow.append(node('th','',h)));head.append(hrow);t.append(head);
    const body=node('tbody');
    rows.forEach(values=>{const tr=node('tr');values.forEach((value,i)=>{const td=node('td');td.dataset.label=headers[i];if(value instanceof Node)td.append(value);else td.textContent=String(value??'—');tr.append(td);});body.append(tr);});
    if(!rows.length){const tr=node('tr'),td=node('td','muted','No records yet.');td.colSpan=headers.length;tr.append(td);body.append(tr);}
    t.append(body);wrap.append(t);return wrap;
  }
  function heading(root,title,text){root.append(node('h2','',title));if(text)root.append(node('p','muted',text));}
  function field(form,label,name,type='text',required=true){
    const l=node('label','field');l.append(node('span','',label));const i=node('input','form-input');i.name=name;i.type=type;i.required=required;
    if(type==='password')i.maxLength=128;form.append(l);l.append(i);return i;
  }
  function form(root,title,submit){
    const f=node('form','academy-form panel');if(title)f.append(node('h2','',title));
    f.onsubmit=async event=>{event.preventDefault();const b=f.querySelector('[type=submit]');if(b)b.disabled=true;clearMessage();try{await submit(new FormData(f));}catch(error){message(error.message,true);}finally{if(b)b.disabled=false;}};
    root.append(f);return f;
  }
  function submitButton(f,text){const b=node('button','btn btn-primary',text);b.type='submit';f.append(b);return b;}
  function adminPage(title,section=''){
    history.replaceState(null,'',`/#admin${section?'/'+section:''}`);
    const root=page(title),nav=node('nav','admin-navigation');nav.setAttribute('aria-label','Administration');
    for(const [label,route,action] of [['Overview','',adminHome],['Students','students',adminUsers],['Courses','courses',adminCourses],['Player activity','player',adminPlayer],['System and audit','system',adminSystem]]){
      const b=button(label,()=>action());if(section.split('/')[0]===route){b.classList.add('active');b.setAttribute('aria-current','page');}nav.append(b);
    }root.append(nav);return root;
  }
  function privateLink(root,url,expires,messageText){
    const box=node('div','panel private-account-link');box.append(node('h2','','Private account link'),node('p','',messageText),node('p','muted','Expires '+date(expires)+'. The link is displayed once and is not stored in reports.'));
    const label=node('label','field');label.append(node('span','','Copy and share directly with the student'));const input=node('input','form-input');input.type='text';input.readOnly=true;input.value=url;input.autocomplete='off';label.append(input);box.append(label);
    box.append(button('Copy link',async()=>{await navigator.clipboard.writeText(url);message('Private account link copied.');}),button('Dismiss',()=>box.remove()));root.prepend(box);input.focus();input.select();
  }

  async function catalog(){
    const root=page('Build skills from your course library');
    root.append(node('p','academy-lead','Learn with organized lectures, course resources, source-linked explanations, and a personal study plan.'));
    const search=node('input','form-input catalog-search');search.type='search';search.placeholder='Search courses, instructors, or topics';search.setAttribute('aria-label','Search published courses');root.append(search);
    const cards=node('div','academy-course-grid');root.append(cards);
    const {courses}=await api('/api/public/courses');
    const render=()=>{cards.replaceChildren();const needle=search.value.toLowerCase();
      const visible=courses.filter(c=>[c.title,c.instructor,...c.tags].join(' ').toLowerCase().includes(needle));
      for(const c of visible){const card=node('article','academy-course panel');
        const category=node('div','academy-course-category',c.category||'Course');card.append(category,node('h2','',c.title),node('p','muted',c.instructor||''),node('p','',c.description||''));
        card.append(node('p','muted',`${c.lesson_count} lessons · ${c.available_lessons} available`));
        card.append(button(c.enrolled?'View your course':'View syllabus',()=>courseDetail(c.id),true));cards.append(card);}
      if(!visible.length)cards.append(node('p','muted',courses.length?'No courses match this search.':'No courses have been published yet.'));
    };search.oninput=render;render();
  }
  async function courseDetail(id){
    const c=await api(`/api/public/courses/${encodeURIComponent(id)}`);const root=page(c.title);
    root.append(button('Back to courses',catalog),node('p','academy-lead',c.description||''),node('p','muted',[c.instructor,c.category,`${c.lesson_count} lessons`].filter(Boolean).join(' · ')));
    root.append(button(c.enrolled?'Continue learning':'Enroll for free',async()=>{
      if(!account.user)return signIn();
      await api(`/api/courses/${encodeURIComponent(id)}/enroll`,json('POST',{}));
      account.bootstrap=await api('/api/me/bootstrap');
      await workspace();const course=state.courseMeta.get(id);if(course)openCourse({...course,name:id});
    },true));
    heading(root,'Course syllabus');root.append(table(['Lesson','Duration','Availability'],c.lessons.map(l=>[l.title,l.duration?minutes(l.duration):'—',l.available?'Ready to watch':'Coming soon'])));
  }
  function signIn(mode='login'){
    if(mode==='register')history.replaceState(null,'','/#register');
    else if(location.hash==='#register')history.replaceState(null,'','/');
    const root=page(mode==='register'?'Create your account':mode==='forgot'?'Reset your password':mode==='resend'?'Resend verification':'Welcome back');
    const f=form(root,'',async data=>{
      const payload=Object.fromEntries(data);const result=await api('/api/auth/'+mode,json('POST',payload));
      if(mode==='login'){location.reload();return;}
      if(mode==='register'&&result.user){history.replaceState(null,'','/#courses');location.reload();return;}
      message(result.message);f.reset();
    });
    if(mode==='register'){const n=field(f,'Name','name');n.maxLength=120;n.autocomplete='name';}
    const email=field(f,'Email address','email','email');email.autocomplete='email';email.maxLength=254;
    if(mode==='login'||mode==='register'){const password=field(f,'Password','password','password');password.autocomplete=mode==='login'?'current-password':'new-password';if(mode==='register'){password.minLength=6;f.append(node('p','muted','Use at least 6 characters.'));}}
    if(mode==='register')f.append(node('p','muted','Your account keeps your progress, notes, playback activity, and sign-in history. Administrators can review learning and access records.'));
    const submit=submitButton(f,mode==='login'?'Sign in':mode==='register'?'Create account':'Send email');
    if(mode!=='login')submit.disabled=true;
    const accountLink=button(mode==='register'?'Already registered? Sign in':'Create an account',()=>signIn(mode==='register'?'login':'register'));
    const forgot=button('Forgot password',()=>signIn('forgot')),resend=button('Resend verification',()=>signIn('resend'));
    root.append(accountLink,forgot,resend);
    api('/api/public/account-options').then(options=>{
      if(!f.isConnected)return;
      submit.disabled=mode==='register'?!options.registration_enabled:mode!=='login'&&!options.email_delivery;
      if(mode!=='register')accountLink.hidden=!options.registration_enabled;
      resend.hidden=!options.email_delivery;
      if(mode==='register'&&options.registration_enabled)root.append(node('p','muted',options.registration_mode==='open'?'Create your account and enroll in a published course to start learning immediately.':'Verify your email after creating your account to start learning.'));
      if(mode==='register'&&!options.registration_enabled)root.append(node('p','muted','Registration is currently available through administrator invitations. Ask your administrator for an activation link.'));
      if(!options.email_delivery)root.append(node('p','muted','For password recovery, ask your administrator for a private recovery link.'));
    }).catch(error=>{if(f.isConnected)message(error.message,true);});
  }
  async function workspace(){
    if(!account.user)return signIn();
    if(!account.user.verified){signIn('resend');message('Verify your email before enrolling or opening lessons.');return;}
    el('academyContent').hidden=true;el('appShell').hidden=false;clearMessage();
    const initial=account.bootstrap;account.bootstrap=null;
    const learning=initial?.learning||await api('/api/me/learning');account.lastLessons=Object.fromEntries(learning.courses.map(c=>[c.course,c.last_video_id]));
    await window.CourseForgeBoot(initial);window.CourseForgeReady=true;window.dispatchEvent(new Event('courseforge-ready'));
    window.CourseForgeLoadTools?.();
  }
  async function myAccount(){
    if(!account.user)return signIn();
    const root=page('Your account');root.append(node('p','muted',account.user.email));
    const f=form(root,'Profile and password',async data=>{
      const body={name:data.get('name')};if(data.get('password')){body.password=data.get('password');body.current_password=data.get('current_password');}
      const result=await api('/api/me',json('PATCH',body));account.user=result.user;message('Account updated.');
    });
    field(f,'Name','name').value=account.user.name;field(f,'Current password (for password changes)','current_password','password',false).autocomplete='current-password';
    const password=field(f,'New password (optional)','password','password',false);password.minLength=6;password.autocomplete='new-password';submitButton(f,'Save account');
    heading(root,'Signed-in devices');const sessions=await api('/api/auth/sessions');
    root.append(table(['Device','Last active','Session'],sessions.sessions.map(s=>[s.device||'Browser',date(s.last_seen),s.current?'This device':button('Revoke',async()=>{await api(`/api/auth/sessions/${s.id}`,{method:'DELETE'});await myAccount();})])));
    heading(root,'Your learning history','Your saved places, completed lessons, study activity, and results are stored in your account. Administrators can review learning records and account access. Access logs are kept for 30 days and detailed sessions for 90 days. Your learning totals remain until you delete your account.');
    const playback=await api('/api/me/playback');root.append(table(['Lesson','Time watched','Saved place'],playback.lessons.map(l=>[l.title,minutes(l.playing_seconds),prettyTime(l.position)])));
    if(account.user.role!=='admin'){
      const deletion=form(root,'Delete your account and learning records',async data=>{await api('/api/me',json('DELETE',{password:data.get('password')}));resetBrowser();});
      field(deletion,'Confirm password','password','password');submitButton(deletion,'Delete my account');
    }
  }
  async function adminHome(){
    const root=adminPage('Administration');root.append(button('Refresh',adminHome));
    const report=await api('/api/admin/overview');
    const metrics=node('div','academy-metrics');
    for(const [label,value] of [['Students',report.summary.students],['Enrollments',report.summary.enrollments],['Completed lessons',report.summary.completed_lessons],['Lesson activity',minutes(report.summary.activity_seconds)],['Playback time',minutes(report.summary.playing_seconds)],['Available lectures',`${report.summary.available_lectures}/${report.summary.lectures}`],['Recent sessions',report.summary.active_sessions]]){
      const card=node('div','panel metric-card');card.append(node('span','muted',label),node('strong','',String(value)));metrics.append(card);
    }root.append(metrics);
    if(report.engagement){
      heading(root,'Active engagement & return rate',report.engagement.period);
      const engMetrics=node('div','academy-metrics');
      for(const [label,value] of [
        ['Daily active students',report.engagement.daily_active_students],
        ['Average session duration',`${report.engagement.average_session_minutes} min`],
        ['7-day return rate',report.engagement.seven_day_return_rate!==null?`${report.engagement.seven_day_return_rate}%`:'Not enough cohort data'],
        ['Returning cohort',`${report.engagement.returning_students} of ${report.engagement.return_cohort} students`],
        ['Quiz pass rate',report.engagement.quiz_pass_rate!==null?`${report.engagement.quiz_pass_rate}% (${report.engagement.quizzes_passed}/${report.engagement.quizzes_taken})`:'No quizzes yet'],
        ['Review sessions completed',report.engagement.review_session_completion]
      ]){
        const card=node('div','panel metric-card');card.append(node('span','muted',label),node('strong','',String(value)));engMetrics.append(card);
      }
      root.append(engMetrics);
    }
    heading(root,'Recent student activity',report.activity_basis+'. '+report.completion_basis+'.');
    root.append(table(['Student','Activity','Lecture','Time'],report.recent_activity.map(e=>[e.name,e.event_type.replaceAll('_',' '),e.title||e.details,date(e.created_at)])));
    heading(root,'Course enrollment funnel');root.append(table(['Course','Enrolled','Started'],report.funnels.map(r=>[r.course,r.enrolled,r.started])));
    heading(root,'Recent access events');root.append(table(['Event','IP address','Device','Time'],report.access_events.map(e=>[e.event_type.replaceAll('_',' '),e.ip,e.device,date(e.created_at)])));

    try{
      const ti = await api('/api/admin/teacher-insights');
      heading(root,'Teacher insights & AI companion analytics','Aggregated student tutor questions, token tracking, and quiz fail rates');
      const tiMetrics=node('div','academy-metrics');
      for(const [label,val] of [
        ['AI Tutor queries', ti.total_ai_queries],
        ['Tokens tracked', ti.total_tokens],
        ['Estimated AI cost', `$${ti.estimated_cost_usd}`],
        ['Overall quiz pass rate', `${ti.overall_quiz_pass_rate}%`],
      ]){
        const c=node('div','panel metric-card');c.append(node('span','muted',label),node('strong','',String(val)));tiMetrics.append(c);
      }
      root.append(tiMetrics);
      if(ti.top_tutor_topics && ti.top_tutor_topics.length){
        heading(root,'Top AI companion query topics','Areas where students seek extra explanation');
        root.append(table(['Topic / Concept','Queries'],ti.top_tutor_topics.map(t=>[t.topic,t.query_count])));
      }
      if(ti.high_fail_quiz_questions && ti.high_fail_quiz_questions.length){
        heading(root,'Challenging quiz questions','Questions with highest failure rates needing instructor clarification');
        root.append(table(['Question','Lesson','Course','Fail rate','Attempts'],ti.high_fail_quiz_questions.map(q=>[q.question,q.lesson_title,q.course,`${q.fail_rate}%`,q.total_attempts])));
      }
    }catch(err){}
  }
  async function adminUsers(query='',offset=0){
    const root=adminPage('Student management','students');
    const searchForm=form(root,'Find a student',data=>adminUsers(data.get('q')));field(searchForm,'Name or email','q','search',false).value=query;submitButton(searchForm,'Search');
    const result=await api(`/api/admin/users?q=${encodeURIComponent(query)}&offset=${offset}`);
    root.append(node('p','muted',`${result.total} accounts`));
    root.append(table(['Student','Email','Status','Courses','Completion','Lesson activity','Details'],result.users.map(u=>[u.name,u.email,u.suspended?'Suspended':u.verified?'Active':'Pending activation',u.enrollments,u.completed_lessons,minutes(u.activity_seconds),button('Inspect',()=>adminStudent(u.id))])));
    const pager=node('div','toolbar');if(offset)pager.append(button('Previous',()=>adminUsers(query,Math.max(0,offset-25))));if(offset+25<result.total)pager.append(button('Next',()=>adminUsers(query,offset+25)));root.append(pager);
    const create=form(root,'Invite a student',async data=>{const payload=Object.fromEntries(data);if(!payload.course)delete payload.course;const r=await api('/api/admin/invitations',json('POST',payload));create.reset();privateLink(root,r.activation_url,r.expires_at,r.message);});
    create.append(node('p','muted','The student chooses their own password using a one-time activation link. No email service is required.'));
    field(create,'Name','name');field(create,'Email','email','email');
    const courses=await api('/api/admin/courses'),label=node('label','field');label.append(node('span','','Grant a course (optional)'));const select=node('select','form-input');select.name='course';select.add(new Option('No course selected',''));courses.courses.forEach(c=>select.add(new Option(c.title+(c.published?'':' (draft)'),c.id)));label.append(select);create.append(label);submitButton(create,'Create invitation');
  }
  async function adminStudent(uid){
    const r=await api(`/api/admin/users/${uid}`),root=adminPage(r.user.name,'students/'+uid);
    root.append(button('Back to students',()=>adminUsers()),node('p','muted',`${r.user.email} · ${r.user.role} · ${r.user.suspended?'Suspended':r.user.verified?'Active':'Pending activation'}`));
    const actions=node('div','toolbar');
    if(r.user.role!=='admin'){
      actions.append(button(r.user.suspended?'Restore account':'Suspend account',async()=>{await api(`/api/admin/users/${uid}`,json('PATCH',{suspended:!r.user.suspended}));await adminStudent(uid);}));
      if(!r.user.suspended)actions.append(button(r.user.verified?'Issue recovery link':'Reissue invitation',async()=>{const link=await api(`/api/admin/users/${uid}/account-link`,json('POST',{}));privateLink(root,link.account_url,link.expires_at,link.message);}));
    }
    actions.append(button('Revoke all sessions',async()=>{await api(`/api/admin/users/${uid}/sessions`,{method:'DELETE'});await adminStudent(uid);}));root.append(actions);
    if(r.user.verified&&!r.user.suspended){
      const roleForm=form(root,'Account role',async data=>{const result=await api(`/api/admin/users/${uid}/role`,json('PUT',{role:data.get('role'),current_password:data.get('current_password')}));if(result.session_revoked)return resetBrowser();await adminStudent(uid);message(result.changed?'Account role changed. Previous sessions were revoked.':'Account role is unchanged.');});
      roleForm.append(node('p','muted','Administrators manage all courses and student accounts. Confirm this change with your own current password.'));
      const roleSelect=node('select','form-input');roleSelect.name='role';roleSelect.setAttribute('aria-label','Account role');for(const value of ['student','admin'])roleSelect.add(new Option(value,value,false,r.user.role===value));roleForm.append(roleSelect);
      field(roleForm,'Your current password','current_password','password').autocomplete='current-password';submitButton(roleForm,'Change role');
    }
    root.append(node('p','academy-lead',`${minutes(r.activity_seconds)} of recorded lesson activity · ${r.note_count} saved notes`));
    heading(root,'Course access');root.append(table(['Course','Enrolled','Access'],r.enrollments.map(e=>[e.course,date(e.created_at),button('Revoke course access',async()=>{await api(`/api/admin/users/${uid}/enrollments`,json('PUT',{course:e.course,enrolled:false}));await adminStudent(uid);})])));
    const courses=await api('/api/admin/courses');const grant=form(root,'Grant a course',async data=>{await api(`/api/admin/users/${uid}/enrollments`,json('PUT',{course:data.get('course'),enrolled:true}));await adminStudent(uid);});
    const select=node('select','form-input');select.name='course';select.required=true;select.setAttribute('aria-label','Course to grant');courses.courses.forEach(c=>select.add(new Option(c.title,c.id)));grant.append(select);submitButton(grant,'Grant course access');
    heading(root,'Lesson completion','Students report completion themselves. This is separate from assessment and lab performance.');root.append(table(['Lecture','Course','Completion','Updated'],r.lessons.map(l=>[l.title,l.course,l.completed?'Reported complete':'Incomplete',date(l.updated_at)])));
    heading(root,'Last opened lessons');root.append(table(['Lecture','Course','Opened'],r.recent_lessons.map(l=>[l.title,l.course,date(l.updated_at)])));
    heading(root,'Lesson activity','Cumulative visible lesson activity remains available after detailed sessions expire.');root.append(table(['Lecture','Course','Activity','Last recorded'],r.lesson_activity.map(l=>[l.title,l.course,minutes(l.activity_seconds),date(l.updated_at)])));
    heading(root,'Watch history','Browser-reported watch time and watched portion are separate from lesson-page activity and lesson completion.');root.append(table(['Lecture','Time watched','Resume','Watched','Last saved'],r.playback.map(l=>[l.title,minutes(l.playing_seconds),prettyTime(l.position),l.coverage_percent+'%',date(l.updated_at)])));
    heading(root,'Assessment results');root.append(table(['Topic','Score','Correct','Completed'],r.assessments.map(a=>[a.step_id,`${a.score}%`,`${a.correct_count}/${a.total_count}`,date(a.completed_at)])));
    heading(root,'Practice labs');root.append(table(['Lab','Status','Updated'],r.labs.map(l=>[l.slug,l.status,date(l.updated_at)])));
    heading(root,'Recall practice');root.append(table(['Self-rating (0–5)','Reviewed'],r.reviews.map(a=>[a.quality,date(a.reviewed_at)])));
    heading(root,'Study plans');root.append(table(['Date','Budget','Updated'],r.plans.map(a=>[a.study_date,`${a.budget_minutes}m`,date(a.updated_at)])));
    heading(root,'Focus sessions');root.append(table(['Title','Mode','Status','Configured duration'],r.focus.map(a=>[a.title,a.mode,a.status,minutes(a.duration_seconds)])));
    heading(root,'Devices and access');root.append(table(['Device','IP address','Last active','Expires'],r.sessions.map(s=>[s.device,s.ip,date(s.last_seen),date(s.expires_at)])));
    heading(root,'Learning history');root.append(table(['Activity','Lecture','Time'],r.activity.map(a=>[a.event_type.replaceAll('_',' '),a.title||a.details,date(a.created_at)])));
    heading(root,'Access history');root.append(table(['Event','IP','Device','Time'],r.access.map(a=>[a.event_type.replaceAll('_',' '),a.ip,a.device,date(a.created_at)])));
  }
  function uploadMaterialRequest(courseId,formData,onProgress){
    return new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();
      xhr.open('POST',`/api/admin/courses/${encodeURIComponent(courseId)}/materials`);
      if(account.csrf)xhr.setRequestHeader('X-CSRF-Token',account.csrf);
      xhr.upload.onprogress=e=>{if(e.lengthComputable&&onProgress)onProgress(Math.round((e.loaded/e.total)*100));};
      xhr.onload=()=>{
        let body={};try{body=JSON.parse(xhr.responseText||'{}');}catch{}
        if(xhr.status>=200&&xhr.status<300)resolve(body);
        else reject(new Error(typeof body.detail==='string'?body.detail:body.detail?.message||`Upload failed (${xhr.status})`));
      };
      xhr.onerror=()=>reject(new Error('Network error while uploading material.'));
      xhr.send(formData);
    });
  }
  async function openCourseInWorkspace(courseId){
    await workspace();
    const course=groupCourses().find(c=>c.name===courseId)||{name:courseId,videos:state.videos.filter(v=>v.course===courseId)};
    openCourse(course);
  }
  async function adminCourses(){
    const root=adminPage('Course management','courses');
    root.append(node('p','academy-lead','Manage all courses, publish or unpublish, edit course details, reorder lessons into sections, and attach or preview lesson materials.'));
    const controls=node('div','admin-course-controls toolbar');
    const searchInput=node('input','form-input');searchInput.type='search';searchInput.placeholder='Search courses by title, category, or instructor…';searchInput.setAttribute('aria-label','Search courses');
    const sortSelect=node('select','form-input');sortSelect.setAttribute('aria-label','Sort courses');
    for(const [label,val] of [['Sort: Recently updated','updated'],['Sort: Title A–Z','title'],['Sort: Most lessons','lessons'],['Sort: Most students','students'],['Sort: Most materials','materials'],['Sort: Publish status','status']])sortSelect.add(new Option(label,val));
    controls.append(searchInput,sortSelect,button('Refresh',adminCourses));
    root.append(controls);
    const tableSlot=node('div','admin-courses-table-slot');root.append(tableSlot);
    const result=await api('/api/admin/courses');
    let courses=result.courses||[];
    const renderTable=()=>{
      const q=searchInput.value.trim().toLowerCase();
      const sortBy=sortSelect.value;
      const filtered=courses.filter(c=>[c.id,c.title||'',c.category||'',c.instructor||'',c.description||''].some(v=>String(v).toLowerCase().includes(q)));
      filtered.sort((a,b)=>{
        if(sortBy==='title')return (a.title||a.id).localeCompare(b.title||b.id);
        if(sortBy==='lessons')return (b.lesson_count||0)-(a.lesson_count||0);
        if(sortBy==='students')return (b.enrolled_students||0)-(a.enrolled_students||0);
        if(sortBy==='materials')return (b.material_count||0)-(a.material_count||0);
        if(sortBy==='status')return Number(Boolean(b.published))-Number(Boolean(a.published));
        return String(b.updated_at||'').localeCompare(String(a.updated_at||''));
      });
      const rows=filtered.map(c=>{
        const titleCell=node('div','admin-course-title-cell');
        const drillBtn=node('button','text-link admin-course-drill',c.title||c.id);drillBtn.type='button';drillBtn.onclick=()=>adminCourseDetail(c.id);
        titleCell.append(drillBtn);
        if(c.instructor)titleCell.append(node('div','muted',`By ${c.instructor}`));
        const playableText=`${c.available_lessons||0} playable · ${c.pending_lessons??Math.max(0,(c.lesson_count||0)-(c.available_lessons||0))} pending`;
        const transcriptText=`${c.transcript_ready||0}/${c.lesson_count||0} (${c.transcript_percent??0}%)`;
        const statusBadge=node('span','tag',c.published?'Published':'Draft');
        const actions=node('div','admin-row-actions');
        actions.append(
          button('Manage lessons & files',()=>adminCourseDetail(c.id),true),
          button('Edit details',()=>openCourseEditor({...c,name:c.id})),
          button(c.published?'Unpublish':'Publish',async()=>{
            await api(`/api/admin/courses/${encodeURIComponent(c.id)}/publication`,json('PUT',{published:!c.published,description:c.description||''}));
            c.published=!c.published;message(`Course ${c.published?'published':'unpublished'}.`);renderTable();
          }),
          button('Open course',()=>openCourseInWorkspace(c.id))
        );
        return [
          titleCell,
          c.category||'General',
          String(c.lesson_count||0),
          playableText,
          transcriptText,
          `${c.material_count||0} files`,
          String(c.enrolled_students||0),
          statusBadge,
          date(c.updated_at),
          actions,
        ];
      });
      tableSlot.replaceChildren(table(['Course','Category','Lessons','Playable vs pending','Transcripts','Materials','Students','Status','Last updated','Actions'],rows));
    };
    searchInput.oninput=renderTable;sortSelect.onchange=renderTable;renderTable();

    const map=form(root,'Map an Odysee lecture',async data=>{await api(`/api/admin/videos/${encodeURIComponent(data.get('video_id'))}/provider`,json('PUT',{claim_name:data.get('claim_name'),claim_id:data.get('claim_id')}));message('Lecture mapping saved.');await adminCourses();});
    const videos=await api('/api/videos');const select=node('select','form-input');select.name='video_id';select.required=true;select.setAttribute('aria-label','Lecture to map');videos.videos.forEach(v=>select.add(new Option(`${v.course} / ${v.title}`,v.id)));map.append(select);
    field(map,'Odysee claim name','claim_name');const claim=field(map,'Odysee claim ID','claim_id');claim.pattern='[0-9a-fA-F]{40}';submitButton(map,'Save mapping');
  }
  async function adminCourseDetail(courseId){
    const detail=await api(`/api/admin/courses/${encodeURIComponent(courseId)}/detail`);
    const c=detail.course;
    const root=adminPage(c.title||courseId,'courses/'+encodeURIComponent(courseId));
    const topBar=node('div','toolbar');
    topBar.append(
      button('← Back to all courses',adminCourses),
      button('Edit metadata & cover',()=>openCourseEditor({...c,name:c.id})),
      button(c.published?'Unpublish course':'Publish course',async()=>{
        await api(`/api/admin/courses/${encodeURIComponent(courseId)}/publication`,json('PUT',{published:!c.published,description:c.description||''}));
        message(`Course ${!c.published?'published':'unpublished'}.`);await adminCourseDetail(courseId);
      },!c.published),
      button('Open in learner view',()=>openCourseInWorkspace(courseId))
    );
    root.append(topBar);
    root.append(node('p','muted',`Course ID: ${c.id} · Category: ${c.category||'General'} · ${c.lesson_count} lessons · ${c.available_lessons} playable (${c.pending_lessons} pending) · ${c.transcript_ready}/${c.lesson_count} transcripts · ${c.material_count} materials · ${c.enrolled_students} enrolled students`));

    const pubForm=form(root,'Publication & description',async data=>{
      await api(`/api/admin/courses/${encodeURIComponent(courseId)}/publication`,json('PUT',{published:data.get('published')==='on',description:data.get('description')}));
      message('Course publication updated.');await adminCourseDetail(courseId);
    });
    const descLabel=node('label','field');descLabel.append(node('span','','Course description'));
    const descInput=node('textarea','form-input');descInput.name='description';descInput.maxLength=5000;descInput.rows=3;descInput.value=c.description||'';
    descLabel.append(descInput);pubForm.append(descLabel);
    const pubToggle=node('label');const pubCheck=node('input');pubCheck.name='published';pubCheck.type='checkbox';pubCheck.checked=Boolean(c.published);
    pubToggle.append(pubCheck,document.createTextNode(' Published in public catalog'));pubForm.append(pubToggle);
    submitButton(pubForm,'Save publication');

    const previewBox=node('div','panel admin-material-preview');previewBox.hidden=true;root.append(previewBox);
    const showPreview=mat=>{
      previewBox.hidden=false;previewBox.replaceChildren();
      const head=node('div','toolbar');
      head.append(node('strong','',`Preview before publish: ${mat.friendly_name||mat.name} (${mat.material_type||'File'} · ${mat.size_kb} KB)`));
      const dl=node('a','btn btn-outline','Download');dl.href=mat.download_url||(mat.url+'?download=1');dl.setAttribute('download','');
      const close=button('Close preview',()=>{previewBox.hidden=true;previewBox.replaceChildren();});
      head.append(dl,close);
      const frame=node('iframe','admin-preview-iframe');frame.title=mat.friendly_name||mat.name;frame.src=mat.url;
      frame.style.cssText='width:100%;min-height:460px;border:1px solid var(--line);border-radius:8px;margin-top:12px;background:#0f1420';
      previewBox.append(head,frame);
      previewBox.scrollIntoView({behavior:'smooth',block:'nearest'});
    };

    let orderedLessons=[...(detail.lessons||[])];
    const datalistId='sections-list-'+courseId.replace(/\W+/g,'_');
    const datalist=node('datalist');datalist.id=datalistId;
    (detail.sections||[]).forEach(s=>datalist.append(new Option(s,s)));
    root.append(datalist);

    heading(root,'Upload or replace course material','Attach notebooks, PDFs, slides, datasets, or code files to a specific lesson, or share an archive at the section level.');
    const uploadPanel=node('form','academy-form panel');
    const fileField=node('label','field');fileField.append(node('span','','Choose file'));
    const fileInput=node('input','form-input');fileInput.type='file';fileInput.name='file';fileInput.required=true;fileField.append(fileInput);
    const friendlyField=node('label','field');friendlyField.append(node('span','','Friendly display name (optional)'));
    const friendlyInput=node('input','form-input');friendlyInput.name='friendly_name';friendlyInput.maxLength=200;friendlyInput.placeholder='e.g. Session 01 — Linux Fundamentals Notes';friendlyField.append(friendlyInput);
    const typeField=node('label','field');typeField.append(node('span','','Material type'));
    const typeSelect=node('select','form-input');typeSelect.name='material_type';
    for(const [label,val] of [['Auto-detect from file extension',''],['Notebook','Notebook'],['PDF','PDF'],['Slides','Slides'],['Dataset','Dataset'],['Code','Code'],['Archive','Archive'],['Notes','Notes']])typeSelect.add(new Option(label,val));
    typeField.append(typeSelect);
    const scopeField=node('label','field');scopeField.append(node('span','','Placement scope'));
    const scopeSelect=node('select','form-input');scopeSelect.name='scope';
    scopeSelect.add(new Option('Lesson material (belongs to one lesson)','lesson'));
    scopeSelect.add(new Option('Section shared file (shown at section level in sidebar)','section'));
    scopeField.append(scopeSelect);
    const lessonField=node('label','field');lessonField.append(node('span','','Target lesson'));
    const lessonSelect=node('select','form-input');lessonSelect.name='lesson_id';
    lessonSelect.add(new Option('Auto-match or select lesson…',''));
    orderedLessons.forEach((l,i)=>lessonSelect.add(new Option(`${String(i+1).padStart(2,'0')}. ${l.title}`,l.id)));
    lessonField.append(lessonSelect);
    const secField=node('label','field');secField.append(node('span','','Target section (for section-level shared files)'));
    const secInput=node('input','form-input');secInput.name='section_title';secInput.setAttribute('list',datalistId);secInput.placeholder=(detail.sections?.[0])||'Module 1 — Course Foundations';
    secField.append(secInput);
    const replaceInput=node('input');replaceInput.type='hidden';replaceInput.name='replace_filename';
    const progressWrap=node('div','upload-progress-wrap');progressWrap.hidden=true;
    const progressBar=node('progress','upload-progress-bar');progressBar.max=100;progressBar.value=0;
    const progressText=node('span','muted','0%');
    progressWrap.append(progressBar,progressText);
    const uploadSubmit=node('button','btn btn-primary','Upload & attach file');uploadSubmit.type='submit';
    uploadPanel.append(fileField,friendlyField,typeField,scopeField,lessonField,secField,replaceInput,progressWrap,uploadSubmit);
    uploadPanel.onsubmit=async e=>{
      e.preventDefault();
      const f=fileInput.files[0];if(!f)return message('Select a file to upload.',true);
      uploadSubmit.disabled=true;progressWrap.hidden=false;progressBar.value=0;progressText.textContent='Uploading 0%…';
      try{
        const fd=new FormData();
        fd.append('file',f);
        fd.append('friendly_name',friendlyInput.value.trim());
        fd.append('material_type',typeSelect.value);
        fd.append('scope',scopeSelect.value);
        fd.append('lesson_id',lessonSelect.value);
        fd.append('section_title',secInput.value.trim());
        fd.append('replace_filename',replaceInput.value);
        const res=await uploadMaterialRequest(courseId,fd,pct=>{progressBar.value=pct;progressText.textContent=`Uploading ${pct}%…`;});
        progressBar.value=100;progressText.textContent='Upload complete (100%)';
        message(`Material “${res.material?.friendly_name||f.name}” saved. Click Preview to inspect before publishing.`);
        await loadLibrary().catch(()=>{});
        await adminCourseDetail(courseId);
      }catch(err){message(err.message,true);}
      finally{uploadSubmit.disabled=false;}
    };
    root.append(uploadPanel);

    heading(root,'Lessons & sections organization','Reorder lessons or organize them into named sections. Existing course and lecture IDs never change, and material-to-lesson assignments are preserved.');
    const saveOrgBar=node('div','toolbar');
    const saveOrgBtn=button('Save lesson order & sections',async()=>{
      const payload={lessons:orderedLessons.map((l,idx)=>({video_id:l.id,section_title:l.section||'Module 1 — Course Foundations',position:idx+1}))};
      await api(`/api/admin/courses/${encodeURIComponent(courseId)}/organization`,json('PUT',payload));
      await loadLibrary().catch(()=>{});
      message('Lesson order and sections saved. Lecture IDs and material assignments were preserved.');
      await adminCourseDetail(courseId);
    },true);
    saveOrgBar.append(saveOrgBtn);root.append(saveOrgBar);

    const lessonsContainer=node('div','admin-lessons-organizer');root.append(lessonsContainer);
    const renderOrganizer=()=>{
      lessonsContainer.replaceChildren();
      const rows=orderedLessons.map((l,idx)=>{
        const orderCell=node('div','admin-order-controls');
        const upBtn=button('↑',()=>{if(idx===0)return;[orderedLessons[idx-1],orderedLessons[idx]]=[orderedLessons[idx],orderedLessons[idx-1]];renderOrganizer();});
        upBtn.disabled=idx===0;upBtn.setAttribute('aria-label',`Move ${l.title} up`);
        const downBtn=button('↓',()=>{if(idx>=orderedLessons.length-1)return;[orderedLessons[idx+1],orderedLessons[idx]]=[orderedLessons[idx],orderedLessons[idx+1]];renderOrganizer();});
        downBtn.disabled=idx>=orderedLessons.length-1;downBtn.setAttribute('aria-label',`Move ${l.title} down`);
        orderCell.append(node('strong','',String(idx+1).padStart(2,'0')),upBtn,downBtn);

        const lessonInfo=node('div','admin-lesson-info');
        lessonInfo.append(node('strong','',l.title),node('div','muted',`Lecture ID: ${l.id} · ${l.available?'Playable':'Pending mapping'} · ${l.transcript_ready?'Transcript ready':'No transcript'}`));

        const secCell=node('div','admin-section-cell');
        const secFieldInput=node('input','form-input');secFieldInput.value=l.section||'';secFieldInput.setAttribute('list',datalistId);
        secFieldInput.setAttribute('aria-label',`Section for ${l.title}`);
        secFieldInput.oninput=()=>{l.section=secFieldInput.value.trim();};
        secCell.append(secFieldInput);

        const matCell=node('div','admin-lesson-materials');
        const mats=l.materials||[];
        if(!mats.length)matCell.append(node('span','muted','No files attached'));
        for(const m of mats){
          const chip=node('div','admin-mat-chip');
          chip.append(node('span','',`${m.friendly_name||m.name} (${m.material_type} · ${m.size_kb} KB)`));
          const pBtn=button('Preview',()=>showPreview(m));
          const repBtn=button('Replace',()=>{
            replaceInput.value=m.name;friendlyInput.value=m.friendly_name||m.name;typeSelect.value=m.material_type||'';
            scopeSelect.value='lesson';lessonSelect.value=l.id;fileInput.click();
            uploadPanel.scrollIntoView({behavior:'smooth',block:'center'});
          });
          const delBtn=button('Remove',async()=>{
            await api(`/api/admin/courses/${encodeURIComponent(courseId)}/materials/${encodeURIComponent(m.name)}`,{method:'DELETE'});
            await loadLibrary().catch(()=>{});message(`Removed ${m.friendly_name||m.name}.`);await adminCourseDetail(courseId);
          });
          chip.append(pBtn,repBtn,delBtn);matCell.append(chip);
        }
        const attachBtn=button('+ Attach file',()=>{
          replaceInput.value='';friendlyInput.value='';scopeSelect.value='lesson';lessonSelect.value=l.id;
          fileInput.click();uploadPanel.scrollIntoView({behavior:'smooth',block:'center'});
        });
        matCell.append(attachBtn);
        return [orderCell,lessonInfo,secCell,matCell];
      });
      lessonsContainer.append(table(['Order','Lesson & immutable ID','Section / Module','Attached lesson materials'],rows));
    };
    renderOrganizer();

    const sectionFiles=(detail.materials||[]).filter(m=>m.scope==='section');
    heading(root,'Section-level shared files','Archives and reference files shared across an entire section in the sidebar.');
    root.append(table(['Friendly name','Type','Section','Size','Actions'],sectionFiles.map(m=>[
      m.friendly_name||m.name,
      m.material_type||'Archive',
      m.section||'Course section',
      `${m.size_kb} KB`,
      (()=>{
        const act=node('div','toolbar');
        act.append(
          button('Preview',()=>showPreview(m)),
          button('Replace',()=>{replaceInput.value=m.name;friendlyInput.value=m.friendly_name||m.name;scopeSelect.value='section';secInput.value=m.section||'';fileInput.click();uploadPanel.scrollIntoView({behavior:'smooth'});}),
          button('Remove',async()=>{await api(`/api/admin/courses/${encodeURIComponent(courseId)}/materials/${encodeURIComponent(m.name)}`,{method:'DELETE'});await loadLibrary().catch(()=>{});message('Removed section file.');await adminCourseDetail(courseId);})
        );
        return act;
      })()
    ])));

    try{
      const qRes = await api(`/api/admin/courses/${encodeURIComponent(courseId)}/quizzes`);
      if(qRes.quizzes && qRes.quizzes.length){
        heading(root,'Lesson mastery quizzes & review flashcards','Admin review, approval, and regeneration of auto-generated quizzes from transcripts.');
        root.append(table(['Lesson','Status','Questions','Attempts','Pass rate','Actions'],qRes.quizzes.map(q=>[
          q.lesson_title,
          q.status||'Approved',
          `${q.question_count} questions`,
          q.attempts,
          `${q.pass_rate}%`,
          (()=>{
            const act=node('div','toolbar');
            act.append(
              button('Regenerate',async()=>{
                await api(`/api/admin/videos/${encodeURIComponent(q.video_id)}/quiz/regenerate`,{method:'POST'});
                message(`Regenerated quiz for “${q.lesson_title}”.`);
                await adminCourseDetail(courseId);
              })
            );
            return act;
          })()
        ])));
      }
    }catch(err){}
  }
  function selectField(f,label,name,choices,value){
    const l=node('label','field');l.append(node('span','',label));const s=node('select','form-input');s.name=name;for(const [text,id] of choices)s.add(new Option(text,id));s.value=value;l.append(s);f.append(l);return s;
  }
  async function adminPlayer(filters={},offset=0){
    const root=adminPage('Player activity','player');
    root.append(node('p','academy-lead','Inspect lesson sessions, visible activity, devices, and access. Live means a lesson page is sending heartbeats; it does not establish that the video is playing.'));
    const criteria={days:'30',q:'',course:'',status:'all',...filters};
    const playback=await api('/api/admin/playback?'+new URLSearchParams({...criteria,offset}));
    heading(root,'Video playback',playback.basis);
    root.append(table(['Student','Lecture','State','Playback time','Position','Opened','Device and IP'],playback.sessions.map(s=>[button(s.name,()=>adminStudent(s.user_id)),s.title,s.live?'Playing':s.state,minutes(s.playing_seconds),prettyTime(s.position),date(s.created_at),[s.device,s.ip].join(' · ')])));
    const playbackPager=node('div','toolbar');if(offset)playbackPager.append(button('Previous playback sessions',()=>adminPlayer(criteria,Math.max(0,offset-25))));if(offset+25<playback.total)playbackPager.append(button('Next playback sessions',()=>adminPlayer(criteria,offset+25)));root.append(playbackPager);
    const playbackExport=node('a','btn btn-outline','Export playback CSV');playbackExport.href='/api/admin/playback/export?'+new URLSearchParams(criteria);playbackExport.download='courseforge-playback.csv';root.append(playbackExport);
    const f=form(root,'Filter sessions',data=>adminPlayer(Object.fromEntries(data)));
    field(f,'Student name, email, or lecture','q','search',false).value=criteria.q;
    selectField(f,'Period','days',[['Last 7 days','7'],['Last 30 days','30'],['Last 90 days','90']],criteria.days);
    const courses=await api('/api/admin/courses');
    selectField(f,'Course','course',[['All courses',''],...courses.courses.map(c=>[c.title,c.id])],criteria.course);
    selectField(f,'Session status','status',[['All sessions','all'],['Live lesson pages','live']],criteria.status);submitButton(f,'Apply filters');
    const query=new URLSearchParams(criteria),report=await api('/api/admin/player-activity?'+query+'&offset='+offset);
    const bar=node('div','toolbar');bar.append(button('Refresh',()=>adminPlayer(criteria,offset)));
    const download=node('a','btn btn-outline','Export CSV');download.href='/api/admin/player-activity/export?'+query;download.download='courseforge-lesson-activity.csv';bar.append(download);root.append(bar);
    root.append(node('p','muted',`${report.total} sessions · ${report.summary.learners} learners · ${minutes(report.summary.activity_seconds)} activity · ${report.period}. Updated ${new Date().toLocaleTimeString()}.`));
    root.append(table(['Student','Lecture','Status','Activity','Opened','Last heartbeat','Device and IP'],report.sessions.map(s=>{
      const student=button(s.name,()=>adminStudent(s.user_id));student.title=s.email;
      return [student,s.title,s.live?'Live lesson page':'Inactive',minutes(s.activity_seconds),date(s.created_at),date(s.last_active),[s.device||'Not recorded',s.ip||'Not recorded'].join(' · ')];
    })));
    const pager=node('div','toolbar');if(offset)pager.append(button('Previous',()=>adminPlayer(criteria,Math.max(0,offset-25))));if(offset+25<report.total)pager.append(button('Next',()=>adminPlayer(criteria,offset+25)));root.append(pager);
  }
  async function adminSystem(){
    const root=adminPage('System and administrator audit','system'),r=await api('/api/admin/system');
    heading(root,'Account delivery');
    root.append(node('p','',`${r.email.provider} email: ${r.email.configured?'Configured':'Awaiting server credentials'}. ${r.pending_invitations} pending invitations.`));
    root.append(node('p','',`Public registration: ${r.registration.registration_enabled?(r.registration.registration_mode==='open'?'Immediate student access':'Email verification required'):'Administrator invitations'}.`));
    if(!r.email.configured)root.append(node('p','muted','Set SMTP_FROM, SMTP_USER, and SMTP_PASSWORD in the server environment, then restart CourseForge. Student activation and recovery links can be issued in Students.'));
    heading(root,'Course readiness');root.append(table(['Course','Publication','Lectures','Cloud mappings','Measured durations'],r.courses.map(c=>[c.course,c.published?'Published':'Draft',c.lessons,c.mapped,c.measured_durations])));
    heading(root,'Player capabilities');root.append(node('p','',`Odysee authorization: ${r.provider_configured?'Configured':'Missing credentials'}. Automatic resume: ${r.player.automatic_resume?'Supported':'Unavailable'}.`),node('p','muted','The CourseForge player supports seeking, speed, volume, fullscreen, timestamp capture, automatic resume, and automatic watch history. Original video quality is delivered by Odysee. The embedded fallback supports manual resume points and visible lesson activity. Authenticated streaming and the viewer watermark provide access control and deterrence; they are not encrypted DRM.'));
    root.append(button('Refresh Odysee mappings',async()=>{const result=await api('/api/admin/provider-sync',json('POST',{}));await adminSystem();message(result.in_progress?'A mapping refresh is already running.':result.error||`${result.mapped}/${result.lectures} lectures mapped. ${result.durations_added} durations added.`,Boolean(result.error));}));
    heading(root,'Service reports');root.append(table(['Service','Last report','Last successful report','Status'],Object.entries(r.service_checks).map(([name,s])=>[name.replaceAll('_',' '),date(s.last_attempt),date(s.last_success),s.last_error||s.summary.state||(s.summary.mapped!==undefined?`${s.summary.mapped}/${s.summary.lectures} mapped`:'Reported')])));
    heading(root,'Learning task queue');root.append(table(['Status','Tasks'],Object.entries(r.tasks)));
    heading(root,'Administrator audit','Records account invitations, access changes, course publishing, provider mapping, and report exports. Logs retain 90 days; private activation links and passwords are excluded.');root.append(table(['Administrator','Action','Resource','Time'],r.audit.map(a=>[a.actor||'Deleted administrator',a.action,a.resource,date(a.created_at)])));
    root.append(button('Refresh status',adminSystem));
  }
  async function materials(course){
    const root=el('resourcesDialog');root.replaceChildren(node('h2','','Course materials'),button('Close',()=>root.close()));root.showModal();
    try{const data=await api('/api/materials'+(course?'?course='+encodeURIComponent(course):''));
      root.append(node('p','muted',`${data.total} study files ready to open or download`));
      root.append(table(['#','Course','Material','Type','Size','Actions'],data.materials.map((m,i)=>{
        const act=node('div','toolbar');
        const openInPlayer=button('Open in browser',()=>{root.close();window.openFlowItem?.(m);});
        const dl=node('a','btn btn-outline','Download');dl.href=m.download_url||(m.url+'?download=1');dl.setAttribute('download','');
        act.append(openInPlayer,dl);
        return [String(i+1).padStart(2,'0'),m.course,m.friendly_name||m.name,m.material_type||m.ext,`${m.size_kb} KB`,act];
      })));}
    catch(error){root.append(node('p','field-error',error.message));}
  }
  let activity=null;
  function stopActivity(){
    const a=activity;activity=null;if(!a)return;
    const visible=a.visible&&document.visibilityState==='visible';
    const elapsed=visible?Math.min(20,(performance.now()-a.last)/1000):0;
    fetch(`/api/activity/${a.id}/heartbeat`,{method:'POST',keepalive:true,credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':account.csrf},body:JSON.stringify({sequence:++a.sequence,visible,elapsed_seconds:elapsed,ended:true})}).catch(()=>{});
  }
  function leaveLesson(){
    window.CourseForgeStudio?.cancelNext();window.CourseForgeNative?.stop();window.CourseForgePlayerSession?.close();
    stopActivity();window.CourseForgeCancelVideoOpen?.();el('lecturePlayerWrap')?.replaceChildren();
  }
  async function startActivity(id,current=true){
    const eligible=()=>typeof current==='function'?current():current;
    if(!eligible())return;const r=await api(`/api/videos/${id}/activity-session`,json('POST',{player_session_id:window.CourseForgePlayerSession?.current()||null}));
    if(!eligible()||state.currentVideoId!==id||el('appShell').hidden||state.view!=='learning')return;
    activity={id:r.id,sequence:0,last:performance.now(),visible:document.visibilityState==='visible',pending:false};
  }
  async function heartbeat(){
    const a=activity;if(!a||a.pending)return;
    const now=performance.now(),visible=document.visibilityState==='visible'&&!el('appShell').hidden&&state.view==='learning';
    const elapsed=a.visible&&visible?Math.min(20,(now-a.last)/1000):0;a.last=now;a.visible=visible;a.pending=true;
    try{const r=await api(`/api/activity/${a.id}/heartbeat`,json('POST',{sequence:++a.sequence,visible,elapsed_seconds:elapsed}));
      if(activity===a&&el('lessonActivityTimer'))el('lessonActivityTimer').textContent='Lesson activity: '+minutes(r.activity_seconds);}
    catch(error){if(error.status===401||error.status===403||error.status===404)leaveLesson();}
    finally{a.pending=false;}
  }
  setInterval(heartbeat,15000);document.addEventListener('visibilitychange',heartbeat);
  window.addEventListener('pagehide',leaveLesson);
  function parseTimestamp(value){
    if(!/^\d+(?::[0-5]\d){0,2}$/.test(value.trim()))throw new Error('Use seconds, MM:SS, or HH:MM:SS for the timestamp.');
    const seconds=value.trim().split(':').reduce((sum,part)=>sum*60+Number(part),0);if(seconds>=1e9)throw new Error('Timestamp is too large.');return seconds;
  }
  async function loadBookmarks(id){
    const data=await api(`/api/videos/${id}/bookmarks`);if(id!==state.currentVideoId)return;
    const list=el('bookmarksList');list.replaceChildren();
    for(const b of data.bookmarks){const row=node('div','saved-note');row.append(button(`${prettyTime(b.position)} · ${b.label}`,()=>openVideo(id,b.position)),button('Delete',async()=>{await api(`/api/bookmarks/${b.id}`,{method:'DELETE'});await loadBookmarks(id);}));list.append(row);}
    if(!data.bookmarks.length)list.append(node('p','muted','No bookmarks for this lecture yet.'));
  }
  el('bookmarkForm').onsubmit=async e=>{e.preventDefault();if(!state.currentVideoId)return;try{await api(`/api/videos/${state.currentVideoId}/bookmarks`,json('POST',{position:parseTimestamp(el('bookmarkPosition').value),label:el('bookmarkLabel').value}));await loadBookmarks(state.currentVideoId);el('bookmarkLabel').value='';}catch(error){toast(error.message,true);}};
  el('lessonSearch').oninput=e=>{
    const query=e.target.value.toLowerCase();
    document.querySelectorAll('.lesson-link').forEach(link=>{link.hidden=!link.textContent.toLowerCase().includes(query);});
    document.querySelectorAll('.lesson-section').forEach(sec=>{
      const anyVisible=[...sec.querySelectorAll('.lesson-link')].some(l=>!l.hidden);
      sec.hidden=Boolean(query)&&!anyVisible;
      if(query&&anyVisible)sec.open=true;
    });
  };
  el('previousLessonBtn').onclick=()=>{
    const previous=window.CourseForgeStudio?.adjacent(-1);
    if(previous)openVideo(previous.id).catch(error=>toast(error.message,true));
    else toast('You are at the first lesson in this course.');
  };
  window.CourseForgeAcademy={materials,stopActivity,leaveLesson,startActivity,loadBookmarks,parseTimestamp,workspace,adminCourses,adminCourseDetail};
  window.addEventListener('courseforge-session-expired',()=>{account.user=null;account.csrf='';resetBrowser();});
  window.addEventListener('courseforge-task',()=>toast('Learning task queued. This view will update when it finishes.'));
  el('catalogNav').onclick=()=>catalog().catch(e=>message(e.message,true));el('learningNav').onclick=()=>workspace().catch(e=>message(e.message,true));
  el('accountNav').onclick=()=>myAccount().catch(e=>message(e.message,true));el('adminNav').onclick=()=>adminHome().catch(e=>message(e.message,true));
  el('signinNav').onclick=()=>signIn();el('registerNav').onclick=()=>signIn('register');el('logoutNav').onclick=async()=>{try{await api('/api/auth/logout',json('POST',{}));resetBrowser();}catch(error){message(error.message,true);}};
  async function boot(){
    try{const r=await api('/api/me/bootstrap');account.user=r.user;account.csrf=r.csrf_token;account.bootstrap=r;}
    catch(error){if(error.status===403){const r=await api('/api/me');account.user=r.user;account.csrf=r.csrf_token;}else if(error.status!==401)message(error.message,true);}
    for(const id of ['learningNav','accountNav','logoutNav'])el(id).hidden=!account.user;
    el('jobSummary').hidden=account.user?.role!=='admin';el('signinNav').hidden=Boolean(account.user);el('adminNav').hidden=account.user?.role!=='admin';
    const options=account.bootstrap?.options||await api('/api/public/account-options');el('registerNav').hidden=Boolean(account.user)||!options.registration_enabled;
    el('accountName').textContent=account.user?.name||'';
    document.querySelectorAll('#scanBtn,#scanBtnSide,#scanBtnLibrary,#emptyScanBtn,#reindexBtn,#buildSyllabusBtn,.sidebar-import,[data-action="edit-course"]').forEach(n=>n.hidden=account.user?.role!=='admin');
    const fragment=location.hash.slice(1).split('?'),params=new URLSearchParams(location.search);
    const fragmentParams=new URLSearchParams(fragment[1]||''),action=fragmentParams.has('token')?fragment[0]:params.get('action'),token=fragmentParams.get('token')||params.get('token');
    if(token)history.replaceState(null,'','/');
    if(token&&action==='verify'){
      const r=await api('/api/auth/verify',json('POST',{token}));history.replaceState(null,'','/');signIn();message(r.message);return;
    }
    if(token&&(action==='reset'||action==='activate')){
      const root=page(action==='activate'?'Activate your account':'Choose a new password');
      if(action==='activate')root.append(node('p','muted','Your administrator invited you to CourseForge. Choose a password with at least 6 characters.'));
      const f=form(root,'',async data=>{const r=await api('/api/auth/'+action,json('POST',{token,password:data.get('password')}));history.replaceState(null,'','/');signIn();message(r.message);});field(f,'New password','password','password').minLength=6;submitButton(f,action==='activate'?'Activate account':'Reset password');return;
    }
    const adminRoute=location.hash.match(/^#admin(?:\/(.*))?$/);
    const h=location.hash;
    if(h==='#register'&&!account.user)signIn('register');
    else if(h==='#courses'||h==='#/browse'||h==='#browse'||h.startsWith('#/course/')||h.startsWith('#course/')) {
      if(!account.user)await catalog();else await workspace();
    }
    else if(adminRoute&&!account.user)signIn();
    else if(adminRoute&&account.user?.role==='admin'){
      const route=adminRoute[1]||'';
      if(route.startsWith('students/'))await adminStudent(decodeURIComponent(route.slice(9)));
      else if(route.startsWith('courses/'))await adminCourseDetail(decodeURIComponent(route.slice(8)));
      else await ({students:adminUsers,courses:adminCourses,player:adminPlayer,system:adminSystem}[route]||adminHome)();
    }
    else if(account.user?.verified)await workspace();else await catalog();
  }
  boot().catch(error=>{page('CourseForge');message(error.message,true);});
})();

/* mobile.js */
'use strict';
(() => {
  const nav=document.createElement('nav');nav.className='mobile-tabs';nav.setAttribute('aria-label','Learning navigation');nav.hidden=true;
  for(const [label,view,glyph]of [['Home','dashboard','grid'],['Library','library','book'],['Today','planner','clock'],['Tutor','tutor','spark'],['Review','reviews','cards']]){
    const b=make('button','mobile-tab',label);b.type='button';b.dataset.mobileView=view;b.prepend(icon(glyph));
    b.onclick=async()=>{if(document.getElementById('appShell').hidden)await window.CourseForgeAcademy.workspace();navigate(view);};nav.append(b);
  }
  const next=make('button','mobile-next btn btn-primary','Next lesson');next.type='button';next.hidden=true;
  next.onclick=()=>document.getElementById('nextLessonBtn').click();
  next.append(icon('arrow'));
  document.body.append(next,nav);
  function sync(){
    const isFullscreen=Boolean(document.fullscreenElement);
    nav.hidden=!window.CourseForgeAccount?.user?.verified||isFullscreen;
    const learning=document.body.classList.contains('in-learning');
    next.hidden=!learning||!state.currentVideoId||isFullscreen;
    next.disabled=Boolean(document.getElementById('nextLessonBtn')?.disabled);
    for(const b of nav.children){
      const selected=b.dataset.mobileView===state.view&&!document.getElementById('appShell').hidden;
      b.classList.toggle('active',selected);
      selected?b.setAttribute('aria-current','page'):b.removeAttribute('aria-current');
    }
  }
  const observer=new MutationObserver(sync);observer.observe(document.body,{attributes:true,attributeFilter:['class']});
  observer.observe(document.getElementById('appShell'),{attributes:true,attributeFilter:['hidden']});
  observer.observe(document.getElementById('nextLessonBtn'),{attributes:true,attributeFilter:['disabled']});
  window.addEventListener('courseforge-ready',sync);window.addEventListener('courseforge-navigate',sync);
  document.addEventListener('fullscreenchange',sync);
  // An edge swipe goes back without capturing controls, writing, or scrolling.
  let start=null;
  document.addEventListener('pointerdown',e=>{
    const isTouch=e.pointerType==='touch'||(e.pointerType==='mouse'&&window.__courseforge_test_swipe);
    start=isTouch&&e.isPrimary&&e.clientX<=36&&document.body.classList.contains('in-learning')&&!e.target.closest('button,a,input,textarea,select,video,media-controller,media-time-range')?{x:e.clientX,y:e.clientY,t:performance.now()}:null;
  },{passive:true});
  document.addEventListener('pointercancel',()=>start=null,{passive:true});
  document.addEventListener('pointerup',e=>{const s=start;start=null;if(s&&e.clientX-s.x>=70&&Math.abs(e.clientY-s.y)<50&&performance.now()-s.t<700&&!document.fullscreenElement)navigate('library');},{passive:true});
  function keyboard(){const v=window.visualViewport;document.body.classList.toggle('phone-keyboard',Boolean(v&&innerHeight-v.height>150&&document.activeElement?.matches('input,textarea')));}
  window.visualViewport?.addEventListener('resize',keyboard);document.addEventListener('focusout',()=>setTimeout(keyboard,0));
})();
