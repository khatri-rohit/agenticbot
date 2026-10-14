import express from 'express';
import { agentRouter } from './routes/agent/agent.routes';
import { voiceRouter } from './routes/voice/voice.routes';

const host = process.env.HOST ?? 'localhost';
const port = process.env.PORT ? Number(process.env.PORT) : 3333;

/** browser | speaches | off — Speaches routes only when explicitly enabled. */
const voiceSttProvider = (process.env.VOICE_STT_PROVIDER ?? 'browser')
  .trim()
  .toLowerCase();

const app = express();

// Vision runs send base64 data URLs in JSON — default 100kb is too small.
app.use(express.json({ limit: '25mb' }));

// CORS configuration for React app
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept',
  );
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

app.get('/', (req, res) => {
  res.send({ message: 'Hello API' });
});

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
