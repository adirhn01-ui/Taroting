// A three-line element builder for the PDF editor's shell, page panel, find
// bar and dialogs. Built through the DOM API rather than markup strings, so
// no user text (a file name, a project name) ever passes through innerHTML;
// icons are trusted SVG strings from the icon modules and go in as markup.

export interface ElProps {
  id?: string;
  className?: string;
  title?: string;
  text?: string;
  /** trusted inline SVG (an icon module's output), placed before `text` */
  icon?: string;
  attrs?: Record<string, string>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  children: (Node | null)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.id) node.id = props.id;
  if (props.className) node.className = props.className;
  if (props.title) node.title = props.title;
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) node.setAttribute(k, v);
  if (props.icon !== undefined) node.innerHTML = props.icon;
  if (props.text !== undefined) {
    if (props.icon !== undefined) node.appendChild(document.createTextNode(props.text));
    else node.textContent = props.text;
  }
  for (const c of children) if (c) node.appendChild(c);
  return node;
}

/** A button: `btn` plus the given modifiers. */
export function button(
  modifiers: string,
  props: ElProps & { label?: string } = {},
): HTMLButtonElement {
  const b = el("button", { ...props, className: `btn ${modifiers}${props.className ? ` ${props.className}` : ""}` });
  b.type = "button";
  if (props.label) b.setAttribute("aria-label", props.label);
  return b;
}
