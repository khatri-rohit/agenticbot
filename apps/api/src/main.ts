import express from 'express';
import cors from 'cors';

import { agentRouter } from './routes/agent/agent.routes';
import { voiceRouter } from './routes/voice/voice.routes';

const host = process.env.HOST ?? 'localhost';
const port = process.env.PORT ? Number(process.env.PORT) : 3333;

/** browser | speaches | off — Speaches routes only when explicitly enabled. */
const voiceSttProvider = (process.env.VOICE_STT_PROVIDER ?? 'browser')
  .trim()
  .toLowerCase();

const app = express();

app.use(
  cors({
    origin: process.env.CORS_ORIGIN ?? true, // true = reflect request origin (dev-friendly)
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept', 'Origin', 'X-Requested-With'],
  }),
);

app.use(express.json({ limit: '25mb' }));

// Agent endpoints
app.use('/api/agent', agentRouter);

// Speaches STT proxy — only when VOICE_STT_PROVIDER=speaches (not Ollama)
if (voiceSttProvider === 'speaches') {
  app.use('/api/voice', voiceRouter);
}

app.listen(port, host, () => {
  console.log(`[ ready ] http://${host}:${port}`);
  console.log(`[ voice ] STT provider=${voiceSttProvider}`);
});
