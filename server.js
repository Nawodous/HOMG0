const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 37788;
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.webm', '.flac']);
const AUDIO_ROOT = path.join(PUBLIC_DIR, 'audio');

function collectAudioFiles(dir, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out = out.concat(collectAudioFiles(full, rel));
    else if (AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(`/audio/${rel.split(path.sep).join('/')}`);
  }
  return out;
}


const DEFAULT_CONFIG = {
  reinforcement: 28,
  attackerMax: { infantry: 5, antiTank: 1, machineGun: 1 },
  defenderMax: { infantry: 4, antiTank: 1, machineGun: 0 },
  allowDeployAfterAction: false
};

const TYPES = {
  infantry: { name: '步兵', short: '步', move: 1, range: 2 },
  antiTank: { name: '反坦克炮', short: '炮', move: 1, range: 3 },
  machineGun: { name: '机枪车', short: '机', move: 2, range: 2 }
};

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

function validCell(row, col) {
  return row >= 1 && row <= 6 && (row === 5 ? col >= 1 && col <= 4 : col >= 0 && col <= 4);
}

function terrainAt(row, col) {
  if (row === 2 && (col === 1 || col === 3)) return 1; // fortress
  if (row === 3 && [0, 1, 3, 4].includes(col)) return 2; // stairs
  return 0;
}

/*
 * 几何坐标：普通行列中心为 1,2,3,4,5；第5行中心为 1.5,2.5,3.5,4.5。
 * 因此：
 *   第5行 c -> 上方第4行 c-1、c；下方第6行 c-1、c
 *   第6行 col -> 第5行 col、col+1
 * 这里特别修正了原代码的第6行邻接错误。
 */
function neighbors(row, col) {
  let result = [];

  if (row === 5) {
    result = [
      [5, col - 1], [5, col + 1],
      [4, col - 1], [4, col],
      [6, col - 1], [6, col]
    ];
  } else if (row === 4) {
    result = [
      [3, col], [4, col - 1], [4, col + 1],
      [5, col], [5, col + 1]
    ];
  } else if (row === 6) {
    result = [
      [5, col], [5, col + 1],
      [6, col - 1], [6, col + 1]
    ];
  } else {
    result = [
      [row - 1, col], [row + 1, col],
      [row, col - 1], [row, col + 1]
    ];
  }

  return unique(result.filter(([r, c]) => validCell(r, c)));
}

function bfs(row, col, maxDistance) {
  const dist = new Map([[key(row, col), 0]]);
  const q = [[row, col, 0]];
  for (let i = 0; i < q.length; i++) {
    const [r, c, d] = q[i];
    if (d >= maxDistance) continue;
    for (const [nr, nc] of neighbors(r, c)) {
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

function newGame(config, hostRole) {
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
    players: { attacker: null, defender: null },
    started: false,
    lastEvent: null,
    lastChat: { attacker: '', defender: '' }
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

function canEnterTerrain(unit, row, col) {
  const t = terrainAt(row, col);
  if (t === 0) return true;
  if (t === 1) return unit.type === 'infantry' || unit.type === 'antiTank';
  if (t === 2) return unit.type === 'infantry';
  return false;
}

function stairsEntryAllowed(g, unit, tr, tc) {
  if (unit.type !== 'infantry' || unit.row !== 4 || tr !== 3 || terrainAt(tr, tc) !== 2) return true;
  if (!unit.shot) return true;
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
    for (const [nr, nc] of neighbors(r, c)) {
      if (unitAt(g, nr, nc)) continue;
      if (!canEnterTerrain(unit, nr, nc)) continue;
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
  if (unit.type === 'antiTank' && (unit.shot || unit.moved)) return [];
  if (unit.type === 'infantry' && unit.moved) return [];
  const remaining = unit.type === 'machineGun' ? 2 - unit.moveSteps : 1;
  if (remaining <= 0) return [];

  const out = [];
  for (const [cellKey] of bfs(unit.row, unit.col, remaining)) {
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
  const out = [];
  for (const [cellKey] of bfs(unit.row, unit.col, TYPES[unit.type].range)) {
    const [r, c] = cellKey.split(',').map(Number);
    const target = unitAt(g, r, c);
    if (target && target.player !== unit.player) out.push(target);
  }
  return out;
}

function immune(target, attacker) {
  if (target.type === 'machineGun' && (attacker.type === 'infantry' || attacker.type === 'machineGun')) return true;
  if (terrainAt(target.row, target.col) === 1 && (attacker.type === 'infantry' || attacker.type === 'machineGun')) return true;
  return false;
}

function finishAction(g, u) {
  if (u.type === 'antiTank') {
    u.canAct = false;
    return;
  }
  if (u.type === 'infantry' && u.moved && u.shot) u.canAct = false;
  if (u.type === 'machineGun' && u.moveSteps >= 2 && u.shot) u.canAct = false;
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
  const a1 = g.units.find(u => u.player === 'attacker' && u.row === 1);
  if (a1) {
    g.state = 'ended';
    g.winner = 'attacker';
    addLog(g, `进攻方 ${TYPES[a1.type].name}#${a1.id} 到达第一行，进攻方胜利。`);
    setEvent(g, { type: 'win', winner: 'attacker', unitId: a1.id });
    return true;
  }
  if (g.attackerReinforcement === 0 && alive(g, 'attacker').length === 0) {
    g.state = 'ended';
    g.winner = 'defender';
    addLog(g, '进攻方增援耗尽且场上全灭，防守方胜利。');
    setEvent(g, { type: 'win', winner: 'defender' });
    return true;
  }
  return false;
}

function deploy(g, player, type, row, col) {
  if (g.state !== 'playing') throw new Error('游戏尚未开始或已经结束');
  if (g.currentPlayer !== player) throw new Error('尚未轮到你');
  if (!TYPES[type]) throw new Error('未知兵种');
  const targetRow = player === 'attacker' ? 6 : 1;
  if (row !== targetRow) throw new Error(`只能部署在第${targetRow}行`);
  if (!validCell(row, col)) throw new Error('无效格子');
  if (unitAt(g, row, col)) throw new Error('该位置已有单位');
  if (player === 'defender' && type === 'machineGun') throw new Error('防守方没有机枪车');
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
  addLog(g, `${player === 'attacker' ? '进攻方' : '防守方'}部署${TYPES[type].name}#${u.id}。`);
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

  addLog(g, `${player === 'attacker' ? '进攻方' : '防守方'}${TYPES[u.type].name}#${u.id}移动到(${row},${displayCol(row, col)})。`);
  setEvent(g, { type: 'move', unitId: u.id, unitType: u.type, from, to: { row, col }, distance: target.distance });

  if (player === 'attacker' && row === 1) { checkEnd(g); return; }
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

  if (immune(t, a)) {
    addLog(g, `${TYPES[a.type].name}#${a.id}射击${TYPES[t.type].name}#${t.id}，未造成伤害。`);
    setEvent(g, { type: 'shoot', attackerId: a.id, attackerType: a.type, targetId: t.id, targetType: t.type, result: 'immune', from: { row: a.row, col: a.col }, targetPos: { row: t.row, col: t.col } });
    finishAction(g, a);
    return;
  }

  if (a.type === 'antiTank' && (t.type === 'machineGun' || terrainAt(t.row, t.col) === 1)) {
    addLog(g, `${TYPES[a.type].name}#${a.id}击毁${TYPES[t.type].name}#${t.id}。`);
    const deadUnit = { ...t };
    g.units = g.units.filter(x => x.id !== t.id);
    setEvent(g, { type: 'kill', attackerId: a.id, attackerType: a.type, targetId: t.id, targetType: t.type, reason: 'antiTank', from: { row: a.row, col: a.col }, targetPos: { row: t.row, col: t.col }, deadUnit });
    finishAction(g, a);
    checkEnd(g);
    return;
  }

  t.hits++;
  addLog(g, `${TYPES[a.type].name}#${a.id}命中${TYPES[t.type].name}#${t.id}，受击${t.hits}/2。`);
  if (t.hits >= 2) {
    const deadUnit = { ...t };
    g.units = g.units.filter(x => x.id !== t.id);
    addLog(g, `${TYPES[t.type].name}#${t.id}被击杀。`);
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
  addLog(g, `${TYPES[u.type].name}#${u.id}主动结束本回合行动。`);
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

function displayCol(row, col) { return row === 5 ? (col + 0.5).toFixed(1) : String(col + 1); }

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
    log: g.log,
    started: g.started,
    config: g.config,
    players: { attacker: !!g.players.attacker, defender: !!g.players.defender },
    you,
    roomPlayerCount: (g.players.attacker ? 1 : 0) + (g.players.defender ? 1 : 0),
    roomName: g.roomName || null,
    lastEvent: g.lastEvent
  };
}

function lobbySnapshot() {
  return Array.from(rooms.values())
    .filter(room => !room.game.started && room.game.state === 'waiting')
    .map(room => ({
      id: room.id,
      name: room.name,
      hostRole: room.hostRole,
      playerCount: (room.players.attacker ? 1 : 0) + (room.players.defender ? 1 : 0),
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
}

function sanitizeConfig(raw = {}) {
  const num = (v, min, max, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : d;
  };
  return {
    reinforcement: num(raw.reinforcement, 1, 999, DEFAULT_CONFIG.reinforcement),
    attackerMax: {
      infantry: num(raw.attackerInfantry, 0, 50, DEFAULT_CONFIG.attackerMax.infantry),
      antiTank: num(raw.attackerAntiTank, 0, 10, DEFAULT_CONFIG.attackerMax.antiTank),
      machineGun: num(raw.attackerMachineGun, 0, 10, DEFAULT_CONFIG.attackerMax.machineGun)
    },
    defenderMax: {
      infantry: num(raw.defenderInfantry, 0, 50, DEFAULT_CONFIG.defenderMax.infantry),
      antiTank: num(raw.defenderAntiTank, 0, 10, DEFAULT_CONFIG.defenderMax.antiTank),
      machineGun: 0
    },
    allowDeployAfterAction: raw.allowDeployAfterAction === true
  };
}

const httpServer = http.createServer((req, res) => {
  let p = req.url.split('?')[0];

  if (p === '/__audio_manifest') {
    const manifest = { files: collectAudioFiles(AUDIO_ROOT) };
    res.writeHead(200, { 'Content-Type': 'application/json;charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(manifest));
  }

  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC_DIR, p);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
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
    res.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', ws => {
  ws.roomId = null;
  ws.role = null;
  send(ws, { type: 'hello', message: 'connected' });

  ws.on('message', raw => {
    try {
      const m = JSON.parse(raw.toString());

      if (m.type === 'listRooms') {
        send(ws, { type: 'lobby', rooms: lobbySnapshot() });
        return;
      }

      if (m.type === 'create') {
        const hostRole = m.hostRole === 'defender' ? 'defender' : 'attacker';
        const config = sanitizeConfig(m.config);
        const g = newGame(config, hostRole);
        const id = `room-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const room = {
          id,
          name: `房间 ${nextRoomNumber++}`,
          hostRole,
          game: g,
          players: { attacker: null, defender: null }
        };
        g.roomName = room.name;
        room.players[hostRole] = ws;
        g.players[hostRole] = ws;
        rooms.set(id, room);
        ws.roomId = id;
        ws.role = hostRole;
        send(ws, { type: 'created', id: room.id, name: room.name, role: hostRole });
        broadcast(room);
        broadcastLobby();
        return;
      }

      if (m.type === 'join') {
        const id = String(m.roomId || '');
        const room = rooms.get(id);
        if (!room) throw new Error('房间不存在或已经开始');
        if (room.game.started || room.game.state !== 'waiting') throw new Error('该房间已经开始');
        const joinRole = room.players.attacker ? 'defender' : 'attacker';
        if (room.players[joinRole]) throw new Error('房间已满');
        room.players[joinRole] = ws;
        room.game.players[joinRole] = ws;
        ws.roomId = room.id;
        ws.role = joinRole;
        send(ws, { type: 'joined', id: room.id, name: room.name, role: joinRole });
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

      const room = rooms.get(ws.roomId);
      if (!room) throw new Error('尚未加入房间');
      const player = ws.role;
      const g = room.game;

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
        for (const r of ['attacker', 'defender']) {
          const peer = room.players[r];
          if (peer) send(peer, { type: 'chat', role: player, text, at: Date.now() });
        }
        return;
      }
      else if (m.type === 'ping') { send(ws, { type: 'pong' }); return; }
      else throw new Error('未知操作');

      broadcast(room);
    } catch (e) {
      send(ws, { type: 'error', code: e.code || null, message: e.message || String(e) });
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomId);
    if (!room) return;
    if (room.game.state !== 'ended' && room.game.started) {
      room.game.state = 'ended';
      room.game.winner = ws.role === 'attacker' ? 'defender' : 'attacker';
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

httpServer.listen(PORT, HOST, () => {
  console.log(`HOMG0 LAN server running on http://0.0.0.0:${PORT}`);
  console.log(`局域网访问: http://<房主IP>:${PORT}`);
});
