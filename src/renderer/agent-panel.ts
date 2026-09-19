import { ui, t } from './i18n.js';
import type { SessionSummary, SessionEvent } from '../shared/session.js';
import type { AgentSystemStatus } from '../shared/agent-system.js';
import { el } from './dom.js';
import { attachWorkPanelResize } from './work-panel-resize.js';

/** A read-only second pane. Its selection never changes the main chat's composer. */
export function createAgentPanel(options: {
  host: HTMLElement;
  toggle: HTMLButtonElement;
  onShow?: () => void;
  load: (id: string) => Promise<{ events: SessionEvent[] } | null>;
  loadControlCenter?: () => Promise<AgentSystemStatus | null>;
  render: (events: SessionEvent[], id: string, current: () => boolean) => HTMLElement[];
  openMain: (id: string) => void;
  working: (summary: SessionSummary) => boolean;
}) {
  const pane = el('aside', 'agent-panel'); pane.hidden = true;
  ui(pane, 'aria-label', () => t("Sub-agents"));
  attachWorkPanelResize(options.host, pane);
  const head = el('div', 'agent-panel-header'); head.hidden = true;
  const back = el('button', 'btn', '←'); ui(back, 'title', () => t("Back to sub-agents")); back.setAttribute('type', 'button');
  back.setAttribute('aria-label', back.title);
  const title = el('strong');
  const body = el('div', 'agent-panel-body');
  head.append(back, title); pane.append(head, body); options.host.append(pane);
  let parent: string | null = null, workers: SessionSummary[] = [], selected: string | null = null;
  let controlOpen = false;
  let generation = 0;
  function hide(): void {
    generation++; pane.hidden = true; selected = null; controlOpen = false;
    options.host.classList.remove('has-agent-panel'); options.toggle.setAttribute('aria-expanded', 'false');
  }
  function show(): void {
    options.onShow?.();
    pane.hidden = false; options.host.classList.add('has-agent-panel'); options.toggle.setAttribute('aria-expanded', 'true');
  }
  function list(): void {
    generation++; selected = null; controlOpen = false; head.hidden = true; body.replaceChildren();
    if (options.loadControlCenter) {
      const control = el('button', 'agent-panel-row agent-control-entry');
      control.setAttribute('type', 'button');
      control.append(el('span', 'agent-control-icon', '⌘'), el('span', '', () => t("Control Center")));
      control.onclick = () => void controlCenter();
      body.append(control);
    }
    for (const active of [true, false]) {
      const group = workers.filter(worker => options.working(worker) === active);
      body.append(el('h3', '', () => `${active ? t("Active") : t("History")} · ${group.length}`));
      if (!group.length) { body.append(el('p', 'meta', () => active ? t("No active sub-agents") : t("No recorded sub-agents"))); continue; }
      for (const worker of group) {
        const row = el('button', 'agent-panel-row'); row.setAttribute('type', 'button');
        row.append(el('span', 'agent-avatar', worker.origin?.agentId?.replace(/^worker-/, '') ?? '•'), el('span', '', worker.title));
        row.title = worker.origin?.task || worker.title;
        row.onclick = () => void open(worker.id); body.append(row);
      }
    }
  }
  async function controlCenter(refresh = false): Promise<void> {
    if (!options.loadControlCenter) return;
    const preserve = refresh && controlOpen && !pane.hidden;
    show(); selected = null; controlOpen = true; const request = ++generation;
    head.hidden = false; title.textContent = t("Control Center");
    if (!preserve) body.replaceChildren(el('p', 'meta', () => t("Loading agent system…")));
    const current = () => request === generation && controlOpen && !pane.hidden;
    const status = await options.loadControlCenter();
    if (!current()) return;
    if (!status) {
      body.replaceChildren(el('p', 'meta', () => t("No Agent System 3.0 run is active.")));
      return;
    }
    const summary = el('div', 'agent-control-summary');
    const progress = status.progress.total > 0
      ? Math.round(status.progress.verified / status.progress.total * 100)
      : 0;
    summary.append(
      el('div', 'agent-control-stat', () => `${status.progress.verified}/${status.progress.total} verified`),
      el('div', 'agent-control-stat', () => `${status.agents.filter(agent => agent.active).length} active`),
      el('div', 'agent-control-stat', () => `${progress}%`)
    );
    const meta = el('p', 'meta', `Manager: ${status.managerAgentId} · ${status.runStatus === 'RUN_VERIFIED' ? 'verified' : 'running'}`);
    const tasks = el('div', 'agent-control-tasks');
    tasks.append(el('h3', '', () => `Tasks · ${status.tasks.length}`));
    for (const task of status.tasks) {
      const row = el('div', 'agent-control-task');
      const text = el('div', 'agent-control-task-copy');
      text.append(
        el('strong', '', task.title),
        el('span', 'meta', () => [task.id, task.assignedWorkerId, task.reviewerId ? `review: ${task.reviewerId}` : ''].filter(Boolean).join(' · '))
      );
      const state = el('span', 'agent-control-state', task.state.replaceAll('_', ' ').toLowerCase());
      state.dataset.state = task.state;
      row.append(text, state);
      tasks.append(row);
    }
    body.replaceChildren(summary, meta, tasks);
  }

  async function open(id: string, refresh = false): Promise<void> {
    const worker = workers.find(row => row.id === id);
    if (!worker) return;
    const preserve = refresh && selected === id && !pane.hidden;
    show(); controlOpen = false; selected = id; const request = ++generation;
    head.hidden = false; title.textContent = worker.title;
    if (!preserve) body.replaceChildren(el('p', 'meta', () => t("Loading conversation…")));
    const current = () => request === generation && selected === id && !pane.hidden;
    const detail = await options.load(id);
    if (!current()) return;
    if (!detail) { body.replaceChildren(el('p', 'meta', () => t("Conversation unavailable"))); return; }
    const openMain = el('button', 'btn', () => t("Open full chat")); openMain.setAttribute('type', 'button');
    openMain.onclick = () => { hide(); options.openMain(id); };
    const position = body.scrollTop;
    const follow = !preserve || position + body.clientHeight >= body.scrollHeight - 40;
    body.replaceChildren(openMain, ...options.render(detail.events, id, current));
    body.scrollTop = follow ? body.scrollHeight : position;
  }
  back.onclick = list;
  pane.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); hide(); options.toggle.focus();
  });
  options.toggle.onclick = () => { if (pane.hidden) { show(); list(); } else hide(); };
  return {
    hide,
    open,
    update(id: string | null, next: SessionSummary[]): void {
      if (parent !== id) { hide(); parent = id; }
      const previous = workers.find(worker => worker.id === selected);
      workers = next; options.toggle.hidden = id === null;
      ui(options.toggle, 'title', () => t("Sub-agents · {0} recorded", [workers.length]));
      if (pane.hidden) return;
      const latest = workers.find(worker => worker.id === selected);
      if (controlOpen) { void controlCenter(true); return; }
      if (!selected || !latest) list();
      else if (latest.updatedAt !== previous?.updatedAt) void open(latest.id, true);
    }
  };
}
