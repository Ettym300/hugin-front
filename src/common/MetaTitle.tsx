import { children, createEffect, JSXElement } from "solid-js";
import env from "./env";
import { APP_NAME } from "./appBrand";

export const MetaTitle = (props: { children: JSXElement }) => {
  const el = children(() => props.children);
  const text = () => el.toArray().join(" ");
  const full = () => `${text() || ""} - ${APP_NAME} ${env.DEV_MODE ? "DEV" : ""}`;

  createEffect(() => {
    document.title = full();
  });
  return <></>;
};
