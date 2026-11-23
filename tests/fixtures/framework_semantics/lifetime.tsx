import { component, onComponentCleanup } from '@fst/components-fst-solid/app/component';
import { State } from '@fst/components-fst-solid/app/state';
import { Form } from '@fst/components-fst-solid/app/form';
import { Scope } from '@fst/components-fst-solid/app/scope';
import { field } from '@fst/components-fst-solid/app/field';
import { useFieldBinding, type InputField } from '@fst/components-fst-solid/app/fieldBinding';
import { onCleanup } from '@fst/components-fst-solid/solid-js';
import { onExit } from '@fst/components-fst-solid/app/dom/hooks';

export class DraftState extends State<DraftState> {
  async initLoad() {}
}
export class DraftForm extends Form<DraftForm, { title: string }> {
  init() {}
  save() {}
}
export class DraftScope extends Scope<DraftScope, {}> {}

export function setup(props: { field?: InputField<string> }, candidate: string | undefined) {
  const state = DraftState.newScoped();
  const form = DraftForm.useOrNewScoped();
  const scope = DraftScope.use();
  const standalone = DraftState.new();
  const raw = new DraftForm();
  const title = form.field('title');
  const binding = useFieldBinding(() => props.field);
  const local = field('initial');
  local(undefined);
  local('changed');
  local(candidate);
  local.onChange(() => {});
  local.onSet(() => {});
  state.init(() => {});
  onCleanup(() => {});
  onComponentCleanup(() => {});
}

export const Panel = component(() => <main />, {
  name: 'DraftPanel',
  onExit: () => afterRender(),
  onRendered: () => undocumentedCallback(),
});
onExit(() => leaveDom());
