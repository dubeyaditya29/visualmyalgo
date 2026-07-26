import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { languages, type RunRequest } from '@visualmyalgo/protocol';
import { RunManager } from './runs.js';

const app = express();
const runs = new RunManager();
const recentRequests = new Map<string, number[]>();
const runSchema = z.object({ language: z.enum(languages), code: z.string().min(1), stdin: z.string().max(20_000).optional(), breakpoints: z.array(z.number().int().positive()).max(100).default([]) });

app.use(cors());
app.use(express.json({ limit: '110kb' }));
app.use((request, response, next) => {
  const key = request.ip || 'unknown'; const now = Date.now(); const attempts = (recentRequests.get(key) || []).filter(time => now - time < 60_000);
  if (attempts.length >= 12) return response.status(429).json({ message: 'Too many executions. Please wait a minute.' });
  attempts.push(now); recentRequests.set(key, attempts); next();
});

app.get('/api/health', (_request, response) => response.json({ ok: true }));
app.post('/api/runs', (request, response) => {
  const parsed = runSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0]?.message || 'Invalid run request.' });
  try { const run = runs.create(parsed.data as RunRequest); return response.status(202).json({ runId: run.id, eventsUrl: `/api/runs/${run.id}/events` }); }
  catch (error) { return response.status(429).json({ message: error instanceof Error ? error.message : 'Unable to queue run.' }); }
});
app.get('/api/runs/:id/events', (request, response) => {
  const run = runs.get(request.params.id); if (!run) return response.status(404).end();
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
  const send = (type: string, payload: unknown) => response.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  const trace = (event: unknown) => send('trace', event); const complete = (event: unknown) => { send('complete', event); response.end(); };
  run.history.forEach(trace);
  if (run.result) return complete(run.result);
  run.events.on('trace', trace); run.events.once('complete', complete);
  request.on('close', () => { run.events.off('trace', trace); run.events.off('complete', complete); });
});
app.delete('/api/runs/:id', (request, response) => response.status(runs.cancel(request.params.id) ? 204 : 404).end());

const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`VisualMyAlgo API listening on http://localhost:${port}`));
