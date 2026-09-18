const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 37788;
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.webm', '.flac']);
const AUDIO_ROOT = path.resolve(PUBLIC_DIR, 'audio');
const DATA_ROOT = path.join(__dirname, 'data');
const CLIENT_ASSET_VERSION = '20260917-rule-grid-v1';

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
    if (isBoardRow(row) && Number.isInteger(col)) return { row, col };
  }
  if (value && typeof value === 'object') {
    const row = Number(value.row), col = Number(value.col);
    if (isBoardRow(row) && Number.isInteger(col)) return { row, col };
  }
  return null;
}

function isBoardRow(value) {
  return Number.isFinite(value) && Number.isInteger(value * 2);
}

function normalizeBoardDefinition(raw) {
  const board = deserializeDefinition(raw, 'board');
  const schemaVersion = Number(board.schemaVersion) || 1;
  if (schemaVersion !== 1) throw new Error(`unsupported board schemaVersion: ${schemaVersion}`);
  if (!Array.isArray(board.rows) || !board.rows.length) throw new Error('board.rows must be a non-empty array');
  const coordinateLayout = board.coordinateLayout && typeof board.coordinateLayout === 'object' ? board.coordinateLayout : {};
  const originX = Number.isFinite(Number(coordinateLayout.originX)) ? Number(coordinateLayout.originX) : 1;
  const columnStep = Number.isFinite(Number(coordinateLayout.columnStep)) && Number(coordinateLayout.columnStep) > 0
    ? Number(coordinateLayout.columnStep)
    : null;
  const rows = board.rows.map(row => ({
    id: Number(row.id),
    top: Number(row.top) || 0,
    cells: Array.isArray(row.cells) ? row.cells.map(cell => ({
      col: Number(cell.col),
      displayCol: String(cell.displayCol ?? Number(cell.col) + 1),
      terrain: String(cell.terrain || ''),
      x: Number.isFinite(Number(cell.x)) ? Number(cell.x) : null,
      top: Number.isFinite(Number(cell.top)) ? Number(cell.top) : null,
      left: Number.isFinite(Number(cell.left))
        ? Number(cell.left)
        : (columnStep && Number.isFinite(Number(cell.x)) ? (Number(cell.x) - originX) * columnStep : null)
    })).filter(cell => Number.isInteger(cell.col)) : []
  })).filter(row => isBoardRow(row.id) && row.cells.length);
  if (!rows.length) throw new Error('board.rows contains no valid rows');

  const cellKeys = new Set();
  for (const row of rows) {
    for (const cell of row.cells) {
      const cellKey = `${row.id},${cell.col}`;
      if (cellKeys.has(cellKey)) throw new Error(`board contains duplicate cell: ${cellKey}`);
      cellKeys.add(cellKey);
    }
  }

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
  if (!edges.length && cellKeys.size > 1) throw new Error('board contains multiple cells but no connections');
  for (const edge of edges) {
    if (!cellKeys.has(`${edge.from.row},${edge.from.col}`) || !cellKeys.has(`${edge.to.row},${edge.to.col}`)) {
      throw new Error('board connection references an unknown cell');
    }
  }
  if (cellKeys.size > 1) {
    const connected = new Set([cellKeys.values().next().value]);
    const queue = [...connected];
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index];
      for (const edge of edges) {
        const from = `${edge.from.row},${edge.from.col}`, to = `${edge.to.row},${edge.to.col}`;
        const next = from === current ? to : (to === current ? from : null);
        if (next && !connected.has(next)) { connected.add(next); queue.push(next); }
      }
    }
    if (connected.size !== cellKeys.size) throw new Error(`board is disconnected: reached ${connected.size} of ${cellKeys.size} cells`);
  }
  return freezeDefinition({
    schemaVersion,
    contentVersion: Number(board.contentVersion) || 1,
    id: String(board.id || 'classic'),
    terrainTypeSet: String(board.terrainTypeSet || ''),
    name: String(board.name || board.id || '棋盘'),
    width: Number(board.width) || 790,
    height: Number(board.height) || 720,
    gridInset: board.gridInset || {},
    cellSize: board.cellSize || {},
    gap: Number(board.gap) || 0,
    coordinateLayout: { originX, columnStep },
    deploymentRows: board.deploymentRows || {},
    deploymentAreas: board.deploymentAreas || {},
    regions: board.regions || {},
    rows,
    connections: edges
  });
}

function validDefinitionId(value) {
  return typeof value === 'string'
    && /^[a-zA-Z0-9_-]{1,64}$/.test(value)
    && value !== '__proto__'
    && value !== 'prototype'
    && value !== 'constructor';
}

function schemaVersionOf(source, label) {
  const schemaVersion = Number(source.schemaVersion) || 1;
  if (schemaVersion !== 1) throw new Error(`unsupported ${label} schemaVersion: ${schemaVersion}`);
  return schemaVersion;
}

function normalizeTerrainTypesDefinition(raw) {
  const source = deserializeDefinition(raw, 'terrain types');
  if (!validDefinitionId(source.id)) throw new Error('terrain types has an invalid id');
  const input = source.terrainTypes && typeof source.terrainTypes === 'object' ? source.terrainTypes : {};
  const terrainTypes = {};
  for (const [id, value] of Object.entries(input)) {
    if (!validDefinitionId(id) || !value || typeof value !== 'object') continue;
    terrainTypes[id] = {
      name: String(value.name || id),
      color: String(value.color || ''),
      borderColor: String(value.borderColor || ''),
      symbol: String(value.symbol || ''),
      icon: String(value.icon || ''),
      description: String(value.description || '')
    };
  }
  if (!Object.keys(terrainTypes).length) throw new Error('terrain types contains no valid definitions');
  return freezeDefinition({
    schemaVersion: schemaVersionOf(source, 'terrain types'),
    contentVersion: Number(source.contentVersion) || 1,
    id: source.id,
    terrainTypes
  });
}

function normalizeUnitTypesDefinition(raw) {
  const source = deserializeDefinition(raw, 'unit types');
  if (!validDefinitionId(source.id)) throw new Error('unit types has an invalid id');
  const input = source.unitTypes && typeof source.unitTypes === 'object' ? source.unitTypes : {};
  const unitTypes = {};
  for (const [id, value] of Object.entries(input)) {
    if (!validDefinitionId(id) || !value || typeof value !== 'object') continue;
    unitTypes[id] = {
      name: String(value.name || id),
      short: String(value.short || '?'),
      icon: String(value.icon || ''),
      description: String(value.description || '')
    };
  }
  if (!Object.keys(unitTypes).length) throw new Error('unit types contains no valid definitions');
  return freezeDefinition({
    schemaVersion: schemaVersionOf(source, 'unit types'),
    contentVersion: Number(source.contentVersion) || 1,
    id: source.id,
    unitTypes
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
    configDefaults: source.configDefaults || {}, ai: source.ai || {}, ui: source.ui || {}, simultaneous: source.simultaneous || {}
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
  reinforcement: 0,
  attackerMax: {},
  defenderMax: {},
  allowDeployAfterAction: true
};

function safeDataPath(relativePath) {
  const value = String(relativePath || '').replace(/\\/g, '/');
  const full = path.resolve(DATA_ROOT, value);
  if (full !== DATA_ROOT && !full.startsWith(DATA_ROOT + path.sep)) throw new Error('definition path escapes data directory');
  return full;
}

function copyDefinition(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeResourceReference(value, label, optional = false) {
  if (value == null && optional) return null;
  const source = typeof value === 'string' ? { path: value } : value;
  if (!source || typeof source !== 'object' || typeof source.path !== 'string' || !source.path.trim()) {
    throw new Error(`${label} resource reference is required`);
  }
  safeDataPath(source.path);
  if (source.id != null && !validDefinitionId(String(source.id))) throw new Error(`${label} has an invalid expected id`);
  if (source.contentVersion != null && (!Number.isInteger(Number(source.contentVersion)) || Number(source.contentVersion) < 1)) {
    throw new Error(`${label} has an invalid contentVersion`);
  }
  return freezeDefinition({
    path: source.path.replace(/\\/g, '/'),
    id: source.id == null ? null : String(source.id),
    contentVersion: source.contentVersion == null ? null : Number(source.contentVersion)
  });
}

function loadReferencedDefinition(reference, label) {
  const source = loadSerializedDefinition(reference.path);
  if (reference.id && source.id !== reference.id) {
    throw new Error(`${label} id mismatch: expected ${reference.id}, received ${source.id || '(missing)'}`);
  }
  const actualVersion = Number(source.contentVersion) || 1;
  if (reference.contentVersion != null && actualVersion !== reference.contentVersion) {
    throw new Error(`${label} contentVersion mismatch: expected ${reference.contentVersion}, received ${actualVersion}`);
  }
  return source;
}

function normalizeBattleCatalog(raw) {
  const source = deserializeDefinition(raw, 'battle catalog');
  schemaVersionOf(source, 'battle catalog');
  const entries = Array.isArray(source.battles)
    ? source.battles
    : Object.entries(source.battles || {}).map(([id, value]) => ({ id, ...value }));
  const out = {};
  for (const value of entries) {
    if (!value || typeof value !== 'object' || !validDefinitionId(value.id)) continue;
    if (Object.hasOwn(out, value.id)) throw new Error(`duplicate battle id: ${value.id}`);
    out[value.id] = freezeDefinition({
      id: value.id,
      enabled: value.enabled !== false,
      manifest: normalizeResourceReference(value.manifest, `battle ${value.id} manifest`)
    });
  }
  if (!Object.keys(out).length) throw new Error('battle catalog contains no valid entries');
  return freezeDefinition(out);
}

function normalizeBattleManifest(raw, catalogId) {
  const source = deserializeDefinition(raw, `battle ${catalogId}`);
  if (!validDefinitionId(source.id) || source.id !== catalogId) throw new Error(`battle manifest id must be ${catalogId}`);
  const resources = source.resources && typeof source.resources === 'object' ? source.resources : {};
  return freezeDefinition({
    schemaVersion: schemaVersionOf(source, 'battle manifest'),
    contentVersion: Number(source.contentVersion) || 1,
    id: source.id,
    name: String(source.name || source.id),
    category: String(source.category || 'battle'),
    enabled: source.enabled !== false,
    engine: String(source.engine || source.id),
    supportsAi: source.supportsAi === true,
    resources: {
      terrainTypes: normalizeResourceReference(resources.terrainTypes, `${source.id}.terrainTypes`),
      unitTypes: normalizeResourceReference(resources.unitTypes, `${source.id}.unitTypes`),
      map: normalizeResourceReference(resources.map, `${source.id}.map`),
      combatRules: normalizeResourceReference(resources.combatRules, `${source.id}.combatRules`),
      gameRules: normalizeResourceReference(resources.gameRules, `${source.id}.gameRules`),
      aiProfile: normalizeResourceReference(resources.aiProfile, `${source.id}.aiProfile`, source.supportsAi !== true),
      scenarioRules: normalizeResourceReference(resources.scenarioRules, `${source.id}.scenarioRules`, true)
    }
  });
}

function normalizeAiProfileDefinition(raw, terrainTypes, unitTypes) {
  const source = deserializeDefinition(raw, 'AI profile');
  if (!validDefinitionId(source.id)) throw new Error('AI profile has an invalid id');
  if (source.algorithm !== 'bounded-lookahead') throw new Error(`unsupported AI algorithm: ${source.algorithm || '(missing)'}`);
  if (source.requires?.terrainTypes !== terrainTypes.id) throw new Error(`AI profile requires terrain types ${source.requires?.terrainTypes || '(missing)'}`);
  if (source.requires?.unitTypes !== unitTypes.id) throw new Error(`AI profile requires unit types ${source.requires?.unitTypes || '(missing)'}`);
  const integer = (value, min, max, label) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) throw new Error(`AI profile has an invalid ${label}`);
    return number;
  };
  const decimal = (value, min, max, label) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max) throw new Error(`AI profile has an invalid ${label}`);
    return number;
  };
  const execution = source.execution && typeof source.execution === 'object' ? source.execution : {};
  const evaluation = source.evaluation && typeof source.evaluation === 'object' ? source.evaluation : {};
  const unitProfiles = evaluation.unitProfiles && typeof evaluation.unitProfiles === 'object' ? evaluation.unitProfiles : {};
  const terrainScores = evaluation.terrainScores && typeof evaluation.terrainScores === 'object' ? evaluation.terrainScores : {};
  const numericEvaluationGroups = {};
  for (const group of ['deploymentScores', 'actionScores', 'stateWeights']) {
    const sourceGroup = evaluation[group] && typeof evaluation[group] === 'object' ? evaluation[group] : {};
    numericEvaluationGroups[group] = {};
    for (const [name, value] of Object.entries(sourceGroup)) {
      numericEvaluationGroups[group][name] = decimal(value, -1000000, 1000000, `evaluation.${group}.${name}`);
    }
  }
  for (const id of Object.keys(unitProfiles)) {
    if (!Object.hasOwn(unitTypes.unitTypes, id)) throw new Error(`AI profile references unknown unit type: ${id}`);
  }
  for (const id of Object.keys(unitTypes.unitTypes)) {
    if (!Object.hasOwn(unitProfiles, id)) throw new Error(`AI profile is missing unit profile: ${id}`);
  }
  for (const id of Object.keys(terrainScores)) {
    if (!Object.hasOwn(terrainTypes.terrainTypes, id)) throw new Error(`AI profile references unknown terrain type: ${id}`);
  }
  const difficulties = {};
  for (const [id, value] of Object.entries(source.difficulties || {})) {
    if (!validDefinitionId(id) || !value || typeof value !== 'object') throw new Error(`AI profile has an invalid difficulty: ${id}`);
    difficulties[id] = {
      searchDepth: integer(value.searchDepth, 1, 8, `${id}.searchDepth`),
      maxRootCandidates: integer(value.maxRootCandidates, 1, 32, `${id}.maxRootCandidates`),
      maxBranching: integer(value.maxBranching, 1, 12, `${id}.maxBranching`),
      maxNodes: integer(value.maxNodes, 1, 1024, `${id}.maxNodes`),
      timeBudgetMs: integer(value.timeBudgetMs, 1, 100, `${id}.timeBudgetMs`),
      futureDiscount: decimal(value.futureDiscount, 0, 1, `${id}.futureDiscount`),
      topChoices: integer(value.topChoices, 1, 8, `${id}.topChoices`),
      nearBestWindow: decimal(value.nearBestWindow, 0, 1000, `${id}.nearBestWindow`),
      dangerWeight: decimal(value.dangerWeight, 0, 5, `${id}.dangerWeight`),
      mobilityWeight: decimal(value.mobilityWeight, 0, 5, `${id}.mobilityWeight`)
    };
  }
  if (!Object.keys(difficulties).length) throw new Error('AI profile contains no difficulties');
  const defaultDifficulty = String(source.defaultDifficulty || '');
  if (!Object.hasOwn(difficulties, defaultDifficulty)) throw new Error('AI profile defaultDifficulty is unknown');
  return freezeDefinition({
    schemaVersion: schemaVersionOf(source, 'AI profile'),
    contentVersion: Number(source.contentVersion) || 1,
    id: source.id,
    algorithm: source.algorithm,
    requires: source.requires,
    defaultDifficulty,
    execution: {
      stepDelayMs: integer(execution.stepDelayMs, 0, 10000, 'execution.stepDelayMs'),
      maxStepsPerTurn: integer(execution.maxStepsPerTurn, 1, 500, 'execution.maxStepsPerTurn'),
      maxDeploymentsPerPlan: integer(execution.maxDeploymentsPerPlan, 1, 200, 'execution.maxDeploymentsPerPlan')
    },
    evaluation: { ...copyDefinition(evaluation), ...numericEvaluationGroups },
    difficulties
  });
}

function assertKnownReferences(values, definitions, label) {
  if (!Array.isArray(values)) return;
  for (const id of values) {
    if (!Object.hasOwn(definitions, id)) throw new Error(`${label} references unknown id: ${id}`);
  }
}

function normalizeCombatRulesDefinition(raw, terrainTypes, unitTypes) {
  const source = deserializeDefinition(raw, 'combat rules');
  if (!validDefinitionId(source.id)) throw new Error('combat rules has an invalid id');
  if (source.requires?.terrainTypes !== terrainTypes.id) throw new Error(`combat rules requires terrain types ${source.requires?.terrainTypes || '(missing)'}`);
  if (source.requires?.unitTypes !== unitTypes.id) throw new Error(`combat rules requires unit types ${source.requires?.unitTypes || '(missing)'}`);
  const unitProfiles = source.unitProfiles && typeof source.unitProfiles === 'object' ? source.unitProfiles : {};
  const terrainProfiles = source.terrainProfiles && typeof source.terrainProfiles === 'object' ? source.terrainProfiles : {};
  for (const id of Object.keys(unitProfiles)) {
    if (!Object.hasOwn(unitTypes.unitTypes, id)) throw new Error(`combat rules references unknown unit type: ${id}`);
    assertKnownReferences(unitProfiles[id]?.immuneFrom, unitTypes.unitTypes, `unit profile ${id}.immuneFrom`);
  }
  for (const id of Object.keys(unitTypes.unitTypes)) {
    if (!Object.hasOwn(unitProfiles, id)) throw new Error(`combat rules is missing unit profile: ${id}`);
  }
  for (const id of Object.keys(terrainProfiles)) {
    if (!Object.hasOwn(terrainTypes.terrainTypes, id)) throw new Error(`combat rules references unknown terrain type: ${id}`);
    assertKnownReferences(terrainProfiles[id]?.passableUnits, unitTypes.unitTypes, `terrain profile ${id}.passableUnits`);
    assertKnownReferences(terrainProfiles[id]?.attackImmuneFrom, unitTypes.unitTypes, `terrain profile ${id}.attackImmuneFrom`);
  }
  for (const id of Object.keys(terrainTypes.terrainTypes)) {
    if (!Object.hasOwn(terrainProfiles, id)) throw new Error(`combat rules is missing terrain profile: ${id}`);
  }
  const instantKill = source.combat?.instantKill;
  if (instantKill) {
    assertKnownReferences(instantKill.attackerTypes, unitTypes.unitTypes, 'combat.instantKill.attackerTypes');
    assertKnownReferences(instantKill.targetTypes, unitTypes.unitTypes, 'combat.instantKill.targetTypes');
    assertKnownReferences(instantKill.terrainTypes, terrainTypes.terrainTypes, 'combat.instantKill.terrainTypes');
  }
  return freezeDefinition(copyDefinition({
    schemaVersion: schemaVersionOf(source, 'combat rules'),
    contentVersion: Number(source.contentVersion) || 1,
    id: source.id,
    requires: source.requires,
    unitProfiles,
    terrainProfiles,
    combat: source.combat || {}
  }));
}

function normalizeGameRulesDefinition(raw, combatRules, unitTypes) {
  const source = deserializeDefinition(raw, 'game rules');
  if (!validDefinitionId(source.id)) throw new Error('game rules has an invalid id');
  if (source.requires?.combatRules !== combatRules.id) throw new Error(`game rules requires combat rules ${source.requires?.combatRules || '(missing)'}`);
  const deploymentProfiles = source.deployment?.unitProfiles && typeof source.deployment.unitProfiles === 'object'
    ? source.deployment.unitProfiles
    : {};
  for (const [id, profile] of Object.entries(deploymentProfiles)) {
    if (!Object.hasOwn(unitTypes.unitTypes, id)) throw new Error(`game rules references unknown unit type: ${id}`);
    const players = Array.isArray(profile?.allowedPlayers) ? profile.allowedPlayers : [];
    if (players.some(player => player !== 'attacker' && player !== 'defender')) throw new Error(`game rules has an invalid player in ${id}.allowedPlayers`);
  }
  for (const id of Object.keys(unitTypes.unitTypes)) {
    if (!Object.hasOwn(deploymentProfiles, id)) throw new Error(`game rules is missing deployment profile: ${id}`);
  }
  return freezeDefinition(copyDefinition({
    schemaVersion: schemaVersionOf(source, 'game rules'),
    contentVersion: Number(source.contentVersion) || 1,
    id: source.id,
    requires: source.requires,
    deployment: source.deployment || {},
    configDefaults: source.configDefaults || {},
    simultaneous: source.simultaneous || {},
    victory: source.victory || {},
    turn: source.turn || {},
    ui: source.ui || {}
  }));
}

function normalizeScenarioRulesDefinition(raw, dependencies, board) {
  const source = deserializeDefinition(raw, 'scenario rules');
  if (!validDefinitionId(source.id)) throw new Error('scenario rules has an invalid id');
  for (const [key, expected] of Object.entries(dependencies)) {
    if (key === 'unitTypeDefinitions') continue;
    if (source.requires?.[key] !== expected) {
      throw new Error(`scenario rules requires ${key} ${source.requires?.[key] || '(missing)'}`);
    }
  }
  const boardCells = new Set(board.rows.flatMap(row => row.cells.map(cell => `${row.id},${cell.col}`)));
  const regions = {};
  for (const [id, value] of Object.entries(source.regions || {})) {
    if (!validDefinitionId(id) || !value || typeof value !== 'object') throw new Error(`scenario rules has an invalid region: ${id}`);
    const seen = new Set();
    const cells = [];
    for (const coordinate of value.cells || []) {
      const cell = parseCoordinate(coordinate);
      if (!cell) throw new Error(`scenario region ${id} contains an invalid coordinate`);
      const cellKey = `${cell.row},${cell.col}`;
      if (!boardCells.has(cellKey)) throw new Error(`scenario region ${id} references unknown cell: ${cellKey}`);
      if (!seen.has(cellKey)) { seen.add(cellKey); cells.push(cell); }
    }
    if (!cells.length) throw new Error(`scenario region ${id} is empty`);
    regions[id] = {
      name: String(value.name || id),
      shortLabel: String(value.shortLabel || value.name || id).slice(0, 8),
      kind: String(value.kind || ''),
      color: String(value.color || ''),
      borderColor: String(value.borderColor || ''),
      cells
    };
  }
  const areaBindings = source.deployment?.areaBindings || {};
  for (const player of ['attacker', 'defender']) {
    if (!validDefinitionId(areaBindings[player]) || !Object.hasOwn(regions, areaBindings[player])) {
      throw new Error(`scenario deployment is missing a valid ${player} area binding`);
    }
  }
  const targetRegion = source.victory?.attackerTargetRegion;
  if (!validDefinitionId(targetRegion) || !Object.hasOwn(regions, targetRegion)) {
    throw new Error('scenario victory is missing a valid attacker target region');
  }
  const roundLimitSource = source.victory?.roundLimit;
  let roundLimit = null;
  if (roundLimitSource != null) {
    const round = Number(roundLimitSource.round);
    const winner = String(roundLimitSource.winner || '');
    const reason = String(roundLimitSource.reason || '');
    if (!Number.isInteger(round) || round < 1 || round > 100000) throw new Error('scenario victory has an invalid round limit');
    if (winner !== 'attacker' && winner !== 'defender') throw new Error('scenario victory round limit has an invalid winner');
    if (!validDefinitionId(reason)) throw new Error('scenario victory round limit has an invalid reason');
    roundLimit = { round, winner, reason };
  }
  const unitProfiles = source.deployment?.unitProfiles || {};
  for (const [id, profile] of Object.entries(unitProfiles)) {
    if (!Object.hasOwn(dependencies.unitTypeDefinitions, id)) throw new Error(`scenario rules references unknown unit type: ${id}`);
    const players = Array.isArray(profile?.allowedPlayers) ? profile.allowedPlayers : [];
    if (players.some(player => player !== 'attacker' && player !== 'defender')) throw new Error(`scenario rules has an invalid player in ${id}.allowedPlayers`);
  }
  return freezeDefinition(copyDefinition({
    schemaVersion: schemaVersionOf(source, 'scenario rules'),
    contentVersion: Number(source.contentVersion) || 1,
    id: source.id,
    requires: source.requires,
    regions,
    deployment: { areaBindings, unitProfiles },
    configDefaults: source.configDefaults || {},
    victory: { ...(source.victory || {}), roundLimit }
  }));
}

function assembleBattleDefinition(catalogEntry) {
  const manifest = normalizeBattleManifest(loadReferencedDefinition(catalogEntry.manifest, `battle ${catalogEntry.id} manifest`), catalogEntry.id);
  if (!manifest.enabled || !catalogEntry.enabled) return null;

  const terrainTypes = normalizeTerrainTypesDefinition(loadReferencedDefinition(manifest.resources.terrainTypes, `${manifest.id}.terrainTypes`));
  const unitTypes = normalizeUnitTypesDefinition(loadReferencedDefinition(manifest.resources.unitTypes, `${manifest.id}.unitTypes`));
  const combatRules = normalizeCombatRulesDefinition(
    loadReferencedDefinition(manifest.resources.combatRules, `${manifest.id}.combatRules`),
    terrainTypes,
    unitTypes
  );
  const gameRules = normalizeGameRulesDefinition(
    loadReferencedDefinition(manifest.resources.gameRules, `${manifest.id}.gameRules`),
    combatRules,
    unitTypes
  );
  const aiProfile = manifest.resources.aiProfile
    ? normalizeAiProfileDefinition(loadReferencedDefinition(manifest.resources.aiProfile, `${manifest.id}.aiProfile`), terrainTypes, unitTypes)
    : null;
  const rawMap = loadReferencedDefinition(manifest.resources.map, `${manifest.id}.map`);
  if (rawMap.terrainTypeSet !== terrainTypes.id) throw new Error(`map requires terrain types ${rawMap.terrainTypeSet || '(missing)'}`);
  const baseBoard = normalizeBoardDefinition({ ...rawMap, deploymentRows: gameRules.deployment.rows || {} });
  const scenarioRules = manifest.resources.scenarioRules
    ? normalizeScenarioRulesDefinition(
      loadReferencedDefinition(manifest.resources.scenarioRules, `${manifest.id}.scenarioRules`),
      {
        terrainTypes: terrainTypes.id,
        unitTypes: unitTypes.id,
        map: baseBoard.id,
        combatRules: combatRules.id,
        gameRules: gameRules.id,
        unitTypeDefinitions: unitTypes.unitTypes
      },
      baseBoard
    )
    : null;
  const deploymentAreas = scenarioRules
    ? Object.fromEntries(['attacker', 'defender'].map(player => [player, scenarioRules.regions[scenarioRules.deployment.areaBindings[player]].cells]))
    : {};
  const board = scenarioRules
    ? freezeDefinition({ ...baseBoard, deploymentRows: {}, deploymentAreas, regions: scenarioRules.regions })
    : baseBoard;
  for (const row of board.rows) {
    for (const cell of row.cells) {
      if (!Object.hasOwn(terrainTypes.terrainTypes, cell.terrain)) {
        throw new Error(`map cell ${row.id},${cell.col} references unknown terrain type: ${cell.terrain}`);
      }
    }
  }

  const combinedUnits = {};
  for (const [id, identity] of Object.entries(unitTypes.unitTypes)) {
    combinedUnits[id] = {
      ...identity,
      ...combatRules.unitProfiles[id],
      ...gameRules.deployment.unitProfiles[id],
      ...(scenarioRules?.deployment.unitProfiles[id] || {}),
      ai: aiProfile?.evaluation.unitProfiles[id] || {}
    };
  }
  const units = normalizeUnitsDefinition({ id: unitTypes.id, units: combinedUnits });

  const combinedTerrain = {};
  for (const [id, identity] of Object.entries(terrainTypes.terrainTypes)) {
    combinedTerrain[id] = { ...identity, ...combatRules.terrainProfiles[id] };
  }
  const runtimeAi = { ...(aiProfile?.evaluation || {}) };
  delete runtimeAi.unitProfiles;
  const scenarioVictory = scenarioRules ? {
    attackerTargetCells: scenarioRules.regions[scenarioRules.victory.attackerTargetRegion].cells,
    attackerTargetReason: String(scenarioRules.victory.reason || 'attacker_reached_target_region'),
    roundLimit: scenarioRules.victory.roundLimit,
    messages: { ...(gameRules.victory.messages || {}), ...(scenarioRules.victory.messages || {}) }
  } : {};
  const rules = normalizeRulesDefinition({
    schemaVersion: 1,
    id: manifest.id,
    version: manifest.contentVersion,
    terrain: combinedTerrain,
    combat: combatRules.combat,
    configDefaults: { ...gameRules.configDefaults, ...(scenarioRules?.configDefaults || {}) },
    simultaneous: gameRules.simultaneous,
    victory: { ...gameRules.victory, ...scenarioVictory },
    ai: { ...runtimeAi, profile: aiProfile },
    turn: gameRules.turn,
    ui: gameRules.ui
  }, units);

  const runtimeVariant = freezeDefinition({
    id: manifest.id,
    name: manifest.name,
    category: manifest.category,
    enabled: true,
    engine: manifest.engine,
    supportsAi: manifest.supportsAi,
    aiProfileId: aiProfile?.id || null,
    boardPath: manifest.resources.map.path,
    unitsPath: manifest.resources.unitTypes.path,
    rulesPath: manifest.resources.gameRules.path,
    boardId: board.id
  });
  return freezeDefinition({
    variant: runtimeVariant,
    manifest,
    terrainTypes,
    unitTypes,
    combatRules,
    gameRules,
    aiProfile,
    scenarioRules,
    board,
    units,
    rules
  });
}

const BATTLE_CATALOG = normalizeBattleCatalog(loadSerializedDefinition('battle-catalog.json'));
const VARIANT_DEFINITIONS = {};
const BOARD_DEFINITIONS = {};
for (const [id, catalogEntry] of Object.entries(BATTLE_CATALOG)) {
  if (!catalogEntry.enabled) continue;
  try {
    const definitions = assembleBattleDefinition(catalogEntry);
    if (!definitions) continue;
    VARIANT_DEFINITIONS[id] = definitions;
    BOARD_DEFINITIONS[definitions.board.id] = definitions.board;
  } catch (err) {
    console.error(`[DEFINITIONS] Skipping battle ${id}:`, err.message);
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
  reinforcement: Number(RULE_DEFINITIONS.configDefaults?.reinforcement) >= 0 ? Number(RULE_DEFINITIONS.configDefaults.reinforcement) : FALLBACK_CONFIG.reinforcement,
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
    rules: definitions.rules,
    aiProfile: definitions.aiProfile
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
    ui: definitions.rules.ui || {},
    simultaneous: definitions.rules.simultaneous || {}
  }));
}

function deploymentRowFor(g, player) {
  const board = BOARD_DEFINITIONS[g?.boardId] || boardForVariant(g?.variantId);
  const explicit = board.deploymentRows?.[player];
  if (isBoardRow(Number(explicit))) return Number(explicit);
  const rows = new Set((board.deploymentAreas?.[player] || []).map(cell => Number(cell.row)));
  return rows.size === 1 ? [...rows][0] : null;
}

function deploymentCellsFor(g, player) {
  const board = BOARD_DEFINITIONS[g?.boardId] || boardForVariant(g?.variantId);
  const area = board.deploymentAreas?.[player];
  if (Array.isArray(area) && area.length) return area.map(cell => ({ row: Number(cell.row), col: Number(cell.col) }));
  const row = deploymentRowFor(g, player);
  return (board.rows.find(item => item.id === row)?.cells || []).map(cell => ({ row, col: cell.col }));
}

function isDeploymentCell(g, player, row, col) {
  return deploymentCellsFor(g, player).some(cell => cell.row === row && cell.col === col);
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
  if (!rule || !Array.isArray(rule.attackerTypes) || !rule.attackerTypes.includes(attacker.type)) return false;
  const targetMatches = Array.isArray(rule.targetTypes) && rule.targetTypes.includes(target.type);
  const terrainMatches = Array.isArray(rule.terrainTypes)
    && rule.terrainTypes.includes(terrainIdAt(target.row, target.col, g.boardId));
  return targetMatches || terrainMatches;
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
  const simultaneousRules = definitions.rules.simultaneous || {};
  const turnMode = config.turnMode === 'simultaneous' && simultaneousRules.enabled !== false ? 'simultaneous' : 'sequential';
  const effectiveConfig = { ...config, turnMode };
  return {
    round: 1,
    currentPlayer: turnMode === 'simultaneous' ? 'both' : 'attacker',
    attackerReinforcement: effectiveConfig.reinforcement,
    nextUnitId: 1,
    units: [],
    state: 'waiting',
    winner: null,
    log: [],
    config: effectiveConfig,
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
    winnerReason: null,
    turnMode,
    phase: 'waiting',
    plans: { attacker: null, defender: null },
    planningDeadline: null
  };
}

function unitAt(g, row, col) { return g.units.find(u => u.row === row && u.col === col); }
function getUnit(g, id) { return g.units.find(u => u.id === id); }
function alive(g, player) { return g.units.filter(u => !player || u.player === player); }
function countType(g, player, type) { return alive(g, player).filter(u => u.type === type).length; }

function canSelectUnit(g, unit, player) {
  if (!unit || unit.player !== player || g.state !== 'playing') return false;
  if (g.turnMode === 'simultaneous') return g.phase === 'planning' && !g.plans?.[player]?.submitted && unit.canAct && unit.deployedRound !== g.round;
  return g.currentPlayer === player && unit.canAct;
}

function legalDeployments(g, player) {
  if ((player !== 'attacker' && player !== 'defender') || g.state !== 'playing') return [];
  if (g.turnMode === 'simultaneous' && (g.phase !== 'planning' || g.plans?.[player]?.submitted)) return [];
  const plan = g.turnMode === 'simultaneous' ? (g.plans?.[player] || createSimultaneousPlan()) : null;
  const pending = plan?.deployments || [];
  const hasAllowedType = Object.entries(g.rules?.units || {}).some(([type, definition]) => {
    if (!definition.allowedPlayers?.includes(player)) return false;
    const max = g.config[player === 'attacker' ? 'attackerMax' : 'defenderMax']?.[type] ?? 0;
    return countType(g, player, type) + pending.filter(item => item.type === type).length < max;
  });
  if (!hasAllowedType || (player === 'attacker' && g.attackerReinforcement - pending.length <= 0)) return [];
  return deploymentCellsFor(g, player)
    .filter(cell => !unitAt(g, cell.row, cell.col) && !pending.some(item => item.row === cell.row && item.col === cell.col));
}

function addLog(g, text) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  g.log.push(`[${t}] ${text}`);
  if (g.log.length > 120) g.log.shift();
}

function setEvent(g, event) { g.lastEvent = { ...event, at: Date.now() }; }

function createSimultaneousPlan() {
  return { submitted: false, deployments: [], actions: {} };
}

function serializePlan(plan) {
  return serializeDefinition(plan || createSimultaneousPlan());
}

function deserializePlan(serialized) {
  const source = deserializeDefinition(serialized, 'plan');
  const deployments = Array.isArray(source.deployments) ? source.deployments.slice(0, 100).map(item => ({ type: String(item?.type || ''), row: Number(item?.row), col: Number(item?.col) })).filter(item => item.type && isBoardRow(item.row) && Number.isInteger(item.col)) : [];
  const actions = {};
  const rawActions = source.actions && typeof source.actions === 'object' ? source.actions : {};
  for (const [id, item] of Object.entries(rawActions).slice(0, 200)) {
    const unitId = Number(item?.unitId ?? id);
    if (!Number.isInteger(unitId)) continue;
    const action = { unitId };
    if (item.shootTargetId != null && Number.isInteger(Number(item.shootTargetId))) action.shootTargetId = Number(item.shootTargetId);
    if (item.moveTo && isBoardRow(Number(item.moveTo.row)) && Number.isInteger(Number(item.moveTo.col))) action.moveTo = { row: Number(item.moveTo.row), col: Number(item.moveTo.col) };
    if (item.end === true) action.end = true;
    actions[unitId] = action;
  }
  return { submitted: source.submitted === true, deployments, actions };
}

function prepareSimultaneousPlanning(g) {
  g.turnMode = 'simultaneous';
  g.currentPlayer = 'both';
  g.phase = 'planning';
  g.plans = { attacker: createSimultaneousPlan(), defender: createSimultaneousPlan() };
  const timeout = Number(g.rules?.simultaneous?.planningTimeoutMs);
  g.planningDeadline = Number.isFinite(timeout) && timeout > 0 ? Date.now() + timeout : null;
  for (const unit of g.units) {
    unit.hits = 0;
    unit.moved = false;
    unit.shot = false;
    unit.moveSteps = 0;
    unit.lastShotTarget = null;
    unit.turnActionStarted = false;
    unit.canAct = unit.deployedRound === g.round ? false : true;
  }
}

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
  if (isBoardRow(Number(specialEntry.fromRow)) && Number(specialEntry.fromRow) !== unit.row) return true;
  if (isBoardRow(Number(specialEntry.toRow)) && Number(specialEntry.toRow) !== tr) return true;
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

function attackerVictoryCells(g) {
  const explicit = g.rules?.victory?.attackerTargetCells;
  if (Array.isArray(explicit) && explicit.length) return explicit;
  const targetRow = Number(g.rules?.victory?.attackerTargetRow);
  if (!Number.isInteger(targetRow)) return [];
  return (boardDefinition(g.boardId).rows.find(row => row.id === targetRow)?.cells || []).map(cell => ({ row: targetRow, col: cell.col }));
}

function isAttackerVictoryCell(g, row, col) {
  return attackerVictoryCells(g).some(cell => Number(cell.row) === row && Number(cell.col) === col);
}

function checkEnd(g, { completedRound = null } = {}) {
  const a1 = g.units.find(u => u.player === 'attacker' && isAttackerVictoryCell(g, u.row, u.col));
  if (a1) {
    g.state = 'ended';
    g.phase = 'ended';
    g.winner = 'attacker';
    g.winnerReason = String(g.rules?.victory?.attackerTargetReason || 'attacker_reached_first_row');
    addLog(g, `进攻方 ${unitDefinition(a1.type, g)?.name || a1.type}#${a1.id} 到达目标区域，进攻方胜利。`);
    setEvent(g, { type: 'win', winner: 'attacker', unitId: a1.id });
    return true;
  }
  if (g.attackerReinforcement === 0 && alive(g, 'attacker').length === 0) {
    g.state = 'ended';
    g.phase = 'ended';
    g.winner = 'defender';
    g.winnerReason = 'attacker_eliminated';
    addLog(g, '进攻方增援耗尽且场上全灭，防守方胜利。');
    setEvent(g, { type: 'win', winner: 'defender' });
    return true;
  }
  const roundLimit = g.rules?.victory?.roundLimit;
  if (roundLimit && Number(completedRound) >= Number(roundLimit.round)) {
    const winner = roundLimit.winner === 'attacker' ? 'attacker' : 'defender';
    g.state = 'ended';
    g.phase = 'ended';
    g.winner = winner;
    g.winnerReason = String(roundLimit.reason || 'round_limit_reached');
    addLog(g, `第${roundLimit.round}回合结束，${winner === 'attacker' ? '进攻方' : '防守方'}胜利。`);
    setEvent(g, { type: 'win', winner, reason: g.winnerReason });
    return true;
  }
  return false;
}

function deploy(g, player, type, row, col) {
  if (g.state !== 'playing') throw new Error('游戏尚未开始或已经结束');
  if (g.currentPlayer !== player) throw new Error('尚未轮到你');
  if (!unitDefinition(type, g)) throw new Error('未知兵种');
  if (!isDeploymentCell(g, player, row, col)) throw new Error('只能部署在本方部署区域');
  if (!validCell(row, col, g.boardId)) throw new Error('无效格子');
  if (unitAt(g, row, col)) throw new Error('该位置已有单位');
  if (!unitDefinition(type, g)?.allowedPlayers?.includes(player)) throw new Error('该阵营不能部署此兵种');
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

  if (player === 'attacker' && isAttackerVictoryCell(g, row, col)) { checkEnd(g); return; }
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

  const completedRound = player === 'defender' ? g.round : null;
  g.currentPlayer = player === 'attacker' ? 'defender' : 'attacker';
  if (g.currentPlayer === 'attacker') g.round++;
  g.lastEvent = null;
  if (checkEnd(g, { completedRound })) return;
  resetTurnForCurrentPlayer(g);
  if (g.state === 'playing') addLog(g, `${g.currentPlayer === 'attacker' ? '进攻方' : '防守方'}开始第${g.round}回合。`);
}

function simultaneousPlanFor(g, player) {
  if (!g.plans[player]) g.plans[player] = createSimultaneousPlan();
  return g.plans[player];
}

function ensureSimultaneousPlanning(g, player) {
  if (g.turnMode !== 'simultaneous' || g.state !== 'playing' || g.phase !== 'planning') throw new Error('当前不是同时回合规划阶段');
  if (player !== 'attacker' && player !== 'defender') throw new Error('观战者不能规划行动');
  const plan = simultaneousPlanFor(g, player);
  if (plan.submitted) throw new Error('本回合规划已经提交');
  return plan;
}

function plannedDeploymentAt(plan, row, col) {
  return plan.deployments.some(item => item.row === row && item.col === col);
}

function planSimultaneousDeploy(g, player, type, row, col) {
  const plan = ensureSimultaneousPlanning(g, player);
  const definition = unitDefinition(type, g);
  if (!definition) throw new Error('未知兵种');
  if (!isDeploymentCell(g, player, row, col)) throw new Error('只能部署在本方部署区域');
  if (!validCell(row, col, g.boardId)) throw new Error('无效格子');
  if (unitAt(g, row, col) || plannedDeploymentAt(plan, row, col)) throw new Error('该位置已被占用或已计划部署');
  if (!definition.allowedPlayers?.includes(player)) throw new Error('该阵营不能部署此兵种');
  const maxima = g.config[player === 'attacker' ? 'attackerMax' : 'defenderMax'] || {};
  if (countType(g, player, type) + plan.deployments.filter(item => item.type === type).length >= (maxima[type] ?? 0)) throw new Error('该兵种已达到房主设置的上限');
  if (player === 'attacker' && g.attackerReinforcement - plan.deployments.length <= 0) throw new Error('增援已经耗尽');
  if (!g.rules?.simultaneous?.deployDuringPlanning) throw new Error('当前玩法不允许规划阶段部署');
  plan.deployments.push({ type, row, col });
}

function planSimultaneousAction(g, player, actionType, unitId, row, col, targetId) {
  const plan = ensureSimultaneousPlanning(g, player);
  const unit = getUnit(g, Number(unitId));
  if (!unit || unit.player !== player) throw new Error('单位不存在或不是你的单位');
  if (!unit.canAct || unit.deployedRound === g.round) throw new Error('该单位本回合不能行动');
  const existing = { ...(plan.actions[unit.id] || { unitId: unit.id }), moveTo: plan.actions[unit.id]?.moveTo ? { ...plan.actions[unit.id].moveTo } : undefined };
  if (existing.end) throw new Error('该单位已结束规划');
  if (actionType === 'move') {
    if (!isBoardRow(row) || !Number.isInteger(col)) throw new Error('移动目标无效');
    if (!moveTargets(g, unit).some(item => item.row === row && item.col === col)) throw new Error('不可移动到该位置');
    existing.moveTo = { row, col };
  } else if (actionType === 'shoot') {
    const target = getUnit(g, Number(targetId));
    if (!target || target.player === player) throw new Error('射击目标无效');
    if (!shootTargets(g, unit).some(item => item.id === target.id)) throw new Error('目标不在射程内');
    existing.shootTargetId = target.id;
  } else if (actionType === 'endUnit') {
    existing.end = true;
  } else {
    throw new Error('未知规划操作');
  }
  if (existing.moveTo && existing.shootTargetId && g.rules?.simultaneous?.allowShootAndMove === false) throw new Error('当前规则不允许同时规划射击和移动');
  plan.actions[unit.id] = existing;
}

function publicPlanFor(g, player) {
  const plan = g.plans?.[player];
  if (!plan) return { submitted: false, deployments: [], actions: [] };
  return {
    submitted: !!plan.submitted,
    deployments: plan.deployments.map(item => ({ ...item })),
    actions: Object.values(plan.actions).map(item => ({ ...item, moveTo: item.moveTo ? { ...item.moveTo } : undefined }))
  };
}

function randomIndex(length) {
  return length > 1 ? crypto.randomInt(0, length) : 0;
}

function resolveSimultaneousRound(g) {
  if (g.turnMode !== 'simultaneous' || g.phase !== 'planning') return;
  g.phase = 'resolving';
  const rules = g.rules?.simultaneous || {};
  const plans = { attacker: g.plans?.attacker || createSimultaneousPlan(), defender: g.plans?.defender || createSimultaneousPlan() };
  const deploymentCandidates = [];
  const deploymentSeen = new Set();
  for (const player of ['attacker', 'defender']) {
    const plan = plans[player];
    const maxima = g.config[player === 'attacker' ? 'attackerMax' : 'defenderMax'] || {};
    const pendingCounts = {};
    for (const item of plan.deployments || []) {
      const definition = unitDefinition(item.type, g);
      const deploymentKey = `${player}:${item.row},${item.col}`;
      if (!definition || deploymentSeen.has(deploymentKey)) continue;
      deploymentSeen.add(deploymentKey);
      if (!definition.allowedPlayers?.includes(player) || !isDeploymentCell(g, player, item.row, item.col) || !validCell(item.row, item.col, g.boardId)) continue;
      if (unitAt(g, item.row, item.col)) continue;
      pendingCounts[item.type] = (pendingCounts[item.type] || 0) + 1;
      if (countType(g, player, item.type) + pendingCounts[item.type] > (maxima[item.type] ?? 0)) { pendingCounts[item.type]--; continue; }
      if (player === 'attacker' && deploymentCandidates.filter(candidate => candidate.player === player).length >= g.attackerReinforcement) continue;
      deploymentCandidates.push({ ...item, player });
    }
  }
  const deploymentGroups = new Map();
  for (const candidate of deploymentCandidates) {
    const cell = key(candidate.row, candidate.col);
    const group = deploymentGroups.get(cell) || [];
    group.push(candidate);
    deploymentGroups.set(cell, group);
  }
  const acceptedDeployments = [];
  for (const group of deploymentGroups.values()) acceptedDeployments.push(group[randomIndex(group.length)]);
  for (const deployment of acceptedDeployments) {
    const unit = createUnit(g, deployment.player, deployment.type, deployment.row, deployment.col);
    unit.deployedRound = g.round;
    unit.canAct = false;
    if (deployment.player === 'attacker') g.attackerReinforcement--;
    addLog(g, `${deployment.player === 'attacker' ? '进攻方' : '防守方'}部署${unitDefinition(deployment.type, g)?.name || deployment.type}#${unit.id}。`);
  }

  const unitsAtPlanStart = new Map(g.units.filter(unit => unit.deployedRound !== g.round).map(unit => [unit.id, { ...unit }]));
  const shots = [];
  const damage = new Map();
  const instantKills = new Set();
  for (const player of ['attacker', 'defender']) {
    for (const action of Object.values(plans[player].actions || {})) {
      if (!action.shootTargetId) continue;
      const shooter = unitsAtPlanStart.get(Number(action.unitId));
      const target = unitsAtPlanStart.get(Number(action.shootTargetId));
      if (!shooter || !target || shooter.player !== player || target.player === player) continue;
      const range = Number(unitDefinition(shooter.type, g)?.range) || 1;
      if (graphDistance(shooter.row, shooter.col, target.row, target.col, g.boardId) > range) continue;
      const liveShooter = getUnit(g, shooter.id);
      if (liveShooter) {
        liveShooter.shot = true;
        liveShooter.turnActionStarted = true;
        liveShooter.lastShotTarget = { row: target.row, col: target.col };
      }
      const shot = { attackerId: shooter.id, attackerType: shooter.type, targetId: target.id, targetType: target.type, result: 'hit' };
      if (immune(g, target, shooter)) shot.result = 'immune';
      else if (isInstantKill(g, shooter, target)) { shot.result = 'instant_kill'; instantKills.add(target.id); }
      else damage.set(target.id, (damage.get(target.id) || 0) + 1);
      shots.push(shot);
    }
  }
  const hitsToDestroy = Number(g.rules?.combat?.hitsToDestroy) || 2;
  const killedIds = new Set(instantKills);
  for (const [targetId, amount] of damage) {
    const target = getUnit(g, targetId);
    if (!target) continue;
    target.hits += amount;
    if (target.hits >= hitsToDestroy) killedIds.add(target.id);
  }
  const deadUnits = g.units.filter(unit => killedIds.has(unit.id)).map(unit => ({ ...unit }));
  g.units = g.units.filter(unit => !killedIds.has(unit.id));
  for (const shot of shots) {
    const attackerName = unitDefinition(shot.attackerType, g)?.name || shot.attackerType;
    const targetName = unitDefinition(shot.targetType, g)?.name || shot.targetType;
    if (shot.result === 'immune') addLog(g, `${attackerName}#${shot.attackerId}射击${targetName}#${shot.targetId}，未造成伤害。`);
    else if (shot.result === 'instant_kill') addLog(g, `${attackerName}#${shot.attackerId}击毁${targetName}#${shot.targetId}。`);
    else addLog(g, `${attackerName}#${shot.attackerId}命中${targetName}#${shot.targetId}。`);
  }
  for (const dead of deadUnits) addLog(g, `${unitDefinition(dead.type, g)?.name || dead.type}#${dead.id}被击杀。`);
  setEvent(g, { type: 'simultaneousResolution', phase: 'shoot', shots, killed: deadUnits });
  if (checkEnd(g)) { g.phase = 'ended'; return; }

  const occupiedAtMovementStart = new Map(g.units.map(unit => [key(unit.row, unit.col), unit.id]));
  const candidates = [];
  for (const player of ['attacker', 'defender']) {
    for (const action of Object.values(plans[player].actions || {})) {
      if (!action.moveTo || action.end) continue;
      if (action.shootTargetId && rules.allowShootAndMove === false) continue;
      const unit = getUnit(g, Number(action.unitId));
      if (!unit || unit.player !== player || unit.deployedRound === g.round) continue;
      const maxSteps = Number(unitDefinition(unit.type, g)?.maxMoveSteps) || 1;
      const path = legalPath(g, unit, Number(action.moveTo.row), Number(action.moveTo.col), maxSteps);
      if (!path?.length) continue;
      const crossesOccupiedOrigin = path.some(([row, col]) => {
        const occupant = occupiedAtMovementStart.get(key(row, col));
        return occupant != null && occupant !== unit.id;
      });
      if (crossesOccupiedOrigin) continue;
      candidates.push({ unit, player, path, origin: { row: unit.row, col: unit.col }, failed: false });
    }
  }
  const positions = new Map(g.units.map(unit => [unit.id, { row: unit.row, col: unit.col }]));
  const occupancy = new Map(g.units.map(unit => [key(unit.row, unit.col), unit.id]));
  const maxPath = candidates.reduce((max, candidate) => Math.max(max, candidate.path.length), 0);
  const restoreOrigin = candidate => {
    candidate.failed = true;
    const originKey = key(candidate.origin.row, candidate.origin.col);
    occupancy.set(originKey, candidate.unit.id);
    positions.set(candidate.unit.id, { ...candidate.origin });
  };
  for (let step = 1; step <= maxPath; step++) {
    const active = candidates.filter(candidate => !candidate.failed && candidate.path.length >= step);
    if (!active.length) continue;
    for (const candidate of active) occupancy.delete(key(positions.get(candidate.unit.id).row, positions.get(candidate.unit.id).col));
    const groups = new Map();
    for (const candidate of active) {
      const destination = candidate.path[step - 1];
      const destinationKey = key(destination[0], destination[1]);
      const group = groups.get(destinationKey) || [];
      group.push(candidate);
      groups.set(destinationKey, group);
    }
    for (const [destinationKey, group] of groups) {
      const blockedBy = occupancy.get(destinationKey);
      if (blockedBy != null) { group.forEach(restoreOrigin); continue; }
      const winner = group[randomIndex(group.length)];
      for (const candidate of group) {
        if (candidate === winner) continue;
        restoreOrigin(candidate);
      }
      const [row, col] = destinationKey.split(',').map(Number);
      positions.set(winner.unit.id, { row, col });
      occupancy.set(destinationKey, winner.unit.id);
    }
  }
  const successfulMoves = [];
  for (const candidate of candidates) {
    if (candidate.failed) continue;
    const position = positions.get(candidate.unit.id);
    if (!position || (position.row === candidate.origin.row && position.col === candidate.origin.col)) continue;
    candidate.unit.row = position.row;
    candidate.unit.col = position.col;
    candidate.unit.moved = true;
    candidate.unit.moveSteps = candidate.path.length;
    candidate.unit.turnActionStarted = true;
    candidate.unit.canAct = false;
    successfulMoves.push({ unitId: candidate.unit.id, unitType: candidate.unit.type, from: candidate.origin, to: position, distance: candidate.path.length });
    addLog(g, `${candidate.player === 'attacker' ? '进攻方' : '防守方'}${unitDefinition(candidate.unit.type, g)?.name || candidate.unit.type}#${candidate.unit.id}移动到(${position.row},${displayCol(position.row, position.col, g.boardId)})。`);
  }
  for (const unit of g.units) unit.canAct = false;
  setEvent(g, { type: 'simultaneousResolution', phase: 'move', moves: successfulMoves, killed: deadUnits });
  if (checkEnd(g, { completedRound: g.round })) { g.phase = 'ended'; return; }
  g.round++;
  prepareSimultaneousPlanning(g);
}

function submitSimultaneousPlan(g, player) {
  const plan = ensureSimultaneousPlanning(g, player);
  plan.submitted = true;
  if (g.plans.attacker?.submitted && g.plans.defender?.submitted) resolveSimultaneousRound(g);
}

function submitEmptyPlansOnTimeout(room) {
  const g = room?.game;
  if (!g || g.turnMode !== 'simultaneous' || g.phase !== 'planning') return false;
  for (const player of ['attacker', 'defender']) {
    const plan = simultaneousPlanFor(g, player);
    if (!plan.submitted) plan.submitted = true;
  }
  resolveSimultaneousRound(g);
  return true;
}

function scheduleSimultaneousDeadline(room) {
  if (!room || room.game.turnMode !== 'simultaneous' || room.game.phase !== 'planning') return;
  if (room.planningTimer) clearTimeout(room.planningTimer);
  const deadline = Number(room.game.planningDeadline);
  const delay = Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : 0;
  room.planningTimer = setTimeout(() => {
    room.planningTimer = null;
    if (submitEmptyPlansOnTimeout(room)) {
      broadcast(room);
      broadcastLobby();
      scheduleBotTurn(room);
    }
  }, delay || 120000);
}

function displayCol(row, col, boardId = 'classic') {
  const cell = boardDefinition(boardId).rows.find(item => item.id === row)?.cells.find(item => item.col === col);
  return cell?.displayCol ?? String(col + 1);
}

function publicState(g, you) {
  const youUnits = g.units.filter(u => u.player === you).map(u => ({
    ...u,
    selectable: canSelectUnit(g, u, you),
    legalMoves: canSelectUnit(g, u, you) ? moveTargets(g, u) : [],
    legalShots: canSelectUnit(g, u, you) ? shootTargets(g, u).map(t => t.id) : []
  }));
  const visibleUnits = g.units.map(u => ({ ...u, selectable: canSelectUnit(g, u, you) }));
  return {
    round: g.round,
    currentPlayer: g.currentPlayer,
    attackerReinforcement: g.attackerReinforcement,
    units: visibleUnits,
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
    botDifficulty: g.botDifficulty,
    turnMode: g.turnMode,
    phase: g.phase,
    planningDeadline: g.planningDeadline,
    planning: {
      you: you === 'attacker' || you === 'defender' ? publicPlanFor(g, you) : { submitted: false, deployments: [], actions: [] },
      attackerSubmitted: !!g.plans?.attacker?.submitted,
      defenderSubmitted: !!g.plans?.defender?.submitted
    },
    legalDeployments: legalDeployments(g, you)
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
      turnMode: room.game.turnMode,
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
  const definitions = definitionsForVariant(variantId);
  const units = definitions.units;
  const attackerMax = {}, defenderMax = {};
  for (const [type, definition] of Object.entries(units)) {
    const defaults = definition.deployLimit || {};
    attackerMax[type] = Number.isFinite(Number(defaults.attacker)) ? Number(defaults.attacker) : 0;
    defenderMax[type] = Number.isFinite(Number(defaults.defender)) ? Number(defaults.defender) : 0;
  }
  return {
    reinforcement: Number(definitions.rules.configDefaults?.reinforcement) >= 0 ? Number(definitions.rules.configDefaults.reinforcement) : 0,
    attackerMax,
    defenderMax,
    allowDeployAfterAction: definitions.rules.configDefaults?.allowDeployAfterAction !== false
  };
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
    turnMode: raw.turnMode === 'simultaneous' ? 'simultaneous' : 'sequential',
    allowDeployAfterAction: raw.allowDeployAfterAction == null
      ? defaults.allowDeployAfterAction
      : raw.allowDeployAfterAction === true
  };
}

function randomChoice(items) {
  return items.length ? items[Math.floor(Math.random() * items.length)] : null;
}

function aiProfileFor(g = null, variantId = 'classic') {
  return g?.rules?.ai?.profile || definitionsForVariant(variantId).aiProfile;
}

function normalizeBotDifficulty(value, variantId = 'classic') {
  const profile = aiProfileFor(null, variantId);
  return Object.hasOwn(profile.difficulties, value) ? value : profile.defaultDifficulty;
}

function botDifficultyProfile(g, difficulty) {
  const aiProfile = aiProfileFor(g, g?.variantId);
  return aiProfile.difficulties[Object.hasOwn(aiProfile.difficulties, difficulty) ? difficulty : aiProfile.defaultDifficulty];
}

function botExecutionProfile(g) {
  return aiProfileFor(g, g?.variantId).execution;
}

function opponentOf(player) {
  return player === 'attacker' ? 'defender' : 'attacker';
}

const GRAPH_DISTANCE_CACHE = new Map();

function graphDistance(fromRow, fromCol, toRow, toCol, boardId = 'classic') {
  if (fromRow === toRow && fromCol === toCol) return 0;
  const cacheKey = `${boardId}:${fromRow},${fromCol}`;
  let distances = GRAPH_DISTANCE_CACHE.get(cacheKey);
  if (!distances) {
    const board = boardDefinition(boardId);
    const cellCount = board.rows.reduce((total, row) => total + row.cells.length, 0);
    distances = bfs(fromRow, fromCol, cellCount, boardId);
    GRAPH_DISTANCE_CACHE.set(cacheKey, distances);
  }
  return distances.get(key(toRow, toCol)) ?? Number.MAX_SAFE_INTEGER;
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

function chooseRanked(items, difficulty, g = null) {
  if (!items.length) return null;
  const profile = botDifficultyProfile(g, difficulty);
  const scoreOf = item => Number(item.searchScore ?? item.score) || 0;
  const ranked = [...items].sort((a, b) => scoreOf(b) - scoreOf(a));
  const bestScore = scoreOf(ranked[0]);
  const nearBest = ranked.filter(item => scoreOf(item) >= bestScore - profile.nearBestWindow);
  return randomChoice(nearBest.slice(0, profile.topChoices));
}

function aiScore(g, group, name, fallback = 0) {
  const value = Number(g.rules?.ai?.[group]?.[name]);
  return Number.isFinite(value) ? value : fallback;
}

function botDeployChoices(g, player, planning = {}) {
  const plannedCounts = planning.plannedCounts || {};
  const pendingTotal = Object.values(plannedCounts).reduce((sum, value) => sum + (Number(value) || 0), 0);
  if (player === 'attacker' && g.attackerReinforcement - pendingTotal <= 0) return [];
  const blockedCells = planning.blockedCells || new Set();
  const emptyCells = deploymentCellsFor(g, player)
    .filter(cell => !unitAt(g, cell.row, cell.col) && !blockedCells.has(key(cell.row, cell.col)));
  if (!emptyCells.length) return [];

  const maxima = g.config[player === 'attacker' ? 'attackerMax' : 'defenderMax'];
  const enemies = alive(g, opponentOf(player));
  const aiRules = g.rules?.ai || {};
  const roleBonuses = aiRules.roleBonuses || {};
  const friendlyCount = alive(g, player).length + pendingTotal;
  return Object.keys(g.rules?.units || {}).flatMap(type => {
    if (!unitDefinition(type, g)?.allowedPlayers?.includes(player)) return [];
    const currentTypeCount = countType(g, player, type) + (Number(plannedCounts[type]) || 0);
    const remainingCapacity = (maxima[type] ?? 0) - currentTypeCount;
    if (remainingCapacity <= 0) return [];
    return emptyCells.map(cell => {
      const { row, col } = cell;
      let score = unitValue(type, g) + aiScore(g, 'deploymentScores', 'base', 15);
      score -= currentTypeCount * aiScore(g, 'deploymentScores', 'duplicatePenalty', 9);
      score += Math.min(remainingCapacity, 3) * aiScore(g, 'deploymentScores', 'remainingCapacityBonus', 8);
      score += neighbors(row, col, g.boardId).length * aiScore(g, 'deploymentScores', 'connectivityBonus', 3);
      if (friendlyCount === 0) score += aiScore(g, 'deploymentScores', 'emptyArmyBonus', 120);
      if (unitDefinition(type, g)?.ai?.role === 'antiTank') score += enemies.reduce((sum, enemy) => sum + aiCombatBonus(g, { type }, enemy, enemy.row, enemy.col), 0);
      if (unitDefinition(type, g)?.ai?.role === 'machineGun' && !enemies.some(u => unitDefinition(u.type, g)?.ai?.role === 'antiTank')) score += Number(roleBonuses.machineGunWithoutAntiTank ?? 0);
      if (enemies.length) {
        const nearestDistance = Math.min(...enemies.map(u => graphDistance(row, col, u.row, u.col, g.boardId)));
        score -= nearestDistance * aiScore(g, 'deploymentScores', 'enemyDistancePenalty', 3);
      }
      const goals = attackerVictoryCells(g);
      if (goals.length) {
        const goalDistance = Math.min(...goals.map(goal => graphDistance(row, col, Number(goal.row), Number(goal.col), g.boardId)));
        const goalWeight = player === 'attacker' ? 'attackerGoalProximity' : 'defenderGoalProximity';
        score -= goalDistance * aiScore(g, 'deploymentScores', goalWeight, player === 'attacker' ? 3 : 5);
      }
      return { type, row, col, score };
    });
  });
}

function chooseBotDeployment(g, player, difficulty) {
  return chooseRanked(botDeployChoices(g, player), difficulty, g);
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
  if (!isAttackerVictoryCell(g, row, col)) return 0;
  let value = 0;
  for (const attacker of alive(g, 'attacker')) {
    if (neighbors(attacker.row, attacker.col, g.boardId).some(([r, c]) => r === row && c === col)) {
      value += aiScore(g, 'actionScores', 'goalBlock', 800);
    }
  }
  return value;
}

function scoreShot(g, attacker, target) {
  if (!canDamageAt(g, attacker, target.type, target.row, target.col)) {
    return { score: -900, priority: 'none' };
  }

  const kill = shotWouldKill(g, attacker, target);
  let score = aiScore(g, 'actionScores', 'shotBase', 95) + unitValue(target.type, g);
  if (target.hits > 0) score += aiScore(g, 'actionScores', 'damagedTarget', 125);
  if (kill) {
    score += aiScore(g, 'actionScores', 'killBase', 560)
      + unitValue(target.type, g) * aiScore(g, 'actionScores', 'killValueMultiplier', 2);
  }
  if (target.player === 'attacker') {
    const goalDistance = Math.min(...attackerVictoryCells(g).map(cell => graphDistance(target.row, target.col, Number(cell.row), Number(cell.col), g.boardId)));
    const distanceScores = g.rules?.ai?.attackerThreatScoresByGoalDistance || {};
    score += Number(distanceScores[String(goalDistance)] || 0);
  }
  score += aiCombatBonus(g, attacker, target, target.row, target.col);
  return { score, priority: kill ? 'kill' : 'hit' };
}

function scoreMove(g, unit, target, difficulty) {
  const profile = botDifficultyProfile(g, difficulty);
  const enemies = alive(g, opponentOf(unit.player));
  let score = -target.distance * aiScore(g, 'actionScores', 'moveDistancePenalty', 2);

  if (unit.player === 'attacker') {
    if (isAttackerVictoryCell(g, target.row, target.col)) return { score: aiScore(g, 'actionScores', 'win', 100000), priority: 'win' };
    const explicitTargets = g.rules?.victory?.attackerTargetCells;
    if (Array.isArray(explicitTargets) && explicitTargets.length) {
      const before = Math.min(...explicitTargets.map(cell => graphDistance(unit.row, unit.col, Number(cell.row), Number(cell.col), g.boardId)));
      const after = Math.min(...explicitTargets.map(cell => graphDistance(target.row, target.col, Number(cell.row), Number(cell.col), g.boardId)));
      score += (before - after) * aiScore(g, 'actionScores', 'attackerProgress', 62);
    } else {
      score += (unit.row - target.row) * aiScore(g, 'actionScores', 'attackerProgress', 62);
    }
    const terrainScores = g.rules?.ai?.terrainScores || {};
    score += Number(terrainScores[terrainAt(target.row, target.col, g.boardId)] || 0);
  } else if (enemies.length) {
    const before = Math.min(...enemies.map(enemy => graphDistance(unit.row, unit.col, enemy.row, enemy.col, g.boardId)));
    const after = Math.min(...enemies.map(enemy => graphDistance(target.row, target.col, enemy.row, enemy.col, g.boardId)));
    score += (before - after) * aiScore(g, 'actionScores', 'defenderEngagement', 34);
    score += defensiveBlockValue(g, target.row, target.col) - defensiveBlockValue(g, unit.row, unit.col);
  }

  if (!unit.shot) {
    const bestFutureShot = enemies
      .filter(enemy => graphDistance(target.row, target.col, enemy.row, enemy.col, g.boardId) <= (Number(unitDefinition(unit.type, g)?.range) || 1))
      .map(enemy => scoreShot(g, { ...unit, row: target.row, col: target.col }, enemy).score)
      .reduce((best, value) => Math.max(best, value), 0);
    score += bestFutureShot * aiScore(g, 'actionScores', 'futureShotMultiplier', 0.18);
  }

  const mobility = neighbors(target.row, target.col, g.boardId)
    .filter(([r, c]) => !unitAt(g, r, c) && canEnterTerrain(g, unit, r, c)).length;
  score += mobility * aiScore(g, 'actionScores', 'moveMobility', 3) * profile.mobilityWeight;
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
    const stopScore = usefulShot || moves.length
      ? aiScore(g, 'actionScores', 'stopWithOptions', -35)
      : aiScore(g, 'actionScores', 'stopIdle', 5);
    actions.push({ type: 'stop', unitId: unit.id, score: stopScore, priority: 'stop' });
  }
  return actions;
}

function cloneGameForBotSearch(g) {
  return {
    ...g,
    units: g.units.map(unit => ({ ...unit, lastShotTarget: unit.lastShotTarget ? { ...unit.lastShotTarget } : null })),
    log: [],
    lastEvent: null,
    spectators: new Set()
  };
}

function applyBotAction(g, player, action) {
  if (action.type === 'shoot') shoot(g, player, action.unitId, action.targetId);
  else if (action.type === 'move') move(g, player, action.unitId, action.row, action.col);
  else endUnit(g, player, action.unitId);
}

function evaluateBotState(g, player) {
  const terminal = aiScore(g, 'stateWeights', 'terminal', 100000);
  if (g.state === 'ended') return g.winner === player ? terminal : -terminal;

  const opponent = opponentOf(player);
  const materialWeight = aiScore(g, 'stateWeights', 'material', 1);
  const damageWeight = aiScore(g, 'stateWeights', 'damage', 0.6);
  const terrainWeight = aiScore(g, 'stateWeights', 'terrain', 0.5);
  const threatWeight = aiScore(g, 'stateWeights', 'threat', 0.7);
  const mobilityWeight = aiScore(g, 'stateWeights', 'mobility', 3);
  let score = 0;

  for (const unit of g.units) {
    const sign = unit.player === player ? 1 : -1;
    const value = unitValue(unit.type, g);
    score += sign * value * materialWeight;
    score -= sign * unit.hits * value * damageWeight;
    score += sign * Number(g.rules?.ai?.terrainScores?.[terrainAt(unit.row, unit.col, g.boardId)] || 0) * terrainWeight;
    score -= sign * threatAt(g, unit, unit.row, unit.col) * threatWeight;
    const mobility = neighbors(unit.row, unit.col, g.boardId)
      .filter(([row, col]) => !unitAt(g, row, col) && canEnterTerrain(g, unit, row, col)).length;
    score += sign * mobility * mobilityWeight;
  }

  const goals = attackerVictoryCells(g);
  if (goals.length) {
    const cellCount = boardDefinition(g.boardId).rows.reduce((sum, row) => sum + row.cells.length, 0);
    const roundLimit = Number(g.rules?.victory?.roundLimit?.round);
    const roundsLeft = Number.isFinite(roundLimit) ? Math.max(0, roundLimit - g.round) : null;
    const urgencyWindow = aiScore(g, 'stateWeights', 'roundUrgencyWindow', 5);
    const urgencyStep = aiScore(g, 'stateWeights', 'roundUrgencyStep', 0.2);
    const urgency = roundsLeft == null ? 1 : 1 + Math.max(0, urgencyWindow - roundsLeft) * urgencyStep;
    let attackerProgress = 0;
    for (const unit of alive(g, 'attacker')) {
      const distance = Math.min(...goals.map(goal => graphDistance(unit.row, unit.col, Number(goal.row), Number(goal.col), g.boardId)));
      attackerProgress += (cellCount - Math.min(distance, cellCount)) * aiScore(g, 'stateWeights', 'attackerGoalProgress', 18) * urgency;
      if (distance === 0) attackerProgress += aiScore(g, 'stateWeights', 'goalControl', 140);
    }
    let defenderCoverage = 0;
    for (const unit of alive(g, 'defender')) {
      const distance = Math.min(...goals.map(goal => graphDistance(unit.row, unit.col, Number(goal.row), Number(goal.col), g.boardId)));
      defenderCoverage += (cellCount - Math.min(distance, cellCount)) * aiScore(g, 'stateWeights', 'defenderGoalProximity', 10);
      if (distance === 0) defenderCoverage += aiScore(g, 'stateWeights', 'goalControl', 140);
    }
    score += (player === 'attacker' ? attackerProgress - defenderCoverage : defenderCoverage - attackerProgress);
  }

  const ownCapacity = Object.values(g.config[player === 'attacker' ? 'attackerMax' : 'defenderMax'] || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const enemyCapacity = Object.values(g.config[opponent === 'attacker' ? 'attackerMax' : 'defenderMax'] || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
  score += (Math.min(alive(g, player).length, ownCapacity) - Math.min(alive(g, opponent).length, enemyCapacity))
    * aiScore(g, 'stateWeights', 'fieldPresence', 12);
  return score;
}

function searchBotActions(g, player, difficulty, choices) {
  const profile = botDifficultyProfile(g, difficulty);
  if (profile.searchDepth < 2 || profile.futureDiscount <= 0) return choices;
  const deadline = Date.now() + profile.timeBudgetMs;
  const roots = [...choices]
    .sort((a, b) => b.score - a.score)
    .slice(0, profile.maxRootCandidates);
  const evaluated = [];
  let nodes = 0;
  const stateChangeWeight = aiScore(g, 'stateWeights', 'stateChange', 0.45);

  const continuationScore = (state, depth, stateScore) => {
    if (depth <= 0 || state.state !== 'playing' || nodes >= profile.maxNodes || Date.now() >= deadline) return 0;
    const candidates = botActionChoices(state, player, difficulty)
      .sort((a, b) => b.score - a.score)
      .slice(0, profile.maxBranching);
    let best = Number.NEGATIVE_INFINITY;
    for (const candidate of candidates) {
      if (nodes >= profile.maxNodes || Date.now() >= deadline) break;
      const child = cloneGameForBotSearch(state);
      try {
        applyBotAction(child, player, candidate);
        nodes++;
      } catch (_) {
        continue;
      }
      const childScore = evaluateBotState(child, player);
      const future = continuationScore(child, depth - 1, childScore);
      const total = candidate.score + (childScore - stateScore) * stateChangeWeight + future * profile.futureDiscount;
      best = Math.max(best, total);
    }
    return Number.isFinite(best) ? best : 0;
  };

  const initialStateScore = evaluateBotState(g, player);

  for (const action of roots) {
    if (nodes >= profile.maxNodes || Date.now() >= deadline) break;
    const simulated = cloneGameForBotSearch(g);
    try {
      applyBotAction(simulated, player, action);
      nodes++;
    } catch (_) {
      continue;
    }

    const simulatedScore = evaluateBotState(simulated, player);
    const futureScore = continuationScore(simulated, profile.searchDepth - 1, simulatedScore);
    evaluated.push({
      ...action,
      searchScore: action.score + (simulatedScore - initialStateScore) * stateChangeWeight + futureScore * profile.futureDiscount
    });
  }
  return evaluated.length ? evaluated : choices;
}

function chooseBotAction(g, player, difficulty) {
  const choices = botActionChoices(g, player, difficulty);
  const winning = choices.filter(action => action.priority === 'win');
  if (winning.length) return chooseRanked(winning, 'hard', g);
  const kills = choices.filter(action => action.priority === 'kill');
  if (kills.length) return chooseRanked(kills, difficulty, g);
  return chooseRanked(searchBotActions(g, player, difficulty, choices), difficulty, g);
}

function buildBotSimultaneousPlan(g, player, difficulty) {
  const plan = createSimultaneousPlan();
  const blockedCells = new Set(g.units.map(unit => key(unit.row, unit.col)));
  const plannedCounts = Object.fromEntries(Object.keys(g.rules?.units || {}).map(type => [type, 0]));
  const execution = botExecutionProfile(g);
  for (let i = 0; i < execution.maxStepsPerTurn; i++) {
    const choice = chooseRanked(botDeployChoices(g, player, { blockedCells, plannedCounts }), difficulty, g);
    if (!choice) break;
    plan.deployments.push({ type: choice.type, row: choice.row, col: choice.col });
    blockedCells.add(key(choice.row, choice.col));
    plannedCounts[choice.type] = (plannedCounts[choice.type] || 0) + 1;
    if (plan.deployments.length >= execution.maxDeploymentsPerPlan) break;
  }
  for (const unit of g.units.filter(item => item.player === player && item.canAct && item.deployedRound !== g.round)) {
    const action = chooseRanked(botActionChoices(g, player, difficulty).filter(item => item.unitId === unit.id && item.type !== 'stop'), difficulty, g);
    if (!action) continue;
    const item = { unitId: unit.id };
    if (action.type === 'shoot') item.shootTargetId = action.targetId;
    if (action.type === 'move') item.moveTo = { row: action.row, col: action.col };
    if (item.shootTargetId || item.moveTo) plan.actions[unit.id] = item;
  }
  plan.submitted = true;
  return plan;
}

function scheduleBotTurn(room, delay = null) {
  if (!room || !room.botRole || room.game.state !== 'playing') return;
  const effectiveDelay = delay == null ? botExecutionProfile(room.game).stepDelayMs : delay;
  if (room.game.turnMode === 'simultaneous') {
    if (room.game.phase !== 'planning' || room.game.plans?.[room.botRole]?.submitted || room.botTimer) return;
    room.botTimer = setTimeout(() => {
      room.botTimer = null;
      if (rooms.get(room.id) !== room) return;
      const g = room.game;
      if (g.turnMode !== 'simultaneous' || g.phase !== 'planning' || g.plans?.[room.botRole]?.submitted) return;
      g.plans[room.botRole] = buildBotSimultaneousPlan(g, room.botRole, room.botDifficulty);
      if (g.plans.attacker.submitted && g.plans.defender.submitted) resolveSimultaneousRound(g);
      broadcast(room);
      broadcastLobby();
      scheduleSimultaneousDeadline(room);
    }, effectiveDelay);
    return;
  }
  if (room.game.currentPlayer !== room.botRole || room.botTimer) return;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    runBotStep(room);
  }, effectiveDelay);
}

function botShouldCheckDeployment(g, completedTurn, currentTurn) {
  return completedTurn !== currentTurn || g.config.allowDeployAfterAction === true;
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
    if (room.botSteps > botExecutionProfile(g).maxStepsPerTurn) {
      addLog(g, '机器人达到本回合操作上限，自动结束回合。');
      endTurn(g, player);
      broadcast(room);
      broadcastLobby();
      return;
    }

    if (botShouldCheckDeployment(g, room.botDeployTurn, turnKey)) {
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

  if (p === '/') {
    res.writeHead(302, {
      Location: `/index.html?v=${CLIENT_ASSET_VERSION}`,
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    });
    return res.end();
  }

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
      'Cache-Control': ext === '.html'
        ? 'no-store, no-cache, must-revalidate'
        : (ext.startsWith('.mp') || AUDIO_EXTENSIONS.has(ext) ? 'no-cache' : 'public, max-age=3600'),
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
        const botDifficulty = normalizeBotDifficulty(m.botDifficulty, variantId);
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
          planningTimer: null,
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
          g.phase = g.turnMode === 'simultaneous' ? 'planning' : 'playing';
          if (g.turnMode === 'simultaneous') prepareSimultaneousPlanning(g); else resetTurnForCurrentPlayer(g);
          const difficultyName = { easy: '简单', normal: '普通', hard: '困难' }[botDifficulty];
          addLog(g, `人机对战开始。${difficultyName}机器人控制${botRole === 'attacker' ? '进攻方' : '防守方'}。`);
        }
        send(ws, { type: 'created', id: room.id, name: room.name, role: hostRole, gameMode, variantId, boardId: g.boardId });
        broadcast(room);
        broadcastLobby();
        scheduleSimultaneousDeadline(room);
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
            room.game.phase = room.game.turnMode === 'simultaneous' ? 'planning' : 'playing';
            if (room.game.turnMode === 'simultaneous') prepareSimultaneousPlanning(room.game); else resetTurnForCurrentPlayer(room.game);
            addLog(room.game, room.game.turnMode === 'simultaneous' ? '两名玩家已连接，双方进入规划阶段。' : `两名玩家已连接。${room.game.currentPlayer === 'attacker' ? '进攻方' : '防守方'}先手。`);
          }
          broadcast(room);
          broadcastLobby();
          scheduleSimultaneousDeadline(room);
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
        g.phase = 'ended';
        if (room.planningTimer) { clearTimeout(room.planningTimer); room.planningTimer = null; }
        g.winner = player === 'attacker' ? 'defender' : 'attacker';
        g.winnerReason = 'surrender';
        addLog(g, `${player === 'attacker' ? '进攻方' : '防守方'}投降，${g.winner === 'attacker' ? '进攻方' : '防守方'}获胜。`);
        setEvent(g, { type: 'surrenderWin', winner: g.winner });
        broadcast(room);
        broadcastLobby();
        return;
      }

      if (player === 'spectator' && m.type !== 'leaveRoom') throw new Error('观战中不能进行游戏操作');

      if (g.turnMode === 'simultaneous' && ['deploy', 'move', 'shoot', 'endUnit', 'endTurn'].includes(m.type)) {
        if (m.type === 'deploy') planSimultaneousDeploy(g, player, String(m.unitType || ''), Number(m.row), Number(m.col));
        else if (m.type === 'move') planSimultaneousAction(g, player, 'move', Number(m.unitId), Number(m.row), Number(m.col));
        else if (m.type === 'shoot') planSimultaneousAction(g, player, 'shoot', Number(m.unitId), null, null, Number(m.targetId));
        else if (m.type === 'endUnit') planSimultaneousAction(g, player, 'endUnit', Number(m.unitId));
        else if (m.type === 'endTurn') submitSimultaneousPlan(g, player);
      } else if (m.type === 'deploy') deploy(g, player, m.unitType, Number(m.row), Number(m.col));
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
        if (room.planningTimer) {
          clearTimeout(room.planningTimer);
          room.planningTimer = null;
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
      scheduleSimultaneousDeadline(room);
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
    if (room.planningTimer) {
      clearTimeout(room.planningTimer);
      room.planningTimer = null;
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
    BATTLE_CATALOG,
    BOARD_DEFINITIONS,
    GAME_VARIANTS,
    GAME_RULES,
    serializeDefinition,
    deserializeDefinition,
    normalizeBoardDefinition,
    normalizeTerrainTypesDefinition,
    normalizeUnitTypesDefinition,
    normalizeUnitsDefinition,
    normalizeCombatRulesDefinition,
    normalizeGameRulesDefinition,
    normalizeAiProfileDefinition,
    normalizeScenarioRulesDefinition,
    normalizeRulesDefinition,
    normalizeBattleCatalog,
    normalizeBattleManifest,
    definitionsForVariant,
    defaultConfigForVariant,
    newGame,
    normalizeVariantId,
    deploymentRowFor,
    createUnit,
    deploy,
    move,
    legalDeployments,
    shoot,
    endTurn,
    normalizeBotDifficulty,
    chooseBotDeployment,
    chooseBotAction,
    botShouldCheckDeployment,
    buildBotSimultaneousPlan,
    evaluateBotState,
    createSimultaneousPlan,
    serializePlan,
    deserializePlan,
    prepareSimultaneousPlanning,
    planSimultaneousDeploy,
    planSimultaneousAction,
    submitSimultaneousPlan,
    resolveSimultaneousRound
  }
};
