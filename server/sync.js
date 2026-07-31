/**
 * WebSocket Real-time Sync Module
 *
 * 负责管理多设备间的数据实时同步。
 * 设计思路：
 *   - 使用房间(room)机制，同"账号"的所有设备加入同一个房间
 *   - 默认账号：anonymous（未登录时的共享设备组）
 *   - 数据变更时广播到同房间的其他设备
 *   - 服务端持有一份"权威数据"副本，新设备连接时全量下发
 *   - 基于 lastModified 时间戳做简单的冲突解决（新数据覆盖旧数据）
 */

const fs = require('fs');
const path = require('path');

// 持久化文件路径
const DATA_DIR = path.join(__dirname, '..', '.sync-data');
const ensureDataDir = () => {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
};

// 需要同步的核心数据模块
const SYNC_KEYS = [
  'metrics',
  'schedules',
  'plans',
  'planCategories',
  'todos',
  'goals',
  'goalCategories',
  'kbEntries',
  'kbCategories',
  'inspirations',
  'drafts',
  'topics',
  'flashcards',
  'flashcardIndex',
  'profile',
  'reflections',
  'growthLog'
];

// 内存中的数据仓库：{ [userId]: { [key]: { value, lastModified } } }
const dataStore = {};

// 加载持久化数据
function loadUserData(userId) {
  ensureDataDir();
  const file = path.join(DATA_DIR, `${userId}.json`);
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf-8');
      dataStore[userId] = JSON.parse(raw);
      return;
    }
  } catch (e) {
    console.warn(`[sync] Failed to load data for ${userId}:`, e.message);
  }
  dataStore[userId] = {};
}

// 保存持久化数据
function saveUserData(userId) {
  ensureDataDir();
  const file = path.join(DATA_DIR, `${userId}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(dataStore[userId] || {}), 'utf-8');
  } catch (e) {
    console.error(`[sync] Failed to save data for ${userId}:`, e.message);
  }
}

// 获取指定用户的全量数据
function getAllData(userId) {
  if (!dataStore[userId]) loadUserData(userId);
  const result = {};
  for (const key of SYNC_KEYS) {
    const entry = dataStore[userId][key];
    if (entry) result[key] = entry.value;
  }
  return result;
}

// 更新单条数据（返回是否实际更新）
function updateData(userId, key, value, lastModified) {
  if (!SYNC_KEYS.includes(key)) return false;
  if (!dataStore[userId]) loadUserData(userId);

  const existing = dataStore[userId][key];
  const ts = lastModified || Date.now();

  // 冲突解决：时间戳新的覆盖旧的
  if (existing && existing.lastModified && existing.lastModified >= ts) {
    return false; // 服务端数据更新，忽略本次
  }

  dataStore[userId][key] = { value, lastModified: ts };
  saveUserData(userId);
  return true;
}

// 批量更新（新设备连接时上报全量数据）
function bulkUpdate(userId, dataMap) {
  if (!dataStore[userId]) loadUserData(userId);
  const updatedKeys = [];
  const now = Date.now();
  for (const key of SYNC_KEYS) {
    if (dataMap[key] !== undefined) {
      const existing = dataStore[userId][key];
      const incoming = dataMap[key];
      const incomingTs = incoming?.lastModified || now;
      const incomingValue = incoming?.value !== undefined ? incoming.value : incoming;

      if (!existing || !existing.lastModified || existing.lastModified < incomingTs) {
        dataStore[userId][key] = { value: incomingValue, lastModified: incomingTs };
        updatedKeys.push(key);
      }
    }
  }
  if (updatedKeys.length > 0) saveUserData(userId);
  return updatedKeys;
}

// 设置 Socket.IO
function setupSync(io) {
  // 连接中间件：从 query 或 handshake 中获取 userId 和 deviceId
  io.use((socket, next) => {
    const userId = socket.handshake.auth?.userId || socket.handshake.query?.userId || 'anonymous';
    const deviceId = socket.handshake.auth?.deviceId || socket.handshake.query?.deviceId || `device_${Math.random().toString(36).slice(2, 10)}`;
    const deviceName = socket.handshake.auth?.deviceName || socket.handshake.query?.deviceName || '未知设备';
    socket.data.userId = userId;
    socket.data.deviceId = deviceId;
    socket.data.deviceName = deviceName;
    next();
  });

  io.on('connection', (socket) => {
    const { userId, deviceId, deviceName } = socket.data;

    // 加入用户房间
    socket.join(`user:${userId}`);

    // 确保用户数据已加载
    if (!dataStore[userId]) loadUserData(userId);

    console.log(`[sync] 设备连接: ${deviceName} (${deviceId}) [用户: ${userId}]`);

    // 1. 新连接时，下发服务端全量数据 + 设备列表
    const serverData = getAllData(userId);
    socket.emit('sync:full', {
      data: serverData,
      serverTime: Date.now(),
      yourDeviceId: deviceId
    });

    // 广播在线设备列表
    broadcastDeviceList(io, userId);

    // 2. 单条数据变更
    socket.on('sync:update', (payload, ack) => {
      const { key, value, lastModified } = payload || {};
      if (!key) { ack && ack({ ok: false, error: 'missing key' }); return; }

      const updated = updateData(userId, key, value, lastModified);
      ack && ack({ ok: true, updated, serverTime: Date.now() });

      if (updated) {
        // 广播给同房间的其他设备（排除自己）
        socket.to(`user:${userId}`).emit('sync:update', {
          key,
          value,
          lastModified: lastModified || Date.now(),
          fromDevice: deviceId
        });
      }
    });

    // 3. 批量同步（新设备首次连接时，把本地数据也上报给服务端合并）
    socket.on('sync:bulk', (payload, ack) => {
      const { data } = payload || {};
      if (!data) { ack && ack({ ok: false, error: 'missing data' }); return; }

      const updatedKeys = bulkUpdate(userId, data);
      ack && ack({
        ok: true,
        updatedKeys,
        serverData: getAllData(userId),
        serverTime: Date.now()
      });

      // 广播给其他设备：哪些 key 被更新了
      if (updatedKeys.length > 0) {
        const updates = {};
        for (const k of updatedKeys) {
          updates[k] = dataStore[userId][k];
        }
        socket.to(`user:${userId}`).emit('sync:bulk-update', {
          updates,
          fromDevice: deviceId
        });
      }
    });

    // 4. 心跳 / 在线状态
    socket.on('sync:ping', (_, ack) => {
      ack && ack({ pong: true, serverTime: Date.now() });
    });

    // 5. 断开连接
    socket.on('disconnect', () => {
      console.log(`[sync] 设备断开: ${deviceName} (${deviceId}) [用户: ${userId}]`);
      setTimeout(() => broadcastDeviceList(io, userId), 500);
    });
  });
}

// 广播在线设备列表
function broadcastDeviceList(io, userId) {
  const room = io.sockets.adapter.rooms.get(`user:${userId}`);
  if (!room) return;
  const devices = [];
  for (const socketId of room) {
    const sock = io.sockets.sockets.get(socketId);
    if (sock) {
      devices.push({
        deviceId: sock.data.deviceId,
        deviceName: sock.data.deviceName
      });
    }
  }
  io.to(`user:${userId}`).emit('sync:devices', { devices });
}

module.exports = { setupSync, SYNC_KEYS };
