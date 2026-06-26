import { computed, nextTick, ref, type ComputedRef, type CSSProperties, type Ref } from 'vue';

export type ScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

export type DiffScrollbarPane<Key extends string> = {
  element: Ref<HTMLElement | null>;
  hasScroll: Ref<boolean>;
  metrics: Ref<ScrollMetrics>;
  thumbStyle: ComputedRef<CSSProperties>;
};

const emptyScrollMetrics = (): ScrollMetrics => ({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 });

const paneHasVerticalScroll = (element: HTMLElement | null) => Boolean(element && element.scrollHeight > element.clientHeight + 1);

const paneScrollMetrics = (element: HTMLElement | null): ScrollMetrics => ({
  scrollTop: element?.scrollTop ?? 0,
  scrollHeight: element?.scrollHeight ?? 0,
  clientHeight: element?.clientHeight ?? 0,
});

const scrollThumbStyle = (metrics: ScrollMetrics): CSSProperties => {
  if (metrics.scrollHeight <= metrics.clientHeight || metrics.clientHeight <= 0) return { display: 'none' };
  return {
    top: `${(metrics.scrollTop / metrics.scrollHeight) * 100}%`,
    height: `${Math.max((metrics.clientHeight / metrics.scrollHeight) * 100, 6)}%`,
  };
};

export const useDiffScrollbar = <Key extends string>(elements: Record<Key, Ref<HTMLElement | null>>) => {
  const panes = {} as Record<Key, DiffScrollbarPane<Key>>;
  for (const key of Object.keys(elements) as Key[]) {
    const metrics = ref<ScrollMetrics>(emptyScrollMetrics());
    panes[key] = {
      element: elements[key],
      hasScroll: ref(false),
      metrics,
      thumbStyle: computed(() => scrollThumbStyle(metrics.value)),
    };
  }

  let frame: number | undefined;
  let afterRenderFrame: number | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let drag: { pane: Key; startY: number; startScrollTop: number; trackHeight: number } | undefined;

  const paneForKey = (pane: Key) => panes[pane].element.value;

  const update = () => {
    frame = undefined;
    for (const key of Object.keys(panes) as Key[]) {
      const pane = panes[key];
      const hasScroll = paneHasVerticalScroll(pane.element.value);
      const metrics = paneScrollMetrics(pane.element.value);
      if (pane.hasScroll.value !== hasScroll) pane.hasScroll.value = hasScroll;
      if (!sameScrollMetrics(pane.metrics.value, metrics)) pane.metrics.value = metrics;
    }
  };

  const schedule = () => {
    if (frame !== undefined) return;
    frame = requestAnimationFrame(update);
  };

  const updateAfterRender = () => {
    void nextTick(() => {
      if (frame !== undefined) return;
      if (afterRenderFrame !== undefined) return;
      afterRenderFrame = requestAnimationFrame(() => {
        afterRenderFrame = undefined;
        update();
      });
    });
  };

  const observe = (element: HTMLElement | null) => {
    if (!element) return;
    resizeObserver?.observe(element);
  };

  const startObserving = (elementsToObserve: Array<HTMLElement | null>) => {
    resizeObserver = new ResizeObserver(update);
    for (const element of elementsToObserve) observe(element);
    updateAfterRender();
  };

  const onTrackPointerDown = (event: PointerEvent, pane: Key) => {
    const element = paneForKey(pane);
    const track = event.currentTarget as HTMLElement;
    if (!element || track.clientHeight <= 0) return;

    const thumbHeight = Math.max((element.clientHeight / element.scrollHeight) * track.clientHeight, 24);
    const trackTop = track.getBoundingClientRect().top;
    const targetTop = event.clientY - trackTop - thumbHeight / 2;
    element.scrollTop = Math.max(
      0,
      Math.min((targetTop / track.clientHeight) * element.scrollHeight, element.scrollHeight - element.clientHeight),
    );
    schedule();
  };

  const onThumbPointerDown = (event: PointerEvent, pane: Key) => {
    const element = paneForKey(pane);
    const track = (event.currentTarget as HTMLElement).parentElement;
    if (!element || !track || track.clientHeight <= 0) return;

    drag = { pane, startY: event.clientY, startScrollTop: element.scrollTop, trackHeight: track.clientHeight };
    window.addEventListener('pointermove', onThumbPointerMove);
    window.addEventListener('pointerup', stopDrag, { once: true });
  };

  const onThumbPointerMove = (event: PointerEvent) => {
    if (!drag) return;
    const element = paneForKey(drag.pane);
    if (!element || drag.trackHeight <= 0) return;

    const deltaY = event.clientY - drag.startY;
    element.scrollTop = drag.startScrollTop + (deltaY / drag.trackHeight) * element.scrollHeight;
    schedule();
  };

  const stopDrag = () => {
    drag = undefined;
    window.removeEventListener('pointermove', onThumbPointerMove);
  };

  const cleanup = () => {
    window.removeEventListener('pointermove', onThumbPointerMove);
    window.removeEventListener('pointerup', stopDrag);
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (afterRenderFrame !== undefined) cancelAnimationFrame(afterRenderFrame);
    resizeObserver?.disconnect();
  };

  return {
    panes,
    update,
    schedule,
    updateAfterRender,
    startObserving,
    onTrackPointerDown,
    onThumbPointerDown,
    cleanup,
  };
};

const sameScrollMetrics = (first: ScrollMetrics, second: ScrollMetrics) => {
  return first.scrollTop === second.scrollTop && first.scrollHeight === second.scrollHeight && first.clientHeight === second.clientHeight;
};
