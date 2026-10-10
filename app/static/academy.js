'use strict';
(() => {
  const el=id=>document.getElementById(id);
  const api=window.CourseForgeServices.request;
  const json=window.CourseForgeServices.json;
  const account=window.CourseForgeAccount={user:null,csrf:'',lastLessons:{}};
  const node=(tag,cls='',text='')=>{const n=document.createElement(tag);n.className=cls;n.textContent=text;return n;};
  const button=(text,action,primary=false)=>{const b=node('button',primary?'btn btn-primary':'btn btn-outline',text);b.type='button';b.onclick=()=>Promise.resolve().then(action).catch(error=>message(error.message,true));return b;};
  const minutes=seconds=>`${Math.floor((seconds||0)/60)}m`;
  const date=value=>value?new Date(value).toLocaleString():'—';
  const message=(text,error=false)=>{el('academyMessage').textContent=text;el('academyMessage').classList.toggle('error',error);el('academyMessage').hidden=false;};
  const clearMessage=()=>{el('academyMessage').hidden=true;};
  const resetBrowser=()=>{history.replaceState(null,'','/');location.reload();};
  function page(title){
    stopActivity();el('appShell').hidden=true;el('academyContent').hidden=false;
    const root=el('academyContent');root.replaceChildren(node('h1','',title));clearMessage();return root;
  }
  function table(headers,rows){
    const wrap=node('div','academy-table-wrap'),t=node('table','academy-table'),head=node('thead'),hrow=node('tr');
    headers.forEach(h=>hrow.append(node('th','',h)));head.append(hrow);t.append(head);
    const body=node('tbody');
    rows.forEach(values=>{const tr=node('tr');values.forEach(value=>{const td=node('td');if(value instanceof Node)td.append(value);else td.textContent=String(value??'—');tr.append(td);});body.append(tr);});
    if(!rows.length){const tr=node('tr'),td=node('td','muted','No records yet.');td.colSpan=headers.length;tr.append(td);body.append(tr);}
    t.append(body);wrap.append(t);return wrap;
  }
  function heading(root,title,text){root.append(node('h2','',title));if(text)root.append(node('p','muted',text));}
  function field(form,label,name,type='text',required=true){
    const l=node('label','field');l.append(node('span','',label));const i=node('input','form-input');i.name=name;i.type=type;i.required=required;
    if(type==='password')i.maxLength=128;form.append(l);l.append(i);return i;
  }
  function form(root,title,submit){
    const f=node('form','academy-form panel');if(title)f.append(node('h2','',title));
    f.onsubmit=async event=>{event.preventDefault();const b=f.querySelector('[type=submit]');if(b)b.disabled=true;clearMessage();try{await submit(new FormData(f));}catch(error){message(error.message,true);}finally{if(b)b.disabled=false;}};
    root.append(f);return f;
  }
  function submitButton(f,text){const b=node('button','btn btn-primary',text);b.type='submit';f.append(b);return b;}

  async function catalog(){
    const root=page('Build skills from your course library');
    root.append(node('p','academy-lead','Learn with organized lectures, course resources, source-linked explanations, and a personal study plan.'));
    const search=node('input','form-input catalog-search');search.type='search';search.placeholder='Search courses, instructors, or topics';search.setAttribute('aria-label','Search published courses');root.append(search);
    const cards=node('div','academy-course-grid');root.append(cards);
    const {courses}=await api('/api/public/courses');
    const render=()=>{cards.replaceChildren();const needle=search.value.toLowerCase();
      const visible=courses.filter(c=>[c.title,c.instructor,...c.tags].join(' ').toLowerCase().includes(needle));
      for(const c of visible){const card=node('article','academy-course panel');
        const category=node('div','academy-course-category',c.category||'Course');card.append(category,node('h2','',c.title),node('p','muted',c.instructor||''),node('p','',c.description||''));
        card.append(node('p','muted',`${c.lesson_count} lessons · ${c.available_lessons} available`));
        card.append(button(c.enrolled?'View your course':'View syllabus',()=>courseDetail(c.id),true));cards.append(card);}
      if(!visible.length)cards.append(node('p','muted',courses.length?'No courses match this search.':'No courses have been published yet.'));
    };search.oninput=render;render();
  }
  async function courseDetail(id){
    const c=await api(`/api/public/courses/${encodeURIComponent(id)}`);const root=page(c.title);
    root.append(button('Back to courses',catalog),node('p','academy-lead',c.description||''),node('p','muted',[c.instructor,c.category,`${c.lesson_count} lessons`].filter(Boolean).join(' · ')));
    root.append(button(c.enrolled?'Continue learning':'Enroll for free',async()=>{
      if(!account.user)return signIn();
      await api(`/api/courses/${encodeURIComponent(id)}/enroll`,json('POST',{}));
      await workspace();const course=state.courseMeta.get(id);if(course)openCourse({...course,name:id});
    },true));
    heading(root,'Course syllabus');root.append(table(['Lesson','Duration','Availability'],c.lessons.map(l=>[l.title,l.duration?minutes(l.duration):'Not measured',l.available?'Available':'Upload pending'])));
  }
  function signIn(mode='login'){
    const root=page(mode==='register'?'Create your account':mode==='forgot'?'Reset your password':mode==='resend'?'Resend verification':'Welcome back');
    const f=form(root,'',async data=>{
      const payload=Object.fromEntries(data);const result=await api('/api/auth/'+mode,json('POST',payload));
      if(mode==='login'){location.reload();return;}
      message(result.message);f.reset();
    });
    if(mode==='register'){const n=field(f,'Name','name');n.maxLength=120;n.autocomplete='name';}
    const email=field(f,'Email address','email','email');email.autocomplete='email';email.maxLength=254;
    if(mode==='login'||mode==='register'){const password=field(f,'Password','password','password');password.autocomplete=mode==='login'?'current-password':'new-password';if(mode==='register'){password.minLength=12;f.append(node('p','muted','Use at least 12 characters.'));}}
    submitButton(f,mode==='login'?'Sign in':mode==='register'?'Create account':'Send email');
    root.append(button(mode==='register'?'Already registered? Sign in':'Create an account',()=>signIn(mode==='register'?'login':'register')),
      button('Forgot password',()=>signIn('forgot')),button('Resend verification',()=>signIn('resend')));
  }
  async function workspace(){
    if(!account.user)return signIn();
    if(!account.user.verified){signIn('resend');message('Verify your email before enrolling or opening lessons.');return;}
    el('academyContent').hidden=true;el('appShell').hidden=false;clearMessage();
    const learning=await api('/api/me/learning');account.lastLessons=Object.fromEntries(learning.courses.map(c=>[c.course,c.last_video_id]));
    await window.CourseForgeBoot();window.dispatchEvent(new Event('courseforge-ready'));
  }
  async function myAccount(){
    if(!account.user)return signIn();
    const root=page('Your account');root.append(node('p','muted',account.user.email));
    const f=form(root,'Profile and password',async data=>{
      const body={name:data.get('name')};if(data.get('password')){body.password=data.get('password');body.current_password=data.get('current_password');}
      const result=await api('/api/me',json('PATCH',body));account.user=result.user;message('Account updated.');
    });
    field(f,'Name','name').value=account.user.name;field(f,'Current password (for password changes)','current_password','password',false).autocomplete='current-password';
    const password=field(f,'New password (optional)','password','password',false);password.minLength=12;password.autocomplete='new-password';submitButton(f,'Save account');
    heading(root,'Signed-in devices');const sessions=await api('/api/auth/sessions');
    root.append(table(['Device','Last active','Session'],sessions.sessions.map(s=>[s.device||'Browser',date(s.last_seen),s.current?'This device':button('Revoke',async()=>{await api(`/api/auth/sessions/${s.id}`,{method:'DELETE'});await myAccount();})])));
    heading(root,'Learning and access data','We record lesson activity, self-reported completion, assessment results, and access events. Visible lesson activity is an estimate of time in the lesson page; it does not prove video playback or attention. Access logs are kept for 30 days and activity events for 90 days. Your learning records remain until account deletion. Administrators can review learning and access records.');
    if(account.user.role!=='admin'){
      const deletion=form(root,'Delete your account and learning records',async data=>{await api('/api/me',json('DELETE',{password:data.get('password')}));resetBrowser();});
      field(deletion,'Confirm password','password','password');submitButton(deletion,'Delete my account');
    }
  }
  async function adminHome(){
    location.hash='admin';const root=page('Administration');
    root.append(button('Students',adminUsers),button('Courses',adminCourses),button('Refresh',adminHome));
    const report=await api('/api/admin/overview');
    const metrics=node('div','academy-metrics');
    for(const [label,value] of [['Students',report.summary.students],['Enrollments',report.summary.enrollments],['Reported completions',report.summary.completed_lessons],['Lesson activity',minutes(report.summary.activity_seconds)],['Available lectures',`${report.summary.available_lectures}/${report.summary.lectures}`],['Recent sessions',report.summary.active_sessions]]){
      const card=node('div','panel metric-card');card.append(node('span','muted',label),node('strong','',String(value)));metrics.append(card);
    }root.append(metrics);
    heading(root,'Recent student activity',report.activity_basis+'. '+report.completion_basis+'.');
    root.append(table(['Student','Activity','Lecture','Time'],report.recent_activity.map(e=>[e.name,e.event_type.replaceAll('_',' '),e.title||e.details,date(e.created_at)])));
    heading(root,'Course enrollment funnel');root.append(table(['Course','Enrolled','Started'],report.funnels.map(r=>[r.course,r.enrolled,r.started])));
    heading(root,'Recent access events');root.append(table(['Event','IP address','Device','Time'],report.access_events.map(e=>[e.event_type.replaceAll('_',' '),e.ip,e.device,date(e.created_at)])));
  }
  async function adminUsers(query='',offset=0){
    const root=page('Student management');root.append(button('Administration',adminHome));
    const searchForm=form(root,'Find a student',data=>adminUsers(data.get('q')));field(searchForm,'Name or email','q','search',false).value=query;submitButton(searchForm,'Search');
    const result=await api(`/api/admin/users?q=${encodeURIComponent(query)}&offset=${offset}`);
    root.append(node('p','muted',`${result.total} accounts`));
    root.append(table(['Student','Email','Status','Courses','Completion','Lesson activity','Details'],result.users.map(u=>[u.name,u.email,u.suspended?'Suspended':u.verified?'Verified':'Unverified',u.enrollments,u.completed_lessons,minutes(u.activity_seconds),button('Inspect',()=>adminStudent(u.id))])));
    const pager=node('div','toolbar');if(offset)pager.append(button('Previous',()=>adminUsers(query,Math.max(0,offset-25))));if(offset+25<result.total)pager.append(button('Next',()=>adminUsers(query,offset+25)));root.append(pager);
    const create=form(root,'Create a student account',async data=>{const r=await api('/api/admin/users',json('POST',Object.fromEntries(data)));message(r.message);create.reset();});
    field(create,'Name','name');field(create,'Email','email','email');field(create,'Initial password','password','password').minLength=12;submitButton(create,'Create and send verification');
  }
  async function adminStudent(uid){
    const r=await api(`/api/admin/users/${uid}`),root=page(r.user.name);
    root.append(button('Back to students',adminUsers),node('p','muted',`${r.user.email} · ${r.user.role} · ${r.user.suspended?'Suspended':r.user.verified?'Verified':'Unverified'}`));
    const actions=node('div','toolbar');
    if(r.user.role!=='admin')actions.append(button(r.user.suspended?'Restore account':'Suspend account',async()=>{await api(`/api/admin/users/${uid}`,json('PATCH',{suspended:!r.user.suspended}));await adminStudent(uid);}));
    actions.append(button('Revoke all sessions',async()=>{await api(`/api/admin/users/${uid}/sessions`,{method:'DELETE'});await adminStudent(uid);}));root.append(actions);
    root.append(node('p','academy-lead',`${minutes(r.activity_seconds)} of recorded lesson activity · ${r.note_count} saved notes`));
    heading(root,'Course access');root.append(table(['Course','Enrolled','Access'],r.enrollments.map(e=>[e.course,date(e.created_at),button('Revoke course access',async()=>{await api(`/api/admin/users/${uid}/enrollments`,json('PUT',{course:e.course,enrolled:false}));await adminStudent(uid);})])));
    const courses=await api('/api/admin/courses');const grant=form(root,'Grant a course',async data=>{await api(`/api/admin/users/${uid}/enrollments`,json('PUT',{course:data.get('course'),enrolled:true}));await adminStudent(uid);});
    const select=node('select','form-input');select.name='course';select.required=true;select.setAttribute('aria-label','Course to grant');courses.courses.forEach(c=>select.add(new Option(c.title,c.id)));grant.append(select);submitButton(grant,'Grant course access');
    heading(root,'Lesson completion','Students report completion themselves. This is separate from assessment and lab performance.');root.append(table(['Lecture','Course','Completion','Updated'],r.lessons.map(l=>[l.title,l.course,l.completed?'Reported complete':'Incomplete',date(l.updated_at)])));
    heading(root,'Last opened lessons');root.append(table(['Lecture','Course','Opened'],r.recent_lessons.map(l=>[l.title,l.course,date(l.updated_at)])));
    heading(root,'Assessment results');root.append(table(['Topic','Score','Correct','Completed'],r.assessments.map(a=>[a.step_id,`${a.score}%`,`${a.correct_count}/${a.total_count}`,date(a.completed_at)])));
    heading(root,'Practice labs');root.append(table(['Lab','Status','Updated'],r.labs.map(l=>[l.slug,l.status,date(l.updated_at)])));
    heading(root,'Recall practice');root.append(table(['Self-rating (0–5)','Reviewed'],r.reviews.map(a=>[a.quality,date(a.reviewed_at)])));
    heading(root,'Study plans');root.append(table(['Date','Budget','Updated'],r.plans.map(a=>[a.study_date,`${a.budget_minutes}m`,date(a.updated_at)])));
    heading(root,'Focus sessions');root.append(table(['Title','Mode','Status','Configured duration'],r.focus.map(a=>[a.title,a.mode,a.status,minutes(a.duration_seconds)])));
    heading(root,'Devices and access');root.append(table(['Device','IP address','Last active','Expires'],r.sessions.map(s=>[s.device,s.ip,date(s.last_seen),date(s.expires_at)])));
    heading(root,'Learning history');root.append(table(['Activity','Lecture','Time'],r.activity.map(a=>[a.event_type.replaceAll('_',' '),a.title||a.details,date(a.created_at)])));
    heading(root,'Access history');root.append(table(['Event','IP','Device','Time'],r.access.map(a=>[a.event_type.replaceAll('_',' '),a.ip,a.device,date(a.created_at)])));
  }
  async function adminCourses(){
    const root=page('Course publishing');root.append(button('Administration',adminHome));const result=await api('/api/admin/courses');
    for(const c of result.courses){const f=form(root,c.title,async data=>{await api(`/api/admin/courses/${encodeURIComponent(c.id)}/publication`,json('PUT',{published:data.get('published')==='on',description:data.get('description')}));message('Course publication updated.');});
      f.append(node('p','muted',`${c.available_lessons}/${c.lesson_count} lectures mapped to Odysee`));
      const l=node('label','field');l.append(node('span','','Course description'));const d=node('textarea','form-input');d.name='description';d.maxLength=5000;d.rows=4;d.value=c.description;l.append(d);f.append(l);
      const publish=node('label');const check=node('input');check.name='published';check.type='checkbox';check.checked=Boolean(c.published);publish.append(check,document.createTextNode(' Published in public catalog'));f.append(publish);submitButton(f,'Save publication');
    }
    const map=form(root,'Map an Odysee lecture',async data=>{await api(`/api/admin/videos/${encodeURIComponent(data.get('video_id'))}/provider`,json('PUT',{claim_name:data.get('claim_name'),claim_id:data.get('claim_id')}));message('Lecture mapping saved.');});
    const videos=await api('/api/videos');const select=node('select','form-input');select.name='video_id';select.required=true;select.setAttribute('aria-label','Lecture to map');videos.videos.forEach(v=>select.add(new Option(`${v.course} / ${v.title}`,v.id)));map.append(select);
    field(map,'Odysee claim name','claim_name');const claim=field(map,'Odysee claim ID','claim_id');claim.pattern='[0-9a-fA-F]{40}';submitButton(map,'Save mapping');
  }
  async function materials(course){
    const root=el('resourcesDialog');root.replaceChildren(node('h2','','Course resources'),button('Close',()=>root.close()));root.showModal();
    try{const data=await api('/api/materials'+(course?'?course='+encodeURIComponent(course):''));
      root.append(table(['Course','Resource','Type','Size','Open'],data.materials.map(m=>{const link=node('a','text-link','View resource');link.href=m.url;link.target='_blank';link.rel='noopener';return [m.course,m.name,m.ext,`${m.size_kb} KB`,link];})));}
    catch(error){root.append(node('p','field-error',error.message));}
  }
  let activity=null;
  function stopActivity(){activity=null;}
  async function startActivity(id,current=true){
    if(!current)return;const r=await api(`/api/videos/${id}/activity-session`,json('POST',{}));
    if(state.currentVideoId!==id||el('appShell').hidden)return;
    activity={id:r.id,sequence:0,last:performance.now(),visible:document.visibilityState==='visible',pending:false};
  }
  async function heartbeat(){
    const a=activity;if(!a||a.pending)return;
    const now=performance.now(),visible=document.visibilityState==='visible'&&!el('appShell').hidden&&state.view==='learning';
    const elapsed=a.visible&&visible?Math.min(20,(now-a.last)/1000):0;a.last=now;a.visible=visible;a.pending=true;
    try{const r=await api(`/api/activity/${a.id}/heartbeat`,json('POST',{sequence:++a.sequence,visible,elapsed_seconds:elapsed}));
      if(activity===a&&el('lessonActivityTimer'))el('lessonActivityTimer').textContent='Lesson activity: '+minutes(r.activity_seconds);}
    catch(error){if(error.status===401||error.status===403||error.status===404)stopActivity();}
    finally{a.pending=false;}
  }
  setInterval(heartbeat,15000);document.addEventListener('visibilitychange',heartbeat);
  function parseTimestamp(value){
    if(!/^\d+(?::[0-5]\d){0,2}$/.test(value.trim()))throw new Error('Use seconds, MM:SS, or HH:MM:SS for the timestamp.');
    const seconds=value.trim().split(':').reduce((sum,part)=>sum*60+Number(part),0);if(seconds>=1e9)throw new Error('Timestamp is too large.');return seconds;
  }
  async function loadBookmarks(id){
    const data=await api(`/api/videos/${id}/bookmarks`);if(id!==state.currentVideoId)return;
    const list=el('bookmarksList');list.replaceChildren();
    for(const b of data.bookmarks){const row=node('div','saved-note');row.append(node('strong','',`${prettyTime(b.position)} · ${b.label}`),button('Delete',async()=>{await api(`/api/bookmarks/${b.id}`,{method:'DELETE'});await loadBookmarks(id);}));list.append(row);}
    if(!data.bookmarks.length)list.append(node('p','muted','No bookmarks for this lecture yet.'));
  }
  el('bookmarkForm').onsubmit=async e=>{e.preventDefault();if(!state.currentVideoId)return;try{await api(`/api/videos/${state.currentVideoId}/bookmarks`,json('POST',{position:parseTimestamp(el('bookmarkPosition').value),label:el('bookmarkLabel').value}));await loadBookmarks(state.currentVideoId);el('bookmarkLabel').value='';}catch(error){toast(error.message,true);}};
  el('lessonSearch').oninput=e=>{const query=e.target.value.toLowerCase();document.querySelectorAll('.lesson-link').forEach(link=>link.hidden=!link.textContent.toLowerCase().includes(query));};
  el('previousLessonBtn').onclick=()=>{const current=state.videos.find(v=>v.id===state.currentVideoId);if(!current)return;const lessons=state.videos.filter(v=>v.course===current.course),previous=lessons[lessons.findIndex(v=>v.id===current.id)-1];if(previous)openVideo(previous.id).catch(error=>toast(error.message,true));else toast('You are at the first lesson.');};
  window.CourseForgeAcademy={materials,stopActivity,startActivity,loadBookmarks,parseTimestamp};
  window.addEventListener('courseforge-session-expired',()=>{account.user=null;account.csrf='';resetBrowser();});
  window.addEventListener('courseforge-task',()=>toast('Learning task queued. This view will update when it finishes.'));
  el('catalogNav').onclick=()=>catalog().catch(e=>message(e.message,true));el('learningNav').onclick=()=>workspace().catch(e=>message(e.message,true));
  el('accountNav').onclick=()=>myAccount().catch(e=>message(e.message,true));el('adminNav').onclick=()=>adminHome().catch(e=>message(e.message,true));
  el('signinNav').onclick=()=>signIn();el('logoutNav').onclick=async()=>{try{await api('/api/auth/logout',json('POST',{}));resetBrowser();}catch(error){message(error.message,true);}};
  async function boot(){
    try{const r=await api('/api/me');account.user=r.user;account.csrf=r.csrf_token;}
    catch(error){if(error.status!==401)message(error.message,true);}
    for(const id of ['learningNav','accountNav','logoutNav'])el(id).hidden=!account.user;
    el('signinNav').hidden=Boolean(account.user);el('adminNav').hidden=account.user?.role!=='admin';
    el('accountName').textContent=account.user?.name||'';
    document.querySelectorAll('#scanBtn,#scanBtnSide,#scanBtnLibrary,#emptyScanBtn,#reindexBtn,#buildSyllabusBtn,.sidebar-import,[data-action="edit-course"]').forEach(n=>n.hidden=account.user?.role!=='admin');
    const params=new URLSearchParams(location.search),action=params.get('action'),token=params.get('token');
    if(token&&action==='verify'){
      const r=await api('/api/auth/verify',json('POST',{token}));history.replaceState(null,'','/');signIn();message(r.message);return;
    }
    if(token&&action==='reset'){
      const root=page('Choose a new password');const f=form(root,'',async data=>{const r=await api('/api/auth/reset',json('POST',{token,password:data.get('password')}));history.replaceState(null,'','/');signIn();message(r.message);});field(f,'New password','password','password').minLength=12;submitButton(f,'Reset password');return;
    }
    if(location.hash==='#admin'&&!account.user)signIn();
    else if(location.hash==='#admin'&&account.user?.role==='admin')await adminHome();
    else if(account.user?.verified)await workspace();else await catalog();
  }
  boot().catch(error=>{page('CourseForge');message(error.message,true);});
})();
