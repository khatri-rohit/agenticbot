import { Agent, run } from '@openai/agents';

const agent = new Agent({
  name: 'My Agent',
  instructions:
    'You are a helpful assistant that can answer questions and help with tasks.',
  model: 'llama3.2:3b',
});

run(agent, 'Hello, how are you?')
  .then((result) => {
    console.log('Result: ');
    console.log(result);
  })
  .catch((error) => {
    console.error('Something went wrong: ', error);
  });
