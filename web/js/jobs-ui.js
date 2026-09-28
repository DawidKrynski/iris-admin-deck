import { jobs } from './jobs.js';
import { h, clear } from './ui.js';

export function jobsIndicator() {
  const list = h('ul.jobs-list', { 'aria-live': 'polite', 'aria-relevant': 'additions text' });
  const panel = h(
    'section.jobs-popover',
    { id: 'background-jobs', hidden: true, 'aria-label': 'Background operations' },
    h('strong', 'Background operations'),
    list,
  );
  const toggle = (open) => {
    panel.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    if (open) draw();
  };
  const trigger = h(
    'button.ghost.jobs-button',
    {
      'aria-label': 'Background operations: 0 running',
      'aria-expanded': 'false',
      'aria-controls': 'background-jobs',
      onclick: () => toggle(panel.hidden),
    },
    'Jobs 0',
  );
  const root = h(
    'div.jobs-indicator',
    {
      onkeydown: (e) => {
        if (e.key === 'Escape') {
          toggle(false);
          trigger.focus();
        }
      },
      onfocusout: (e) => {
        if (!root.contains(e.relatedTarget)) toggle(false);
      },
    },
    trigger,
    panel,
  );
  function draw() {
    const entries = jobs.list();
    const count = entries.filter((e) => e.ended === null).length;
    trigger.textContent = `Jobs ${count}`;
    trigger.setAttribute('aria-label', `Background operations: ${count} running`);
    clear(
      list,
      entries.length
        ? entries
            .slice()
            .reverse()
            .map((e) =>
              h(
                'li',
                { 'data-state': e.state },
                h('strong', e.label),
                h('div', e.state),
                h(
                  'div',
                  { 'aria-live': 'off' },
                  `${Math.floor(((e.ended ?? Date.now()) - e.started) / 1000)} s elapsed`,
                ),
                h('div.muted.small', `Started ${new Date(e.started).toLocaleTimeString()}`),
                e.message ? h('div.small', e.message) : null,
              ),
            )
        : h('li.muted', 'No background operations yet.'),
    );
  }
  const unsubscribe = jobs.subscribe(draw);
  const timer = setInterval(() => {
    if (!root.isConnected) {
      clearInterval(timer);
      unsubscribe();
      return;
    }
    // Update elapsed time without repeatedly announcing the whole list.
    if (!panel.hidden) {
      const entries = jobs.list().slice().reverse();
      [...list.children].forEach((li, i) => {
        const e = entries[i];
        if (e && e.ended === null)
          li.children[2].textContent = `${Math.floor((Date.now() - e.started) / 1000)} s elapsed`;
      });
    }
  }, 1000);
  draw();
  return root;
}
