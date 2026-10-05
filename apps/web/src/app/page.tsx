'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import type { Message } from '@org/agent-models';
import { createThread, deleteThread } from '../features/agent/store/db';
import { useThreads, useMessages, useAgentRun } from '../features/agent/hooks/use-agent-run';

const MODEL = 'llama3.1:8b';

export default function ChatPage() {
  const threads = useThreads();
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const messages = useMessages(activeThreadId);
  const { chatState, sendMessage } = useAgentRun(activeThreadId);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when messages or streaming content changes
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, chatState.activeRun?.streamingMessage]);

  const handleNewThread = useCallback(async () => {
    const thread = await createThread('New Chat', MODEL);
    setActiveThreadId(thread.id);
    setInput('');
  }, []);

  const handleDeleteThread = useCallback(async (id: string) => {
    await deleteThread(id);
    if (activeThreadId === id) {
      setActiveThreadId(null);
    }
  }, [activeThreadId]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || !activeThreadId) return;
    const content = input.trim();
    setInput('');
    await sendMessage(content, { streaming });
  }, [input, activeThreadId, sendMessage, streaming]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div style={styles.container}>
      {/* Sidebar */}
      <aside style={styles.sidebar}>
        <button style={styles.newChatBtn} onClick={handleNewThread}>
          + New Chat
        </button>
        <div style={styles.threadList}>
          {threads?.map((thread) => (
            <div
              key={thread.id}
              style={{
                ...styles.threadItem,
                ...(activeThreadId === thread.id ? styles.threadItemActive : {}),
              }}
              onClick={() => setActiveThreadId(thread.id)}
            >
              <span style={styles.threadTitle}>{thread.title}</span>
              <button
                style={styles.deleteBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeleteThread(thread.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </aside>

      {/* Main chat area */}
      <main style={styles.main}>
        {activeThreadId ? (
          <>
            {/* Messages */}
            <div style={styles.messagesContainer}>
              {messages?.map((msg) => (
                <MessageBubble key={msg.id} message={msg} />
              ))}

              {/* Streaming message */}
              {chatState.activeRun?.streamingMessage && (
                <div style={styles.assistantMsg}>
                  <div style={styles.msgRole}>Assistant</div>
                  <div style={styles.msgContent}>
                    {chatState.activeRun.streamingMessage.content}
                    <span style={styles.cursor}>▊</span>
                  </div>
                </div>
              )}

              {/* Tool activity */}
              {chatState.activeRun?.toolActivity && chatState.activeRun.toolActivity.length > 0 && (
                <div style={styles.toolActivity}>
                  {chatState.activeRun.toolActivity.map((tool) => (
                    <ToolChip key={tool.toolCallId} tool={tool} />
                  ))}
                </div>
              )}

              {/* Running indicator */}
              {chatState.activeRun?.status === 'running' && !chatState.activeRun.streamingMessage && (
                <div style={styles.thinking}>Thinking…</div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Input area */}
            <div style={styles.inputArea}>
              <div style={styles.inputRow}>
                <button
                  style={{ ...styles.toggle, ...(streaming ? styles.toggleOn : {}) }}
                  onClick={() => setStreaming(!streaming)}
                  title="Toggle streaming mode"
                >
                  {streaming ? '⚡ Streaming' : '⏸ Non-streaming'}
                </button>
                <textarea
                  style={styles.input}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type a message…"
                  rows={1}
                  disabled={chatState.activeRun?.status === 'running'}
                />
                <button
                  style={{
                    ...styles.sendBtn,
                    ...((!input.trim() || chatState.activeRun?.status === 'running') ? styles.sendBtnDisabled : {}),
                  }}
                  onClick={handleSend}
                  disabled={!input.trim() || chatState.activeRun?.status === 'running'}
                >
                  Send
                </button>
              </div>
            </div>
          </>
        ) : (
          <div style={styles.emptyState}>
            <h2 style={styles.emptyTitle}>AgenticBot</h2>
            <p style={styles.emptyText}>Select a thread or create a new chat to begin.</p>
            <button style={styles.newChatBtn} onClick={handleNewThread}>
              + New Chat
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user';
  return (
    <div style={isUser ? styles.userMsg : styles.assistantMsg}>
      <div style={styles.msgRole}>{isUser ? 'You' : 'Assistant'}</div>
      <div style={styles.msgContent}>{message.content}</div>
    </div>
  );
}

function ToolChip({ tool }: { tool: { toolName: string; status: string; durationMs?: number } }) {
  const icon = tool.status === 'running' ? '🔄' : tool.status === 'failed' ? '❌' : '✓';
  const label = `${icon} ${tool.toolName}`;
  const time = tool.durationMs ? ` (${tool.durationMs}ms)` : '';
  return (
    <span style={styles.toolChip}>
      {label}
      {time}
    </span>
  );
}

/* ---------- inline styles (clean, minimal, dark-ish) ---------- */

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    height: '100vh',
    width: '100%',
    fontFamily: 'ui-sans-serif, system-ui, sans-serif',
    background: '#0f0f0f',
    color: '#e0e0e0',
  },
  sidebar: {
    width: 260,
    minWidth: 260,
    background: '#1a1a1a',
    borderRight: '1px solid #333',
    display: 'flex',
    flexDirection: 'column',
    padding: 12,
  },
  newChatBtn: {
    background: '#2563eb',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    padding: '10px 16px',
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer',
    marginBottom: 12,
    textAlign: 'center',
  },
  threadList: {
    flex: 1,
    overflowY: 'auto',
  },
  threadItem: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 12px',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
    color: '#aaa',
    marginBottom: 2,
  },
  threadItemActive: {
    background: '#2a2a2a',
    color: '#fff',
  },
  threadTitle: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  deleteBtn: {
    background: 'none',
    border: 'none',
    color: '#666',
    cursor: 'pointer',
    fontSize: 16,
    padding: '0 4px',
  },
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
  },
  messagesContainer: {
    flex: 1,
    overflowY: 'auto',
    padding: 24,
    maxWidth: 800,
    width: '100%',
    margin: '0 auto',
  },
  userMsg: {
    marginBottom: 16,
  },
  assistantMsg: {
    marginBottom: 16,
  },
  msgRole: {
    fontSize: 12,
    fontWeight: 600,
    color: '#888',
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  msgContent: {
    fontSize: 15,
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap',
  },
  cursor: {
    animation: 'blink 1s step-end infinite',
    color: '#888',
  },
  toolActivity: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  toolChip: {
    background: '#222',
    border: '1px solid #333',
    borderRadius: 12,
    padding: '4px 12px',
    fontSize: 12,
    color: '#aaa',
  },
  thinking: {
    color: '#888',
    fontStyle: 'italic',
    fontSize: 14,
    marginBottom: 16,
  },
  inputArea: {
    borderTop: '1px solid #333',
    padding: 16,
    maxWidth: 800,
    width: '100%',
    margin: '0 auto',
  },
  inputRow: {
    display: 'flex',
    gap: 8,
    alignItems: 'flex-end',
  },
  toggle: {
    background: '#222',
    border: '1px solid #333',
    borderRadius: 8,
    padding: '8px 12px',
    fontSize: 12,
    color: '#888',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  toggleOn: {
    background: '#1e3a5f',
    borderColor: '#2563eb',
    color: '#60a5fa',
  },
  input: {
    flex: 1,
    background: '#1a1a1a',
    border: '1px solid #333',
    borderRadius: 8,
    padding: '10px 14px',
    fontSize: 15,
    color: '#e0e0e0',
    resize: 'none',
    outline: 'none',
    fontFamily: 'inherit',
    minHeight: 40,
    maxHeight: 120,
  },
  sendBtn: {
    background: '#2563eb',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    padding: '10px 20px',
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  sendBtnDisabled: {
    background: '#333',
    color: '#666',
    cursor: 'not-allowed',
  },
  emptyState: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  emptyTitle: {
    fontSize: 32,
    fontWeight: 600,
    color: '#fff',
  },
  emptyText: {
    fontSize: 16,
    color: '#888',
  },
};