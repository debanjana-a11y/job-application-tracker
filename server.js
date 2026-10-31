import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import donenv from 'dotenv';
donenv.config();

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT) || 3000;
const publicDirectory = fileURLToPath(new URL('./public/', import.meta.url));
const dataDirectory = path.resolve(
	process.env.DATA_DIR || fileURLToPath(new URL('./data/', import.meta.url)),
);
const dataFile = path.join(dataDirectory, 'applications.json');
const validStatuses = ['Applied', 'Interviewing', 'Rejected'];
const app = express();
let server;
let storeQueue = Promise.resolve();

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
app.use('/apps/import', express.json({ limit: '2mb', strict: true }));
app.use(express.json({ limit: '12kb', strict: true }));
app.use(express.static(publicDirectory, { index: 'index.html' }));

function cleanText(value, maxLength) {
	if (typeof value !== 'string') return '';
	return value
		.replace(/[\u0000-\u001f\u007f]/g, '')
		.trim()
		.slice(0, maxLength);
}

function validDate(value) {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
		return false;
	const date = new Date(`${value}T00:00:00.000Z`);
	return (
		!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
	);
}

function validateStore(store) {
	if (
		!store ||
		!Array.isArray(store.applications) ||
		!(
			store.lastSyncAt === null ||
			(typeof store.lastSyncAt === 'string' &&
				Number.isFinite(Date.parse(store.lastSyncAt)))
		)
	) {
		throw new Error(`Data file ${dataFile} has an invalid structure.`);
	}
	for (const application of store.applications) {
		if (
			!application ||
			typeof application.id !== 'string' ||
			typeof application.company !== 'string' ||
			typeof application.role !== 'string' ||
			!validStatuses.includes(application.status) ||
			!validDate(application.date) ||
			typeof application.createdAt !== 'string'
		) {
			throw new Error(
				`Data file ${dataFile} contains an invalid application record.`,
			);
		}
	}
	return store;
}

async function readStore() {
	let contents;
	try {
		contents = await readFile(dataFile, 'utf8');
	} catch (error) {
		if (error.code === 'ENOENT') return { applications: [], lastSyncAt: null };
		throw error;
	}

	let store;
	try {
		store = JSON.parse(contents);
	} catch (error) {
		throw new Error(`Data file ${dataFile} is not valid JSON.`, {
			cause: error,
		});
	}
	return validateStore(store);
}

async function saveStore(store) {
	const temporaryFile = `${dataFile}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryFile, `${JSON.stringify(store, null, 2)}\n`, {
			flag: 'wx',
		});
		await rename(temporaryFile, dataFile);
	} catch (error) {
		try {
			await unlink(temporaryFile);
		} catch (cleanupError) {
			if (cleanupError.code !== 'ENOENT')
				console.error('Unable to remove temporary data file:', cleanupError);
		}
		throw error;
	}
}

function updateStore(updater) {
	const operation = storeQueue.then(async () => {
		const store = await readStore();
		const result = await updater(store);
		await saveStore(store);
		return result;
	});
	storeQueue = operation.catch(() => {});
	return operation;
}

async function getStore() {
	await storeQueue;
	return readStore();
}

function publicApplication(application) {
	return {
		id: application.id,
		company: application.company,
		role: application.role,
		status: application.status,
		date: application.date,
		createdAt: application.createdAt,
	};
}

app.get('/stats', async (req, res, next) => {
	try {
		const store = await getStore();
		const counts = { Applied: 0, Interviewing: 0, Rejected: 0 };
		for (const application of store.applications)
			counts[application.status] += 1;
		const lastSync =
			store.lastSyncAt === null
				? null
				: Math.floor(Date.parse(store.lastSyncAt) / 1000);
		res.json({
			total_applications: store.applications.length,
			applied: counts.Applied,
			interviewing: counts.Interviewing,
			rejected: counts.Rejected,
			last_sync_timestamp: lastSync,
		});
	} catch (error) {
		next(error);
	}
});

app.get('/apps', async (req, res, next) => {
	try {
		const store = await getStore();
		const applications = store.applications
			.sort(
				(first, second) =>
					second.date.localeCompare(first.date) ||
					second.createdAt.localeCompare(first.createdAt),
			)
			.slice(0, 500);
		res.json(applications.map(publicApplication));
	} catch (error) {
		next(error);
	}
});

app.put('/apps/import', async (req, res, next) => {
	const inputApplications = Array.isArray(req.body)
		? req.body
		: req.body?.applications;
	if (!Array.isArray(inputApplications)) {
		return res.status(400).json({
			error: 'JSON must be an application array or an object with an applications array.',
		});
	}
	if (inputApplications.length > 500) {
		return res.status(400).json({ error: 'JSON files can contain at most 500 applications.' });
	}

	const importedIds = new Set();
	const importedSourceIds = new Set();
	const importedApplications = [];
	for (const [index, item] of inputApplications.entries()) {
		const row = index + 1;
		const company = cleanText(item?.company, 120);
		const role = cleanText(item?.role, 120);
		const status = item?.status;
		const date = item?.date;
		if (!company || !role || !validStatuses.includes(status) || !validDate(date)) {
			return res.status(400).json({
				error: `Application ${row} must include a company, role, valid status, and date (YYYY-MM-DD).`,
			});
		}
		if (item.company.length > 120 || item.role.length > 120) {
			return res.status(400).json({
				error: `Application ${row} company and role must be 120 characters or fewer.`,
			});
		}

		const id = item.id === undefined ? randomUUID() : item.id;
		if (
			typeof id !== 'string' ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
			importedIds.has(id)
		) {
			return res.status(400).json({
				error: `Application ${row} has an invalid or duplicate ID.`,
			});
		}
		importedIds.add(id);

		const sourceId = item.sourceId;
		if (
			sourceId !== undefined &&
			(typeof sourceId !== 'string' ||
				!sourceId.trim() ||
				sourceId.length > 200 ||
				importedSourceIds.has(sourceId))
		) {
			return res.status(400).json({
				error: `Application ${row} has an invalid or duplicate source ID.`,
			});
		}
		if (sourceId !== undefined) importedSourceIds.add(sourceId);

		const createdAt = item.createdAt === undefined ? `${date}T00:00:00.000Z` : item.createdAt;
		if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) {
			return res.status(400).json({
				error: `Application ${row} has an invalid createdAt timestamp.`,
			});
		}

		importedApplications.push({
			id,
			company,
			role,
			status,
			date,
			createdAt,
			...(sourceId === undefined ? {} : { sourceId }),
		});
	}

	try {
		await updateStore(store => {
			store.applications = importedApplications;
		});
		res.json({ imported: importedApplications.length });
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

	if (
		typeof rawCompany !== 'string' ||
		typeof rawRole !== 'string' ||
		!company ||
		!role
	) {
		return res.status(400).json({ error: 'Company and role are required.' });
	}
	if (rawCompany.length > 120 || rawRole.length > 120) {
		return res
			.status(400)
			.json({ error: 'Company and role must be 120 characters or fewer.' });
	}
	if (!validStatuses.includes(status)) {
		return res
			.status(400)
			.json({ error: 'Status must be Applied, Interviewing, or Rejected.' });
	}
	if (!validDate(date)) {
		return res
			.status(400)
			.json({ error: 'Date must be a valid YYYY-MM-DD date.' });
	}
	if (
		req.body?.sourceId !== undefined &&
		(typeof req.body.sourceId !== 'string' ||
			!req.body.sourceId.trim() ||
			req.body.sourceId.length > 200)
	) {
		return res.status(400).json({ error: 'Invalid source ID.' });
	}

	try {
		let created = true;
		const application = await updateStore((store) => {
			if (sourceId) {
				const existing = store.applications.find(
					(item) => item.sourceId === sourceId,
				);
				if (existing) {
					created = false;
					return existing;
				}
			}

			const newApplication = {
				id: randomUUID(),
				company,
				role,
				status,
				date,
				createdAt: new Date().toISOString(),
			};
			if (sourceId) newApplication.sourceId = sourceId;
			store.applications.push(newApplication);
			return newApplication;
		});

		const result = publicApplication(application);
		res.status(created ? 201 : 200).json({ application: result, created });
	} catch (error) {
		next(error);
	}
});

app.put('/apps/:id', async (req, res, next) => {
	const { id } = req.params;
	const rawCompany = req.body?.company;
	const rawRole = req.body?.role;
	const company = cleanText(rawCompany, 120);
	const role = cleanText(rawRole, 120);
	const { status, date } = req.body ?? {};

	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			id,
		)
	) {
		return res.status(400).json({ error: 'Invalid application ID.' });
	}
	if (
		typeof rawCompany !== 'string' ||
		typeof rawRole !== 'string' ||
		!company ||
		!role
	) {
		return res.status(400).json({ error: 'Company and role are required.' });
	}
	if (rawCompany.length > 120 || rawRole.length > 120) {
		return res
			.status(400)
			.json({ error: 'Company and role must be 120 characters or fewer.' });
	}
	if (!validStatuses.includes(status)) {
		return res
			.status(400)
			.json({ error: 'Status must be Applied, Interviewing, or Rejected.' });
	}
	if (!validDate(date)) {
		return res
			.status(400)
			.json({ error: 'Date must be a valid YYYY-MM-DD date.' });
	}

	try {
		const application = await updateStore((store) => {
			const found = store.applications.find((item) => item.id === id);
			if (!found) return null;
			found.company = company;
			found.role = role;
			found.status = status;
			found.date = date;
			return found;
		});
		if (!application)
			return res.status(404).json({ error: 'Application not found.' });

		res.json({ application: publicApplication(application) });
	} catch (error) {
		next(error);
	}
});

app.patch('/apps/:id/status', async (req, res, next) => {
	const { id } = req.params;
	const { status } = req.body ?? {};
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			id,
		)
	) {
		return res.status(400).json({ error: 'Invalid application ID.' });
	}
	if (!validStatuses.includes(status)) {
		return res
			.status(400)
			.json({ error: 'Status must be Applied, Interviewing, or Rejected.' });
	}

	try {
		const application = await updateStore((store) => {
			const found = store.applications.find((item) => item.id === id);
			if (!found) return null;
			found.status = status;
			return found;
		});
		if (!application)
			return res.status(404).json({ error: 'Application not found.' });

		res.json({ application: publicApplication(application) });
	} catch (error) {
		next(error);
	}
});

app.post('/sync-checkpoint', async (req, res, next) => {
	const timestamp = req.body?.timestamp;
	if (
		!Number.isSafeInteger(timestamp) ||
		timestamp <= 0 ||
		timestamp > Math.floor(Date.now() / 1000)
	) {
		return res
			.status(400)
			.json({ error: 'Timestamp must be a valid Unix timestamp in seconds.' });
	}

	try {
		const lastSyncAt = new Date(timestamp * 1000).toISOString();
		const savedTimestamp = await updateStore((store) => {
			if (
				store.lastSyncAt === null ||
				Date.parse(store.lastSyncAt) < Date.parse(lastSyncAt)
			) {
				store.lastSyncAt = lastSyncAt;
			}
			return Math.floor(Date.parse(store.lastSyncAt) / 1000);
		});
		res.json({ last_sync_timestamp: savedTimestamp });
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
		return res
			.status(413)
			.json({ error: 'Request body exceeds the 12 KB limit.' });
	}
	console.error('Request failed:', error);
	res.status(500).json({ error: 'The request could not be completed.' });
});

async function start() {
	try {
		await mkdir(dataDirectory, { recursive: true });
		await updateStore((store) => store);
		server = app.listen(port, host, () => {
			console.log(`Job tracker listening on http://${host}:${port}`);
			console.log(`Application data stored in ${dataFile}`);
		});
	} catch (error) {
		console.error('Unable to start job tracker:', error);
		process.exitCode = 1;
	}
}

let shuttingDown = false;
function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
	if (server) {
		server.close((error) => {
			if (error) {
				console.error('HTTP server shutdown failed:', error);
				process.exitCode = 1;
			}
		});
	}
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
await start();
