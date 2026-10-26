/**
 * Run sessions.
 *
 * Cursor splits one agent turn across two calls:
 *
 *   POST /aiserver.v1.BidiService/BidiAppend     carries the run request
 *   POST /agent.v1.AgentService/RunSSE           streams the response
 *
 * The order is not guaranteed: `RunSSE` may arrive before `BidiAppend`, and more
 * than one `BidiAppend` can belong to the same run (later frames carry heartbeats
 * and blob acknowledgements). A session is the meeting point — `BidiAppend` posts
 * into it, `RunSSE` waits on it.
 */

const IDLE_TIMEOUT_MS = 120_000;

/** requestId -> session */
const sessions = new Map();

function create(requestId) {
  const session = {
    requestId,
    queue: [],
    waiters: [],
    closed: false,
    createdAt: Date.now(),
    lastSeen: Date.now(),
  };
  sessions.set(requestId, session);
  return session;
}

/** Get or create the session for a request id. */
export function openSession(requestId) {
  return sessions.get(requestId) ?? create(requestId);
}

/** Has anything been posted for this request id? */
export function hasSession(requestId) {
  return sessions.has(requestId);
}

/** Post one decoded client message into a session. */
export function deliver(requestId, message) {
  const session = openSession(requestId);
  session.lastSeen = Date.now();

  const waiter = session.waiters.shift();
  if (waiter) {
    waiter.resolve(message);
    return;
  }
  session.queue.push(message);
}

/**
 * Wait for the next client message.
 *
 * @param {string} requestId
 * @param {number} [timeoutMs]
 * @returns {Promise<object|null>} null on timeout or close
 */
export function next(requestId, timeoutMs = IDLE_TIMEOUT_MS) {
  const session = openSession(requestId);

  if (session.queue.length > 0) {
    return Promise.resolve(session.queue.shift());
  }
  if (session.closed) return Promise.resolve(null);

  return new Promise((resolve) => {
    const waiter = {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
    };

    const timer = setTimeout(() => {
      const at = session.waiters.indexOf(waiter);
      if (at >= 0) session.waiters.splice(at, 1);
      resolve(null);
    }, timeoutMs);
    timer.unref?.();

    session.waiters.push(waiter);
  });
}

/** Close a session and release anyone waiting on it. */
export function closeSession(requestId) {
  const session = sessions.get(requestId);
  if (!session) return;
  session.closed = true;
  for (const waiter of session.waiters.splice(0)) waiter.resolve(null);
  sessions.delete(requestId);
}

/** Drop sessions nobody has touched for a while. */
export function sweep(now = Date.now()) {
  for (const [id, session] of sessions) {
    if (now - session.lastSeen > IDLE_TIMEOUT_MS) closeSession(id);
  }
}

/** Active session count; used by /byok/debug. */
export function sessionCount() {
  return sessions.size;
}

/** Drop every session; used by tests. */
export function clearSessions() {
  for (const id of [...sessions.keys()]) closeSession(id);
}
