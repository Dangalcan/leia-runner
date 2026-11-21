const multiLeiaService = require('../services/multiLeiaService');

function sendError(res, error, fallbackMessage) {
  const statusCode = error.statusCode || 500;
  if (statusCode >= 500) console.error(fallbackMessage, error);
  return res.status(statusCode).send({
    error: statusCode >= 500 ? fallbackMessage : error.message,
  });
}

function writeSse(res, event, data) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

module.exports.createMultiLeia = async function createMultiLeia(req, res) {
  try {
    const { sessionId, actors, orchestration } = req.body || {};
    const state = await multiLeiaService.initialize(
      sessionId,
      actors,
      orchestration
    );
    return res.status(201).send({
      sessionId,
      created: true,
      state,
    });
  } catch (error) {
    return sendError(res, error, 'Internal error creating MultiLEIA session');
  }
};

module.exports.sendMultiLeiaMessage = async function sendMultiLeiaMessage(req, res) {
  try {
    const { message, turnId } = req.body || {};
    const result = await multiLeiaService.sendMessage(
      req.params.sessionId,
      message,
      turnId
    );
    return res.status(200).send(result);
  } catch (error) {
    return sendError(res, error, 'Internal error sending MultiLEIA message');
  }
};

module.exports.streamMultiLeiaMessage = async function streamMultiLeiaMessage(req, res) {
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  writeSse(res, 'ready', { connected: true });

  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(': keep-alive\n\n');
  }, 15000);

  try {
    const { message, turnId } = req.body || {};
    const result = await multiLeiaService.sendMessage(
      req.params.sessionId,
      message,
      turnId,
      {
        onRoute: async (route) => writeSse(res, 'route', route),
        onMessage: async (event) => writeSse(res, 'message', { message: event }),
      }
    );
    writeSse(res, 'complete', {
      turnId: result.turnId,
      state: result.state,
      partial: Boolean(result.partial),
      replayed: Boolean(result.replayed),
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    if (statusCode >= 500) {
      console.error('Internal error streaming MultiLEIA message', error);
    }
    writeSse(res, 'error', {
      error:
        statusCode >= 500
          ? 'Internal error sending MultiLEIA message'
          : error.message,
      statusCode,
    });
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded && !res.destroyed) res.end();
  }
};

module.exports.getMultiLeiaState = async function getMultiLeiaState(req, res) {
  try {
    const runtime = await multiLeiaService.getRuntime(req.params.sessionId);
    if (!runtime) {
      return res.status(404).send({ error: 'MultiLEIA session not found' });
    }
    return res.status(200).send(multiLeiaService.toPublicState(runtime));
  } catch (error) {
    return sendError(res, error, 'Internal error reading MultiLEIA session');
  }
};
