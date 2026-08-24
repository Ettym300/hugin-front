import env from "./env";

export const generateUrl = (
  item: undefined | { avatar?: string; banner?: string },
  type: "avatar" | "banner"
): string | null => {
  const path = item?.[type];
  if (!path) return null;
  const base = env.HUGIN_CDN.endsWith("/")
    ? env.HUGIN_CDN
    : `${env.HUGIN_CDN}/`;
  return `${base}${path.replace(/^\//, "")}`;
};
