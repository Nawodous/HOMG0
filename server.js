const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 37788;
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.webm', '.flac']);
const AUDIO_ROOT = path.resolve(PUBLIC_DIR, 'audio');
const BOT_STEP_DELAY = 550;
const BOT_MAX_STEPS_PER_TURN = 100;
const DATA_ROOT = path.join(__dirname, 'data');

function serializeDefinition(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function deserializeDefinition(serialized, label = 'definition') {
  if (serialized && typeof serialized === 'object') return serialized;
  if (typeof serialized !== 'string') throw new Error(`${label} must be JSON text or an object`);
  try {
    const value = JSON.parse(serialized);
    if (!value || typeof value !== 'object') throw new Error('root must be an object or array');
    return value;
  } catch (err) {
    throw new Error(`Invalid serialized ${label}: ${err.message}`);
  }
}

function loadSerializedDefinition(relativePath) {
  const filePath = safeDataPath(relativePath);
  const text = fs.readFileSync(filePath, 'utf8');
  return deserializeDefinition(text, relativePath);
}

function freezeDefinition(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDefinition(child);
  return Object.freeze(value);
}

function parseCoordinate(value) {
  if (typeof value === 'string') {
    const [row, col] = value.split(',').map(Number);
    if (Number.isInteger(row) && Number.isInteger(col)) return { row, col };
  }
  if (value && typeof value === 'object') {
    const row = Number(value.row), col = Number(value.col);
    if (Number.isInteger(row) && Number.isInteger(col)) return { row, col };
  }
  return null;
}

function normalizeBoardDefinition(raw) {
  const board = deserializeDefinition(raw, 'board');
  if (!Array.isArray(board.rows) || !board.rows.length) throw new Error('board.rows must be a non-empty array');
  const rows = board.rows.map(row => ({
    id: Number(row.id),
    top: Number(row.top) || 0,
    cells: Array.isArray(row.cells) ? row.cells.map(cell => ({
      col: Number(cell.col),
      displayCol: String(cell.displayCol ?? Number(cell.col) + 1),
      terrain: String(cell.terrain || '')
    })).filter(cell => Number.isInteger(cell.col)) : []
  })).filter(row => Number.isInteger(row.id) && row.cells.length);
  if (!rows.length) throw new Error('board.rows contains no valid rows');

  const edges = [];
  const seenEdges = new Set();
  const addEdge = (fromValue, toValue, type = 'adjacent', style = null) => {
    const from = parseCoordinate(fromValue), to = parseCoordinate(toValue);
    if (!from || !to || (from.row === to.row && from.col === to.col)) return;
    const left = `${from.row},${from.col}`, right = `${to.row},${to.col}`;
    const edgeId = [left, right].sort().join('|');
    if (seenEdges.has(edgeId)) return;
    seenEdges.add(edgeId);
    edges.push({ from, to, type: String(type || 'adjacent').slice(0, 32), style: style && typeof style === 'object' ? { ...style } : null });
  };
  if (Array.isArray(board.connections)) {
    for (const edge of board.connections) addEdge(edge?.from, edge?.to, edge?.type, edge?.style);
  } else if (board.connections && typeof board.connections === 'object') {
    for (const [from, targets] of Object.entries(board.connections)) {
      if (!Array.isArray(targets)) continue;
      for (const target of targets) addEdge(from, target);
    }
  }
  return freezeDefinition({
    schemaVersion: Number(board.schemaVersion) || 1,
    id: String(board.id || 'classic'),
    name: String(board.name || board.id || '棋盘'),
    width: Number(board.width) || 790,
    height: Number(board.height) || 720,
    gridInset: board.gridInset || {},
    cellSize: board.cellSize || {},
    gap: Number(board.gap) || 0,
    deploymentRows: board.deploymentRows || {},
    rows,
    connections: edges
  });
}

function normalizeUnitsDefinition(raw) {
  const source = deserializeDefinition(raw, 'units');
  const units = source.units && typeof source.units === 'object' ? source.units : source;
  const out = {};
  for (const [id, value] of Object.entries(units)) {
    if (!/^[a-zA-Z0-9_-]{1,48}$/.test(id) || !value || typeof value !== 'object') continue;
    out[id] = {
      name: String(value.name || id), short: String(value.short || '?'),
      move: Number(value.move) || 1, range: Number(value.range) || 1,
      maxMoveSteps: Number(value.maxMoveSteps) || Number(value.move) || 1,
      icon: String(value.icon || ''),
      immuneFrom: Array.isArray(value.immuneFrom) ? value.immuneFrom.map(String) : [],
      allowedPlayers: Array.isArray(value.allowedPlayers) ? value.allowedPlayers.map(String) : ['attacker', 'defender'],
      actionRules: value.actionRules && typeof value.actionRules === 'object' ? { ...value.actionRules } : {},
      deployLimit: value.deployLimit && typeof value.deployLimit === 'object' ? { ...value.deployLimit } : {},
      ai: value.ai && typeof value.ai === 'object' ? { ...value.ai } : {}
    };
  }
  if (!Object.keys(out).length) throw new Error('units contains no valid unit definitions');
  return freezeDefinition(out);
}

function normalizeRulesDefinition(raw, units) {
  const source = deserializeDefinition(raw, 'rules');
  const terrain = source.terrain && typeof source.terrain === 'object' ? source.terrain : {};
  const normalizedTerrain = {};
  for (const [id, value] of Object.entries(terrain)) {
    if (!/^[a-zA-Z0-9_-]{1,48}$/.test(id) || !value || typeof value !== 'object') continue;
    normalizedTerrain[id] = {
      name: String(value.name || id),
      passableUnits: Array.isArray(value.passableUnits) ? value.passableUnits.map(String).filter(type => units[type]) : [],
      color: String(value.color || ''), borderColor: String(value.borderColor || ''), symbol: String(value.symbol || ''),
      attackImmuneFrom: Array.isArray(value.attackImmuneFrom) ? value.attackImmuneFrom.map(String).filter(type => units[type]) : [],
      specialEntry: value.specialEntry && typeof value.specialEntry === 'object'
        ? JSON.parse(JSON.stringify(value.specialEntry))
        : (value.specialEntry ? String(value.specialEntry) : null)
    };
  }
  if (!Object.keys(normalizedTerrain).length) throw new Error('rules.terrain contains no valid terrain definitions');
  return freezeDefinition({
    schemaVersion: Number(source.schemaVersion) || 1,
    id: String(source.id || 'classic'), version: Number(source.version) || 1,
    units, terrain: normalizedTerrain,
    combat: source.combat || {}, turn: source.turn || {}, victory: source.victory || {},
    configDefaults: source.configDefaults || {}, ai: source.ai || {}, ui: source.ui || {}
  });
}

function collectAudioFiles(dir, prefix = '') {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    console.error(`[AUDIO] Cannot read directory: ${dir}`, err);
    return [];
  }

  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...collectAudioFiles(full, rel));
    } else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      // URL 编码每一段，兼容空格、中文等 Linux/Windows 都合法的文件名。
      const urlPath = rel.split('/').map(encodeURIComponent).join('/');
      out.push(`/audio/${urlPath}`);
    }
  }
  return out.sort();
}


const FALLBACK_CONFIG = {
  reinforcement: 28,
  attackerMax: { infantry: 5, antiTank: 1, machineGun: 1 },
  defenderMax: { infantry: 4, antiTank: 1, machineGun: 0 },
  allowDeployAfterAction: true
};

function safeDataPath(relativePath) {
  const value = String(relativePath || '').replace(/\\/g, '/');
  const full = path.resolve(DATA_ROOT, value);
  if (full !== DATA_ROOT && !full.startsWith(DATA_ROOT + path.sep)) throw new Error('definition path escapes data directory');
  return full;
}

function normalizeVariantCatalog(raw) {
  const source = deserializeDefinition(raw, 'variants');
  const entries = source.variants && typeof source.variants === 'object' ? source.variants : source;
  const out = {};
  for (const [id, value] of Object.entries(entries)) {
    if (!/^[a-zA-Z0-9_-]{1,48}$/.test(id) || !value || typeof value !== 'object') continue;
    if (!value.board || !value.units || !value.rules) continue;
    out[id] = {
      id, name: String(value.name || id), category: String(value.category || 'battle'),
      enabled: value.enabled !== false, engine: String(value.engine || id),
      supportsAi: value.supportsAi === true,
      boardPath: String(value.board), unitsPath: String(value.units), rulesPath: String(value.rules)
    };
  }
  if (!Object.keys(out).length) throw new Error('variants contains no valid entries');
  return freezeDefinition(out);
}

const VARIANT_CATALOG = normalizeVariantCatalog(loadSerializedDefinition('variants.json'));
const VARIANT_DEFINITIONS = {};
const BOARD_DEFINITIONS = {};
for (const [id, variant] of Object.entries(VARIANT_CATALOG)) {
  if (!variant.enabled) continue;
  try {
    const units = normalizeUnitsDefinition(loadSerializedDefinition(variant.unitsPath));
    const rules = normalizeRulesDefinition(loadSerializedDefinition(variant.rulesPath), units);
    const board = normalizeBoardDefinition(loadSerializedDefinition(variant.boardPath));
    const runtimeVariant = freezeDefinition({ ...variant, boardId: board.id });
    VARIANT_DEFINITIONS[id] = freezeDefinition({ variant: runtimeVariant, board, units, rules });
    BOARD_DEFINITIONS[board.id] = board;
  } catch (err) {
    console.error(`[DEFINITIONS] Skipping variant ${id}:`, err.message);
  }
}
if (!VARIANT_DEFINITIONS.classic) throw new Error('classic variant definitions are required');
const GAME_VARIANTS = freezeDefinition(Object.fromEntries(Object.entries(VARIANT_DEFINITIONS).map(([id, value]) => [id, value.variant])));
const UNIT_DEFINITIONS = VARIANT_DEFINITIONS.classic.units;
const RULE_DEFINITIONS = VARIANT_DEFINITIONS.classic.rules;
const TYPES = UNIT_DEFINITIONS;
const TERRAIN_RULES = RULE_DEFINITIONS.terrain;
const GAME_RULES = RULE_DEFINITIONS;
const DEFAULT_CONFIG = freezeDefinition({
  reinforcement: Number(RULE_DEFINITIONS.configDefaults?.reinforcement) || FALLBACK_CONFIG.reinforcement,
  attackerMax: Object.fromEntries(Object.entries(UNIT_DEFINITIONS).map(([type, unit]) => [type, Number(unit.deployLimit?.attacker) || 0])),
  defenderMax: Object.fromEntries(Object.entries(UNIT_DEFINITIONS).map(([type, unit]) => [type, Number(unit.deployLimit?.defender) || 0])),
  allowDeployAfterAction: RULE_DEFINITIONS.configDefaults?.allowDeployAfterAction !== false
});

function normalizeVariantId(value) {
  return Object.hasOwn(VARIANT_DEFINITIONS, value) ? value : 'classic';
}

function boardForVariant(variantId) {
  return VARIANT_DEFINITIONS[normalizeVariantId(variantId)]?.board || VARIANT_DEFINITIONS.classic.board;
}

function definitionsForVariant(variantId) {
  const normalized = normalizeVariantId(variantId);
  const definitions = VARIANT_DEFINITIONS[normalized] || VARIANT_DEFINITIONS.classic;
  return {
    variantId: normalized,
    variant: definitions.variant,
    board: definitions.board,
    units: definitions.units,
    rules: definitions.rules
  };
}

function variantCatalogForClient() {
  return Object.values(VARIANT_DEFINITIONS).map(definitions => ({
    id: definitions.variant.id,
    name: definitions.variant.name,
    category: definitions.variant.category,
    engine: definitions.variant.engine,
    supportsAi: definitions.variant.supportsAi,
    units: definitions.units,
    defaults: defaultConfigForVariant(definitions.variant.id),
    ui: definitions.rules.ui || {}
  }));
}

function deploymentRowFor(g, player) {
  const board = BOARD_DEFINITIONS[g?.boardId] || boardForVariant(g?.variantId);
  return board.deploymentRows?.[player] ?? (player === 'attacker' ? 6 : 1);
}

const rooms = new Map();
let nextRoomNumber = 1;

function key(r, c) { return `${r},${c}`; }
function unique(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = x.join(',');
    if (!seen.has(k)) { seen.add(k); out.push(x); }
  }
  return out;
}

function boardDefinition(boardId = 'classic') {
  return BOARD_DEFINITIONS[boardId] || BOARD_DEFINITIONS.classic;
}

function validCell(row, col, boardId = 'classic') {
  return boardDefinition(boardId).rows.some(item => item.id === row && item.cells.some(cell => cell.col === col));
}

function terrainIdAt(row, col, boardId = 'classic') {
  const rowDef = boardDefinition(boardId).rows.find(item => item.id === row);
  return rowDef?.cells.find(cell => cell.col === col)?.terrain || '';
}

function terrainAt(row, col, boardId = 'classic') {
  return terrainIdAt(row, col, boardId);
}

function unitDefinition(type, g = null) {
  if (g?.rules?.units) return g.rules.units[type] || null;
  return TYPES[type] || null;
}

function terrainRuleFor(g, row, col) {
  if (g?.rules?.terrain) return g.rules.terrain[terrainIdAt(row, col, g.boardId)] || null;
  return TERRAIN_RULES[terrainIdAt(row, col, g?.boardId || 'classic')] || null;
}

function isInstantKill(g, attacker, target) {
  const rule = g.rules?.combat?.instantKill;
  if (!rule || !Array.isArray(rule.attackerTypes) || !Array.isArray(rule.targetTypes)) return false;
  if (!rule.attackerTypes.includes(attacker.type) || !rule.targetTypes.includes(target.type)) return false;
  return !Array.isArray(rule.terrainTypes)
    || rule.terrainTypes.length === 0
    || rule.terrainTypes.includes(terrainIdAt(target.row, target.col, g.boardId));
}

/*
 * 几何坐标：普通行列中心为 1,2,3,4,5；第5行中心为 1.5,2.5,3.5,4.5。
 * 因此：
 *   第5行 c -> 上方第4行 c-1、c；下方第6行 c-1、c
 *   第6行 col -> 第5行 col、col+1
 * 这里特别修正了原代码的第6行邻接错误。
 */
function neighbors(row, col, boardId = 'classic') {
  const result = [];
  for (const edge of boardDefinition(boardId).connections || []) {
    if (edge.from.row === row && edge.from.col === col) result.push([edge.to.row, edge.to.col]);
    if (edge.to.row === row && edge.to.col === col) result.push([edge.from.row, edge.from.col]);
  }
  return unique(result.filter(([r, c]) => validCell(r, c, boardId)));
}

function bfs(row, col, maxDistance, boardId = 'classic') {
  const dist = new Map([[key(row, col), 0]]);
  const q = [[row, col, 0]];
  for (let i = 0; i < q.length; i++) {
    const [r, c, d] = q[i];
    if (d >= maxDistance) continue;
    for (const [nr, nc] of neighbors(r, c, boardId)) {
      const k = key(nr, nc);
      if (!dist.has(k)) {
        dist.set(k, d + 1);
        q.push([nr, nc, d + 1]);
      }
    }
  }
  dist.delete(key(row, col));
  return dist;
}

function newGame(config, hostRole, requestedVariantId = 'classic') {
  const variantId = normalizeVariantId(requestedVariantId);
  const definitions = definitionsForVariant(variantId);
  const board = definitions.board;
  return {
    round: 1,
    currentPlayer: 'attacker',
    attackerReinforcement: config.reinforcement,
    nextUnitId: 1,
    units: [],
    state: 'waiting',
    winner: null,
    log: [],
    config,
    rules: definitions.rules,
    players: { attacker: null, defender: null },
    spectators: new Set(),
    started: false,
    lastEvent: null,
    lastChat: { attacker: '', defender: '' },
    gameMode: 'pvp',
    variantId,
    boardId: board.id,
    botRole: null,
    botDifficulty: 'normal',
    winnerReason: null
  };
}

function unitAt(g, row, col) { return g.units.find(u => u.row === row && u.col === col); }
function getUnit(g, id) { return g.units.find(u => u.id === id); }
function alive(g, player) { return g.units.filter(u => !player || u.player === player); }
function countType(g, player, type) { return alive(g, player).filter(u => u.type === type).length; }

function addLog(g, text) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  g.log.push(`[${t}] ${text}`);
  if (g.log.length > 120) g.log.shift();
}

function setEvent(g, event) { g.lastEvent = { ...event, at: Date.now() }; }

function createUnit(g, player, type, row, col) {
  const u = {
    id: g.nextUnitId++, player, type, row, col,
    hits: 0,
    moved: false,
    shot: false,
    moveSteps: 0,
    lastShotTarget: null,
    canAct: false,
    deployedRound: g.round,
    turnActionStarted: false
  };
  g.units.push(u);
  return u;
}

function canEnterTerrain(g, unit, row, col) {
  const rule = terrainRuleFor(g, row, col);
  return !!rule?.passableUnits?.includes(unit.type);
}

function stairsEntryAllowed(g, unit, tr, tc) {
  const specialEntry = terrainRuleFor(g, tr, tc)?.specialEntry;
  if (!specialEntry) return true;
  if (typeof specialEntry === 'string') {
    if (specialEntry !== 'infantry-row4-to-row3' || unit.type !== 'infantry' || unit.row !== 4 || tr !== 3) return true;
    return !unit.shot || !!unit.lastShotTarget && unit.lastShotTarget.row === tr && unit.lastShotTarget.col === tc;
  }
  if (specialEntry.unitType && specialEntry.unitType !== unit.type) return true;
  if (Number.isInteger(Number(specialEntry.fromRow)) && Number(specialEntry.fromRow) !== unit.row) return true;
  if (Number.isInteger(Number(specialEntry.toRow)) && Number(specialEntry.toRow) !== tr) return true;
  if (specialEntry.requiresShotTarget !== true || !unit.shot) return true;
  return !!unit.lastShotTarget && unit.lastShotTarget.row === tr && unit.lastShotTarget.col === tc;
}

function legalPath(g, unit, tr, tc, maxSteps) {
  const start = key(unit.row, unit.col);
  const dist = new Map([[start, 0]]);
  const q = [[unit.row, unit.col, 0, []]];
  for (let i = 0; i < q.length; i++) {
    const [r, c, d, path] = q[i];
    if (r === tr && c === tc) return path;
    if (d >= maxSteps) continue;
    for (const [nr, nc] of neighbors(r, c, g.boardId)) {
      if (unitAt(g, nr, nc)) continue;
      if (!canEnterTerrain(g, unit, nr, nc)) continue;
      if (!stairsEntryAllowed(g, unit, nr, nc)) continue;
      const k = key(nr, nc);
      if (dist.has(k)) continue;
      dist.set(k, d + 1);
      q.push([nr, nc, d + 1, path.concat([[nr, nc]])]);
    }
  }
  return null;
}

function moveTargets(g, unit) {
  if (!unit.canAct) return [];
  const actionRules = unitDefinition(unit.type, g)?.actionRules || {};
  if (unit.shot && actionRules.canMoveAfterShot === false) return [];
  if (unit.moved && actionRules.maxMoveActions === 1) return [];
  const maxMoveSteps = Number(unitDefinition(unit.type, g)?.maxMoveSteps) || 1;
  const remaining = maxMoveSteps - (unit.moveSteps || 0);
  if (remaining <= 0) return [];

  const out = [];
  for (const [cellKey] of bfs(unit.row, unit.col, remaining, g.boardId)) {
    const [r, c] = cellKey.split(',').map(Number);
    if (unitAt(g, r, c)) continue;
    const path = legalPath(g, unit, r, c, remaining);
    if (!path) continue;
    out.push({ row: r, col: c, distance: path.length });
  }
  return out;
}

function shootTargets(g, unit) {
  if (!unit.canAct || unit.shot) return [];
  if (unit.moved && unitDefinition(unit.type, g)?.actionRules?.canShootAfterMove === false) return [];
  const out = [];
  for (const [cellKey] of bfs(unit.row, unit.col, Number(unitDefinition(unit.type, g)?.range) || 1, g.boardId)) {
    const [r, c] = cellKey.split(',').map(Number);
    const target = unitAt(g, r, c);
    if (target && target.player !== unit.player) out.push(target);
  }
  return out;
}

function immune(g, target, attacker) {
  if (unitDefinition(target.type, g)?.immuneFrom?.includes(attacker.type)) return true;
  const terrainRule = terrainRuleFor(g, target.row, target.col);
  if (terrainRule?.attackImmuneFrom?.includes(attacker.type)) return true;
  return false;
}

function finishAction(g, u) {
  const definition = unitDefinition(u.type, g);
  const endWhen = definition?.actionRules?.endWhen;
  if (endWhen === 'movedOrShot' && (u.moved || u.shot)) u.canAct = false;
  if (endWhen === 'movedAndShot' && u.moved && u.shot) u.canAct = false;
  if (endWhen === 'maxMoveStepsAndShot' && u.moveSteps >= (definition?.maxMoveSteps || 1) && u.shot) u.canAct = false;
}

function resetTurnForCurrentPlayer(g) {
  for (const u of g.units) {
    u.hits = 0;
    u.moved = false;
    u.shot = false;
    u.moveSteps = 0;
    u.lastShotTarget = null;
    u.turnActionStarted = false;
    if (u.player === g.currentPlayer) {
      u.canAct = u.deployedRound === g.round ? false : true;
    } else {
      u.canAct = false;
    }
  }
}

function checkEnd(g) {
  const attackerTargetRow = Number(g.rules?.victory?.attackerTargetRow) || 1;
  const a1 = g.units.find(u => u.player === 'attacker' && u.row === attackerTargetRow);
  if (a1) {
    g.state = 'ended';
    g.winner = 'attacker';
    g.winnerReason = 'attacker_reached_first_row';
    addLog(g, `进攻方 ${unitDefinition(a1.type, g)?.name || a1.type}#${a1.id} 到达目标行，进攻方胜利。`);
    setEvent(g, { type: 'win', winner: 'attacker', unitId: a1.id });
    return true;
  }
  if (g.attackerReinforcement === 0 && alive(g, 'attacker').length === 0) {
    g.state = 'ended';
    g.winner = 'defender';
    g.winnerReason = 'attacker_eliminated';
    addLog(g, '进攻方增援耗尽且场上全灭，防守方胜利。');
    setEvent(g, { type: 'win', winner: 'defender' });
    return true;
  }
  return false;
}

function deploy(g, player, type, row, col) {
  if (g.state !== 'playing') throw new Error('游戏尚未开始或已经结束');
  if (g.currentPlayer !== player) throw new Error('尚未轮到你');
  if (!unitDefinition(type, g)) throw new Error('未知兵种');
  const targetRow = deploymentRowFor(g, player);
  if (row !== targetRow) throw new Error(`只能部署在第${targetRow}行`);
  if (!validCell(row, col, g.boardId)) throw new Error('无效格子');
  if (unitAt(g, row, col)) throw new Error('该位置已有单位');
  if (!unitDefinition(type)?.allowedPlayers?.includes(player)) throw new Error('该阵营不能部署此兵种');
  const max = g.config[player === 'attacker' ? 'attackerMax' : 'defenderMax'][type] ?? 0;
  if (countType(g, player, type) >= max) throw new Error('该兵种已达到房主设置的上限');
  if (player === 'attacker' && g.attackerReinforcement <= 0) throw new Error('增援已经耗尽');
  if (!g.config.allowDeployAfterAction && g.units.some(u => u.player === player && u.turnActionStarted)) {
    const err = new Error('当前房间未允许行动后部署单位。');
    err.code = 'DEPLOY_AFTER_ACTION';
    throw err;
  }

  const u = createUnit(g, player, type, row, col);
  if (player === 'attacker') g.attackerReinforcement--;
  addLog(g, `${player === 'attacker' ? '进攻方' : '防守方'}部署${unitDefinition(type, g)?.name || type}#${u.id}。`);
  setEvent(g, { type: 'deploy', unitId: u.id });
}

function move(g, player, id, row, col) {
  const u = getUnit(g, id);
  if (!u || u.player !== player) throw new Error('单位不存在或不是你的单位');
  if (g.currentPlayer !== player) throw new Error('尚未轮到你');
  if (g.state !== 'playing' || !u.canAct) throw new Error('该单位当前不能行动');

  const target = moveTargets(g, u).find(x => x.row === row && x.col === col);
  if (!target) throw new Error('不可移动到该位置');

  const from = { row: u.row, col: u.col };
  u.row = row;
  u.col = col;
  u.moved = true;
  u.turnActionStarted = true;
  u.moveSteps += target.distance;

  addLog(g, `${player === 'attacker' ? '进攻方' : '防守方'}${unitDefinition(u.type, g)?.name || u.type}#${u.id}移动到(${row},${displayCol(row, col, g.boardId)})。`);
  setEvent(g, { type: 'move', unitId: u.id, unitType: u.type, from, to: { row, col }, distance: target.distance });

  const attackerTargetRow = Number(g.rules?.victory?.attackerTargetRow) || 1;
  if (player === 'attacker' && row === attackerTargetRow) { checkEnd(g); return; }
  finishAction(g, u);
}

function shoot(g, player, id, targetId) {
  const a = getUnit(g, id), t = getUnit(g, targetId);
  if (!a || !t || a.player !== player || t.player === player) throw new Error('射击目标无效');
  if (g.currentPlayer !== player) throw new Error('尚未轮到你');
  if (g.state !== 'playing' || !a.canAct || a.shot) throw new Error('该单位当前不能射击');
  if (!shootTargets(g, a).some(x => x.id === t.id)) throw new Error('目标不在射程内');

  a.shot = true;
  a.turnActionStarted = true;
  a.lastShotTarget = { row: t.row, col: t.col };

  if (immune(g, t, a)) {
    addLog(g, `${unitDefinition(a.type, g)?.name || a.type}#${a.id}射击${unitDefinition(t.type, g)?.name || t.type}#${t.id}，未造成伤害。`);
    setEvent(g, { type: 'shoot', attackerId: a.id, attackerType: a.type, targetId: t.id, targetType: t.type, result: 'immune', from: { row: a.row, col: a.col }, targetPos: { row: t.row, col: t.col } });
    finishAction(g, a);
    return;
  }

  if (isInstantKill(g, a, t)) {
    addLog(g, `${unitDefinition(a.type, g)?.name || a.type}#${a.id}击毁${unitDefinition(t.type, g)?.name || t.type}#${t.id}。`);
    const deadUnit = { ...t };
    g.units = g.units.filter(x => x.id !== t.id);
    setEvent(g, { type: 'kill', attackerId: a.id, attackerType: a.type, targetId: t.id, targetType: t.type, reason: g.rules?.combat?.instantKill?.reason || 'instant_kill', from: { row: a.row, col: a.col }, targetPos: { row: t.row, col: t.col }, deadUnit });
    finishAction(g, a);
    checkEnd(g);
    return;
  }

  t.hits++;
  const hitsToDestroy = Number(g.rules?.combat?.hitsToDestroy) || 2;
  addLog(g, `${unitDefinition(a.type, g)?.name || a.type}#${a.id}命中${unitDefinition(t.type, g)?.name || t.type}#${t.id}，受击${t.hits}/${hitsToDestroy}。`);
  if (t.hits >= hitsToDestroy) {
    const deadUnit = { ...t };
    g.units = g.units.filter(x => x.id !== t.id);
    addLog(g, `${unitDefinition(t.type, g)?.name || t.type}#${t.id}被击杀。`);
    setEvent(g, { type: 'kill', attackerId: a.id, attackerType: a.type, targetId: t.id, targetType: t.type, reason: 'twoHits', from: { row: a.row, col: a.col }, targetPos: { row: t.row, col: t.col }, deadUnit });
  } else {
    setEvent(g, { type: 'hit', attackerId: a.id, attackerType: a.type, targetId: t.id, targetType: t.type, hits: t.hits, from: { row: a.row, col: a.col }, targetPos: { row: t.row, col: t.col } });
  }
  finishAction(g, a);
  checkEnd(g);
}

function endUnit(g, player, id) {
  const u = getUnit(g, id);
  if (!u || u.player !== player) throw new Error('单位不存在');
  if (g.currentPlayer !== player) throw new Error('尚未轮到你');
  if (!u.canAct) return;
  u.canAct = false;
  u.turnActionStarted = true;
  addLog(g, `${unitDefinition(u.type, g)?.name || u.type}#${u.id}主动结束本回合行动。`);
  setEvent(g, { type: 'endUnit', unitId: u.id });
}

function endTurn(g, player) {
  if (g.currentPlayer !== player) throw new Error('尚未轮到你');
  if (g.state !== 'playing') throw new Error('游戏已结束');
  addLog(g, `${player === 'attacker' ? '进攻方' : '防守方'}结束回合。`);

  g.currentPlayer = player === 'attacker' ? 'defender' : 'attacker';
  if (g.currentPlayer === 'attacker') g.round++;
  resetTurnForCurrentPlayer(g);
  g.lastEvent = null;
  checkEnd(g);
  if (g.state === 'playing') addLog(g, `${g.currentPlayer === 'attacker' ? '进攻方' : '防守方'}开始第${g.round}回合。`);
}

function displayCol(row, col, boardId = 'classic') {
  const cell = boardDefinition(boardId).rows.find(item => item.id === row)?.cells.find(item => item.col === col);
  return cell?.displayCol ?? String(col + 1);
}

function publicState(g, you) {
  const youUnits = g.units.filter(u => u.player === you).map(u => ({
    ...u,
    legalMoves: moveTargets(g, u),
    legalShots: shootTargets(g, u).map(t => t.id)
  }));
  return {
    round: g.round,
    currentPlayer: g.currentPlayer,
    attackerReinforcement: g.attackerReinforcement,
    units: g.units,
    myUnits: youUnits,
    state: g.state,
    winner: g.winner,
    winnerReason: g.winnerReason,
    log: g.log,
    started: g.started,
    config: g.config,
    rules: g.rules || GAME_RULES,
    players: { attacker: !!g.players.attacker, defender: !!g.players.defender },
    you,
    roomPlayerCount: (g.players.attacker ? 1 : 0) + (g.players.defender ? 1 : 0),
    roomName: g.roomName || null,
    lastEvent: g.lastEvent,
    gameMode: g.gameMode,
    variantId: g.variantId,
    variant: GAME_VARIANTS[g.variantId] || GAME_VARIANTS.classic,
    boardId: g.boardId,
    board: BOARD_DEFINITIONS[g.boardId] || boardForVariant(g.variantId),
    botRole: g.botRole,
    botDifficulty: g.botDifficulty
  };
}

function lobbySnapshot() {
  return Array.from(rooms.values())
    .filter(room => room.game.state !== 'ended')
    .map(room => ({
      id: room.id,
      name: room.name,
      hostRole: room.hostRole,
      gameMode: room.gameMode,
      variantId: room.variantId,
      variant: GAME_VARIANTS[room.variantId] || GAME_VARIANTS.classic,
      boardId: room.game.boardId,
      botDifficulty: room.botDifficulty,
      status: room.game.started ? 'playing' : 'waiting',
      playerCount: (room.game.players.attacker ? 1 : 0) + (room.game.players.defender ? 1 : 0),
      spectatorCount: room.game.spectators ? room.game.spectators.size : 0,
      config: room.game.config
    }));
}

function broadcastLobby() {
  const data = { type: 'lobby', rooms: lobbySnapshot() };
  for (const client of wss.clients) send(client, data);
}

function send(ws, obj) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function broadcast(room) {
  for (const role of ['attacker', 'defender']) {
    const p = room.players[role];
    if (p) send(p, { type: 'state', state: publicState(room.game, role) });
  }
  if (room.game.spectators) {
    for (const spectator of room.game.spectators) {
      send(spectator, { type: 'state', state: publicState(room.game, 'spectator') });
    }
  }
}

function defaultConfigForVariant(variantId = 'classic') {
  const units = definitionsForVariant(variantId).units;
  const attackerMax = {}, defenderMax = {};
  for (const [type, definition] of Object.entries(units)) {
    const defaults = definition.deployLimit || {};
    attackerMax[type] = Number.isFinite(Number(defaults.attacker)) ? Number(defaults.attacker) : 0;
    defenderMax[type] = Number.isFinite(Number(defaults.defender)) ? Number(defaults.defender) : 0;
  }
  if (variantId === 'classic') {
    Object.assign(attackerMax, DEFAULT_CONFIG.attackerMax);
    Object.assign(defenderMax, DEFAULT_CONFIG.defenderMax);
  }
  return { reinforcement: DEFAULT_CONFIG.reinforcement, attackerMax, defenderMax, allowDeployAfterAction: DEFAULT_CONFIG.allowDeployAfterAction };
}

function sanitizeConfig(raw = {}, variantId = 'classic') {
  const num = (v, min, max, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : d;
  };
  const defaults = defaultConfigForVariant(variantId);
  const units = definitionsForVariant(variantId).units;
  const legacyNames = { attacker: 'attacker', defender: 'defender' };
  const maxUnits = raw.maxUnits && typeof raw.maxUnits === 'object' ? raw.maxUnits : {};
  const buildLimits = player => Object.fromEntries(Object.entries(units).map(([type], index) => {
    const legacyKey = `${legacyNames[player]}${type[0].toUpperCase()}${type.slice(1)}`;
    const legacyValue = raw[legacyKey];
    const source = maxUnits[player]?.[type] ?? legacyValue;
    return [type, num(source, 0, 999, defaults[player === 'attacker' ? 'attackerMax' : 'defenderMax'][type] ?? 0)];
  }));
  return {
    reinforcement: num(raw.reinforcement, 0, 999999, defaults.reinforcement),
    attackerMax: buildLimits('attacker'),
    defenderMax: buildLimits('defender'),
    allowDeployAfterAction: raw.allowDeployAfterAction == null
      ? defaults.allowDeployAfterAction
      : raw.allowDeployAfterAction === true
  };
}

function randomChoice(items) {
  return items.length ? items[Math.floor(Math.random() * items.length)] : null;
}

const BOT_PROFILES = {
  easy: { topChoices: 4, dangerWeight: 0.25, mobilityWeight: 0.5 },
  normal: { topChoices: 2, dangerWeight: 0.75, mobilityWeight: 1 },
  hard: { topChoices: 1, dangerWeight: 1.2, mobilityWeight: 1.25 }
};

function normalizeBotDifficulty(value) {
  return Object.hasOwn(BOT_PROFILES, value) ? value : 'normal';
}

function opponentOf(player) {
  return player === 'attacker' ? 'defender' : 'attacker';
}

function graphDistance(fromRow, fromCol, toRow, toCol, boardId = 'classic') {
  if (fromRow === toRow && fromCol === toCol) return 0;
  return bfs(fromRow, fromCol, 12, boardId).get(key(toRow, toCol)) ?? 99;
}

function unitValue(type, g = null) {
  return Number(unitDefinition(type, g)?.ai?.value) || 1;
}

function aiCombatBonus(g, attacker, target, row, col) {
  const attackerRole = unitDefinition(attacker.type, g)?.ai?.role;
  const targetRole = unitDefinition(target.type, g)?.ai?.role;
  const terrain = terrainAt(row, col, g.boardId);
  return (Array.isArray(g.rules?.ai?.combatBonuses) ? g.rules.ai.combatBonuses : [])
    .filter(rule => (!rule.attackerRole || rule.attackerRole === attackerRole)
      && (!rule.targetRole || rule.targetRole === targetRole)
      && (!rule.terrain || rule.terrain === terrain))
    .reduce((sum, rule) => sum + (Number(rule.score) || 0), 0);
}

function canDamageAt(g, attacker, targetType, row, col) {
  if (unitDefinition(targetType, g)?.immuneFrom?.includes(attacker.type)) return false;
  if (terrainRuleFor(g, row, col)?.attackImmuneFrom?.includes(attacker.type)) return false;
  return true;
}

function shotWouldKill(g, attacker, target) {
  if (!canDamageAt(g, attacker, target.type, target.row, target.col)) return false;
  if (isInstantKill(g, attacker, target)) return true;
  return target.hits >= (Number(g.rules?.combat?.hitsToDestroy) || 2) - 1;
}

function chooseRanked(items, difficulty) {
  if (!items.length) return null;
  const profile = BOT_PROFILES[normalizeBotDifficulty(difficulty)];
  const ranked = [...items].sort((a, b) => b.score - a.score);
  const bestScore = ranked[0].score;
  const nearBest = ranked.filter(item => item.score >= bestScore - (difficulty === 'easy' ? 80 : 12));
  return randomChoice(nearBest.slice(0, profile.topChoices));
}

function botDeployChoices(g, player) {
  if (player === 'attacker' && g.attackerReinforcement <= 0) return [];
  const row = deploymentRowFor(g, player);
  const rowDef = boardDefinition(g.boardId).rows.find(item => item.id === row);
  const emptyCols = (rowDef?.cells || []).map(cell => cell.col).filter(col => !unitAt(g, row, col));
  if (!emptyCols.length) return [];

  const maxima = g.config[player === 'attacker' ? 'attackerMax' : 'defenderMax'];
  const enemies = alive(g, opponentOf(player));
  const aiRules = g.rules?.ai || {};
  const roleBonuses = aiRules.roleBonuses || {};
  return Object.keys(g.rules?.units || {}).flatMap(type => {
    if (!unitDefinition(type, g)?.allowedPlayers?.includes(player)) return [];
    if (countType(g, player, type) >= (maxima[type] ?? 0)) return [];
    return emptyCols.map(col => {
      let score = unitValue(type, g) + 15;
      score -= countType(g, player, type) * 9;
      score += 10 - Math.abs(col - 2) * 4;
      if (unitDefinition(type, g)?.ai?.role === 'antiTank') score += enemies.reduce((sum, enemy) => sum + aiCombatBonus(g, { type }, enemy, enemy.row, enemy.col), 0);
      if (unitDefinition(type, g)?.ai?.role === 'machineGun' && !enemies.some(u => unitDefinition(u.type, g)?.ai?.role === 'antiTank')) score += Number(roleBonuses.machineGunWithoutAntiTank ?? 0);
      if (enemies.length) {
        const nearestDistance = Math.min(...enemies.map(u => graphDistance(row, col, u.row, u.col, g.boardId)));
        score -= nearestDistance * 3;
      }
      return { type, row, col, score };
    });
  });
}

function chooseBotDeployment(g, player, difficulty) {
  return chooseRanked(botDeployChoices(g, player), difficulty);
}

function threatAt(g, unit, row, col) {
  let threat = 0;
  for (const enemy of alive(g, opponentOf(unit.player))) {
    if (graphDistance(enemy.row, enemy.col, row, col, g.boardId) > (Number(unitDefinition(enemy.type, g)?.range) || 1)) continue;
    if (!canDamageAt(g, enemy, unit.type, row, col)) continue;
    threat += Math.max(0, aiCombatBonus(g, enemy, unit, row, col)) + (unit.hits > 0 ? 85 : 48);
  }
  return threat;
}

function defensiveBlockValue(g, row, col) {
  const targetRow = Number(g.rules?.victory?.attackerTargetRow);
  if (!Number.isInteger(targetRow) || row !== targetRow) return 0;
  let value = 0;
  for (const attacker of alive(g, 'attacker')) {
    if (neighbors(attacker.row, attacker.col, g.boardId).some(([r, c]) => r === row && c === col)) value += 800;
  }
  return value;
}

function scoreShot(g, attacker, target) {
  if (!canDamageAt(g, attacker, target.type, target.row, target.col)) {
    return { score: -900, priority: 'none' };
  }

  const kill = shotWouldKill(g, attacker, target);
  let score = 95 + unitValue(target.type, g);
  if (target.hits > 0) score += 125;
  if (kill) score += 560 + unitValue(target.type, g) * 2;
  if (target.player === 'attacker') {
    const targetRowScores = g.rules?.ai?.targetRowScores || {};
    score += Number(targetRowScores[String(target.row)] || 0);
  }
  score += aiCombatBonus(g, attacker, target, target.row, target.col);
  return { score, priority: kill ? 'kill' : 'hit' };
}

function scoreMove(g, unit, target, difficulty) {
  const profile = BOT_PROFILES[normalizeBotDifficulty(difficulty)];
  const enemies = alive(g, opponentOf(unit.player));
  let score = -target.distance * 2;

  if (unit.player === 'attacker') {
    const attackerTargetRow = Number(g.rules?.victory?.attackerTargetRow) || 1;
    if (target.row === attackerTargetRow) return { score: 100000, priority: 'win' };
    score += (unit.row - target.row) * 62;
    score += (Math.max(...boardDefinition(g.boardId).rows.map(row => row.id)) - target.row) * 4;
    const terrainScores = g.rules?.ai?.terrainScores || {};
    score += Number(terrainScores[terrainAt(target.row, target.col, g.boardId)] || 0);
  } else if (enemies.length) {
    const before = Math.min(...enemies.map(enemy => graphDistance(unit.row, unit.col, enemy.row, enemy.col, g.boardId)));
    const after = Math.min(...enemies.map(enemy => graphDistance(target.row, target.col, enemy.row, enemy.col, g.boardId)));
    score += (before - after) * 34;
    score += defensiveBlockValue(g, target.row, target.col) - defensiveBlockValue(g, unit.row, unit.col);
    score += Number((g.rules?.ai?.defenderRowScore || {})[String(target.row)] || 0);
  }

  if (!unit.shot) {
    const bestFutureShot = enemies
      .filter(enemy => graphDistance(target.row, target.col, enemy.row, enemy.col, g.boardId) <= (Number(unitDefinition(unit.type, g)?.range) || 1))
      .map(enemy => scoreShot(g, { ...unit, row: target.row, col: target.col }, enemy).score)
      .reduce((best, value) => Math.max(best, value), 0);
    score += bestFutureShot * 0.18;
  }

  const mobility = neighbors(target.row, target.col, g.boardId)
    .filter(([r, c]) => !unitAt(g, r, c) && canEnterTerrain(g, unit, r, c)).length;
  score += mobility * 3 * profile.mobilityWeight;
  score -= threatAt(g, unit, target.row, target.col) * profile.dangerWeight;
  return { score, priority: 'move' };
}

function botActionChoices(g, player, difficulty) {
  const actions = [];
  for (const unit of g.units.filter(u => u.player === player && u.canAct)) {
    const shots = shootTargets(g, unit);
    const moves = moveTargets(g, unit);

    for (const target of shots) {
      const scored = scoreShot(g, unit, target);
      actions.push({ type: 'shoot', unitId: unit.id, targetId: target.id, ...scored });
    }
    for (const target of moves) {
      const scored = scoreMove(g, unit, target, difficulty);
      actions.push({ type: 'move', unitId: unit.id, row: target.row, col: target.col, ...scored });
    }

    const usefulShot = shots.some(target => canDamageAt(g, unit, target.type, target.row, target.col));
    const stopScore = usefulShot || moves.length ? -35 : 5;
    actions.push({ type: 'stop', unitId: unit.id, score: stopScore, priority: 'stop' });
  }
  return actions;
}

function chooseBotAction(g, player, difficulty) {
  const choices = botActionChoices(g, player, difficulty);
  const winning = choices.filter(action => action.priority === 'win');
  if (winning.length) return chooseRanked(winning, 'hard');
  const kills = choices.filter(action => action.priority === 'kill');
  if (kills.length) return chooseRanked(kills, difficulty);
  return chooseRanked(choices, difficulty);
}

/* The bot scores only the current legal actions and yields between each one. */
function scheduleBotTurn(room, delay = BOT_STEP_DELAY) {
  if (!room || !room.botRole || room.game.state !== 'playing') return;
  if (room.game.currentPlayer !== room.botRole || room.botTimer) return;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    runBotStep(room);
  }, delay);
}

function runBotStep(room) {
  if (rooms.get(room.id) !== room) return;
  const g = room.game;
  const player = room.botRole;
  if (!player || g.state !== 'playing' || g.currentPlayer !== player) return;

  try {
    const turnKey = `${g.round}:${player}`;
    if (room.botStepTurn !== turnKey) {
      room.botStepTurn = turnKey;
      room.botSteps = 0;
    }
    room.botSteps++;
    if (room.botSteps > BOT_MAX_STEPS_PER_TURN) {
      addLog(g, '机器人达到本回合操作上限，自动结束回合。');
      endTurn(g, player);
      broadcast(room);
      broadcastLobby();
      return;
    }

    if (room.botDeployTurn !== turnKey) {
      // Deployment is repeatable within a turn. Keep taking legal deployment
      // choices until the row, reinforcement, or per-type caps are exhausted;
      // only then mark the deployment phase complete and begin unit actions.
      const choice = chooseBotDeployment(g, player, room.botDifficulty);
      if (choice) {
        deploy(g, player, choice.type, choice.row, choice.col);
        broadcast(room);
        scheduleBotTurn(room);
        return;
      }
      room.botDeployTurn = turnKey;
    }

    const activeUnits = g.units.filter(u => u.player === player && u.canAct);
    if (!activeUnits.length) {
      endTurn(g, player);
      broadcast(room);
      broadcastLobby();
      return;
    }

    const action = chooseBotAction(g, player, room.botDifficulty);
    if (!action) {
      endTurn(g, player);
      broadcast(room);
      return;
    }

    if (action.type === 'shoot') shoot(g, player, action.unitId, action.targetId);
    else if (action.type === 'move') move(g, player, action.unitId, action.row, action.col);
    else endUnit(g, player, action.unitId);

    broadcast(room);
    if (g.state === 'ended') {
      broadcastLobby();
      return;
    }
    scheduleBotTurn(room);
  } catch (err) {
    console.error(`[BOT] Failed in ${room.id}:`, err);
    if (g.state === 'playing' && g.currentPlayer === player) {
      try { endTurn(g, player); } catch (_) { /* leave the room state intact */ }
      broadcast(room);
    }
  }
}

const httpServer = http.createServer((req, res) => {
  let p = req.url.split('?')[0];

  if (p === '/__audio_manifest') {
    try {
      const files = collectAudioFiles(AUDIO_ROOT);
      console.log(`[AUDIO] Manifest requested: ${files.length} file(s) found in ${AUDIO_ROOT}`);
      const manifest = { files };
      res.writeHead(200, {
        'Content-Type': 'application/json;charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate'
      });
      return res.end(JSON.stringify(manifest));
    } catch (err) {
      console.error('[AUDIO] Failed to build manifest:', err);
      res.writeHead(500, { 'Content-Type': 'application/json;charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ files: [], error: 'audio_manifest_failed' }));
    }
  }

  try {
    p = decodeURIComponent(p);
  } catch (_) {
    res.writeHead(400);
    return res.end('Bad Request');
  }

  if (p === '/') p = '/index.html';

  // 使用 path.resolve + path.sep 做目录边界判断，避免 Windows/Linux 路径差异与目录穿越问题。
  const relativePath = p.replace(/^[/\\]+/, '');
  const file = path.resolve(PUBLIC_DIR, relativePath);
  const publicRoot = path.resolve(PUBLIC_DIR);
  if (file !== publicRoot && !file.startsWith(publicRoot + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  const ext = path.extname(file).toLowerCase();
  const types = {
    '.html': 'text/html;charset=utf-8',
    '.js': 'text/javascript;charset=utf-8',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.webm': 'audio/webm',
    '.flac': 'audio/flac'
  };

  fs.stat(file, (statErr, stat) => {
    if (statErr) {
      if (AUDIO_EXTENSIONS.has(ext)) console.error(`[AUDIO] Failed to stat ${file}:`, statErr.code || statErr.message);
      res.writeHead(statErr.code === 'EACCES' ? 403 : 404);
      return res.end(statErr.code === 'EACCES' ? 'Forbidden' : 'Not Found');
    }
    if (!stat.isFile()) {
      res.writeHead(404);
      return res.end('Not Found');
    }

    const commonHeaders = {
      'Content-Type': types[ext] || 'application/octet-stream',
      'Cache-Control': ext.startsWith('.mp') || AUDIO_EXTENSIONS.has(ext) ? 'no-cache' : 'public, max-age=3600',
      'Accept-Ranges': AUDIO_EXTENSIONS.has(ext) ? 'bytes' : 'none'
    };

    // 音频支持 HTTP Range，兼容 Safari/Chrome 以及 Linux 服务器前的反向代理。
    if (AUDIO_EXTENSIONS.has(ext) && req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (match) {
        let start = match[1] === '' ? 0 : Number(match[1]);
        let end = match[2] === '' ? stat.size - 1 : Number(match[2]);
        if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start && start < stat.size) {
          end = Math.min(end, stat.size - 1);
          const chunkSize = end - start + 1;
          res.writeHead(206, {
            ...commonHeaders,
            'Content-Length': chunkSize,
            'Content-Range': `bytes ${start}-${end}/${stat.size}`
          });
          if (req.method === 'HEAD') return res.end();
          return fs.createReadStream(file, { start, end })
            .on('error', err => console.error(`[AUDIO] Stream error ${file}:`, err.code || err.message))
            .pipe(res);
        }
      }
      res.writeHead(416, { ...commonHeaders, 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }

    res.writeHead(200, { ...commonHeaders, 'Content-Length': stat.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file)
      .on('error', err => console.error(`[STATIC] Failed to stream ${file}:`, err.code || err.message))
      .pipe(res);
  });
});

const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', ws => {
  ws.roomId = null;
  ws.role = null;
  send(ws, { type: 'hello', message: 'connected', variants: variantCatalogForClient() });

  ws.on('message', raw => {
    try {
      const m = JSON.parse(raw.toString());

      if (m.type === 'listRooms') {
        send(ws, { type: 'lobby', rooms: lobbySnapshot() });
        return;
      }

      if (m.type === 'create') {
        const hostRole = m.hostRole === 'defender' ? 'defender' : 'attacker';
        const gameMode = m.gameMode === 'ai' ? 'ai' : 'pvp';
        const variantId = normalizeVariantId(m.variantId);
        const variant = GAME_VARIANTS[variantId];
        if (!variant?.enabled) throw new Error('该玩法当前不可用');
        if (gameMode === 'ai' && variant.supportsAi !== true) throw new Error('该玩法暂不支持人机对战');
        const botRole = gameMode === 'ai' ? (hostRole === 'attacker' ? 'defender' : 'attacker') : null;
        const botDifficulty = normalizeBotDifficulty(m.botDifficulty);
        const config = sanitizeConfig(m.config, variantId);
        const g = newGame(config, hostRole, variantId);
        const id = `room-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const room = {
          id,
          name: `房间 ${nextRoomNumber++}`,
          hostRole,
          gameMode,
          variantId,
          botRole,
          botDifficulty,
          botTimer: null,
          botDeployTurn: null,
          botStepTurn: null,
          botSteps: 0,
          game: g,
          players: { attacker: null, defender: null }
        };
        g.roomName = room.name;
        g.gameMode = gameMode;
        g.botRole = botRole;
        g.botDifficulty = botDifficulty;
        room.players[hostRole] = ws;
        g.players[hostRole] = ws;
        if (botRole) g.players[botRole] = { bot: true };
        rooms.set(id, room);
        ws.roomId = id;
        ws.role = hostRole;
        ws.spectating = false;
        ws.surrenderClicks = 0;
        ws.surrenderWindowStartedAt = 0;
        if (botRole) {
          g.started = true;
          g.state = 'playing';
          resetTurnForCurrentPlayer(g);
          const difficultyName = { easy: '简单', normal: '普通', hard: '困难' }[botDifficulty];
          addLog(g, `人机对战开始。${difficultyName}机器人控制${botRole === 'attacker' ? '进攻方' : '防守方'}。`);
        }
        send(ws, { type: 'created', id: room.id, name: room.name, role: hostRole, gameMode, variantId, boardId: g.boardId });
        broadcast(room);
        broadcastLobby();
        scheduleBotTurn(room);
        return;
      }

      if (m.type === 'join') {
        const id = String(m.roomId || '');
        const room = rooms.get(id);
        if (!room) throw new Error('房间不存在或已经结束');

        // 等待中的房间优先加入空缺玩家位；已经开始的房间则进入观战。
        if (!room.game.started && room.game.state === 'waiting') {
          const joinRole = room.players.attacker ? 'defender' : 'attacker';
          if (room.players[joinRole]) throw new Error('房间已满');
          room.players[joinRole] = ws;
          room.game.players[joinRole] = ws;
          ws.roomId = room.id;
          ws.role = joinRole;
          ws.spectating = false;
          ws.surrenderClicks = 0;
          ws.surrenderWindowStartedAt = 0;
          send(ws, { type: 'joined', id: room.id, name: room.name, role: joinRole, spectating: false });
          if (room.players.attacker && room.players.defender && !room.game.started) {
            room.game.started = true;
            room.game.state = 'playing';
            resetTurnForCurrentPlayer(room.game);
            addLog(room.game, `两名玩家已连接。${room.game.currentPlayer === 'attacker' ? '进攻方' : '防守方'}先手。`);
          }
          broadcast(room);
          broadcastLobby();
          return;
        }

        // 已开战房间：只读观战连接。
        if (room.game.started && room.game.state !== 'ended') {
          room.game.spectators ||= new Set();
          room.game.spectators.add(ws);
          ws.roomId = room.id;
          ws.role = 'spectator';
          ws.spectating = true;
          send(ws, { type: 'joined', id: room.id, name: room.name, role: 'spectator', spectating: true });
          send(ws, { type: 'state', state: publicState(room.game, 'spectator') });
          broadcastLobby();
          return;
        }

        throw new Error('该房间无法加入');
      }
      const room = rooms.get(ws.roomId);
      if (!room) throw new Error('尚未加入房间');
      const player = ws.role;
      const g = room.game;

      if (m.type === 'surrender') {
        if (player !== 'attacker' && player !== 'defender') throw new Error('观战者不能投降');
        if (g.state !== 'playing') throw new Error('游戏已结束');
        const now = Date.now();
        if (!ws.surrenderWindowStartedAt || now - ws.surrenderWindowStartedAt > 2000) {
          ws.surrenderWindowStartedAt = now;
          ws.surrenderClicks = 1;
        } else {
          ws.surrenderClicks = (ws.surrenderClicks || 0) + 1;
        }
        if (ws.surrenderClicks < 3) {
          send(ws, { type: 'surrenderProgress', count: ws.surrenderClicks, remainingMs: Math.max(0, 2000 - (now - ws.surrenderWindowStartedAt)) });
          return;
        }
        ws.surrenderClicks = 0;
        ws.surrenderWindowStartedAt = 0;
        g.state = 'ended';
        g.winner = player === 'attacker' ? 'defender' : 'attacker';
        g.winnerReason = 'surrender';
        addLog(g, `${player === 'attacker' ? '进攻方' : '防守方'}投降，${g.winner === 'attacker' ? '进攻方' : '防守方'}获胜。`);
        setEvent(g, { type: 'surrenderWin', winner: g.winner });
        broadcast(room);
        broadcastLobby();
        return;
      }

      if (player === 'spectator' && m.type !== 'leaveRoom') throw new Error('观战中不能进行游戏操作');

      if (m.type === 'deploy') deploy(g, player, m.unitType, Number(m.row), Number(m.col));
      else if (m.type === 'move') move(g, player, Number(m.unitId), Number(m.row), Number(m.col));
      else if (m.type === 'shoot') shoot(g, player, Number(m.unitId), Number(m.targetId));
      else if (m.type === 'endUnit') endUnit(g, player, Number(m.unitId));
      else if (m.type === 'endTurn') endTurn(g, player);
      else if (m.type === 'chat') {
        let text = String(m.text ?? '').trim().slice(0, 200);
        if (!text) text = g.lastChat[player] || '';
        if (!text) throw new Error('还没有可重复发送的上一条消息');
        g.lastChat[player] = text;
        const chatPacket = { type: 'chat', role: player, text, at: Date.now() };
        for (const r of ['attacker', 'defender']) {
          const peer = room.players[r];
          if (peer) send(peer, chatPacket);
        }
        if (room.game.spectators) {
          for (const spectator of room.game.spectators) send(spectator, chatPacket);
        }
        return;
      }
      else if (m.type === 'ping') { send(ws, { type: 'pong' }); return; }
      else if (m.type === 'leaveRoom') {
        const leavingRole = ws.role;
        if (leavingRole === 'spectator') {
          room.game.spectators?.delete(ws);
          ws.roomId = null;
          ws.role = null;
          ws.spectating = false;
          send(ws, { type: 'leftRoom' });
          broadcastLobby();
          return;
        }

        if (room.game.state === 'playing' && room.game.started) {
          room.game.state = 'ended';
          room.game.winner = leavingRole === 'attacker' ? 'defender' : 'attacker';
          room.game.winnerReason = 'leave_room';
          addLog(room.game, `${leavingRole === 'attacker' ? '进攻方' : '防守方'}退出房间，另一方获胜。`);
          setEvent(room.game, { type: 'leaveWin', winner: room.game.winner });
        }

        room.players[leavingRole] = null;
        room.game.players[leavingRole] = null;
        if (room.botTimer) {
          clearTimeout(room.botTimer);
          room.botTimer = null;
        }
        ws.roomId = null;
        ws.role = null;
        ws.spectating = false;
        send(ws, { type: 'leftRoom' });
        if (room.game.state === 'ended') broadcast(room);
        if (!room.game.started) rooms.delete(room.id);
        broadcastLobby();
        return;
      }
      else throw new Error('未知操作');

      broadcast(room);
      scheduleBotTurn(room);
    } catch (e) {
      send(ws, { type: 'error', code: e.code || null, message: e.message || String(e) });
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomId);
    if (!room) return;
    if (ws.role === 'spectator') {
      room.game.spectators?.delete(ws);
      broadcastLobby();
      return;
    }
    if (room.botTimer) {
      clearTimeout(room.botTimer);
      room.botTimer = null;
    }
    if (room.game.state !== 'ended' && room.game.started) {
      room.game.state = 'ended';
      room.game.winner = ws.role === 'attacker' ? 'defender' : 'attacker';
      room.game.winnerReason = 'disconnect';
      addLog(room.game, `${ws.role === 'attacker' ? '进攻方' : '防守方'}断开连接，另一方获胜。`);
      setEvent(room.game, { type: 'disconnectWin', winner: room.game.winner });
    }
    broadcast(room);
    setTimeout(() => {
      if (rooms.get(room.id) === room) {
        rooms.delete(room.id);
        broadcastLobby();
      }
    }, 60000);
    broadcastLobby();
  });
});

if (require.main === module) {
  httpServer.listen(PORT, HOST, () => {
    console.log(`HOMG0 LAN server running on http://0.0.0.0:${PORT}`);
    console.log(`局域网访问: http://<房主IP>:${PORT}`);
  });
}

module.exports = {
  testing: {
    DEFAULT_CONFIG,
    BOARD_DEFINITIONS,
    GAME_VARIANTS,
    GAME_RULES,
    serializeDefinition,
    deserializeDefinition,
    normalizeBoardDefinition,
    normalizeUnitsDefinition,
    normalizeRulesDefinition,
    definitionsForVariant,
    newGame,
    normalizeVariantId,
    deploymentRowFor,
    createUnit,
    normalizeBotDifficulty,
    chooseBotDeployment,
    chooseBotAction
  }
};
