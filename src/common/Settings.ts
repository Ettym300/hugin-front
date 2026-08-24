import { lazy } from "solid-js";
import { ExperimentIds } from "./experiments";
import { t } from "@nerimity/i18lite";

export const SettingGroup = {
  Account: "account",
  App: "app",
  Voice: "voice",
  Advanced: "advanced"
} as const;

export type SettingGroupId = (typeof SettingGroup)[keyof typeof SettingGroup];

/**
 * Ordem em que os grupos aparecem no drawer. Um ajuste visivel so precisa
 * mexer aqui, sem tocar na lista de telas.
 */
export const settingGroups: { id: SettingGroupId; name: () => string }[] = [
  {
    id: SettingGroup.Account,
    name: () => t("settings.drawer.groups.account")
  },
  { id: SettingGroup.App, name: () => t("settings.drawer.groups.app") },
  { id: SettingGroup.Voice, name: () => t("settings.drawer.groups.voice") },
  {
    id: SettingGroup.Advanced,
    name: () => t("settings.drawer.groups.advanced")
  }
];

export interface Setting {
  path: string;
  routePath: string;
  name: () => string;
  icon: string;
  element: any;
  /**
   * Ausente nas telas escondidas. Uma tela visivel sem grupo continua sendo
   * listada, so cai no fim sem cabecalho, para nunca desaparecer do drawer.
   */
  group?: SettingGroupId;
  hide?: boolean;
  hideHeader?: boolean;
  experimentId?: ExperimentIds;
}

const DeveloperApplicationBotSettings = lazy(
  () =>
    import("@/components/settings/developer/DeveloperApplicationBotSettings")
);

const DeveloperApplicationSettings = lazy(
  () => import("@/components/settings/developer/DeveloperApplicationSettings")
);

const settings: Setting[] = [
  {
    path: "account",
    routePath: "/account",
    name: () => t("settings.drawer.account"),
    icon: "account_circle",
    group: SettingGroup.Account,
    element: lazy(() => import("@/components/settings/AccountSettings"))
  },

  {
    path: "profile",
    routePath: "/profile",
    name: () => t("settings.account.profile"),
    icon: "person",
    group: SettingGroup.Account,
    element: lazy(() => import("@/components/settings/ProfileSettings"))
  },
  {
    path: "sessions",
    routePath: "/sessions",
    name: () => t("settings.drawer.sessions"),
    icon: "data_loss_prevention",
    group: SettingGroup.Account,
    element: lazy(() => import("@/components/settings/SessionSettings"))
  },
  {
    path: "badges",
    routePath: "/badges",
    name: () => t("settings.drawer.badges"),
    icon: "local_police",
    group: SettingGroup.Account,
    element: lazy(() => import("@/components/settings/BadgeSettings"))
  },
  {
    path: "interface",
    routePath: "/interface",
    name: () => t("settings.drawer.interface"),
    icon: "brush",
    group: SettingGroup.App,
    element: lazy(() => import("@/components/settings/InterfaceSettings"))
  },
  {
    path: "/interface/custom-css",
    routePath: "/interface/custom-css",
    name: () => t("settings.drawer.interface"),
    icon: "code",
    element: lazy(() => import("@/components/settings/CustomCssSettings")),
    hide: true
  },
  {
    path: "notifications",
    routePath: "/notifications",
    name: () => t("settings.drawer.notifications"),
    icon: "notifications",
    group: SettingGroup.App,
    element: lazy(() => import("@/components/settings/NotificationsSettings"))
  },
  {
    path: "call-settings",
    routePath: "/call-settings",
    name: () => t("settings.drawer.call-settings"),
    icon: "call",
    group: SettingGroup.Voice,
    element: lazy(() => import("@/components/settings/CallSettings"))
  },
  {
    path: "connections",
    routePath: "/connections",
    name: () => t("settings.drawer.connections"),
    icon: "hub",
    group: SettingGroup.Account,
    element: lazy(() => import("@/components/settings/ConnectionsSettings"))
  },
  {
    path: "privacy",
    routePath: "/privacy",
    name: () => t("settings.drawer.privacy"),
    icon: "shield",
    group: SettingGroup.Account,
    element: lazy(() => import("@/components/settings/PrivacySettings"))
  },
  {
    path: "window-settings",
    routePath: "/window-settings",
    name: () => t("settings.drawer.window-settings"),
    icon: "open_in_new",
    group: SettingGroup.App,
    element: lazy(() => import("@/components/settings/WindowSettings"))
  },
  {
    path: "activity-status",
    routePath: "/activity-status",
    name: () => t("settings.drawer.activity-status"),
    icon: "gamepad",
    group: SettingGroup.App,
    element: lazy(() => import("@/components/settings/ActivityStatus"))
  },
  {
    path: "language",
    routePath: "/language",
    name: () => t("settings.drawer.language"),
    icon: "flag",
    group: SettingGroup.App,
    element: lazy(() => import("@/components/settings/LanguageSettings"))
  },
  {
    path: "developer",
    routePath: "/developer",
    name: () => t("settings.drawer.developer"),
    icon: "code",
    group: SettingGroup.Advanced,
    element: lazy(
      () => import("@/components/settings/developer/DeveloperSettings")
    )
  },
  {
    path: "developer/applications",
    routePath: "/developer/applications",
    name: () => t("settings.drawer.developer"),
    icon: "code",
    hide: true,
    element: lazy(
      () =>
        import("@/components/settings/developer/DeveloperApplicationsSettings")
    )
  },
  {
    path: "developer/applications",
    routePath: "/developer/applications/:id",
    name: () => t("settings.drawer.developer"),
    hideHeader: true,
    icon: "code",
    hide: true,
    element: DeveloperApplicationSettings
  },
  {
    path: "developer/applications",
    routePath: "/developer/applications/:id/oauth2",
    name: () => t("settings.drawer.developer"),
    hideHeader: true,
    icon: "code",
    hide: true,
    element: DeveloperApplicationSettings
  },
  {
    path: "developer/applications",
    routePath: "/developer/applications/:id/bot/create-link",
    name: () => t("settings.drawer.developer"),
    hideHeader: true,
    icon: "code",
    hide: true,
    element: lazy(
      () =>
        import("@/components/settings/developer/DeveloperApplicationBotCreateLinkSettings")
    )
  },
  {
    path: "developer/applications",
    routePath: "/developer/applications/:id/bot/profile",
    name: () => t("settings.drawer.developer"),
    hideHeader: true,
    icon: "code",
    hide: true,
    element: DeveloperApplicationBotSettings
  },

  {
    path: "developer/applications",
    routePath: "/developer/applications/:id/bot",
    name: () => t("settings.drawer.developer"),
    hideHeader: true,
    icon: "code",
    hide: true,
    element: DeveloperApplicationBotSettings
  },
  {
    path: "developer/applications",
    routePath: "/developer/applications/:id/bot/publish",
    name: () => t("settings.drawer.developer"),
    hideHeader: true,
    icon: "code",
    hide: true,
    element: DeveloperApplicationBotSettings
  },
  {
    path: "experiments",
    routePath: "/experiments",
    name: () => t("settings.drawer.experiments"),
    icon: "science",
    group: SettingGroup.Advanced,
    element: lazy(() => import("@/components/settings/ExperimentSettings"))
  },
  {
    path: "tickets",
    routePath: "/tickets/:id?",
    name: () => t("settings.drawer.tickets"),
    icon: "sell",
    group: SettingGroup.Account,
    element: lazy(() => import("@/components/settings/TicketSettings"))
  }
];

export default settings;
