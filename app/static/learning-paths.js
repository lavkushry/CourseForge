'use strict';
/* P1 cross-course paths: progressive enhancement over CourseForge Studio v3. */
(() => {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const api = window.CourseForgeServices;
  let activeId = null;
  const node = (tag, cls='', value='') => {
    const el = document.createElement(tag);
    if(cls) el.className=cls;
    if(value) el.textContent=value;
    return el;
  };
  const time = s => {
    const n=Math.max(0,Math.floor(Number(s)||0));
    return [Math.floor(n/3600),Math.floor(n%3600/60),n%60].map(x=>String(x).padStart(2,'0')).join(':');
  };
  const report = err => toast(err.message||String(err),true);
  function courseChoices() {
    const target=$('#pathCourseChoices');
    const old=new Set($$('#pathCourseChoices input:checked').map(x=>x.value));
    target.replaceChildren();
    const eligible=groupCourses().filter(x=>x.indexed);
    if(!eligible.length) {
      target.append(node('p','muted','Import and index your videos first, then build each course syllabus below.'));
      return;
    }
    for(const course of eligible) {
      const label=node('label','path-course-option');
      const input=node('input');input.type='checkbox';input.value=course.name;
      input.checked=old.has(course.name);
      label.append(input,node('span','',course.title||course.name));
      target.append(label);
    }
  }
  async function loadPaths(preferred=null) {
    const {paths}=await api.learningPaths();
    const target=$('#savedPathList');target.replaceChildren();
    if(!paths.length) {
      target.append(node('p','muted','No saved roadmaps yet. Build individual course syllabi, then create a combined plan.'));
      $('#crossPathDetail').hidden=true;
      return;
    }
    for(const path of paths) {
      const button=node('button','saved-path');
      button.type='button';button.dataset.pathId=path.id;
      button.append(node('strong','',path.goal));
      button.append(node('small','',path.courses.length+' courses · '+path.steps.length+' topics · '+path.completion_percent+'% complete'+(path.outdated?' · Refresh needed':'')));
      button.addEventListener('click',()=>showPath(path.id).catch(report));
      target.append(button);
    }
    const picked=paths.find(x=>x.id===(preferred||activeId))||paths[0];
    await showPath(picked.id);
  }
  async function showPath(id) {
    const path=await api.learningPath(id);
    activeId=path.id;
    $$('#savedPathList .saved-path').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.pathId===id)));
    $('#crossPathDetail').hidden=false;
    $('#crossPathTitle').textContent=path.goal;
    $('#crossPathMeta').textContent=path.courses.join(' + ')+' · '+path.steps.length+' unique topics · '+path.topics_collapsed+' overlaps grouped · '+(path.inference==='ai'?'AI-suggested prerequisites':'Conservative local rules');
    $('#crossPathPercent').textContent=path.completion_percent+'%';
    $('#crossPathProgressBar').style.width=path.completion_percent+'%';
    $('#crossPathHint').textContent=path.outdated
      ? 'One or more source syllabi changed. Rebuild this roadmap to incorporate the latest lessons.'
      : 'Mark a step complete when you understand it. Watching a video does not automatically establish mastery.';
    const target=$('#crossPathSteps');target.replaceChildren();
    const lookup=new Map(path.steps.map(s=>[s.id,s]));
    for(const step of path.steps) {
      const unlocked=step.prerequisites.every(p=>lookup.get(p)?.completed);
      const card=node('article','cross-step'+(step.completed?' complete':''));
      const header=node('div','cross-step-head'),description=node('div');
      description.append(node('span','step-index','STEP '+String(step.order).padStart(2,'0')+(step.goal_focus?' · Goal focus':'')));
      description.append(node('h4','',step.title));
      const done=node('label','path-check'),checkbox=node('input');
      checkbox.type='checkbox';checkbox.checked=Boolean(step.completed);
      checkbox.disabled=!unlocked&&!step.completed;
      checkbox.setAttribute('aria-label','Mark '+step.title+(step.completed?' incomplete':' complete'));
      checkbox.addEventListener('change',async()=>{
        const value=checkbox.checked;checkbox.disabled=true;
        try {
          await api.completeLearningStep(path.id,step.id,value);
          await loadPaths(path.id);
        } catch(err) {
          checkbox.checked=!value;checkbox.disabled=false;report(err);
        }
      });
      done.append(checkbox,node('span','',step.completed?'Done':unlocked?'Mark done':'Locked'));
      header.append(description,done);card.append(header);
      if(step.objectives?.length)card.append(node('p','cross-objectives',step.objectives.join(' · ')));
      if(step.prerequisites.length)card.append(node('p','path-prereqs','Requires: '+step.prerequisites.map(p=>lookup.get(p)?.title||'Unknown').join(', ')));
      const sources=node('div','cross-references');
      for(const source of step.sources) {
        const btn=node('button','source-chip',source.course+' · '+source.video_title+' · '+time(source.start));
        btn.type='button';
        btn.addEventListener('click',()=>openVideo(source.video_id,source.start).catch(report));
        sources.append(btn);
      }
      card.append(sources);
      if(step.watched_sources)card.append(node('p','path-evidence',step.watched_sources+' supporting source video(s) watched; confirm your understanding.'));
      target.append(card);
    }
  }
  $('#crossPathForm').addEventListener('submit',async e=>{
    e.preventDefault();
    const courses=$$('#pathCourseChoices input:checked').map(x=>x.value);
    if(!courses.length)return toast('Select an indexed course first.',true);
    if(courses.length>8)return toast('Choose up to eight courses.',true);
    const button=$('#createPathBtn');button.disabled=true;
    button.textContent='Planning topic prerequisites…';
    try {
      const path=await api.createLearningPath(courses,$('#pathGoal').value.trim(),$('#pathUseAI').checked);
      await loadPaths(path.id);
      toast(path.steps.length+' source-linked concepts ready.');
    } catch(err) {report(err)}
    finally {button.disabled=false;button.textContent='Build cross-course roadmap →'}
  });
  $('#reloadPathsBtn').addEventListener('click',()=>loadPaths().catch(report));
  function refresh() {
    courseChoices();
    loadPaths().catch(report);
  }
  $$('[data-nav="syllabus"]').forEach(button=>button.addEventListener('click',refresh));
  window.addEventListener('hashchange',()=>{if(location.hash==='#syllabus')refresh()});
  // The core v3 library load starts asynchronously in app.js.
  loadLibrary().then(()=>{courseChoices();loadPaths().catch(report)}).catch(report);
})();
