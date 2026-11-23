import { component as view, componentWithChildren, onComponentCleanup } from '@fst/components-fst-solid/app/component';
import { State, onChange } from '@fst/components-fst-solid/app/state';
import { Form } from '@fst/components-fst-solid/app/form';
import { Scope, ItemScope } from '@fst/components-fst-solid/app/scope';
import { field, type Field } from '@fst/components-fst-solid/app/field';
import { useFieldBinding, type InputField } from '@fst/components-fst-solid/app/fieldBinding';
import { onCleanup } from '@fst/components-fst-solid/solid-js';

export interface Props { field?: InputField<string>; label: string; }
export type Draft = { title: string };
export class EditorState extends State<EditorState> {
  count = 0;
  caption = field('initial');
  async initLoad() {}
  init(configure: (state: EditorState) => void) { configure(this); }
}
export class EditorForm extends Form<EditorForm, Draft> {
  title = this.field('title');
  init() {}
  validate() {}
  errors() { return []; }
  save() {}
  submit() {}
}
export class RowScope extends Scope<RowScope, Draft> {}
export class RowItem extends ItemScope<Draft> {}

const renderCheckbox = (props: Props) => <input value={props.label} />;
export const Checkbox = view<Props>(renderCheckbox, {name:'Checkbox', designName:'controls/check', designConcept:'selection'});
export const OtherCheckbox = componentWithChildren(renderCheckbox, {name:'OtherCheckbox'});
export const GroupedList = view(<T,>(props: { item:T }) => <span />, {name:'GroupedList'}) as <T>(props: { item:T }) => unknown;
export default view(() => <main />, { name: 'DefaultPage' });

export function setup(props: Props) {
  const state = EditorState.newScoped();
  const form = EditorForm.useOrNewScoped();
  const scope = RowScope.use();
  const item = RowItem.newScoped();
  const global = EditorState.useGlobal();
  const raw = new EditorForm();
  const standalone = field<string>('value');
  const title = form.field("items[id=='sku-1'].quantity");
  const typed: Field<string> = standalone;
  const binding = useFieldBinding(() => props.field);
  standalone.onChange(() => {});
  standalone.onSet(() => {});
  standalone(undefined);
  standalone('write');
  onChange([() => state.count, () => form.data()], () => {});
  onCleanup(() => {});
  onComponentCleanup(() => {});
  return { state, form, scope, item, global, raw, title, typed, binding };
}
