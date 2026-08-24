import { t } from "@nerimity/i18lite";
import { lazy } from "solid-js";

export interface ExploreRoute {
  path?: string;
  match?: string;
  routePath: string;
  name: () => string;
  icon: string;
  element: any;
}

const exploreRoutes: ExploreRoute[] = [
  {
    path: "themes",
    routePath: "/themes",
    name: () => t("explore.drawer.themes"),
    icon: "brush",
    element: lazy(() => import("@/components/explore/ExploreThemes"))
  }
];

export default exploreRoutes;
