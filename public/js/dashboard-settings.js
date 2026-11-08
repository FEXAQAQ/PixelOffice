function createSettingsActions({
  showSettings, setErr, draftProjects, draftEngineers, draftAi, draftModes,
  modesInfo, aiLoading, aiReady, setSaving, projects, engineerList, modelInfo, sys, toast,
}) {
  let draftSeq = 0;
  async function openSettings(){
    setErr.value = '';
    // 複製一份草稿，取消時不影響現況
    draftProjects.value  = projects.value.map(p => ({ ...p, automation:{enabled:true,timeoutMinutes:30,baseBranch:'develop',...p.automation,commands:undefined,baseBranch:p.automation?.baseBranch || 'develop'}, _k: ++draftSeq }));
    draftEngineers.value = engineerList.value.map(e => ({
      id:e.id, name:e.name, model:e.model || '', codexModel:e.codexModel || '', _k: ++draftSeq
    }));
    showSettings.value = true;
    aiLoading.value=true;aiReady.value=false;
    try {
      const [ra,rm]=await Promise.all([fetch('/api/ai'),fetch('/api/runtime')]);
      if(!ra.ok)throw Error('讀取 AI 設定失敗');
      if(!rm.ok)throw Error('讀取執行期設定失敗');
      Object.assign(draftAi,await ra.json());
      const m=await rm.json();
      Object.assign(draftModes,m.settings);
      Object.assign(modesInfo,{values:m.values,defaults:m.defaults,overridden:m.overridden,effective:m.effective});
      aiReady.value=true;
    }
    catch(error){setErr.value=error.message;return;}
    finally{aiLoading.value=false;}
    loadModels();
  }
  let modelsRequest = 0;
  async function loadModels(){
    const request=++modelsRequest,provider=draftAi.provider;
    Object.assign(modelInfo,{aliases:[],models:[],seen:[],error:'',note:''});
    try{
      const r = await fetch('/api/models?provider='+provider);
      const data=await r.json();
      if(request===modelsRequest)Object.assign(modelInfo,data);
    }catch(e){if(request===modelsRequest)modelInfo.error='讀取模型清單失敗：'+e.message;}
  }
  // Mock 模式不會讀寫專案路徑（只拿來顯示與上鎖），新專案先填一個示範路徑，省得手打。
  // 每個專案的路徑要不同：同一路徑同時只能跑一個任務，共用會讓工程師互相卡住。
  function mockProjectPath(){
    const used = new Set(draftProjects.value.map(p => p.path));
    let n = 1;
    while (used.has(`mock/project-${n}`)) n++;
    return `mock/project-${n}`;
  }
  function addProject(){
    const path = (draftModes.mode || sys.aiMode) === 'mock' ? mockProjectPath() : '';
    draftProjects.value.push({ id:'', name:'', path, type:'前端', automation:{enabled:true,timeoutMinutes:30,baseBranch:'develop'}, _k: ++draftSeq });
  }
  function addEngineer(){
    if(draftEngineers.value.length>=6)return;
    draftEngineers.value.push({ id:'', name:'Dev ' + (draftEngineers.value.length + 1), model:'', codexModel:'', _k: ++draftSeq });
  }
  async function saveSettings(){
    if(aiLoading.value || !aiReady.value || setSaving.value)return;
    if(draftEngineers.value.length>6){setErr.value='工程師最多 6 位';return;}
    setErr.value = ''; setSaving.value = true;
    try{
      const rp = await fetch('/api/projects', { method:'PUT', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ projects: draftProjects.value.map(({_k,...p})=>p) }) });
      const dp = await rp.json();
      if (!rp.ok) throw new Error(dp.error || '專案儲存失敗');

      const re = await fetch('/api/engineers', { method:'PUT', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ engineers: draftEngineers.value.map(({_k,...e})=>e) }) });
      const de = await re.json();
      if (!re.ok) throw new Error(de.error || '工程師儲存失敗');

      const ra=await fetch('/api/ai',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:draftAi.provider})});
      const da=await ra.json();
      if(!ra.ok)throw Error(da.error || 'AI 平台儲存失敗');
      sys.aiProvider=da.provider;sys.aiMode=da.mode;

      // 執行期設定最後送：被擋下時（有任務在跑、Jira 缺憑證／看板 ID）錯誤訊息才不會被後續請求蓋掉。
      const rm=await fetch('/api/runtime',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...draftModes})});
      const dm=await rm.json();
      if(!rm.ok)throw Error(dm.error || '執行期設定儲存失敗');
      Object.assign(draftModes,dm.settings);Object.assign(modesInfo,{overridden:dm.overridden,effective:dm.effective});

      toast('設定已儲存並寫入設定檔');
      showSettings.value = false;
    }catch(err){ setErr.value = err.message; }
    finally{ setSaving.value = false; }
  }

  return { openSettings, loadModels, addProject, addEngineer, saveSettings };
}

const DashboardSettings = { createSettingsActions };
if (typeof module !== 'undefined' && module.exports) module.exports = DashboardSettings;
if (typeof window !== 'undefined') window.DashboardSettings = DashboardSettings;
