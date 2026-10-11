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
    rows.forEach(values=>{const tr=node('tr');values.forEach((value,i)=>{const td=node('td');td.dataset.label=headers[i];if(value instanceof Node)td.append(value);else td.textContent=String(value??'—');tr.append(td);});body.append(tr);});
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
      account.bootstrap=await api('/api/me/bootstrap');
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
    const initial=account.bootstrap;account.bootstrap=null;
    const learning=initial?.learning||await api('/api/me/learning');account.lastLessons=Object.fromEntries(learning.courses.map(c=>[c.course,c.last_video_id]));
    await window.CourseForgeBoot(initial);window.CourseForgeReady=true;window.dispatchEvent(new Event('courseforge-ready'));
    window.CourseForgeLoadTools?.();
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
    if(report.engagement){
      heading(root,'Active engagement & return rate',report.engagement.period);
      const engMetrics=node('div','academy-metrics');
      for(const [label,value] of [
        ['Daily active students',report.engagement.daily_active_students],
        ['Average session duration',`${report.engagement.average_session_minutes} min`],
        ['7-day return rate',report.engagement.seven_day_return_rate!==null?`${report.engagement.seven_day_return_rate}%`:'Not enough cohort data'],
        ['Returning cohort',`${report.engagement.returning_students} of ${report.engagement.return_cohort} students`],
        ['Quiz pass rate',report.engagement.quiz_pass_rate!==null?`${report.engagement.quiz_pass_rate}% (${report.engagement.quizzes_passed}/${report.engagement.quizzes_taken})`:'No quizzes yet'],
        ['Review sessions completed',report.engagement.review_session_completion]
      ]){
        const card=node('div','panel metric-card');card.append(node('span','muted',label),node('strong','',String(value)));engMetrics.append(card);
      }
      root.append(engMetrics);
    }
    heading(root,'Recent student activity',report.activity_basis+'. '+report.completion_basis+'.');
    root.append(table(['Student','Activity','Lecture','Time'],report.recent_activity.map(e=>[e.name,e.event_type.replaceAll('_',' '),e.title||e.details,date(e.created_at)])));
    heading(root,'Course enrollment funnel');root.append(table(['Course','Enrolled','Started'],report.funnels.map(r=>[r.course,r.enrolled,r.started])));
    heading(root,'Recent access events');root.append(table(['Event','IP address','Device','Time'],report.access_events.map(e=>[e.event_type.replaceAll('_',' '),e.ip,e.device,date(e.created_at)])));

    try{
      const ti = await api('/api/admin/teacher-insights');
      heading(root,'Teacher insights & AI companion analytics','Aggregated student tutor questions, token tracking, and quiz fail rates');
      const tiMetrics=node('div','academy-metrics');
      for(const [label,val] of [
        ['AI Tutor queries', ti.total_ai_queries],
        ['Tokens tracked', ti.total_tokens],
        ['Estimated AI cost', `$${ti.estimated_cost_usd}`],
        ['Overall quiz pass rate', `${ti.overall_quiz_pass_rate}%`],
      ]){
        const c=node('div','panel metric-card');c.append(node('span','muted',label),node('strong','',String(val)));tiMetrics.append(c);
      }
      root.append(tiMetrics);
      if(ti.top_tutor_topics && ti.top_tutor_topics.length){
        heading(root,'Top AI companion query topics','Areas where students seek extra explanation');
        root.append(table(['Topic / Concept','Queries'],ti.top_tutor_topics.map(t=>[t.topic,t.query_count])));
      }
      if(ti.high_fail_quiz_questions && ti.high_fail_quiz_questions.length){
        heading(root,'Challenging quiz questions','Questions with highest failure rates needing instructor clarification');
        root.append(table(['Question','Lesson','Course','Fail rate','Attempts'],ti.high_fail_quiz_questions.map(q=>[q.question,q.lesson_title,q.course,`${q.fail_rate}%`,q.total_attempts])));
      }
    }catch(err){}
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
    heading(root,'Watch history','Browser-reported watch time and watched portion are separate from lesson-page activity and lesson completion.');root.append(table(['Lecture','Time watched','Resume','Watched','Last saved'],r.playback.map(l=>[l.title,minutes(l.playing_seconds),prettyTime(l.position),l.coverage_percent+'%',date(l.updated_at)])));
    heading(root,'Assessment results');root.append(table(['Topic','Score','Correct','Completed'],r.assessments.map(a=>[a.step_id,`${a.score}%`,`${a.correct_count}/${a.total_count}`,date(a.completed_at)])));
    heading(root,'Practice labs');root.append(table(['Lab','Status','Updated'],r.labs.map(l=>[l.slug,l.status,date(l.updated_at)])));
    heading(root,'Recall practice');root.append(table(['Self-rating (0–5)','Reviewed'],r.reviews.map(a=>[a.quality,date(a.reviewed_at)])));
    heading(root,'Study plans');root.append(table(['Date','Budget','Updated'],r.plans.map(a=>[a.study_date,`${a.budget_minutes}m`,date(a.updated_at)])));
    heading(root,'Focus sessions');root.append(table(['Title','Mode','Status','Configured duration'],r.focus.map(a=>[a.title,a.mode,a.status,minutes(a.duration_seconds)])));
    heading(root,'Devices and access');root.append(table(['Device','IP address','Last active','Expires'],r.sessions.map(s=>[s.device,s.ip,date(s.last_seen),date(s.expires_at)])));
    heading(root,'Learning history');root.append(table(['Activity','Lecture','Time'],r.activity.map(a=>[a.event_type.replaceAll('_',' '),a.title||a.details,date(a.created_at)])));
    heading(root,'Access history');root.append(table(['Event','IP','Device','Time'],r.access.map(a=>[a.event_type.replaceAll('_',' '),a.ip,a.device,date(a.created_at)])));
  }
  function uploadMaterialRequest(courseId,formData,onProgress){
    return new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();
      xhr.open('POST',`/api/admin/courses/${encodeURIComponent(courseId)}/materials`);
      if(account.csrf)xhr.setRequestHeader('X-CSRF-Token',account.csrf);
      xhr.upload.onprogress=e=>{if(e.lengthComputable&&onProgress)onProgress(Math.round((e.loaded/e.total)*100));};
      xhr.onload=()=>{
        let body={};try{body=JSON.parse(xhr.responseText||'{}');}catch{}
        if(xhr.status>=200&&xhr.status<300)resolve(body);
        else reject(new Error(typeof body.detail==='string'?body.detail:body.detail?.message||`Upload failed (${xhr.status})`));
      };
      xhr.onerror=()=>reject(new Error('Network error while uploading material.'));
      xhr.send(formData);
    });
  }
  async function openCourseInWorkspace(courseId){
    await workspace();
    const course=groupCourses().find(c=>c.name===courseId)||{name:courseId,videos:state.videos.filter(v=>v.course===courseId)};
    openCourse(course);
  }
  async function adminCourses(){
    const root=adminPage('Course management','courses');
    root.append(node('p','academy-lead','Manage all courses, publish or unpublish, edit course details, reorder lessons into sections, and attach or preview lesson materials.'));
    const controls=node('div','admin-course-controls toolbar');
    const searchInput=node('input','form-input');searchInput.type='search';searchInput.placeholder='Search courses by title, category, or instructor…';searchInput.setAttribute('aria-label','Search courses');
    const sortSelect=node('select','form-input');sortSelect.setAttribute('aria-label','Sort courses');
    for(const [label,val] of [['Sort: Recently updated','updated'],['Sort: Title A–Z','title'],['Sort: Most lessons','lessons'],['Sort: Most students','students'],['Sort: Most materials','materials'],['Sort: Publish status','status']])sortSelect.add(new Option(label,val));
    controls.append(searchInput,sortSelect,button('Refresh',adminCourses));
    root.append(controls);
    const tableSlot=node('div','admin-courses-table-slot');root.append(tableSlot);
    const result=await api('/api/admin/courses');
    let courses=result.courses||[];
    const renderTable=()=>{
      const q=searchInput.value.trim().toLowerCase();
      const sortBy=sortSelect.value;
      const filtered=courses.filter(c=>[c.id,c.title||'',c.category||'',c.instructor||'',c.description||''].some(v=>String(v).toLowerCase().includes(q)));
      filtered.sort((a,b)=>{
        if(sortBy==='title')return (a.title||a.id).localeCompare(b.title||b.id);
        if(sortBy==='lessons')return (b.lesson_count||0)-(a.lesson_count||0);
        if(sortBy==='students')return (b.enrolled_students||0)-(a.enrolled_students||0);
        if(sortBy==='materials')return (b.material_count||0)-(a.material_count||0);
        if(sortBy==='status')return Number(Boolean(b.published))-Number(Boolean(a.published));
        return String(b.updated_at||'').localeCompare(String(a.updated_at||''));
      });
      const rows=filtered.map(c=>{
        const titleCell=node('div','admin-course-title-cell');
        const drillBtn=node('button','text-link admin-course-drill',c.title||c.id);drillBtn.type='button';drillBtn.onclick=()=>adminCourseDetail(c.id);
        titleCell.append(drillBtn);
        if(c.instructor)titleCell.append(node('div','muted',`By ${c.instructor}`));
        const playableText=`${c.available_lessons||0} playable · ${c.pending_lessons??Math.max(0,(c.lesson_count||0)-(c.available_lessons||0))} pending`;
        const transcriptText=`${c.transcript_ready||0}/${c.lesson_count||0} (${c.transcript_percent??0}%)`;
        const statusBadge=node('span','tag',c.published?'Published':'Draft');
        const actions=node('div','admin-row-actions');
        actions.append(
          button('Manage lessons & files',()=>adminCourseDetail(c.id),true),
          button('Edit details',()=>openCourseEditor({...c,name:c.id})),
          button(c.published?'Unpublish':'Publish',async()=>{
            await api(`/api/admin/courses/${encodeURIComponent(c.id)}/publication`,json('PUT',{published:!c.published,description:c.description||''}));
            c.published=!c.published;message(`Course ${c.published?'published':'unpublished'}.`);renderTable();
          }),
          button('Open course',()=>openCourseInWorkspace(c.id))
        );
        return [
          titleCell,
          c.category||'General',
          String(c.lesson_count||0),
          playableText,
          transcriptText,
          `${c.material_count||0} files`,
          String(c.enrolled_students||0),
          statusBadge,
          date(c.updated_at),
          actions,
        ];
      });
      tableSlot.replaceChildren(table(['Course','Category','Lessons','Playable vs pending','Transcripts','Materials','Students','Status','Last updated','Actions'],rows));
    };
    searchInput.oninput=renderTable;sortSelect.onchange=renderTable;renderTable();

    const map=form(root,'Map an Odysee lecture',async data=>{await api(`/api/admin/videos/${encodeURIComponent(data.get('video_id'))}/provider`,json('PUT',{claim_name:data.get('claim_name'),claim_id:data.get('claim_id')}));message('Lecture mapping saved.');await adminCourses();});
    const videos=await api('/api/videos');const select=node('select','form-input');select.name='video_id';select.required=true;select.setAttribute('aria-label','Lecture to map');videos.videos.forEach(v=>select.add(new Option(`${v.course} / ${v.title}`,v.id)));map.append(select);
    field(map,'Odysee claim name','claim_name');const claim=field(map,'Odysee claim ID','claim_id');claim.pattern='[0-9a-fA-F]{40}';submitButton(map,'Save mapping');
  }
  async function adminCourseDetail(courseId){
    const detail=await api(`/api/admin/courses/${encodeURIComponent(courseId)}/detail`);
    const c=detail.course;
    const root=adminPage(c.title||courseId,'courses/'+encodeURIComponent(courseId));
    const topBar=node('div','toolbar');
    topBar.append(
      button('← Back to all courses',adminCourses),
      button('Edit metadata & cover',()=>openCourseEditor({...c,name:c.id})),
      button(c.published?'Unpublish course':'Publish course',async()=>{
        await api(`/api/admin/courses/${encodeURIComponent(courseId)}/publication`,json('PUT',{published:!c.published,description:c.description||''}));
        message(`Course ${!c.published?'published':'unpublished'}.`);await adminCourseDetail(courseId);
      },!c.published),
      button('Open in learner view',()=>openCourseInWorkspace(courseId))
    );
    root.append(topBar);
    root.append(node('p','muted',`Course ID: ${c.id} · Category: ${c.category||'General'} · ${c.lesson_count} lessons · ${c.available_lessons} playable (${c.pending_lessons} pending) · ${c.transcript_ready}/${c.lesson_count} transcripts · ${c.material_count} materials · ${c.enrolled_students} enrolled students`));

    const pubForm=form(root,'Publication & description',async data=>{
      await api(`/api/admin/courses/${encodeURIComponent(courseId)}/publication`,json('PUT',{published:data.get('published')==='on',description:data.get('description')}));
      message('Course publication updated.');await adminCourseDetail(courseId);
    });
    const descLabel=node('label','field');descLabel.append(node('span','','Course description'));
    const descInput=node('textarea','form-input');descInput.name='description';descInput.maxLength=5000;descInput.rows=3;descInput.value=c.description||'';
    descLabel.append(descInput);pubForm.append(descLabel);
    const pubToggle=node('label');const pubCheck=node('input');pubCheck.name='published';pubCheck.type='checkbox';pubCheck.checked=Boolean(c.published);
    pubToggle.append(pubCheck,document.createTextNode(' Published in public catalog'));pubForm.append(pubToggle);
    submitButton(pubForm,'Save publication');

    const previewBox=node('div','panel admin-material-preview');previewBox.hidden=true;root.append(previewBox);
    const showPreview=mat=>{
      previewBox.hidden=false;previewBox.replaceChildren();
      const head=node('div','toolbar');
      head.append(node('strong','',`Preview before publish: ${mat.friendly_name||mat.name} (${mat.material_type||'File'} · ${mat.size_kb} KB)`));
      const dl=node('a','btn btn-outline','Download');dl.href=mat.download_url||(mat.url+'?download=1');dl.setAttribute('download','');
      const close=button('Close preview',()=>{previewBox.hidden=true;previewBox.replaceChildren();});
      head.append(dl,close);
      const frame=node('iframe','admin-preview-iframe');frame.title=mat.friendly_name||mat.name;frame.src=mat.url;
      frame.style.cssText='width:100%;min-height:460px;border:1px solid var(--line);border-radius:8px;margin-top:12px;background:#0f1420';
      previewBox.append(head,frame);
      previewBox.scrollIntoView({behavior:'smooth',block:'nearest'});
    };

    let orderedLessons=[...(detail.lessons||[])];
    const datalistId='sections-list-'+courseId.replace(/\W+/g,'_');
    const datalist=node('datalist');datalist.id=datalistId;
    (detail.sections||[]).forEach(s=>datalist.append(new Option(s,s)));
    root.append(datalist);

    heading(root,'Upload or replace course material','Attach notebooks, PDFs, slides, datasets, or code files to a specific lesson, or share an archive at the section level.');
    const uploadPanel=node('form','academy-form panel');
    const fileField=node('label','field');fileField.append(node('span','','Choose file'));
    const fileInput=node('input','form-input');fileInput.type='file';fileInput.name='file';fileInput.required=true;fileField.append(fileInput);
    const friendlyField=node('label','field');friendlyField.append(node('span','','Friendly display name (optional)'));
    const friendlyInput=node('input','form-input');friendlyInput.name='friendly_name';friendlyInput.maxLength=200;friendlyInput.placeholder='e.g. Session 01 — Linux Fundamentals Notes';friendlyField.append(friendlyInput);
    const typeField=node('label','field');typeField.append(node('span','','Material type'));
    const typeSelect=node('select','form-input');typeSelect.name='material_type';
    for(const [label,val] of [['Auto-detect from file extension',''],['Notebook','Notebook'],['PDF','PDF'],['Slides','Slides'],['Dataset','Dataset'],['Code','Code'],['Archive','Archive'],['Notes','Notes']])typeSelect.add(new Option(label,val));
    typeField.append(typeSelect);
    const scopeField=node('label','field');scopeField.append(node('span','','Placement scope'));
    const scopeSelect=node('select','form-input');scopeSelect.name='scope';
    scopeSelect.add(new Option('Lesson material (belongs to one lesson)','lesson'));
    scopeSelect.add(new Option('Section shared file (shown at section level in sidebar)','section'));
    scopeField.append(scopeSelect);
    const lessonField=node('label','field');lessonField.append(node('span','','Target lesson'));
    const lessonSelect=node('select','form-input');lessonSelect.name='lesson_id';
    lessonSelect.add(new Option('Auto-match or select lesson…',''));
    orderedLessons.forEach((l,i)=>lessonSelect.add(new Option(`${String(i+1).padStart(2,'0')}. ${l.title}`,l.id)));
    lessonField.append(lessonSelect);
    const secField=node('label','field');secField.append(node('span','','Target section (for section-level shared files)'));
    const secInput=node('input','form-input');secInput.name='section_title';secInput.setAttribute('list',datalistId);secInput.placeholder=(detail.sections?.[0])||'Module 1 — Course Foundations';
    secField.append(secInput);
    const replaceInput=node('input');replaceInput.type='hidden';replaceInput.name='replace_filename';
    const progressWrap=node('div','upload-progress-wrap');progressWrap.hidden=true;
    const progressBar=node('progress','upload-progress-bar');progressBar.max=100;progressBar.value=0;
    const progressText=node('span','muted','0%');
    progressWrap.append(progressBar,progressText);
    const uploadSubmit=node('button','btn btn-primary','Upload & attach file');uploadSubmit.type='submit';
    uploadPanel.append(fileField,friendlyField,typeField,scopeField,lessonField,secField,replaceInput,progressWrap,uploadSubmit);
    uploadPanel.onsubmit=async e=>{
      e.preventDefault();
      const f=fileInput.files[0];if(!f)return message('Select a file to upload.',true);
      uploadSubmit.disabled=true;progressWrap.hidden=false;progressBar.value=0;progressText.textContent='Uploading 0%…';
      try{
        const fd=new FormData();
        fd.append('file',f);
        fd.append('friendly_name',friendlyInput.value.trim());
        fd.append('material_type',typeSelect.value);
        fd.append('scope',scopeSelect.value);
        fd.append('lesson_id',lessonSelect.value);
        fd.append('section_title',secInput.value.trim());
        fd.append('replace_filename',replaceInput.value);
        const res=await uploadMaterialRequest(courseId,fd,pct=>{progressBar.value=pct;progressText.textContent=`Uploading ${pct}%…`;});
        progressBar.value=100;progressText.textContent='Upload complete (100%)';
        message(`Material “${res.material?.friendly_name||f.name}” saved. Click Preview to inspect before publishing.`);
        await loadLibrary().catch(()=>{});
        await adminCourseDetail(courseId);
      }catch(err){message(err.message,true);}
      finally{uploadSubmit.disabled=false;}
    };
    root.append(uploadPanel);

    heading(root,'Lessons & sections organization','Reorder lessons or organize them into named sections. Existing course and lecture IDs never change, and material-to-lesson assignments are preserved.');
    const saveOrgBar=node('div','toolbar');
    const saveOrgBtn=button('Save lesson order & sections',async()=>{
      const payload={lessons:orderedLessons.map((l,idx)=>({video_id:l.id,section_title:l.section||'Module 1 — Course Foundations',position:idx+1}))};
      await api(`/api/admin/courses/${encodeURIComponent(courseId)}/organization`,json('PUT',payload));
      await loadLibrary().catch(()=>{});
      message('Lesson order and sections saved. Lecture IDs and material assignments were preserved.');
      await adminCourseDetail(courseId);
    },true);
    saveOrgBar.append(saveOrgBtn);root.append(saveOrgBar);

    const lessonsContainer=node('div','admin-lessons-organizer');root.append(lessonsContainer);
    const renderOrganizer=()=>{
      lessonsContainer.replaceChildren();
      const rows=orderedLessons.map((l,idx)=>{
        const orderCell=node('div','admin-order-controls');
        const upBtn=button('↑',()=>{if(idx===0)return;[orderedLessons[idx-1],orderedLessons[idx]]=[orderedLessons[idx],orderedLessons[idx-1]];renderOrganizer();});
        upBtn.disabled=idx===0;upBtn.setAttribute('aria-label',`Move ${l.title} up`);
        const downBtn=button('↓',()=>{if(idx>=orderedLessons.length-1)return;[orderedLessons[idx+1],orderedLessons[idx]]=[orderedLessons[idx],orderedLessons[idx+1]];renderOrganizer();});
        downBtn.disabled=idx>=orderedLessons.length-1;downBtn.setAttribute('aria-label',`Move ${l.title} down`);
        orderCell.append(node('strong','',String(idx+1).padStart(2,'0')),upBtn,downBtn);

        const lessonInfo=node('div','admin-lesson-info');
        lessonInfo.append(node('strong','',l.title),node('div','muted',`Lecture ID: ${l.id} · ${l.available?'Playable':'Pending mapping'} · ${l.transcript_ready?'Transcript ready':'No transcript'}`));

        const secCell=node('div','admin-section-cell');
        const secFieldInput=node('input','form-input');secFieldInput.value=l.section||'';secFieldInput.setAttribute('list',datalistId);
        secFieldInput.setAttribute('aria-label',`Section for ${l.title}`);
        secFieldInput.oninput=()=>{l.section=secFieldInput.value.trim();};
        secCell.append(secFieldInput);

        const matCell=node('div','admin-lesson-materials');
        const mats=l.materials||[];
        if(!mats.length)matCell.append(node('span','muted','No files attached'));
        for(const m of mats){
          const chip=node('div','admin-mat-chip');
          chip.append(node('span','',`${m.friendly_name||m.name} (${m.material_type} · ${m.size_kb} KB)`));
          const pBtn=button('Preview',()=>showPreview(m));
          const repBtn=button('Replace',()=>{
            replaceInput.value=m.name;friendlyInput.value=m.friendly_name||m.name;typeSelect.value=m.material_type||'';
            scopeSelect.value='lesson';lessonSelect.value=l.id;fileInput.click();
            uploadPanel.scrollIntoView({behavior:'smooth',block:'center'});
          });
          const delBtn=button('Remove',async()=>{
            await api(`/api/admin/courses/${encodeURIComponent(courseId)}/materials/${encodeURIComponent(m.name)}`,{method:'DELETE'});
            await loadLibrary().catch(()=>{});message(`Removed ${m.friendly_name||m.name}.`);await adminCourseDetail(courseId);
          });
          chip.append(pBtn,repBtn,delBtn);matCell.append(chip);
        }
        const attachBtn=button('+ Attach file',()=>{
          replaceInput.value='';friendlyInput.value='';scopeSelect.value='lesson';lessonSelect.value=l.id;
          fileInput.click();uploadPanel.scrollIntoView({behavior:'smooth',block:'center'});
        });
        matCell.append(attachBtn);
        return [orderCell,lessonInfo,secCell,matCell];
      });
      lessonsContainer.append(table(['Order','Lesson & immutable ID','Section / Module','Attached lesson materials'],rows));
    };
    renderOrganizer();

    const sectionFiles=(detail.materials||[]).filter(m=>m.scope==='section');
    heading(root,'Section-level shared files','Archives and reference files shared across an entire section in the sidebar.');
    root.append(table(['Friendly name','Type','Section','Size','Actions'],sectionFiles.map(m=>[
      m.friendly_name||m.name,
      m.material_type||'Archive',
      m.section||'Course section',
      `${m.size_kb} KB`,
      (()=>{
        const act=node('div','toolbar');
        act.append(
          button('Preview',()=>showPreview(m)),
          button('Replace',()=>{replaceInput.value=m.name;friendlyInput.value=m.friendly_name||m.name;scopeSelect.value='section';secInput.value=m.section||'';fileInput.click();uploadPanel.scrollIntoView({behavior:'smooth'});}),
          button('Remove',async()=>{await api(`/api/admin/courses/${encodeURIComponent(courseId)}/materials/${encodeURIComponent(m.name)}`,{method:'DELETE'});await loadLibrary().catch(()=>{});message('Removed section file.');await adminCourseDetail(courseId);})
        );
        return act;
      })()
    ])));

    try{
      const qRes = await api(`/api/admin/courses/${encodeURIComponent(courseId)}/quizzes`);
      if(qRes.quizzes && qRes.quizzes.length){
        heading(root,'Lesson mastery quizzes & review flashcards','Admin review, approval, and regeneration of auto-generated quizzes from transcripts.');
        root.append(table(['Lesson','Status','Questions','Attempts','Pass rate','Actions'],qRes.quizzes.map(q=>[
          q.lesson_title,
          q.status||'Approved',
          `${q.question_count} questions`,
          q.attempts,
          `${q.pass_rate}%`,
          (()=>{
            const act=node('div','toolbar');
            act.append(
              button('Regenerate',async()=>{
                await api(`/api/admin/videos/${encodeURIComponent(q.video_id)}/quiz/regenerate`,{method:'POST'});
                message(`Regenerated quiz for “${q.lesson_title}”.`);
                await adminCourseDetail(courseId);
              })
            );
            return act;
          })()
        ])));
      }
    }catch(err){}
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
    heading(root,'Player capabilities');root.append(node('p','',`Odysee authorization: ${r.provider_configured?'Configured':'Missing credentials'}. Automatic resume: ${r.player.automatic_resume?'Supported':'Unavailable'}.`),node('p','muted','The CourseForge player supports seeking, speed, volume, fullscreen, timestamp capture, automatic resume, and automatic watch history. Original video quality is delivered by Odysee. The embedded fallback supports manual resume points and visible lesson activity. Authenticated streaming and the viewer watermark provide access control and deterrence; they are not encrypted DRM.'));
    root.append(button('Refresh Odysee mappings',async()=>{const result=await api('/api/admin/provider-sync',json('POST',{}));await adminSystem();message(result.in_progress?'A mapping refresh is already running.':result.error||`${result.mapped}/${result.lectures} lectures mapped. ${result.durations_added} durations added.`,Boolean(result.error));}));
    heading(root,'Service reports');root.append(table(['Service','Last report','Last successful report','Status'],Object.entries(r.service_checks).map(([name,s])=>[name.replaceAll('_',' '),date(s.last_attempt),date(s.last_success),s.last_error||s.summary.state||(s.summary.mapped!==undefined?`${s.summary.mapped}/${s.summary.lectures} mapped`:'Reported')])));
    heading(root,'Learning task queue');root.append(table(['Status','Tasks'],Object.entries(r.tasks)));
    heading(root,'Administrator audit','Records account invitations, access changes, course publishing, provider mapping, and report exports. Logs retain 90 days; private activation links and passwords are excluded.');root.append(table(['Administrator','Action','Resource','Time'],r.audit.map(a=>[a.actor||'Deleted administrator',a.action,a.resource,date(a.created_at)])));
    root.append(button('Refresh status',adminSystem));
  }
  async function materials(course){
    const root=el('resourcesDialog');root.replaceChildren(node('h2','','Course materials'),button('Close',()=>root.close()));root.showModal();
    try{const data=await api('/api/materials'+(course?'?course='+encodeURIComponent(course):''));
      root.append(node('p','muted',`${data.total} study files ready to open or download`));
      root.append(table(['#','Course','Material','Type','Size','Actions'],data.materials.map((m,i)=>{
        const act=node('div','toolbar');
        const openInPlayer=button('Open in browser',()=>{root.close();window.openFlowItem?.(m);});
        const dl=node('a','btn btn-outline','Download');dl.href=m.download_url||(m.url+'?download=1');dl.setAttribute('download','');
        act.append(openInPlayer,dl);
        return [String(i+1).padStart(2,'0'),m.course,m.friendly_name||m.name,m.material_type||m.ext,`${m.size_kb} KB`,act];
      })));}
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
  el('lessonSearch').oninput=e=>{
    const query=e.target.value.toLowerCase();
    document.querySelectorAll('.lesson-link').forEach(link=>{link.hidden=!link.textContent.toLowerCase().includes(query);});
    document.querySelectorAll('.lesson-section').forEach(sec=>{
      const anyVisible=[...sec.querySelectorAll('.lesson-link')].some(l=>!l.hidden);
      sec.hidden=Boolean(query)&&!anyVisible;
      if(query&&anyVisible)sec.open=true;
    });
  };
  el('previousLessonBtn').onclick=()=>{
    const previous=window.CourseForgeStudio?.adjacent(-1);
    if(previous)openVideo(previous.id).catch(error=>toast(error.message,true));
    else toast('You are at the first lesson in this course.');
  };
  window.CourseForgeAcademy={materials,stopActivity,leaveLesson,startActivity,loadBookmarks,parseTimestamp,workspace,adminCourses,adminCourseDetail};
  window.addEventListener('courseforge-session-expired',()=>{account.user=null;account.csrf='';resetBrowser();});
  window.addEventListener('courseforge-task',()=>toast('Learning task queued. This view will update when it finishes.'));
  el('catalogNav').onclick=()=>catalog().catch(e=>message(e.message,true));el('learningNav').onclick=()=>workspace().catch(e=>message(e.message,true));
  el('accountNav').onclick=()=>myAccount().catch(e=>message(e.message,true));el('adminNav').onclick=()=>adminHome().catch(e=>message(e.message,true));
  el('signinNav').onclick=()=>signIn();el('registerNav').onclick=()=>signIn('register');el('logoutNav').onclick=async()=>{try{await api('/api/auth/logout',json('POST',{}));resetBrowser();}catch(error){message(error.message,true);}};
  async function boot(){
    try{const r=await api('/api/me/bootstrap');account.user=r.user;account.csrf=r.csrf_token;account.bootstrap=r;}
    catch(error){if(error.status===403){const r=await api('/api/me');account.user=r.user;account.csrf=r.csrf_token;}else if(error.status!==401)message(error.message,true);}
    for(const id of ['learningNav','accountNav','logoutNav'])el(id).hidden=!account.user;
    el('jobSummary').hidden=account.user?.role!=='admin';el('signinNav').hidden=Boolean(account.user);el('adminNav').hidden=account.user?.role!=='admin';
    const options=account.bootstrap?.options||await api('/api/public/account-options');el('registerNav').hidden=Boolean(account.user)||!options.registration_enabled;
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
      if(route.startsWith('students/'))await adminStudent(decodeURIComponent(route.slice(9)));
      else if(route.startsWith('courses/'))await adminCourseDetail(decodeURIComponent(route.slice(8)));
      else await ({students:adminUsers,courses:adminCourses,player:adminPlayer,system:adminSystem}[route]||adminHome)();
    }
    else if(account.user?.verified)await workspace();else await catalog();
  }
  boot().catch(error=>{page('CourseForge');message(error.message,true);});
})();
