import { JSX } from "solid-js/jsx-runtime";
import styles from "./styles.module.scss";
import { classNames } from "@/common/classNames";
import env from "@/common/env";

interface IconProps {
  name?: string;
  color?: string;
  size?: number;
  class?: string;
  style?: JSX.CSSProperties;
  title?: string;
  onClick?: JSX.EventHandlerUnion<HTMLSpanElement, MouseEvent>;
}

export default function Icon(props: IconProps) {
  const rawName = () => props.name || "texture";
  const outlined = () => rawName().endsWith("_border");
  const glyph = () => rawName().replace(/_border$/, "");
  const sizePx = () => `${props.size || 24}px`;

  return (
    <span
      {...(env.DEV_MODE ? { "data-icon": props.name } : undefined)}
      class={classNames(
        "icon",
        "material-symbols-rounded",
        styles.icon,
        props.class
      )}
      style={{
        ...props.style,
        "--icon-color": props.color,
        width: sizePx(),
        height: sizePx(),
        "font-size": sizePx(),
        "font-variation-settings": outlined()
          ? "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24"
          : "'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24"
      }}
      title={props.title}
      onClick={props.onClick}
    >
      {glyph()}
    </span>
  );
}
