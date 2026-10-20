import express from 'express';
import mongoose from 'mongoose';
import { createClient } from 'redis';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';

const host = process.env.HOST || '127.0.0.1';
const publicDirectory = fileURLToPath(new URL('./public/', import.meta.url));
const validStatuses = ['Applied', 'Interviewing', 'Rejected'];
const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
});

redisClient.on('error', error => {
  console.error('Redis client error:', error);
});

const applicationSchema = new mongoose.Schema({
  company: { type: String, required: true, trim: true, maxlength: 120 },
  role: { type: String, required: true, trim: true, maxlength: 120 },
  status: { type: String, enum: validStatuses, required: true, default: 'Applied' },
  date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  sourceId: { type: String, unique: true, sparse: true, maxlength: 200 },
}, { timestamps: true });

const Application = mongoose.model('Application', applicationSchema);

const syncStateSchema = new mongoose.Schema({
  _id: { type: String, default: 'gmail' },
  lastSyncAt: { type: Date, default: null },
});

const SyncState = mongoose.model('SyncState', syncStateSchema);
const app = express();
let server;
let webSocketServer;
let countersNeedRebuild = false;

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
});
app.use(express.json({ limit: '12kb', strict: true }));
app.use(express.static(publicDirectory, { index: 'index.html' }));

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function publicApplication(application) {
  return {
    id: application._id.toString(),
    company: application.company,
    role: application.role,
    status: application.status,
    date: application.date,
    createdAt: application.createdAt,
  };
}

async function updateRedisCounters(application, direction) {
  const commands = [
    { key: 'stats:total', value: direction },
    { key: `stats:${application.status.toLowerCase()}`, value: direction },
  ];
  const multi = redisClient.multi();
  for (const command of commands) multi.incrBy(command.key, command.value);
  try {
    await multi.exec();
  } catch (error) {
    countersNeedRebuild = true;
    throw error;
  }
}

async function ensureCounters() {
  if (!countersNeedRebuild) return;
  await rebuildRedisCounters();
  countersNeedRebuild = false;
}

function broadcast(event) {
  const payload = JSON.stringify(event);
  for (const client of webSocketServer.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

app.get('/stats', async (req, res, next) => {
  try {
    await ensureCounters();
    const [total, applied, interviewing, rejected, syncState] = await Promise.all([
      redisClient.get('stats:total'),
      redisClient.get('stats:applied'),
      redisClient.get('stats:interviewing'),
      redisClient.get('stats:rejected'),
      SyncState.findById('gmail').lean(),
    ]);
    const lastSync = syncState?.lastSyncAt ? new Date(syncState.lastSyncAt).getTime() : null;
    res.json({
      total_applications: Number(total || 0),
      applied: Number(applied || 0),
      interviewing: Number(interviewing || 0),
      rejected: Number(rejected || 0),
      last_sync_timestamp: lastSync === null ? null : Math.floor(lastSync / 1000),
    });
  } catch (error) {
    next(error);
  }
});

app.get('/apps', async (req, res, next) => {
  try {
    const applications = await Application.find().sort({ createdAt: -1 }).limit(500).lean();
    res.json(applications.map(publicApplication));
  } catch (error) {
    next(error);
  }
});

app.post('/apps', async (req, res, next) => {
  const rawCompany = req.body?.company;
  const rawRole = req.body?.role;
  const company = cleanText(rawCompany, 120);
  const role = cleanText(rawRole, 120);
  const status = req.body?.status === undefined ? 'Applied' : req.body.status;
  const date = req.body?.date;
  const sourceId = cleanText(req.body?.sourceId, 200);

  if (typeof rawCompany !== 'string' || typeof rawRole !== 'string' || !company || !role) {
    return res.status(400).json({ error: 'Company and role are required.' });
  }
  if (rawCompany.length > 120 || rawRole.length > 120) {
    return res.status(400).json({ error: 'Company and role must be 120 characters or fewer.' });
  }
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Status must be Applied, Interviewing, or Rejected.' });
  }
  if (!validDate(date)) {
    return res.status(400).json({ error: 'Date must be a valid YYYY-MM-DD date.' });
  }
  if (req.body?.sourceId !== undefined &&
      (typeof req.body.sourceId !== 'string' || !req.body.sourceId.trim() || req.body.sourceId.length > 200)) {
    return res.status(400).json({ error: 'Invalid source ID.' });
  }

  try {
    const fields = { company, role, status, date };
    if (sourceId) fields.sourceId = sourceId;

    let application;
    let created = true;
    if (sourceId) {
      application = await Application.findOne({ sourceId });
      if (application) {
        created = false;
      } else {
        try {
          application = await Application.create(fields);
        } catch (error) {
          if (error.code !== 11000) throw error;
          application = await Application.findOne({ sourceId });
          if (!application) throw error;
          created = false;
        }
      }
    } else {
      application = await Application.create(fields);
    }

    const result = publicApplication(application);
    if (created) {
      await updateRedisCounters(application, 1);
      broadcast({ type: 'application.created', application: result });
    }
    res.status(created ? 201 : 200).json({ application: result, created });
  } catch (error) {
    next(error);
  }
});

app.patch('/apps/:id/status', async (req, res, next) => {
  const { id } = req.params;
  const { status } = req.body ?? {};
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ error: 'Invalid application ID.' });
  }
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Status must be Applied, Interviewing, or Rejected.' });
  }

  try {
    const application = await Application.findById(id);
    if (!application) return res.status(404).json({ error: 'Application not found.' });
    const previousStatus = application.status;
    application.status = status;
    await application.save();

    if (previousStatus !== status) {
      const multi = redisClient.multi();
      multi.incrBy(`stats:${previousStatus.toLowerCase()}`, -1);
      multi.incrBy(`stats:${status.toLowerCase()}`, 1);
      try {
        await multi.exec();
      } catch (error) {
        countersNeedRebuild = true;
        throw error;
      }
      broadcast({ type: 'application.updated', application: publicApplication(application) });
    }
    res.json({ application: publicApplication(application) });
  } catch (error) {
    next(error);
  }
});

app.post('/sync-checkpoint', async (req, res, next) => {
  const timestamp = req.body?.timestamp;
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > Math.floor(Date.now() / 1000)) {
    return res.status(400).json({ error: 'Timestamp must be a valid Unix timestamp in seconds.' });
  }

  try {
    const lastSyncAt = new Date(timestamp * 1000);
    await SyncState.findByIdAndUpdate(
      'gmail',
      { $max: { lastSyncAt } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    res.json({ last_sync_timestamp: timestamp });
  } catch (error) {
    next(error);
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({ error: 'Request body must be valid JSON.' });
  }
  if (error.status === 413) {
    return res.status(413).json({ error: 'Request body exceeds the 12 KB limit.' });
  }
  console.error('Request failed:', error);
  res.status(500).json({ error: 'The request could not be completed.' });
});

async function rebuildRedisCounters() {
  const counts = await Application.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const values = { total: 0, applied: 0, interviewing: 0, rejected: 0 };
  for (const item of counts) {
    const status = item._id.toLowerCase();
    values[status] = item.count;
    values.total += item.count;
  }
  const multi = redisClient.multi();
  for (const [key, value] of Object.entries(values)) multi.set(`stats:${key}`, value);
  await multi.exec();
  countersNeedRebuild = false;
}

async function start() {
  try {
    const mongoUrl = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/jobtracker';
    await Promise.all([mongoose.connect(mongoUrl), redisClient.connect()]);
    await Application.init();
    await rebuildRedisCounters();
    console.log('MongoDB and Redis are connected.');
    const onListening = () => console.log(`Job tracker listening on http://${host}:3000`);
    server = process.env.HOST
      ? app.listen(3000, process.env.HOST, onListening)
      : app.listen(3000, '127.0.0.1', onListening);
    webSocketServer = new WebSocketServer({
      server,
      verifyClient: ({ origin }) => origin === 'http://127.0.0.1:3000' || origin === 'http://localhost:3000',
    });
    webSocketServer.on('connection', socket => {
      socket.on('error', error => console.error('WebSocket client error:', error));
    });
  } catch (error) {
    console.error('Unable to start job tracker:', error);
    process.exitCode = 1;
    await Promise.allSettled([
      mongoose.disconnect(),
      redisClient.isOpen ? redisClient.quit() : Promise.resolve(),
    ]);
  }
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  webSocketServer?.close();
  if (server) {
    server.close(error => {
      if (error) {
        console.error('HTTP server shutdown failed:', error);
        process.exitCode = 1;
      }
    });
  }
  await Promise.allSettled([
    mongoose.disconnect(),
    redisClient.isOpen ? redisClient.quit() : Promise.resolve(),
  ]);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
await start();
