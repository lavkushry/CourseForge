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
function navigate(view, focusHeading=false){if(!navNames[view])view='dashboard';state.view=view;$$('[data-view]').forEach(el=>el.hidden=el.dataset.view!==view);$$('.nav-item').forEach(el=>{const selected=el.dataset.nav===view;el.classList.toggle('active',selected);if(selected)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});$('#topbarLocation').textContent=navNames[view];$('#universalSearchResults').hidden=true;window.dispatchEvent(new Event('courseforge-navigate'));closeMobileMenu(false);document.body.classList.toggle('in-learning',view==='learning');if(!applyingRoute){const hash=view==='learning'&&state.currentVideoId?lessonHash(state.currentVideoId):'#'+view;if(location.hash!==hash)history.pushState(null,'',hash);}window.scrollTo({top:0,behavior:'instant'});if(focusHeading){const heading=$(`[data-view="${view}"] h1`);if(heading){heading.setAttribute('tabindex','-1');heading.focus({preventScroll:true})}}if(view!=='learning')window.CourseForgeAcademy?.leaveLesson();else if(state.currentVideoId&&!document.querySelector('#lecturePlayerWrap iframe, #lecturePlayerWrap video, #lecturePlayerWrap .player-loading, #lecturePlayerWrap .player-unavailable'))openVideo(state.currentVideoId).catch(err=>toast(err.message,true));if(view==='syllabus')loadSyllabus().catch(err=>toast(err.message,true));if(view==='reviews')loadDue().catch(err=>toast(err.message,true));if(view==='labs')loadLabs().catch(err=>toast(err.message,true));}
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
  cover.append(make('span','cover-label',course.category||category));cover.append(make('span','cover-symbol',symbol));
  if(course.cover_url){const img=make('img','course-cover-img');img.src=course.cover_url+'?rev='+state.coverRevision;img.alt='';img.loading='lazy';img.decoding='async';img.addEventListener('load',()=>cover.classList.add('has-image'));img.addEventListener('error',()=>img.remove());cover.append(img);}
  button.append(cover);
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
function renderCatalog(){const all=groupCourses();updateHeroAction();const totalMats=(state.materials||[]).length;$('#featuredCourses').setAttribute('aria-busy','false');$('#courseCatalog').setAttribute('aria-busy','false');$('#statCourses').textContent=all.length;$('#statVideos').textContent=state.videos.length;$('#statIndexed').textContent=state.videos.filter(v=>v.status==='done').length;$('#statCompleted').textContent=state.videos.filter(v=>state.progress.get(v.id)?.completed).length;$('#sideCourseCount').textContent=all.length;$('#countLabel').textContent=`${state.videos.length} lessons · ${totalMats} materials`;
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
        btn.dataset.vid=item.id;btn.href='#learning/'+encodeURIComponent(item.id);
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
