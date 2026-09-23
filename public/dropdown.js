/** CoffeeJack custom dark listbox dropdown — no native OS menus. */

let dropdownSeq = 0;

function normalizeOptions(options) {
  return options.map((item) =>
    typeof item === "string" ? { value: item, label: item } : item,
  );
}

/**
 * @param {object} opts
 * @param {string} [opts.name]
 * @param {Array<{value: string, label: string}|string>} [opts.options]
 * @param {string} [opts.value]
 * @param {string} [opts.ariaLabel]
 * @param {boolean} [opts.disabled]
 * @param {string} [opts.className]
 * @param {(value: string, option: {value: string, label: string}) => void} [opts.onChange]
 * @returns {HTMLElement & {
 *   setOptions: (options: Array<{value: string, label: string}|string>) => void,
 *   setValue: (value: string) => void,
 *   getValue: () => string,
 *   destroy: () => void,
 * }}
 */
export function createDropdown(opts = {}) {
  const {
    name,
    options: rawOptions = [],
    value,
    ariaLabel,
    disabled = false,
    className = "",
    onChange,
  } = opts;

  let options = normalizeOptions(rawOptions);
  let currentValue = value ?? options[0]?.value ?? "";
  let isOpen = false;
  let activeIndex = -1;
  let isDisabled = disabled;
  const id = `cj-dropdown-${++dropdownSeq}`;

  const root = document.createElement("div");
  root.className = ["cj-dropdown", className].filter(Boolean).join(" ");

  /** @type {HTMLInputElement|null} */
  let hiddenInput = null;
  if (name) {
    hiddenInput = document.createElement("input");
    hiddenInput.type = "hidden";
    hiddenInput.name = name;
    hiddenInput.value = currentValue;
    root.appendChild(hiddenInput);
  }

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "cj-dropdown__trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  if (ariaLabel) trigger.setAttribute("aria-label", ariaLabel);

  const menu = document.createElement("ul");
  menu.className = "cj-dropdown__menu";
  menu.setAttribute("role", "listbox");
  menu.id = `${id}-listbox`;
  menu.hidden = true;
  trigger.setAttribute("aria-controls", menu.id);

  function findIndex(v) {
    return options.findIndex((o) => o.value === v);
  }

  function getLabel(v) {
    return options.find((o) => o.value === v)?.label ?? v;
  }

  function syncHidden() {
    if (hiddenInput) hiddenInput.value = currentValue;
  }

  function updateTriggerLabel() {
    trigger.textContent = getLabel(currentValue);
  }

  function renderOptions() {
    menu.innerHTML = "";
    options.forEach((opt, index) => {
      const li = document.createElement("li");
      li.className = "cj-dropdown__option";
      li.setAttribute("role", "option");
      li.id = `${id}-opt-${index}`;
      li.dataset.value = opt.value;
      li.textContent = opt.label;
      li.setAttribute(
        "aria-selected",
        String(opt.value === currentValue),
      );
      li.tabIndex = -1;
      li.addEventListener("mousedown", (e) => e.preventDefault());
      li.addEventListener("click", () => selectValue(opt.value));
      menu.appendChild(li);
    });
    updateTriggerLabel();
    syncHidden();
  }

  function highlight(index) {
    const items = [...menu.querySelectorAll(".cj-dropdown__option")];
    if (!items.length) return;
    activeIndex = ((index % items.length) + items.length) % items.length;
    items.forEach((el, i) => {
      const active = i === activeIndex;
      el.classList.toggle("is-active", active);
      if (active) {
        trigger.setAttribute("aria-activedescendant", el.id);
        el.scrollIntoView({ block: "nearest" });
      }
    });
  }

  function clearHighlight() {
    menu.querySelectorAll(".cj-dropdown__option").forEach((el) => {
      el.classList.remove("is-active");
    });
    trigger.removeAttribute("aria-activedescendant");
  }

  function openMenu() {
    if (isDisabled || isOpen) return;
    isOpen = true;
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    activeIndex = findIndex(currentValue);
    if (activeIndex < 0) activeIndex = 0;
    highlight(activeIndex);
  }

  function closeMenu() {
    if (!isOpen) return;
    isOpen = false;
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    clearHighlight();
  }

  function toggleMenu() {
    if (isOpen) closeMenu();
    else openMenu();
  }

  function selectValue(next) {
    const changed = next !== currentValue;
    currentValue = next;
    syncHidden();
    updateTriggerLabel();
    menu.querySelectorAll(".cj-dropdown__option").forEach((el) => {
      el.setAttribute(
        "aria-selected",
        String(el.dataset.value === currentValue),
      );
    });
    closeMenu();
    if (changed) {
      const option = options.find((o) => o.value === next);
      onChange?.(next, option ?? { value: next, label: getLabel(next) });
    }
  }

  function onDocumentPointer(e) {
    if (!root.contains(/** @type {Node} */ (e.target))) closeMenu();
  }

  function onDocumentKey(e) {
    if (e.key === "Escape" && isOpen) {
      e.preventDefault();
      closeMenu();
      trigger.focus();
    }
  }

  trigger.addEventListener("click", () => toggleMenu());

  trigger.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!isOpen) openMenu();
        else highlight(activeIndex + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (!isOpen) openMenu();
        else highlight(activeIndex - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (isOpen && activeIndex >= 0) {
          const items = menu.querySelectorAll(".cj-dropdown__option");
          const item = items[activeIndex];
          if (item) selectValue(item.dataset.value);
        } else openMenu();
        break;
      case "Home":
        if (isOpen) {
          e.preventDefault();
          highlight(0);
        }
        break;
      case "End":
        if (isOpen) {
          e.preventDefault();
          highlight(options.length - 1);
        }
        break;
      case "Escape":
        if (isOpen) {
          e.preventDefault();
          closeMenu();
        }
        break;
      default:
        break;
    }
  });

  document.addEventListener("pointerdown", onDocumentPointer);
  document.addEventListener("keydown", onDocumentKey);

  root.setOptions = (nextOptions) => {
    options = normalizeOptions(nextOptions);
    if (!options.some((o) => o.value === currentValue)) {
      currentValue = options[0]?.value ?? "";
    }
    renderOptions();
  };

  root.setValue = (next) => {
    currentValue = next;
    syncHidden();
    updateTriggerLabel();
    menu.querySelectorAll(".cj-dropdown__option").forEach((el) => {
      el.setAttribute(
        "aria-selected",
        String(el.dataset.value === currentValue),
      );
    });
  };

  root.getValue = () => currentValue;

  root.destroy = () => {
    document.removeEventListener("pointerdown", onDocumentPointer);
    document.removeEventListener("keydown", onDocumentKey);
    closeMenu();
    root.remove();
  };

  if (isDisabled) trigger.disabled = true;

  Object.defineProperty(root, "disabled", {
    get: () => isDisabled,
    set: (next) => {
      isDisabled = Boolean(next);
      trigger.disabled = isDisabled;
      if (isDisabled) closeMenu();
    },
  });

  root.append(trigger, menu);
  renderOptions();

  return root;
}

/**
 * @param {Element|string|null} elementOrSelector
 * @param {Parameters<typeof createDropdown>[0]} options
 */
export function mountDropdown(elementOrSelector, options) {
  const host =
    typeof elementOrSelector === "string"
      ? document.querySelector(elementOrSelector)
      : elementOrSelector;
  const dropdown = createDropdown(options);
  if (host) {
    host.replaceChildren(dropdown);
  }
  return dropdown;
}
