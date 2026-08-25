import { reconcile } from "solid-js/store";
import { StorageKeys, useLocalStorage, setStorageString } from "./localStorage";

export const ThemeCategory = {
  Surface: "Surface",
  Overlays: "Overlays",
  Input: "Input",
  MarkupBar: "Markup Bar",
  Message: "Message",
  Accent: "Accent",
  Alert: "Alert",
  Warn: "Warn",
  Success: "Success",
  Status: "Status",
  Text: "Text",
  Markup: "Markup",
  Drawer: "Drawer",
  Call: "Call"
} as const;

const ThemeTokensBase = [
  // Surface
  {
    key: "background-color",
    category: ThemeCategory.Surface,
    value: "#07080d",
    allowGradient: true
  },
  {
    key: "pane-color",
    category: ThemeCategory.Surface,
    value: "#12141c",
    allowGradient: true
  },
  {
    key: "side-pane-color",
    category: ThemeCategory.Surface,
    value: "#0e1016",
    allowGradient: true
  },
  {
    key: "panel-border-color",
    category: ThemeCategory.Surface,
    value: "rgba(255, 255, 255, 0.055)"
  },

  // Overlays
  {
    key: "header-background-color",
    category: ThemeCategory.Overlays,
    value: "rgba(18, 20, 28, 0.78)"
  },
  {
    key: "header-background-color-blur-disabled",
    category: ThemeCategory.Overlays,
    value: "#12141c"
  },
  {
    key: "tooltip-background-color",
    category: ThemeCategory.Overlays,
    value: "#08090f"
  },

  // Input
  {
    key: "chat-input-background-color",
    category: ThemeCategory.Input,
    value: "#1a1d28"
  },
  {
    key: "chat-input-background-color-blur-disabled",
    category: ThemeCategory.Input,
    value: "#1a1d28"
  },

  // Markup bar
  {
    key: "chat-markup-bar-background-color",
    category: ThemeCategory.MarkupBar,
    value: "#141722"
  },
  {
    key: "chat-markup-bar-background-color-blur-disabled",
    category: ThemeCategory.MarkupBar,
    value: "#141722"
  },

  // Message
  {
    key: "message-hover-background-color",
    category: ThemeCategory.Message,
    value: "rgba(122, 162, 255, 0.06)"
  },
  {
    key: "message-floating-options-background-color",
    category: ThemeCategory.Message,
    value: "#0a0b12"
  },

  // Accent (Primary)
  { key: "primary-color", category: ThemeCategory.Accent, value: "#7aa2ff" },
  {
    key: "primary-color-dark",
    category: ThemeCategory.Accent,
    value: "#3d5cb8"
  },

  // Alert
  { key: "alert-color", category: ThemeCategory.Alert, value: "#ff5c7a" },
  { key: "alert-color-dark", category: ThemeCategory.Alert, value: "#4a1c28" },

  // Warn
  { key: "warn-color", category: ThemeCategory.Warn, value: "#f0b232" },
  { key: "warn-color-dark", category: ThemeCategory.Warn, value: "#3d3218" },

  // Success
  { key: "success-color", category: ThemeCategory.Success, value: "#3dd68c" },
  {
    key: "success-color-dark",
    category: ThemeCategory.Success,
    value: "#163d2a"
  },

  // Status
  { key: "status-offline", category: ThemeCategory.Status, value: "#6b7280" },
  { key: "status-online", category: ThemeCategory.Status, value: "#3dd68c" },
  {
    key: "status-looking-to-play",
    category: ThemeCategory.Status,
    value: "#3dd68c"
  },
  {
    key: "status-away-from-keyboard",
    category: ThemeCategory.Status,
    value: "#f0b232"
  },
  {
    key: "status-do-not-disturb",
    category: ThemeCategory.Status,
    value: "#ff5c7a"
  },

  // Text
  { key: "text-color", category: ThemeCategory.Text, value: "#eef0f6" },
  {
    key: "content-color",
    category: ThemeCategory.Text,
    value: "#c5cad6"
  },
  { key: "side-pane-text-color", category: ThemeCategory.Text, value: "#eef0f6" },
  {
    key: "typing-indicator-color",
    category: ThemeCategory.Text,
    value: "#eef0f6"
  },
  {
    key: "typing-indicator-secondary-color",
    category: ThemeCategory.Text,
    value: "#9aa3b5"
  },

  // Markup
  {
    key: "markup-code-background-color",
    category: ThemeCategory.Markup,
    value: "rgba(255, 255, 255, 0.08)"
  },
  {
    key: "markup-mention-background-color",
    category: ThemeCategory.Markup,
    value: "rgba(122, 162, 255, 0.16)"
  },
  {
    key: "markup-mention-background-color-hover",
    category: ThemeCategory.Markup,
    value: "rgba(122, 162, 255, 0.24)"
  },
  {
    key: "markup-codeblock-background-color",
    category: ThemeCategory.Markup,
    value: "rgba(0, 0, 0, 0.35)"
  },
  {
    key: "markup-spoiler-background-color",
    category: ThemeCategory.Markup,
    value: "#0c0d12ff"
  },
  {
    key: "markup-spoiler-background-color-hover",
    category: ThemeCategory.Markup,
    value: "#161822ff"
  },

  // Drawer
  {
    key: "drawer-item-background-color",
    category: ThemeCategory.Drawer,
    value: "rgba(122, 162, 255, 0.14)"
  },
  {
    key: "drawer-item-hover-background-color",
    category: ThemeCategory.Drawer,
    value: "rgba(255, 255, 255, 0.05)"
  },

  // Call
  {
    key: "call-background-color",
    category: ThemeCategory.Call,
    value: "#04050a"
  },
  {
    key: "call-tile-background-color",
    category: ThemeCategory.Call,
    value: "#16181e"
  },
  {
    key: "call-bar-background-color",
    category: ThemeCategory.Call,
    value: "#1e1f22"
  }
] as const;

// Get the order of categories as defined in ThemeCategory
const categoryOrder = Object.values(ThemeCategory);

export const ThemeTokens = [...ThemeTokensBase].sort((a, b) => {
  const categoryIndexA = categoryOrder.indexOf(a.category);
  const categoryIndexB = categoryOrder.indexOf(b.category);
  return categoryIndexA - categoryIndexB;
});

type ThemeKey = (typeof ThemeTokensBase)[number]["key"];

export const DefaultTheme = ThemeTokens.reduce(
  (acc, token) => {
    acc[token.key] = token.value;
    return acc;
  },
  {} as Record<ThemeKey, string>
);

const [customColors, setCustomColors] = useLocalStorage<
  Partial<Record<ThemeKey, string>>
>(StorageKeys.CUSTOM_COLORS, {});

const currentTheme = () => ({ ...DefaultTheme, ...customColors() });

export const themeVars = (
  theme: Record<ThemeKey, string>
): Record<string, string> => {
  const vars: Record<string, string> = {};
  for (const key of Object.keys(theme)) {
    vars[`--${key}`] = theme[key as ThemeKey];
  }
  vars["--text-color-secondary"] ??= dimmedColor(theme["text-color"], 0.6);
  vars["--alert-color-faded"] ??= dimmedColor(theme["alert-color"], 0.6);
  vars["--content-color-dim60"] ??= dimmedColor(theme["content-color"], 0.6);
  vars["--content-color-dim80"] ??= dimmedColor(theme["content-color"], 0.8);

  // Accents translucidos. Sem isto, superficies como a borda do tile em foco
  // ou o selo de "ao vivo" precisariam de rgba fixo e parariam de acompanhar
  // o tema quando o usuario troca a cor.
  vars["--primary-color-faded"] ??= dimmedColor(theme["primary-color"], 0.6);
  vars["--primary-color-dim20"] ??= dimmedColor(theme["primary-color"], 0.2);
  vars["--alert-color-dim20"] ??= dimmedColor(theme["alert-color"], 0.2);
  vars["--warn-color-faded"] ??= dimmedColor(theme["warn-color"], 0.6);
  vars["--warn-color-dim20"] ??= dimmedColor(theme["warn-color"], 0.2);
  vars["--success-color-faded"] ??= dimmedColor(theme["success-color"], 0.6);

  // Texto legivel sobre os accents. Escolher no claro/escuro evita o caso em
  // que um accent escuro deixa o rotulo do botao invisivel.
  vars["--on-primary-color"] ??= contrastColor(
    theme["primary-color"],
    theme["background-color"]
  );
  vars["--on-alert-color"] ??= contrastColor(
    theme["alert-color"],
    theme["background-color"]
  );
  return vars;
};

export const updateTheme = () => {
  const vars = themeVars(currentTheme());
  for (const key in vars) {
    document.documentElement.style.setProperty(key, vars[key] ?? null);
  }
};

export const setThemeColor = (key: ThemeKey, value?: string) => {
  if (value === undefined) {
    const temp = { ...customColors() };
    delete temp[key];
    setCustomColors(reconcile(temp));
  } else {
    setCustomColors({ ...customColors(), [key]: value });
  }
  updateTheme();
};

// Theme presets
export type ThemePreset = {
  colors: Partial<Record<ThemeKey, string>>;
  maintainers: string[];
};

export const themePresets: Record<string, ThemePreset> = {
  Default: {
    colors: DefaultTheme,
    maintainers: ["Superkitten", "Asraye"]
  },
  Hugin: {
    colors: DefaultTheme,
    maintainers: ["local"]
  },
  "Discord Root": {
    colors: {
      "background-color": "#1e1f22",
      "pane-color": "#313338",
      "side-pane-color": "#2b2d31",
      "header-background-color": "#313338",
      "header-background-color-blur-disabled": "#313338",
      "primary-color": "#5865f2",
      "success-color": "#23a559",
      "alert-color": "#ed4245"
    },
    maintainers: ["local"]
  },
  Classic: {
    colors: {
      "background-color": "hsl(216deg 9% 8%)",
      "pane-color": "hsl(216deg 8% 15%)",
      "side-pane-color": "hsl(216deg 7.82% 12.55%)",
      "header-background-color": "hsla(216deg 8% 15% / 80%)",
      "header-background-color-blur-disabled": "hsl(216deg 8% 15%)",
      "tooltip-background-color": "rgb(40, 40, 40)",
      "markup-code-background-color": "rgba(0, 0, 0, 0.6)",
      "markup-mention-background-color": "rgba(0, 0, 0, 0.2)",
      "markup-mention-background-color-hover": "rgba(0, 0, 0, 0.6)",
      "markup-codeblock-background-color": "rgba(0, 0, 0, 0.6)",
      "message-hover-background-color": "rgba(255, 255, 255, 0.03)",
      "message-floating-options-background-color": "rgb(40, 40, 40)",
      "markup-spoiler-background-color": "#0e0f10",
      "markup-spoiler-background-color-hover": "#1c1e20"
    },
    maintainers: ["Superkitten", "Asraye"]
  }
};

// Apply a preset
export const applyTheme = (name: string, themeObj?: ThemePreset) => {
  const preset = themeObj || themePresets[name];
  if (!preset || !preset.colors) return;

  // Clear previous
  Object.keys(customColors()).forEach((key) =>
    setThemeColor(key as ThemeKey, undefined)
  );

  // Apply
  Object.entries(preset.colors).forEach(([key, value]) =>
    setThemeColor(key as ThemeKey, value)
  );

  // Persist
  setStorageString(StorageKeys.CUSTOM_COLORS, JSON.stringify(preset.colors));
};

const placeholder = document.createElement("span");
placeholder.style.display = "none";
document.body.appendChild(placeholder);

const computedColor = (
  color: string
): [number, number, number, number] | null => {
  placeholder.style.color = "";
  placeholder.style.color = color;
  if (placeholder.style.color == "") return null;

  const computed = window.getComputedStyle(placeholder).color;
  const match = computed.match(/^rgba?\((.*)\)$/)?.[1];
  const colors = match?.split(",")?.map(Number);
  if (colors === undefined || colors.length < 3 || colors.length > 4)
    return null;
  colors[3] = colors[3] ?? 1.0;
  return colors as [number, number, number, number];
};

const supportsColorMix = CSS.supports(
  "color",
  "color-mix(in srgb, #FFF 50%, transparent)"
);

const dimmedColor = (color: string, opacity: number): string => {
  if (supportsColorMix)
    return `color-mix(in srgb, ${color} ${opacity * 100}%, transparent)`;

  const computed = computedColor(color);
  if (computed === null) return color;

  const [r, g, b, a] = computed;
  return `rgba(${r},${g},${b},${a * opacity})`;
};

/**
 * Luminancia relativa da WCAG, usada so para decidir entre texto claro e
 * escuro sobre uma cor de destaque.
 */
const luminance = (r: number, g: number, b: number) => {
  const channel = (value: number) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  );
};

const contrastRatio = (a: number, b: number) => {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * Devolve a cor de texto mais legivel sobre `background`, comparando o
 * contraste real do branco com o da cor escura do tema.
 *
 * Um limiar fixo de luminancia nao serve aqui: o accent padrao (#7aa2ff) fica
 * logo abaixo do meio da escala, mas rende 8:1 com texto escuro contra 2,5:1
 * com branco.
 */
const contrastColor = (background: string, dark: string): string => {
  const computed = computedColor(background);
  if (computed === null) return "#ffffff";
  const backgroundLuminance = luminance(computed[0], computed[1], computed[2]);

  // Um gradiente nao pode ser lido como cor unica; nesse caso o preto puro e
  // a melhor alternativa ao branco.
  const darkComputed = computedColor(dark);
  const darkLuminance = darkComputed
    ? luminance(darkComputed[0], darkComputed[1], darkComputed[2])
    : 0;

  const white = contrastRatio(backgroundLuminance, 1);
  const darker = contrastRatio(backgroundLuminance, darkLuminance);
  if (white > darker) return "#ffffff";
  return darkComputed ? dark : "#000000";
};

updateTheme();

const storedTheme = customColors();
if (
  storedTheme["primary-color"] === "#5865f2" ||
  storedTheme["pane-color"] === "#313338"
) {
  setCustomColors({});
  updateTheme();
}

export const defaultThemeCSSVars = themeVars(DefaultTheme);

export { DefaultTheme as theme, currentTheme, customColors, setCustomColors };
