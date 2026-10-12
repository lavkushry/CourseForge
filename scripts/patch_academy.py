with open('/home/ubuntu/CourseForge/app/static/academy.js', 'r') as f:
    code = f.read()

# 1. Update table function
old_table = """  function table(headers,rows){
    const wrap=node('div','academy-table-wrap'),t=node('table','academy-table'),head=node('thead'),hrow=node('tr');
    headers.forEach(h=>hrow.append(node('th','',h)));head.append(hrow);t.append(head);
    const body=node('tbody');
    rows.forEach(values=>{const tr=node('tr');values.forEach((value,i)=>{const td=node('td');td.dataset.label=headers[i];if(value instanceof Node)td.append(value);else td.textContent=String(value??'—');tr.append(td);});body.append(tr);});
    if(!rows.length){const tr=node('tr'),td=node('td','muted','No records yet.');td.colSpan=headers.length;tr.append(td);body.append(tr);}
    t.append(body);wrap.append(t);return wrap;
  }"""

new_table = """  function table(headers,rows){
    const wrap=node('div','academy-table-wrap'),t=node('table','academy-table'),head=node('thead'),hrow=node('tr');
    headers.forEach(h=>hrow.append(node('th','',h)));head.append(hrow);t.append(head);
    const body=node('tbody');
    rows.forEach(values=>{
      const tr=node('tr');
      values.forEach((value,i)=>{
        const td=node('td');const h=headers[i]||'';td.dataset.label=h;
        if(value instanceof Node){td.append(value);}
        else{
          const s=String(value??'—'),lower=s.toLowerCase();
          if(s==='Active'||s==='Published'||s==='Playing'||s==='Live lesson page'||s==='Configured'||s==='Reported complete'||s==='100%'){
            const badge=node('span','badge badge-success',s);td.append(badge);
          }else if(s==='Suspended'||lower==='access denied'||s==='Inactive'||s==='Incomplete'||s==='Missing credentials'||s==='Failed'){
            const badge=node('span','badge badge-danger',s);td.append(badge);
          }else if(s==='Draft'||s==='Pending activation'||s==='Awaiting server credentials'){
            const badge=node('span','badge badge-warning',s);td.append(badge);
          }else if(/^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$/.test(s)||h.toLowerCase().includes('ip')){
            const mono=node('span','mono-code',s);td.append(mono);
          }else{td.textContent=s;}
        }
        tr.append(td);
      });
      body.append(tr);
    });
    if(!rows.length){const tr=node('tr'),td=node('td','muted text-center','No records yet.');td.colSpan=headers.length;tr.append(td);body.append(tr);}
    t.append(body);wrap.append(t);return wrap;
  }"""

assert old_table in code, 'old_table not found'
code = code.replace(old_table, new_table)

# 2. Update adminPage function
old_adminPage = """  function adminPage(title,section=''){
    history.replaceState(null,'',`/#admin${section?'/'+section:''}`);
    const root=page(title),nav=node('nav','admin-navigation');nav.setAttribute('aria-label','Administration');
    for(const [label,route,action] of [['Overview','',adminHome],['Students','students',adminUsers],['Courses','courses',adminCourses],['Player activity','player',adminPlayer],['System and audit','system',adminSystem]]){
      const b=button(label,()=>action());if(section.split('/')[0]===route){b.classList.add('active');b.setAttribute('aria-current','page');}nav.append(b);
    }root.append(nav);return root;
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
    return root;
  }"""

assert old_adminPage in code, 'old_adminPage not found'
code = code.replace(old_adminPage, new_adminPage)

# 3. Add document.body.classList.remove('in-admin') in workspace
old_workspace = "async function workspace(){\n    if(!account.user)return signIn();"
new_workspace = "async function workspace(){\n    document.body.classList.remove('in-admin');\n    if(!account.user)return signIn();"
assert old_workspace in code, 'old_workspace not found'
code = code.replace(old_workspace, new_workspace)

# 4. Add hashchange handler for admin
old_boot_call = "  boot().catch(error=>{page('CourseForge');message(error.message,true);});\n})();"
new_boot_call = """  window.addEventListener('hashchange',()=>{
    const adminRoute=location.hash.match(/^#admin(?:\\/(.*))?$/);
    if(adminRoute&&account.user?.role==='admin'){
      const route=adminRoute[1]||'';
      if(route.startsWith('students/'))adminStudent(decodeURIComponent(route.slice(9)));
      else if(route.startsWith('courses/'))adminCourseDetail(decodeURIComponent(route.slice(8)));
      else ({students:adminUsers,courses:adminCourses,player:adminPlayer,system:adminSystem}[route]||adminHome)();
    }
  });
  boot().catch(error=>{page('CourseForge');message(error.message,true);});
})();"""

assert old_boot_call in code, 'old_boot_call not found'
code = code.replace(old_boot_call, new_boot_call)

with open('/home/ubuntu/CourseForge/app/static/academy.js', 'w') as f:
    f.write(code)
print('Successfully patched academy.js')
