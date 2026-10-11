// A long page that mounts in parts (T-A-173; plan 14.2 tactic 4).
//
// React renders a first tree in slices, but it commits it in ONE task, and a page of several thousand
// elements (the component showcase) commits for 90 ms on a laptop: on the 4x throttled phone profile that
// task alone is worth 300 ms of Total Blocking Time. `StagedRoot` holds a queue and `Staged` parts take
// turns in it: one part is mounted per task (a transition, so React slices the render as well), the next
// one is released by the effect of the previous one. A part is always appended below the ones that are
// there, so nothing that is on screen moves. `enabled={false}` mounts everything at once (tests, and any
// page that is short enough).
//
// The root says `data-progressive="pending"` until the queue has been emptied and `"done"` after, so a
// test (the end-to-end `app.ready()`) can wait for the whole page before it looks at it.
import {
  createContext,
  startTransition,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { yieldToMain } from '../../boot/yield';

/**
 * The turns of the parts. A part that is mounted may contain parts of its own: they ask for a turn while
 * the turn of their parent is still running, and are served before the parent's siblings (depth first),
 * so the page fills from the top down and nothing that is on screen is ever pushed by a later part.
 */
class StageQueue {
  private readonly waiting: (() => void)[] = [];
  /** Requests made while a turn is running: the children of the part that has it. */
  private readonly children: (() => void)[] = [];
  private running = false;
  private scheduled = false;

  constructor(private readonly onDrained: () => void) {}

  /** Asks for a turn; the returned function withdraws the request (unmount). */
  enqueue(mount: () => void): () => void {
    (this.running ? this.children : this.waiting).push(mount);
    // A microtask, so that the whole first round of requests is in before the first turn starts.
    if (!this.running && !this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        this.pump();
      });
    }
    return () => {
      for (const list of [this.waiting, this.children]) {
        const index = list.indexOf(mount);
        if (index >= 0) list.splice(index, 1);
      }
    };
  }

  /** The part that had the turn is on screen: its children go first, then the next sibling. */
  finished(): void {
    this.running = false;
    this.waiting.unshift(...this.children.splice(0));
    this.pump();
  }

  /** Called once the first round of requests has been made: nothing asked, nothing to wait for. */
  checkDrained(): void {
    if (this.waiting.length === 0 && this.children.length === 0 && !this.running) this.onDrained();
  }

  private pump(): void {
    if (this.running) return;
    const next = this.waiting.shift();
    if (next === undefined) {
      this.onDrained();
      return;
    }
    this.running = true;
    void yieldToMain().then(next);
  }
}

const StageContext = createContext<StageQueue | null>(null);

export interface StagedRootProps {
  readonly enabled: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}

/** The element that holds a staged page. Without `enabled` it is a plain element and the parts mount at once. */
export function StagedRoot({ enabled, className, children }: StagedRootProps) {
  const [done, setDone] = useState(!enabled);
  const [queue] = useState(() =>
    enabled
      ? new StageQueue(() => {
          setDone(true);
        })
      : null,
  );
  // The children's effects have run (and asked for their turns) before this one does.
  useEffect(() => {
    queue?.checkDrained();
  }, [queue]);
  return (
    <div className={className} data-progressive={done ? 'done' : 'pending'}>
      <StageContext.Provider value={queue}>{children}</StageContext.Provider>
    </div>
  );
}

/** A part of a staged page: mounted when it is its turn, at once outside a `StagedRoot`. */
export function Staged({ children }: { readonly children: ReactNode }) {
  const queue = useContext(StageContext);
  const [mounted, setMounted] = useState(queue === null);
  useEffect(() => {
    if (queue === null) return undefined;
    return queue.enqueue(() => {
      startTransition(() => {
        setMounted(true);
      });
    });
  }, [queue]);
  useEffect(() => {
    if (mounted && queue !== null) queue.finished();
  }, [mounted, queue]);
  return mounted ? children : null;
}
