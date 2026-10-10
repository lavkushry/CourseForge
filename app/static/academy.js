'use strict';
(() => {
  const el=id=>document.getElementById(id);
  const api=window.CourseForgeServices.request;
  const json=window.CourseForgeServices.json;
  const account=window.CourseForgeAccount={user:null,csrf:'',lastLessons:{}};
  const node=(tag,cls='',text='')=>{const n=document.createElement(tag);n.className=cls;n.textContent=text;return n;};
  const button=(text,action,primary=false)=>{const b=node('button',primary?'btn btn-primary':'btn btn-outline',text);b.type='button';b.onclick=()=>Promise.resolve().then(action).catch(error=>message(error.message,true));return b;};
  const minutes=seconds=>{const n=Math.floor(seconds||0);return n>=3600?`${Math.floor(n/3600)}h ${Math.floor(n%3600/60)}m`:n>=60?`${Math.floor(n/60)}m ${n%60}s`:`${n}s`;};
  const date=value=>value?new Date(value).toLocaleString():'—';
  const message=(text,error=false)=>{el('academyMessage').textContent=text;el('academyMessage').classList.toggle('error',error);el('academyMessage').hidden=false;};
  const clearMessage=()=>{el('academyMessage').hidden=true;};
  const resetBrowser=()=>{history.replaceState(null,'','/');location.reload();};
  function page(title){
    leaveLesson();document.body.classList.remove('in-learning');el('appShell').hidden=true;el('academyContent').hidden=false;
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
  function adminPage(title,section=''){
    history.replaceState(null,'',`/#admin${section?'/'+section:''}`);
    const root=page(title),nav=node('nav','admin-navigation');nav.setAttribute('aria-label','Administration');
    for(const [label,route,action] of [['Overview','',adminHome],['Students','students',adminUsers],['Courses','courses',adminCourses],['Player activity','player',adminPlayer],['System and audit','system',adminSystem]]){
      const b=button(label,()=>action());if(section.split('/')[0]===route){b.classList.add('active');b.setAttribute('aria-current','page');}nav.append(b);
    }root.append(nav);return root;
  }
  function privateLink(root,url,expires,messageText){
    const box=node('div','panel private-account-link');box.append(node('h2','','Private account link'),node('p','',messageText),node('p','muted','Expires '+date(expires)+'. The link is displayed once and is not stored in reports.'));
    const label=node('label','field');label.append(node('span','','Copy and share directly with the student'));const input=node('input','form-input');input.type='text';input.readOnly=true;input.value=url;input.autocomplete='off';label.append(input);box.append(label);
    box.append(button('Copy link',async()=>{await navigator.clipboard.writeText(url);message('Private account link copied.');}),button('Dismiss',()=>box.remove()));root.prepend(box);input.focus();input.select();
  }

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
    heading(root,'Course syllabus');root.append(table(['Lesson','Duration','Availability'],c.lessons.map(l=>[l.title,l.duration?minutes(l.duration):'—',l.available?'Ready to watch':'Coming soon'])));
  }
  function signIn(mode='login'){
    if(mode==='register')history.replaceState(null,'','/#register');
    else if(location.hash==='#register')history.replaceState(null,'','/');
    const root=page(mode==='register'?'Create your account':mode==='forgot'?'Reset your password':mode==='resend'?'Resend verification':'Welcome back');
    const f=form(root,'',async data=>{
      const payload=Object.fromEntries(data);const result=await api('/api/auth/'+mode,json('POST',payload));
      if(mode==='login'){location.reload();return;}
      if(mode==='register'&&result.user){history.replaceState(null,'','/#courses');location.reload();return;}
      message(result.message);f.reset();
    });
    if(mode==='register'){const n=field(f,'Name','name');n.maxLength=120;n.autocomplete='name';}
    const email=field(f,'Email address','email','email');email.autocomplete='email';email.maxLength=254;
    if(mode==='login'||mode==='register'){const password=field(f,'Password','password','password');password.autocomplete=mode==='login'?'current-password':'new-password';if(mode==='register'){password.minLength=12;f.append(node('p','muted','Use at least 12 characters.'));}}
    if(mode==='register')f.append(node('p','muted','Your account keeps your progress, notes, playback activity, and sign-in history. Administrators can review learning and access records.'));
    const submit=submitButton(f,mode==='login'?'Sign in':mode==='register'?'Create account':'Send email');
    if(mode!=='login')submit.disabled=true;
    const accountLink=button(mode==='register'?'Already registered? Sign in':'Create an account',()=>signIn(mode==='register'?'login':'register'));
    const forgot=button('Forgot password',()=>signIn('forgot')),resend=button('Resend verification',()=>signIn('resend'));
    root.append(accountLink,forgot,resend);
    api('/api/public/account-options').then(options=>{
      if(!f.isConnected)return;
      submit.disabled=mode==='register'?!options.registration_enabled:mode!=='login'&&!options.email_delivery;
      if(mode!=='register')accountLink.hidden=!options.registration_enabled;
      resend.hidden=!options.email_delivery;
      if(mode==='register'&&options.registration_enabled)root.append(node('p','muted',options.registration_mode==='open'?'Create your account and enroll in a published course to start learning immediately.':'Verify your email after creating your account to start learning.'));
      if(mode==='register'&&!options.registration_enabled)root.append(node('p','muted','Registration is currently available through administrator invitations. Ask your administrator for an activation link.'));
      if(!options.email_delivery)root.append(node('p','muted','For password recovery, ask your administrator for a private recovery link.'));
    }).catch(error=>{if(f.isConnected)message(error.message,true);});
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
    heading(root,'Your learning history','Your saved places, completed lessons, study activity, and results are stored in your account. Administrators can review learning records and account access. Access logs are kept for 30 days and detailed sessions for 90 days. Your learning totals remain until you delete your account.');
    const playback=await api('/api/me/playback');root.append(table(['Lesson','Time watched','Saved place'],playback.lessons.map(l=>[l.title,minutes(l.playing_seconds),prettyTime(l.position)])));
    if(account.user.role!=='admin'){
      const deletion=form(root,'Delete your account and learning records',async data=>{await api('/api/me',json('DELETE',{password:data.get('password')}));resetBrowser();});
      field(deletion,'Confirm password','password','password');submitButton(deletion,'Delete my account');
    }
  }
  async function adminHome(){
    const root=adminPage('Administration');root.append(button('Refresh',adminHome));
    const report=await api('/api/admin/overview');
    const metrics=node('div','academy-metrics');
    for(const [label,value] of [['Students',report.summary.students],['Enrollments',report.summary.enrollments],['Completed lessons',report.summary.completed_lessons],['Lesson activity',minutes(report.summary.activity_seconds)],['Playback time',minutes(report.summary.playing_seconds)],['Available lectures',`${report.summary.available_lectures}/${report.summary.lectures}`],['Recent sessions',report.summary.active_sessions]]){
      const card=node('div','panel metric-card');card.append(node('span','muted',label),node('strong','',String(value)));metrics.append(card);
    }root.append(metrics);
    heading(root,'Recent student activity',report.activity_basis+'. '+report.completion_basis+'.');
    root.append(table(['Student','Activity','Lecture','Time'],report.recent_activity.map(e=>[e.name,e.event_type.replaceAll('_',' '),e.title||e.details,date(e.created_at)])));
    heading(root,'Course enrollment funnel');root.append(table(['Course','Enrolled','Started'],report.funnels.map(r=>[r.course,r.enrolled,r.started])));
    heading(root,'Recent access events');root.append(table(['Event','IP address','Device','Time'],report.access_events.map(e=>[e.event_type.replaceAll('_',' '),e.ip,e.device,date(e.created_at)])));
  }
  async function adminUsers(query='',offset=0){
    const root=adminPage('Student management','students');
    const searchForm=form(root,'Find a student',data=>adminUsers(data.get('q')));field(searchForm,'Name or email','q','search',false).value=query;submitButton(searchForm,'Search');
    const result=await api(`/api/admin/users?q=${encodeURIComponent(query)}&offset=${offset}`);
    root.append(node('p','muted',`${result.total} accounts`));
    root.append(table(['Student','Email','Status','Courses','Completion','Lesson activity','Details'],result.users.map(u=>[u.name,u.email,u.suspended?'Suspended':u.verified?'Active':'Pending activation',u.enrollments,u.completed_lessons,minutes(u.activity_seconds),button('Inspect',()=>adminStudent(u.id))])));
    const pager=node('div','toolbar');if(offset)pager.append(button('Previous',()=>adminUsers(query,Math.max(0,offset-25))));if(offset+25<result.total)pager.append(button('Next',()=>adminUsers(query,offset+25)));root.append(pager);
    const create=form(root,'Invite a student',async data=>{const payload=Object.fromEntries(data);if(!payload.course)delete payload.course;const r=await api('/api/admin/invitations',json('POST',payload));create.reset();privateLink(root,r.activation_url,r.expires_at,r.message);});
    create.append(node('p','muted','The student chooses their own password using a one-time activation link. No email service is required.'));
    field(create,'Name','name');field(create,'Email','email','email');
    const courses=await api('/api/admin/courses'),label=node('label','field');label.append(node('span','','Grant a course (optional)'));const select=node('select','form-input');select.name='course';select.add(new Option('No course selected',''));courses.courses.forEach(c=>select.add(new Option(c.title+(c.published?'':' (draft)'),c.id)));label.append(select);create.append(label);submitButton(create,'Create invitation');
  }
  async function adminStudent(uid){
    const r=await api(`/api/admin/users/${uid}`),root=adminPage(r.user.name,'students/'+uid);
    root.append(button('Back to students',()=>adminUsers()),node('p','muted',`${r.user.email} · ${r.user.role} · ${r.user.suspended?'Suspended':r.user.verified?'Active':'Pending activation'}`));
    const actions=node('div','toolbar');
    if(r.user.role!=='admin'){
      actions.append(button(r.user.suspended?'Restore account':'Suspend account',async()=>{await api(`/api/admin/users/${uid}`,json('PATCH',{suspended:!r.user.suspended}));await adminStudent(uid);}));
      if(!r.user.suspended)actions.append(button(r.user.verified?'Issue recovery link':'Reissue invitation',async()=>{const link=await api(`/api/admin/users/${uid}/account-link`,json('POST',{}));privateLink(root,link.account_url,link.expires_at,link.message);}));
    }
    actions.append(button('Revoke all sessions',async()=>{await api(`/api/admin/users/${uid}/sessions`,{method:'DELETE'});await adminStudent(uid);}));root.append(actions);
    if(r.user.verified&&!r.user.suspended){
      const roleForm=form(root,'Account role',async data=>{const result=await api(`/api/admin/users/${uid}/role`,json('PUT',{role:data.get('role'),current_password:data.get('current_password')}));if(result.session_revoked)return resetBrowser();await adminStudent(uid);message(result.changed?'Account role changed. Previous sessions were revoked.':'Account role is unchanged.');});
      roleForm.append(node('p','muted','Administrators manage all courses and student accounts. Confirm this change with your own current password.'));
      const roleSelect=node('select','form-input');roleSelect.name='role';roleSelect.setAttribute('aria-label','Account role');for(const value of ['student','admin'])roleSelect.add(new Option(value,value,false,r.user.role===value));roleForm.append(roleSelect);
      field(roleForm,'Your current password','current_password','password').autocomplete='current-password';submitButton(roleForm,'Change role');
    }
    root.append(node('p','academy-lead',`${minutes(r.activity_seconds)} of recorded lesson activity · ${r.note_count} saved notes`));
    heading(root,'Course access');root.append(table(['Course','Enrolled','Access'],r.enrollments.map(e=>[e.course,date(e.created_at),button('Revoke course access',async()=>{await api(`/api/admin/users/${uid}/enrollments`,json('PUT',{course:e.course,enrolled:false}));await adminStudent(uid);})])));
    const courses=await api('/api/admin/courses');const grant=form(root,'Grant a course',async data=>{await api(`/api/admin/users/${uid}/enrollments`,json('PUT',{course:data.get('course'),enrolled:true}));await adminStudent(uid);});
    const select=node('select','form-input');select.name='course';select.required=true;select.setAttribute('aria-label','Course to grant');courses.courses.forEach(c=>select.add(new Option(c.title,c.id)));grant.append(select);submitButton(grant,'Grant course access');
    heading(root,'Lesson completion','Students report completion themselves. This is separate from assessment and lab performance.');root.append(table(['Lecture','Course','Completion','Updated'],r.lessons.map(l=>[l.title,l.course,l.completed?'Reported complete':'Incomplete',date(l.updated_at)])));
    heading(root,'Last opened lessons');root.append(table(['Lecture','Course','Opened'],r.recent_lessons.map(l=>[l.title,l.course,date(l.updated_at)])));
    heading(root,'Lesson activity','Cumulative visible lesson activity remains available after detailed sessions expire.');root.append(table(['Lecture','Course','Activity','Last recorded'],r.lesson_activity.map(l=>[l.title,l.course,minutes(l.activity_seconds),date(l.updated_at)])));
    heading(root,'Playback tracking','Browser-reported playback and content coverage are separate from lesson-page activity and lesson completion.');root.append(table(['Lecture','Playback','Resume','Coverage','Last saved'],r.playback.map(l=>[l.title,minutes(l.playing_seconds),prettyTime(l.position),l.coverage_percent+'%',date(l.updated_at)])));
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
    const root=adminPage('Course publishing','courses');const result=await api('/api/admin/courses');
    for(const c of result.courses){const f=form(root,c.title,async data=>{await api(`/api/admin/courses/${encodeURIComponent(c.id)}/publication`,json('PUT',{published:data.get('published')==='on',description:data.get('description')}));message('Course publication updated.');});
      f.append(node('p','muted',`${c.available_lessons}/${c.lesson_count} lectures mapped to Odysee`));
      f.append(button('Edit course details and cover',()=>openCourseEditor({...c,name:c.id})));
      const l=node('label','field');l.append(node('span','','Course description'));const d=node('textarea','form-input');d.name='description';d.maxLength=5000;d.rows=4;d.value=c.description;l.append(d);f.append(l);
      const publish=node('label');const check=node('input');check.name='published';check.type='checkbox';check.checked=Boolean(c.published);publish.append(check,document.createTextNode(' Published in public catalog'));f.append(publish);submitButton(f,'Save publication');
    }
    const map=form(root,'Map an Odysee lecture',async data=>{await api(`/api/admin/videos/${encodeURIComponent(data.get('video_id'))}/provider`,json('PUT',{claim_name:data.get('claim_name'),claim_id:data.get('claim_id')}));message('Lecture mapping saved.');});
    const videos=await api('/api/videos');const select=node('select','form-input');select.name='video_id';select.required=true;select.setAttribute('aria-label','Lecture to map');videos.videos.forEach(v=>select.add(new Option(`${v.course} / ${v.title}`,v.id)));map.append(select);
    field(map,'Odysee claim name','claim_name');const claim=field(map,'Odysee claim ID','claim_id');claim.pattern='[0-9a-fA-F]{40}';submitButton(map,'Save mapping');
  }
  function selectField(f,label,name,choices,value){
    const l=node('label','field');l.append(node('span','',label));const s=node('select','form-input');s.name=name;for(const [text,id] of choices)s.add(new Option(text,id));s.value=value;l.append(s);f.append(l);return s;
  }
  async function adminPlayer(filters={},offset=0){
    const root=adminPage('Player activity','player');
    root.append(node('p','academy-lead','Inspect lesson sessions, visible activity, devices, and access. Live means a lesson page is sending heartbeats; it does not establish that the video is playing.'));
    const criteria={days:'30',q:'',course:'',status:'all',...filters};
    const playback=await api('/api/admin/playback?'+new URLSearchParams({...criteria,offset}));
    heading(root,'Video playback',playback.basis);
    root.append(table(['Student','Lecture','State','Playback time','Position','Opened','Device and IP'],playback.sessions.map(s=>[button(s.name,()=>adminStudent(s.user_id)),s.title,s.live?'Playing':s.state,minutes(s.playing_seconds),prettyTime(s.position),date(s.created_at),[s.device,s.ip].join(' · ')])));
    const playbackPager=node('div','toolbar');if(offset)playbackPager.append(button('Previous playback sessions',()=>adminPlayer(criteria,Math.max(0,offset-25))));if(offset+25<playback.total)playbackPager.append(button('Next playback sessions',()=>adminPlayer(criteria,offset+25)));root.append(playbackPager);
    const playbackExport=node('a','btn btn-outline','Export playback CSV');playbackExport.href='/api/admin/playback/export?'+new URLSearchParams(criteria);playbackExport.download='courseforge-playback.csv';root.append(playbackExport);
    const f=form(root,'Filter sessions',data=>adminPlayer(Object.fromEntries(data)));
    field(f,'Student name, email, or lecture','q','search',false).value=criteria.q;
    selectField(f,'Period','days',[['Last 7 days','7'],['Last 30 days','30'],['Last 90 days','90']],criteria.days);
    const courses=await api('/api/admin/courses');
    selectField(f,'Course','course',[['All courses',''],...courses.courses.map(c=>[c.title,c.id])],criteria.course);
    selectField(f,'Session status','status',[['All sessions','all'],['Live lesson pages','live']],criteria.status);submitButton(f,'Apply filters');
    const query=new URLSearchParams(criteria),report=await api('/api/admin/player-activity?'+query+'&offset='+offset);
    const bar=node('div','toolbar');bar.append(button('Refresh',()=>adminPlayer(criteria,offset)));
    const download=node('a','btn btn-outline','Export CSV');download.href='/api/admin/player-activity/export?'+query;download.download='courseforge-lesson-activity.csv';bar.append(download);root.append(bar);
    root.append(node('p','muted',`${report.total} sessions · ${report.summary.learners} learners · ${minutes(report.summary.activity_seconds)} activity · ${report.period}. Updated ${new Date().toLocaleTimeString()}.`));
    root.append(table(['Student','Lecture','Status','Activity','Opened','Last heartbeat','Device and IP'],report.sessions.map(s=>{
      const student=button(s.name,()=>adminStudent(s.user_id));student.title=s.email;
      return [student,s.title,s.live?'Live lesson page':'Inactive',minutes(s.activity_seconds),date(s.created_at),date(s.last_active),[s.device||'Not recorded',s.ip||'Not recorded'].join(' · ')];
    })));
    const pager=node('div','toolbar');if(offset)pager.append(button('Previous',()=>adminPlayer(criteria,Math.max(0,offset-25))));if(offset+25<report.total)pager.append(button('Next',()=>adminPlayer(criteria,offset+25)));root.append(pager);
  }
  async function adminSystem(){
    const root=adminPage('System and administrator audit','system'),r=await api('/api/admin/system');
    heading(root,'Account delivery');
    root.append(node('p','',`${r.email.provider} email: ${r.email.configured?'Configured':'Awaiting server credentials'}. ${r.pending_invitations} pending invitations.`));
    root.append(node('p','',`Public registration: ${r.registration.registration_enabled?(r.registration.registration_mode==='open'?'Immediate student access':'Email verification required'):'Administrator invitations'}.`));
    if(!r.email.configured)root.append(node('p','muted','Set SMTP_FROM, SMTP_USER, and SMTP_PASSWORD in the server environment, then restart CourseForge. Student activation and recovery links can be issued in Students.'));
    heading(root,'Course readiness');root.append(table(['Course','Publication','Lectures','Cloud mappings','Measured durations'],r.courses.map(c=>[c.course,c.published?'Published':'Draft',c.lessons,c.mapped,c.measured_durations])));
    heading(root,'Player capabilities');root.append(node('p','',`Odysee authorization: ${r.provider_configured?'Configured':'Missing credentials'}. Automatic resume: ${r.player.automatic_resume?'Supported':'Unavailable'}.`),node('p','muted','The CourseForge player supports seeking, speed, volume, fullscreen, timestamp capture, automatic resume, and browser-reported playback tracking. Original video quality is delivered by Odysee. The embedded fallback supports manual resume points and visible lesson activity. Authenticated streaming and the viewer watermark provide access control and deterrence; they are not encrypted DRM.'));
    root.append(button('Refresh Odysee mappings',async()=>{const result=await api('/api/admin/provider-sync',json('POST',{}));await adminSystem();message(result.in_progress?'A mapping refresh is already running.':result.error||`${result.mapped}/${result.lectures} lectures mapped. ${result.durations_added} durations added.`,Boolean(result.error));}));
    heading(root,'Service reports');root.append(table(['Service','Last report','Last successful report','Status'],Object.entries(r.service_checks).map(([name,s])=>[name.replaceAll('_',' '),date(s.last_attempt),date(s.last_success),s.last_error||s.summary.state||(s.summary.mapped!==undefined?`${s.summary.mapped}/${s.summary.lectures} mapped`:'Reported')])));
    heading(root,'Learning task queue');root.append(table(['Status','Tasks'],Object.entries(r.tasks)));
    heading(root,'Administrator audit','Records account invitations, access changes, course publishing, provider mapping, and report exports. Logs retain 90 days; private activation links and passwords are excluded.');root.append(table(['Administrator','Action','Resource','Time'],r.audit.map(a=>[a.actor||'Deleted administrator',a.action,a.resource,date(a.created_at)])));
    root.append(button('Refresh status',adminSystem));
  }
  async function materials(course){
    const root=el('resourcesDialog');root.replaceChildren(node('h2','','Course resources'),button('Close',()=>root.close()));root.showModal();
    try{const data=await api('/api/materials'+(course?'?course='+encodeURIComponent(course):''));
      root.append(table(['Course','Resource','Type','Size','Open'],data.materials.map(m=>{const link=node('a','text-link','View resource');link.href=m.url;link.target='_blank';link.rel='noopener';return [m.course,m.name,m.ext,`${m.size_kb} KB`,link];})));}
    catch(error){root.append(node('p','field-error',error.message));}
  }
  let activity=null;
  function stopActivity(){
    const a=activity;activity=null;if(!a)return;
    const visible=a.visible&&document.visibilityState==='visible';
    const elapsed=visible?Math.min(20,(performance.now()-a.last)/1000):0;
    fetch(`/api/activity/${a.id}/heartbeat`,{method:'POST',keepalive:true,credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':account.csrf},body:JSON.stringify({sequence:++a.sequence,visible,elapsed_seconds:elapsed,ended:true})}).catch(()=>{});
  }
  function leaveLesson(){
    window.CourseForgeStudio?.cancelNext();window.CourseForgeNative?.stop();window.CourseForgePlayerSession?.close();
    stopActivity();window.CourseForgeCancelVideoOpen?.();el('lecturePlayerWrap')?.replaceChildren();
  }
  async function startActivity(id,current=true){
    const eligible=()=>typeof current==='function'?current():current;
    if(!eligible())return;const r=await api(`/api/videos/${id}/activity-session`,json('POST',{player_session_id:window.CourseForgePlayerSession?.current()||null}));
    if(!eligible()||state.currentVideoId!==id||el('appShell').hidden||state.view!=='learning')return;
    activity={id:r.id,sequence:0,last:performance.now(),visible:document.visibilityState==='visible',pending:false};
  }
  async function heartbeat(){
    const a=activity;if(!a||a.pending)return;
    const now=performance.now(),visible=document.visibilityState==='visible'&&!el('appShell').hidden&&state.view==='learning';
    const elapsed=a.visible&&visible?Math.min(20,(now-a.last)/1000):0;a.last=now;a.visible=visible;a.pending=true;
    try{const r=await api(`/api/activity/${a.id}/heartbeat`,json('POST',{sequence:++a.sequence,visible,elapsed_seconds:elapsed}));
      if(activity===a&&el('lessonActivityTimer'))el('lessonActivityTimer').textContent='Lesson activity: '+minutes(r.activity_seconds);}
    catch(error){if(error.status===401||error.status===403||error.status===404)leaveLesson();}
    finally{a.pending=false;}
  }
  setInterval(heartbeat,15000);document.addEventListener('visibilitychange',heartbeat);
  window.addEventListener('pagehide',leaveLesson);
  function parseTimestamp(value){
    if(!/^\d+(?::[0-5]\d){0,2}$/.test(value.trim()))throw new Error('Use seconds, MM:SS, or HH:MM:SS for the timestamp.');
    const seconds=value.trim().split(':').reduce((sum,part)=>sum*60+Number(part),0);if(seconds>=1e9)throw new Error('Timestamp is too large.');return seconds;
  }
  async function loadBookmarks(id){
    const data=await api(`/api/videos/${id}/bookmarks`);if(id!==state.currentVideoId)return;
    const list=el('bookmarksList');list.replaceChildren();
    for(const b of data.bookmarks){const row=node('div','saved-note');row.append(button(`${prettyTime(b.position)} · ${b.label}`,()=>openVideo(id,b.position)),button('Delete',async()=>{await api(`/api/bookmarks/${b.id}`,{method:'DELETE'});await loadBookmarks(id);}));list.append(row);}
    if(!data.bookmarks.length)list.append(node('p','muted','No bookmarks for this lecture yet.'));
  }
  el('bookmarkForm').onsubmit=async e=>{e.preventDefault();if(!state.currentVideoId)return;try{await api(`/api/videos/${state.currentVideoId}/bookmarks`,json('POST',{position:parseTimestamp(el('bookmarkPosition').value),label:el('bookmarkLabel').value}));await loadBookmarks(state.currentVideoId);el('bookmarkLabel').value='';}catch(error){toast(error.message,true);}};
  el('lessonSearch').oninput=e=>{const query=e.target.value.toLowerCase();document.querySelectorAll('.lesson-link').forEach(link=>link.hidden=!link.textContent.toLowerCase().includes(query));};
  el('previousLessonBtn').onclick=()=>{const current=state.videos.find(v=>v.id===state.currentVideoId);if(!current)return;const lessons=state.videos.filter(v=>v.course===current.course),previous=lessons[lessons.findIndex(v=>v.id===current.id)-1];if(previous)openVideo(previous.id).catch(error=>toast(error.message,true));else toast('You are at the first lesson.');};
  window.CourseForgeAcademy={materials,stopActivity,leaveLesson,startActivity,loadBookmarks,parseTimestamp};
  window.addEventListener('courseforge-session-expired',()=>{account.user=null;account.csrf='';resetBrowser();});
  window.addEventListener('courseforge-task',()=>toast('Learning task queued. This view will update when it finishes.'));
  el('catalogNav').onclick=()=>catalog().catch(e=>message(e.message,true));el('learningNav').onclick=()=>workspace().catch(e=>message(e.message,true));
  el('accountNav').onclick=()=>myAccount().catch(e=>message(e.message,true));el('adminNav').onclick=()=>adminHome().catch(e=>message(e.message,true));
  el('signinNav').onclick=()=>signIn();el('registerNav').onclick=()=>signIn('register');el('logoutNav').onclick=async()=>{try{await api('/api/auth/logout',json('POST',{}));resetBrowser();}catch(error){message(error.message,true);}};
  async function boot(){
    try{const r=await api('/api/me');account.user=r.user;account.csrf=r.csrf_token;}
    catch(error){if(error.status!==401)message(error.message,true);}
    for(const id of ['learningNav','accountNav','logoutNav'])el(id).hidden=!account.user;
    el('jobSummary').hidden=account.user?.role!=='admin';el('signinNav').hidden=Boolean(account.user);el('adminNav').hidden=account.user?.role!=='admin';
    const options=await api('/api/public/account-options');el('registerNav').hidden=Boolean(account.user)||!options.registration_enabled;
    el('accountName').textContent=account.user?.name||'';
    document.querySelectorAll('#scanBtn,#scanBtnSide,#scanBtnLibrary,#emptyScanBtn,#reindexBtn,#buildSyllabusBtn,.sidebar-import,[data-action="edit-course"]').forEach(n=>n.hidden=account.user?.role!=='admin');
    const fragment=location.hash.slice(1).split('?'),params=new URLSearchParams(location.search);
    const fragmentParams=new URLSearchParams(fragment[1]||''),action=fragmentParams.has('token')?fragment[0]:params.get('action'),token=fragmentParams.get('token')||params.get('token');
    if(token)history.replaceState(null,'','/');
    if(token&&action==='verify'){
      const r=await api('/api/auth/verify',json('POST',{token}));history.replaceState(null,'','/');signIn();message(r.message);return;
    }
    if(token&&(action==='reset'||action==='activate')){
      const root=page(action==='activate'?'Activate your account':'Choose a new password');
      if(action==='activate')root.append(node('p','muted','Your administrator invited you to CourseForge. Choose a password with at least 12 characters.'));
      const f=form(root,'',async data=>{const r=await api('/api/auth/'+action,json('POST',{token,password:data.get('password')}));history.replaceState(null,'','/');signIn();message(r.message);});field(f,'New password','password','password').minLength=12;submitButton(f,action==='activate'?'Activate account':'Reset password');return;
    }
    const adminRoute=location.hash.match(/^#admin(?:\/(.*))?$/);
    if(location.hash==='#register'&&!account.user)signIn('register');
    else if(location.hash==='#courses')await catalog();
    else if(adminRoute&&!account.user)signIn();
    else if(adminRoute&&account.user?.role==='admin'){
      const route=adminRoute[1]||'';
      if(route.startsWith('students/'))await adminStudent(route.slice(9));
      else await ({students:adminUsers,courses:adminCourses,player:adminPlayer,system:adminSystem}[route]||adminHome)();
    }
    else if(account.user?.verified)await workspace();else await catalog();
  }
  boot().catch(error=>{page('CourseForge');message(error.message,true);});
})();
