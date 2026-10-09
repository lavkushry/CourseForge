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
  // TODO: expose optional instructor, author-provided tags, thumbnails and course rating
  // through a validated local course-manifest API. Never invent these values.
  /** @returns {{instructor:null,rating:null,thumbnail:null}} */
  const unavailableCourseMetadata = () => ({instructor:null, rating:null, thumbnail:null});
  window.CourseForgeServices = Object.freeze({request, json, videos, progress, insights, notes, saveNote, deleteNote, unavailableCourseMetadata});
})();
