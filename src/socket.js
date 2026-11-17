import { Server } from 'socket.io';
import Match from './models/Match.js';
import { config } from './config.js';
import { verifyToken } from './middleware/auth.js';
import { attachIo, roomOf, serializeMatch, setPresence } from './services/matchEngine.js';
import { attachPresenceIo, trackUser, userRoom } from './services/presence.js';

// Sockets are push-only: clients subscribe to a match room and receive updates.
// All state changes go through the REST API so they are validated in one place.
export function createSocketServer(httpServer) {
  const io = new Server(httpServer, { cors: { origin: config.corsOrigin, credentials: true } });
  attachIo(io);
  attachPresenceIo(io);

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    socket.data.userId = token ? verifyToken(token) : null;
    next();
  });

  io.on('connection', (socket) => {
    const watching = new Set();
    const { userId } = socket.data;
    if (userId) {
      socket.join(userRoom(userId));
      trackUser(userId, 1);
    }

    socket.on('match:watch', async ({ code } = {}, ack = () => {}) => {
      const upper = String(code || '').toUpperCase();
      const match = await Match.findOne({ code: upper }).catch(() => null);
      if (!match) return ack({ error: 'No match with this code' });
      if (!watching.has(upper)) {
        watching.add(upper);
        socket.join(roomOf(upper));
        setPresence(upper, socket.data.userId, 1);
      }
      ack({ match: serializeMatch(match, { withMessages: true }) });
    });

    socket.on('match:unwatch', ({ code } = {}) => {
      const upper = String(code || '').toUpperCase();
      if (!watching.delete(upper)) return;
      socket.leave(roomOf(upper));
      setPresence(upper, socket.data.userId, -1);
    });

    socket.on('disconnect', () => {
      watching.forEach((code) => setPresence(code, socket.data.userId, -1));
      watching.clear();
      if (userId) trackUser(userId, -1);
    });
  });

  return io;
}
