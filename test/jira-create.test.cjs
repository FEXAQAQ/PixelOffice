const { test } = require('node:test');
const assert = require('node:assert/strict');
const { issueTypeArgName } = require('../src/server/integrations/jira-create');

/**
 * 回歸測試：Atlassian 遠端把 createJiraIssue 的參數從 issueTypeName 改成 issueType，
 * 舊名會被擋成「MCP error -32602: Required at issueType」。
 * 參數名要照工具當下宣告的 inputSchema 決定，不能寫死。
 */

const tool = (name, properties) => ({ name, inputSchema: { properties } });

test('照現行 schema 送 issueType', () => {
  const tools = [tool('createJiraIssue', { cloudId: {}, projectKey: {}, summary: {}, issueType: {} })];
  assert.equal(issueTypeArgName(tools, 'createJiraIssue'), 'issueType');
});

test('遇到舊 schema 仍送得出 issueTypeName', () => {
  const tools = [tool('createJiraIssue', { cloudId: {}, projectKey: {}, issueTypeName: {} })];
  assert.equal(issueTypeArgName(tools, 'createJiraIssue'), 'issueTypeName');
});

test('兩個都宣告時以新名為準', () => {
  const tools = [tool('createJiraIssue', { issueType: {}, issueTypeName: {} })];
  assert.equal(issueTypeArgName(tools, 'createJiraIssue'), 'issueType');
});

test('schema 缺漏或工具找不到時退回新名，不要送出空參數', () => {
  assert.equal(issueTypeArgName([], 'createJiraIssue'), 'issueType');
  assert.equal(issueTypeArgName([{ name: 'createJiraIssue' }], 'createJiraIssue'), 'issueType');
  assert.equal(issueTypeArgName([tool('createJiraIssue', {})], 'createJiraIssue'), 'issueType');
  assert.equal(issueTypeArgName(null, 'createJiraIssue'), 'issueType');
});

test('支援 input_schema 這種底線寫法', () => {
  const tools = [{ name: 'createJiraIssue', input_schema: { properties: { issueTypeName: {} } } }];
  assert.equal(issueTypeArgName(tools, 'createJiraIssue'), 'issueTypeName');
});

test('只看指定的那個工具，不會被同名參數的其他工具影響', () => {
  const tools = [
    tool('somethingElse', { issueTypeName: {} }),
    tool('createJiraIssue', { issueType: {} }),
  ];
  assert.equal(issueTypeArgName(tools, 'createJiraIssue'), 'issueType');
});
