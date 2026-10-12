#!/usr/bin/env python3
"""Generate the implemented versioned learner/player contract, deterministically."""
from pathlib import Path
import argparse
import json
import re

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'backend/internal/contract/openapi.json'

def ref(name):
    return {'$ref': '#/components/schemas/' + name}

def obj(properties, required=None):
    return {'type':'object', 'properties':properties, 'required':list(properties) if required is None else required, 'additionalProperties':False}

def number(minimum=0, maximum=1e7):
    return {'type':'number', 'minimum':minimum, 'maximum':maximum}

def build():
    string={'type':'string'}; boolean={'type':'boolean'}
    schemas={
        'Error':{'oneOf':[{'type':'object','required':['detail'],'properties':{'detail':string,'code':string}},obj({'error':obj({'code':string,'message':string})})]},
        'User':obj({'id':string,'email':string,'name':string,'role':{'enum':['student','admin']},'verified':boolean,'suspended':boolean,'created_at':{'type':'string','format':'date-time'}}),
        'Auth':{'type':'object','required':['user','csrf_token'],'properties':{'user':ref('User'),'csrf_token':string,'session_id':string}},
        'Course':obj({'id':string,'title':string,'description':string,'published':boolean,'enrolled':boolean,'version':{'type':'integer'},'instructor':string,'category':string,'tags':{'type':'array','items':string},'slug':{'type':['string','null']},'cover_url':string},['id','title','description','published','enrolled','version']),
        'Lesson':obj({'id':string,'course_id':string,'title':string,'sort_order':{'type':'integer'},'duration_seconds':number(),'section_title':string,'flow_order':number()},['id','course_id','title','sort_order','duration_seconds']),
        'Progress':obj({'lesson_id':string,'percent':{'type':'integer','minimum':0,'maximum':100},'position':number(),'completed':boolean,'explicit_completed':boolean,'revision':{'type':'integer'},'updated_at':{'type':['string','null'],'format':'date-time'}}),
        'Note':obj({'id':string,'lesson_id':string,'position':number(),'content':{'type':'string','minLength':1,'maxLength':3000},'created_at':{'type':'string','format':'date-time'}}),
        'Preferences':obj({'autoplay':boolean,'speed':number(.5,3),'theater':boolean},['autoplay','speed']),
        'OpenPlayback':obj({'lesson_id':string,'take_over':boolean,'start_position':number()},['lesson_id']),
        'Playback':obj({'id':string,'media_url':string,'position':number(),'sequence':{'type':'integer'},'preferences':ref('Preferences'),'owner':boolean}),
        'Pulse':obj({'sequence':{'type':'integer','minimum':1,'maximum':2**53},'kind':{'enum':['playing','pause','seek','ended','heartbeat','hidden','close','waiting','ratechange','ready']},'position':number(),'playing':boolean,'visible':boolean,'elapsed_seconds':number(0,20),'playback_rate':number(.25,4)}),
        'Acknowledgement':obj({'sequence':{'type':'integer'},'position':number(),'watched_seconds':number(0,1e15),'visible_seconds':number(0,1e15),'coverage':number(0,100),'owner':boolean,'completed':boolean}),
        'JobCommand':obj({'kind':{'enum':['tutor','quiz','review','path','transcribe','index','lab','export']},'lesson_id':string,'payload':{'type':'object'}}),
        'Job':obj({'id':string,'lesson_id':string,'kind':string,'resource':string,'state':{'enum':['queued','running','completed','failed','canceled']},'attempt':{'type':'integer'},'max_attempts':{'type':'integer'},'result':{'type':'object'},'error_code':{'type':['string','null']},'created_at':{'type':'string','format':'date-time'},'updated_at':{'type':'string','format':'date-time'}},['id','lesson_id','kind','resource','state','attempt','max_attempts','created_at','updated_at']),
    }
    paths={}
    def route(method,path,summary,response=None,body=None,status=200,public=False,page=False):
        operation={'summary':summary,'operationId':method.lower()+''.join(x.title() for x in path.replace('{','').replace('}','').replace('-','/').split('/') if x), 'responses':{str(status):{'description':'Success'}}}
        if not public: operation['security']=[{'sessionCookie':[]}]
        parameters=[]
        for part in path.split('/'):
            if part.startswith('{'): parameters.append({'name':part[1:-1],'in':'path','required':True,'schema':{'type':'string','maxLength':500}})
        if method not in ('GET','HEAD') and not public: parameters.append({'name':'X-CSRF-Token','in':'header','required':True,'schema':string})
        if page: parameters.extend([{'name':'limit','in':'query','schema':{'type':'integer','minimum':1,'maximum':100,'default':50}},{'name':'cursor','in':'query','schema':string}])
        if parameters: operation['parameters']=parameters
        if body: operation['requestBody']={'required':True,'content':{'application/json':{'schema':body}}}
        if response: operation['responses'][str(status)]['content']={'application/json':{'schema':response}}
        for code in ('400','401','403','404','409','422','429','503'): operation['responses'][code]={'description':'Rejected request or unavailable dependency','content':{'application/json':{'schema':ref('Error')}}}
        paths.setdefault(path,{})[method.lower()]=operation
    route('GET','/health/live','Process liveness',public=True)
    route('GET','/health/ready','PostgreSQL readiness',public=True)
    route('POST','/api/v1/auth/login','Create rotated cookie session',ref('Auth'),obj({'email':string,'password':{'type':'string','minLength':4,'maxLength':128}}),public=True)
    route('POST','/api/v1/auth/register','Register under configured registration policy',None,obj({'email':string,'password':{'type':'string','minLength':4,'maxLength':128},'name':string}),status=201,public=True)
    route('GET','/api/v1/auth/me','Current public user and CSRF token',ref('Auth'))
    route('POST','/api/v1/auth/logout','Revoke this login session')
    route('GET','/api/v1/public/account-options','Read registration mode and available account flows',public=True)
    for path in ('verify','activate'):
        route('POST','/api/v1/auth/'+path,'Consume single-use '+path+' token',body=obj({'token':string}),public=True)
    for path in ('forgot','resend'):
        route('POST','/api/v1/auth/'+path,'Request private account mail without enumerating accounts',body=obj({'email':string}),public=True)
    route('POST','/api/v1/auth/reset','Consume single-use reset token and revoke existing sessions',body=obj({'token':string,'password':string}),public=True)
    route('GET','/api/v1/auth/sessions','Read own login sessions')
    route('DELETE','/api/v1/auth/sessions/{sid}','Revoke an owned login session')
    for path in ('/api/v1/auth/me','/api/v1/me'):
        if path.endswith('/v1/me'):route('GET',path,'Current public user and CSRF token',ref('Auth'))
        route('PATCH',path,'Update own profile or change password',body=obj({'name':string,'current_password':string,'password':string},[]))
        route('DELETE',path,'Delete own account after password confirmation',body=obj({'password':string}))
    for path in ('/api/v1/public/courses','/api/v1/public/courses/{id}'):
        route('GET',path,'Read published course preview without protected lesson sources',public=True,page=True)
    route('GET','/api/v1/admin/users','Read bounded administrator user list',page=True)
    route('GET','/api/v1/admin/users/{id}','Read administrator account detail')
    route('POST','/api/v1/admin/invitations','Create or reissue one-use invitation; raw link is administrator-only',body=obj({'email':string,'name':string,'course':string},['email','name']),status=201)
    route('POST','/api/v1/admin/users/{id}/account-link','Issue administrator-only activation/recovery link')
    route('DELETE','/api/v1/admin/users/{id}/sessions','Revoke all sessions for an account')
    route('PUT','/api/v1/admin/users/{id}/enrollments','Grant/revoke course enrollment',body=obj({'course':string,'enrolled':boolean}))
    route('PUT','/api/v1/admin/users/{id}/role','Change role with administrator password confirmation',body=obj({'role':{'enum':['student','admin']},'current_password':string}))
    route('PATCH','/api/v1/admin/users/{id}','Change suspension/role; any role field requires administrator password',body=obj({'role':{'enum':['student','admin']},'suspended':boolean,'current_password':string},[]))
    schemas['AdminReportPage']=obj({'items':{'type':'array','items':{'type':'object'}},'next_cursor':string})
    schemas['AdminSessionReport']=obj({'sessions':{'type':'array','items':{'type':'object'}},'next_cursor':string,'total':{'type':'integer','minimum':0},'summary':obj({'learners':{'type':'integer','minimum':0},'lessons':{'type':'integer','minimum':0},'session_seconds':number(0,1e15)}),'basis':{'enum':['visible_lesson_activity','accepted_browser_playback']},'period':string,'retention_days':{'const':90},'server_now':{'type':'string','format':'date-time'},'disclaimer':string})
    report_filters=[{'name':'days','in':'query','schema':{'type':'integer','minimum':1,'maximum':90,'default':30}}, {'name':'q','in':'query','schema':{'type':'string','maxLength':120}}, {'name':'course_id','in':'query','schema':{'type':'string','maxLength':512}}, {'name':'user_id','in':'query','schema':{'type':'string','maxLength':512}}, {'name':'status','in':'query','schema':{'enum':['all','live'],'default':'all'}}]
    for suffix,summary,paged in [('overview','Read administrator SQL aggregates with distinct time bases',False),('course-funnels','Read complete paginated course completion funnels',True),('learner-reports','Read bounded learner reports without learning answer content',True),('users/{id}/learning-report','Read independent learner totals and available history sections',False),('users/{id}/reports/{section}','Read owner-scoped administrator history; events/labs remain unavailable',True),('audit','Read paginated administrator audit',True),('access-events','Read paginated access events; device/IP enrichment remains unavailable',True),('system','Read bounded SQL system facts and explicit capability/retention limits',False)]:
        path='/api/v1/admin/'+suffix
        route('GET',path,summary,response=ref('AdminReportPage') if paged and suffix!='learner-reports' else None,page=paged)
        operation=paths[path]['get']
        operation['x-required-role']='admin'
        for parameter in operation.get('parameters',[]):
            if parameter['name']=='limit':parameter['schema']['default']=25
        if suffix=='learner-reports':operation.setdefault('parameters',[]).append({'name':'q','in':'query','schema':{'type':'string','maxLength':120}})
    for suffix in ('player-activity','playback'):
        path='/api/v1/admin/'+suffix
        route('GET',path,'Read administrator retained session details; independent from lifetime totals',response=ref('AdminSessionReport'),page=True)
        operation=paths[path]['get']; operation['x-required-role']='admin'
        operation['parameters'].extend(report_filters)
        for parameter in operation['parameters']:
            if parameter['name']=='limit':parameter['schema']['default']=25
        route('GET',path+'/export','Export a complete bounded administrator CSV; narrower filters required above 10,000 rows or16MiB')
        operation=paths[path+'/export']['get']; operation['x-required-role']='admin'
        operation['parameters']=report_filters
        operation['responses']['200']['content']={'text/csv':{'schema':{'type':'string'}}}
        operation['responses']['413']={'description':'Complete snapshot exceeds bounded export limits; no partial file or quota charge','content':{'application/json':{'schema':ref('Error')}}}
    for path,key,name in [('/api/v1/courses','courses','Course'),('/api/v1/progress','progress','Progress'),('/api/v1/lessons/{id}/notes','notes','Note')]:
        route('GET',path,'Read paginated private '+key,{'type':'object','required':[key,'next_cursor'],'properties':{key:{'type':'array','items':ref(name)},'next_cursor':string,'items':{'type':'array','items':ref(name)}}},page=True)
    route('GET','/api/v1/courses/{id}','Read course and authorized ordered lessons',{'type':'object','required':['course','lessons'],'properties':{'course':ref('Course'),'lessons':{'type':'array','items':ref('Lesson')},'next_cursor':string}},page=True)
    route('POST','/api/v1/courses/{id}/enroll','Idempotent published-course enrollment',status=201)
    route('GET','/api/v1/lessons/{id}','Read an authorized lesson with private progress',obj({'lesson':ref('Lesson'),'progress':ref('Progress')}))
    route('GET','/api/v1/lessons/{id}/progress','Read private progress',ref('Progress'))
    route('PUT','/api/v1/lessons/{id}/progress','Commit private progress; percent100 explicitly completes, position-only preserves completion; optional revision rejects stale changes',ref('Progress'),obj({'percent':{'type':'integer','minimum':0,'maximum':100},'position':number(0,1e9),'expected_revision':{'type':'integer','minimum':0}},['position']))
    route('PUT','/api/v1/lessons/{id}/resume-point','Save position without changing completion',ref('Progress'),obj({'position':number(0,1e9)},['position']))
    route('POST','/api/v1/lessons/{id}/notes','Create a timestamped private note idempotently',ref('Note'),obj({'position':number(),'content':{'type':'string','minLength':1,'maxLength':3000}}),status=201)
    paths['/api/v1/lessons/{id}/notes']['post']['parameters'].append({'name':'Idempotency-Key','in':'header','required':True,'schema':{'type':'string','minLength':1,'maxLength':128}})
    route('DELETE','/api/v1/lessons/{id}/notes/{note_id}','Delete owned note',status=204)
    route('POST','/api/v1/playback/sessions','Acquire exclusive account player lease',ref('Playback'),ref('OpenPlayback'),status=201)
    route('POST','/api/v1/playback/sessions/{id}/pulse','Commit ordered playback and page activity separately',ref('Acknowledgement'),ref('Pulse'))
    route('POST','/api/v1/playback/sessions/{id}/claim','Deliberately reclaim or take over a player',obj({'owner':boolean,'position':number(),'sequence':{'type':'integer'}}),obj({'take_over':boolean},[]))
    route('POST','/api/v1/playback/sessions/{id}/release','Pause and release ownership',obj({'owner':boolean}))
    route('GET','/api/v1/player/preferences','Read saved player preferences',ref('Preferences'))
    route('PUT','/api/v1/player/preferences','Save saved player preferences',ref('Preferences'),ref('Preferences'))
    route('POST','/api/v1/jobs','Durably queue a scoped job; executor availability is separate',ref('Job'),ref('JobCommand'),status=202)
    paths['/api/v1/jobs']['post']['parameters'].append({'name':'Idempotency-Key','in':'header','required':True,'schema':{'type':'string','minLength':1,'maxLength':128}})
    route('GET','/api/v1/jobs','Read own job history',page=True)
    route('GET','/api/v1/jobs/{id}','Read an owned durable job',ref('Job'))
    route('POST','/api/v1/jobs/{id}/cancel','Cancel owned job and invalidate worker fence')
    route('GET','/api/v1/courses/{id}/cover','Read published course cover',public=True)
    route('GET','/api/v1/materials','Read scoped material metadata without storage/provider secrets',page=True)
    route('GET','/api/v1/materials/{id}/download','Download authorized material with byte-range support')
    route('GET','/api/v1/search','Search scoped courses/lessons/materials/transcript moments')
    paths['/api/v1/search']['get'].setdefault('parameters',[]).extend([{'name':'q','in':'query','schema':{'type':'string','maxLength':200}},{'name':'course','in':'query','schema':string}])
    route('PATCH','/api/v1/admin/courses/{id}','Update course metadata/publication with optimistic revision',body=obj({'expected_version':{'type':'integer','minimum':1},'title':string,'description':string,'instructor':string,'category':string,'tags':{'type':'array','items':string},'published':boolean},['expected_version']))
    route('PUT','/api/v1/admin/courses/{id}/organization','Update lesson sections/order without changing stable IDs',body=obj({'expected_version':{'type':'integer','minimum':1},'lessons':{'type':'array','items':obj({'id':string,'section_title':string,'position':number(-1e6,1e6)})}}))
    route('PUT','/api/v1/admin/materials/{id}','Update versioned material metadata',body=obj({'title':string,'material_type':string,'lesson_id':{'type':['string','null']},'scope':{'enum':['course','section','lesson']},'section_title':string,'position':number(0,1e9),'expected_version':{'type':'integer','minimum':1}},['title','scope','expected_version']))
    route('DELETE','/api/v1/admin/materials/{id}','Remove a material from discovery')
    for path in ('home-feed','trending'):
        route('GET','/api/v1/streaming/'+path,'Read bounded published streaming discovery',public=True)
    for path in ('my-list','history','continue-watching'):
        route('GET','/api/v1/streaming/'+path,'Read scoped learner '+path,page=True)
    route('POST','/api/v1/streaming/my-list','Idempotently save an authorized course or lecture',body=obj({'item_type':{'enum':['course','lecture']},'item_id':string}),status=201)
    route('DELETE','/api/v1/streaming/my-list/{type}/{id}','Remove owned saved item')
    route('DELETE','/api/v1/streaming/history','Clear private history while preserving resume')
    route('POST','/api/v1/streaming/analytics/event','Aggregate a bounded authorized streaming event',body=obj({'event_type':string,'event_name':string,'meta':{'type':'object'}},['event_type','event_name']))
    route('GET','/api/v1/admin/streaming-analytics','Read bounded aggregate administrator analytics')
    question=obj({'id':string,'question':{'type':'string','minLength':8,'maxLength':500},'options':{'type':'array','minItems':2,'maxItems':8,'items':{'type':'string','minLength':1,'maxLength':300}},'correct_index':{'type':'integer','minimum':0,'maximum':7},'explanation':{'type':'string','minLength':1,'maxLength':1000},'concept':{'type':'string','maxLength':120},'source_start':number(0,1e9),'source_chunk_id':{'type':['string','null']}},['id','question','options','correct_index','explanation','source_start'])
    questions={'type':'array','minItems':1,'maxItems':20,'items':question}
    revision={'type':'integer','minimum':1}
    card=obj({'course_id':string,'lesson_id':{'type':['string','null']},'question':string,'answer':string,'source_start':number(0,1e9),'source_chunk_id':{'type':['string','null']}},['course_id','question','answer','source_start'])
    for path,summary in [('/api/v1/lessons/{id}/bookmarks','Read private lesson bookmarks'),('/api/v1/reviews/cards','Read private review cards'),('/api/v1/reviews/due','Read currently due authorized review cards'),('/api/v1/reviews/history','Read private review grading history'),('/api/v1/lessons/{id}/quiz/attempts','Read private graded quiz attempts'),('/api/v1/me/learning-credits','Read private deduplicated learning credits')]:
        route('GET',path,summary,page=True)
    route('POST','/api/v1/lessons/{id}/bookmarks','Create private timestamped bookmark',body=obj({'position':number(0,1e9),'label':{'type':'string','minLength':1,'maxLength':160}}),status=201)
    route('DELETE','/api/v1/bookmarks/{id}','Delete owned bookmark')
    route('POST','/api/v1/reviews/cards','Create private source-linked review card',body=card,status=201)
    route('POST','/api/v1/reviews/{id}/grade','Grade a private card and advance its revision',body=obj({'quality':{'type':'integer','minimum':0,'maximum':5},'expected_revision':revision}))
    route('POST','/api/v1/reviews/complete','Credit a private review session once',body=obj({'course':{'type':['string','null']},'attempt_ids':{'type':'array','minItems':1,'maxItems':100,'uniqueItems':True,'items':string}},['attempt_ids']),status=201)
    route('POST','/api/v1/reviews/generate','Queue bounded source-cited private review generation',response=ref('Job'),body=obj({'lesson_id':string,'count':{'type':'integer','minimum':1,'maximum':20,'default':8}},['lesson_id']),status=202)
    route('GET','/api/v1/lessons/{id}/quiz','Read approved quiz without solutions, or pending state')
    route('POST','/api/v1/lessons/{id}/quiz/attempts','Grade immutable current quiz revision privately',body=obj({'quiz_id':string,'revision':revision,'answers':{'type':'object','minProperties':1,'maxProperties':20,'additionalProperties':{'type':'integer','minimum':0,'maximum':7}}}),status=201)
    route('GET','/api/v1/courses/{id}/quizzes/status','Read own course quiz status')
    route('GET','/api/v1/admin/courses/{id}/quizzes','Read authorized quiz curation list',page=True)
    route('GET','/api/v1/admin/quizzes/{id}','Read administrator quiz with solutions')
    route('POST','/api/v1/admin/lessons/{id}/quiz','Create curated immutable quiz version',body=obj({'questions':questions,'status':{'enum':['draft','approved','withdrawn']}}),status=201)
    route('PUT','/api/v1/admin/quizzes/{id}','Create a new quiz revision with optimistic fencing',body=obj({'questions':questions,'status':{'enum':['draft','approved','withdrawn']},'expected_revision':revision}))
    route('POST','/api/v1/admin/lessons/{id}/quiz/regenerate','Queue source-cited quiz draft with revision fencing',response=ref('Job'),body=obj({'count':{'type':'integer','minimum':1,'maximum':20,'default':5},'expected_revision':{'type':'integer','minimum':0}},['expected_revision']),status=202)
    route('GET','/api/v1/me/learning-preferences','Read anchored learning timezone')
    route('PUT','/api/v1/me/learning-preferences','Initialize learning timezone; later calls return anchored choice',body=obj({'timezone':{'type':'string','minLength':1,'maxLength':100}}))
    for path in ('/api/v1/lessons/{id}/bookmarks','/api/v1/reviews/cards','/api/v1/reviews/{id}/grade','/api/v1/reviews/complete','/api/v1/reviews/generate','/api/v1/lessons/{id}/quiz/attempts','/api/v1/admin/lessons/{id}/quiz','/api/v1/admin/quizzes/{id}','/api/v1/admin/lessons/{id}/quiz/regenerate'):
        method='put' if path=='/api/v1/admin/quizzes/{id}' else 'post'
        paths[path][method]['parameters'].append({'name':'Idempotency-Key','in':'header','required':True,'schema':{'type':'string','minLength':1,'maxLength':128}})
    planning_mutations=[]
    def planning_route(method,path,summary,body=None,page=False,status=200):
        route(method,path,summary,body=body,page=page,status=status)
        if method not in ('GET','HEAD'):
            planning_mutations.append((path,method.lower()))
    revision0={'type':'integer','minimum':0}
    day={'type':'string','format':'date'}
    nullable_id={'type':['string','null'],'minLength':1,'maxLength':500}
    planning_route('GET','/api/v1/planner/preferences','Read private daily budget and path preference')
    planning_route('PUT','/api/v1/planner/preferences','Save versioned private daily planner preference',obj({'daily_minutes':{'type':'integer','minimum':15,'maximum':180},'path_id':nullable_id,'expected_revision':revision0},['daily_minutes','expected_revision']))
    planning_route('GET','/api/v1/planner/week-preferences','Read private seven-day budgets')
    planning_route('PUT','/api/v1/planner/week-preferences','Save seven budgets with at least one study day',obj({'weekday_minutes':{'type':'array','minItems':7,'maxItems':7,'items':{'oneOf':[{'const':0},{'type':'integer','minimum':15,'maximum':180}]}},'expected_revision':revision0}))
    for kind,field in [('days','study_date'),('weeks','week_start')]:
        planning_route('GET','/api/v1/planner/'+kind+'/{date}','Read private saved '+kind+' snapshot')
        planning_route('POST','/api/v1/planner/'+kind,'Create source-backed snapshot or refresh with expected revision',obj({field:day,'refresh':boolean,'expected_revision':revision0},[field]),status=201)
    planning_route('PUT','/api/v1/planner/items/{id}','Update private checklist status without awarding mastery',obj({'status':{'enum':['pending','done','skipped']},'expected_revision':revision}))
    planning_route('PUT','/api/v1/planner/items/{id}/actual','Save explicitly self-reported planner minutes',obj({'actual_minutes':{'type':'integer','minimum':0,'maximum':600},'expected_revision':revision}))
    planning_route('POST','/api/v1/focus/sessions','Start one server-timed focus or break session; at most one source reference',obj({'mode':{'enum':['focus','break'],'default':'focus'},'duration_minutes':{'type':'integer','minimum':1,'maximum':120,'default':25},'title':{'type':'string','maxLength':160},'planner_item_id':nullable_id,'lesson_id':nullable_id,'lab_session_id':nullable_id},[]),status=201)
    planning_route('POST','/api/v1/focus/sessions/{id}/actions','Apply versioned focus pause/resume/finish/cancel/hidden command',obj({'action':{'enum':['pause','resume','finish','cancel','hidden']},'expected_revision':revision}))
    planning_route('GET','/api/v1/focus/active','Read current private timer with authoritative server time')
    planning_route('GET','/api/v1/focus/history','Read private source-authorized timer history',page=True)
    planning_route('GET','/api/v1/focus/analytics/{date}','Read Monday-based focus, planned and self-reported time separately')
    planning_route('GET','/api/v1/me/habits','Read anchored-local private habit aggregates and streaks')
    planning_route('PUT','/api/v1/me/habit-preferences','Save goal and anchored IANA timezone; reminder opt-in needs configured delivery',obj({'goal':{'enum':['minutes','lesson']},'timezone':{'type':'string','minLength':1,'maxLength':100},'reminder_email':boolean}))
    planning_route('GET','/api/v1/studio/insights','Read private learning and activity signals')
    for path,method in planning_mutations:
        paths[path][method]['parameters'].append({'name':'Idempotency-Key','in':'header','required':True,'schema':{'type':'string','minLength':1,'maxLength':128}})
    schemas['Certificate']=obj({'issued':{'const':True},'certificate_id':string,'verification_code':{'type':'string','minLength':1,'maxLength':128},'student_name':string,'course':string,'completed_at':{'type':'string','format':'date-time'},'verify_url':string})
    schemas['CertificateReadiness']=obj({'issued':{'const':False},'eligible':boolean,'reason':string,**{key:{'type':'integer','minimum':0} for key in ('total_lessons','completed_lessons','passed_quizzes','remaining_lessons','remaining_quizzes')}},['issued','eligible','total_lessons','completed_lessons','passed_quizzes','remaining_lessons','remaining_quizzes'])
    schemas['CertificateVerification']=obj({'valid':{'const':True},'student_name':string,'course':string,'completed_at':{'type':'string','format':'date-time'},'verification_code':string,'status':{'const':'Verified Official CourseForge Certificate'}})
    certificate_response={'oneOf':[ref('Certificate'),ref('CertificateReadiness')]}
    route('GET','/api/v1/courses/{id}/certificate','Read private immutable issuance or readiness; GET never issues',response=certificate_response)
    route('POST','/api/v1/courses/{id}/certificate','Idempotently issue after every lesson is completed and has any passed quiz',response=ref('Certificate'),body=obj({}),status=201)
    paths['/api/v1/courses/{id}/certificate']['post']['responses']['200']={'description':'Existing issued certificate or ineligible readiness; exact retries retain original status and snapshot','content':{'application/json':{'schema':certificate_response}}}
    paths['/api/v1/courses/{id}/certificate']['post']['parameters'].append({'name':'Idempotency-Key','in':'header','required':True,'schema':{'type':'string','minLength':1,'maxLength':128}})
    route('GET','/api/v1/certificates/verify/{code}','Read minimal immutable public certificate verification',response=ref('CertificateVerification'),public=True)
    route('GET','/verify/{code}','Read escaped printable public certificate HTML',public=True)
    paths['/verify/{code}']['get']['responses']['200']['content']={'text/html':{'schema':{'type':'string'}}}
    path_id={'type':'string','pattern':'^[A-Za-z0-9_-]{1,100}$'}
    course_ids={'type':'array','minItems':1,'maxItems':8,'uniqueItems':True,'items':{'type':'string','minLength':1,'maxLength':200}}
    schemas['PathSource']=obj({'lesson_id':{'type':'string','minLength':1,'maxLength':500},'course_id':{'type':'string','minLength':1,'maxLength':200},'start':number(),'chunk_id':string,'title':string},['lesson_id','course_id','start'])
    schemas['PathStep']=obj({'id':path_id,'title':{'type':'string','minLength':1,'maxLength':120},'objectives':{'type':'array','maxItems':5,'items':{'type':'string','minLength':1,'maxLength':300}},'sources':{'type':'array','minItems':1,'maxItems':8,'items':ref('PathSource')},'prerequisites':{'type':'array','items':path_id},'goal_focus':boolean},['id','title','sources'])
    schemas['PathDefinition']=obj({'id':path_id,'goal':{'type':'string','minLength':3,'maxLength':180},'course_ids':course_ids,'steps':{'type':'array','minItems':1,'maxItems':100,'items':ref('PathStep')},'expected_revision':revision0},['id','goal','course_ids','steps'])
    schemas['PathUpdate']=obj(schemas['PathDefinition']['properties'],['goal','course_ids','steps'])
    public_question={'id':path_id,'question':{'type':'string','minLength':12,'maxLength':350},'options':{'type':'array','minItems':4,'maxItems':4,'items':{'type':'string','minLength':1,'maxLength':240}},'concept':{'type':'string','maxLength':100},'source':ref('PathSource'),'excerpt':{'type':'string','maxLength':280}}
    schemas['TopicQuestion']=obj(public_question)
    schemas['ManualTopicQuestion']=obj({**public_question,'correct_index':{'type':'integer','minimum':0,'maximum':3},'explanation':{'type':'string','minLength':10,'maxLength':800}},['id','question','options','source','correct_index','explanation'])
    schemas['TopicAssessment']=obj({'id':path_id,'path_id':path_id,'step_id':path_id,'questions':{'type':'array','minItems':3,'maxItems':5,'items':ref('TopicQuestion')},'question_count':{'type':'integer','minimum':3,'maximum':5},'provenance':{'enum':['manual','generated','legacy_import']},'created_at':{'type':'string','format':'date-time'}})
    route('GET','/api/v1/learning-paths','Read bounded private source-authorized paths',page=True)
    route('POST','/api/v1/learning-paths','Queue source-backed path generation; unavailable until a configured typed executor exists',response=ref('Job'),body=obj({'course_ids':course_ids,'goal':{'type':'string','minLength':3,'maxLength':180},'expected_revision':revision0},['course_ids','goal']),status=202)
    route('POST','/api/v1/learning-paths/manual','Create an explicitly manual source-backed path',body=ref('PathDefinition'),status=201)
    route('GET','/api/v1/learning-paths/{id}','Read private path, checklist completion and distinct topic mastery')
    route('PUT','/api/v1/learning-paths/{id}','Replace private path at expected revision; unchanged steps retain completion',body=ref('PathUpdate'))
    route('DELETE','/api/v1/learning-paths/{id}','Delete private path with duplicate-safe response',body=obj({'expected_revision':revision}))
    route('PUT','/api/v1/learning-paths/{id}/steps/{step_id}','Set private checklist completion with prerequisite validation; no mastery credit',body=obj({'completed':boolean,'expected_revision':revision}))
    route('POST','/api/v1/learning-paths/{id}/steps/{step_id}/assessments','Queue cited topic questions; unavailable until a configured typed executor exists',response=ref('Job'),body=obj({'count':{'type':'integer','minimum':3,'maximum':5},'expected_revision':revision}),status=202)
    route('POST','/api/v1/learning-paths/{id}/steps/{step_id}/assessments/manual','Create explicitly manual cited questions; response hides answer keys',response=ref('TopicAssessment'),body=obj({'questions':{'type':'array','minItems':3,'maxItems':5,'items':ref('ManualTopicQuestion')},'expected_revision':revision}),status=201)
    route('GET','/api/v1/assessments/{id}','Read current authorized topic questions without answers',response=ref('TopicAssessment'))
    route('POST','/api/v1/assessments/{id}/attempts','Grade one immutable private attempt and expose feedback only after submission',body=obj({'answers':{'type':'object','minProperties':3,'maxProperties':5,'additionalProperties':{'type':'integer','minimum':0,'maximum':3}}}),status=201)
    route('GET','/api/v1/learning-paths/{id}/assessment-history','Read immutable private attempt history with current citation access',page=True)
    route('GET','/api/v1/learning-paths/{id}/practice-recommendations','Read curated ranked labs with truthful availability and separate source suggestions')
    route('GET','/api/v1/learning-paths/{id}/practice-history','Read immutable owned verified-lab summaries and original citation scope',page=True)
    paths['/api/v1/learning-paths/{id}/practice-history']['get']['parameters'].append({'name':'step_id','in':'query','schema':path_id})
    route('GET','/api/v1/learning-paths/{id}/practice-status','Read separate current verified-lab outcomes; unchanged topic signal survives goal-only refresh')
    route('POST','/api/v1/learning-paths/{id}/steps/{step_id}/practice/{slug}/start','Start only an actual owned curated lab;503 when no verified adapter exists',body=obj({}),status=201)
    route('POST','/api/v1/practice/sessions/{id}/verified-attempts','Reconcile accepted owned grader evidence; never accepts client grades or runs code',body=obj({'evidence_id':{'type':'string','minLength':1,'maxLength':100}}),status=201)
    paths['/api/v1/practice/sessions/{id}/verified-attempts']['post']['parameters'].append({'name':'Idempotency-Key','in':'header','required':True,'schema':{'type':'string','minLength':1,'maxLength':128}})
    for path,methods in paths.items():
        if path.startswith('/api/v1/learning-paths') or path=='/api/v1/assessments/{id}/attempts':
            for method,operation in methods.items():
                if method not in ('get','head'):
                    operation['parameters'].append({'name':'Idempotency-Key','in':'header','required':True,'schema':{'type':'string','minLength':1,'maxLength':128}})
    schemas['ActivityAcknowledgement']=obj({'id':string,'activity_seconds':number(0,1e15),'sequence':{'type':'integer','minimum':0,'maximum':1000000000},'accepted':boolean,'owner':boolean,'closed':boolean,'reason':string,'basis':{'const':'visible_lesson_activity'},'server_now':{'type':'string','format':'date-time'}},['activity_seconds','sequence','accepted','owner','closed','basis','server_now'])
    schemas['LearningSummary']=obj({'courses':{'type':'array','items':{'type':'object'}},'next_cursor':string,'activity_seconds':number(0,1e15),'watched_seconds':number(0,1e15),'measured_focus_seconds':number(0,1e15),'time_basis':{'const':'visible_lesson_activity'},'completion_basis':{'const':'learner_or_playback'},'disclaimer':string,'server_now':{'type':'string','format':'date-time'}})
    route('POST','/api/v1/lessons/{id}/activity-session','Open independent visible-page activity; optional exact native player binding; no opening credit',response=ref('ActivityAcknowledgement'),body=obj({'player_session_id':{'type':'string','minLength':1,'maxLength':100},'visible':boolean},[]),status=201)
    route('POST','/api/v1/activity/{id}/heartbeat','Commit ordered server-bounded visible-page interval; separate from watched video and focus',response=ref('ActivityAcknowledgement'),body=obj({'sequence':{'type':'integer','minimum':1,'maximum':1000000000},'visible':boolean,'elapsed_seconds':number(0,20),'ended':boolean},['sequence','visible','elapsed_seconds']))
    route('GET','/api/v1/me/learning','Read enrolled-course history with separate lifetime visible, watched and focus totals',response=ref('LearningSummary'),page=True)
    for parameter in paths['/api/v1/me/learning']['get']['parameters']:
        if parameter['name']=='limit': parameter['schema']['default']=30
    route('GET','/api/v1/openapi.json','Read the versioned API contract',public=True)
    for method in ('GET','HEAD'):
        route(method,'/api/v1/playback/sessions/{id}/media','Forward authorized single-range media')
        op=paths['/api/v1/playback/sessions/{id}/media'][method.lower()]
        op['parameters'].extend([{'name':'t','in':'query','required':True,'schema':{'type':'string','maxLength':100}},{'name':'Range','in':'header','schema':string}])
        op['responses']={'200':{'description':'Authorized bytes'},'206':{'description':'Authorized byte range'},'416':{'description':'Invalid or unsatisfiable range'},'401':{'description':'No session'},'403':{'description':'Playback access ended'},'503':{'description':'Provider or admission unavailable'}}
    return {'openapi':'3.1.0','info':{'title':'CourseForge Go learner and playback API','version':'0.1.0','description':'Implemented identity/catalog/learner/player/queue slices. Remaining product contracts are added after their implementation handoff. Cookie mutations require CSRF and the configured same-origin policy. Public auth mutations with an existing session also require its CSRF token. Some administrator/material response schemas are still being expanded.'},'paths':paths,'components':{'securitySchemes':{'sessionCookie':{'type':'apiKey','in':'cookie','name':'cf_session'}},'schemas':schemas}}

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--check',action='store_true');parser.add_argument('--check-routes',action='store_true');args=parser.parse_args()
    payload=json.dumps(build(),indent=2,sort_keys=True)+'\n'
    if args.check:
        if not DEST.exists() or DEST.read_text()!=payload: raise SystemExit('OpenAPI artifact differs; run python3 scripts/rewrite_openapi.py')
        print('OpenAPI artifact matches generator')
    elif not args.check_routes:
        DEST.parent.mkdir(parents=True,exist_ok=True);DEST.write_text(payload);print(f'Wrote {DEST.relative_to(ROOT)}')
    if args.check_routes:
        registered=set()
        # Follow the API/media entrypoint imports. Parallel modules are excluded
        # until integrated, without maintaining a growing package exception list.
        pending=[ROOT/'backend/cmd/api',ROOT/'backend/cmd/media']
        visited=set()
        while pending:
            package=pending.pop()
            if package in visited:continue
            visited.add(package)
            for source in package.glob('*.go'):
                if source.name.endswith('_test.go'):continue
                content=source.read_text()
                registered.update(re.findall(r'"(GET|POST|PUT|PATCH|DELETE|HEAD) (/api/v1/[^" ]+)"',content))
                for imported in re.findall(r'"courseforge/backend/(internal/[A-Za-z0-9_/]+)"',content):
                    pending.append(ROOT/'backend'/imported)
        published={(method.upper(),path) for path,operations in build()['paths'].items() for method in operations}
        missing=sorted(registered-published)
        if missing:raise SystemExit('Undocumented route literals: '+repr(missing))
        print(f'Contract includes all {len(registered)} handed-off v1 route literals; this is a documentation check, not behavior coverage')

if __name__=='__main__':main()
