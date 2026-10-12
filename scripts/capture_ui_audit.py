#!/usr/bin/env python3
"""Capture real CourseForge views using a disposable, anonymized catalog copy.

No accounts, learning records, configuration, or provider mappings are written
to production. Error variants use browser-scoped response failures. Screenshots
and geometry are evidence, not automatically classified visual findings.
"""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import html
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
WIDTHS = (320, 390, 768, 1366, 1920)
GEOMETRY_SOURCE = (ROOT/'scripts/ui_geometry.js').read_text()


def seed(source, destination):
    """Preserve public course content; discard every private/runtime table."""
    from app.config import settings
    from app import db, learning_paths, study, assessments
    keep = {'videos', 'chunks', 'course_metadata', 'syllabi', 'schema_migrations',
            'course_publication', 'lecture_providers', 'course_lesson_organization',
            'course_materials_meta', 'lesson_quizzes', 'lesson_briefs'}
    with sqlite3.connect(f'file:{source}?mode=ro', uri=True) as src, sqlite3.connect(destination) as dst:
        src.backup(dst)
        names = [r[0] for r in dst.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        for name in names:
            if name not in keep and not name.startswith(('sqlite_', 'chunks_fts')):
                dst.execute('DELETE FROM "' + name.replace('"', '""') + '"')
        now = db.utcnow()
        for uid, name, role in [('audit-admin','Audit administrator','admin'),
                                ('audit-learner','Audit learner','student'),
                                ('audit-empty','New learner','student')]:
            dst.execute('INSERT INTO users VALUES(?,?,?,?,?,1,0,?)',
                        (uid,uid+'@example.test',name,'disabled',role,now))
        for course, in dst.execute('SELECT DISTINCT course FROM videos').fetchall():
            dst.execute('INSERT OR REPLACE INTO course_publication VALUES(?,1,?,?)',(course,'',now))
            dst.execute('INSERT INTO enrollments VALUES(?,?,?)',('audit-learner',course,now))
        row = dst.execute('SELECT v.id,v.course,v.title FROM videos v JOIN lecture_providers p ON p.video_id=v.id '
                          "ORDER BY CASE WHEN v.course='Deepak Data Engg' THEN 0 ELSE 1 END,v.title LIMIT 1").fetchone()
        if not row:
            row = dst.execute('SELECT id,course,title FROM videos ORDER BY course,title LIMIT 1').fetchone()
        vid, course, title = row
        # Deterministic educational fixtures exercise populated UI branches.
        # They exist only in this disposable database and are labelled below.
        doc = {'course':course,'source_fingerprint':'ui-audit-fixture', 'topics':[
            {'title':'SQL fundamentals','objectives':['Review source concepts'],
             'sources':[{'video_id':vid,'video_title':title,'start':0}]}]}
        dst.execute('INSERT OR REPLACE INTO syllabi VALUES(?,?,?,?)',(course,json.dumps(doc),now,'ui-audit-fixture'))
        dst.execute("UPDATE videos SET status='done' WHERE id=?",(vid,))
        dst.execute('INSERT OR REPLACE INTO chunks VALUES(?,?,?,?,?,?,?)',
                    ('ui-audit-excerpt',vid,'speech',0,90,'SQL joins combine related records using matching keys.',None))
        dst.execute('INSERT OR REPLACE INTO lesson_briefs VALUES(?,?,?,?,?,?)',
                    (vid,course,json.dumps(['Review the core concepts','Follow a worked example','Practise using source notes']),
                     'Basic SQL concepts','Understand the source example',now))
    db.learner_id.set('audit-learner')
    path=learning_paths.generate([course],'Review SQL fundamentals',db_path=destination,use_ai=False)
    study.add_cards(course,[{'video_id':vid,'question':'What does a SQL join combine?',
                            'answer':'Related records using matching keys.','source_start':0}],destination)
    study.add_note(vid,12,'Audit sample note: review the worked example and practise the next step.',destination)
    with db.connect(destination) as conn:
        conn.execute('INSERT INTO bookmarks VALUES(?,?,?,?,?,?)',
                     ('audit-bookmark','audit-learner',vid,12,'Worked example',now))
    def questions(topic, evidence, count):
        return {'questions':[{'question':f'Which expression combines related records? (example {i+1})',
                'options':['SQL JOIN','ORDER BY','LIMIT','COUNT'], 'correct_index':0, 'source_index':0,
                'explanation':'The source example combines related records using matching keys.',
                'concept':'SQL joins'} for i in range(count)]}
    assessment=assessments.create(path['id'],path['steps'][0]['id'],db_path=destination,generator=questions)
    print(json.dumps({'video':vid,'course':course,'path':path['id'],'step':path['steps'][0],
                      'assessment':assessment,'fixture_note':'Catalog copied from production; private data removed; educational fixtures seeded locally.'}))


def token_ledger():
    findings=[]
    props=re.compile(r'^(?:color|background(?:-color)?|border(?:-radius|-color)?|padding(?:-.+)?|margin(?:-.+)?|gap|(?:min-|max-)?(?:width|height)|font(?:-size|-weight|-family)?|line-height|box-shadow|grid-template-columns|stroke-width)$')
    for path in sorted((ROOT/'app/static').glob('*.css')):
        if path.name in ('tokens.css','core.css','tools.css'):continue
        raw=path.read_text()
        for rule in re.finditer(r'([^{}]+)\{([^{}]*)\}',raw):
            selector=rule.group(1).strip()
            for decl in re.finditer(r'([\w-]+)\s*:\s*([^;{}]+)',rule.group(2)):
                prop,value=decl.groups()
                if props.match(prop) and re.search(r'#[\da-fA-F]{3,8}\b|\brgba?\(|\b\d+(?:\.\d+)?px\b',value):
                    findings.append({'file':str(path.relative_to(ROOT)),
                        'line':raw[:rule.start(2)+decl.start()].count('\n')+1,
                        'selector':selector,'property':prop,'value':value.strip()})
    inline=[]
    for path in sorted((ROOT/'app/static').glob('*')):
        if path.suffix not in ('.html','.js') or path.name in ('core.js','tools.js'):continue
        for number,line in enumerate(path.read_text().splitlines(),1):
            if re.search(r'style=|\.style\.(?:cssText|background|color|padding|margin|fontSize|border|borderRadius)',line):
                inline.append({'file':str(path.relative_to(ROOT)),'line':number,'source':line.strip()[:500]})
    return {'css_literals':findings,'inline_style_candidates':inline,
            'note':'Candidates require classification. Geometry, artwork coordinates, progress percentages, and protected player overlays can have legitimate dynamic values.'}


def gallery(output, records, label):
    groups={}
    for record in records:groups.setdefault(record['view'],[]).append(record)
    sections=[]
    for view, rows in groups.items():
        tiles=''.join(f'<a href="{r["screenshot"]}"><b>{r["width"]} px</b><img loading="lazy" src="{r["screenshot"]}" alt="{html.escape(view)} at {r["width"]} pixels"></a>' for r in rows)
        sections.append(f'<section id="{view}"><h2>{html.escape(view)}</h2><div class="shots">{tiles}</div></section>')
    content='<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>CourseForge UI evidence</title><style>body{font:16px system-ui;margin:24px;background:#f7f8fb;color:#162039}h1{font-size:28px}.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}a{display:block;color:inherit;background:white;border:1px solid #ddd;border-radius:12px;padding:12px}img{display:block;width:100%;height:260px;object-fit:contain;object-position:top;margin-top:12px}section{margin-block:40px}</style>'
    content+=f'<h1>{html.escape(label)}</h1><p>320 / 390 / 768 / 1366 / 1920 px. Click a screenshot for full resolution. Isolated accounts and educational fixtures; real shipped UI and real course catalog.</p>'
    (output/'index.html').write_text(content+''.join(sections))


def capture(args):
    from app.config import settings
    import httpx
    from playwright.sync_api import sync_playwright
    output=Path(args.output).resolve();output.mkdir(parents=True,exist_ok=True)
    screenshots=output/'screenshots';screenshots.mkdir(exist_ok=True)
    records=[];failures=[]
    with tempfile.TemporaryDirectory(prefix='courseforge-ui-audit-') as folder:
        data=Path(folder);destination=data/'courseforge.sqlite3'
        env=dict(os.environ,DATA_DIR=folder,COURSES_DIR=str(settings.courses_dir),COOKIE_SECURE='0',
                 ALLOWED_HOSTS='127.0.0.1',REGISTRATION_MODE='open',SMTP_HOST='',SMTP_PASSWORD='')
        fixture=json.loads(subprocess.check_output([sys.executable,__file__,'--seed',str(settings.db_path),str(destination)],env=env,text=True))
        if (settings.data_dir/'artwork').exists():shutil.copytree(settings.data_dir/'artwork',data/'artwork')
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        base=f'{"https" if args.proof else "http"}://127.0.0.1:{port}';env['PUBLIC_BASE_URL']=base
        tls=[]
        if args.proof:
            cert=data/'loopback.crt';key=data/'loopback.key'
            subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(key),'-out',str(cert),'-subj','/CN=127.0.0.1','-days','1'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            tls=['--ssl-certfile',str(cert),'--ssl-keyfile',str(key)]
        with (data/'server.log').open('w') as log:
            server=subprocess.Popen([sys.executable,'-m','uvicorn','app.main:app','--host','127.0.0.1','--port',str(port)]+tls,cwd=ROOT,env=env,stdout=log,stderr=log)
            try:
                for _ in range(100):
                    if server.poll() is not None:raise RuntimeError((data/'server.log').read_text()[-2000:])
                    try:
                        if httpx.get(base+'/api/health',timeout=1,verify=not args.proof).status_code==200:break
                    except httpx.HTTPError:pass
                    time.sleep(.1)
                else:raise RuntimeError('Isolated application failed to start')
                expires=(datetime.now(timezone.utc)+timedelta(hours=4)).isoformat(timespec='seconds')
                tokens={}
                with sqlite3.connect(destination) as conn:
                    for uid in ('audit-admin','audit-learner','audit-empty'):
                        token=secrets.token_urlsafe(32);tokens[uid]=token
                        conn.execute('INSERT INTO auth_sessions VALUES(?,?,?,?,?,?,?,?,?)',
                            (uid,uid,hashlib.sha256(token.encode()).hexdigest(),secrets.token_urlsafe(32),
                             datetime.now(timezone.utc).isoformat(),expires,datetime.now(timezone.utc).isoformat(),'Audit browser','127.0.0.1'))
                with sync_playwright() as pw:
                    browser=pw.chromium.launch()
                    for width in args.widths:
                        context=browser.new_context(viewport={'width':width,'height':900},device_scale_factor=1,service_workers='block',ignore_https_errors=args.proof)
                        page=context.new_page();page.set_default_timeout(15000)
                        errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
                        uid=None
                        def user(next_uid):
                            nonlocal uid
                            if uid==next_uid:return
                            context.clear_cookies()
                            if next_uid:context.add_cookies([{'name':'cf_session','value':tokens[next_uid],'url':base}])
                            uid=next_uid
                        def go(route='dashboard', who='audit-learner'):
                            user(who);page.goto(base+'/?ui-audit='+secrets.token_hex(4)+'#'+route,wait_until='domcontentloaded')
                            if who and not route.startswith(('admin','courses','account')):
                                page.wait_for_function('window.CourseForgeReady===true || !!document.querySelector(".player-dialog[open]")',timeout=60000)
                                if page.locator('.player-dialog[open]').count():
                                    page.get_by_role('button',name='Move playback here',exact=True).click()
                                    page.wait_for_function('window.CourseForgeReady===true',timeout=60000)
                                page.evaluate('window.CourseForgeLoadTools()')
                            page.wait_for_timeout(500)
                        def shot(view, focus=None, note='Real UI; isolated records'):
                            page.wait_for_timeout(150)
                            # Full-page evidence warms content that normally renders while scrolling.
                            page.add_style_tag(content='.lesson-link,.episode-row { content-visibility: visible !important; }')
                            page.evaluate('for (const img of document.images) img.loading="eager"')
                            if focus:
                                target=page.locator(focus);target.scroll_into_view_if_needed()
                            else:page.evaluate('window.scrollTo(0,0)')
                            name=f'screenshots/{view}-{width}.png'
                            page.screenshot(path=str(output/name),full_page=not focus and not page.locator('dialog[open]').count())
                            page.evaluate('window.CourseForgeComponents?.apply(document)')
                            page.add_script_tag(content=GEOMETRY_SOURCE)
                            geometry=page.evaluate('CourseForgeUIAudit()')
                            records.append({'view':view,'width':width,'screenshot':name,'note':note,
                                            'geometry':geometry,'page_errors':list(errors)})
                            (output/'measurements.json').write_text(json.dumps(records,indent=2))
                            print(f'{width}px {view}: {len(geometry["overflow"])} overflow candidates; {len(geometry["clipped"])} clipped controls',flush=True)
                        def run(view, action):
                            if args.groups and view not in args.groups:
                                return
                            try:action()
                            except Exception as exc:
                                failures.append({'view':view,'width':width,'error':str(exc)[:1500]})
                                print(f'CAPTURE FAILED {width}px {view}: {str(exc).splitlines()[0]}',flush=True)
                        def public():
                            go('courses',None);shot('public-catalog')
                            page.locator('article.academy-course').first.get_by_role('button').click();shot('public-course-syllabus')
                            page.locator('#signinNav').click();shot('sign-in')
                            page.locator('#registerNav').click();shot('register')
                            page.get_by_role('button',name='Forgot password',exact=True).click();shot('password-recovery-disabled')
                            page.locator('#signinNav').click()
                            page.route('**/api/auth/login',lambda route:route.fulfill(status=401,json={'detail':'Invalid email or password'}))
                            page.locator('input[name=email]').fill('audit@example.test');page.locator('input[name=password]').fill('invalid-example')
                            page.locator('.academy-form button[type=submit]').click();page.wait_for_selector('#academyMessage:not([hidden])');shot('sign-in-error')
                            page.unroute('**/api/auth/login')
                        run('public',public)
                        def dashboard():
                            go();shot('dashboard');shot('header-navigation','.topbar')
                            if width<=970:page.locator('#mobileMenu').click()
                            shot('workspace-sidebar','#sidebar')
                            if width<=970:page.keyboard.press('Escape')
                            page.locator('#notifyBtn').click();shot('notification-popover','#notifyPopover');page.locator('#closeNotify').evaluate('(e)=>e.click()')
                            page.locator('#themeBtn').click();shot('appearance-popover','#themePopover');page.locator('#closeTheme').evaluate('(e)=>e.click()')
                        run('dashboard',dashboard)
                        def library():
                            go('library');shot('library-grid')
                            page.locator('#librarySearch').fill('no-result-audit-xyz');shot('library-no-results');page.locator('#librarySearch').fill('')
                            page.locator('#openPlacementBtn').click();page.wait_for_timeout(350);shot('placement-dialog');page.keyboard.press('Escape')
                            page.locator('#globalSearch').fill('no-result-audit-xyz');page.wait_for_timeout(600);shot('search-no-results')
                        run('library',library)
                        def title():
                            go('/course/deepak-data-engg');page.wait_for_selector('#titleDetailDialog[open]');page.wait_for_timeout(700)
                            shot('course-title-episodes');page.locator('.title-tab').filter(has_text='Details').click();shot('course-title-details')
                            page.keyboard.press('Escape')
                        run('course-title',title)
                        def materials():
                            go('library');page.evaluate('CourseForgeAcademy.materials()');page.wait_for_timeout(600);shot('study-materials-browser')
                            page.keyboard.press('Escape')
                        run('materials',materials)
                        def lesson():
                            go('learning/'+fixture['video']);page.wait_for_timeout(1000)
                            shot('player-and-chrome');shot('lesson-sidebar','#panel-lessons')
                            page.evaluate("selectLessonTab('notes')");shot('notes','#panel-notes');shot('bookmarks','#bookmarksList')
                            for tab in ('brief','quiz','transcript','summary','path'):
                                page.evaluate('tab=>selectLessonTab(tab)',tab);shot('lesson-'+tab,'[data-lesson-panel="'+tab+'"]')
                            if page.locator('#lessonMaterialsSection').is_visible():
                                shot('lesson-materials','#lessonMaterialsSection')
                                page.evaluate("selectLessonTab('materials')");shot('lesson-materials-rail','#panel-materials')
                            else:
                                # Materials fixture responses are routed through the real renderer.
                                material={'course':fixture['course'],'lesson_id':fixture['video'],'name':'audit-example.pdf','friendly_name':'Worked example notes',
                                          'ext':'pdf','material_type':'PDF','size_kb':128,'url':'/api/materials/audit-example','download_url':'/api/materials/audit-example?download=1','scope':'lesson'}
                                page.evaluate('material=>{state.materials.push(material);renderLessonMaterials(state.videos.find(v=>v.id===state.currentVideoId))}',material)
                                shot('lesson-materials','#lessonMaterialsSection',note='Real materials renderer; local PDF metadata fixture')
                                page.evaluate("selectLessonTab('materials')");shot('lesson-materials-rail','#panel-materials',note='Real materials renderer; local PDF metadata fixture')
                            page.evaluate("selectLessonTab('lessons')")
                            page.locator('#lessonSearch').fill('no-result-audit-xyz');shot('lesson-search-empty','#panel-lessons')
                        run('lesson',lesson)
                        def views():
                            for route in ('settings','tutor','reviews','syllabus','labs','planner'):
                                go(route);shot({'labs':'practice-labs','syllabus':'study-paths','reviews':'reviews-empty-answer'}.get(route,route))
                            shot('focus-sessions','.focus-studio');shot('weekly-calendar','.weekly-calendar');shot('daily-plan-empty','.planner-day')
                            page.locator('#focusStart').click();page.wait_for_selector('#focusPause:not([hidden])');shot('focus-running','.focus-studio')
                            page.locator('#focusPause').click();page.wait_for_selector('#focusResume:not([hidden])');shot('focus-paused','.focus-studio')
                            page.locator('#focusFinish').click();page.wait_for_selector('#focusStart:not([hidden])');shot('focus-history','.focus-studio')
                            page.locator('#plannerCreate').click();page.wait_for_timeout(600);shot('daily-plan-populated','.planner-day')
                            go('labs');page.locator('.lab-card').first.click();page.wait_for_selector('#labEditor:not([hidden])');shot('practice-editor','#labEditor')
                            go('tutor');page.locator('#interviewPrepModeBtn').click();page.wait_for_timeout(500);shot('interview-dialog');page.keyboard.press('Escape')
                        run('learner-tools',views)
                        def assessment():
                            go('syllabus')
                            pattern='**/api/learning-paths/*/steps/*/assessments'
                            page.route(pattern,lambda route:route.fulfill(json=fixture['assessment']))
                            page.evaluate('data=>CourseForgeAssessments.begin(data.path,data.step)',fixture)
                            shot('assessments','#assessmentPanel',note='Real assessment UI; seeded source-linked question response (no AI worker)')
                            page.unroute(pattern)
                        run('assessments',assessment)
                        def admin():
                            for route,label in [('admin','admin-dashboard'),('admin/students','admin-accounts-invitations'),
                                                ('admin/students/audit-learner','admin-user-tracking'),('admin/courses','admin-courses'),
                                                ('admin/player','admin-player-activity'),('admin/system','admin-system-audit')]:
                                go(route,'audit-admin');shot(label)
                            go('admin/students','audit-admin');shot('admin-invitation-form','.academy-form:last-of-type')
                        run('admin',admin)
                        def empty():
                            for route,label in [('dashboard','dashboard-empty'),('library','library-empty'),('learning','player-empty'),
                                                ('reviews','reviews-empty'),('syllabus','study-paths-empty'),('planner','planner-empty')]:
                                go(route,'audit-empty');shot(label)
                            go('/my-list');page.wait_for_timeout(350);shot('my-list-empty')
                            go('/history');page.wait_for_timeout(350);shot('watch-history-empty')
                        run('empty-states',empty)
                        def errors_ui():
                            go('library');page.route('**/api/materials*',lambda route:route.fulfill(status=503,json={'detail':'Study materials are temporarily unavailable. Please retry.'}))
                            page.evaluate('CourseForgeAcademy.materials()');page.wait_for_timeout(250);shot('materials-error');page.keyboard.press('Escape');page.unroute('**/api/materials*')
                            go('library');page.route('**/api/streaming/courses/*',lambda route:route.fulfill(status=503,json={'detail':'Course details are temporarily unavailable.'}))
                            page.evaluate("CourseForgeTitle.openTitleModal('deepak-data-engg')");page.wait_for_timeout(500);shot('course-title-error');page.keyboard.press('Escape');page.unroute('**/api/streaming/courses/*')
                            page.route('**/api/videos/*/native-session*',lambda route:route.fulfill(status=503,json={'detail':'Playback temporarily unavailable'}))
                            go('learning/'+fixture['video']);page.wait_for_timeout(1000);shot('player-error');page.unroute('**/api/videos/*/native-session*')
                        run('error-states',errors_ui)
                        def more_states():
                            go();page.locator('#accountNav').click();page.wait_for_timeout(350);shot('account-profile-devices')
                            for action,label in [('activate','invitation-activation'),('reset','password-reset')]:
                                user(None);page.goto(base+'/?action='+action+'&token=local-ui-example',wait_until='domcontentloaded')
                                page.wait_for_selector('.academy-form');shot(label)
                                page.locator('[name=password]').fill('local-ui-example')
                                page.locator('.academy-form button[type=submit]').click();page.wait_for_selector('#academyMessage:not([hidden])');shot(label+'-invalid-link')
                            go('reviews')
                            if page.locator('#revealAnswerBtn').is_visible():
                                shot('reviews-question','#reviewCard');page.locator('#revealAnswerBtn').click();shot('reviews-answer','#reviewCard')
                            go('planner');page.locator('#weekBuild').click();page.wait_for_timeout(500);shot('weekly-calendar-populated','.weekly-calendar')
                            page.locator('#weekDaysInput input').first.fill('1');page.locator('#weekBuild').click();shot('weekly-calendar-validation','.weekly-calendar')
                            page.route('**/api/planner/days',lambda route:route.fulfill(status=503,json={'detail':'Your plan could not be saved. Please retry.'}))
                            page.locator('#plannerCreate').click();page.wait_for_timeout(250);shot('daily-plan-error','.planner-controls');page.unroute('**/api/planner/days')
                            if page.locator('#focusFinish').is_visible():
                                page.locator('#focusFinish').click();page.wait_for_selector('#focusStart:not([hidden])')
                            page.route('**/api/focus/sessions',lambda route:route.fulfill(status=503,json={'detail':'Your focus session could not start. Please retry.'}))
                            page.locator('#focusStart').click();page.wait_for_timeout(250);shot('focus-error','.focus-studio');page.unroute('**/api/focus/sessions')
                            go('learning/'+fixture['video'])
                            page.route('**/api/videos/*/notes',lambda route:route.fulfill(json={'notes':[]}))
                            page.route('**/api/videos/*/bookmarks',lambda route:route.fulfill(json={'bookmarks':[]}))
                            page.evaluate('id=>Promise.all([loadNotes(id),CourseForgeAcademy.loadBookmarks(id)])',fixture['video'])
                            page.evaluate("selectLessonTab('notes')");shot('notes-bookmarks-empty','#panel-notes')
                            page.unroute('**/api/videos/*/notes');page.unroute('**/api/videos/*/bookmarks')
                            go('syllabus');pattern='**/api/learning-paths/*/steps/*/assessments'
                            page.route(pattern,lambda route:route.fulfill(json=fixture['assessment']))
                            page.evaluate('data=>CourseForgeAssessments.begin(data.path,data.step)',fixture)
                            for question in page.locator('.assessment-question').all():question.locator('input').first.check()
                            page.locator('#assessmentSubmit').click();page.wait_for_selector('#assessmentResult:not([hidden])');shot('assessments-result','#assessmentPanel')
                            page.unroute(pattern)
                            page.route(pattern,lambda route:route.fulfill(status=503,json={'detail':'Questions are temporarily unavailable. Please retry.'}))
                            page.evaluate('data=>CourseForgeAssessments.begin(data.path,data.step)',fixture);shot('assessments-error','#assessmentPanel');page.unroute(pattern)
                            go('admin/courses/'+quote(fixture['course'],safe=''),'audit-admin');shot('admin-course-lessons-files')
                            go('admin/students','audit-admin')
                            page.route('**/api/admin/users?q=*',lambda route:route.fulfill(json={'users':[],'total':0}))
                            page.locator('.academy-form').first.locator('[name=q]').fill('no-result-audit-xyz')
                            page.locator('.academy-form').first.locator('button[type=submit]').click();page.wait_for_timeout(300);shot('admin-accounts-empty');page.unroute('**/api/admin/users?q=*')
                            go('library');page.evaluate('CourseForgeAcademy.materials()');page.wait_for_timeout(250)
                            page.route('**/api/materials*',lambda route:route.fulfill(json={'materials':[],'total':0}))
                            page.keyboard.press('Escape');page.evaluate('CourseForgeAcademy.materials()');page.wait_for_timeout(250);shot('materials-empty');page.keyboard.press('Escape');page.unroute('**/api/materials*')
                            page.route('**/api/streaming/history*',lambda route:route.fulfill(status=503,json={'detail':'Watch history temporarily unavailable.'}))
                            go('/history');page.wait_for_timeout(300);shot('watch-history-error');page.unroute('**/api/streaming/history*')
                            go('tutor');page.route('**/api/ask',lambda route:route.fulfill(status=503,json={'detail':'The tutor is temporarily unavailable. Please retry.'}))
                            page.locator('#question').fill('Explain SQL joins');page.locator('#askForm button[type=submit]').click();page.wait_for_timeout(250);shot('tutor-error');page.unroute('**/api/ask')
                        run('additional-states',more_states)
                        if args.proof and width==args.widths[-1]:
                            from scripts.ui_clickthrough import prove
                            report=prove(page,browser,go,fixture,destination,base)
                            (output/'clickthrough.json').write_text(json.dumps(report,indent=2))
                            if not report['passed']:failures.append({'view':'clickthrough','width':width,'error':'See clickthrough.json'})
                        context.close()
                    browser.close()
            finally:
                server.terminate()
                try:server.wait(timeout=15)
                except subprocess.TimeoutExpired:server.kill();server.wait(timeout=5)
    (output/'measurements.json').write_text(json.dumps(records,indent=2))
    (output/'capture-failures.json').write_text(json.dumps(failures,indent=2))
    (output/'token-ledger.json').write_text(json.dumps(token_ledger(),indent=2))
    (output/'manifest.json').write_text(json.dumps({'stage':args.label,'captured_at':datetime.now(timezone.utc).isoformat(),
         'commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
         'widths':args.widths,'screenshots':len(records),'views':sorted({r['view'] for r in records}),
         'failures':failures,'fixture_note':fixture['fixture_note']},indent=2))
    gallery(output,records,args.label)
    print(json.dumps({'screenshots':len(records),'views':len({r['view'] for r in records}),'failures':failures},indent=2))
    violations=[{'view':r['view'],'width':r['width'],'issues':{k:r['geometry'][k] for k in ('overflow','clipped','gridFailures','unmapped','badIcons') if r['geometry'][k]}} for r in records if any(r['geometry'][k] for k in ('overflow','clipped','gridFailures','unmapped','badIcons'))]
    (output/'validation.json').write_text(json.dumps({'passed':not failures and not violations,'capture_failures':failures,'violations':violations},indent=2))
    return bool(failures or (args.strict and violations))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--proof',action='store_true',help='Run real isolated admin/learner and playback actions')
    parser.add_argument('--strict',action='store_true',help='Fail on overflow, clipping, card geometry or component violations')
    parser.add_argument('--seed',nargs=2,metavar=('SOURCE','DESTINATION'))
    parser.add_argument('--output',default='docs/ui-evidence/stage-1')
    parser.add_argument('--label',default='Stage 1 — Before fixes')
    parser.add_argument('--widths',nargs='+',type=int,default=list(WIDTHS))
    parser.add_argument('--groups',nargs='+',help='Run selected capture groups for targeted rechecks')
    args=parser.parse_args()
    if args.seed:seed(Path(args.seed[0]),Path(args.seed[1]))
    else:sys.exit(capture(args))
