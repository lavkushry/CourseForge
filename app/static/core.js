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
  window.CourseForgeServices = Object.freeze({beginFocus,focusAction,activeFocus,focusHistory,focusAnalytics,weekPreferences,saveWeekPreferences,weeklyCalendar,generateWeeklyCalendar,savePlannerActual,plannerPreferences,savePlannerPreferences,plannerDay,generatePlannerDay,setPlannerItem,practiceRecommendations,practiceHistory,startRecommendedPractice,startAssessment,submitAssessment,assessmentHistory,learningPaths,learningPath,createLearningPath,completeLearningStep,request, json, videos, progress, insights, notes, saveNote, deleteNote, courses, updateCourse, uploadCover, resetCover});
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
const navNames={planner:'Today',dashboard:'Dashboard',library:'Library',learning:'Learning',tutor:'AI Tutor',syllabus:'Study paths',reviews:'Review',labs:'Labs',settings:'Settings'};
function navigate(view, focusHeading=false){if(!navNames[view])view='dashboard';state.view=view;$$('[data-view]').forEach(el=>el.hidden=el.dataset.view!==view);$$('.nav-item').forEach(el=>{const selected=el.dataset.nav===view;el.classList.toggle('active',selected);if(selected)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});$('#topbarLocation').textContent=navNames[view];window.dispatchEvent(new Event('courseforge-navigate'));closeMobileMenu(false);document.body.classList.toggle('in-learning',view==='learning');if(!applyingRoute){const hash=view==='learning'&&state.currentVideoId?lessonHash(state.currentVideoId):'#'+view;if(location.hash!==hash)history.pushState(null,'',hash);}window.scrollTo({top:0,behavior:'instant'});if(focusHeading){const heading=$(`[data-view="${view}"] h1`);if(heading){heading.setAttribute('tabindex','-1');heading.focus({preventScroll:true})}}if(view!=='learning')window.CourseForgeAcademy?.leaveLesson();else if(state.currentVideoId&&!document.querySelector('#lecturePlayerWrap iframe, #lecturePlayerWrap video, #lecturePlayerWrap .player-loading, #lecturePlayerWrap .player-unavailable'))openVideo(state.currentVideoId).catch(err=>toast(err.message,true));if(view==='syllabus')loadSyllabus().catch(err=>toast(err.message,true));if(view==='reviews')loadDue().catch(err=>toast(err.message,true));if(view==='labs')loadLabs().catch(err=>toast(err.message,true));}
$$('[data-nav]').forEach(el=>el.addEventListener('click',event=>{if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();navigate(el.dataset.nav,true);}));
let applyingRoute=0;
function readLessonRoute(){const [path,query='']=location.hash.slice(1).split('?');const [view,id]=path.split('/');const params=new URLSearchParams(query);let decoded=null;try{decoded=id?decodeURIComponent(id):null;}catch{}return {view,id:decoded,at:params.has('t')?Math.max(0,Number(params.get('t'))||0):null,tab:params.get('tab')||'lessons'};}
function lessonHash(id,at=null){const params=new URLSearchParams();if(at!==null)params.set('t',Math.floor(at));const tab=state.studyTab||'lessons';if(tab&&tab!=='lessons')params.set('tab',tab);return '#learning/'+encodeURIComponent(id)+(params.size?'?'+params:'');}
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
document.addEventListener('click',event=>{if(!$('#themePopover').hidden&&!$('#themePopover').contains(event.target)&&!$('#themeBtn').contains(event.target))closeTheme();if(!$('#notifyPopover').hidden&&!$('#notifyPopover').contains(event.target)&&!$('#notifyBtn').contains(event.target))closeNotify();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){if(!$('#themePopover').hidden){closeTheme();$('#themeBtn').focus();}if(!$('#notifyPopover').hidden){closeNotify();$('#notifyBtn').focus();}closeMobileMenu(true);}if(event.key==='/'&&!['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)&&!event.ctrlKey&&!event.metaKey){event.preventDefault();$('#globalSearch').focus();}});
loadTheme();
$('#todayLabel').textContent=new Intl.DateTimeFormat(undefined,{month:'long',day:'numeric',year:'numeric'}).format(new Date());
const colorways=[['#493eb8','#9285ed','{ }','ENGINEERING'],['#06685f','#4bd4ac','<>','DEVELOPMENT'],['#d66c39','#f7c68a','01','DATA'],['#305b92','#72aff8','⌘','TECHNOLOGY'],['#903b81','#e39ad2','','CREATIVE'],['#414c70','#8797cc','//','COURSE']];
function coverFor(course){let hash=0;for(const c of course)hash=((hash*31)+c.charCodeAt(0))>>>0;const lower=course.toLowerCase();let index=hash%colorways.length;if(/kubernetes|ansible|docker|devops|cloud|linux/i.test(lower))index=0;if(/java|python|javascript|backend|go\b|program/i.test(lower))index=1;if(/data|sql|spark|databricks|analytics|machine learning/i.test(lower))index=2;return colorways[index];}
function groupCourses(){const groups=new Map();for(const video of state.videos){if(!groups.has(video.course))groups.set(video.course,[]);groups.get(video.course).push(video);}return [...groups].map(([name,videos])=>{const completed=videos.filter(v=>state.progress.get(v.id)?.completed).length;const percent=Math.round(completed/videos.length*100);const indexed=videos.filter(v=>v.status==='done').length;const lastActivity=Math.max(...videos.map(v=>Date.parse(state.progress.get(v.id)?.updated_at||'')||0),0);return {name,videos,completed,percent,indexed,lastActivity,...(state.courseMeta.get(name)||{})};}).sort((a,b)=>b.lastActivity-a.lastActivity||a.name.localeCompare(b.name));}
function lessonTitle(title){return String(title||'').replace(/^\[\d+(?: Part\d+)?\]\s*/, '').replace(/\s*(?:\[Live\]|\(Live\))\s*/gi,' ').trim();}
function formatDuration(seconds){const total=Math.round((Number(seconds)||0)/60);if(!total)return '';const hours=Math.floor(total/60),minutes=total%60;return hours?`${hours}h${minutes?' '+minutes+'m':''}`:`${minutes}m`;}
function openCourse(course){const lessons=state.videos.filter(v=>v.course===course.name);$('#lessonCourse').value=course.name;renderLessons();const recent=lessons.find(v=>v.id===window.CourseForgeAccount?.lastLessons?.[course.name])||lessons.find(v=>{const p=state.progress.get(v.id);return p&&!p.completed&&p.percent>0;})||lessons.find(v=>!state.progress.get(v.id)?.completed)||lessons[0];navigate('learning');if(recent)openVideo(recent.id).catch(err=>toast(err.message,true));}
function buildCourseCard(course){
  const tile=make('div','course-tile');
  const button=make('button','course-card');button.type='button';button.style.cssText='border:1px solid var(--line);padding:0;text-align:left;color:inherit';
  const [a,b,symbol,category]=coverFor(course.name);const cover=make('div','course-cover');
  cover.style.setProperty('--cover-a',a);cover.style.setProperty('--cover-b',b);
  cover.append(make('span','cover-label',course.category||category));cover.append(make('span','cover-symbol',symbol));
  if(course.cover_url){const img=make('img','course-cover-img');img.src=course.cover_url+'?rev='+state.coverRevision;img.alt='';img.loading='lazy';img.decoding='async';img.addEventListener('load',()=>cover.classList.add('has-image'));img.addEventListener('error',()=>img.remove());cover.append(img);}
  button.append(cover);
  const body=make('div','course-body');
  body.append(make('div','course-category','Your course'));
  body.append(make('h3','',course.title||course.name));
  const length=course.videos.reduce((total,v)=>total+(Number(v.duration)||0),0);
  body.append(make('div','course-meta',`${course.videos.length} lessons${course.videos.every(v=>v.duration)&&length?' · '+formatDuration(length):''}`));
  if(course.instructor)body.append(make('div','course-byline',`By ${course.instructor}`));
  body.append(make('span','course-topic',course.category||courseCategory(course.name)));
  if(course.tags?.length){const tags=make('div','course-tags');for(const tag of course.tags.slice(0,3))tags.append(make('span','course-tag',tag));body.append(tags);}
  const line=make('div','course-progress-line');line.append(make('span','',`${course.completed} of ${course.videos.length} completed`));line.append(make('b','',`${course.percent}%`));body.append(line);
  const progress=make('div','progress-track');const bar=make('span');bar.style.width=course.percent+'%';progress.append(bar);body.append(progress);
  const bottom=make('div','course-bottom');bottom.append(make('span','',course.percent===100?'Review course':course.percent>0?'Continue learning':'Start learning'));bottom.append(icon('arrow'));body.append(bottom);
  button.append(body);button.addEventListener('click',()=>openCourse(course));
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
function courseCategory(name){return (/kubernetes|ansible|docker|devops|cloud|linux/i.test(name)?'DevOps':/data|spark|sql|databricks|analytics/i.test(name)?'Data engineering':/java|backend|python|javascript|golang|web/i.test(name)?'Development':'Other');}
function renderCatalog(){const all=groupCourses();$('#featuredCourses').setAttribute('aria-busy','false');$('#courseCatalog').setAttribute('aria-busy','false');$('#statCourses').textContent=all.length;$('#statVideos').textContent=state.videos.length;$('#statIndexed').textContent=state.videos.filter(v=>v.status==='done').length;$('#statCompleted').textContent=state.videos.filter(v=>state.progress.get(v.id)?.completed).length;$('#sideCourseCount').textContent=all.length;$('#countLabel').textContent=`${state.videos.length} videos`;
  const featured=$('#featuredCourses');featured.replaceChildren();for(const course of all.slice(0,3))featured.append(buildCourseCard(course));if(!all.length){const hint=make('div','panel empty-featured');hint.append(make('h3','','Your learning library starts here'));const admin=window.CourseForgeAccount?.user?.role==='admin';hint.append(make('p','',admin?'Import a course to organize your library.':'Enroll in a published course to start learning.'));const c=make('button','btn btn-primary',admin?'Scan my library':'Browse courses');c.addEventListener('click',admin?scanLibrary:()=>document.getElementById('catalogNav').click());hint.append(c);featured.append(hint);}
  const categorySelect=$('#categoryFilter');const categories=[...new Set(all.map(c=>c.category||courseCategory(c.name)))].sort();const oldCategory=categorySelect.value;categorySelect.replaceChildren(new Option('All categories','all'));categories.forEach(c=>categorySelect.add(new Option(c,c)));categorySelect.value=categories.includes(oldCategory)?oldCategory:'all';state.category=categorySelect.value;
  let visible=all.filter(c=>[c.name,c.title||'',c.instructor||'',...(c.tags||[])].some(t=>t.toLowerCase().includes(state.search))||c.videos.some(v=>v.title.toLowerCase().includes(state.search)));
  if(state.category!=='all')visible=visible.filter(c=>(c.category||courseCategory(c.name))===state.category);
  if(state.libraryFilter==='active')visible=visible.filter(c=>c.percent>0&&c.percent<100);
  if(state.libraryFilter==='completed')visible=visible.filter(c=>c.percent===100);
  if(state.librarySort==='title')visible.sort((a,b)=>(a.title||a.name).localeCompare(b.title||b.name));else if(state.librarySort==='duration')visible.sort((a,b)=>b.videos.reduce((sum,v)=>sum+(v.duration||0),0)-a.videos.reduce((sum,v)=>sum+(v.duration||0),0));else if(state.librarySort==='progress')visible.sort((a,b)=>b.percent-a.percent);
  $('#libraryCount').textContent=`Showing ${visible.length} of ${all.length} courses`;
  $('#libraryEmpty').hidden=!!visible.length||!!all.length;
  const catalog=$('#courseCatalog');catalog.replaceChildren();for(const course of visible)catalog.append(buildCourseCard(course));if(!visible.length&&all.length){const hint=make('p','muted',state.search?'No courses match your search. Try a different keyword.':'No courses match this filter yet.');catalog.append(hint);}
}
function renderSelects(){const courses=groupCourses();for(const id of ['#scope','#studyCourse','#lessonCourse']){const select=$(id);const old=select.value;select.replaceChildren();if(id==='#scope')select.add(new Option('Entire course library','all'));else if(id==='#studyCourse')select.add(new Option('Choose a course',''));else select.add(new Option('All courses',''));for(const c of courses){if(id==='#studyCourse'&&!c.indexed)continue;select.add(new Option(`${c.title||c.name}${id==='#scope'?' ('+c.videos.length+')':''}`,id==='#scope'?'course:'+c.name:c.name));}if([...select.options].some(x=>x.value===old))select.value=old;else if(id==='#studyCourse'&&select.options.length>1)select.selectedIndex=1;}
  const scope=$('#scope');const selected=scope.value;for(const v of state.videos){scope.add(new Option(`↳ ${v.title}`,'video:'+v.id));}if([...scope.options].some(x=>x.value===selected))scope.value=selected;
}
function getViewerName(){return window.CourseForgeAccount?.user?.name || '';}
function openMaterialsModal(course=null){return window.CourseForgeAcademy?.materials(course);}
function renderLessons(){const course=$('#lessonCourse').value;const list=$('#courseList');list.replaceChildren();const groups=new Map();for(const video of state.videos.filter(v=>!course||v.course===course)){if(!groups.has(video.course))groups.set(video.course,[]);groups.get(video.course).push(video);}let index=0;for(const [name,lessons] of groups){list.append(make('div','lesson-course-label',name));for(const v of lessons){index++;const btn=make('a','lesson-link'+(state.currentVideoId===v.id?' active':''));btn.dataset.vid=v.id;btn.href='#learning/'+encodeURIComponent(v.id);if(state.currentVideoId===v.id)btn.setAttribute('aria-current','true');const number=make('span','lesson-number',String(index).padStart(2,'0'));if(state.progress.get(v.id)?.completed){number.replaceChildren(icon('check'));number.setAttribute('aria-label','Completed');}btn.append(number);const t=make('span','lesson-text');t.append(make('span','name',lessonTitle(v.title)));const p=state.progress.get(v.id);const baseStatus=p?.completed?'Completed':p?.position>0?'In progress':v.cloud_ready?'':'Coming soon';t.append(make('span','status',[formatDuration(v.duration),baseStatus].filter(Boolean).join(' · ')));btn.append(t);btn.addEventListener('click',event=>{if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();openVideo(v.id).catch(err=>toast(err.message,true));});list.append(btn);}}
  $('#lessonCount').textContent=`${index} lessons`;
}
function renderJobs(){const active=state.jobs.filter(j=>j.status==='processing');const queued=state.jobs.filter(j=>j.status==='queued');const failed=state.jobs.filter(j=>j.status==='failed');$('#jobSummary').textContent=active.length?`Indexing: ${active[0].title}`:queued.length?`${queued.length} queued · ${failed.length} failed`:failed.length?`${failed.length} imports need attention`:'Your library is ready';}
async function loadLibrary(){const [{videos},{jobs},{progress},catalog]=await Promise.all([request('/api/videos'),(window.CourseForgeAccount?.user?.role==='admin'?request('/api/jobs'):Promise.resolve({jobs:[]})),request('/api/progress'),services.courses().catch(()=>({courses:[]}))]);state.videos=videos;state.jobs=jobs;state.progress=new Map(progress.map(p=>[p.video_id,p]));state.courseMeta=new Map((catalog.courses||[]).map(c=>[c.id,c]));renderCatalog();renderSelects();renderLessons();renderJobs();}
async function scanLibrary(){for(const btn of ['#scanBtn','#scanBtnSide','#scanBtnLibrary','#emptyScanBtn'])$(btn).disabled=true;try{const result=await request('/api/scan',{method:'POST'});await loadLibrary();toast(`Found ${result.found} videos · ${result.imported} new · ${result.changed} changed. Processing continues in the worker.`);}catch(err){toast(err.message,true)}finally{for(const btn of ['#scanBtn','#scanBtnSide','#scanBtnLibrary','#emptyScanBtn'])$(btn).disabled=false;}}
for(const selector of ['#scanBtn','#scanBtnSide','#scanBtnLibrary','#emptyScanBtn'])$(selector).addEventListener('click',scanLibrary);
$('#refreshBtn').addEventListener('click',()=>loadLibrary().catch(err=>toast(err.message,true)));
$('#heroLearnBtn').addEventListener('click',()=>{const courses=groupCourses();if(courses.length)openCourse(courses.find(c=>c.percent>0&&c.percent<100)||courses[0]);else navigate('library')});
$$('[data-filter]').forEach(button=>button.addEventListener('click',()=>{state.libraryFilter=button.dataset.filter;$$('[data-filter]').forEach(el=>el.classList.toggle('active',el===button));renderCatalog()}));
$('#categoryFilter').addEventListener('change',event=>{state.category=event.target.value;renderCatalog()});
$('#librarySort').addEventListener('change',event=>{state.librarySort=event.target.value;renderCatalog()});
$('#librarySearch').addEventListener('input',event=>{state.search=event.target.value.trim().toLowerCase();renderCatalog()});
$('#globalSearch').addEventListener('input',event=>{state.search=event.target.value.trim().toLowerCase();$('#librarySearch').value=event.target.value;if(state.search)navigate('library');renderCatalog();});
$('#globalSearch').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();navigate('library')}});
$('#lessonCourse').addEventListener('change',renderLessons);
let openingGeneration=0;
window.CourseForgeCancelVideoOpen=()=>{openingGeneration++;};
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
  state.selectedId=id;state.currentVideoId=id;window.CourseForgeAccount.lastLessons[video.course]=id;
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
    toast(completed?'Completion undone.':'Lesson completed.');
  }catch(error){toast('We couldn’t save your progress. Please try again.',true);}finally{button.disabled=false;}
});
$('#reindexBtn').addEventListener('click',async()=>{if(!state.currentVideoId)return;try{const result=await request(`/api/videos/${state.currentVideoId}/reindex`,{method:'POST'});toast(result.message);await loadLibrary()}catch(err){toast(err.message,true)}});
$('#askAboutVideo').addEventListener('click',()=>{if(!state.currentVideoId)return;$('#scope').value='video:'+state.currentVideoId;$('#question').value='Explain the key ideas from this lesson with examples and references to timestamps.';navigate('tutor');$('#question').focus()});
const currentScope=()=>{const value=$('#scope').value;return value==='all'?{}:value.startsWith('video:')?{video_id:value.slice(6)}:{course:value.slice(7)};};
$$('.mode').forEach(button=>button.addEventListener('click',()=>{state.mode=button.dataset.mode;$$('.mode').forEach(el=>el.classList.toggle('active',el===button));$('#question').placeholder=({explain:'Explain a concept from my lectures…',notes:'Create concise notes from this course…',quiz:'Quiz me on what I learned…',lab:'Give me a practical exercise…'})[state.mode]}));
$$('[data-prompt]').forEach(button=>button.addEventListener('click',()=>{$('#question').value=button.dataset.prompt;$('#question').focus();}));
async function askTutor(){const question=$('#question').value.trim();if(!question)return toast('Enter a question first.',true);const btn=$('#askBtn');btn.disabled=true;btn.textContent='Searching your lessons…';try{const result=await request('/api/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question,mode:state.mode,...currentScope()})});state.lastAnswer=result.answer;$('#answer').textContent=result.answer;$('#answerPanel').hidden=false;
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
async function loadDue(){const {cards}=await request('/api/reviews/due'+(selectedStudyCourse()?'?course='+encodeURIComponent(selectedStudyCourse()):''));state.dueCards=cards;showReview();}
function showReview(){state.activeCard=state.dueCards.shift()||null;$('#reviewCard').hidden=!state.activeCard;$('#reviewStatus').textContent=state.activeCard?`${state.dueCards.length+1} cards in this review session`:'You’re all caught up. Create flashcards from your lessons to keep practising.';if(!state.activeCard)return;$('#reviewQuestion').textContent=state.activeCard.question;$('#reviewAnswer').textContent=state.activeCard.answer;$('#reviewAnswer').hidden=true;$('#reviewGrades').hidden=true;$('#revealAnswerBtn').hidden=false;}
$('#generateCardsBtn').addEventListener('click',async()=>{const course=selectedStudyCourse();if(!course)return toast('Choose a course in Study paths first.',true);const btn=$('#generateCardsBtn');btn.disabled=true;$('#reviewStatus').textContent='Creating your flashcards…';try{const result=await request('/api/reviews/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({course,topic:$('#reviewTopic').value.trim()||'key concepts',count:5})});await loadDue();toast(`${result.created} flashcards created.`)}catch(err){$('#reviewStatus').textContent=err.message}finally{btn.disabled=false}});
$('#loadDueBtn').addEventListener('click',()=>loadDue().catch(err=>toast(err.message,true)));
$('#revealAnswerBtn').addEventListener('click',()=>{$('#reviewAnswer').hidden=false;$('#revealAnswerBtn').hidden=true;$('#reviewGrades').hidden=false});
$$('[data-quality]').forEach(button=>button.addEventListener('click',async()=>{if(!state.activeCard)return;button.disabled=true;try{await request(`/api/reviews/${state.activeCard.id}/grade`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({quality:Number(button.dataset.quality)})});showReview();loadInsights().catch(()=>{});}catch(err){toast(err.message,true)}finally{button.disabled=false}}));
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
}
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
  if(!['lessons','notes','transcript','summary','path'].includes(name))name='lessons';
  state.studyTab=name;
  $$('[data-lesson-tab]').forEach(tab=>{const selected=tab.dataset.lessonTab===name;tab.classList.toggle('active',selected);tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected||(['summary','path'].includes(name)&&tab.dataset.lessonTab==='lessons')?0:-1;});
  $$('[data-lesson-panel]').forEach(panel=>panel.hidden=panel.dataset.lessonPanel!==name);
  if(sync&&state.currentVideoId)syncLessonRoute(state.currentVideoId,null,true);
}
$$('[data-lesson-tab]').forEach(button=>{button.addEventListener('click',()=>selectLessonTab(button.dataset.lessonTab));button.addEventListener('keydown',event=>{const tabs=$$('[data-lesson-tab]'),index=tabs.indexOf(button);let next;if(event.key==='ArrowRight')next=tabs[(index+1)%tabs.length];else if(event.key==='ArrowLeft')next=tabs[(index+tabs.length-1)%tabs.length];else if(event.key==='Home')next=tabs[0];else if(event.key==='End')next=tabs.at(-1);if(next){event.preventDefault();next.focus();selectLessonTab(next.dataset.lessonTab);}});});
$('#nextLessonBtn').addEventListener('click',()=>{const next=window.CourseForgeStudio.adjacent(1);if(next)openVideo(next.id).catch(error=>toast(error.message,true));});
$('#generateSummaryBtn').addEventListener('click',async()=>{if(!state.currentVideoId)return toast('Choose a lesson first.',true);const btn=$('#generateSummaryBtn');btn.disabled=true;$('#lessonSummary').textContent='Creating your lesson summary…';try{const data=await request('/api/ask',services.json('POST',{question:'Summarize the learning objectives, key concepts, code or commands, and next steps from this lecture. Cite sources and timestamps.',mode:'notes',video_id:state.currentVideoId}));$('#lessonSummary').textContent=data.answer;}catch(err){$('#lessonSummary').textContent=err.message;}finally{btn.disabled=false}});
$('#guidedTutorBtn').addEventListener('click',()=>{state.mode='explain';$$('.mode').forEach(m=>m.classList.toggle('active',m.dataset.mode==='explain'));$('#question').value='Teach me a core concept from the selected course step by step. Start with intuition, then a worked example, then one question to check understanding. Include source timestamps.';navigate('tutor');$('#question').focus()});
$('#conceptCheckBtn').addEventListener('click',()=>{state.mode='quiz';$$('.mode').forEach(m=>m.classList.toggle('active',m.dataset.mode==='quiz'));$('#question').value='Give me one question to assess my understanding of the selected course, then explain the correct answer with a video citation. Do not claim to grade my knowledge without my response.';$('#question').focus()});
function recordConceptSignal(signal){const answer=state.lastAnswer;if(!answer)return;try{const history=JSON.parse(localStorage.getItem('courseforge-concept-feedback:'+window.CourseForgeAccount.user.id)||'[]');history.unshift({feedback:signal,summary:answer.slice(0,120),date:new Date().toISOString()});localStorage.setItem('courseforge-concept-feedback:'+window.CourseForgeAccount.user.id,JSON.stringify(history.slice(0,60)));}catch{}toast(signal==='confident'?'Confidence recorded on this device.':'Marked for extra practice on this device. Review the cited lecture next.');}
$('#conceptConfident').addEventListener('click',()=>recordConceptSignal('confident'));
$('#conceptUnsure').addEventListener('click',()=>recordConceptSignal('unsure'));
function renderPlannedLabs(){const target=$('#plannedLabs');target.replaceChildren();for(const text of ['Choose an exercise', 'Write your solution', 'Check your work', 'Review feedback']){const card=make('div','planned-lab');card.append(make('strong','',text));target.append(card);}}
async function loadSettings(){$('#settingsPaths').textContent='Your saved lessons, notes, and progress stay together in your account.';}
function syncGoal(){let value='30';try{value=localStorage.getItem('courseforge-daily-goal:'+window.CourseForgeAccount.user.id)||'30';}catch{}if(!['15','30','45','60'].includes(value))value='30';$('#goalMinutes').value=value;$('#settingsGoal').value=value;}
for(const selector of ['#goalMinutes','#settingsGoal'])$(selector).addEventListener('change',event=>{const value=event.target.value;try{localStorage.setItem('courseforge-daily-goal:'+window.CourseForgeAccount.user.id,value)}catch{}syncGoal();toast(`Daily target set to ${value} minutes on this device.`)});

window.CourseForgeBoot=async(initialData)=>{
  const initial=readLessonRoute();applyingRoute++;try{navigate(navNames[initial.view]?initial.view:'dashboard');}finally{applyingRoute--;}
  if(initialData){state.videos=initialData.videos;state.jobs=[];state.progress=new Map(initialData.progress.map(p=>[p.video_id,p]));state.courseMeta=new Map(initialData.courses.map(c=>[c.id,c]));renderCatalog();renderSelects();renderLessons();renderJobs();}else await loadLibrary();
  renderPlannedLabs();syncGoal();loadSettings();await window.CourseForgePlayerSession.loadPreferences(initialData?.preferences);
  document.documentElement.dataset.lessonInteractive='true';window.dispatchEvent(new Event('courseforge-interactive'));
  if(initial.view==='learning'&&initial.id){selectLessonTab(initial.tab,false);applyingRoute++;try{await openVideo(initial.id,initial.at);}finally{applyingRoute--;}}
  setTimeout(()=>Promise.allSettled([loadSyllabus(),loadDue(),loadInsights(),loadLabs()]),0);
};
setInterval(()=>{if(window.CourseForgeAccount?.user?.verified&&!document.hidden&&!$('#appShell').hidden)loadLibrary().catch(()=>{})},30000);

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
        if(navigator.onLine===false)throw new Error('You are offline. Tracking resumes when the connection returns.');
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
        stop();const error=new Error('Tracking could not keep up. Reopen this lesson to continue.');
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
      onError:error=>{if(owner!==a)return;if([401,403,404].includes(error.status)){a.claimed=false;onLost('Please reopen the lesson to keep watching.');}else window.CourseForgeNative?.trackingNotice('Connection interrupted. Playback tracking will resume after reconnection.');}
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
  function button(label,svg,action){
    const b=element('button','player-button');b.type='button';b.title=label;b.setAttribute('aria-label',label);
    b.innerHTML=`<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${svg}</svg>`;b.onclick=action;return b;
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
        state.progress.set(a.lesson,{...p,video_id:a.lesson,position:r.position,completed,percent:completed?100:r.coverage_percent});
        window.CourseForgeStudio?.completion(completed);
        if(completed&&!p.completed){renderLessons();toast('Lesson completed.');}
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
      const capture=button('Capture timestamp','<path d="M6 3h12v18l-6-4-6 4z"/>',()=>window.CourseForgeStudio?.capture());
      const theater=button('Theater mode','<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14"/>',()=>window.CourseForgeStudio?.toggleTheater());
      const lock=button('Lock player controls','<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',()=>setLock(true));
      top.append(capture,theater,lock);controller.append(top);
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
      const speed=button('Playback speed','<path d="m9 3 .5 2a7 7 0 0 1 5 0L15 3l3 2-1 2a7 7 0 0 1 2.5 4L22 12l-2.5 1a7 7 0 0 1-2.5 4l1 2-3 2-.5-2a7 7 0 0 1-5 0L9 21l-3-2 1-2a7 7 0 0 1-2.5-4L2 12l2.5-1A7 7 0 0 1 7 7L6 5z"/><circle cx="12" cy="12" r="3"/>',()=>toggleMenu(menu.hidden));
      speed.classList.add('player-settings');speed.setAttribute('aria-haspopup','true');speed.setAttribute('aria-expanded','false');
      const menu=element('div','player-speed-menu');menu.hidden=true;menu.setAttribute('role','group');menu.setAttribute('aria-label','Playback speed');
      menu.append(element('strong','','Playback speed'));
      const rates=element('div','player-speed-options');
      for(const rate of [.5,.75,1,1.25,1.5,1.75,2,2.5,3]){
        const choice=element('button','',rate===1?'Normal':`${rate}×`);choice.type='button';choice.dataset.rate=rate;
        choice.setAttribute('aria-pressed',String(rate===prefs.speed));choice.onclick=()=>{v.playbackRate=rate;toggleMenu(false);speed.focus();};rates.append(choice);
      }
      menu.append(rates);stage.append(menu);
      const pinControls=()=>controller.setAttribute('autohide',a.locked||!menu.hidden||stage.matches(':focus-visible')||stage.querySelector(':focus-visible')?'-1':'3');
      function toggleMenu(open){menu.hidden=!open;speed.setAttribute('aria-expanded',String(open));pinControls();if(open)rates.querySelector('[aria-pressed="true"]')?.focus();}
      v.addEventListener('ratechange',()=>{for(const choice of rates.children)choice.setAttribute('aria-pressed',String(Number(choice.dataset.rate)===v.playbackRate));});
      stage.addEventListener('pointerdown',event=>{if(!menu.hidden&&!event.composedPath().includes(menu)&&!event.composedPath().includes(speed))toggleMenu(false);});
      menu.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();toggleMenu(false);speed.focus();}});
      menu.addEventListener('focusout',event=>{if(event.relatedTarget&&!menu.contains(event.relatedTarget)&&event.relatedTarget!==speed)toggleMenu(false);});
      const full=button('Fullscreen','<path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5"/>',async()=>{
        try{if(document.fullscreenElement)await document.exitFullscreen();else{await wrap.requestFullscreen();if(matchMedia('(pointer:coarse)').matches)await screen.orientation?.lock?.('landscape').catch(()=>{});}}
        catch{toast('Fullscreen is unavailable.',true);}
      });
      const fullscreen=()=>{if(!document.fullscreenElement)screen.orientation?.unlock?.();};
      document.addEventListener('fullscreenchange',fullscreen);
      a.cleanup=()=>{document.removeEventListener('fullscreenchange',fullscreen);screen.orientation?.unlock?.();};
      row.append(spacer,speed,full);chrome.append(timeline,row);controller.append(chrome);
      const center=element('div','player-center-controls');
      const back=button('Back 10 seconds','<path d="M3 9a9 9 0 1 1 1 9M3 4v5h5"/><text x="12" y="15" text-anchor="middle" stroke="none" fill="currentColor" font-size="8" font-weight="600">10</text>',()=>seek(-10));
      const play=button('Play lesson','<path d="m9 5 11 7-11 7z" fill="currentColor" stroke="none"/>',()=>v.paused?v.play().catch(()=>{}):v.pause());
      const forward=button('Forward 10 seconds','<path d="M21 9a9 9 0 1 0-1 9M21 4v5h-5"/><text x="12" y="15" text-anchor="middle" stroke="none" fill="currentColor" font-size="8" font-weight="600">10</text>',()=>seek(10));
      play.classList.add('player-center-play');center.append(back,play,forward);stage.append(center);
      const updatePlay=()=>{
        stage.classList.toggle('is-playing',!v.paused);
        play.setAttribute('aria-label',v.paused?'Play lesson':'Pause lesson');play.title=v.paused?'Play lesson':'Pause lesson';
        play.querySelector('svg').innerHTML=v.paused?'<path d="m9 5 11 7-11 7z" fill="currentColor" stroke="none"/>':'<path d="M8 5v14M16 5v14" stroke-width="4"/>';
      };
      for(const event of ['play','pause','ended'])v.addEventListener(event,updatePlay);
      const unlock=element('button','player-unlock','Hold to unlock');unlock.type='button';unlock.hidden=true;unlock.setAttribute('aria-label','Hold for one second to unlock, or press Enter or Escape');stage.append(unlock);
      function setLock(locked){
        a.locked=locked;toggleMenu(false);stage.classList.toggle('controls-locked',locked);chrome.inert=locked;top.inert=locked;center.inert=locked;
        unlock.hidden=!locked;pinControls();unlock.textContent='Hold to unlock';
        if(locked)unlock.focus();else stage.focus();
      }
      a.unlock=()=>setLock(false);
      unlock.addEventListener('pointerdown',event=>{if(event.button!==0)return;unlock.setPointerCapture(event.pointerId);unlock.textContent='Keep holding…';a.hold=setTimeout(()=>setLock(false),1000);});
      for(const event of ['pointerup','pointercancel','lostpointercapture'])unlock.addEventListener(event,()=>{clearTimeout(a.hold);if(a.locked)unlock.textContent='Hold to unlock';});
      unlock.onclick=event=>{if(event.detail===0)setLock(false);};
      stage.addEventListener('keydown',event=>{
        if(event.key==='Escape'&&a.locked){event.preventDefault();event.stopPropagation();setLock(false);return;}
        if(a.locked)return;
        const target=event.composedPath()[0];if(target!==stage&&target!==v)return;
        if(event.ctrlKey||event.metaKey||event.altKey)return;
        const actions={' ':()=>v.paused?v.play().catch(()=>{}):v.pause(),ArrowLeft:()=>seek(-10),ArrowRight:()=>seek(10),m:()=>v.muted=!v.muted,f:()=>full.click(),l:()=>setLock(true)};
        const action=actions[event.key.length===1?event.key.toLowerCase():event.key];if(action){event.preventDefault();action();}
      });
      let lastTap=0,lastSide=null;
      v.addEventListener('pointerup',event=>{
        if(a.locked)return;
        if(event.pointerType==='mouse'){v.paused?v.play().catch(()=>{}):v.pause();return;}
        const side=event.offsetX<v.clientWidth/2?'left':'right',now=performance.now();
        if(now-lastTap<350&&side===lastSide){seek(side==='left'?-10:10);lastTap=0;}else{lastTap=now;lastSide=side;}
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
  let countdown=null,seconds=0;
  const prefs=()=>window.CourseForgePlayerSession.preferences();
  function cancelNext(){clearInterval(countdown);countdown=null;document.querySelector('.player-next')?.remove();}
  function adjacent(direction,availableOnly=false){
    const current=state.videos.find(v=>v.id===state.currentVideoId);if(!current)return null;
    const lessons=state.videos.filter(v=>v.course===current.course),at=lessons.findIndex(v=>v.id===current.id);
    for(let i=at+direction;i>=0&&i<lessons.length;i+=direction){if(!availableOnly||lessons[i].cloud_ready)return lessons[i];}
    return null;
  }
  function update(video){
    cancelNext();document.body.classList.add('in-learning');
    $('#learningHeader').textContent=state.courseMeta.get(video.course)?.title||video.course;
    $('#learningSubhead').textContent=lessonTitle(video.title);
    completion(Boolean(state.progress.get(video.id)?.completed));
    $('#playerAutoplay').checked=prefs().autoplay;
    $('.learning-grid').classList.toggle('cinema-expanded',prefs().theater);
    for(const [id,step]of [['previousLessonBtn',-1],['nextLessonBtn',1]]){const next=adjacent(step);$('#'+id).disabled=!next;$('#'+id).title=next?.title||'No more lessons';}
  }
  function overlay(cls,text,actions){
    const stage=document.querySelector('.native-player-stage')||$('#lecturePlayerWrap');if(!stage)return null;
    stage.querySelector('.'+cls)?.remove();const box=make('div',cls);box.setAttribute('role','status');
    if(cls==='player-recovery'){stage.querySelector('.player-resume')?.remove();const status=stage.querySelector('.native-player-status');if(status)status.textContent='';}
    box.append(make('p','',text));const row=make('div');
    for(const [label,action]of actions){const b=make('button','btn btn-outline',label);b.type='button';b.onclick=()=>Promise.resolve(action()).catch(error=>toast(error.message,true));row.append(b);}
    box.append(row);stage.append(box);return box;
  }
  function ownershipLost(text){
    cancelNext();const v=window.CourseForgeNative.video();if(v){window.CourseForgeNative.unlock();window.CourseForgeNative.pauseForRecovery();}
    else document.querySelector('#lecturePlayerWrap iframe')?.remove();
    overlay('player-recovery',text,[['Resume here',async()=>{
      try{if(!await window.CourseForgePlayerSession.reclaim())return;}catch(error){if([403,404].includes(error.status)){await openVideo(state.currentVideoId);return;}throw error;}
      const media=window.CourseForgeNative.video();
      if(media&&!media.error&&media.readyState>=1){
        document.querySelector('.player-recovery')?.remove();window.CourseForgeNative.resumeRecovery();await media.play();
      }else await openVideo(state.currentVideoId,window.CourseForgeNative.currentPosition());
    }],['Back to courses',()=>navigate('library')]]);
  }
  function ended(lesson){
    cancelNext();if(!prefs().autoplay||window.CourseForgeNative.locked())return;
    const next=adjacent(1,true);if(!next||next.course!==lesson.course)return;
    seconds=10;const box=overlay('player-next',`Next lesson in ${seconds}s: ${next.title}`,[['Play next',async()=>{cancelNext();await openVideo(next.id);await window.CourseForgeNative.video()?.play();}],['Cancel autoplay',cancelNext]]);
    if(!box)return;countdown=setInterval(()=>{
      if(document.hidden||window.CourseForgeNative.locked()){cancelNext();return;}
      seconds--;box.querySelector('p').textContent=`Next lesson in ${seconds}s: ${next.title}`;
      if(seconds<=0){cancelNext();openVideo(next.id).then(()=>window.CourseForgeNative.video()?.play()).catch(error=>toast(error.message,true));}
    },1000);
  }
  function resumePrompt(start){
    if(!start)return;
    overlay('player-resume',`Continue from ${prettyTime(start)}?`,[['Resume',()=>{document.querySelector('.player-resume')?.remove();return window.CourseForgeNative.video()?.play();}],['Restart',()=>{window.CourseForgeNative.seek(0,true);document.querySelector('.player-resume')?.remove();return window.CourseForgeNative.video()?.play();}]]);
  }
  function capture(){
    const position=window.CourseForgeNative.currentPosition();if(position===null)return;
    for(const id of ['notePosition','bookmarkPosition'])$('#'+id).value=prettyTime(position);
    selectLessonTab('notes');$('#noteText').focus({preventScroll:true});toast('Timestamp added. Write a note or bookmark to save it.');
  }
  function completion(completed){
    const button=$('#markCompleteBtn');button.textContent=completed?'Completed':'Complete lesson';
    button.setAttribute('aria-pressed',String(Boolean(completed)));
    button.title=completed?'Undo lesson completion':'Mark this lesson complete';
    button.classList.toggle('lesson-completed',Boolean(completed));
    $('#playingCourse').textContent=completed?'Lesson completed. Continue to the next lesson when you’re ready.':'Pick up where you left off. Your place is saved automatically.';
  }
  function toggleTheater(){const theater=!prefs().theater;window.CourseForgePlayerSession.setPreferences({theater});$('.learning-grid').classList.toggle('cinema-expanded',theater);}
  $('#playerAutoplay').onchange=event=>{window.CourseForgePlayerSession.setPreferences({autoplay:event.target.checked});if(!event.target.checked)cancelNext();};
  $('#studioAccount').onclick=()=>$('#accountNav').click();
  $('#studioResources').onclick=()=>{const video=state.videos.find(v=>v.id===state.currentVideoId);if(video)openMaterialsModal(video.course);};
  document.querySelectorAll('[data-study-extra]').forEach(button=>button.onclick=()=>{selectLessonTab(button.dataset.studyExtra);button.closest('details').open=false;});
  window.CourseForgeStudio={update,completion,cancelNext,adjacent,ended,ownershipLost,capture,toggleTheater,resumePrompt};
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
    if(mode==='login'||mode==='register'){const password=field(f,'Password','password','password');password.autocomplete=mode==='login'?'current-password':'new-password';if(mode==='register'){password.minLength=12;f.append(node('p','muted','Use at least 12 characters.'));}}
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
    const password=field(f,'New password (optional)','password','password',false);password.minLength=12;password.autocomplete='new-password';submitButton(f,'Save account');
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
    heading(root,'Recent student activity',report.activity_basis+'. '+report.completion_basis+'.');
    root.append(table(['Student','Activity','Lecture','Time'],report.recent_activity.map(e=>[e.name,e.event_type.replaceAll('_',' '),e.title||e.details,date(e.created_at)])));
    heading(root,'Course enrollment funnel');root.append(table(['Course','Enrolled','Started'],report.funnels.map(r=>[r.course,r.enrolled,r.started])));
    heading(root,'Recent access events');root.append(table(['Event','IP address','Device','Time'],report.access_events.map(e=>[e.event_type.replaceAll('_',' '),e.ip,e.device,date(e.created_at)])));
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
    heading(root,'Playback tracking','Browser-reported playback and content coverage are separate from lesson-page activity and lesson completion.');root.append(table(['Lecture','Playback','Resume','Coverage','Last saved'],r.playback.map(l=>[l.title,minutes(l.playing_seconds),prettyTime(l.position),l.coverage_percent+'%',date(l.updated_at)])));
    heading(root,'Assessment results');root.append(table(['Topic','Score','Correct','Completed'],r.assessments.map(a=>[a.step_id,`${a.score}%`,`${a.correct_count}/${a.total_count}`,date(a.completed_at)])));
    heading(root,'Practice labs');root.append(table(['Lab','Status','Updated'],r.labs.map(l=>[l.slug,l.status,date(l.updated_at)])));
    heading(root,'Recall practice');root.append(table(['Self-rating (0–5)','Reviewed'],r.reviews.map(a=>[a.quality,date(a.reviewed_at)])));
    heading(root,'Study plans');root.append(table(['Date','Budget','Updated'],r.plans.map(a=>[a.study_date,`${a.budget_minutes}m`,date(a.updated_at)])));
    heading(root,'Focus sessions');root.append(table(['Title','Mode','Status','Configured duration'],r.focus.map(a=>[a.title,a.mode,a.status,minutes(a.duration_seconds)])));
    heading(root,'Devices and access');root.append(table(['Device','IP address','Last active','Expires'],r.sessions.map(s=>[s.device,s.ip,date(s.last_seen),date(s.expires_at)])));
    heading(root,'Learning history');root.append(table(['Activity','Lecture','Time'],r.activity.map(a=>[a.event_type.replaceAll('_',' '),a.title||a.details,date(a.created_at)])));
    heading(root,'Access history');root.append(table(['Event','IP','Device','Time'],r.access.map(a=>[a.event_type.replaceAll('_',' '),a.ip,a.device,date(a.created_at)])));
  }
  async function adminCourses(){
    const root=adminPage('Course publishing','courses');const result=await api('/api/admin/courses');
    for(const c of result.courses){const f=form(root,c.title,async data=>{await api(`/api/admin/courses/${encodeURIComponent(c.id)}/publication`,json('PUT',{published:data.get('published')==='on',description:data.get('description')}));message('Course publication updated.');});
      f.append(node('p','muted',`${c.available_lessons}/${c.lesson_count} lectures mapped to Odysee`));
      f.append(button('Edit course details and cover',()=>openCourseEditor({...c,name:c.id})));
      const l=node('label','field');l.append(node('span','','Course description'));const d=node('textarea','form-input');d.name='description';d.maxLength=5000;d.rows=4;d.value=c.description;l.append(d);f.append(l);
      const publish=node('label');const check=node('input');check.name='published';check.type='checkbox';check.checked=Boolean(c.published);publish.append(check,document.createTextNode(' Published in public catalog'));f.append(publish);submitButton(f,'Save publication');
    }
    const map=form(root,'Map an Odysee lecture',async data=>{await api(`/api/admin/videos/${encodeURIComponent(data.get('video_id'))}/provider`,json('PUT',{claim_name:data.get('claim_name'),claim_id:data.get('claim_id')}));message('Lecture mapping saved.');});
    const videos=await api('/api/videos');const select=node('select','form-input');select.name='video_id';select.required=true;select.setAttribute('aria-label','Lecture to map');videos.videos.forEach(v=>select.add(new Option(`${v.course} / ${v.title}`,v.id)));map.append(select);
    field(map,'Odysee claim name','claim_name');const claim=field(map,'Odysee claim ID','claim_id');claim.pattern='[0-9a-fA-F]{40}';submitButton(map,'Save mapping');
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
    heading(root,'Player capabilities');root.append(node('p','',`Odysee authorization: ${r.provider_configured?'Configured':'Missing credentials'}. Automatic resume: ${r.player.automatic_resume?'Supported':'Unavailable'}.`),node('p','muted','The CourseForge player supports seeking, speed, volume, fullscreen, timestamp capture, automatic resume, and browser-reported playback tracking. Original video quality is delivered by Odysee. The embedded fallback supports manual resume points and visible lesson activity. Authenticated streaming and the viewer watermark provide access control and deterrence; they are not encrypted DRM.'));
    root.append(button('Refresh Odysee mappings',async()=>{const result=await api('/api/admin/provider-sync',json('POST',{}));await adminSystem();message(result.in_progress?'A mapping refresh is already running.':result.error||`${result.mapped}/${result.lectures} lectures mapped. ${result.durations_added} durations added.`,Boolean(result.error));}));
    heading(root,'Service reports');root.append(table(['Service','Last report','Last successful report','Status'],Object.entries(r.service_checks).map(([name,s])=>[name.replaceAll('_',' '),date(s.last_attempt),date(s.last_success),s.last_error||s.summary.state||(s.summary.mapped!==undefined?`${s.summary.mapped}/${s.summary.lectures} mapped`:'Reported')])));
    heading(root,'Learning task queue');root.append(table(['Status','Tasks'],Object.entries(r.tasks)));
    heading(root,'Administrator audit','Records account invitations, access changes, course publishing, provider mapping, and report exports. Logs retain 90 days; private activation links and passwords are excluded.');root.append(table(['Administrator','Action','Resource','Time'],r.audit.map(a=>[a.actor||'Deleted administrator',a.action,a.resource,date(a.created_at)])));
    root.append(button('Refresh status',adminSystem));
  }
  async function materials(course){
    const root=el('resourcesDialog');root.replaceChildren(node('h2','','Course resources'),button('Close',()=>root.close()));root.showModal();
    try{const data=await api('/api/materials'+(course?'?course='+encodeURIComponent(course):''));
      root.append(table(['Course','Resource','Type','Size','Open'],data.materials.map(m=>{const link=node('a','text-link','View resource');link.href=m.url;link.target='_blank';link.rel='noopener';return [m.course,m.name,m.ext,`${m.size_kb} KB`,link];})));}
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
  el('lessonSearch').oninput=e=>{const query=e.target.value.toLowerCase();document.querySelectorAll('.lesson-link').forEach(link=>link.hidden=!link.textContent.toLowerCase().includes(query));};
  el('previousLessonBtn').onclick=()=>{const current=state.videos.find(v=>v.id===state.currentVideoId);if(!current)return;const lessons=state.videos.filter(v=>v.course===current.course),previous=lessons[lessons.findIndex(v=>v.id===current.id)-1];if(previous)openVideo(previous.id).catch(error=>toast(error.message,true));else toast('You are at the first lesson.');};
  window.CourseForgeAcademy={materials,stopActivity,leaveLesson,startActivity,loadBookmarks,parseTimestamp,workspace};
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
      if(action==='activate')root.append(node('p','muted','Your administrator invited you to CourseForge. Choose a password with at least 12 characters.'));
      const f=form(root,'',async data=>{const r=await api('/api/auth/'+action,json('POST',{token,password:data.get('password')}));history.replaceState(null,'','/');signIn();message(r.message);});field(f,'New password','password','password').minLength=12;submitButton(f,action==='activate'?'Activate account':'Reset password');return;
    }
    const adminRoute=location.hash.match(/^#admin(?:\/(.*))?$/);
    if(location.hash==='#register'&&!account.user)signIn('register');
    else if(location.hash==='#courses')await catalog();
    else if(adminRoute&&!account.user)signIn();
    else if(adminRoute&&account.user?.role==='admin'){
      const route=adminRoute[1]||'';
      if(route.startsWith('students/'))await adminStudent(route.slice(9));
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
  for(const [label,view,glyph]of [['Home','dashboard','grid'],['Today','planner','clock'],['Courses','library','book'],['Review','reviews','cards']]){
    const b=make('button','mobile-tab',label);b.type='button';b.dataset.mobileView=view;b.prepend(icon(glyph));
    b.onclick=async()=>{if(document.getElementById('appShell').hidden)await window.CourseForgeAcademy.workspace();navigate(view);};nav.append(b);
  }
  const next=make('button','mobile-next btn btn-primary','Next lesson');next.type='button';next.hidden=true;
  next.onclick=()=>document.getElementById('nextLessonBtn').click();document.body.append(next,nav);
  function sync(){
    nav.hidden=!window.CourseForgeAccount?.user?.verified;
    const learning=document.body.classList.contains('in-learning');next.hidden=!learning||!state.currentVideoId;
    next.disabled=document.getElementById('nextLessonBtn').disabled;
    for(const b of nav.children){const selected=b.dataset.mobileView===state.view&&!document.getElementById('appShell').hidden;b.classList.toggle('active',selected);selected?b.setAttribute('aria-current','page'):b.removeAttribute('aria-current');}
  }
  const observer=new MutationObserver(sync);observer.observe(document.body,{attributes:true,attributeFilter:['class']});
  observer.observe(document.getElementById('appShell'),{attributes:true,attributeFilter:['hidden']});
  observer.observe(document.getElementById('nextLessonBtn'),{attributes:true,attributeFilter:['disabled']});
  window.addEventListener('courseforge-ready',sync);window.addEventListener('courseforge-navigate',sync);
  // An edge swipe goes back without capturing controls, writing, or scrolling.
  let start=null;
  document.addEventListener('pointerdown',e=>{
    start=e.pointerType==='touch'&&e.isPrimary&&e.clientX<=24&&document.body.classList.contains('in-learning')&&!e.target.closest('button,a,input,textarea,select,video,media-controller')?{x:e.clientX,y:e.clientY,t:performance.now()}:null;
  },{passive:true});
  document.addEventListener('pointercancel',()=>start=null,{passive:true});
  document.addEventListener('pointerup',e=>{const s=start;start=null;if(s&&e.clientX-s.x>=90&&Math.abs(e.clientY-s.y)<45&&performance.now()-s.t<700&&!document.fullscreenElement)navigate('library');},{passive:true});
  function keyboard(){const v=window.visualViewport;document.body.classList.toggle('phone-keyboard',Boolean(v&&innerHeight-v.height>150&&document.activeElement?.matches('input,textarea')));}
  window.visualViewport?.addEventListener('resize',keyboard);document.addEventListener('focusout',()=>setTimeout(keyboard,0));
})();
