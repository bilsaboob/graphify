import { onCleanup } from "@fst/components-fst-solid/solid-js";

export function cleanup() {
  return undefined;
}

export function Page() {
  const title = "TITLE";
  onCleanup(cleanup);
  return <section>{title}</section>;
}
