/* Shared by populated browser captures and width regression tests. */
window.CourseForgeUIAudit = () => {
  const visible=e=>e.checkVisibility({checkVisibilityCSS:true,checkOpacity:true}) && e.getBoundingClientRect().width>0;
  const selector=e=>e.id?'#'+e.id:e.tagName.toLowerCase()+'.'+[...e.classList].join('.');
  const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};
  const root=document.querySelector('dialog[open]')||document;
  const elements=[...root.querySelectorAll('*')].filter(visible);
  // Only these existing content regions intentionally scroll horizontally.
  const scrollRegions='.row-track,.academy-table-wrap,.material-preview-content,.summary-content,.code-editor,.transcript-content';
  function intentional(e) {
    for(let p=e;p&&p!==document.body;p=p.parentElement) {
      if(p.matches('.sidebar') && getComputedStyle(p).transform!=='none' && !p.classList.contains('open'))return true;
      if(p.matches(scrollRegions) && ['auto','scroll'].includes(getComputedStyle(p).overflowX))return true;
    }
    return false;
  }
  const overflow=elements.filter(e=>{
    const r=e.getBoundingClientRect();
    return (r.left < -1 || r.right > innerWidth+1) && !intentional(e) &&
      !e.matches('svg,svg *,video,.billboard-backdrop,.billboard-vignette');
  }).map(e=>({selector:selector(e),rect:rect(e),text:(e.textContent||'').trim().slice(0,100)}));
  const interactive=window.CourseForgeComponents?.interactive||'button,a[href],input:not([type=hidden]),textarea,select,summary,[role=button],[role=tab]';
  const controls=elements.filter(e=>e.matches(interactive)||typeof e.onclick==='function');
  const clipped=controls.flatMap(e=>{
    if(intentional(e))return [];
    const r=e.getBoundingClientRect();
    let scrollableY=false;
    for(let p=e.parentElement;p&&p!==document.body;p=p.parentElement){
      const s=getComputedStyle(p),pr=p.getBoundingClientRect();
      if(['auto','scroll'].includes(s.overflowY))scrollableY=true;
      if((['hidden','clip'].includes(s.overflowX)&&(r.right>pr.right+2||r.left<pr.left-2))||
         (!scrollableY&&['hidden','clip'].includes(s.overflowY)&&(r.bottom>pr.bottom+2||r.top<pr.top-2)))
        return [{selector:selector(e),ancestor:selector(p),rect:rect(e),ancestorRect:rect(p)}];
    }
    return [];
  });
  const gridFailures=[];
  const grids=elements.filter(e=>e.matches('.course-grid,.academy-course-grid,.settings-grid,.lab-catalog,.academy-metrics,.week-grid,.lesson-materials-grid,.more-like-this-grid')&&getComputedStyle(e).display==='grid')
    .map(e=>{
      const style=getComputedStyle(e),columns=style.gridTemplateColumns.split(' ').map(parseFloat);
      const items=[...e.children].filter(visible);
      const rows=[];
      for(const item of items){
        if(!item.matches('.course-tile,[data-ui-component="card"],.week-day'))continue;
        const r=item.getBoundingClientRect();let row=rows.find(row=>Math.abs(row[0].getBoundingClientRect().top-r.top)<2);
        if(getComputedStyle(item).gridColumn==='1 / -1'){
          const contentWidth=e.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
          if(Math.abs(r.width-contentWidth)>2)gridFailures.push({selector:selector(item),reason:'spanning empty state does not fill the grid',rect:rect(item)});
          continue;
        }
        if(!row)rows.push(row=[]);row.push(item);
        if(!columns.some(w=>Math.abs(w-r.width)<2))gridFailures.push({selector:selector(item),reason:'card does not fill its grid column',rect:rect(item),columns});
      }
      for(const row of rows){
        const boxes=row.map(e=>(e.querySelector(':scope > .course-card')||e).getBoundingClientRect());
        if(boxes.length>1 && Math.max(...boxes.map(r=>r.height))-Math.min(...boxes.map(r=>r.height))>2)
          gridFailures.push({selector:selector(e),reason:'unequal card heights within a row',heights:boxes.map(r=>r.height)});
      }
      return {selector:selector(e),rect:rect(e),columns:style.gridTemplateColumns,gap:style.gap,items:items.map(e=>({selector:selector(e),rect:rect(e)}))};
    });
  const componentNames=new Set(['button','input','select','card','chip','row','modal','tab']);
  const unmapped=controls.filter(e=>!componentNames.has(e.dataset.uiComponent)).map(selector);
  const badIcons=elements.filter(e=>e.matches('svg.icon,.player-button svg')).filter(e=>{
    const r=e.getBoundingClientRect();return ![16,20,24].some(n=>Math.abs(r.width-n)<.2&&Math.abs(r.height-n)<.2);
  }).map(e=>({selector:selector(e),rect:rect(e)}));
  return {width:innerWidth,documentWidth:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,
    overflow,clipped,grids,gridFailures,unmapped,badIcons,
    controls:controls.map(e=>({selector:selector(e),component:e.dataset.uiComponent,variant:e.dataset.uiVariant,rect:rect(e)}))};
};
