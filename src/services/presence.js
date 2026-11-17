// Per-user socket presence and direct pushes. The socket server attaches io here,
// so routes can notify a player without importing the socket module.
let io = null;
const online = new Map(); // userId -> socket count

export const attachPresenceIo = (server) => {
  io = server;
};
export const userRoom = (userId) => `user:${userId}`;

export function trackUser(userId, delta) {
  if (!userId) return;
  const id = String(userId);
  const next = (online.get(id) || 0) + delta;
  if (next > 0) online.set(id, next);
  else online.delete(id);
}

export const isOnline = (userId) => online.has(String(userId));

export function emitToUser(userId, event, payload) {
  io?.to(userRoom(String(userId))).emit(event, payload);
}
