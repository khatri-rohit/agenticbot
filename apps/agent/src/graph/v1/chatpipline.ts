/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  StateGraph,
  START,
  END,
  GraphNode,
  StateSchema,
  MessagesValue,
  // MemorySaver,
  // InMemoryStore,
  type CompiledStateGraph,
} from '@langchain/langgraph';
import { getAgentModel } from '../../lib/model';

const State = new StateSchema({
  messages: MessagesValue,
});

// const store = new InMemoryStore();
// const checkpointer = new MemorySaver();

const model = getAgentModel();

const chatbot: GraphNode<typeof State> = async (state) => {
  const response = await model.invoke(state.messages, {
    outputVersion: 'v1',
    configurable: {
      thread_id: '123',
    },
  });
  return { messages: [response] };
};

export const graph = new StateGraph(State)
  .addNode('chatbot', chatbot)
  .addEdge(START, 'chatbot')
  .addEdge('chatbot', END)
  .compile() as unknown as CompiledStateGraph<any, any>;
// .compile({ checkpointer, store }) as unknown as CompiledStateGraph<any, any>;

export type ChatPipeline = typeof graph;
