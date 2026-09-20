const crypto = require('crypto');
const { load, save, LEVELS, STATUSES, MAX_SCAN_RUNS } = require('./store');
const { ApiError, pickText } = require('./errors');
const { aliasesOf } = require('./rules');

// 一条规则管不管这个文件：适用文件类型写成全部的管所有文件，否则只认同类型的
function ruleAppliesToFile(rule, file) {
  return rule.fileType === '全部' || rule.fileType === file.type;
}

function levelOrder(level) {
  const index = LEVELS.indexOf(level);
  return index === -1 ? LEVELS.length : index;
}

// 扫一遍：启用的规则逐条去比对范围内的文件，命中记到具体行上
function scan(options) {
  const input = options && typeof options === 'object' ? options : {};
  const level = pickText(input.level);
  const fileId = pickText(input.fileId);
  const ruleId = pickText(input.ruleId);

  if (level && !LEVELS.includes(level)) {
    throw new ApiError(400, 'LEVEL_INVALID', `级别只能是 ${LEVELS.join('、')} 其中之一`, 'scanLevel');
  }

  const data = load();

  let scopeFile = null;
  if (fileId) {
    scopeFile = data.files.find((item) => item.id === fileId);
    if (!scopeFile) throw new ApiError(404, 'FILE_NOT_FOUND', '选中的文件不在清单里', 'scanFile');
  }

  let scopeRule = null;
  if (ruleId) {
    scopeRule = data.rules.find((item) => item.id === ruleId);
    if (!scopeRule) throw new ApiError(404, 'RULE_NOT_FOUND', '选中的规则不在清单里', 'scanRule');
  }

  const enabled = data.rules.filter((item) => item.status === STATUSES[0]);
  const warning = scopeRule && scopeRule.status !== STATUSES[0]
    ? `${scopeRule.code} 当前是停用状态，这一轮不参与比对`
    : '';

  const rulesUsed = enabled
    .filter((item) => !scopeRule || item.id === scopeRule.id)
    .filter((item) => !level || item.level === level);

  const filesInScope = scopeFile ? [scopeFile] : data.files;

  const hits = [];
  rulesUsed.forEach((rule) => {
    filesInScope.filter((file) => ruleAppliesToFile(rule, file)).forEach((file) => {
      file.content.split('\n').forEach((text, index) => {
        if (text.includes(rule.pattern)) {
          hits.push({
            ruleId: rule.id,
            code: rule.code,
            ruleName: rule.name,
            level: rule.level,
            pattern: rule.pattern,
            fileId: file.id,
            path: file.path,
            fileType: file.type,
            lineNo: index + 1,
            lineText: text.trim(),
          });
        }
      });
    });
  });

  hits.sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.lineNo - b.lineNo;
  });

  const byLevel = {};
  LEVELS.forEach((item) => { byLevel[item] = 0; });
  hits.forEach((hit) => { byLevel[hit.level] += 1; });

  const byRuleMap = new Map();
  hits.forEach((hit) => {
    const key = hit.code;
    if (!byRuleMap.has(key)) {
      byRuleMap.set(key, { code: hit.code, ruleName: hit.ruleName, level: hit.level, count: 0 });
    }
    byRuleMap.get(key).count += 1;
  });

  const byFileMap = new Map();
  hits.forEach((hit) => {
    const key = hit.path;
    if (!byFileMap.has(key)) byFileMap.set(key, { path: hit.path, fileType: hit.fileType, count: 0 });
    byFileMap.get(key).count += 1;
  });

  const scannedAt = new Date().toISOString();
  const summary = {
    total: hits.length,
    byLevel,
    byRule: Array.from(byRuleMap.values()).sort((a, b) => (a.code < b.code ? -1 : 1)),
    byFile: Array.from(byFileMap.values()).sort((a, b) => (a.path < b.path ? -1 : 1)),
  };

  // 每一轮都落盘成历史记录：命中里带的是当时那一版的编码，
  // 之后规则改编码，这一轮还能按沿革落回同一条规则上
  const run = {
    id: crypto.randomUUID(),
    scannedAt,
    enabledRules: enabled.length,
    rulesUsed: rulesUsed.length,
    filesInScope: filesInScope.length,
    filesTotal: data.files.length,
    rulesTotal: data.rules.length,
    warning,
    hits,
    summary,
  };
  data.scans = [...(Array.isArray(data.scans) ? data.scans : []), run].slice(-MAX_SCAN_RUNS);
  save(data);

  return {
    scanId: run.id,
    scannedAt,
    enabledRules: enabled.length,
    rulesUsed: rulesUsed.length,
    filesInScope: filesInScope.length,
    filesTotal: data.files.length,
    rulesTotal: data.rules.length,
    warning,
    hits,
    summary,
  };
}

// 历史轮次清单：新的在前，只带概要不带命中明细
function listScans() {
  const data = load();
  const scans = (Array.isArray(data.scans) ? data.scans : [])
    .slice()
    .sort((a, b) => (a.scannedAt < b.scannedAt ? 1 : -1))
    .map((run) => ({
      id: run.id,
      scannedAt: run.scannedAt,
      rulesUsed: run.rulesUsed,
      filesInScope: run.filesInScope,
      total: run.summary && Number.isInteger(run.summary.total) ? run.summary.total : run.hits.length,
      warning: run.warning || '',
    }));
  return { scans };
}

// 按 id 先找，找不到再按编码与旧编码找：历史命中里记的可能是改名之前的编码
function resolveRule(rules, hit) {
  const byId = rules.find((item) => item.id === hit.ruleId);
  if (byId) return byId;
  const code = typeof hit.code === 'string' ? hit.code.toLowerCase() : '';
  if (!code) return null;
  return rules.find((item) => item.code.toLowerCase() === code
    || aliasesOf(item).some((alias) => alias.toLowerCase() === code)) || null;
}

// 看历史轮次：每条命中都解析到现在的规则上，当时编码与现在对应规则一起给出；
// 规则被删了也如实标出来，不会出现找不到的情况
function getScan(id) {
  const data = load();
  const run = (Array.isArray(data.scans) ? data.scans : []).find((item) => item.id === id);
  if (!run) throw new ApiError(404, 'SCAN_NOT_FOUND', '这一轮扫描记录不存在或已被清掉', '');
  const hits = run.hits.map((hit) => {
    const rule = resolveRule(data.rules, hit);
    return {
      ...hit,
      currentCode: rule ? rule.code : '',
      currentRuleName: rule ? rule.name : '',
      codeChanged: Boolean(rule) && rule.code !== hit.code,
      ruleGone: !rule,
    };
  });
  return { ...run, hits };
}

module.exports = { scan, listScans, getScan, ruleAppliesToFile, levelOrder };
