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
