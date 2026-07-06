// Framework-less context menu. One reused host div on document.body; a single
// menu is open at a time. No editor imports — usable from anywhere.

export interface MenuItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  /** Native tooltip — used to explain why a disabled item can't be chosen. */
  title?: string;
  onSelect(): void;
}

let host: HTMLDivElement | null = null;
let items: MenuItem[] = [];
let activeIndex = -1;

function ensureHost(): HTMLDivElement {
  if (host) return host;
  const el = document.createElement("div");
  el.className = "ctx-menu";
  el.setAttribute("role", "menu");
  document.body.appendChild(el);
  host = el;
  return el;
}

function isOpen(): boolean {
  return host !== null && host.style.display === "block";
}

function focusableIndices(): number[] {
  const out: number[] = [];
  for (let i = 0; i < items.length; i++) if (!items[i]!.disabled) out.push(i);
  return out;
}

function setActive(index: number): void {
  if (!host) return;
  activeIndex = index;
  const buttons = host.querySelectorAll<HTMLButtonElement>(".ctx-menu__item");
  buttons.forEach((b, i) => {
    if (i === index) {
      b.classList.add("ctx-menu__item--active");
      b.focus();
    } else {
      b.classList.remove("ctx-menu__item--active");
    }
  });
}

function moveActive(delta: number): void {
  const idxs = focusableIndices();
  if (idxs.length === 0) return;
  const pos = idxs.indexOf(activeIndex);
  const next = pos < 0 ? (delta > 0 ? 0 : idxs.length - 1) : (pos + delta + idxs.length) % idxs.length;
  setActive(idxs[next]!);
}

function select(index: number): void {
  const item = items[index];
  if (!item || item.disabled) return;
  closeMenu();
  item.onSelect();
}

function onKeyDown(e: KeyboardEvent): void {
  if (!isOpen()) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closeMenu();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    moveActive(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    moveActive(-1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (activeIndex >= 0) select(activeIndex);
  }
}

function onOutsidePointerDown(e: PointerEvent): void {
  if (!host) return;
  if (!host.contains(e.target as Node)) closeMenu();
}

function onDismiss(): void {
  closeMenu();
}

function addListeners(): void {
  // capture phase so an outside pointerdown closes before other handlers run
  document.addEventListener("pointerdown", onOutsidePointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("wheel", onDismiss, true);
  window.addEventListener("resize", onDismiss);
  window.addEventListener("blur", onDismiss);
}

function removeListeners(): void {
  document.removeEventListener("pointerdown", onOutsidePointerDown, true);
  document.removeEventListener("keydown", onKeyDown, true);
  window.removeEventListener("wheel", onDismiss, true);
  window.removeEventListener("resize", onDismiss);
  window.removeEventListener("blur", onDismiss);
}

export function showMenu(x: number, y: number, menuItems: MenuItem[]): void {
  const wasOpen = isOpen();
  const el = ensureHost();
  items = menuItems;
  activeIndex = -1;

  el.textContent = "";
  menuItems.forEach((item, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ctx-menu__item";
    if (item.danger) btn.classList.add("ctx-menu__item--danger");
    btn.textContent = item.label;
    if (item.title) btn.title = item.title;
    if (item.disabled) {
      btn.disabled = true;
    } else {
      btn.addEventListener("click", () => select(i));
      btn.addEventListener("pointerenter", () => setActive(i));
    }
    el.appendChild(btn);
  });

  // measure off-screen, then clamp into the viewport
  el.style.display = "block";
  el.style.left = "0px";
  el.style.top = "0px";
  const rect = el.getBoundingClientRect();
  const pad = 4;
  const left = Math.max(pad, Math.min(x, window.innerWidth - rect.width - pad));
  const top = Math.max(pad, Math.min(y, window.innerHeight - rect.height - pad));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;

  if (!wasOpen) addListeners();
}

export function closeMenu(): void {
  if (!host) return;
  host.style.display = "none";
  host.textContent = "";
  items = [];
  activeIndex = -1;
  removeListeners();
}
