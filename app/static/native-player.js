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
  function checkpointHit(list, previous, current){
    if(!Array.isArray(list))return null;
    for(const cp of list){
      if(!cp||cp.fired)continue;
      const start=Number(cp.start);
      if(!Number.isFinite(start))continue;
      const delta=current-previous;
      if(delta<=0||delta>=3)continue;
      if(previous<start&&current+0.05>=start)return cp;
    }
    return null;
  }
  function showCheckpoint(a, cp){
    if(!a||a.stage.querySelector('.player-checkpoint'))return;
    cp.fired=true;
    a.video.pause();
    const box=element('div','player-checkpoint');
    box.setAttribute('role','dialog');
    box.setAttribute('aria-label','Lecture checkpoint');
    box.append(element('p','','Checkpoint'), element('strong','',cp.prompt||'Check this idea'));
    const answer=element('p','checkpoint-answer',cp.answer||'');
    answer.hidden=true;
    const actions=element('div','');
    const reveal=element('button','btn btn-outline','Show the lecture answer');
    reveal.type='button';
    reveal.onclick=()=>{answer.hidden=false;reveal.hidden=true;};
    const cont=element('button','btn btn-primary','Continue');
    cont.type='button';
    cont.onclick=()=>{box.remove();a.video.play().catch(()=>{});};
    actions.append(reveal, cont);
    box.append(answer, actions);
    a.stage.append(box);
  }
  window.CourseForgeCheckpoints={hit:checkpointHit, show:showCheckpoint};
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
    v.id='nativeLecturePlayer';v.controls=true;v.playsInline=true;v.preload='auto';v.slot='media';
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
      if(!v.paused&&advanced>0&&advanced<3){
        const hit=checkpointHit(state.lessonCheckpoints, v.currentTime-advanced, v.currentTime);
        if(hit)showCheckpoint(a, hit);
      }
      window.CourseForgeStudio?.checkUpNext?.(lesson, v.currentTime, v.duration);
      // Buffer headroom monitor
      try {
        if (v.buffered && v.buffered.length > 0 && !v.paused && !a.reloading) {
          let ahead = 0;
          for (let i = 0; i < v.buffered.length; i++) {
            if (v.buffered.start(i) <= v.currentTime && v.buffered.end(i) >= v.currentTime) {
              ahead = v.buffered.end(i) - v.currentTime;
              break;
            }
          }
          if (ahead > 0) a.lastAdvance = performance.now();
        }
      } catch (_) {}
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
    a.timer=setInterval(()=>{if(active===a&&!a.reloading)a.send('heartbeat');},10000);
    a.watchdog=setInterval(()=>{if(active===a&&!a.recovery.busy()&&(v.readyState===0||a.wantsPlay&&!v.ended)&&performance.now()-a.lastAdvance>7000){a.lastAdvance=performance.now();a.recovery.fail(new Error('Playback stalled'));}},1500);
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
