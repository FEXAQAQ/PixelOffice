// Claude Code 原生 AskUserQuestion 的輸入驗證與答案整理。
//
// 工具輸入：{questions:[{question, header, multiSelect, options:[{label, description}]}]}
// 回答方式：PreToolUse hook 回 permissionDecision:'allow' 並附 updatedInput，
//   updatedInput 要把原本的 questions 原樣帶回，再加上 answers：{ "<問題全文>": "<選項 label>" }。
//   複選用 ", " 串起來；使用者自填的文字直接當值。
//   （https://code.claude.com/docs/en/hooks#pretooluse-decision-control）
//
// 問題內容來自模型輸出，是資料不是指令：只取需要的欄位、限制長度，畫面上一律當純文字顯示。
const TOOL_NAME='AskUserQuestion';
const text=(v,max)=>typeof v==='string' ? v.trim().slice(0,max) : '';

function parseQuestions(input){
  const list=input && Array.isArray(input.questions) ? input.questions : null;
  if(!list || !list.length || list.length>4)throw Error('AskUserQuestion 的 questions 格式不正確');
  return list.map(q=>{
    const question=text(q && q.question,1000);
    const options=Array.isArray(q && q.options) ? q.options.map(o=>({label:text(o && o.label,200),description:text(o && o.description,1000)})).filter(o=>o.label) : [];
    if(!question || options.length<2)throw Error('AskUserQuestion 的問題或選項不完整');
    return {question,header:text(q.header,40),multiSelect:q.multiSelect===true,options:options.slice(0,6)};
  });
}

/**
 * 把畫面送來的回答整理成 CLI 要的 answers。
 * raw：{ "<問題全文>": {picked:[label...], other:"自填文字"} }，每題都要有答案。
 */
function normalizeAnswers(questions, raw){
  if(!raw || typeof raw!=='object')throw Error('缺少回答');
  const answers={};
  for(const q of questions){
    const a=raw[q.question] || {};
    const labels=new Set(q.options.map(o=>o.label));
    const picked=(Array.isArray(a.picked) ? a.picked : []).filter(l=>labels.has(l));
    const other=text(a.other,2000);
    const values=[...(q.multiSelect ? picked : picked.slice(0,1)),...(other?[other]:[])];
    if(!values.length)throw Error(`「${q.header || q.question}」還沒有回答`);
    // 單選時自填文字優先於點選（使用者打了字通常就是想改答案）
    answers[q.question]=q.multiSelect ? values.join(', ') : (other || picked[0]);
  }
  return answers;
}
module.exports={TOOL_NAME,parseQuestions,normalizeAnswers};
