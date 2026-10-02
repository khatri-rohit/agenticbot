/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  StateGraph,
  START,
  END,
  GraphNode,
  StateSchema,
  MessagesValue,
  type CompiledStateGraph,
} from '@langchain/langgraph';
import { getAgentModel } from '../../lib/model';
import { getWebInformationTool, searchTool } from '../../lib/tools/web';
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import { BaseMessage, ToolMessage } from '@langchain/core/messages';
import { MAX_TOOL_PAYLOAD_CHARS } from '../../lib/tools/compact-tool-payload';

/** Node id used when filtering LangGraph message streams in the HTTP layer. */
export const CHATBOT_NODE_ID = 'chatbot';

const State = new StateSchema({
  messages: MessagesValue,
});

const model = getAgentModel();

const tools = [searchTool, getWebInformationTool];
const modelWithTools = model.bindTools(tools);

const config = {
  configurable: {
    thread_id: '1',
  },
};

const chatbot: GraphNode<typeof State> = async (state) => {
  const response = await modelWithTools.invoke(state.messages, {
    outputVersion: 'v1',
    ...config,
  });
  return { messages: [response] };
};

const toolNode = new ToolNode(tools);

export const graph = new StateGraph(State)
  .addNode(CHATBOT_NODE_ID, chatbot)
  .addNode('tools', toolNode)
  .addEdge(START, CHATBOT_NODE_ID)
  .addConditionalEdges(CHATBOT_NODE_ID, toolsCondition, ['tools', END])
  .addEdge('tools', CHATBOT_NODE_ID)
  .compile() as unknown as CompiledStateGraph<any, any>;

export type ChatPipeline = typeof graph;
