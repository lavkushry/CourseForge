import re

with open('/home/ubuntu/CourseForge/app/static/academy.js', 'r') as f:
    js = f.read()

# 1. Patch adminPage to return body container
old_adminPage = """  function adminPage(title,section=''){
    document.body.classList.add('in-admin');
    history.replaceState(null,'',`/#admin${section?'/'+section:''}`);
    const root=page(title);

    const topBar=node('div','admin-topbar');
    const breadcrumb=node('div','admin-breadcrumb');
    breadcrumb.innerHTML=`<a href="#dashboard">Dashboard</a><span class="crumb-sep">/</span><a href="/#admin">Admin</a><span class="crumb-sep">/</span><span class="crumb-curr">${title}</span>`;
    const backBtn=button('← Back to Academy',()=>{document.body.classList.remove('in-admin');workspace();});
    backBtn.className='btn btn-outline admin-back-btn';
    topBar.append(breadcrumb,backBtn);

    const nav=node('nav','admin-navigation');nav.setAttribute('aria-label','Administration');
    for(const [label,route,action] of [['Overview','',adminHome],['Students','students',adminUsers],['Courses','courses',adminCourses],['Player activity','player',adminPlayer],['System & audit','system',adminSystem]]){
      const b=button(label,()=>action());if(section.split('/')[0]===route){b.classList.add('active');b.setAttribute('aria-current','page');}nav.append(b);
    }
    const h1=root.querySelector('h1');
    if(h1){h1.className='admin-page-title';root.insertBefore(topBar,h1);h1.after(nav);}
    else{root.prepend(topBar,nav);}
    return root;
  }"""

new_adminPage = """  function adminPage(title,section=''){
    document.body.classList.add('in-admin');
    history.replaceState(null,'',`/#admin${section?'/'+section:''}`);
    const root=page(title);

    const topBar=node('div','admin-topbar');
    const breadcrumb=node('div','admin-breadcrumb');
    breadcrumb.innerHTML=`<a href="#dashboard">Dashboard</a><span class="crumb-sep">/</span><a href="/#admin">Admin</a><span class="crumb-sep">/</span><span class="crumb-curr">${title}</span>`;
    const backBtn=button('← Back to Academy',()=>{document.body.classList.remove('in-admin');workspace();});
    backBtn.className='btn btn-outline admin-back-btn';
    topBar.append(breadcrumb,backBtn);

    const nav=node('nav','admin-navigation');nav.setAttribute('aria-label','Administration');
    for(const [label,route,action] of [['Overview','',adminHome],['Students','students',adminUsers],['Courses','courses',adminCourses],['Player activity','player',adminPlayer],['System & audit','system',adminSystem]]){
      const b=button(label,()=>action());if(section.split('/')[0]===route){b.classList.add('active');b.setAttribute('aria-current','page');}nav.append(b);
    }
    const h1=root.querySelector('h1');
    if(h1){h1.className='admin-page-title';root.insertBefore(topBar,h1);h1.after(nav);}
    else{root.prepend(topBar,nav);}
    const body=node('div','admin-body');
    root.append(body);
    return body;
  }"""

assert old_adminPage in js, 'old_adminPage not found in academy.js'
js = js.replace(old_adminPage, new_adminPage)

# 2. Patch adminHome
old_adminHome = """  async function adminHome(){
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
  }"""

new_adminHome = """  async function adminHome(){
    const root=adminPage('Administration');
    const actionsBar=node('div','toolbar');
    actionsBar.append(button('↻ Refresh metrics',adminHome));
    root.append(actionsBar);
    const report=await api('/api/admin/overview');
    if(!root.isConnected)return;
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
      if(!root.isConnected)return;
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
  }"""

assert old_adminHome in js, 'old_adminHome not found in academy.js'
js = js.replace(old_adminHome, new_adminHome)

# 3. Patch adminUsers
old_adminUsers = """  async function adminUsers(query='',offset=0){
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
  }"""

new_adminUsers = """  async function adminUsers(query='',offset=0){
    const root=adminPage('Student management','students');
    const searchForm=form(root,'Find a student',data=>adminUsers(data.get('q')));field(searchForm,'Name or email','q','search',false).value=query;submitButton(searchForm,'Search');
    const result=await api(`/api/admin/users?q=${encodeURIComponent(query)}&offset=${offset}`);
    if(!root.isConnected)return;
    root.append(node('p','muted',`${result.total} accounts`));
    root.append(table(['Student','Email','Status','Courses','Completion','Lesson activity','Details'],result.users.map(u=>[u.name,u.email,u.suspended?'Suspended':u.verified?'Active':'Pending activation',u.enrollments,u.completed_lessons,minutes(u.activity_seconds),button('Inspect',()=>adminStudent(u.id))])));
    const pager=node('div','toolbar');if(offset)pager.append(button('Previous',()=>adminUsers(query,Math.max(0,offset-25))));if(offset+25<result.total)pager.append(button('Next',()=>adminUsers(query,offset+25)));root.append(pager);
    const create=form(root,'Invite a student',async data=>{const payload=Object.fromEntries(data);if(!payload.course)delete payload.course;const r=await api('/api/admin/invitations',json('POST',payload));create.reset();privateLink(root,r.activation_url,r.expires_at,r.message);});
    create.append(node('p','muted','The student chooses their own password using a one-time activation link. No email service is required.'));
    field(create,'Name','name');field(create,'Email','email','email');
    const courses=await api('/api/admin/courses');
    if(!root.isConnected)return;
    const label=node('label','field');label.append(node('span','','Grant a course (optional)'));const select=node('select','form-input');select.name='course';select.add(new Option('No course selected',''));courses.courses.forEach(c=>select.add(new Option(c.title+(c.published?'':' (draft)'),c.id)));label.append(select);create.append(label);submitButton(create,'Create invitation');
  }"""

assert old_adminUsers in js, 'old_adminUsers not found in academy.js'
js = js.replace(old_adminUsers, new_adminUsers)

# 4. Patch adminCourses
old_adminCourses = """    const tableSlot=node('div','admin-courses-table-slot');root.append(tableSlot);
    const result=await api('/api/admin/courses');
    let courses=result.courses||[];"""

new_adminCourses = """    const tableSlot=node('div','admin-courses-table-slot');root.append(tableSlot);
    const result=await api('/api/admin/courses');
    if(!root.isConnected)return;
    let courses=result.courses||[];"""

assert old_adminCourses in js, 'old_adminCourses not found in academy.js'
js = js.replace(old_adminCourses, new_adminCourses)

old_map = """    const map=form(root,'Map an Odysee lecture',async data=>{await api(`/api/admin/videos/${encodeURIComponent(data.get('video_id'))}/provider`,json('PUT',{claim_name:data.get('claim_name'),claim_id:data.get('claim_id')}));message('Lecture mapping saved.');await adminCourses();});
    const videos=await api('/api/videos');const select=node('select','form-input');"""

new_map = """    const map=form(root,'Map an Odysee lecture',async data=>{await api(`/api/admin/videos/${encodeURIComponent(data.get('video_id'))}/provider`,json('PUT',{claim_name:data.get('claim_name'),claim_id:data.get('claim_id')}));message('Lecture mapping saved.');await adminCourses();});
    const videos=await api('/api/videos');
    if(!root.isConnected)return;
    const select=node('select','form-input');"""

assert old_map in js, 'old_map not found in academy.js'
js = js.replace(old_map, new_map)

# 5. Patch adminPlayer
old_adminPlayer = """    const criteria={days:'30',q:'',course:'',status:'all',...filters};
    const playback=await api('/api/admin/playback?'+new URLSearchParams({...criteria,offset}));
    heading(root,'Video playback',playback.basis);"""

new_adminPlayer = """    const criteria={days:'30',q:'',course:'',status:'all',...filters};
    const playback=await api('/api/admin/playback?'+new URLSearchParams({...criteria,offset}));
    if(!root.isConnected)return;
    heading(root,'Video playback',playback.basis);"""

assert old_adminPlayer in js, 'old_adminPlayer not found in academy.js'
js = js.replace(old_adminPlayer, new_adminPlayer)

old_player_mid = """    const courses=await api('/api/admin/courses');
    selectField(f,'Course','course',[['All courses',''],...courses.courses.map(c=>[c.title,c.id])],criteria.course);
    selectField(f,'Session status','status',[['All sessions','all'],['Live lesson pages','live']],criteria.status);submitButton(f,'Apply filters');
    const query=new URLSearchParams(criteria),report=await api('/api/admin/player-activity?'+query+'&offset='+offset);
    const bar=node('div','toolbar');"""

new_player_mid = """    const courses=await api('/api/admin/courses');
    if(!root.isConnected)return;
    selectField(f,'Course','course',[['All courses',''],...courses.courses.map(c=>[c.title,c.id])],criteria.course);
    selectField(f,'Session status','status',[['All sessions','all'],['Live lesson pages','live']],criteria.status);submitButton(f,'Apply filters');
    const query=new URLSearchParams(criteria),report=await api('/api/admin/player-activity?'+query+'&offset='+offset);
    if(!root.isConnected)return;
    const bar=node('div','toolbar');"""

assert old_player_mid in js, 'old_player_mid not found in academy.js'
js = js.replace(old_player_mid, new_player_mid)

# 6. Patch adminSystem
old_adminSystem = """  async function adminSystem(){
    const root=adminPage('System and administrator audit','system'),r=await api('/api/admin/system');
    heading(root,'Account delivery');"""

new_adminSystem = """  async function adminSystem(){
    const root=adminPage('System and administrator audit','system');
    const r=await api('/api/admin/system');
    if(!root.isConnected)return;
    heading(root,'Account delivery');"""

assert old_adminSystem in js, 'old_adminSystem not found in academy.js'
js = js.replace(old_adminSystem, new_adminSystem)

# 7. Patch adminCourseDetail
old_qRes = """    try{
      const qRes = await api(`/api/admin/courses/${encodeURIComponent(courseId)}/quizzes`);
      if(qRes.quizzes && qRes.quizzes.length){"""

new_qRes = """    try{
      const qRes = await api(`/api/admin/courses/${encodeURIComponent(courseId)}/quizzes`);
      if(!root.isConnected)return;
      if(qRes.quizzes && qRes.quizzes.length){"""

assert old_qRes in js, 'old_qRes not found in academy.js'
js = js.replace(old_qRes, new_qRes)

with open('/home/ubuntu/CourseForge/app/static/academy.js', 'w') as f:
    f.write(js)
print('Successfully applied tab isolation to academy.js')

# Now append responsive & admin-body CSS to academy.css
with open('/home/ubuntu/CourseForge/app/static/academy.css', 'r') as f:
    css = f.read()

responsive_css = """
/* Admin Body Container */
.in-admin .admin-body {
  display: block;
  width: 100%;
}

.in-admin .academy-table-wrap {
  overflow-x: auto !important;
  -webkit-overflow-scrolling: touch;
}

@media (max-width: 768px) {
  .in-admin .academy-content {
    padding: 16px 14px 60px !important;
  }
  body.in-admin .academy-header {
    padding: 10px 14px !important;
  }
  .admin-page-title {
    font-size: 20px !important;
  }
  .in-admin .academy-metrics {
    grid-template-columns: repeat(2, 1fr) !important;
    gap: 10px !important;
  }
  .in-admin .metric-card {
    padding: 14px !important;
  }
  .in-admin .metric-card strong {
    font-size: 20px !important;
  }
  .admin-topbar {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
}

@media (max-width: 480px) {
  .in-admin .academy-metrics {
    grid-template-columns: 1fr !important;
  }
}
"""

if '.in-admin .admin-body' not in css:
    css += responsive_css
    with open('/home/ubuntu/CourseForge/app/static/academy.css', 'w') as f:
        f.write(css)
    print('Successfully added responsive rules to academy.css')
