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
      onSaved:r=>{if(owner!==a)return;if(!r.active&&!r.released){a.claimed=false;onLost('Playback moved or the session expired. Select Resume here to continue.');}},
      onError:error=>{if(owner!==a)return;if([401,403,404].includes(error.status)){a.claimed=false;onLost('Your player session has ended. Reopen the lesson.');}else window.CourseForgeNative?.trackingNotice('Connection interrupted. Playback tracking will resume after reconnection.');}
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
    if(document.hidden){window.CourseForgeNative?.suspend();owner.onLost('Playback paused while this page was hidden. Select Resume here to continue.');heartbeat(false);}
    // Visible players reclaim only after a deliberate user action.
  });
  window.addEventListener('pagehide',close);
  window.addEventListener('offline',()=>{window.CourseForgeNative?.trackingNotice('You are offline. Watched time will not be estimated during the interruption.');});
  window.addEventListener('online',()=>{if(owner){owner.claimed=false;owner.onLost('Connection restored. Select Resume here to continue.');}});
  async function loadPreferences(){
    preferences=await api('/api/me/player-preferences');return preferences;
  }
  function setPreferences(change){
    Object.assign(preferences,change);clearTimeout(savePending);
    savePending=setTimeout(()=>api('/api/me/player-preferences',json('PUT',preferences)).catch(error=>toast('Player preference could not save: '+error.message,true)),300);
  }
  window.CourseForgePlayerSession={open,close,reclaim,heartbeat,loadPreferences,setPreferences,preferences:()=>({...preferences}),current:()=>owner?.id};
})();
