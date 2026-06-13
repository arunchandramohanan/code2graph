import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// looks like a project file path: has a slash and a known source extension
const PATH_RE = /^[\w@./\\-]+\/[\w@./\\-]+\.(java|ts|tsx|js|html|css|scss|json|ya?ml|properties|xml)$/;
import { api } from '../api';
import { useApp } from '../context/AppContext';
import { LabelBadge } from '../components/Badges';
import ProjectSelect from '../components/ProjectSelect';

function TrailEntry({ entry }) {
  if (entry.type === 'thought') {
    return <div className="ask-thought">“{entry.text}”</div>;
  }
  return (
    <div className="ask-trail-step mono">
      <span className="ask-trail-tool">{entry.tool}</span>{' '}
      {JSON.stringify(entry.input || {}).slice(0, 140)}
    </div>
  );
}

function ToolTrail({ steps, nodes }) {
  const [open, setOpen] = useState(false);
  const toolCount = (steps || []).filter((s) => s.type !== 'thought').length;
  if (!steps?.length && !nodes?.length) return null;
  return (
    <div className="ask-trail">
      <button className="btn btn-tiny" onClick={() => setOpen(!open)} type="button">
        {open ? '▾' : '▸'} thinking process ({toolCount} graph/source lookups)
      </button>
      {open && (
        <div className="ask-trail-body">
          {steps.map((s, i) => <TrailEntry key={i} entry={s} />)}
          {nodes?.length > 0 && (
            <div className="ask-trail-nodes">
              {nodes.slice(0, 30).map((n) => (
                <Link
                  key={n.id}
                  className="chip chip-link"
                  to={`/graph?focus=${encodeURIComponent(n.id)}`}
                  title={n.id}
                >
                  <LabelBadge label={n.label} /> {n.name}
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// live view while the model is working: most recent thought + running tool list
function ThinkingLive({ trail }) {
  const thoughts = (trail || []).filter((s) => s.type === 'thought');
  const tools = (trail || []).filter((s) => s.type !== 'thought');
  const lastThought = thoughts[thoughts.length - 1];
  return (
    <div>
      <div className="ask-live-head">
        <span className="ask-spinner" /> Thinking — {tools.length} lookups so far
      </div>
      {lastThought && <div className="ask-thought">“{lastThought.text}”</div>}
      <div className="ask-trail-body">
        {tools.slice(-6).map((s, i) => <TrailEntry key={i} entry={s} />)}
      </div>
    </div>
  );
}

function Answer({ text }) {
  const navigate = useNavigate();
  const { project, pushToast } = useApp();

  const openPath = async (path) => {
    try {
      const res = await api.nodeByPath({ project, path });
      navigate(`/graph?focus=${encodeURIComponent(res.id)}`);
    } catch {
      pushToast(`No graph node found for ${path}`);
    }
  };

  const components = {
    code(props) {
      const { className, children } = props;
      const raw = String(children).replace(/\n$/, '');
      const candidate = raw.trim();
      if (!candidate.includes('\n') && PATH_RE.test(candidate)) {
        return (
          <code
            className="ask-path"
            title="open in graph explorer"
            onClick={() => openPath(candidate)}
          >
            {raw}
          </code>
        );
      }
      return <code className={className}>{children}</code>;
    },
  };

  return (
    <div className="ask-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {String(text)}
      </ReactMarkdown>
    </div>
  );
}

export default function AskPage() {
  const { project, pushToast } = useApp();
  const [messages, setMessages] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [liveTrail, setLiveTrail] = useState([]);
  const bottomRef = useRef(null);
  const pollRef = useRef(null);

  useEffect(() => () => clearInterval(pollRef.current), []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy, liveTrail]);

  // project-specific starter questions derived from the graph
  useEffect(() => {
    setSuggestions([]);
    if (!project) return;
    api.askSuggestions(project)
      .then((list) => setSuggestions(Array.isArray(list) ? list : []))
      .catch(() => setSuggestions([]));
  }, [project]);

  const clearChat = useCallback(() => {
    clearInterval(pollRef.current);
    setMessages([]);
    setLiveTrail([]);
    setBusy(false);
  }, []);

  const send = async (text) => {
    const question = (text ?? input).trim();
    if (!question || busy) return;
    if (!project) {
      pushToast('Select a project first.');
      return;
    }
    setInput('');
    const history = messages
      .filter((m) => m.content)
      .map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [...prev, { role: 'user', content: question }]);
    setBusy(true);
    setLiveTrail([]);
    try {
      const { jobId } = await api.ask({ project, question, history });
      pollRef.current = setInterval(async () => {
        try {
          const job = await api.job(jobId);
          setLiveTrail(job.stats?.trail || []);
          if (job.status === 'done' || job.status === 'error') {
            clearInterval(pollRef.current);
            setBusy(false);
            setMessages((prev) => [
              ...prev,
              job.status === 'done'
                ? {
                    role: 'assistant',
                    content: job.stats?.answer || '(no answer)',
                    steps: job.stats?.trail || [],
                    nodes: job.stats?.nodes || [],
                  }
                : {
                    role: 'assistant',
                    content: `**Error:** ${job.error || 'ask failed'}`,
                    steps: job.stats?.trail || [],
                    nodes: [],
                  },
            ]);
            setLiveTrail([]);
          }
        } catch (err) {
          clearInterval(pollRef.current);
          setBusy(false);
          setLiveTrail([]);
          pushToast(`Polling failed: ${err.message}`);
        }
      }, 1200);
    } catch (err) {
      setBusy(false);
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `**Error:** ${err.message}`, steps: [], nodes: [] },
      ]);
    }
  };

  return (
    <div className="page page-fill ask-page">
      <div className="page-head">
        <div>
          <h2>Ask the codebase</h2>
        </div>
        <div className="page-head-actions">
          <ProjectSelect />
          {messages.length > 0 && (
            <button className="btn" onClick={clearChat} type="button">
              Clear chat
            </button>
          )}
        </div>
      </div>

      <div className="ask-thread">
        {messages.length === 0 && !busy && (
          <div className="ask-suggestions">
            {suggestions.map((s) => (
              <button key={s} className="ask-suggestion" onClick={() => send(s)} type="button">
                {s}
              </button>
            ))}
            {!suggestions.length && (
              <div className="muted small">Select an ingested project to see suggested questions.</div>
            )}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`ask-msg ask-msg-${m.role}`}>
            {m.role === 'assistant' ? <Answer text={m.content} /> : m.content}
            {m.role === 'assistant' && <ToolTrail steps={m.steps} nodes={m.nodes} />}
          </div>
        ))}
        {busy && (
          <div className="ask-msg ask-msg-assistant">
            <ThinkingLive trail={liveTrail} />
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <form
        className="ask-input-row"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          className="input ask-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={`Ask anything about "${project || '…'}" — flows, impact, behavior`}
          disabled={busy}
        />
        <button className="btn btn-primary" type="submit" disabled={busy || !input.trim()}>
          {busy ? '…' : 'Ask'}
        </button>
      </form>
    </div>
  );
}
