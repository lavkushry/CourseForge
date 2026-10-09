'use strict';
const $ = (selector) => document.querySelector(selector);
const state = {videos: [], mode: 'explain', selectedId: null, lastAnswer: '', currentVideoId: null};
const prettyTime = (seconds) => {const n = Math.max(0, Math.floor(Number(seconds)||0)); return `${String(Math.floor(n/3600)).padStart(2,'0')}:${String(Math.floor(n%3600/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`};
async function request(path, opts={}) {const r=await fetch(path, opts); const body=await r.json().catch(()=>({})); if(!r.ok) throw new Error(body.detail||`Request failed: ${r.status}`); return body;}
function notice(msg, err=false) {$('#notice').textContent=msg; $('#notice').className=err?'error':'';}
function make(tag, className='', text='') {const node=document.createElement(tag); if(className) node.className=className; if(text) node.textContent=text; return node;}
function currentScope() {const value=$('#scope').value; return value==='all'?{}:value.startsWith('video:')?{video_id:value.slice(6)}:{course:value.slice(7)};}
async function loadLibrary() {
  const [{videos}, {jobs}] = await Promise.all([request('/api/videos'),request('/api/jobs')]);
  state.videos=videos;
  $('#statVideos').textContent=videos.length;
  $('#statIndexed').textContent=videos.filter(v=>v.status==='done').length;
  const groups=new Map(); for(const v of videos){if(!groups.has(v.course))groups.set(v.course,[]);groups.get(v.course).push(v);}
  $('#statCourses').textContent=groups.size; $('#countLabel').textContent=`${videos.length} videos`;
  const list=$('#courseList'); list.replaceChildren(); if(!videos.length){const empty=make('p','meta','No lectures yet. Point COURSES_DIR to your video folder in .env, restart, then Scan Library.');empty.style.padding='12px';list.append(empty);} const scope=$('#scope'); const existing=scope.value; scope.replaceChildren(new Option('Entire library','all'));
  for(const [course,items] of groups){
    const header=make('div','course-heading'); const cbutton=make('button','',`▾ ${course}`);
    cbutton.addEventListener('click',()=>{scope.value='course:'+course;notice(`Filtering to ${course}.`)}); header.append(cbutton);list.append(header);
    scope.add(new Option(`${course} (${items.length})`,'course:'+course));
    for(const v of items){
      scope.add(new Option(`↳ ${v.title}`,'video:'+v.id));
      const b=make('button','video-link'+(state.selectedId===v.id?' active':''));
      b.append(make('span','name',v.title));
      b.append(make('span','status '+(v.status==='done'?'done':v.status==='failed'?'failed':''), `${v.status.toUpperCase()}${v.chunk_count?' · '+v.chunk_count+' excerpts':''}`));
      b.dataset.vid=v.id;
      b.addEventListener('click',()=>openVideo(v.id,null));list.append(b);
    }
  }
  if([...scope.options].some(o=>o.value===existing))scope.value=existing;
  const active=jobs.filter(j=>j.status==='processing'); const queued=jobs.filter(j=>j.status==='queued');const failed=jobs.filter(j=>j.status==='failed');
  $('#jobSummary').textContent=`${active.length} processing · ${queued.length} queued · ${failed.length} failed` + (active.length?`\n${active[0].title}\n${active[0].stage}`:'');
  await refreshStudy();
}
async function openVideo(id,at=null){
  try {
    const {video,chunks}=await request(`/api/videos/${encodeURIComponent(id)}`);
    state.selectedId=id;state.currentVideoId=id;lastPositionSaved=-1;
    const seekAt = at === null ? (currentProgress.get(id)?.position || 0) : at;
    $('#emptyPlayer').hidden=true;const player=$('#player');player.hidden=false;
    if(!player.src.endsWith(`/api/videos/${encodeURIComponent(id)}/stream`)){
      player.src=`/api/videos/${encodeURIComponent(id)}/stream`;player.load();
    }
    const seek=()=>{player.currentTime=Number(seekAt)||0;};
    if(player.readyState>=1)seek();else player.addEventListener('loadedmetadata',seek,{once:true});
    $('#playingDetails').hidden=false;$('#playingTitle').textContent=video.title;
    $('#playingCourse').textContent=`${video.course} · ${video.status} · ${prettyTime(video.duration)}`;
    const timeline=$('#timeline');timeline.replaceChildren();
    for(const chunk of chunks){
      const button=make('button','timeline-btn');const t=make('span','',prettyTime(chunk.start));button.append(t);
      button.append(document.createTextNode((chunk.kind==='screen'?'[Screen] ':'')+(chunk.text||'Screenshot without OCR text').slice(0,100)));
      button.addEventListener('click',()=>{player.currentTime=chunk.start;player.play().catch(()=>{});});
      timeline.append(button);
    }
    document.querySelectorAll('.video-link').forEach(b=>b.classList.remove('active'));
    notice(`Opened ${video.title} at ${prettyTime(seekAt)}.`);
  } catch(err){notice(err.message,true)}
}
async function ask(){
  const question=$('#question').value.trim();if(!question){notice('Enter a question first.',true);return}
  const btn=$('#askBtn');btn.disabled=true;btn.textContent='Thinking…';notice('Searching course material and generating an answer…');
  try {
    const result=await request('/api/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question,mode:state.mode,...currentScope()})});
    state.lastAnswer=result.answer;$('#answer').textContent=result.answer;$('#answerPanel').hidden=false;
    const container=$('#sources');container.replaceChildren();
    for(const src of result.sources){
      const b=make('button','source');b.append(make('strong','',`${src.label} · ${src.title}`));
      b.append(make('small','',`${src.course} · ${prettyTime(src.start)} · ${src.kind}${src.score!=null?' · similarity '+src.score:''}`));
      b.append(make('p','',(src.text||'Screen image').slice(0,185)));
      b.addEventListener('click',()=>openVideo(src.video_id,src.start));container.append(b);
      if(src.frame_path){const img=make('img');img.src=`/api/chunks/${encodeURIComponent(src.chunk_id)}/frame`;img.loading='lazy';img.alt='Extracted lecture screen';img.style.cssText='width:100%;max-height:150px;object-fit:contain;margin-top:8px;border-radius:6px';b.append(img);}
    }
    notice(`${result.sources.length} lecture excerpts retrieved. Citations are model-generated; verify important details against source clips.`);
  } catch(err){notice(err.message,true)}finally{btn.disabled=false;btn.textContent='Ask Tutor ↗'}
}
$('#scanBtn').addEventListener('click',async()=>{const btn=$('#scanBtn');btn.disabled=true;try{const outcome=await request('/api/scan',{method:'POST'});await loadLibrary();notice(`Scanned ${outcome.found} videos: ${outcome.imported} new, ${outcome.changed} changed. Worker handles queued jobs.`);}catch(err){notice(err.message,true)}finally{btn.disabled=false}});
$('#refreshBtn').addEventListener('click',()=>loadLibrary().catch(e=>notice(e.message,true)));
$('#askForm').addEventListener('submit',(e)=>{e.preventDefault();ask()});
document.querySelectorAll('.mode').forEach(btn=>btn.addEventListener('click',()=>{state.mode=btn.dataset.mode;document.querySelectorAll('.mode').forEach(b=>b.classList.toggle('active',b===btn));$('#question').placeholder=({explain:'Explain a topic from my downloaded lectures…',notes:'Create concise study notes about…',quiz:'Quiz me on this topic…',lab:'Give me a hands-on practice lab for…'})[state.mode]}));
$('#reindexBtn').addEventListener('click',async()=>{if(!state.currentVideoId)return;try{const result=await request(`/api/videos/${encodeURIComponent(state.currentVideoId)}/reindex`,{method:'POST'});notice(result.message);await loadLibrary()}catch(err){notice(err.message,true)}});
$('#copyBtn').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(state.lastAnswer);notice('Copied to clipboard.')}catch{notice('Copy failed; select the answer and copy manually.',true)}});
setInterval(()=>loadLibrary().catch(()=>{}),12000);

// Progress is saved for the current lecture. No external tracking service.
let lastPositionSaved = -1;
let currentLab = null;
let pendingCards = [];
let activeCard = null;
let currentProgress = new Map();
async function refreshStudy() {
  const {progress} = await request('/api/progress');
  currentProgress = new Map(progress.map(p => [p.video_id,p]));
  for(const node of document.querySelectorAll('.video-link[data-vid]')){
    const item = currentProgress.get(node.dataset.vid);
    const label = node.querySelector('.watch-status') || make('span','status watch-status');
    label.textContent = item?.completed ? '✓ Completed' : item?.percent ? `${item.percent}% watched` : 'Not started';
    if(!label.parentElement)node.append(label);
  }
  const total = progress.length; const done = progress.filter(x => x.completed).length;
  $('#studyProgressSummary')?.remove();
  const label = make('div','meta', `${done} / ${total} lectures completed`);
  label.id='studyProgressSummary';$('#syllabusPanel').append(label);
  const select=$('#studyCourse'); const previous=select.value;
  const courses=[...new Set(state.videos.filter(v=>v.status==='done').map(v=>v.course))];
  select.replaceChildren(new Option('Select indexed course',''));
  for (const course of courses) select.add(new Option(course,course));
  if (courses.includes(previous)) select.value=previous;
  else if(courses.length) select.value=courses[0];
}
async function recordPlayback(force=false) {
  const p=$('#player'); if(!state.currentVideoId || !Number.isFinite(p.duration) || !p.duration) return;
  const seconds=Math.round(p.currentTime);
  if(!force && Math.abs(seconds-lastPositionSaved)<12) return;
  lastPositionSaved=seconds;
  const progress=Math.min(100,Math.max(0,Math.round(100*seconds/p.duration)));
  const previously=currentProgress.get(state.currentVideoId)?.percent||0;
  await request(`/api/videos/${state.currentVideoId}/progress`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({percent:Math.max(progress,previously),position:seconds})});
}
$('#player').addEventListener('timeupdate',()=>recordPlayback().catch(()=>{}));
$('#markCompleteBtn').addEventListener('click',async()=>{
  if(!state.currentVideoId) return;
  try{await request(`/api/videos/${state.currentVideoId}/progress`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({percent:100,position:$('#player').currentTime||0})});await refreshStudy();notice('Lecture marked complete.');}catch(e){notice(e.message,true)}
});
$('#player').addEventListener('ended',async()=>{
  if(state.currentVideoId) await request(`/api/videos/${state.currentVideoId}/progress`, {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({percent:100,position:$('#player').duration})}).catch(()=>{});
  await refreshStudy().catch(()=>{});
});
const courseNow=()=>$('#studyCourse').value;
async function loadSyllabus() {
  if(!courseNow()){ $('#syllabusSummary').textContent='Import and index a course first.';return; }
  const {syllabus}=await request('/api/syllabus?course='+encodeURIComponent(courseNow()));
  const target=$('#syllabusItems');target.replaceChildren();
  if(!syllabus){$('#syllabusSummary').textContent='No saved syllabus. Click Build / refresh syllabus.';return;}
  $('#syllabusSummary').textContent=`${syllabus.topics.length} unique topics · ${syllabus.duplicates_collapsed} overlapping topic mentions merged · ${syllabus.video_count} lectures`;
  for(const topic of syllabus.topics){
    const node=make('div','topic');node.append(make('strong','',`${topic.order}. ${topic.title}`));
    if(topic.objectives?.length)node.append(make('p','',topic.objectives.join(' · ')));
    node.append(make('p','',`${topic.sources.length} lecture reference(s)`));
    for(const src of topic.sources){const btn=make('button','',`${src.video_title} at ${prettyTime(src.start)}`);
      btn.addEventListener('click',()=>openVideo(src.video_id,src.start));node.append(btn);}
    target.append(node);
  }
}
$('#studyCourse').addEventListener('change',()=>{loadSyllabus().catch(e=>notice(e.message,true));loadDue().catch(()=>{})});
$('#loadSyllabusBtn').addEventListener('click',()=>loadSyllabus().catch(e=>notice(e.message,true)));
$('#buildSyllabusBtn').addEventListener('click',async()=>{
  if(!courseNow()) return notice('Select an indexed course first.',true);
  const button=$('#buildSyllabusBtn'); button.disabled=true;$('#syllabusSummary').textContent='Building topics using local Ollama…';
  try{await request('/api/syllabus/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({course:courseNow()})});await loadSyllabus();}
  catch(e){$('#syllabusSummary').textContent=e.message;}finally{button.disabled=false;}
});
async function loadDue(){
  const {cards}=await request('/api/reviews/due'+(courseNow()?'?course='+encodeURIComponent(courseNow()):''));
  pendingCards=cards;showReview();
}
function showReview(){
  activeCard=pendingCards.shift()||null;
  $('#reviewCard').hidden=!activeCard;
  $('#reviewStatus').textContent=activeCard?`${pendingCards.length+1} cards due in this batch`:'No review cards due right now.';
  if(!activeCard)return;
  $('#reviewQuestion').textContent=activeCard.question;
  $('#reviewAnswer').textContent=activeCard.answer;
  $('#reviewAnswer').hidden=true;$('#reviewGrades').hidden=true;$('#revealAnswerBtn').hidden=false;
}
$('#generateCardsBtn').addEventListener('click',async()=>{
  if(!courseNow())return notice('Select a course first.',true);
  const btn=$('#generateCardsBtn');btn.disabled=true;$('#reviewStatus').textContent='Generating grounded flashcards…';
  try{const outcome=await request('/api/reviews/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({course:courseNow(),topic:$('#reviewTopic').value||'key concepts',count:5})});await loadDue();notice(`${outcome.created} cards created.`)}
  catch(e){$('#reviewStatus').textContent=e.message;}finally{btn.disabled=false;}
});
$('#loadDueBtn').addEventListener('click',()=>loadDue().catch(e=>notice(e.message,true)));
$('#revealAnswerBtn').addEventListener('click',()=>{$('#reviewAnswer').hidden=false;$('#revealAnswerBtn').hidden=true;$('#reviewGrades').hidden=false;});
document.querySelectorAll('[data-quality]').forEach(b=>b.addEventListener('click',async()=>{
  if(!activeCard)return; b.disabled=true;
  try{await request(`/api/reviews/${activeCard.id}/grade`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({quality:Number(b.dataset.quality)})});showReview();}
  catch(e){notice(e.message,true)}finally{b.disabled=false;}
}));
$('#reviewSource').addEventListener('click',()=>{if(activeCard)openVideo(activeCard.video_id,activeCard.source_start)});
async function loadLabs(){
  const {labs}=await request('/api/labs');const target=$('#labCatalog');target.replaceChildren();
  for(const lab of labs){const btn=make('button','lab-card');btn.append(make('strong','',lab.title));btn.append(make('small','',lab.objective));
    btn.addEventListener('click',async()=>{try{const session=await request(`/api/labs/${lab.slug}/start`,{method:'POST'});currentLab=session;
      $('#labEditor').hidden=false;$('#labTitle').textContent=session.title;
      $('#labObjective').textContent=session.objective;$('#labFilename').textContent=`Edit: ${session.filename} · Session: ${session.session_id}`;
      $('#labCode').value=session.content;$('#kindCheck').parentElement.hidden=session.type!=='kubernetes';$('#kindCheck').checked=false;
      $('#labResult').replaceChildren();}catch(e){notice(e.message,true)}});target.append(btn);}
}
async function saveLab(){if(!currentLab) return;return request(`/api/lab-sessions/${currentLab.session_id}/file`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:$('#labCode').value})})}
$('#saveLabBtn').addEventListener('click',async()=>{try{await saveLab();notice('Lab solution saved locally.')}catch(e){notice(e.message,true)}});
$('#submitLabBtn').addEventListener('click',async()=>{
  if(!currentLab)return;const btn=$('#submitLabBtn');btn.disabled=true;$('#labResult').textContent='Running verifications in isolated Docker container…';
  try{await saveLab();const r=await request(`/api/lab-sessions/${currentLab.session_id}/submit`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({validate_in_kind:$('#kindCheck').checked})});
    const target=$('#labResult');target.replaceChildren();target.append(make('strong','',r.passed?'All checks passed':'Some checks failed'));
    for(const check of r.checks) target.append(make('div','grade-check',`${check.passed?'PASS':'FAIL'} · ${check.name}${check.details?' — '+check.details:''}`));
    if(r.kind)target.append(make('div','grade-check',r.kind.skipped?r.kind.reason:r.kind.details));
  }catch(e){$('#labResult').textContent=e.message;}finally{btn.disabled=false;}
});
loadLabs().catch(e=>notice(e.message,true));
loadLibrary().then(()=>loadSyllabus()).then(()=>loadDue()).catch(e=>notice(e.message,true));
