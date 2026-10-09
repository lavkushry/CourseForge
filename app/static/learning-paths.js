/* P1 · cross-course learning roadmap; complements v3 without altering the core player. */
'use strict';
(() => {
let activeLearningPath=null;
function renderPathCourseChoices(){
  const list=$('#pathCourseChoices');
  const chosen=new Set($$('#pathCourseChoices input:checked').map(el=>el.value));
  list.replaceChildren();
  const available=groupCourses().filter(c=>c.indexed);
  if(!available.length){list.append(make('p','muted','No indexed courses yet. Scan and process lectures, then generate each course syllabus below.'));return;}
  for(const course of available){
    const label=make('label','path-course-option');
    const box=make('input');box.type='checkbox';box.value=course.name;box.checked=chosen.has(course.name);
    label.append(box,make('span','',course.title||course.name));list.append(label);
  }
}
function pathStatusMessage(message){$('#crossPathHint').textContent=message;}
async function loadLearningPaths(selectedId=null){
  const {paths}=await services.learningPaths();
  const target=$('#savedPathList');target.replaceChildren();
  if(!paths.length){target.append(make('p','muted','No saved roadmaps yet. Generate individual syllabi first, then build a combined plan.'));$('#crossPathDetail').hidden=true;return;}
  for(const path of paths){
    const button=make('button','saved-path');button.type='button';button.dataset.pathId=path.id;
    button.append(make('strong','',path.goal));
    button.append(make('small','',`${path.courses.length} courses · ${path.steps.length} topics · ${path.completion_percent}% completed${path.outdated?' · Needs refresh':''}`));
    button.setAttribute('aria-pressed',String((selectedId||activeLearningPath)===path.id));
    button.addEventListener('click',()=>showLearningPath(path.id).catch(err=>toast(err.message,true)));
    target.append(button);
  }
  const chosen=paths.find(x=>x.id===(selectedId||activeLearningPath))||paths[0];
  await showLearningPath(chosen.id);
}
async function showLearningPath(id){
  const path=await services.learningPath(id);activeLearningPath=path.id;
  $$('#savedPathList .saved-path').forEach(node=>node.setAttribute('aria-pressed',String(node.dataset.pathId===path.id)));
  $('#crossPathDetail').hidden=false;
  $('#crossPathTitle').textContent=path.goal;
  $('#crossPathMeta').textContent=`${path.courses.join(' + ')} · ${path.steps.length} unique topics · ${path.topics_collapsed} redundant sources grouped · ${path.inference==='ai'?'AI-suggested dependencies':'Conservative local rules'}`;
  $('#crossPathPercent').textContent=path.completion_percent+'%';
  $('#crossPathProgressBar').style.width=path.completion_percent+'%';
  pathStatusMessage(path.outdated?'Some source syllabi changed. Rebuild this path to include the latest indexed topics.':'Complete prerequisites first. Watched video links do not automatically mark a concept as mastered.');
  const list=$('#crossPathSteps');list.replaceChildren();
  const lookup=new Map(path.steps.map(s=>[s.id,s]));
  for(const step of path.steps){
    const unlocked=step.prerequisites.every(pre=>lookup.get(pre)?.completed);
    const card=make('article','cross-step'+(step.completed?' complete':''));
    const top=make('div','cross-step-head');
    const title=make('div');title.append(make('span','step-index',`STEP ${String(step.order).padStart(2,'0')}${step.goal_focus?' · Goal focus':''}`),make('h4','',step.title));
    const done=make('label','path-check');
    const box=make('input');box.type='checkbox';box.checked=Boolean(step.completed);box.disabled=!unlocked&&!step.completed;box.setAttribute('aria-label',`Mark ${step.title} ${step.completed?'incomplete':'complete'}`);
    box.addEventListener('change',async()=>{box.disabled=true;try{const updated=await services.completeLearningStep(path.id,step.id,box.checked);await showLearningPath(updated.id);await loadLearningPaths(updated.id);}catch(err){toast(err.message,true);box.checked=!box.checked;box.disabled=false;}});
    done.append(box,make('span','',step.completed?'Done':unlocked?'Mark done':'Locked'));
    top.append(title,done);card.append(top);
    if(step.objectives?.length)card.append(make('p','cross-objectives',step.objectives.join(' · ')));
    if(step.prerequisites.length){const req=make('p','path-prereqs','Requires: '+step.prerequisites.map(k=>lookup.get(k)?.title||'Unknown').join(', '));card.append(req)}
    const refs=make('div','cross-references');
    for(const source of step.sources){const btn=make('button','source-chip',`${source.course} · ${source.video_title} · ${prettyTime(source.start)}`);btn.type='button';btn.addEventListener('click',()=>openVideo(source.video_id,source.start).catch(err=>toast(err.message,true)));refs.append(btn)}
    card.append(refs);
    const mastery=step.mastery;
    const signal=make('div','assessment-topic-signal',mastery?`Latest practice: ${mastery.last_score}% · ${mastery.attempts} attempt${mastery.attempts===1?'':'s'} · ${mastery.status.replaceAll('_',' ')}`:'Not assessed yet');
    card.append(signal);
    const assess=make('button','btn btn-outline assessment-trigger',mastery?'Try another topic check':'Assess this topic');
    assess.type='button';assess.dataset.assessStep=step.id;
    assess.addEventListener('click',()=>window.CourseForgeAssessments.begin(path.id,step));
    card.append(assess);
    if(step.watched_sources)card.append(make('p','path-evidence',`${step.watched_sources} source video${step.watched_sources===1?'':'s'} watched. Confirm understanding before marking done.`));
    list.append(card);
  }
}
$('#crossPathForm').addEventListener('submit',async event=>{
  event.preventDefault();
  const courses=$$('#pathCourseChoices input:checked').map(x=>x.value);
  if(!courses.length)return toast('Select one or more indexed courses with generated syllabi.',true);
  if(courses.length>8)return toast('Choose at most eight courses.',true);
  const button=$('#createPathBtn');button.disabled=true;button.textContent='Planning topics and prerequisites…';
  try{const path=await services.createLearningPath(courses,$('#pathGoal').value.trim(),$('#pathUseAI').checked);
    await loadLearningPaths(path.id);toast(`${path.steps.length} source-linked steps ready.`);
  }catch(err){toast(err.message,true)}finally{button.disabled=false;button.textContent='Build cross-course roadmap →'}
});
$('#reloadPathsBtn').addEventListener('click',()=>loadLearningPaths().catch(err=>toast(err.message,true)));

async function initCrossPaths(){
  try {await loadLibrary();renderPathCourseChoices();await loadLearningPaths();}
  catch(err){toast(err.message,true)}
}
$$('[data-nav="syllabus"]').forEach(button=>button.addEventListener('click',()=>{
  renderPathCourseChoices();loadLearningPaths().catch(err=>toast(err.message,true));
}));
window.addEventListener('hashchange',()=>{if(location.hash==='#syllabus'){
  renderPathCourseChoices();loadLearningPaths().catch(err=>toast(err.message,true));
}});
window.CourseForgeLearningPaths = Object.freeze({show:showLearningPath});
initCrossPaths();
})();
