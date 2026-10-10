'use strict';
/**
 * CourseForge's typed client boundary. Only real backend data is rendered as facts.
 * @typedef {{id:string,course:string,title:string,duration:number|null,status:string,chunk_count:number}} Video
 * @typedef {{video_id:string,percent:number,position:number,completed:number,updated_at?:string|null}} Progress
 * @typedef {{due_count:number,total_cards:number,reviews_today:number,streak_days:number,mastery_signal_percent:number|null,weak_areas:Array<{course:string,question:string,quality:number,date:string}>,history:Array<{course:string,question:string,quality:number,date:string}>,weekly_reviews:Array<{date:string,count:number}>}} Insights
 */
(() => {
  async function request(path, options = {}, resolveTask = true) {
    const headers = new Headers(options.headers || {});
    if (window.CourseForgeAccount?.csrf) headers.set('X-CSRF-Token', window.CourseForgeAccount.csrf);
    const response = await fetch(path, {...options, headers});
    const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${response.status})`);
      error.status = response.status;
      if(response.status===401 && window.CourseForgeAccount?.user) window.dispatchEvent(new Event('courseforge-session-expired'));
      throw error;
    }
    if (body.task_id && resolveTask) {
      window.dispatchEvent(new CustomEvent('courseforge-task', {detail: body}));
      for(let i=0;i<360;i++) {
        await new Promise(resolve=>setTimeout(resolve,1000));
        const task=await request(`/api/tasks/${encodeURIComponent(body.task_id)}`,{},false);
        if(task.status==='done')return task.result;
        if(task.status==='failed')throw new Error(task.error || 'The task could not finish. Please retry.');
      }
      throw new Error('This task is still queued. Refresh later or ask the administrator to check the learning worker.');
    }
    return body;
  }
  const json = (method, data) => ({method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)});
  /** @returns {Promise<{videos:Video[]}>} */
  const videos = () => request('/api/videos');
  /** @returns {Promise<{progress:Progress[]}>} */
  const progress = () => request('/api/progress');
  /** @returns {Promise<Insights>} */
  const insights = () => request('/api/studio/insights');
  const notes = (id) => request(`/api/videos/${encodeURIComponent(id)}/notes`);
  const saveNote = (id, position, content) => request(`/api/videos/${encodeURIComponent(id)}/notes`, json('POST', {position, content}));
  const deleteNote = (id) => request(`/api/notes/${encodeURIComponent(id)}`, {method:'DELETE'});
  /** @typedef {{id:string,title:string,instructor:string|null,category:string|null,tags:string[],cover_url:string,cover_kind:string|null}} CourseMeta */
  /** @returns {Promise<{courses:CourseMeta[]}>} */
  const courses = () => request('/api/courses');
  const updateCourse = (id,data) => request(`/api/courses/${encodeURIComponent(id)}`,json('PATCH',data));
  const uploadCover = (id,file) => request(`/api/courses/${encodeURIComponent(id)}/cover`,{method:'PUT',headers:{'Content-Type':file.type},body:file});
  const resetCover = (id) => request(`/api/courses/${encodeURIComponent(id)}/cover`,{method:'DELETE'});
  /** @typedef {{id:string,title:string,order:number,prerequisites:string[],sources:Array<{video_id:string,video_title:string,start:number,course:string}>,completed:boolean,watched_sources:number,goal_focus:boolean}} PathStep */
  /** @typedef {{id:string,goal:string,courses:string[],steps:PathStep[],inference:string,completion_percent:number,outdated:boolean,next_step_id:string|null}} LearningPath */
  const learningPaths = () => request('/api/learning-paths');
  const learningPath = (id) => request(`/api/learning-paths/${encodeURIComponent(id)}`);
  const createLearningPath = (courses,goal,use_ai=true) => request('/api/learning-paths',json('POST',{courses,goal,use_ai}));
  const completeLearningStep = (id,step,completed) => request(`/api/learning-paths/${encodeURIComponent(id)}/steps/${encodeURIComponent(step)}`,json('PUT',{completed}));
  /** @typedef {{id:string,question_count:number,questions:Array<{id:string,question:string,options:string[],source:{video_id:string,start:number,title:string}}>} } TopicAssessment */
  const startAssessment = (pathId,stepId,count=3) => request(`/api/learning-paths/${encodeURIComponent(pathId)}/steps/${encodeURIComponent(stepId)}/assessments`,json('POST',{count}));
  const submitAssessment = (id,answers) => request(`/api/assessments/${encodeURIComponent(id)}/attempts`,json('POST',{answers}));
  const assessmentHistory = (pathId,stepId=null) => request(`/api/learning-paths/${encodeURIComponent(pathId)}/assessment-history${stepId?'?step_id='+encodeURIComponent(stepId):''}`);
  const practiceRecommendations = (id) => request(`/api/learning-paths/${encodeURIComponent(id)}/practice-recommendations`);
  const practiceHistory = (id,step=null) => request(`/api/learning-paths/${encodeURIComponent(id)}/practice-history${step?'?step_id='+encodeURIComponent(step):''}`);
  const startRecommendedPractice = (id,step,slug) => request(`/api/learning-paths/${encodeURIComponent(id)}/steps/${encodeURIComponent(step)}/practice/${encodeURIComponent(slug)}/start`,{method:'POST'});
  /** @typedef {{study_date:string,budget_minutes:number,planned_minutes:number,completed_count:number,items:Array<{id:string,kind:string,title:string,description:string,minutes:number,status:string,action:object}>}} DailyPlan */
  const plannerPreferences = () => request('/api/planner/preferences');
  const savePlannerPreferences = (daily_minutes,path_id) => request('/api/planner/preferences', json('PUT',{daily_minutes,path_id}));
  const plannerDay = (day) => request(`/api/planner/days/${encodeURIComponent(day)}`);
  const generatePlannerDay = (study_date,tz_offset_minutes,refresh=false) => request('/api/planner/days',json('POST',{study_date,tz_offset_minutes,refresh}));
  const setPlannerItem = (id,status) => request(`/api/planner/items/${encodeURIComponent(id)}`,json('PUT',{status}));
  /** @typedef {{week_start:string,days:Array<{date:string,weekday:number,budget_minutes:number,planned_minutes:number,actual_minutes:number,forecast_reviews:number,rest_day:boolean}>}} WeeklyCalendar */
  const weekPreferences = () => request('/api/planner/week-preferences');
  const saveWeekPreferences = (weekday_minutes) => request('/api/planner/week-preferences',json('PUT',{weekday_minutes}));
  const weeklyCalendar = (week) => request(`/api/planner/weeks/${encodeURIComponent(week)}`);
  const generateWeeklyCalendar = (week_start,tz_offset_minutes,refresh=false) => request('/api/planner/weeks',json('POST',{week_start,tz_offset_minutes,refresh}));
  const savePlannerActual = (id,actual_minutes) => request(`/api/planner/items/${encodeURIComponent(id)}/actual`,json('PUT',{actual_minutes}));
  /** @typedef {{id:string,mode:'focus'|'break',status:'running'|'paused'|'finished'|'cancelled',duration_seconds:number,elapsed_seconds:number,remaining_seconds:number}} FocusSession */
  const beginFocus = (body) => request('/api/focus/sessions',json('POST',body));
  const focusAction = (id,action) => request(`/api/focus/sessions/${encodeURIComponent(id)}/actions`,json('POST',{action}));
  const activeFocus = () => request('/api/focus/active');
  const focusHistory = () => request('/api/focus/history');
  const focusAnalytics = (week,offset) => request(`/api/focus/analytics/${encodeURIComponent(week)}?tz_offset_minutes=${encodeURIComponent(offset)}`);
  window.CourseForgeServices = Object.freeze({beginFocus,focusAction,activeFocus,focusHistory,focusAnalytics,weekPreferences,saveWeekPreferences,weeklyCalendar,generateWeeklyCalendar,savePlannerActual,plannerPreferences,savePlannerPreferences,plannerDay,generatePlannerDay,setPlannerItem,practiceRecommendations,practiceHistory,startRecommendedPractice,startAssessment,submitAssessment,assessmentHistory,learningPaths,learningPath,createLearningPath,completeLearningStep,request, json, videos, progress, insights, notes, saveNote, deleteNote, courses, updateCourse, uploadCover, resetCover});
})();
