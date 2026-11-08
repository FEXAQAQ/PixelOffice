/**
 * =============================================================
 *  jiraMcp.js — 透過 Atlassian Rovo MCP Server 撈取 Jira 任務
 * -------------------------------------------------------------
 *  以 child_process 啟動 `npx mcp-remote https://mcp.atlassian.com/v2/mcp?tools=all`
 *  （把 Atlassian 遠端 MCP 服務轉成本地 stdio 介面），
 *  然後以 JSON-RPC 2.0 (newline-delimited) 與它握手、呼叫工具：
 *    1. getAccessibleAtlassianResources  -> 取得 cloudId
 *    2. listJiraBoardSprints             -> 取最新 active Sprint
 *    3. searchJiraIssuesUsingJql         -> 依 JQL 撈任務
 *  回傳精簡結果： [{ key, summary }]
 *
 *  ⚠️ v2 端點把工具結果多包一層 { "data": … }，站台清單的鍵也叫
 *     resources（v1 是 values）。unwrapEnvelope() 負責拆封，取站台時
 *     兩種鍵名都接受 —— 換回 v1 端點也不會壞。
 *
 *  ⚠️ 首次使用需先在終端機手動跑一次以完成 OAuth 授權：
 *       npx mcp-remote@latest "https://mcp.atlassian.com/v2/mcp?tools=all"
 *     授權後 token 會被 mcp-remote 快取在 ~/.mcp-auth，**依 URL 的 md5 分目錄**，
 *     所以改了 JIRA_MCP_URL 就等於換一個未授權的 server，必須重新授權一次。
 * =============================================================
 */

const { spawn } = require('child_process');
const {boardId, latestActiveSprint, collectSprints, sprintJql} = require('./latest-sprint');

const MCP_URL = process.env.JIRA_MCP_URL || 'https://mcp.atlassian.com/v2/mcp?tools=all';
const MCP_COMMAND = process.env.JIRA_MCP_COMMAND || 'npx';
const MCP_ARGS = process.env.JIRA_MCP_ARGS
  ? process.env.JIRA_MCP_ARGS.split(' ').filter(Boolean)
  : ['-y', 'mcp-remote@latest', MCP_URL];

const PROTOCOL_VERSION = '2024-11-05';

/**
 * MCP 的指令與參數來自環境變數，而 Windows 上 npx 是 .cmd、只能走 shell
 * （Node 對 .cmd / .bat 不開 shell 會直接丟 EINVAL）。走 shell 就代表 args
 * 不會被轉義，所以啟動前先擋掉 shell 元字元，避免 .env 裡的內容變成可執行的命令。
 */
const SHELL_META = /[&|;<>^`$(){}[\]!\n\r]/;

function assertNoShellMeta(parts) {
  for (const p of parts) {
    if (SHELL_META.test(String(p))) {
      throw new Error(
        `MCP 指令含 shell 元字元，已拒絕執行：${p}` +
          `（請檢查 JIRA_MCP_COMMAND / JIRA_MCP_ARGS / JIRA_MCP_URL）`
      );
    }
  }
}

/** 走 shell 時執行檔路徑要自己加引號 —— Node 不會幫你包，路徑含空白就會失敗。 */
function shellQuote(s) {
  return /[\s()]/.test(s) ? `"${s}"` : s;
}

/**
 * 一個極簡的 MCP stdio client。
 * 每個 JSON-RPC 訊息一行（newline-delimited JSON）。
 */
class McpStdioClient {
  constructor({ onLog } = {}) {
    this.proc = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject}
    this.onLog = onLog || (() => {});
    this.ready = false;
  }

  start() {
    return new Promise((resolve, reject) => {
      // 這裡刻意不把啟動指令回報出去：onLog 會直接顯示在接取／開單視窗裡，
      // 每次連線都印一行 `$ npx -y mcp-remote@latest <URL>` 只是雜訊
      // （mcp-remote 本來就會把連線與授權狀況印到 stderr，那些才有診斷價值）。
      try {
        assertNoShellMeta([MCP_COMMAND, ...MCP_ARGS]);
        const useShell = process.platform === 'win32';
        this.proc = spawn(useShell ? shellQuote(MCP_COMMAND) : MCP_COMMAND, MCP_ARGS, {
          env: process.env,
          shell: useShell,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        return reject(new Error(`無法啟動 MCP server：${err.message}`));
      }

      this.proc.stdout.on('data', (d) => this._onStdout(d));
      // mcp-remote 會把連線/授權訊息印到 stderr
      this.proc.stderr.on('data', (d) => this.onLog(`[mcp] ${d.toString()}`, 'stderr'));

      this.proc.on('error', (err) => reject(new Error(`MCP 程序錯誤：${err.message}`)));
      this.proc.on('close', (code) => {
        this.ready = false;
        // 讓還在等待的請求失敗
        for (const { reject: rj } of this.pending.values()) {
          rj(new Error(`MCP 程序已結束 (code ${code})`));
        }
        this.pending.clear();
      });

      resolve();
    });
  }

  _onStdout(chunk) {
    this.buf += chunk.toString();
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_) {
        // 非 JSON（可能是雜訊）就當 log 印出
        this.onLog(`[mcp] ${line}\n`);
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
    // 其餘（server 主動送的 notification）忽略
  }

  _send(obj) {
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params, timeoutMs = 60000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 請求逾時：${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this._send({ jsonrpc: '2.0', method, params });
  }

  async initialize() {
    const res = await this.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'pixeloffice', version: '1.0.0' },
      },
      90000 // 首次可能要下載 npx 套件 + OAuth，給寬一點
    );
    this.notify('notifications/initialized', {});
    this.ready = true;
    return res;
  }

  async listTools() {
    const tools = [];
    let cursor;
    const seen = new Set();
    do {
      const res = await this.request('tools/list', cursor ? {cursor} : {});
      tools.push(...(res?.tools || []));
      cursor = res?.nextCursor;
      if (cursor && seen.has(cursor)) throw Error('MCP 工具清單分頁未前進');
      seen.add(cursor);
    } while (cursor);
    return tools;
  }

  async callTool(name, args) {
    return this.request('tools/call', { name, arguments: args || {} });
  }

  stop() {
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill(); } catch (_) {}
    }
  }
}

/**
 * 從 MCP tool 回傳的 content 陣列中萃取出結構化資料。
 * Atlassian 工具通常回： { content: [{ type:'text', text:'<JSON 字串>' }] }
 */
function unwrapEnvelope(payload) {
  // Atlassian v2 端點把結果包一層 { "data": … }；v1 則直接回內容。
  // 只在「唯一的鍵就是 data」時拆封，避免誤拆真的有 data 欄位的結果。
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const keys = Object.keys(payload);
    if (keys.length === 1 && keys[0] === 'data') return payload.data;
  }
  return payload;
}

function extractPayload(result) {
  if (!result) return null;
  // 有些實作直接回 structuredContent
  if (result.structuredContent) return unwrapEnvelope(result.structuredContent);
  const content = result.content || [];
  const textPart = content.find((c) => c && c.type === 'text' && typeof c.text === 'string');
  if (!textPart) return null;
  try {
    return unwrapEnvelope(JSON.parse(textPart.text));
  } catch (_) {
    return textPart.text; // 不是 JSON 就回原字串
  }
}

/** 在工具清單中用關鍵字模糊比對工具名稱（避免 server 端前綴差異，如 atlassian_） */
function findTool(tools, keyword) {
  const kw = keyword.toLowerCase();
  const hit = tools.find((t) => t.name && t.name.toLowerCase().includes(kw));
  return hit ? hit.name : null;
}

/** 把 Jira ADF（Atlassian Document Format）描述壓成純文字 */
function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  let out = '';
  if (node.text) out += node.text;
  if (Array.isArray(node.content)) {
    for (const child of node.content) out += adfToText(child);
    if (['paragraph', 'heading', 'listItem'].includes(node.type)) out += '\n';
  }
  return out;
}

/**
 * 開一個 MCP session、初始化、取得 cloudId 與工具清單後，
 * 執行 callback(ctx) 並保證最後關閉程序。
 */
async function withSession(onLog, fn) {
  const log = onLog || (() => {});
  const client = new McpStdioClient({ onLog: log });
  try {
    await client.start();
    await client.initialize();
    const tools = await client.listTools();
    log(`[mcp] 已連線，可用工具 ${tools.length} 個\n`);

    let cloudId = process.env.JIRA_CLOUD_ID || '';
    if (!cloudId) {
      const resTool =
        findTool(tools, 'AccessibleAtlassianResources') || findTool(tools, 'AccessibleResources');
      if (!resTool) throw new Error('找不到取得 cloudId 的工具（getAccessibleAtlassianResources）');
      const resources = extractPayload(await client.callTool(resTool, {}));
      const list = Array.isArray(resources)
        ? resources
        : resources && (resources.values || resources.resources);
      if (!list || !list.length) throw new Error('MCP 未回傳任何可存取的 Atlassian 站台');
      cloudId = list[0].id || list[0].cloudId;
      log(`[mcp] 使用站台 cloudId=${cloudId}（${list[0].url || ''}）\n`);
    }
    return await fn({ client, tools, cloudId, log });
  } finally {
    client.stop();
  }
}

/**
 * 逐字取出工單標題。
 * ⚠️ 刻意「不」做任何 fallback 改寫（不抓 it.title、不補「(無標題)」、不 trim），
 *    確保畫面顯示的標題與 Jira 卡面完全一致。
 *    只接受 fields.summary，其次是頂層 summary（部分回傳格式會扁平化）。
 */
function pickSummary(it) {
  const f = it.fields || {};
  if (typeof f.summary === 'string') return f.summary;
  if (typeof it.summary === 'string') return it.summary;
  return '';
}

function pickDescription(it) {
  const f = it.fields || {};
  const d = f.description !== undefined ? f.description : it.description;
  if (d === undefined || d === null) return '';
  return typeof d === 'string' ? d : adfToText(d);
}

/**
 * 從 getJiraIssue 的回傳中取出那一張工單。
 * 不同版本的端點包法不一：可能直接回工單物件、包成 { issues: [...] }，
 * 也可能是 v2 的 { issues: { nodes: [...] } }，三種都接。
 */
function pickIssueNode(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const issues = payload.issues;
  if (Array.isArray(issues)) return issues[0] || null;
  if (issues && Array.isArray(issues.nodes)) return issues.nodes[0] || null;
  if (payload.key || payload.fields) return payload;
  return null;
}

/** 解析 searchJiraIssuesUsingJql 回傳的 issues 陣列 */
function parseIssues(searchRes) {
  const issues = (searchRes && (searchRes.issues || searchRes.results || searchRes.values)) || [];
  return issues.map((it) => ({
    key: it.key || (it.fields && it.fields.key) || '',
    summary: pickSummary(it),
    description: pickDescription(it),
  }));
}

/**
 * 主要對外函式：撈取「未指派」任務（或自訂 JQL），只回 key + summary。
 * @param {object} opts
 * @param {string} [opts.jql]     自訂 JQL（預設抓未指派、未完成）
 * @param {number} [opts.maxResults]
 * @param {string|number} [opts.boardId] 看板 ID；省略時回退 JIRA_BOARD_ID
 * @param {function} [opts.onLog] 把 MCP stdout/stderr 轉發出去（可接到 Socket.io）
 * @returns {Promise<Array<{key:string, summary:string}>>}
 */
async function fetchUnassignedTasks(opts = {}) {
  // 看板 ID 由呼叫端給（畫面設定優先，沒有才回退 env），不要各自讀 env
  const selectedBoard = boardId(opts.boardId || process.env.JIRA_BOARD_ID);
  const maxResults = opts.maxResults || 50;

  return withSession(opts.onLog, async ({ client, tools, cloudId, log }) => {
    const searchTool =
      findTool(tools, 'searchJiraIssuesUsingJql') || findTool(tools, 'searchJiraIssues');
    if (!searchTool) throw new Error('找不到 Jira JQL 搜尋工具（searchJiraIssuesUsingJql）');

    const sprintTool = findTool(tools, 'listJiraBoardSprints');
    if (!sprintTool) throw Error('MCP 未提供 listJiraBoardSprints；請使用提供完整工具清單的 MCP 端點，或設定 JIRA_MODE=real 使用 REST。');
    const sprints = await collectSprints(async startAt => {
      const result = await client.callTool(sprintTool, {cloudId,boardId:selectedBoard,state:'active',startAt,maxResults:50});
      if (result.isError) throw Error('MCP 取得 Sprint 失敗');
      return extractPayload(result);
    });
    const sprint = latestActiveSprint(sprints);
    if (!sprint) return {tasks:[],sprint:null,jql:''};
    const jql = sprintJql(sprint, opts.jql || '');
    log(`[mcp] Sprint: ${sprint.name} (#${sprint.id})\n[mcp] JQL: ${jql}\n`);
    const tasks = [];
    let nextPageToken;
    do {
      const result = await client.callTool(searchTool, {cloudId,jql,maxResults,fields:['summary'],...(nextPageToken ? {nextPageToken} : {})});
      if (result.isError) throw Error('MCP 搜尋 Jira 任務失敗');
      const payload = extractPayload(result);
      if (!payload || typeof payload !== 'object') throw Error('Jira 搜尋回傳格式不正確');
      if (String(process.env.JIRA_DEBUG) === 'true') console.log('[jira-debug] 原始搜尋回應：\n' + JSON.stringify(payload, null, 2).slice(0, 4000));
      tasks.push(...parseIssues(payload).filter(t=>t.key).map(t=>({key:t.key,summary:t.summary,sprint})));
      if (payload.nextPageToken && payload.nextPageToken === nextPageToken) throw Error('Jira 任務分頁未前進');
      nextPageToken = payload.nextPageToken;
      if (!nextPageToken && (payload.isLast === false || payload.total > tasks.length)) throw Error('Jira 搜尋未提供後續頁，無法取得完整任務清單');
    } while(nextPageToken);
    log(`[mcp] 取得 ${tasks.length} 筆任務\n`);
    return {tasks,jql,sprint};
  });
}

/**
 * 依 key 撈取工單完整內容（標題 + 描述），供「接取」時存到 task 資料夾。
 *
 * ⚠️ 這裡刻意「一張一張」呼叫 getJiraIssue，而不是用一次 JQL 搜尋撈完：
 *    Atlassian v2 的 searchJiraIssuesUsingJql 取不到某個欄位時會**靜默丟掉**該欄位
 *    （fields 只剩 summary、description 整個不見，isError 仍是 false、也不拋錯），
 *    即使 fields 只指定 ['description'] 也一樣。描述被丟掉後工單照樣被接取，
 *    要到派工前的守門才爆「需求描述為空」，等於把 Jira 的問題誤報成 PM 的問題。
 *    getJiraIssue 對同一張單則穩定回得到描述。
 *
 * 撈不到描述欄位時直接拋錯（而非留空），避免同樣的靜默失敗再次改頭換面出現。
 *
 * @param {string[]} keys
 * @returns {Promise<Array<{key,summary,description}>>}
 */
async function fetchIssuesDetail(keys, opts = {}) {
  const list = (keys || []).filter(Boolean);
  if (!list.length) return [];

  return withSession(opts.onLog, async ({ client, tools, cloudId, log }) => {
    const issueTool = findTool(tools, 'getJiraIssue');
    if (!issueTool) throw new Error('找不到 Jira 工單讀取工具（getJiraIssue）');

    const detail = [];
    for (const key of list) {
      log(`[mcp] 擷取工單詳情：${key}\n`);
      const result = await client.callTool(issueTool, {
        cloudId,
        issueIdOrKey: key,
        fields: ['summary', 'description'],
        responseContentFormat: 'markdown',
      });
      // 查無此單（或沒權限）會回 isError；比照原本 JQL 的行為略過，
      // 由上層彙整成「查無這些單號」回報，不讓一張壞單拖垮整批接取。
      const node = result.isError ? null : pickIssueNode(extractPayload(result));
      if (!node) {
        log(`[mcp] 查無 ${key}（或無權限），略過\n`);
        continue;
      }
      // 欄位「沒回來」和「本來就空」是兩回事，前者是抓取失敗，不能當成空描述放行。
      const fields = node.fields || {};
      if (!('description' in fields) && node.description === undefined) {
        throw Error(`Jira 未回傳 ${key} 的描述欄位，請重試或改用 REST 模式`);
      }

      detail.push({
        key: node.key || key,
        summary: pickSummary(node),
        description: pickDescription(node),
      });
    }
    log(`[mcp] 取得 ${detail.length} 筆工單詳情\n`);
    return detail;
  });
}

module.exports = {
  fetchUnassignedTasks, fetchIssuesDetail, McpStdioClient,
  // 給 jira-create.js 共用同一套 session／解封／工具比對邏輯，避免各寫一份。
  withSession, findTool, extractPayload, pickIssueNode, adfToText,
};
