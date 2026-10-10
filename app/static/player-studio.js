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
