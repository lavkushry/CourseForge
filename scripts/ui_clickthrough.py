"""Real UI actions against the capture server's disposable database only."""
import sqlite3


def prove(page, browser, go, fixture, destination, base):
    checks=[];phase={}
    def check(name, action):
        try:
            detail=action()
            checks.append({'name':name,'status':'PASS','detail':detail or 'Clicked through the shipped UI'})
        except Exception as error:
            checks.append({'name':name,'status':'FAIL','detail':phase.get(name,'')+' '+str(error).splitlines()[0][:300]})

    go('learning/'+fixture['video'])
    def playback():
        page.locator('.player-center-play').click()
        page.wait_for_function('CourseForgeNative.video().videoWidth>0 && CourseForgeNative.video().currentTime>0',timeout=60000)
        before=page.evaluate('CourseForgeNative.video().currentTime')
        page.locator('.native-player-stage').focus();page.keyboard.press('ArrowRight')
        page.wait_for_function('before=>CourseForgeNative.video().currentTime>=before+4',arg=before,timeout=30000)
        page.evaluate('CourseForgeNative.video().pause()')
        assert 'Audit learner' in page.locator('.native-watermark').inner_text()
        page.get_by_role('button',name='Lock player controls',exact=True).click()
        assert page.evaluate('CourseForgeNative.locked()')
        assert page.locator('.native-controls').evaluate('(e)=>e.inert')
        page.locator('.player-unlock').focus();page.keyboard.press('Enter')
        assert not page.evaluate('CourseForgeNative.locked()')
        return 'Real authenticated video decoded and sought; watermark visible; controls locked and unlocked'
    check('learner decode, seek, watermark and control shielding',playback)

    def notes():
        page.locator('#tab-notes').click()
        page.locator('#notePosition').fill('00:00:12');page.locator('#noteText').fill('UI acceptance temporary note')
        page.locator('#saveNoteBtn').click()
        row=page.locator('#notesList .saved-note').filter(has_text='UI acceptance temporary note')
        row.wait_for();row.locator('.small-delete').click();row.wait_for(state='detached')
        page.locator('#bookmarkPosition').fill('00:00:12');page.locator('#bookmarkLabel').fill('UI acceptance temporary bookmark')
        page.locator('#bookmarkForm button[type=submit]').click()
        bookmark=page.locator('#bookmarksList .saved-note').filter(has_text='UI acceptance temporary bookmark')
        bookmark.wait_for();bookmark.get_by_role('button',name='Delete',exact=True).click();bookmark.wait_for(state='detached')
        return 'Timestamped note and bookmark created, read and deleted through the UI'
    check('learner notes and bookmarks',notes)

    def focus():
        go('planner')
        if page.locator('#focusFinish').is_visible():
            page.locator('#focusFinish').click();page.wait_for_selector('#focusStart:not([hidden])')
        page.locator('#focusStart').click();page.wait_for_selector('#focusPause:not([hidden])')
        page.locator('#focusPause').click();page.wait_for_selector('#focusResume:not([hidden])')
        page.locator('#focusResume').click();page.wait_for_selector('#focusPause:not([hidden])')
        page.locator('#focusFinish').click();page.wait_for_selector('#focusStart:not([hidden])')
        assert page.locator('.focus-history-row').count()>0
        return 'Focus session started, paused, resumed, finished and appeared in persisted history'
    check('learner focus lifecycle',focus)

    def invitations():
        go('admin/students','audit-admin')
        form=page.locator('.academy-form').filter(has=page.get_by_role('button',name='Create invitation',exact=True))
        form.locator('[name=name]').fill('UI acceptance learner')
        form.locator('[name=email]').fill('ui-acceptance@example.test')
        form.locator('[name=course]').select_option(fixture['course'])
        with page.expect_response('**/api/admin/invitations') as response:
            form.get_by_role('button',name='Create invitation',exact=True).click()
        result=response.value
        if result.status not in (200,201):raise AssertionError('Invitation response '+str(result.status)+': '+str(result.json().get('detail','')))
        phase['admin invitation and learner activation']='Waiting for invitation link';
        link=page.locator('.private-account-link input');link.wait_for()
        activation=link.input_value()
        context=browser.new_context(service_workers='block',ignore_https_errors=True);student=context.new_page()
        try:
            phase['admin invitation and learner activation']='Activating account';
            student.goto(activation);student.locator('[name=password]').fill('Isolated acceptance password 123')
            student.get_by_role('button',name='Activate account',exact=True).click()
            phase['admin invitation and learner activation']='Signing in';
            student.locator('.academy-form [name=email]').fill('ui-acceptance@example.test')
            student.locator('.academy-form [name=password]').fill('Isolated acceptance password 123')
            student.locator('.academy-form button[type=submit]').click()
            student.wait_for_function('window.CourseForgeReady===true')
            phase['admin invitation and learner activation']='Opening granted library';
            student.locator('.side-nav [data-nav=library]').click()
            student.wait_for_selector('#courseCatalog .course-card')
            assert student.locator('#courseCatalog .course-card').count()==1
        finally:context.close()
        go('admin/students','audit-admin')
        page.locator('.academy-table tbody tr').filter(has_text='UI acceptance learner').get_by_role('button',name='Inspect',exact=True).click()
        phase['admin invitation and learner activation']='Inspecting student tracking';
        page.get_by_role('heading',name='UI acceptance learner',exact=True).wait_for()
        return 'Invitation, activation, real sign-in, granted library and administrator tracking clicked end to end'
    check('admin invitation and learner activation',invitations)

    def logging():
        with sqlite3.connect(destination) as conn:
            sessions=conn.execute("SELECT COUNT(*),MAX(last_sequence) FROM native_sessions WHERE user_id='audit-learner'").fetchone()
            events=conn.execute("SELECT COUNT(*) FROM learning_events WHERE user_id='audit-learner'").fetchone()[0]
        assert sessions[0]>0 and sessions[1]>0 and events>0
        return {'native_sessions':sessions[0],'highest_event_sequence':sessions[1],'learning_events':events}
    check('authenticated player and learning event persistence',logging)
    return {'passed':all(c['status']=='PASS' for c in checks),'checks':checks,
            'isolation':'Disposable anonymized database; production unchanged; activation URLs are never retained'}
