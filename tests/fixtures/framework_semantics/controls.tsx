import { TextBox, Checkbox, Slider, ColorEditor } from '@fst/components-fst-disco-ui';

export const Controls = () => <>
  <TextBox field={borrowed} onInput={text => consume(text)} />
  <Checkbox checked={enabled} onChange={checked => consume(checked)} />
  <Slider value={position} onInput={number => consume(number)} />
</>;

const defaults = { value: '#123456', onInput: hex => consume(hex) };
export const OverriddenColor = () => <ColorEditor {...defaults} value="#abcdef" />;
export const UnknownProps = () => <TextBox value="obsolete" {...unknown} onInput={text => consume(text)} />;
