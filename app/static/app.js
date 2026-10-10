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
function navigate(view, focusHeading=false){if(!navNames[view])view='dashboard';state.view=view;$$('[data-view]').forEach(el=>el.hidden=el.dataset.view!==view);$$('.nav-item').forEach(el=>{const selected=el.dataset.nav===view;el.classList.toggle('active',selected);if(selected)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});$('#topbarLocation').textContent=navNames[view];closeMobileMenu(false);window.location.hash=view;window.scrollTo({top:0,behavior:'instant'});if(focusHeading){const heading=$(`[data-view="${view}"] h1`);if(heading){heading.setAttribute('tabindex','-1');heading.focus({preventScroll:true})}}if(view!=='learning')window.CourseForgeAcademy?.leaveLesson();else if(state.currentVideoId&&!document.querySelector('#lecturePlayerWrap iframe, #lecturePlayerWrap video, #lecturePlayerWrap .player-loading, #lecturePlayerWrap .player-unavailable'))openVideo(state.currentVideoId).catch(err=>toast(err.message,true));if(view==='syllabus')loadSyllabus().catch(err=>toast(err.message,true));if(view==='reviews')loadDue().catch(err=>toast(err.message,true));if(view==='labs')loadLabs().catch(err=>toast(err.message,true));}
$$('[data-nav]').forEach(el=>el.addEventListener('click',event=>{event.preventDefault();navigate(el.dataset.nav,true);}));
function closeMobileMenu(restoreFocus=false){$('#sidebar').classList.remove('open');$('#mobileScrim').hidden=true;$('#mobileMenu').setAttribute('aria-expanded','false');if(restoreFocus)$('#mobileMenu').focus();}
$('#mobileMenu').addEventListener('click',()=>{const open=!$('#sidebar').classList.contains('open');$('#sidebar').classList.toggle('open',open);$('#mobileScrim').hidden=!open;$('#mobileMenu').setAttribute('aria-expanded',String(open));if(open)$('#sidebar .nav-item').focus();});
$('#mobileScrim').addEventListener('click',()=>closeMobileMenu(true));
window.addEventListener('hashchange',()=>{const view=location.hash.replace('#','');if(view!==state.view&&navNames[view])navigate(view)});
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
function groupCourses(){const groups=new Map();for(const video of state.videos){if(!groups.has(video.course))groups.set(video.course,[]);groups.get(video.course).push(video);}return [...groups].map(([name,videos])=>{const completed=videos.filter(v=>state.progress.get(v.id)?.completed).length;const watched=videos.reduce((acc,v)=>acc+(state.progress.get(v.id)?.percent||0),0);const percent=Math.round(watched/videos.length);const indexed=videos.filter(v=>v.status==='done').length;const lastActivity=Math.max(...videos.map(v=>Date.parse(state.progress.get(v.id)?.updated_at||'')||0),0);return {name,videos,completed,percent,indexed,lastActivity,...(state.courseMeta.get(name)||{})};}).sort((a,b)=>b.lastActivity-a.lastActivity||a.name.localeCompare(b.name));}
function formatDuration(seconds){const n=Number(seconds)||0;if(!n)return 'Duration not measured';const hours=Math.floor(n/3600);const minutes=Math.round((n%3600)/60);return hours?`${hours}h ${minutes}m`:`${minutes}m`;}
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
  body.append(make('div','course-category',course.indexed===course.videos.length?'AI-ready learning':'Your course library'));
  body.append(make('h3','',course.title||course.name));
  const length=course.videos.reduce((total,v)=>total+(Number(v.duration)||0),0);
  body.append(make('div','course-meta',`${course.videos.length} lessons · ${length?formatDuration(length)+' measured':'Duration not measured'}`));
  body.append(make('div','course-byline',course.instructor?`By ${course.instructor}`:'Instructor not provided'));
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
function renderSelects(){const courses=groupCourses();for(const id of ['#scope','#studyCourse','#lessonCourse']){const select=$(id);const old=select.value;select.replaceChildren();if(id==='#scope')select.add(new Option('Entire course library','all'));else if(id==='#studyCourse')select.add(new Option('Select indexed course',''));else select.add(new Option('All courses',''));for(const c of courses){if(id==='#studyCourse'&&!c.indexed)continue;select.add(new Option(`${c.name}${id==='#scope'?' ('+c.videos.length+')':''}`,id==='#scope'?'course:'+c.name:c.name));}if([...select.options].some(x=>x.value===old))select.value=old;else if(id==='#studyCourse'&&select.options.length>1)select.selectedIndex=1;}
  const scope=$('#scope');const selected=scope.value;for(const v of state.videos){scope.add(new Option(`↳ ${v.title}`,'video:'+v.id));}if([...scope.options].some(x=>x.value===selected))scope.value=selected;
}
function getViewerName(){return window.CourseForgeAccount?.user?.name || '';}
function openMaterialsModal(course=null){return window.CourseForgeAcademy?.materials(course);}
function renderLessons(){const course=$('#lessonCourse').value;const list=$('#courseList');list.replaceChildren();const groups=new Map();for(const video of state.videos.filter(v=>!course||v.course===course)){if(!groups.has(video.course))groups.set(video.course,[]);groups.get(video.course).push(video);}let index=0;for(const [name,lessons] of groups){list.append(make('div','lesson-course-label',name));for(const v of lessons){index++;const btn=make('button','lesson-link'+(state.currentVideoId===v.id?' active':''));btn.dataset.vid=v.id;btn.append(make('span','lesson-number',state.progress.get(v.id)?.completed?'':String(index).padStart(2,'0')));const t=make('span','lesson-text');t.append(make('span','name',v.title));const p=state.progress.get(v.id);const baseStatus=p?.completed?'Completed':p?.percent?`${p.percent}% complete`:v.cloud_ready?'Available':'Upload pending';t.append(make('span','status',`${formatDuration(v.duration)} · ${baseStatus}`));btn.append(t);btn.addEventListener('click',()=>openVideo(v.id).catch(err=>toast(err.message,true)));list.append(btn);}}
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
  const generation=++openingGeneration;
  window.CourseForgeNative?.stop();
  window.CourseForgeAcademy?.stopActivity();
  const {video,chunks}=await request(`/api/videos/${encodeURIComponent(id)}`);
  if(generation!==openingGeneration)return;
  state.selectedId=id;state.currentVideoId=id;
  window.CourseForgeAccount.lastLessons[video.course]=id;
  const player=$('#player');player.pause();player.hidden=true;
  $('#emptyPlayer').hidden=true;
  let wrap=document.getElementById('lecturePlayerWrap');
  if(!wrap){wrap=make('div','lecture-player-wrap');wrap.id='lecturePlayerWrap';player.parentElement.append(wrap);}
  wrap.replaceChildren(make('p','player-loading','Loading the lesson player…'));
  const start=at===null?(state.progress.get(id)?.position||0):at;
  try{
    const session=await request(`/api/videos/${encodeURIComponent(id)}/native-session`,services.json('POST',{start_pos:start}));
    if(generation!==openingGeneration)return;
    wrap.replaceChildren();
    window.CourseForgeNative.open(wrap,video,session,()=>{});
    wrap.append(window.CourseForgeNative.toolbar());
  }catch(error){
    if(generation!==openingGeneration)return;
    wrap.replaceChildren();const failure=make('div','player-unavailable');failure.append(make('h3','', 'Lecture unavailable'),make('p','',error.message));
    const retry=make('button','btn btn-outline','Retry');retry.onclick=()=>openVideo(id,start).catch(e=>toast(e.message,true));failure.append(retry);wrap.append(failure);
  }
  const toolbar=make('div','lecture-player-toolbar');
  const activity=make('span','muted','Lesson activity: 0m');activity.id='lessonActivityTimer';toolbar.append(activity);
  const theater=make('button','btn btn-outline','Theater mode');theater.onclick=()=>$('.learning-grid').classList.toggle('cinema-expanded');
  const full=make('button','btn btn-outline','Fullscreen');full.onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await wrap.requestFullscreen();}catch{toast('Fullscreen is unavailable in this browser.',true);}};
  const resources=make('button','btn btn-outline','Course resources');resources.onclick=()=>openMaterialsModal(video.course);
  const fallback=make('button','btn btn-outline','Use embedded player');fallback.onclick=async()=>{
    try{const point=window.CourseForgeNative.currentPosition()??start;
      window.CourseForgeNative.stop();
      const session=await request(`/api/videos/${encodeURIComponent(id)}/playback-session`,services.json('POST',{start_pos:point}));
      if(generation!==openingGeneration)return;
      const iframe=make('iframe');iframe.title=video.title;iframe.src=session.vault_url;iframe.allow='autoplay; fullscreen; encrypted-media';iframe.allowFullscreen=true;
      wrap.replaceChildren(iframe,toolbar);
      const resume=make('div','lecture-resume-point'),label=make('label','','Resume point'),input=make('input','form-input');
      input.value=prettyTime(point);input.setAttribute('aria-label','Manually saved resume timestamp');label.append(input);
      const save=make('button','btn btn-outline','Save resume point');save.onclick=async()=>{try{await request(`/api/videos/${id}/resume-point`,services.json('PUT',{position:window.CourseForgeAcademy.parseTimestamp(input.value)}));await loadLibrary();toast('Resume point saved.');}catch(error){toast(error.message,true);}};
      resume.append(label,save,make('small','muted','Embedded playback supports manually saved resume points.'));wrap.append(resume);
      $('#playingCourse').textContent='Odysee embedded lecture · Playback tracking unavailable in this mode';
    }catch(error){toast(error.message,true);}
  };
  const reload=make('button','btn btn-outline','Reload player');reload.onclick=()=>openVideo(id,window.CourseForgeNative.currentPosition()??start).catch(e=>toast(e.message,true));
  toolbar.append(theater,full,resources,reload,fallback);wrap.append(toolbar);
  $('#playingDetails').hidden=false;$('#playingTitle').textContent=video.title;
  $('#learningHeader').textContent=video.course;$('#learningSubhead').textContent=video.title;
  $('#playingCourse').textContent='Odysee cloud lecture · Automatic resume · Completion is self-reported';
  $('#playerProgressBar').style.width=(state.progress.get(id)?.percent||0)+'%';
  $('#markCompleteBtn').textContent=state.progress.get(id)?.completed?'Mark incomplete':'Mark complete';
  const timeline=$('#timeline');timeline.replaceChildren();
  if(!chunks.length)timeline.append(make('p','muted','A transcript is not available for this lecture yet.'));
  for(const chunk of chunks){
    const item=make('button','timeline-btn');item.type='button';item.append(make('span','',prettyTime(chunk.start)),make('div','',chunk.text||''));item.onclick=()=>openVideo(id,chunk.start).catch(error=>toast(error.message,true));timeline.append(item);
  }
  $('#lessonCourse').value=video.course;renderLessons();
  $('#lessonSummary').textContent='Generate a summary from indexed lecture evidence.';$('#noteText').value='';
  $('#notePosition').value=at===null?'00:00':prettyTime(at);
  if(start>0)toast(`Opening the lecture at ${prettyTime(start)}.`);
  await loadNotes(id);if(generation!==openingGeneration)return;navigate('learning');
  await window.CourseForgeAcademy?.startActivity(id,()=>generation===openingGeneration);
  await window.CourseForgeAcademy?.loadBookmarks(id);
}
$('#markCompleteBtn').addEventListener('click',async()=>{
  if(!state.currentVideoId)return;
  const id=state.currentVideoId,completed=Boolean(state.progress.get(id)?.completed);
  try{await request(`/api/videos/${id}/progress`,services.json('PUT',{percent:completed?0:100,position:state.progress.get(id)?.position||0}));
    await loadLibrary();$('#playerProgressBar').style.width=completed?'0%':'100%';$('#markCompleteBtn').textContent=completed?'Mark complete':'Mark incomplete';
    toast(completed?'Lesson marked incomplete.':'Lesson completion recorded as self-reported.');
  }catch(error){toast(error.message,true);}
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
async function loadSyllabus(){if(!selectedStudyCourse()){$('#syllabusSummary').textContent='Import and index a course to generate a learning path.';$('#syllabusItems').replaceChildren();return;}const {syllabus}=await request('/api/syllabus?course='+encodeURIComponent(selectedStudyCourse()));const target=$('#syllabusItems');target.replaceChildren();if(!syllabus){$('#syllabusSummary').textContent='No saved path yet. Click Build / refresh path.';return;}$('#syllabusSummary').textContent=`${syllabus.topics.length} unique topics · ${syllabus.duplicates_collapsed} overlaps merged · ${syllabus.video_count} lectures analyzed`;for(const topic of syllabus.topics){const node=make('div','topic');node.append(make('strong','',`${topic.order}. ${topic.title}`));if(topic.objectives?.length)node.append(make('p','',topic.objectives.join(' · ')));node.append(make('p','',`${topic.sources.length} lecture references`));for(const source of topic.sources){const btn=make('button','',`${source.video_title} · ${prettyTime(source.start)}`);btn.addEventListener('click',()=>openVideo(source.video_id,source.start).catch(err=>toast(err.message,true)));node.append(btn);}target.append(node);}}
$('#studyCourse').addEventListener('change',()=>{loadSyllabus().catch(err=>toast(err.message,true));loadDue().catch(()=>{})});
$('#loadSyllabusBtn').addEventListener('click',()=>loadSyllabus().catch(err=>toast(err.message,true)));
$('#buildSyllabusBtn').addEventListener('click',async()=>{const course=selectedStudyCourse();if(!course)return toast('Choose an indexed course first.',true);const btn=$('#buildSyllabusBtn');btn.disabled=true;$('#syllabusSummary').textContent='Your local AI is building the learning path…';try{await request('/api/syllabus/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({course})});await loadSyllabus();}catch(err){$('#syllabusSummary').textContent=err.message}finally{btn.disabled=false}});
async function loadDue(){const {cards}=await request('/api/reviews/due'+(selectedStudyCourse()?'?course='+encodeURIComponent(selectedStudyCourse()):''));state.dueCards=cards;showReview();}
function showReview(){state.activeCard=state.dueCards.shift()||null;$('#reviewCard').hidden=!state.activeCard;$('#reviewStatus').textContent=state.activeCard?`${state.dueCards.length+1} cards in this review session`:'No flashcards due. Generate cards from your indexed lectures to get started.';if(!state.activeCard)return;$('#reviewQuestion').textContent=state.activeCard.question;$('#reviewAnswer').textContent=state.activeCard.answer;$('#reviewAnswer').hidden=true;$('#reviewGrades').hidden=true;$('#revealAnswerBtn').hidden=false;}
$('#generateCardsBtn').addEventListener('click',async()=>{const course=selectedStudyCourse();if(!course)return toast('Select an indexed course in Study paths first.',true);const btn=$('#generateCardsBtn');btn.disabled=true;$('#reviewStatus').textContent='Generating source-grounded flashcards…';try{const result=await request('/api/reviews/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({course,topic:$('#reviewTopic').value.trim()||'key concepts',count:5})});await loadDue();toast(`${result.created} flashcards created.`)}catch(err){$('#reviewStatus').textContent=err.message}finally{btn.disabled=false}});
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
  $('#labFilename').textContent=`${session.filename} · Session ${session.session_id}`;
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
$('#submitLabBtn').addEventListener('click',async()=>{if(!state.currentLab)return;const btn=$('#submitLabBtn');btn.disabled=true;$('#labResult').textContent=state.currentLab.type==='static'?'Running static safety checks in restricted Docker…':'Running tests in isolated Docker…';try{await saveLab();const result=await request(`/api/lab-sessions/${state.currentLab.session_id}/submit`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({validate_in_kind:$('#kindCheck').checked})});const target=$('#labResult');target.replaceChildren();target.append(make('strong','',result.passed?'All checks passed':'Some checks need attention'));for(const check of result.checks||[])target.append(make('div','grade-check',`${check.passed?'PASS':'FAIL'} · ${check.name}${check.details?' — '+check.details:''}`));if(result.kind)target.append(make('div','grade-check',result.kind.skipped?result.kind.reason:result.kind.details));if(result.practice_attempt){target.append(make('p','muted',result.practice_attempt.passed?'Verified practice pass saved. Take another topic check to confirm understanding.':'Practice attempt saved. Review failed checks and retry.'));window.dispatchEvent(new CustomEvent('courseforge:practicegraded',{detail:result.practice_attempt}));}}catch(err){$('#labResult').textContent=err.message}finally{btn.disabled=false}});

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
$$('[data-lesson-tab]').forEach(button=>button.addEventListener('click',()=>{
  const name=button.dataset.lessonTab;
  $$('[data-lesson-tab]').forEach(tab=>{const selected=tab===button;tab.classList.toggle('active',selected);tab.setAttribute('aria-selected',String(selected));});
  $$('[data-lesson-panel]').forEach(panel=>panel.hidden=panel.dataset.lessonPanel!==name);
}));
$('#nextLessonBtn').addEventListener('click',()=>{const current=state.videos.find(v=>v.id===state.currentVideoId);if(!current)return;const lessons=state.videos.filter(v=>v.course===current.course);const next=lessons[lessons.findIndex(v=>v.id===current.id)+1];if(next)openVideo(next.id).catch(err=>toast(err.message,true));else toast('You have reached the last lesson in this course.');});
$('#generateSummaryBtn').addEventListener('click',async()=>{if(!state.currentVideoId)return toast('Choose a lesson first.',true);const btn=$('#generateSummaryBtn');btn.disabled=true;$('#lessonSummary').textContent='Generating from your indexed lecture…';try{const data=await request('/api/ask',services.json('POST',{question:'Summarize the learning objectives, key concepts, code or commands, and next steps from this lecture. Cite sources and timestamps.',mode:'notes',video_id:state.currentVideoId}));$('#lessonSummary').textContent=data.answer;}catch(err){$('#lessonSummary').textContent=err.message;}finally{btn.disabled=false}});
$('#guidedTutorBtn').addEventListener('click',()=>{state.mode='explain';$$('.mode').forEach(m=>m.classList.toggle('active',m.dataset.mode==='explain'));$('#question').value='Teach me a core concept from the selected course step by step. Start with intuition, then a worked example, then one question to check understanding. Include source timestamps.';navigate('tutor');$('#question').focus()});
$('#conceptCheckBtn').addEventListener('click',()=>{state.mode='quiz';$$('.mode').forEach(m=>m.classList.toggle('active',m.dataset.mode==='quiz'));$('#question').value='Give me one question to assess my understanding of the selected course, then explain the correct answer with a video citation. Do not claim to grade my knowledge without my response.';$('#question').focus()});
function recordConceptSignal(signal){const answer=state.lastAnswer;if(!answer)return;try{const history=JSON.parse(localStorage.getItem('courseforge-concept-feedback:'+window.CourseForgeAccount.user.id)||'[]');history.unshift({feedback:signal,summary:answer.slice(0,120),date:new Date().toISOString()});localStorage.setItem('courseforge-concept-feedback:'+window.CourseForgeAccount.user.id,JSON.stringify(history.slice(0,60)));}catch{}toast(signal==='confident'?'Confidence recorded on this device.':'Marked for extra practice on this device. Review the cited lecture next.');}
$('#conceptConfident').addEventListener('click',()=>recordConceptSignal('confident'));
$('#conceptUnsure').addEventListener('click',()=>recordConceptSignal('unsure'));
function renderPlannedLabs(){const target=$('#plannedLabs');target.replaceChildren();for(const text of ['No external networks', 'No Docker socket or production kubeconfig', 'Read-only solution mounts', 'CPU, memory and execution limits']){const card=make('div','planned-lab');card.append(make('strong','',text));target.append(card);}}
async function loadSettings(){$('#settingsPaths').textContent='Your learning records are private to your account. Course videos play through Odysee.';}
function syncGoal(){let value='30';try{value=localStorage.getItem('courseforge-daily-goal:'+window.CourseForgeAccount.user.id)||'30';}catch{}if(!['15','30','45','60'].includes(value))value='30';$('#goalMinutes').value=value;$('#settingsGoal').value=value;}
for(const selector of ['#goalMinutes','#settingsGoal'])$(selector).addEventListener('change',event=>{const value=event.target.value;try{localStorage.setItem('courseforge-daily-goal:'+window.CourseForgeAccount.user.id,value)}catch{}syncGoal();toast(`Daily target set to ${value} minutes on this device.`)});

window.CourseForgeBoot=async()=>{
  const initial=location.hash.slice(1);navigate(navNames[initial]?initial:'dashboard');
  await loadLibrary();await Promise.allSettled([loadSyllabus(),loadDue(),loadInsights(),loadLabs()]);
  renderPlannedLabs();syncGoal();await loadSettings();
};
setInterval(()=>{if(window.CourseForgeAccount?.user?.verified&&!document.hidden&&!$('#appShell').hidden)loadLibrary().catch(()=>{})},30000);
