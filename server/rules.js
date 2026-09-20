const crypto = require('crypto');
const {
  load,
  save,
  LEVELS,
  STATUSES,
  FILE_TYPES,
  MAX_CODE_LENGTH,
  MAX_RULE_NAME_LENGTH,
  MAX_PATTERN_LENGTH,
  MAX_NOTE_LENGTH,
  previousCodesOf,
  claimedCodesOf,
} = require('./store');
const { ApiError, pickText } = require('./errors');

// 规则编码固定成大写字母加分段的数字，方便在命中清单里引用
const CODE_PATTERN = /^[A-Z]{2,6}-\d{2,4}$/;

// 按编码找规则：当前编码与沿革里的旧编码都认，保证旧引用能落回同一条规则
function findRuleByCode(data, code) {
  const target = code.toLowerCase();
  return data.rules.find((item) => item.code.toLowerCase() === target
    || previousCodesOf(item).some((oldCode) => oldCode.toLowerCase() === target)) || null;
}

function validateCode(value, data, selfId) {
  const code = pickText(value);
  if (!code) throw new ApiError(400, 'CODE_REQUIRED', '请填写规则编码', 'code');
  if (code.length > MAX_CODE_LENGTH) {
    throw new ApiError(400, 'CODE_TOO_LONG', `规则编码不能超过 ${MAX_CODE_LENGTH} 个字符`, 'code');
  }
  if (!CODE_PATTERN.test(code)) {
    throw new ApiError(400, 'CODE_INVALID', '规则编码要写成大写字母加短横线加数字，例如 CODE-001', 'code');
  }
  const target = code.toLowerCase();
  // 同一个新编码不能被两条规则同时占用：先看是不是别人的当前编码
  const currentOwner = data.rules.find((item) => item.id !== selfId && item.code.toLowerCase() === target);
  if (currentOwner) {
    throw new ApiError(409, 'CODE_DUPLICATED', `编码 ${currentOwner.code} 已经被 ${currentOwner.name} 用了`, 'code');
  }
  // 再看是不是别的规则沿革里保留下来的旧编码——旧编码也不能拿去做正文
  const aliasOwner = data.rules.find((item) => item.id !== selfId
    && Array.from(claimedCodesOf(item)).includes(target));
  if (aliasOwner) {
    throw new ApiError(409, 'CODE_ALIAS_OCCUPIED', `编码 ${code} 曾是规则 ${aliasOwner.code}（${aliasOwner.name}）的旧编码，不能再用作其他规则的编码`, 'code');
  }
  return code;
}

function validateName(value) {
  const name = pickText(value);
  if (!name) throw new ApiError(400, 'NAME_REQUIRED', '请填写规则名称', 'name');
  if (name.length > MAX_RULE_NAME_LENGTH) {
    throw new ApiError(400, 'NAME_TOO_LONG', `规则名称不能超过 ${MAX_RULE_NAME_LENGTH} 个字符`, 'name');
  }
  return name;
}

function validatePattern(value) {
  const pattern = typeof value === 'string' ? value : '';
  if (!pattern.trim()) throw new ApiError(400, 'PATTERN_REQUIRED', '请填写要匹配的写法', 'pattern');
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new ApiError(400, 'PATTERN_TOO_LONG', `匹配写法不能超过 ${MAX_PATTERN_LENGTH} 个字符`, 'pattern');
  }
  return pattern;
}

function validateLevel(value) {
  const level = pickText(value);
  if (!level) return LEVELS[0];
  if (!LEVELS.includes(level)) {
    throw new ApiError(400, 'LEVEL_INVALID', `级别只能是 ${LEVELS.join('、')} 其中之一`, 'level');
  }
  return level;
}

function validateStatus(value) {
  const status = pickText(value);
  if (!status) return STATUSES[0];
  if (!STATUSES.includes(status)) {
    throw new ApiError(400, 'STATUS_INVALID', `状态只能是 ${STATUSES.join('、')} 其中之一`, 'status');
  }
  return status;
}

function validateFileType(value) {
  const fileType = pickText(value);
  if (!fileType) return FILE_TYPES[0];
  if (!FILE_TYPES.includes(fileType)) {
    throw new ApiError(400, 'FILE_TYPE_INVALID', `适用文件类型只能是 ${FILE_TYPES.join('、')} 其中之一`, 'fileType');
  }
  return fileType;
}

function validateNote(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ApiError(400, 'NOTE_INVALID', '说明需要是文本', 'note');
  if (value.length > MAX_NOTE_LENGTH) {
    throw new ApiError(400, 'NOTE_TOO_LONG', `说明不能超过 ${MAX_NOTE_LENGTH} 个字符`, 'note');
  }
  return value.trim();
}

function sortRules(list) {
  return list.slice().sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

// 规则清单：按级别、状态、适用文件类型筛选，再按编码、名称或匹配写法搜索
function listRules(options) {
  const input = options && typeof options === 'object' ? options : {};
  const level = pickText(input.level);
  const status = pickText(input.status);
  const fileType = pickText(input.fileType);
  const keyword = pickText(input.keyword).toLowerCase();
  const data = load();

  let list = data.rules;
  if (level) list = list.filter((item) => item.level === level);
  if (status) list = list.filter((item) => item.status === status);
  if (fileType) list = list.filter((item) => item.fileType === fileType || item.fileType === '全部');
  if (keyword) {
    // 旧编码同样参与搜索：按曾经用过的编码也能找到现在这条规则
    list = list.filter((item) => item.code.toLowerCase().includes(keyword)
      || previousCodesOf(item).some((oldCode) => oldCode.toLowerCase().includes(keyword))
      || item.name.toLowerCase().includes(keyword)
      || item.pattern.toLowerCase().includes(keyword));
  }

  const usedFileTypes = Array.from(new Set(data.rules.map((item) => item.fileType)));
  return {
    rules: sortRules(list),
    levels: LEVELS.slice(),
    statuses: STATUSES.slice(),
    fileTypes: FILE_TYPES.slice(),
    usedFileTypes,
  };
}

function getRule(id) {
  const data = load();
  const found = data.rules.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'RULE_NOT_FOUND', '这条规则不存在或已被删除', '');
  return found;
}

function createRule(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const now = new Date().toISOString();
  const created = {
    id: crypto.randomUUID(),
    code: validateCode(input.code, data, ''),
    name: validateName(input.name),
    level: validateLevel(input.level),
    status: validateStatus(input.status),
    fileType: validateFileType(input.fileType),
    pattern: validatePattern(input.pattern),
    note: validateNote(input.note),
    codeHistory: [],
    createdAt: now,
    updatedAt: now,
  };
  data.rules.push(created);
  save(data);
  return created;
}

function updateRule(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const found = data.rules.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'RULE_NOT_FOUND', '这条规则不存在或已被删除', '');

  const nextCode = input.code === undefined ? found.code : validateCode(input.code, data, found.id);
  // 编码改动：旧编码作为别名留在沿革里，页面与历史引用都还能按旧编码找回这条规则
  if (nextCode.toLowerCase() !== found.code.toLowerCase()) {
    found.codeHistory.push({ from: found.code, to: nextCode, at: new Date().toISOString() });
  }
  found.code = nextCode;
  found.name = input.name === undefined ? found.name : validateName(input.name);
  found.level = input.level === undefined ? found.level : validateLevel(input.level);
  found.status = input.status === undefined ? found.status : validateStatus(input.status);
  found.fileType = input.fileType === undefined ? found.fileType : validateFileType(input.fileType);
  found.pattern = input.pattern === undefined ? found.pattern : validatePattern(input.pattern);
  found.note = input.note === undefined ? found.note : validateNote(input.note);
  found.updatedAt = new Date().toISOString();
  save(data);
  return found;
}

function deleteRule(id) {
  const data = load();
  const index = data.rules.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'RULE_NOT_FOUND', '这条规则不存在或已被删除', '');
  const [removed] = data.rules.splice(index, 1);
  save(data);
  return { id: removed.id, code: removed.code, name: removed.name };
}

module.exports = {
  listRules,
  getRule,
  createRule,
  updateRule,
  deleteRule,
  findRuleByCode,
};
