const {test}=require('node:test');
const assert=require('node:assert/strict');
const {boardId,latestActiveSprint,collectSprints,sprintJql}=require('../src/server/integrations/latest-sprint');
const {McpStdioClient}=require('../src/server/integrations/jira-mcp');
const {fetchUnassignedTasks}=require('../src/server/integrations/jira-mcp');
test('latest sprint is selected by active start date, not ID, issue presence or future sprint',async()=>{
  const pages=[{values:[{id:90,name:'Old',state:'active',startDate:'2026-08-01'},{id:100,name:'Future',state:'future'}],isLast:false},{values:[{id:2,name:'Latest empty sprint',state:'active',startDate:'2026-09-01'},{id:110,name:'Closed',state:'closed',startDate:'2026-09-10'}],isLast:true}];
  const starts=[];
  const all=await collectSprints(async start=>{starts.push(start);return pages.shift();});
  assert.deepEqual(starts,[0,2]);
  assert.equal(latestActiveSprint(all).id,2);
  assert.equal(latestActiveSprint([]),null);
  assert.throws(()=>latestActiveSprint([{id:1,name:'Broken',state:'active'}]),/開始日期/);
  await assert.rejects(collectSprints(async()=>({values:[],isLast:false})),/分頁不完整/);
});
test('custom JQL cannot replace sprint or standard eligibility filters',()=>{
  const jql=sprintJql({id:42},'priority = High OR priority = Low ORDER BY created ASC','ABC');
  assert.match(jql,/^sprint = 42 AND statusCategory = "To Do" AND assignee is EMPTY/);
  assert.match(jql,/AND \(priority = High OR priority = Low\) ORDER BY created DESC$/);
  assert.equal(boardId('12'),12);
  assert.throws(()=>boardId(''),/JIRA_BOARD_ID/);
});
test('MCP reads every tool catalog page so sprint tools can be found',async()=>{
  const client=new McpStdioClient();
  client.request=async(method,args)=>args.cursor ? {tools:[{name:'listJiraBoardSprints'}]} : {tools:[{name:'searchJiraIssuesUsingJql'}],nextCursor:'page2'};
  assert.equal((await client.listTools())[1].name,'listJiraBoardSprints');
});
test('MCP flow selects latest sprint before searching and keeps sprint on every issue',async t=>{
  const originalBoard=process.env.JIRA_BOARD_ID,originalCloud=process.env.JIRA_CLOUD_ID;
  process.env.JIRA_BOARD_ID='7';process.env.JIRA_CLOUD_ID='test-cloud';
  t.after(()=>{for(const [key,value] of [['JIRA_BOARD_ID',originalBoard],['JIRA_CLOUD_ID',originalCloud]])value===undefined?delete process.env[key]:process.env[key]=value;});
  t.mock.method(McpStdioClient.prototype,'start',async()=>{});
  t.mock.method(McpStdioClient.prototype,'initialize',async()=>{});
  t.mock.method(McpStdioClient.prototype,'stop',()=>{});
  t.mock.method(McpStdioClient.prototype,'listTools',async()=>[{name:'listJiraBoardSprints'},{name:'searchJiraIssuesUsingJql'}]);
  let searches=0;
  t.mock.method(McpStdioClient.prototype,'callTool',async(name,args)=>{
    if(name==='listJiraBoardSprints')return {structuredContent:{values:[{id:3,name:'Current',state:'active',startDate:'2026-09-01'}],isLast:true}};
    searches++;
    assert.match(args.jql,/^sprint = 3 AND/);
    return {structuredContent:{issues:args.nextPageToken?[{key:'ABC-2',fields:{summary:'第二張'}}]:[{key:'ABC-1',fields:{summary:'第一張'}}],...(args.nextPageToken?{isLast:true}:{nextPageToken:'next',isLast:false})}};
  });
  const result=await fetchUnassignedTasks();
  assert.equal(searches,2);assert.equal(result.sprint.name,'Current');
  assert.deepEqual(result.tasks.map(t=>t.sprint.id),[3,3]);
  t.mock.method(McpStdioClient.prototype,'callTool',async(name)=>{
    assert.equal(name,'listJiraBoardSprints');
    return {structuredContent:{values:[],isLast:true}};
  });
  assert.deepEqual(await fetchUnassignedTasks(),{tasks:[],sprint:null,jql:''});
});
