'use strict';
/**
 * CourseForge's typed client boundary. Only real backend data is rendered as facts.
 * @typedef {{id:string,course:string,title:string,duration:number|null,status:string,chunk_count:number}} Video
 * @typedef {{video_id:string,percent:number,position:number,completed:number,updated_at?:string|null}} Progress
 * @typedef {{due_count:number,total_cards:number,reviews_today:number,streak_days:number,mastery_signal_percent:number|null,weak_areas:Array<{course:string,question:string,quality:number,date:string}>,history:Array<{course:string,question:string,quality:number,date:string}>,weekly_reviews:Array<{date:string,count:number}>}} Insights
 */
(() => {
  async function request(path, options = {}) {
    const response = await fetch(path, options);
    const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${response.status})`);
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
  window.CourseForgeServices = Object.freeze({learningPaths,learningPath,createLearningPath,completeLearningStep,request, json, videos, progress, insights, notes, saveNote, deleteNote, courses, updateCourse, uploadCover, resetCover});
})();
