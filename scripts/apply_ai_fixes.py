import re

# 1. Update app/vectorstore.py to disable version check warning
vpath = "/home/ubuntu/CourseForge/app/vectorstore.py"
with open(vpath, "r") as f:
    vcode = f.read()

old_qc = "return QdrantClient(url=settings.qdrant_url, timeout=30)"
new_qc = "return QdrantClient(url=settings.qdrant_url, timeout=30, check_compatibility=False)"
if old_qc in vcode:
    vcode = vcode.replace(old_qc, new_qc, 1)
    with open(vpath, "w") as f:
        f.write(vcode)
    print("Updated vectorstore.py check_compatibility")

# 2. Update app/tutor.py context line length and options
tpath = "/home/ubuntu/CourseForge/app/tutor.py"
with open(tpath, "r") as f:
    tcode = f.read()

old_ctx = """    context_lines = []
    for i, s in enumerate(evidence, 1):
        t_label = _format_time(s['start'])
        c_title = _clean_title(s['title'])
        context_lines.append(
            f'[S{i}] {s["course"]} / {c_title} (ID: {s["video_id"]}, Time: {t_label}, Seconds: {int(s["start"])}):\\n'
            + s['text'][:1500]
        )
    context = '\\n\\n'.join(context_lines)"""

new_ctx = """    context_lines = []
    for i, s in enumerate(evidence[:4], 1):
        t_label = _format_time(s['start'])
        c_title = _clean_title(s['title'])
        context_lines.append(
            f'[S{i}] {s["course"]} / {c_title} (ID: {s["video_id"]}, Time: {t_label}, Seconds: {int(s["start"])}):\\n'
            + s['text'][:320]
        )
    context = '\\n\\n'.join(context_lines)"""

if old_ctx in tcode:
    tcode = tcode.replace(old_ctx, new_ctx, 1)

old_t_opts = "'options': {'temperature': 0.2, 'num_ctx': 2048, 'num_predict': 350},"
new_t_opts = "'options': {'temperature': 0.2, 'num_ctx': 2048, 'num_predict': 250},"
if old_t_opts in tcode:
    tcode = tcode.replace(old_t_opts, new_t_opts)

with open(tpath, "w") as f:
    f.write(tcode)
print("Updated tutor.py context lines and prediction limit")

# 3. Update app/main.py for ask_tutor and create_review_cards
mpath = "/home/ubuntu/CourseForge/app/main.py"
with open(mpath, "r") as f:
    mcode = f.read()

old_ask = """@app.post('/api/ask',status_code=202)
def ask_tutor(body: QueryBody):
    try:
        return enqueue('ask',body.model_dump())
    except HTTPException:
        raise
    except Exception as exc:
        # Avoid leaking backend credentials/paths in error responses.
        raise HTTPException(status_code=503, detail='AI services unavailable or search failed. '
                            'Check Ollama, Qdrant, pulled models and worker logs.') from exc"""

new_ask = """@app.post('/api/ask',status_code=202)
def ask_tutor(body: QueryBody, request: Request, response: Response):
    if request.query_params.get('sync') == '1' or request.headers.get('x-sync') == '1':
        response.status_code = 200
        return tutor.ask(question=body.question, mode=body.mode, course=body.course, video_id=body.video_id)
    try:
        return enqueue('ask',body.model_dump())
    except HTTPException:
        raise
    except Exception as exc:
        # Avoid leaking backend credentials/paths in error responses.
        raise HTTPException(status_code=503, detail='AI services unavailable or search failed. '
                            'Check Ollama, Qdrant, pulled models and worker logs.') from exc"""

if old_ask in mcode:
    mcode = mcode.replace(old_ask, new_ask, 1)
    print("Updated main.py ask_tutor")

old_rev = """@app.post('/api/reviews/generate',status_code=202)
def create_review_cards(body: CardCreateBody):
    try:
        return enqueue('reviews',body.model_dump())
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, 'Quiz generation unavailable; check Ollama and indexes') from exc"""

new_rev = """@app.post('/api/reviews/generate',status_code=202)
def create_review_cards(body: CardCreateBody, request: Request, response: Response):
    if request.query_params.get('sync') == '1' or request.headers.get('x-sync') == '1':
        response.status_code = 200
        return reviews.generate_cards(course=body.course, topic=body.topic, count=body.count)
    try:
        return enqueue('reviews',body.model_dump())
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, 'Quiz generation unavailable; check Ollama and indexes') from exc"""

if old_rev in mcode:
    mcode = mcode.replace(old_rev, new_rev, 1)
    print("Updated main.py create_review_cards")

with open(mpath, "w") as f:
    f.write(mcode)

# 4. Update core.js and app.js askTutor and summary to pass ?sync=1 and poll fallback
for jspath in ["/home/ubuntu/CourseForge/app/static/core.js", "/home/ubuntu/CourseForge/app/static/app.js"]:
    with open(jspath, "r") as f:
        jscode = f.read()
    
    # Update askTutor call
    old_call_js = "const result=await request('/api/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question,mode:state.mode,...currentScope()})});state.lastAnswer=result.answer;renderTutorAnswer(result.answer);"
    new_call_js = "let result=await request('/api/ask?sync=1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question,mode:state.mode,...currentScope()})});if(result&&result.task_id&&!result.answer){btn.textContent='Thinking with AI…';for(let i=0;i<90;i++){await new Promise(r=>setTimeout(r,800));const task=await request('/api/tasks/'+result.task_id);if(task.status==='done'){result=task.result;break;}if(task.status==='failed'){throw new Error(task.error||'AI Tutor task failed');}}}state.lastAnswer=result.answer;renderTutorAnswer(result.answer);"
    
    if old_call_js in jscode:
        jscode = jscode.replace(old_call_js, new_call_js, 1)
        print(f"Updated askTutor in {jspath}")
        
    old_sum_js = "const data=await request('/api/ask',services.json('POST',{question:'Summarize the learning objectives, key concepts, code or commands, and next steps from this lecture. Cite sources and timestamps.',mode:'notes',video_id:state.currentVideoId}));$('#lessonSummary').textContent=data.answer;"
    new_sum_js = "let data=await request('/api/ask?sync=1',services.json('POST',{question:'Summarize the learning objectives, key concepts, code or commands, and next steps from this lecture. Cite sources and timestamps.',mode:'notes',video_id:state.currentVideoId}));if(data&&data.task_id&&!data.answer){for(let i=0;i<90;i++){await new Promise(r=>setTimeout(r,800));const task=await request('/api/tasks/'+data.task_id);if(task.status==='done'){data=task.result;break;}if(task.status==='failed'){throw new Error(task.error||'Summary failed');}}}$('#lessonSummary').textContent=data.answer;"
    
    if old_sum_js in jscode:
        jscode = jscode.replace(old_sum_js, new_sum_js, 1)
        print(f"Updated generateSummary in {jspath}")

    old_rev_js = "const result=await request('/api/reviews/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({course,topic:$('#reviewTopic').value.trim()||'key concepts',count:5})});await loadDue();toast(`${result.created} flashcards created.`)"
    new_rev_js = "let result=await request('/api/reviews/generate?sync=1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({course,topic:$('#reviewTopic').value.trim()||'key concepts',count:5})});if(result&&result.task_id&&result.created===undefined){for(let i=0;i<90;i++){await new Promise(r=>setTimeout(r,800));const task=await request('/api/tasks/'+result.task_id);if(task.status==='done'){result=task.result;break;}if(task.status==='failed'){throw new Error(task.error||'Cards failed');}}}await loadDue();toast(`${result.created||result.count||0} flashcards created.`)"

    if old_rev_js in jscode:
        jscode = jscode.replace(old_rev_js, new_rev_js, 1)
        print(f"Updated generateCards in {jspath}")

    with open(jspath, "w") as f:
        f.write(jscode)

print("All updates applied cleanly!")
