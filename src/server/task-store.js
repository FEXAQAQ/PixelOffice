const fs = require('fs');
const path = require('path');
const {STATUS, label} = require('../../public/js/task-status');

function createTaskStore(root) {
  root = path.resolve(root);
  fs.mkdirSync(root, {recursive:true});
  function taskDir(key) {
    if (!/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(String(key))) throw Error('工單號格式不合法');
    return path.join(root, key);
  }
  const taskFile = key => path.join(taskDir(key), 'task.json');
  const markdownFile = key => path.join(taskDir(key), `${key}.md`);
  const eventsFile = key => path.join(taskDir(key), 'log.jsonl');
  function saveTask(task) {
    if (!Object.values(STATUS).includes(task.status)) throw Error(`未知任務狀態：${task.status}`);
    fs.mkdirSync(taskDir(task.key), {recursive:true});
    const previous = fs.existsSync(taskFile(task.key)) ? JSON.parse(fs.readFileSync(taskFile(task.key), 'utf8')) : null;
    const statusHistory = previous?.statusHistory || task.statusHistory || [];
    if (!previous || previous.status !== task.status || !!previous.archived !== !!task.archived) {
      statusHistory.push({status:task.status, archived:!!task.archived, at:Date.now()});
    }
    const record = {...task, schemaVersion:1, statusHistory, statusLabel:label(task.status, task.archived)};
    const temp = taskFile(task.key) + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(temp, taskFile(task.key));
    fs.writeFileSync(markdownFile(task.key), `# ${task.key}：${task.summary || ''}\n\n- 狀態：${record.statusLabel} (${task.status})\n- Sprint：${task.sprint ? `${task.sprint.name} (#${task.sprint.id})` : '未記錄'}\n- 工程師：${task.engineerName || '未指派'}\n\n## 需求描述\n\n${task.description || '（無描述）'}\n`, 'utf8');
    return record;
  }
  function migrate(key) {
    const legacy = path.join(root, `${key}.json`);
    if (!fs.existsSync(legacy)) return;
    const old = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    if (old.key !== key) throw Error(`舊任務單號不一致：${key}`);
    if (!fs.existsSync(taskFile(key))) saveTask({...old, status:old.status === 'running' ? STATUS.IN_PROGRESS : old.status || STATUS.BACKLOG});
    const oldLog = path.join(root, `${key}.events.jsonl`);
    if (fs.existsSync(oldLog)) {
      if (!fs.existsSync(eventsFile(key))) fs.copyFileSync(oldLog, eventsFile(key));
      fs.renameSync(oldLog, path.join(taskDir(key), 'legacy.events.jsonl'));
    }
    fs.renameSync(legacy, path.join(taskDir(key), 'legacy.task.json'));
  }
  function readTask(key) {
    taskDir(key);
    migrate(key);
    if (!fs.existsSync(taskFile(key))) return null;
    return JSON.parse(fs.readFileSync(taskFile(key), 'utf8'));
  }
  function updateTask(key, patch) {
    const task = readTask(key);
    return task ? saveTask({...task, ...patch, updatedAt:Date.now()}) : null;
  }
  function listTasks(status) {
    const keys = new Set(fs.readdirSync(root).map(name => name.replace(/\.json$/, '')).filter(key => /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(key)));
    return [...keys].map(readTask).filter(t => t && (!status || t.status === status)).sort((a,b)=>(a.claimedAt||0)-(b.claimedAt||0));
  }
  function removeTask(key) {
    // Remove only system-owned files; preserve any developer notes and migration backups.
    for (const file of [taskFile(key), markdownFile(key), eventsFile(key)]) if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  return {taskFile, markdownFile, eventsFile, saveTask, readTask, updateTask, listTasks, removeTask};
}
module.exports = {createTaskStore};
