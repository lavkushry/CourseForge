/* P1 · Source-backed mastery checks for a roadmap topic. Never reveal answer keys before submission. */
'use strict';
(() => {
  let assessment = null;
  let activePath = null;
  let activeStep = null;

  const heading = $('#assessmentHeading');
  const status = $('#assessmentStatus');
  const panel = $('#assessmentPanel');
  const questions = $('#assessmentQuestions');
  const resultPanel = $('#assessmentResult');

  function reviewVideo(source) {
    return openVideo(source.video_id, source.start).catch(error => toast(error.message, true));
  }

  function statusLabel(value) {
    return ({needs_practice:'Needs practice', developing:'Developing', ready_for_review:'Ready for review'})[value] || 'Not assessed';
  }

  function reset() {
    assessment = null;
    questions.replaceChildren();
    resultPanel.replaceChildren();
    resultPanel.hidden = true;
    status.textContent = '';
    $('#assessmentSubmit').disabled = false;
    panel.hidden = true;
  }

  async function begin(pathId, step) {
    activePath = pathId;
    activeStep = step;
    panel.hidden = false;
    panel.scrollIntoView({behavior:'smooth',block:'start'});
    heading.textContent = `Check your understanding: ${step.title}`;
    status.textContent = 'Creating questions from your indexed lectures…';
    questions.replaceChildren();
    resultPanel.hidden = true;
    $('#assessmentSubmit').disabled = true;
    $('#assessmentForm').hidden = true;
    try {
      assessment = await services.startAssessment(pathId, step.id, 3);
      questions.replaceChildren();
      for (let i=0; i<assessment.questions.length; i++) {
        const q = assessment.questions[i];
        const fieldset = make('fieldset','assessment-question');
        fieldset.dataset.questionId = q.id;
        const legend=make('legend','',`${i+1}. ${q.question}`);fieldset.append(legend);
        for (let index=0;index<q.options.length;index++){
          const label=make('label','assessment-option');
          const input=make('input');input.type='radio';input.name=`answer_${q.id}`;
          input.value=String(index);input.required=true;
          label.append(input,make('span','',q.options[index]));fieldset.append(label);
        }
        questions.append(fieldset);
      }
      status.textContent=`${assessment.question_count} source-grounded questions. Choose one answer per question.`;
      $('#assessmentForm').hidden=false;
      $('#assessmentSubmit').disabled=false;
      questions.querySelector('input')?.focus({preventScroll:true});
    }catch(error){status.textContent=error.message;toast(error.message,true)}
  }

  $('#assessmentForm').addEventListener('submit',async event=>{
    event.preventDefault();
    if (!assessment) return;
    const answers={};
    for (const q of assessment.questions) {
      const container = [...questions.children].find(el=>el.dataset.questionId===q.id);
      const selected=container?.querySelector('input:checked');
      if (!selected) {status.textContent='Choose an answer for every question.';container?.querySelector('input')?.focus();return;}
      answers[q.id]=Number(selected.value);
    }
    const submit=$('#assessmentSubmit');submit.disabled=true;
    status.textContent='Checking your answers…';
    try {
      const result=await services.submitAssessment(assessment.id,answers);
      $('#assessmentForm').hidden=true;
      resultPanel.replaceChildren();resultPanel.hidden=false;
      const headline=make('h4','',`${result.score}% · ${statusLabel(result.status)}`);
      resultPanel.append(headline,make('p','',`${result.correct_count} of ${result.total_count} correct. This is a practice signal, not a certification or automatic mastery claim.`));
      for(const feedback of result.feedback){
        const original=assessment.questions.find(q=>q.id===feedback.question_id);
        const item=make('article','assessment-feedback'+(feedback.correct?' correct':' incorrect'));
        item.append(make('strong','',`${feedback.correct?'Correct':'Review needed'} · ${original?.question || 'Question'}`));
        item.append(make('p','',feedback.explanation));
        if(!feedback.correct){
          item.append(make('p','',`Suggested answer: ${original?.options[feedback.correct_index] || ''}`));
          const button=make('button','source-chip',`Revisit ${feedback.source.title} at ${prettyTime(feedback.source.start)} →`);
          button.type='button';button.addEventListener('click',()=>reviewVideo(feedback.source));item.append(button);
        }
        resultPanel.append(item);
      }
      status.textContent='Saved your attempt and updated the topic signal.';
      const pathId=activePath;
      await window.CourseForgeLearningPaths.show(pathId);
      resultPanel.querySelector('h4')?.setAttribute('tabindex','-1');
      resultPanel.querySelector('h4')?.focus({preventScroll:true});
    }catch(error){status.textContent=error.message;submit.disabled=false;toast(error.message,true)}
  });

  $('#assessmentClose').addEventListener('click',()=>{
    reset();
    const button=[...document.querySelectorAll('[data-assess-step]')].find(el=>el.dataset.assessStep===activeStep?.id);
    button?.focus({preventScroll:true});
  });

  window.CourseForgeAssessments = Object.freeze({begin,reset,statusLabel});
})();
