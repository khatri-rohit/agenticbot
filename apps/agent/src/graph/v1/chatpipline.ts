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
import { getWebInformationTool, searchTool } from '../../lib/tools/web';
import { ToolNode } from '@langchain/langgraph/prebuilt';

/** Node id used when filtering LangGraph message streams in the HTTP layer. */
export const CHATBOT_NODE_ID = 'chatbot';

const State = new StateSchema({
  messages: MessagesValue,
});

// const store = new InMemoryStore();
// const checkpointer = new MemorySaver();

const model = getAgentModel();

const chatbot: GraphNode<typeof State> = async (state) => {
  const response = await model
    .bindTools([searchTool, getWebInformationTool])
    .invoke(state.messages, {
      outputVersion: 'v1',
      configurable: {
        thread_id: '123',
      },
    });
  console.log(response);
  return { messages: [response] };
};

const toolNode = new ToolNode([searchTool, getWebInformationTool]);

export const graph = new StateGraph(State)
  .addNode(CHATBOT_NODE_ID, chatbot)
  .addNode('tool_call', toolNode)
  .addEdge(START, CHATBOT_NODE_ID)
  .addEdge(CHATBOT_NODE_ID, 'tool_call')
  .addEdge('tool_call', END)
  .compile() as unknown as CompiledStateGraph<any, any>;
// .compile({ checkpointer, store }) as unknown as CompiledStateGraph<any, any>;

export type ChatPipeline = typeof graph;
