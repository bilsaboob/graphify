import { createSignal as signal, For, Index, Show } from '@fst/components-fst-solid/solid-js';
import { createStore } from '@fst/components-fst-solid/solid-js/store';
import { Dynamic } from '@fst/components-fst-solid/solid-js/web';

export function setup() {
  const [first, setFirst] = signal(0);
  const [second, setSecond] = signal(1);
  const write = setFirst;
  const [record, update] = createStore({ title: 'before' });
  const patch = update;
  first();
  first();
  second();
  setFirst(2);
  setSecond(3);
  write(4);
  const title = record.title;
  update('title', 'after');
  patch('title', 'again');
}

export const Lists = () => <>
  <For each={items}>{(item, index) => <i />}</For>
  <Index each={items}>{(item, index) => <i />}</Index>
  <Show when={current} keyed>{item => <i />}</Show>
  <Show when={current}>{item => <i />}</Show>
</>;

export const Overridden = () => <Dynamic component={Known} {...forwarded} />;
