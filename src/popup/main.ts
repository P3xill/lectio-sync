import type browser from "webextension-polyfill";
import { formatDisplayDateTime, formatDisplayTime } from "../core/date";
import { CALENDAR_COLOR_OPTIONS, MAX_CHECK_INTERVAL_MINUTES, MIN_CHECK_INTERVAL_MINUTES } from "../core/settings";
import { DEFAULT_STATE, type ExtensionState, type RuntimeMessage, type RuntimeResponse } from "../core/types";
import "./styles.css";

type View = "main" | "settings" | "details";

const appRoot = document.querySelector<HTMLDivElement>("#app");
if (!appRoot) throw new Error("Popup root is missing.");
const root: HTMLDivElement = appRoot;

let state: ExtensionState = DEFAULT_STATE;
let view: View = "main";
let busy = false;
let transientMessage = "";
let transientIsError = false;
let browserApi: typeof browser | undefined;

const isSafari = __TARGET_BROWSER__ === "safari";
const calendarStatusLabel = isSafari ? "Google via Apple Calendar" : "Google Calendar";
const connectCalendarLabel = isSafari ? "Connect Apple Calendar" : "Connect Google Calendar";
const settingsMenuFocusSelector = '[data-focus-key="settings-menu"]';
const settingsActionFocusSelector = '[data-focus-key="settings-action"]';
const detailsActionFocusSelector = '[data-focus-key="view-details"]';

let pendingFocusSelector: string | undefined;
let backFocusSelector = settingsMenuFocusSelector;

function isPreview(): boolean {
  return location.protocol === "http:" || location.protocol === "https:";
}

function previewState(): ExtensionState {
  const preview = new URLSearchParams(location.search).get("preview") ?? "setup";
  const now = new Date();
  const connected = {
    lectioAccount: { schoolId: "23", studentId: "42", schoolName: "Rysensteen Gymnasium", connectedAt: now.toISOString() },
    googleCalendarId: "preview-calendar",
    googleCalendarName: "Lectio"
  };
  if (preview === "healthy") {
    return { ...DEFAULT_STATE, ...connected, status: "healthy", lastSuccessAt: now.toISOString(), nextSyncAt: new Date(now.getTime() + 8 * 60_000).toISOString() };
  }
  if (preview === "expired") {
    return { ...DEFAULT_STATE, ...connected, status: "lectio_expired", lastError: { code: "LECTIO_AUTH_REQUIRED", message: "Your Lectio login has expired.", occurredAt: now.toISOString() } };
  }
  if (preview === "error") {
    return { ...DEFAULT_STATE, ...connected, status: "safe_error", lastError: { code: "LECTIO_UNEXPECTED_PAGE", message: "Lectio returned an unexpected page.", occurredAt: now.toISOString(), technicalDetail: "Schedule markers were not found. Calendar writes were skipped." } };
  }
  if (preview === "google-disconnected") {
    return {
      ...DEFAULT_STATE,
      lectioAccount: connected.lectioAccount,
      status: "google_disconnected",
      lastError: { code: "GOOGLE_AUTH_REQUIRED", message: "Google Calendar access needs to be reconnected.", occurredAt: now.toISOString() }
    };
  }
  if (preview === "settings") {
    view = "settings";
    return { ...DEFAULT_STATE, ...connected, status: "healthy", lastSuccessAt: now.toISOString() };
  }
  return DEFAULT_STATE;
}

async function send<T = unknown>(message: RuntimeMessage): Promise<T> {
  if (isPreview()) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (message.type === "GET_STATE") return previewState() as T;
    if (message.type === "START_LECTIO_SETUP") return state as T;
    if (message.type === "UPDATE_SETTINGS") {
      state = { ...state, settings: { ...state.settings, ...message.settings } };
      return state as T;
    }
    if (message.type === "CONNECT_GOOGLE") {
      state = { ...state, googleCalendarId: "preview-calendar", googleCalendarName: "Lectio", status: "ready", lastError: undefined };
      return state as T;
    }
    return undefined as T;
  }
  browserApi ??= (await import("webextension-polyfill")).default;
  const response = await browserApi.runtime.sendMessage(message) as RuntimeResponse<T>;
  if (!response.ok) throw response.error ?? new Error("Action failed.");
  return response.data as T;
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { className?: string; text?: string; attrs?: Record<string, string> } = {},
  ...children: Array<Node | undefined>
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = options.text;
  for (const [name, value] of Object.entries(options.attrs ?? {})) element.setAttribute(name, value);
  element.append(...children.filter((child): child is Node => Boolean(child)));
  return element;
}

function icon(kind: "calendar" | "check" | "warning" | "lock" | "clock" | "arrow" | "settings"): SVGSVGElement {
  const paths: Record<typeof kind, string> = {
    calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    warning: '<path d="M10.3 3.8 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>'
  };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const parsed = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg">${paths[kind]}</svg>`,
    "image/svg+xml"
  );
  for (const child of Array.from(parsed.documentElement.children)) {
    svg.append(document.importNode(child, true));
  }
  return svg;
}

function setView(nextView: View, focusSelector = "h1"): void {
  view = nextView;
  pendingFocusSelector = focusSelector;
  transientMessage = "";
  transientIsError = false;
}

function openSubView(nextView: Exclude<View, "main">, returnFocusSelector: string): void {
  backFocusSelector = returnFocusSelector;
  setView(nextView);
}

function focusPendingTarget(): void {
  const selector = pendingFocusSelector;
  pendingFocusSelector = undefined;
  if (!selector) return;
  const target = root.querySelector<HTMLElement>(selector);
  if (!target) return;
  if (target instanceof HTMLHeadingElement) target.tabIndex = -1;
  target.focus({ preventScroll: true });
}

function header(title = "Lectio Sync", back = false): HTMLElement {
  const left = node("div", { className: "brand" }, icon("calendar"), node("span", { text: title }));
  const action = back
    ? node("button", {
      className: "button quiet icon-button",
      attrs: { type: "button", "aria-label": "Back" }
    }, node("span", { text: "←", attrs: { "aria-hidden": "true" } }))
    : node("button", { className: "menu-button", attrs: { type: "button", "aria-label": "Open settings", "data-focus-key": "settings-menu" } }, icon("settings"));
  action.addEventListener("click", () => {
    if (back) setView("main", backFocusSelector);
    else openSubView("settings", settingsMenuFocusSelector);
    render();
  });
  return node("header", { className: "app-header" }, left, action);
}

function actionButton(label: string, className: string, handler: () => void | Promise<void>, leading?: string): HTMLButtonElement {
  const button = node("button", { className: `button ${className}`, attrs: { type: "button" } });
  if (leading) button.append(node("span", { className: "button-leading", text: leading }));
  button.append(node("span", { text: label }));
  button.disabled = busy;
  button.addEventListener("click", () => void perform(handler));
  return button;
}

async function perform(handler: () => void | Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  transientMessage = "";
  transientIsError = false;
  render();
  try {
    await handler();
  } catch (error) {
    transientMessage = typeof error === "object" && error && "message" in error ? String(error.message) : "That action could not be completed.";
    transientIsError = true;
  } finally {
    busy = false;
    render();
  }
}

function formatRelative(raw?: string): string {
  if (!raw) return "Never";
  const difference = Date.now() - new Date(raw).getTime();
  if (difference < 60_000) return "just now";
  const minutes = Math.round(difference / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  return formatDisplayTime(new Date(raw));
}

function nextCheckLabel(raw?: string): string {
  if (!raw) return "Sync paused";
  const minutes = Math.max(0, Math.ceil((new Date(raw).getTime() - Date.now()) / 60_000));
  return minutes === 0 ? "Checking soon" : `Next check in ${minutes} min`;
}

function statusRow(label: string, connected: boolean, detail?: string): HTMLElement {
  return node("div", { className: "status-row" },
    node("div", { className: "status-label" },
      node("span", { className: `status-dot ${connected ? "connected" : "pending"}`, attrs: { "aria-hidden": "true" } }),
      node("span", { text: label })
    ),
    node("span", { className: `status-value ${connected ? "" : "muted"}`, text: detail ?? (connected ? "Connected" : "Not connected") })
  );
}

function appleCalendarNote(): HTMLElement {
  const text = "Lectio Sync stores events in Google Calendar. Add the same Google account to Apple Calendar on every Mac, iPhone, and iPad where you want to see them.";

  return node("aside", { className: "calendar-note", attrs: { "aria-label": "Apple Calendar setup" } },
    icon("calendar"),
    node("div", { className: "calendar-note-copy" },
      node("strong", { text: "Using Apple Calendar? Connect Google on every device" }),
      node("p", { text }),
      node("p", { className: "calendar-note-limit", text: "This version does not create or sync an iCloud calendar." })
    )
  );
}

function setupView(): HTMLElement {
  const lectioConnected = Boolean(state.lectioAccount);
  const googleConnected = Boolean(state.googleCalendarId);
  const title = node("h1", { text: "Lectio Sync" });
  const intro = node("p", { className: "lead", text: "Your timetable, where you need it." });
  const steps = node("div", { className: "steps" },
    setupStep("1", "Sign in to Lectio", lectioConnected, lectioConnected ? state.lectioAccount?.schoolName ?? "Connected" : "Opens the real Lectio website"),
    setupStep(
      "2",
      connectCalendarLabel,
      googleConnected,
      googleConnected
        ? "Dedicated Google calendar"
        : isSafari
          ? "Requires Google in Apple Calendar"
          : "Creates a dedicated Google calendar"
    )
  );
  const privacy = node("div", { className: "privacy-note" }, icon("lock"), node("span", { text: "No analytics or hosted backend." }));

  let button: HTMLButtonElement;
  if (!lectioConnected) {
    button = actionButton("Start setup", "primary full", async () => {
      state = await send<ExtensionState>({ type: "START_LECTIO_SETUP" });
      transientMessage = state.lectioAccount
        ? "Lectio sign-in detected."
        : "If you are already signed in, reload the Lectio tab and try again.";
      transientIsError = false;
    });
  } else if (!googleConnected) {
    button = actionButton(connectCalendarLabel, "primary full", async () => {
      state = await send<ExtensionState>({ type: "CONNECT_GOOGLE" });
    });
  } else {
    button = actionButton("Run first sync", "primary full", async () => {
      try {
        await send({ type: "SYNC_NOW" });
      } finally {
        state = await send<ExtensionState>({ type: "GET_STATE" });
      }
    });
  }

  return node("div", { className: "popup-shell" }, header(), node("main", { className: "content setup-content" }, title, intro, steps, appleCalendarNote(), node("div", { className: "setup-footer" }, privacy, transient(), button)));
}

function setupStep(number: string, title: string, complete: boolean, detail: string): HTMLElement {
  return node("div", { className: `step ${complete ? "complete" : ""}` },
    node("div", { className: "step-number", text: complete ? "✓" : number, attrs: { "aria-hidden": "true" } }),
    node("div", { className: "step-copy" }, node("strong", { text: title }), node("span", { text: detail }))
  );
}

function healthyView(): HTMLElement {
  const syncing = state.status === "syncing" || busy;
  const mark = node("div", { className: "hero-icon success" }, icon("check"));
  const settingsAction = actionButton("Settings", "secondary", () => {
    openSubView("settings", settingsActionFocusSelector);
  });
  settingsAction.setAttribute("data-focus-key", "settings-action");
  const actions = node("div", { className: "button-row" },
    actionButton(syncing ? "Syncing…" : "Sync now", "primary", async () => {
      try {
        await send({ type: "SYNC_NOW" });
      } finally {
        state = await send<ExtensionState>({ type: "GET_STATE" });
      }
    }),
    settingsAction
  );
  return node("div", { className: "popup-shell" }, header(), node("main", { className: "content status-content" },
    mark,
    node("h1", { className: "success-title", text: syncing ? "Syncing safely" : "Up to date" }),
    node("p", { className: "lead", text: `Last checked ${formatRelative(state.lastSuccessAt)}` }),
    node("div", { className: "status-list" },
      statusRow("Lectio", Boolean(state.lectioAccount)),
      statusRow(calendarStatusLabel, Boolean(state.googleCalendarId))
    ),
    node("div", { className: "next-check" }, icon("clock"), node("span", { text: nextCheckLabel(state.nextSyncAt) })),
    actions,
    transient()
  ));
}

function recoveryView(expired: boolean): HTMLElement {
  const googleDisconnected = state.status === "google_disconnected";
  const title = expired ? "Lectio login expired" : "Sync paused safely";
  const text = expired
    ? "Open Lectio and sign in again with MitID. We never see your MitID details."
    : state.lastError?.calendarMayHaveChanged
      ? "A calendar update was interrupted. The next sync will safely reconcile any partial changes."
      : "Your calendar was not changed.";
  const detail = expired ? undefined : state.lastError?.message ?? "Lectio returned an unexpected page.";
  const primary = expired ? "Open Lectio" : googleDisconnected ? `Reconnect ${calendarStatusLabel}` : "Try again";
  const secondaryAction = actionButton(expired ? "Check again" : "View details", "secondary full", async () => {
    if (expired) {
      await send({ type: "CHECK_LECTIO" });
      state = await send<ExtensionState>({ type: "GET_STATE" });
    } else {
      openSubView("details", detailsActionFocusSelector);
    }
  });
  if (!expired) secondaryAction.setAttribute("data-focus-key", "view-details");
  return node("div", { className: "popup-shell" }, header(), node("main", { className: "content recovery-content" },
    node("div", { className: "hero-icon warning" }, icon("warning")),
    node("h1", { text: title }),
    node("p", { className: "lead recovery-lead", text }),
    detail ? node("p", { className: "error-detail", text: detail }) : undefined,
    node("div", { className: "recovery-actions" },
      actionButton(primary, "primary full", async () => {
        if (expired) await send({ type: "START_LECTIO_SETUP" });
        else if (googleDisconnected) state = await send<ExtensionState>({ type: "CONNECT_GOOGLE" });
        else {
          try {
            await send({ type: "SYNC_NOW" });
          } finally {
            state = await send<ExtensionState>({ type: "GET_STATE" });
          }
        }
      }),
      secondaryAction
    ),
    transient()
  ));
}

function settingsView(): HTMLElement {
  const form = node("form", { className: "settings-form" });
  const interval = numberField(
    "Check interval (minutes)",
    "interval",
    state.settings.intervalMinutes,
    MIN_CHECK_INTERVAL_MINUTES,
    MAX_CHECK_INTERVAL_MINUTES,
    "Choose any whole number from 5 minutes to 24 hours."
  );
  const cancellations = selectField("Cancelled modules", "cancellations", ["Mark as cancelled", "Remove after confirmation"], state.settings.cancellationMode === "mark" ? "Mark as cancelled" : "Remove after confirmation");
  const calendarColor = calendarColorField(
    "Calendar colour",
    "calendar-color",
    state.settings.calendarColor,
    "Updates the dedicated Google calendar colour. Apple Calendar displays that same calendar."
  );
  const title = toggleField("Include title", "Lesson titles are used as event names; otherwise the class is used.", state.settings.includeTitle);
  const description = toggleField("Include description", "Lesson descriptions are copied to event notes.", state.settings.includeDescription);
  const className = toggleField("Include class", "Class or hold names are copied to event notes.", state.settings.includeClass);
  const teacher = toggleField("Include teacher", "Teacher names are copied to event notes.", state.settings.includeTeacher);
  const homework = toggleField("Include homework", "Off by default for data minimization.", state.settings.includeHomework);
  form.append(interval.wrapper, calendarColor.wrapper, cancellations.wrapper, title.wrapper, description.wrapper, className.wrapper, teacher.wrapper, homework.wrapper);
  const save = node("button", { className: "button primary full", attrs: { type: "button" } }, node("span", { text: "Save settings" }));
  save.disabled = busy;
  save.addEventListener("click", () => {
    if (!form.reportValidity()) return;
    void perform(async () => {
      state = await send<ExtensionState>({
        type: "UPDATE_SETTINGS",
        settings: {
          intervalMinutes: Number(interval.input.value),
          calendarColor: calendarColor.value(),
          cancellationMode: cancellations.select.value.startsWith("Mark") ? "mark" : "remove",
          includeTitle: title.input.checked,
          includeDescription: description.input.checked,
          includeClass: className.input.checked,
          includeTeacher: teacher.input.checked,
          includeHomework: homework.input.checked
        }
      });
      setView("main");
    });
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    save.click();
  });
  form.append(save);
  return node("div", { className: "popup-shell" }, header("Settings", true), node("main", { className: "content settings-content" },
    node("h1", { text: "Settings" }),
    node("p", { className: "lead", text: "Keep the extension quiet, private, and predictable." }),
    appleCalendarNote(),
    form,
    node("p", { className: "settings-footnote", text: "Lectio credentials and page contents are never stored by the extension." }),
    transient()
  ));
}

function calendarColorField(label: string, name: string, value: string, detail: string) {
  const inputs: HTMLInputElement[] = [];
  const options = node("div", { className: "calendar-color-options", attrs: { role: "radiogroup", "aria-label": label } });
  for (const option of CALENDAR_COLOR_OPTIONS) {
    const input = node("input", { attrs: {
      type: "radio",
      name,
      value: option.value,
      "aria-label": option.name,
      ...(option.value === value ? { checked: "" } : {})
    } });
    inputs.push(input);
    options.append(node("label", { className: "calendar-color-option", attrs: { title: option.name } },
      input,
      node("span", {
        className: "calendar-color-swatch",
        attrs: { style: `--calendar-color: ${option.value}`, "aria-hidden": "true" }
      })
    ));
  }
  return {
    value: () => inputs.find((input) => input.checked)?.value ?? value,
    wrapper: node("div", { className: "field calendar-color-field" },
      node("span", { text: label }),
      options,
      node("small", { text: detail, attrs: { id: `${name}-detail` } })
    )
  };
}

function selectField(label: string, name: string, options: string[], selected: string) {
  const select = node("select", { attrs: { name, id: name } });
  for (const value of options) select.append(node("option", { text: value, attrs: { value, ...(value === selected ? { selected: "" } : {}) } }));
  return { select, wrapper: node("label", { className: "field", attrs: { for: name } }, node("span", { text: label }), select) };
}

function numberField(label: string, name: string, value: number, min: number, max: number, detail: string) {
  const input = node("input", { attrs: {
    type: "number",
    inputmode: "numeric",
    name,
    id: name,
    min: String(min),
    max: String(max),
    step: "1",
    required: "",
    value: String(value)
  } });
  return {
    input,
    wrapper: node("label", { className: "field", attrs: { for: name } },
      node("span", { text: label }),
      input,
      node("small", { text: detail })
    )
  };
}

function toggleField(label: string, detail: string, checked: boolean) {
  const input = node("input", { attrs: { type: "checkbox", ...(checked ? { checked: "" } : {}) } });
  const copy = node("span", { className: "toggle-copy" }, node("strong", { text: label }), node("small", { text: detail }));
  return { input, wrapper: node("label", { className: "toggle-field" }, copy, node("span", { className: "switch" }, input, node("span", { className: "switch-track" }))) };
}

function detailsView(): HTMLElement {
  const error = state.lastError;
  const mayHaveChanged = Boolean(error?.calendarMayHaveChanged);
  return node("div", { className: "popup-shell" }, header("Error details", true), node("main", { className: "content settings-content" },
    node("h1", { text: mayHaveChanged ? "Update interrupted" : "Nothing was changed" }),
    node("p", { className: "lead", text: mayHaveChanged
      ? "Some changes may have been applied. Try again to reconcile the dedicated Lectio calendar."
      : "Lectio Sync stopped before writing to your calendar." }),
    node("dl", { className: "detail-list" },
      node("dt", { text: "Error" }), node("dd", { text: error?.code ?? "UNKNOWN" }),
      node("dt", { text: "When" }), node("dd", { text: error ? formatDisplayDateTime(new Date(error.occurredAt)) : "Unknown" }),
      node("dt", { text: "Technical detail" }), node("dd", { text: error?.technicalDetail ?? error?.message ?? "No details available." })
    ),
    actionButton("Try again", "primary full", async () => {
      try {
        await send({ type: "SYNC_NOW" });
      } finally {
        state = await send<ExtensionState>({ type: "GET_STATE" });
        setView("main");
      }
    }),
    transient()
  ));
}

function transient(): HTMLElement | undefined {
  return transientMessage
    ? node("p", {
      className: `transient ${transientIsError ? "error" : ""}`,
      text: transientMessage,
      attrs: { role: transientIsError ? "alert" : "status" }
    })
    : undefined;
}

function render(): void {
  root.replaceChildren();
  if (view === "settings") root.append(settingsView());
  else if (view === "details") root.append(detailsView());
  else if (state.status === "lectio_expired") root.append(recoveryView(true));
  else if (state.status === "safe_error" || state.status === "google_disconnected") root.append(recoveryView(false));
  else if (state.lectioAccount && state.googleCalendarId && ["healthy", "ready", "syncing"].includes(state.status)) root.append(healthyView());
  else root.append(setupView());
  focusPendingTarget();
}

async function initialize(): Promise<void> {
  state = isPreview() ? previewState() : await send<ExtensionState>({ type: "GET_STATE" });
  render();
}

void initialize().catch((error) => {
  transientMessage = String(error);
  render();
});
