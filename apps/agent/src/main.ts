import express from 'express';
import chatRouter from './routers/chat.router';

const host = process.env.HOST ?? 'localhost';
const port = process.env.PORT ? Number(process.env.PORT) : 8080;

const app = express();

app.use(express.json());

app.use('/api/v1', chatRouter);

app.get('/health', (req, res) => {
  res.send({ status: 'ok' });
});

app.get('/', (req, res) => {
  res.send({ message: 'Hello Agent' });
});

app.listen(port, host, () => {
  console.log(`[ ready ] http://${host}:${port}`);
});
