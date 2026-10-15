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
